// Atendente fixo por cliente (item 46) + cenário combinado com o Financeiro
// protegido (item 47). Canal sempre falso: nada é enviado de verdade.
require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const inbox = require("../src/services/inbox-service");
const preferred = require("../src/services/preferred-assignee-service");
const { routeIncomingMessage } = require("../src/services/preferred-assignee-routing-service");
const { handleIncomingVisualFlow } = require("../src/services/bot-visual-flow-service");
const { runSlaChecks } = require("../src/services/conversation-sla-service");
const { invalidateCache } = require("../src/services/conversation-settings-service");
const { saveIncoming } = require("../src/services/message-service");

const PREFIX = "prefassign";
const emailDomain = "@atendente-fixo.test";
let seq = 0;
let phoneSeq = 0;
let financeiro;
let support;
let commercial;
let originalSettings;

function fakeChannel() {
  const sent = [];
  let counter = 0;
  const reply = (kind) => async (to, payload) => { sent.push({ kind, to, payload }); counter += 1; return { externalId: `wamid.${PREFIX}.out.${Date.now()}.${counter}`, data: {} }; };
  return { sent, sendText: reply("text"), sendList: reply("list"), sendImage: reply("image"), sendAudio: reply("audio"), sendVideo: reply("video"), sendDocument: reply("document") };
}

async function cleanup() {
  const contacts = await prisma.contact.findMany({ where: { externalId: { startsWith: PREFIX } }, select: { id: true } });
  const conversations = await prisma.conversation.findMany({ where: { contactId: { in: contacts.map(({ id }) => id) } }, select: { id: true } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [...contacts.map(({ id }) => id), ...conversations.map(({ id }) => id)] } } });
  await prisma.botFlowExecution.deleteMany({ where: { conversationId: { in: conversations.map(({ id }) => id) } } });
  await prisma.contact.deleteMany({ where: { id: { in: contacts.map(({ id }) => id) } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: emailDomain } } });
  await prisma.category.deleteMany({ where: { companyId: "cmp_mibro", code: { startsWith: "FIN_PREF_TEST" } } });
}

async function createUser(name, { role = "ATENDENTE", categories = [], companies = ["cmp_mibro"], ...flags } = {}) {
  seq += 1;
  return prisma.user.create({
    data: {
      companyAccess: { create: companies.map((companyId) => ({ companyId })) },
      name, email: `pa${seq}-${Date.now()}${emailDomain}`, role, canViewPreviousMessages: false, ...flags,
      categoryAccess: { create: categories.map((category) => ({ categoryId: category.id })) },
    },
  });
}

async function incoming(phone, text) {
  phoneSeq += 1;
  const event = {
    externalId: `wamid.${PREFIX}.in.${Date.now()}.${phoneSeq}`, contactExternalId: `${PREFIX}-${phone}`, phone,
    contactName: "João Silva", type: "text", text, occurredAt: new Date(),
  };
  const result = await saveIncoming(event);
  return { event, message: result.message };
}

// Mesmo encadeamento do webhook (src/app.js): atendente fixo antes do Flow.
async function webhook(phone, text, channel) {
  const { event, message } = await incoming(phone, text);
  const routed = await routeIncomingMessage(event, message, channel, { notify: async () => {} });
  const flowOwned = routed ? false : await handleIncomingVisualFlow(event, message, channel);
  const conversation = await prisma.conversation.findUnique({ where: { id: message.conversationId }, include: { contact: true } });
  return { event, message, routed, flowOwned, conversation };
}

const newPhone = () => `55119${String(Date.now()).slice(-7)}${phoneSeq % 10}`;

test.before(async () => {
  await cleanup();
  support = await prisma.category.findUnique({ where: { companyId_code: { companyId: "cmp_mibro", code: "SUPORTE" } } });
  commercial = await prisma.category.findUnique({ where: { companyId_code: { companyId: "cmp_mibro", code: "COMERCIAL" } } });
  financeiro = await prisma.category.create({ data: { companyId: "cmp_mibro", code: `FIN_PREF_TEST_${Date.now()}`, name: "Financeiro", visibilityMode: "SECTOR_PRIVATE" } });
  // Reabertura ligada (padrão): cliente que volta inicia um novo atendimento.
  originalSettings = await prisma.conversationSettings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  await prisma.conversationSettings.update({ where: { id: "singleton" }, data: { reopenConversationOnCustomerMessage: true, reopenWindowMinutes: null } });
  invalidateCache();
});
test.after(async () => {
  await prisma.conversationSettings.update({ where: { id: "singleton" }, data: {
    reopenConversationOnCustomerMessage: originalSettings.reopenConversationOnCustomerMessage, reopenWindowMinutes: originalSettings.reopenWindowMinutes,
  } });
  invalidateCache();
  await cleanup();
  await prisma.$disconnect();
});

