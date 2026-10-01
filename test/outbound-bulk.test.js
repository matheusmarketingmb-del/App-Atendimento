// Envio pelo painel "Nova conversa" (individual e em massa). Todos os canais
// aqui são FALSOS: nenhuma chamada à Meta, nenhum envio real.
require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const bulk = require("../src/services/outbound-bulk-service");
const worker = require("../src/services/campaign-worker-service");
const channelMessageService = require("../src/services/channels/channel-message-service");
const campaignReplyService = require("../src/services/campaign-reply-service");
const { createOutboundConversation } = require("../src/services/outbound-conversation-service");
const { saveIncoming } = require("../src/services/message-service");
const { registerOptOut } = require("../src/services/campaign-optout-service");

const P = "55119660"; // prefixo dos telefones de teste (celular 11 9660xxxxx)
const EMAILS = ["bulk-admin@teste.local", "bulk-sup@teste.local", "bulk-att@teste.local", "bulk-att2@teste.local", "bulk-att3@teste.local"];
let admin; let attendant; let attendantNoBulk; let otherAttendant; let supervisor; let category; let otherCategory; let account; let offlineAccount; let principalAccount;

const templates = [
  {
    id: "t1", name: "contato_comercial_inicial", language: "pt_BR", category: "MARKETING", status: "APPROVED",
    components: [
      { type: "BODY", text: "Olá, {{customer_name}}! Aqui é {{agent_name}}.", example: { body_text_named_params: [{ param_name: "customer_name", example: "Ana" }, { param_name: "agent_name", example: "Matheus" }] } },
      { type: "FOOTER", text: "Mibro" },
    ],
  },
  {
    id: "t2", name: "cliente_inativo_retorno", language: "pt_BR", category: "UTILITY", status: "APPROVED",
    components: [{ type: "BODY", text: "Oi {{1}}, sentimos sua falta.", example: { body_text: [["Maria"]] } }],
  },
  {
    id: "t3", name: "retorno_cotacao", language: "pt_BR", category: "MARKETING", status: "APPROVED",
    components: [{ type: "BODY", text: "Sua cotação {{order}} está pronta.", example: { body_text_named_params: [{ param_name: "order", example: "123" }] } }],
  },
  { id: "t4", name: "rascunho_pendente", language: "pt_BR", category: "MARKETING", status: "PENDING", components: [{ type: "BODY", text: "Oi" }] },
];

function fakeChannel(label, { failPhones = [], list = templates } = {}) {
  const sent = [];
  return {
    label, sent,
    listMessageTemplates: async () => list,
    getPhoneNumberProfile: async () => ({ display_phone_number: `+55 11 9${label.length}000-0000`, verified_name: label, quality_rating: "GREEN" }),
    sendTemplate: async (phone, payload) => {
      if (failPhones.includes(phone)) throw new Error("Falha simulada da Meta");
      sent.push({ phone, payload });
      return { externalId: `wamid.bulk.${label}.${sent.length}.${Math.random().toString(36).slice(2)}`, data: {} };
    },
  };
}