test("1–7, 10: sem vínculo segue o Bot; com vínculo pula a triagem, atribui, mantém após finalizar/transferir e volta ao mesmo atendente", async () => {
  const master = await createUser("Master Fixo", { role: "ADMIN" });
  const carlos = await createUser("Carlos Fixo", { categories: [commercial], canTransferConversations: true });
  const suporte = await createUser("Suporte Temp", { categories: [support] });
  const channel = fakeChannel();
  const phone = newPhone();

  // 1. Cliente sem atendente fixo → roteamento não age (Bot/triagem normais).
  const first = await webhook(phone, "Oi", channel);
  assert.equal(first.routed, false);
  assert.equal(first.conversation.assignedUserId, null);
  const contactId = first.conversation.contactId;

  // Master define Carlos como atendente fixo.
  const set = await preferred.setPreferredAssignee(contactId, { userId: carlos.id, enabled: true, reason: "carteira" }, master);
  assert.equal(set.assignee.id, carlos.id);
  assert.equal(set.setBy.id, master.id);
  assert.ok(set.setAt);
  assert.ok(await prisma.auditLog.findFirst({ where: { entityId: contactId, action: "PREFERRED_ASSIGNEE_SET" } }));

  // Encerra o atendimento atual para simular o próximo contato.
  await prisma.conversation.update({ where: { id: first.conversation.id }, data: { status: "FINALIZADO", finalizedAt: new Date() } });
  channel.sent.length = 0;

  // 2–4. Cliente com atendente fixo → pula triagem, mensagem curta, atribui.
  const second = await webhook(phone, "Voltei", channel);
  assert.equal(second.routed, true);
  assert.equal(second.flowOwned, false, "o Flow Builder não roda");
  assert.equal(second.conversation.assignedUserId, carlos.id);
  assert.equal(second.conversation.status, "AGUARDANDO_EQUIPE");
  assert.equal(second.conversation.categoryId, null);
  assert.equal(channel.sent.length, 1);
  assert.match(channel.sent[0].payload, /atendente responsável/);
  assert.equal(channel.sent[0].payload.includes("Carlos"), false, "não cita o nome do atendente");
  assert.ok(await prisma.message.findFirst({ where: { conversationId: second.conversation.id, rawPayload: { path: ["system"], equals: "preferred_assignee_routing" } } }));
  assert.ok(await prisma.conversationActivity.findFirst({ where: { conversationId: second.conversation.id, action: "ROUTED_TO_PREFERRED_ASSIGNEE" } }));
  // Mensagens seguintes do mesmo atendimento não reenviam nem reatribuem.
  const followUp = await webhook(phone, "Alô?", channel);
  assert.equal(followUp.routed, false);
  assert.equal(channel.sent.length, 1);

  // 5. "Offline": nada redistribui — nem o monitor de SLA.
  await runSlaChecks({ now: new Date(Date.now() + 6 * 60 * 60 * 1000) });
  assert.equal((await prisma.conversation.findUnique({ where: { id: second.conversation.id } })).assignedUserId, carlos.id);

  // 10. Transferência temporária para o Suporte não muda o atendente fixo.
  await inbox.updateConversation(second.conversation.id, { categoryId: support.id }, carlos);
  await inbox.updateConversation(second.conversation.id, { assignedUserId: suporte.id }, suporte);
  assert.equal((await prisma.contact.findUnique({ where: { id: contactId } })).preferredAssigneeId, carlos.id);

  // 6. Finalizar → assignedUserId segue a regra atual; atendente fixo permanece.
  await inbox.updateConversation(second.conversation.id, { status: "FINALIZADO" }, suporte);
  assert.equal((await prisma.contact.findUnique({ where: { id: contactId } })).preferredAssigneeId, carlos.id);

  // 7. Cliente volta → mesmo atendente fixo (não o Suporte da última vez).
  const third = await webhook(phone, "Oi de novo", channel);
  assert.equal(third.routed, true);
  assert.equal(third.conversation.assignedUserId, carlos.id);
});

test("8–9: Supervisor altera (com histórico), Atendente não pode, empresa é respeitada, Master remove e o cliente volta ao fluxo comum", async () => {
  const master = await createUser("Master Fixo 2", { role: "ADMIN" });
  const supervisor = await createUser("Supervisor Mibro", { role: "SUPERVISOR", categories: [commercial], canViewUncategorized: true });
  const atendente = await createUser("Atendente Comum", { categories: [commercial], canViewUncategorized: true });
  const carlos = await createUser("Carlos 2", { categories: [commercial] });
  const ana = await createUser("Ana 2", { categories: [commercial] });
  const soSincrofit = await createUser("Só Sincrofit", { companies: ["cmp_sincrofit"] });
  const inativo = await createUser("Inativo", { active: false });
  const channel = fakeChannel();
  const phone = newPhone();
  const first = await webhook(phone, "Olá", channel);
  const contactId = first.conversation.contactId;

  await preferred.setPreferredAssignee(contactId, { userId: carlos.id }, supervisor);
  await assert.rejects(() => preferred.setPreferredAssignee(contactId, { userId: ana.id }, atendente), { statusCode: 403 });
  await assert.rejects(() => preferred.removePreferredAssignee(contactId, {}, atendente), { statusCode: 403 });
  // Multiempresa: cliente Mibro nunca vai para quem não acessa a Mibro.
  await assert.rejects(() => preferred.setPreferredAssignee(contactId, { userId: soSincrofit.id }, supervisor), { statusCode: 400 });
  await assert.rejects(() => preferred.setPreferredAssignee(contactId, { userId: inativo.id }, supervisor), { statusCode: 400 });
  const candidates = await preferred.listCandidates(contactId, supervisor);
  assert.ok(candidates.some(({ id }) => id === ana.id));
  assert.equal(candidates.some(({ id }) => id === soSincrofit.id || id === inativo.id), false);
  // Atendente comum vê somente leitura.
  const readOnly = await preferred.getPreferredAssignee(contactId, atendente);
  assert.equal(readOnly.canEdit, false);
  assert.equal(readOnly.assignee.id, carlos.id);

  // 8. Supervisor altera Carlos → Ana (histórico com anterior/novo/quem/motivo).
  await preferred.setPreferredAssignee(contactId, { userId: ana.id, reason: "redistribuição de carteira" }, supervisor);
  const changed = await prisma.auditLog.findFirst({ where: { entityId: contactId, action: "PREFERRED_ASSIGNEE_CHANGED" } });
  assert.equal(changed.details.previousAssigneeId, carlos.id);
  assert.equal(changed.details.newAssigneeId, ana.id);
  assert.equal(changed.details.reason, "redistribuição de carteira");
  assert.equal(changed.actorUserId, supervisor.id);

  // 9. Master remove → próximo atendimento volta ao fluxo comum.
  await preferred.removePreferredAssignee(contactId, { reason: "cliente pediu" }, master);
  assert.ok(await prisma.auditLog.findFirst({ where: { entityId: contactId, action: "PREFERRED_ASSIGNEE_REMOVED" } }));
  assert.equal((await preferred.listHistory(contactId, master)).length, 3);
  await prisma.conversation.update({ where: { id: first.conversation.id }, data: { status: "FINALIZADO", finalizedAt: new Date() } });
  const next = await webhook(phone, "Oi", channel);
  assert.equal(next.routed, false);
  assert.equal(next.conversation.assignedUserId, null);

  // Filtros da lista: com/sem/de um atendente; Atendente não consulta outro.
  await preferred.setPreferredAssignee(contactId, { userId: carlos.id }, master);
  const withCarlos = await inbox.listConversations({ preferredAssignee: carlos.id }, master);
  assert.ok(withCarlos.some(({ contactId: id }) => id === contactId));
  assert.ok(withCarlos.find(({ contactId: id }) => id === contactId).contact.preferredAssignee.name === "Carlos 2");
  assert.equal((await inbox.listConversations({ preferredAssignee: "NONE" }, master)).some(({ contactId: id }) => id === contactId), false);
  assert.ok((await inbox.listConversations({ preferredAssignee: "ANY" }, master)).some(({ contactId: id }) => id === contactId));
  await assert.rejects(() => inbox.listConversations({ preferredAssignee: carlos.id }, atendente), { statusCode: 403 });
});