const phone = (n) => `${P}${String(n).padStart(5, "0")}`;
const recipient = (n, name, extra = {}) => ({ key: `k${n}`, name, phone: phone(n), ...extra });
const key = () => `teste-idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

async function cleanup() {
  await prisma.campaign.deleteMany({ where: { OR: [{ name: { startsWith: "Bulk Teste" } }, { origin: "PANEL", createdByUserId: { in: [admin?.id, attendant?.id, supervisor?.id].filter(Boolean) } }] } });
  await prisma.optOut.deleteMany({ where: { phone: { startsWith: P } } });
  await prisma.contact.deleteMany({ where: { OR: [{ externalId: { startsWith: P } }, { externalId: { startsWith: "5511660" } }] } });
}

async function contactWithConversation(n, name, { categoryId = null, assignedUserId = null, received = true, channelAccountId = null, daysAgo = 1 } = {}) {
  const contact = await prisma.contact.create({ data: { channel: "META", externalId: phone(n), phone: phone(n), name } });
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  const conversation = await prisma.conversation.create({ data: {
    contactId: contact.id, channel: "META", channelScope: channelAccountId || "LEGACY", channelAccountId, categoryId, assignedUserId,
    status: "EM_ATENDIMENTO", lastMessageAt: at,
  } });
  await prisma.message.create({ data: {
    conversationId: conversation.id, channel: "META", direction: received ? "RECEBIDA" : "ENVIADA", status: received ? "RECEBIDA" : "ENVIADA",
    type: "text", text: "oi", occurredAt: at, externalId: `wamid.seed.${n}.${Math.random().toString(36).slice(2)}`,
  } });
  return { contact, conversation };
}

let restoreAdapter;
function useAccountChannels(map) {
  const original = channelMessageService.adapterFor;
  channelMessageService.adapterFor = async (channel, id) => {
    if (map[id]) return { channel: map[id] };
    return original(channel, id);
  };
  restoreAdapter = () => { channelMessageService.adapterFor = original; };
}

// Processa só o lote do teste: os lotes de outros testes ficam pausados.
async function runWorker(defaultChannel, ticks = 1, campaignId) {
  await prisma.campaign.updateMany({ where: { origin: "PANEL", id: { not: campaignId }, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "PAUSED" } });
  await prisma.campaignGlobalSettings.update({ where: { id: "singleton" }, data: { massMessagingEnabled: true, defaultBatchSize: 50, defaultDelayBetweenBatchesSeconds: 1 } });
  try {
    for (let i = 0; i < ticks; i += 1) {
      await prisma.campaign.updateMany({ where: { origin: "PANEL" }, data: { lastBatchAt: null } });
      await worker.runCampaignSendTick(defaultChannel);
    }
  } finally {
    await prisma.campaignGlobalSettings.update({ where: { id: "singleton" }, data: { massMessagingEnabled: false } });
  }
}

test.before(async () => {
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "waba-bulk-test";
  await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
  admin = await prisma.user.create({ data: { name: "Master Bulk", email: EMAILS[0], role: "ADMIN" } });
  supervisor = await prisma.user.create({ data: { name: "Supervisora Bulk", email: EMAILS[1], role: "SUPERVISOR" } });
  attendant = await prisma.user.create({ data: { name: "Matheus Atendente", email: EMAILS[2], role: "ATENDENTE", canManageCampaigns: true, canStartConversations: true } });
  attendantNoBulk = await prisma.user.create({ data: { name: "Atendente Individual", email: EMAILS[3], role: "ATENDENTE", canStartConversations: true } });
  otherAttendant = await prisma.user.create({ data: { name: "Outro Atendente", email: EMAILS[4], role: "ATENDENTE" } });
  // Unified inbox: the principal number is now a managed sender as well.
  principalAccount = await prisma.channelAccount.create({ data: { channel: "META", name: "Principal Bulk Teste", enabled: true, status: "CONNECTED", config: { isLegacyWhatsApp: true, outboundCategoryIds: [] } } });
  await prisma.channelAccountUserAccess.createMany({ data: [admin, supervisor, attendant, attendantNoBulk, otherAttendant].map(u => ({ channelAccountId: principalAccount.id, userId: u.id })) });
  category = await prisma.category.upsert({ where: { code: "bulk_teste_comercial" }, update: {}, create: { code: "bulk_teste_comercial", name: "Comercial Bulk" } });
  otherCategory = await prisma.category.upsert({ where: { code: "bulk_teste_suporte" }, update: {}, create: { code: "bulk_teste_suporte", name: "Suporte Bulk" } });
  await prisma.userCategoryAccess.createMany({ data: [{ userId: attendant.id, categoryId: category.id }], skipDuplicates: true });
  await prisma.channelAccount.deleteMany({ where: { name: { in: ["Mibro Comercial Teste", "Mibro Offline Teste"] } } });
  account = await prisma.channelAccount.create({ data: { channel: "META", name: "Mibro Comercial Teste", status: "CONNECTED", enabled: true } });
  offlineAccount = await prisma.channelAccount.create({ data: { channel: "META", name: "Mibro Offline Teste", status: "ERROR", enabled: true } });
  await prisma.channelAccountUserAccess.create({ data: { channelAccountId: account.id, userId: attendant.id } });
  await prisma.campaignGlobalSettings.upsert({ where: { id: "singleton" }, update: { massMessagingEnabled: false }, create: { id: "singleton", massMessagingEnabled: false } });
  await cleanup();
});

test.afterEach(() => { restoreAdapter?.(); restoreAdapter = null; });

test.after(async () => {
  await cleanup();
  await prisma.channelAccount.deleteMany({ where: { id: { in: [account.id, offlineAccount.id, principalAccount.id] } } });
  await prisma.userCategoryAccess.deleteMany({ where: { userId: attendant.id } });
  await prisma.category.deleteMany({ where: { code: { in: ["bulk_teste_comercial", "bulk_teste_suporte"] } } });
  await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
  await prisma.$disconnect();
});

test("1. envio individual: atendente só com “Iniciar conversas” envia template (sem precisar de Campanhas)", async () => {
  const channel = fakeChannel("principal");
  const result = await createOutboundConversation({
    phone: "(11) 96600-0001", customName: "Ana Individual", accountId: "legacy", user: attendantNoBulk, channel,
    template: { name: "cliente_inativo_retorno", language: "pt_BR", values: { "BODY:1": "Ana" } },
  });
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].phone, phone(1));
  assert.ok(result.conversationId);
});

test("RBAC: envio em massa exige “Campanhas e templates”; atendente individual recebe 403", async () => {
  await assert.rejects(() => bulk.previewBulkSend(attendantNoBulk, { accountId: "legacy", recipients: [recipient(2, "X")] }, fakeChannel("p")), (error) => error.statusCode === 403);
  await assert.rejects(() => bulk.createBulkSend(otherAttendant, { idempotencyKey: key(), recipients: [] }, fakeChannel("p")), (error) => error.statusCode === 403);
});

test("2/3/13/16/17/22/27. vários contatos manuais + template global: lote na fila, nada enviado na requisição, custo estimado", async () => {
  const channel = fakeChannel("principal");
  const payload = {
    accountId: "legacy", name: "Bulk Teste manual", idempotencyKey: key(),
    defaultTemplate: { name: "contato_comercial_inicial", language: "pt_BR" },
    recipients: [recipient(10, "Ana Souza"), recipient(11, "Carlos"), recipient(12, "João")],
  };
  const preview = await bulk.previewBulkSend(attendant, payload, channel);
  assert.equal(preview.summary.ready, 3);
  assert.deepEqual(preview.recipients.map((row) => `${row.values["BODY:customer_name"]} / ${row.values["BODY:agent_name"]}`), [
    "Ana Souza / Matheus Atendente", "Carlos / Matheus Atendente", "João / Matheus Atendente",
  ]);
  assert.deepEqual(preview.summary.cost.byCategory, { MARKETING: { count: 3, cost: 0.9651 } });
  const created = await bulk.createBulkSend(attendant, { ...payload, confirmedCount: 3 }, channel);
  assert.equal(created.queued, 3);
  assert.equal(channel.sent.length, 0, "a requisição nunca envia — só a fila");
  const rows = await prisma.campaignContact.findMany({ where: { campaignId: created.campaignId } });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.status === "QUEUED" && row.templateName === "contato_comercial_inicial"));
  const campaign = await prisma.campaign.findUnique({ where: { id: created.campaignId } });
  assert.equal(campaign.origin, "PANEL");
  assert.equal(campaign.createdByUserId, attendant.id);
  const audit = await prisma.auditLog.findFirst({ where: { action: "PANEL_BULK_SEND_CREATED", entityId: campaign.id } });
  assert.ok(audit, "criação do lote auditada");
  assert.doesNotMatch(JSON.stringify(audit.details), /token|secret/i);
});

test("21. idempotência: o mesmo pedido (clique duplo) devolve o mesmo lote e não duplica destinatários", async () => {
  const channel = fakeChannel("principal");
  const payload = { accountId: "legacy", name: "Bulk Teste idem", idempotencyKey: key(), defaultTemplate: { name: "cliente_inativo_retorno", language: "pt_BR" }, recipients: [recipient(20, "Ana"), recipient(21, "Bia")] };
  const [first, second] = await Promise.all([bulk.createBulkSend(attendant, payload, channel), bulk.createBulkSend(attendant, payload, channel)]);
  assert.equal(first.campaignId, second.campaignId);
  assert.ok(first.duplicateRequest || second.duplicateRequest);
  assert.equal(await prisma.campaignContact.count({ where: { campaignId: first.campaignId } }), 2);
  const again = await bulk.createBulkSend(attendant, payload, channel);
  assert.equal(again.campaignId, first.campaignId);
  assert.equal(again.duplicateRequest, true);
});

test("6/18/19/20. revisão bloqueia só os problemáticos: duplicado, nome ausente, template não aprovado, opt-out", async () => {
  await registerOptOut({ phone: phone(33), source: "MANUAL" });
  const preview = await bulk.previewBulkSend(attendant, {
    accountId: "legacy", defaultTemplate: { name: "contato_comercial_inicial", language: "pt_BR" },
    recipients: [
      recipient(30, "Ana"),
      { key: "dup", name: "Ana sem 9", phone: `5511660${"00030"}` }, // mesmo celular sem o 9º dígito
      recipient(31, ""),
      recipient(32, "Pendente", { templateName: "rascunho_pendente", templateLanguage: "pt_BR" }),
      recipient(33, "Saiu"),
      { key: "bad", name: "Inválido", phone: "123" },
    ],
  }, fakeChannel("principal"));
  const issues = Object.fromEntries(preview.recipients.map((row) => [row.key, row.issues]));
  assert.deepEqual(issues.k30, []);
  assert.deepEqual(issues.dup, ["DUPLICATE"]);
  assert.deepEqual(issues.k31, ["NAME_MISSING"]);
  assert.deepEqual(issues.k32, ["TEMPLATE_NOT_APPROVED"]);
  assert.deepEqual(issues.k33, ["OPTED_OUT"]);
  assert.deepEqual(issues.bad, ["INVALID_PHONE"]);
  assert.equal(preview.summary.ready, 1);
  assert.equal(preview.summary.nameMissing, 1);

  // “Usar mensagem sem nome”: fallback configurado libera o contato.
  const fixed = await bulk.previewBulkSend(attendant, {
    accountId: "legacy", defaultTemplate: { name: "contato_comercial_inicial", language: "pt_BR" },
    mappings: { "contato_comercial_inicial|pt_BR": { "BODY:customer_name": { source: "CONTACT_NAME", fallback: "cliente" }, "BODY:agent_name": { source: "AGENT_NAME" } } },
    recipients: [recipient(31, "", { useNameFallback: true })],
  }, fakeChannel("principal"));
  assert.equal(fixed.recipients[0].ok, true);
  assert.equal(fixed.recipients[0].values["BODY:customer_name"], "cliente");
});

test("variável manual obrigatória (ex.: número da cotação) bloqueia até ser preenchida", async () => {
  const channel = fakeChannel("principal");
  const base = { accountId: "legacy", defaultTemplate: { name: "retorno_cotacao", language: "pt_BR" } };
  const missing = await bulk.previewBulkSend(attendant, { ...base, recipients: [recipient(40, "Ana")] }, channel);
  assert.deepEqual(missing.recipients[0].issues, ["MISSING_VARIABLE"]);
  const filled = await bulk.previewBulkSend(attendant, { ...base, recipients: [recipient(40, "Ana", { values: { "BODY:order": "#123" } })] }, channel);
  assert.equal(filled.recipients[0].ok, true);
});

test("8/9/10/11/12/26/31. Contatos da Central: filtros de conversa/categoria/responsável, selecionar todos, reaproveita Contact", async () => {
  const conversed = await contactWithConversation(50, "Cliente Conversou", { categoryId: category.id, assignedUserId: attendant.id });
  const never = await contactWithConversation(51, "Nunca Respondeu", { categoryId: category.id, received: false });
  const old = await contactWithConversation(52, "Antigo", { categoryId: category.id, assignedUserId: attendant.id, daysAgo: 60 });
  await contactWithConversation(53, "Suporte Outro", { categoryId: otherCategory.id, assignedUserId: otherAttendant.id });

  const all = await bulk.searchCentralContacts(admin, { q: "966000", conversed: "" });
  assert.ok(all.total >= 4);
  const talked = await bulk.searchCentralContacts(admin, { conversed: "yes", categoryId: category.id });
  assert.deepEqual(talked.contacts.map((row) => row.name).sort(), ["Antigo", "Cliente Conversou"]);
  const recent = await bulk.searchCentralContacts(admin, { conversed: "yes", period: "30", categoryId: category.id });
  assert.deepEqual(recent.contacts.map((row) => row.name), ["Cliente Conversou"]);
  const silent = await bulk.searchCentralContacts(admin, { conversed: "no", categoryId: category.id });
  assert.deepEqual(silent.contacts.map((row) => row.name), ["Nunca Respondeu"]);
  const byOwner = await bulk.searchCentralContacts(admin, { assignedUserId: attendant.id, categoryId: category.id });
  assert.deepEqual(byOwner.contacts.map((row) => row.name).sort(), ["Antigo", "Cliente Conversou"]);
  assert.equal(talked.contacts[0].category.name, "Comercial Bulk");

  // RBAC: o atendente não enxerga contatos de conversas de outro atendente/setor.
  const scoped = await bulk.searchCentralContacts(attendant, { q: "966000" });
  assert.ok(!scoped.contacts.some((row) => row.name === "Suporte Outro"));

  const selectAll = await bulk.selectAllCentralContacts(admin, { conversed: "yes", categoryId: category.id });
  assert.equal(selectAll.contacts.length, 2);

  // Envio para contato existente reaproveita Contact e Conversation (nunca duplica).
  const channel = fakeChannel("principal");
  const contactsBefore = await prisma.contact.count({ where: { externalId: { startsWith: P } } });
  const created = await bulk.createBulkSend(admin, {
    accountId: "legacy", name: "Bulk Teste central", idempotencyKey: key(), defaultTemplate: { name: "cliente_inativo_retorno", language: "pt_BR" },
    recipients: selectAll.contacts.map((row) => ({ key: row.contactId, contactId: row.contactId, name: row.name, phone: row.phone })),
  }, channel);
  await runWorker(channel, 1, created.campaignId);
  assert.equal(channel.sent.length, 2);
  assert.equal(await prisma.contact.count({ where: { externalId: { startsWith: P } } }), contactsBefore);
  assert.equal(await prisma.conversation.count({ where: { contactId: conversed.contact.id } }), 1);
  const rows = await prisma.campaignContact.findMany({ where: { campaignId: created.campaignId } });
  assert.ok(rows.every((row) => row.status === "SENT" && [conversed.contact.id, old.contact.id].includes(row.contactId)));
  assert.ok(never.contact.id);
});

test("contato de conversa de outro atendente (fora do escopo) é bloqueado no envio em massa", async () => {
  const { contact } = await contactWithConversation(60, "Privado", { categoryId: otherCategory.id, assignedUserId: otherAttendant.id });
  const preview = await bulk.previewBulkSend(attendant, {
    accountId: "legacy", defaultTemplate: { name: "cliente_inativo_retorno", language: "pt_BR" },
    recipients: [{ key: "a", contactId: contact.id, name: "Privado", phone: phone(60) }, { key: "b", name: "Digitado", phone: phone(60).replace(/^5511966/, "551166") }],
  }, fakeChannel("principal"));
  assert.ok(preview.recipients.every((row) => row.issues.includes("CONTACT_NOT_ALLOWED")));
});

test("14/15/23/24/25. templates por grupo, erro individual não derruba o lote, status e resposta na Central", async () => {
  const channel = fakeChannel("principal", { failPhones: [phone(72)] });
  const created = await bulk.createBulkSend(attendant, {
    accountId: "legacy", name: "Bulk Teste grupos", idempotencyKey: key(),
    defaultTemplate: { name: "contato_comercial_inicial", language: "pt_BR" },
    recipients: [
      recipient(70, "Ana"), // padrão
      recipient(71, "Bruno", { templateName: "cliente_inativo_retorno", templateLanguage: "pt_BR" }), // grupo inativos
      recipient(72, "Carla", { templateName: "cliente_inativo_retorno", templateLanguage: "pt_BR" }), // falha simulada
      recipient(73, "Davi", { templateName: "retorno_cotacao", templateLanguage: "pt_BR", values: { "BODY:order": "#456" } }), // por contato
    ],
  }, channel);
  await prisma.campaign.update({ where: { id: created.campaignId }, data: { maxRetries: 0 } });
  await runWorker(channel, 1, created.campaignId);

  const sentBy = Object.fromEntries(channel.sent.map((item) => [item.phone, item.payload]));
  assert.equal(sentBy[phone(70)].name, "contato_comercial_inicial");
  assert.equal(sentBy[phone(71)].name, "cliente_inativo_retorno");
  assert.equal(sentBy[phone(73)].name, "retorno_cotacao");
  assert.deepEqual(sentBy[phone(70)].components[0].parameters.map((parameter) => parameter.text), ["Ana", "Matheus Atendente"]);
  assert.equal(sentBy[phone(71)].components[0].parameters[0].text, "Bruno");
  assert.equal(sentBy[phone(73)].components[0].parameters[0].text, "#456");

  const status = await bulk.getBulkSend(attendant, created.campaignId);
  assert.equal(status.sent, 3);
  assert.equal(status.failed, 1);
  assert.match(status.recipients.find((row) => row.phone === phone(72)).failureReason, /Falha simulada/);
  const sentMessage = await prisma.message.findFirst({ where: { type: "template", conversation: { contact: { externalId: phone(70) } } } });
  assert.equal(sentMessage.sentByUserId, attendant.id, "mensagem registrada em nome de quem criou o lote");

  // Status do webhook (entregue/lido) atualiza o acompanhamento.
  const ana = await prisma.campaignContact.findFirst({ where: { campaignId: created.campaignId, phone: phone(70) } });
  await campaignReplyService.handleCampaignStatusEvent({ status: "delivered", externalId: ana.externalMessageId });
  await campaignReplyService.handleCampaignStatusEvent({ status: "read", externalId: ana.externalMessageId });
  assert.equal((await bulk.getBulkSend(attendant, created.campaignId)).counts.READ, 1);

  // Resposta do cliente entra na MESMA conversa (sem contato/conversa novos) e vincula ao lote.
  const conversationsBefore = await prisma.conversation.count({ where: { contact: { externalId: phone(70) } } });
  const reply = await saveIncoming({
    externalId: `wamid.reply.${Date.now()}`, contactExternalId: phone(70), phone: phone(70), contactName: "Ana",
    type: "text", text: "Tenho interesse!", occurredAt: new Date(), rawPayload: {},
  });
  await campaignReplyService.handleInboundMessage({ phone: phone(70), text: "Tenho interesse!", conversationId: reply.message.conversationId });
  assert.equal(await prisma.conversation.count({ where: { contact: { externalId: phone(70) } } }), conversationsBefore);
  assert.equal(await prisma.contact.count({ where: { externalId: phone(70) } }), 1);
  const conversation = await prisma.conversation.findUnique({ where: { id: reply.message.conversationId } });
  assert.equal(conversation.originCampaignId, created.campaignId);
  assert.equal((await prisma.campaignContact.findUnique({ where: { id: ana.id } })).status, "REPLIED");

  // 29. histórico por contato
  const history = await bulk.contactTemplateHistory(admin, conversation.contactId);
  assert.equal(history[0].template, "contato_comercial_inicial");
  assert.equal(history[0].status, "REPLIED");
});

test("19. template que perde a aprovação depois de enfileirado: só aquele destinatário falha", async () => {
  const channel = fakeChannel("principal");
  const created = await bulk.createBulkSend(attendant, {
    accountId: "legacy", name: "Bulk Teste aprovação", idempotencyKey: key(), defaultTemplate: { name: "contato_comercial_inicial", language: "pt_BR" },
    recipients: [recipient(80, "Ana"), recipient(81, "Bia", { templateName: "cliente_inativo_retorno", templateLanguage: "pt_BR" })],
  }, channel);
  const later = fakeChannel("principal", { list: templates.map((template) => template.name === "cliente_inativo_retorno" ? { ...template, status: "PAUSED" } : template) });
  await runWorker(later, 1, created.campaignId);
  const rows = await prisma.campaignContact.findMany({ where: { campaignId: created.campaignId }, orderBy: { phone: "asc" } });
  assert.deepEqual(rows.map((row) => row.status), ["SENT", "FAILED"]);
  assert.match(rows[1].failureReason, /não está mais aprovado/);
});

test("22. fila: master switch desligado não envia nada; ligado envia em lotes controlados", async () => {
  const channel = fakeChannel("principal");
  const created = await bulk.createBulkSend(attendant, {
    accountId: "legacy", name: "Bulk Teste fila", idempotencyKey: key(), defaultTemplate: { name: "cliente_inativo_retorno", language: "pt_BR" },
    recipients: [recipient(90, "A"), recipient(91, "B"), recipient(92, "C")],
  }, channel);
  await prisma.campaign.updateMany({ where: { origin: "PANEL", id: { not: created.campaignId }, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "PAUSED" } });
  await worker.runCampaignSendTick(channel); // switch OFF
  assert.equal(channel.sent.length, 0);
  await prisma.campaign.update({ where: { id: created.campaignId }, data: { batchSize: 2 } });
  await runWorker(channel, 1, created.campaignId);
  assert.equal(channel.sent.length, 2, "um tick envia no máximo o tamanho do lote");
  await runWorker(channel, 1, created.campaignId);
  assert.equal(channel.sent.length, 3);
  assert.equal((await prisma.campaign.findUnique({ where: { id: created.campaignId } })).status, "COMPLETED");
});

test("28. números remetentes: lista status/qualidade, bloqueia offline e sem permissão, e o worker envia pelo número do lote", async () => {
  const principal = fakeChannel("principal");
  const comercial = fakeChannel("comercial");
  useAccountChannels({ [account.id]: comercial });

  const numbers = await bulk.listSenderNumbers(attendant, principal);
  const mine = numbers.find((row) => row.id === account.id);
  assert.equal(mine.available, true);
  assert.equal(mine.quality, "GREEN");
  assert.ok(!numbers.some((row) => row.id === offlineAccount.id), "atendente só vê números liberados para ele");
  const adminNumbers = await bulk.listSenderNumbers(admin, principal);
  assert.equal(adminNumbers.find((row) => row.id === offlineAccount.id).available, false);

  await assert.rejects(() => bulk.resolveSender(admin, offlineAccount.id, principal), (error) => error.statusCode === 409);
  await assert.rejects(() => bulk.resolveSender(supervisor, account.id, principal), (error) => error.statusCode === 403);

  const created = await bulk.createBulkSend(attendant, {
    accountId: account.id, name: "Bulk Teste multi-número", idempotencyKey: key(), defaultTemplate: { name: "cliente_inativo_retorno", language: "pt_BR" },
    recipients: [recipient(95, "Ana")],
  }, principal);
  await runWorker(principal, 1, created.campaignId);
  assert.equal(comercial.sent.length, 1, "enviado pelo número escolhido");
  assert.equal(principal.sent.length, 0, "nunca pelo número principal");
  const conversation = await prisma.conversation.findFirst({ where: { contact: { externalId: phone(95) } } });
  assert.equal(conversation.channelAccountId, account.id);
  assert.equal(conversation.channelScope, account.id);
  assert.equal((await prisma.campaign.findUnique({ where: { id: created.campaignId } })).channelAccountId, account.id);
});