test("47: João fixo do Carlos → Financeiro (Ana) → finaliza → volta ao Carlos sem ver o Financeiro → Financeiro de novo: Ana/Emily recuperam; Master vê tudo", async () => {
  const master = await createUser("Master 47", { role: "ADMIN" });
  const carlos = await createUser("Carlos 47", { categories: [commercial], canTransferConversations: true, canViewConversationHistory: true });
  const ana = await createUser("Ana 47", { categories: [financeiro] });
  const emily = await createUser("Emily 47", { categories: [financeiro] });
  const channel = fakeChannel();
  const phone = newPhone();

  const opening = await webhook(phone, "Oi", channel);
  const contactId = opening.conversation.contactId;
  await preferred.setPreferredAssignee(contactId, { userId: carlos.id }, master);
  await prisma.conversation.update({ where: { id: opening.conversation.id }, data: { status: "FINALIZADO", finalizedAt: new Date() } });

  // João entra → Carlos.
  const joao = await webhook(phone, "Quero comprar dois relógios", channel);
  assert.equal(joao.conversation.assignedUserId, carlos.id);
  const conversationId = joao.conversation.id;
  await prisma.message.create({ data: { conversationId, direction: "ENVIADA", status: "ENVIADA", type: "text", text: "Fechado, vou te passar ao Financeiro", occurredAt: new Date(), sentByUserId: carlos.id } });

  // Carlos → Financeiro → Ana atende.
  await inbox.updateConversation(conversationId, { categoryId: financeiro.id }, carlos);
  await inbox.updateConversation(conversationId, { assignedUserId: ana.id }, ana);
  const boleto = await webhook(phone, "Pode mandar o boleto em 2x?", channel);
  assert.equal(boleto.message.privateCategoryId, financeiro.id);
  await prisma.message.create({ data: { conversationId, direction: "ENVIADA", status: "ENVIADA", type: "text", text: "Boleto 2x enviado", occurredAt: new Date(), sentByUserId: ana.id } });

  // Ana finaliza (atendente fixo continua Carlos).
  await inbox.updateConversation(conversationId, { status: "FINALIZADO" }, ana);
  assert.equal((await prisma.contact.findUnique({ where: { id: contactId } })).preferredAssigneeId, carlos.id);

  // Dias depois João retorna → direto para o Carlos.
  const back = await webhook(phone, "Oi Carlos, chegou o pedido", channel);
  assert.equal(back.routed, true);
  assert.equal(back.conversation.assignedUserId, carlos.id);
  assert.equal(back.message.privateCategoryId, null);

  // Carlos NÃO vê o conteúdo Financeiro anterior (atendente fixo ≠ acesso).
  const carlosView = await inbox.getConversation(conversationId, carlos);
  const serialized = JSON.stringify(carlosView);
  assert.equal(serialized.includes("boleto"), false);
  assert.equal(serialized.includes("Boleto"), false);
  assert.ok(carlosView.messages.some(({ restricted, categoryName }) => restricted && categoryName === "Financeiro"));
  assert.ok(carlosView.messages.some(({ text }) => text === "Oi Carlos, chegou o pedido"));
  await assert.rejects(() => inbox.assertCanViewMessage(carlos, boleto.message.id), { statusCode: 403 });

  // Carlos transfere ao Financeiro de novo → Ana/Emily veem o anterior.
  await inbox.updateConversation(conversationId, { categoryId: financeiro.id }, carlos);
  for (const member of [ana, emily]) {
    const view = await inbox.getConversation(conversationId, member);
    assert.ok(view.messages.some(({ text }) => text === "Pode mandar o boleto em 2x?"), `${member.name} recupera o Financeiro anterior`);
  }

  // Master vê tudo, sempre.
  const masterView = await inbox.getConversation(conversationId, master);
  assert.equal(masterView.messages.some(({ restricted }) => restricted), false);
  assert.ok(masterView.messages.some(({ text }) => text === "Boleto 2x enviado"));
  // Atendente fixo seguiu Carlos o tempo todo.
  assert.equal((await prisma.contact.findUnique({ where: { id: contactId } })).preferredAssigneeId, carlos.id);
});
