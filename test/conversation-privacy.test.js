require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const inbox = require("../src/services/inbox-service");
const authorization = require("../src/services/authorization-service");
const inboxEvents = require("../src/realtime/inbox-events");
const { finalizeInactiveConversations } = require("../src/services/conversation-inactivity-service");
const { saveIncoming } = require("../src/services/message-service");
const users = require("../src/services/user-management-service");

// Privacidade de conversa assumida + transferência com/sem histórico.
// Cenários numerados conforme a especificação (itens 1–13 da Parte 1).

const emailDomain = "@privacidade.test";
const contactPrefix = "privacy-test-";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { endsWith: emailDomain } }, select: { id: true } });
  const contacts = await prisma.contact.findMany({ where: { externalId: { startsWith: contactPrefix } }, select: { id: true } });
  const conversations = await prisma.conversation.findMany({ where: { contactId: { in: contacts.map(({ id }) => id) } }, select: { id: true } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: conversations.map(({ id }) => id) } } });
  await prisma.contact.deleteMany({ where: { id: { in: contacts.map(({ id }) => id) } } });
  await prisma.user.deleteMany({ where: { id: { in: users.map(({ id }) => id) } } });
}

let support;
let commercial;
let seq = 0;

async function createUser(name, { role = "ATENDENTE", categories = [], ...flags } = {}) {
  seq += 1;
  return prisma.user.create({
    data: {
      name, email: `u${seq}-${Date.now()}${emailDomain}`, role, canViewPreviousMessages: false, ...flags,
      categoryAccess: { create: categories.map((category) => ({ categoryId: category.id })) },
    },
  });
}

async function createConversation(label, categoryId) {
  const contact = await prisma.contact.create({
    data: { externalId: `${contactPrefix}${label}-${Date.now()}`, phone: `55119${String(Date.now()).slice(-8)}`, name: `Cliente Privacidade ${label}` },
  });
  return prisma.conversation.create({ data: { contactId: contact.id, categoryId, status: "NOVO", lastMessageAt: new Date() } });
}

async function customerMessage(conversationId, text, occurredAt = new Date()) {
  return prisma.message.create({ data: {
    conversationId, direction: "RECEBIDA", status: "RECEBIDA", type: "text", text, occurredAt,
  } });
}

async function agentMessage(conversationId, user, text, occurredAt = new Date()) {
  return prisma.message.create({ data: {
    conversationId, direction: "ENVIADA", status: "ENVIADA", type: "text", text, occurredAt, sentByUserId: user.id,
  } });
}

async function mediaMessage(conversationId, occurredAt) {
  return prisma.message.create({ data: {
    conversationId, direction: "RECEBIDA", status: "RECEBIDA", type: "image", text: null, occurredAt,
    mediaStorageKey: "privacy-test/nao-existe.jpg", mediaMimeType: "image/jpeg", mediaFileName: "foto.jpg",
  } });
}

const ids = (messages) => messages.map(({ id }) => id);

test.before(async () => {
  await cleanup();
  support = await prisma.category.findUnique({ where: { code: "SUPORTE" } });
  commercial = await prisma.category.findUnique({ where: { code: "COMERCIAL" } });
});
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("1–4: fila visível ao setor; ao assumir fica privada (403 por ID); Master sempre vê", async () => {
  const [userA, userB, master] = await Promise.all([
    createUser("Atendente A", { categories: [support] }),
    createUser("Atendente B", { categories: [support] }),
    createUser("Master Privacidade", { role: "ADMIN" }),
  ]);
  const conversation = await createConversation("fila", support.id);
  const first = await customerMessage(conversation.id, "Olá, preciso de ajuda", new Date(Date.now() - 5000));

  // 1. Não atribuída: elegíveis do setor veem.
  for (const viewer of [userA, userB]) {
    const list = await inbox.listConversations({}, viewer);
    assert.ok(list.some(({ id }) => id === conversation.id), `${viewer.name} deveria ver a conversa na fila`);
    assert.ok(await inbox.getConversation(conversation.id, viewer));
  }

  // 2. A assume → B deixa de ver.
  await inbox.updateConversation(conversation.id, { assignedUserId: userA.id }, userA);
  const listB = await inbox.listConversations({}, userB);
  assert.equal(listB.some(({ id }) => id === conversation.id), false);

  // 3. B tenta abrir/responder/anexo por ID → 403 "em atendimento por".
  await assert.rejects(() => inbox.getConversation(conversation.id, userB), (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.code, "CONVERSATION_ASSIGNED_TO_OTHER");
    assert.match(error.message, /Atendente A/);
    return true;
  });
  await assert.rejects(() => authorization.assertCanViewConversation(userB, conversation.id), { statusCode: 403 });
  await assert.rejects(() => inbox.updateConversation(conversation.id, { assignedUserId: userB.id }, userB), { statusCode: 403 });
  await assert.rejects(() => inbox.assertCanViewMessage(userB, first.id), { statusCode: 403 });
  await assert.rejects(() => inbox.addContactNote(conversation.contactId, { content: "x", authorId: userB.id }, userB), { statusCode: 403 });
  // Quem não é do setor nem descobre que a conversa existe (404).
  const outsider = await createUser("Fora do setor", { categories: [commercial] });
  await assert.rejects(() => authorization.assertCanViewConversation(outsider, conversation.id), { statusCode: 404 });

  // A continua vendo tudo.
  const detailA = await inbox.getConversation(conversation.id, userA);
  assert.deepEqual(ids(detailA.messages), [first.id]);

  // 4. Master abre normalmente.
  const masterDetail = await inbox.getConversation(conversation.id, master);
  assert.deepEqual(ids(masterDetail.messages), [first.id]);
  assert.equal(masterDetail.messageHistoryLimited, false);
});

test("5: transferência COM histórico entrega o histórico completo ao novo atendente", async () => {
  const [userA, userB] = await Promise.all([
    createUser("A com histórico", { categories: [support], canTransferConversations: true }),
    createUser("B com histórico", { categories: [support] }),
  ]);
  const conversation = await createConversation("com-historico", support.id);
  const m1 = await customerMessage(conversation.id, "Pedido 123 atrasado", new Date(Date.now() - 4000));
  await inbox.updateConversation(conversation.id, { assignedUserId: userA.id }, userA);
  const m2 = await agentMessage(conversation.id, userA, "Vou verificar", new Date(Date.now() - 3000));

  await inbox.updateConversation(conversation.id, {
    assignedUserId: userB.id, shareHistory: true, transferReason: "Especialista", handoffSummary: "Cliente aguarda rastreio",
  }, userA);
  const detailB = await inbox.getConversation(conversation.id, userB);
  assert.deepEqual(ids(detailB.messages), [m1.id, m2.id]);
  assert.equal(detailB.messageHistoryLimited, false);
  assert.equal(detailB.currentHandoff.historyShared, true);
  assert.equal(detailB.currentHandoff.handoffSummary, "Cliente aguarda rastreio");
  // A perdeu o acesso depois de transferir.
  await assert.rejects(() => inbox.getConversation(conversation.id, userA), { statusCode: 403 });
});

test("6–9 + 8 (auditoria): sem histórico, etapa do B, retorno ao A com tudo; Master vê tudo", async () => {
  const [userA, userB, master] = await Promise.all([
    createUser("A sem histórico", { categories: [support], canTransferConversations: true }),
    createUser("B sem histórico", { categories: [support], canTransferConversations: true, canViewConversationHistory: true }),
    createUser("Master acompanhamento", { role: "ADMIN" }),
  ]);
  const conversation = await createConversation("sem-historico", support.id);
  const m1 = await customerMessage(conversation.id, "Meu CPF é 123", new Date(Date.now() - 6000));
  const oldMedia = await mediaMessage(conversation.id, new Date(Date.now() - 5500));
  await inbox.updateConversation(conversation.id, { assignedUserId: userA.id }, userA);
  const m2 = await agentMessage(conversation.id, userA, "Recebido, analisando", new Date(Date.now() - 5000));
  await inbox.addContactNote(conversation.contactId, { content: "Nota da etapa do A", authorId: userA.id, conversationId: conversation.id }, userA);
  await sleep(10);

  // 6. A → B sem histórico.
  await inbox.updateConversation(conversation.id, {
    assignedUserId: userB.id, shareHistory: false, transferReason: "Assunto financeiro", handoffSummary: "Cliente quer segunda via",
  }, userA);
  const transfer = await prisma.conversationActivity.findFirst({
    where: { conversationId: conversation.id, action: "CONVERSATION_TRANSFERRED" }, orderBy: { createdAt: "desc" },
  });
  assert.equal(transfer.details.historyShared, false);

  // Na lista, a prévia não pode vazar a última mensagem da etapa do A.
  const listB = await inbox.listConversations({}, userB);
  const listed = listB.find(({ id }) => id === conversation.id);
  assert.ok(listed);
  assert.deepEqual(listed.messages, []);

  const limited = await inbox.getConversation(conversation.id, userB);
  assert.equal(limited.messageHistoryLimited, true);
  assert.deepEqual(ids(limited.messages), []);
  assert.equal(limited.currentHandoff.historyShared, false);
  assert.equal(limited.currentHandoff.reason, "Assunto financeiro");
  assert.equal(limited.currentHandoff.handoffSummary, "Cliente quer segunda via");
  // Eventos anteriores (nota da etapa do A) também ficam ocultos para B.
  assert.equal(limited.activities.some(({ action }) => action === "NOTE_ADDED"), false);
  assert.ok(limited.activities.some(({ action }) => action === "CONVERSATION_TRANSFERRED"));
  // Anexo da etapa oculta não é servido nem por ID.
  await assert.rejects(() => inbox.assertCanViewMessage(userB, oldMedia.id), { statusCode: 404 });
  // Nada foi apagado.
  assert.equal(await prisma.message.count({ where: { id: { in: [m1.id, m2.id, oldMedia.id] } } }), 3);

  // 7. B conversa com o cliente.
  await sleep(10);
  const m3 = await customerMessage(conversation.id, "Oi, sou eu de novo");
  const m4 = await agentMessage(conversation.id, userB, "Segunda via enviada");
  const duringB = await inbox.getConversation(conversation.id, userB);
  assert.deepEqual(ids(duringB.messages), [m3.id, m4.id]);

  // 8. B → A (mesmo sem compartilhar): A recupera o histórico antigo + etapa do B.
  await sleep(10);
  await inbox.updateConversation(conversation.id, { assignedUserId: userA.id, shareHistory: false }, userB);
  const backToA = await inbox.getConversation(conversation.id, userA);
  assert.equal(backToA.messageHistoryLimited, false);
  assert.deepEqual(ids(backToA.messages), [m1.id, oldMedia.id, m2.id, m3.id, m4.id]);
  const allowedMedia = await inbox.assertCanViewMessage(userA, oldMedia.id);
  assert.equal(allowedMedia.id, oldMedia.id);
  // B perdeu o acesso.
  await assert.rejects(() => inbox.getConversation(conversation.id, userB), { statusCode: 403 });

  // 9. Master vê tudo, inclusive as duas transferências e a escolha feita.
  const masterDetail = await inbox.getConversation(conversation.id, master);
  assert.deepEqual(ids(masterDetail.messages), [m1.id, oldMedia.id, m2.id, m3.id, m4.id]);
  const transfers = masterDetail.activities.filter(({ action }) => action === "CONVERSATION_TRANSFERRED");
  assert.equal(transfers.length, 2);
  assert.ok(transfers.every(({ details }) => details.historyShared === false));

  // Auditoria da transferência (item 8).
  const auditEntry = await prisma.auditLog.findFirst({
    where: { entityId: conversation.id, action: "CONVERSATION_ASSIGNEE_CHANGED", details: { path: ["toUserId"], equals: userB.id } },
  });
  assert.ok(auditEntry);
  assert.equal(auditEntry.actorUserId, userA.id);
  assert.equal(auditEntry.details.fromUserId, userA.id);
  assert.equal(auditEntry.details.historyShared, false);
  assert.equal(auditEntry.details.reason, "Assunto financeiro");
  assert.equal(auditEntry.details.handoffSummary, "Cliente quer segunda via");
  assert.equal(auditEntry.details.fromCategoryId, support.id);
  assert.equal(auditEntry.details.toCategoryId, support.id);
  assert.ok(auditEntry.createdAt instanceof Date);
});

test("10–11: transferência para setor volta à fila; quem assumir torna a conversa privada de novo", async () => {
  const [userA, commercialD, commercialE, master] = await Promise.all([
    createUser("A que envia ao setor", { categories: [support], canTransferConversations: true }),
    createUser("D Comercial", { categories: [commercial] }),
    createUser("E Comercial", { categories: [commercial] }),
    createUser("Master fila", { role: "ADMIN" }),
  ]);
  const conversation = await createConversation("setor", support.id);
  await customerMessage(conversation.id, "Quero comprar", new Date(Date.now() - 3000));
  await inbox.updateConversation(conversation.id, { assignedUserId: userA.id }, userA);

  // 10. A transfere para o setor Comercial → sem responsável individual.
  const moved = await inbox.updateConversation(conversation.id, { categoryId: commercial.id, transferReason: "Venda" }, userA);
  assert.equal(moved.assignedUserId, null);
  for (const viewer of [commercialD, commercialE]) {
    assert.ok((await inbox.listConversations({}, viewer)).some(({ id }) => id === conversation.id));
  }
  // A não é do Comercial: a conversa some para ele (null → 404 no controller).
  assert.equal(await inbox.getConversation(conversation.id, userA), null);
  await assert.rejects(() => authorization.assertCanViewConversation(userA, conversation.id), { statusCode: 404 });

  // 11. D assume → privada para D (E perde acesso; Master continua vendo).
  await inbox.updateConversation(conversation.id, { assignedUserId: commercialD.id }, commercialD);
  assert.equal((await inbox.listConversations({}, commercialE)).some(({ id }) => id === conversation.id), false);
  await assert.rejects(() => inbox.getConversation(conversation.id, commercialE), { statusCode: 403 });
  assert.ok(await inbox.getConversation(conversation.id, commercialD));
  assert.ok(await inbox.getConversation(conversation.id, master));

  // Dois "assumir" simultâneos: o segundo não sobrescreve o primeiro.
  const race = await createConversation("corrida", commercial.id);
  const results = await Promise.allSettled([
    inbox.updateConversation(race.id, { assignedUserId: commercialD.id }, commercialD),
    inbox.updateConversation(race.id, { assignedUserId: commercialE.id }, commercialE),
  ]);
  const winners = results.filter(({ status }) => status === "fulfilled");
  assert.equal(winners.length, 1);
  const final = await prisma.conversation.findUnique({ where: { id: race.id } });
  assert.equal(final.assignedUserId, winners[0].value.assignedUserId);
});

test("12–13: busca, alertas e SSE respeitam a visibilidade", async () => {
  const [userA, userB, master] = await Promise.all([
    createUser("A busca", { categories: [support] }),
    createUser("B busca", { categories: [support] }),
    createUser("Master busca", { role: "ADMIN" }),
  ]);
  const conversation = await createConversation("busca", support.id);
  const contact = await prisma.contact.findUnique({ where: { id: conversation.contactId } });
  await inbox.updateConversation(conversation.id, { assignedUserId: userA.id }, userA);

  // 12. Busca: B não encontra; A e Master encontram.
  const term = contact.name;
  assert.equal((await inbox.listConversations({ search: term }, userB)).length, 0);
  assert.equal((await inbox.listConversations({ search: term }, userA)).length, 1);
  assert.equal((await inbox.listConversations({ search: term }, master)).length, 1);

  // Alertas de nova mensagem do cliente: só o responsável (e Master).
  const since = new Date(Date.now() - 1000).toISOString();
  await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "AGUARDANDO_EQUIPE", unreadCount: 1 } });
  const incoming = await customerMessage(conversation.id, "Conteúdo sigiloso do cliente");
  const alertsA = await inbox.getUserAlerts({ since }, userA);
  const alertsB = await inbox.getUserAlerts({ since }, userB);
  assert.ok(alertsA.alerts.some(({ id }) => id === `message:${incoming.id}`));
  assert.equal(alertsB.alerts.some(({ conversationId }) => conversationId === conversation.id), false);

  // 13. SSE: o aviso global não carrega conteúdo; eventos direcionados só
  // chegam às conexões dos usuários informados.
  const frames = new Map();
  const fakeClient = (userId) => {
    const req = { user: { id: userId }, once() {} };
    const res = {
      destroyed: false, writableEnded: false,
      status() { return this; }, set() {}, flushHeaders() {},
      write(chunk) { frames.set(userId, [...(frames.get(userId) || []), chunk]); },
      once() {},
    };
    inboxEvents.handle(req, res);
  };
  fakeClient(userA.id);
  fakeClient(userB.id);
  inboxEvents.publish();
  inboxEvents.publishToUsers([userA.id], "internal-chat.updated", { chatId: "chat-x", kind: "message" });
  const framesA = frames.get(userA.id).join("");
  const framesB = frames.get(userB.id).join("");
  assert.match(framesA, /event: inbox.updated/);
  assert.match(framesB, /event: inbox.updated/);
  assert.doesNotMatch(framesB, /Conteúdo sigiloso/);
  assert.doesNotMatch(framesA, /Conteúdo sigiloso/);
  assert.match(framesA, /event: internal-chat.updated/);
  assert.doesNotMatch(framesB, /internal-chat.updated/);
});

test("14: auto-finalização mantém categoria e acesso só do último atendente; nova mensagem reinicia a triagem", async () => {
  const [lastAgent, otherAgent, master] = await Promise.all([
    createUser("Último atendente", { categories: [support] }),
    createUser("Outro do setor", { categories: [support] }),
    createUser("Master finalizadas", { role: "ADMIN" }),
  ]);
  const conversation = await createConversation("auto-finalizada", support.id);
  const contact = await prisma.contact.findUnique({ where: { id: conversation.contactId } });
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await inbox.updateConversation(conversation.id, { assignedUserId: lastAgent.id }, lastAgent);
  await agentMessage(conversation.id, lastAgent, "Posso ajudar em algo mais?", old);
  await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: old, status: "AGUARDANDO_CLIENTE" } });

  await finalizeInactiveConversations({ inactivityMinutes: 60 });
  const finalized = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(finalized.status, "FINALIZADO");
  assert.equal(finalized.categoryId, support.id);
  assert.equal(finalized.assignedUserId, lastAgent.id);
  assert.ok(await inbox.getConversation(conversation.id, lastAgent));
  assert.ok(await inbox.getConversation(conversation.id, master));
  await assert.rejects(() => inbox.getConversation(conversation.id, otherAgent), { statusCode: 403 });

  // Cliente volta a escrever: perde a categoria e o responsável até a nova triagem.
  await saveIncoming({
    externalId: `wamid.privacy.reopen.${Date.now()}`, contactExternalId: contact.externalId,
    phone: contact.phone, contactName: contact.name, type: "text", text: "Oi de novo",
    occurredAt: new Date(), rawPayload: {},
  });
  const reopened = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  if (reopened.status !== "FINALIZADO") {
    assert.equal(reopened.categoryId, null);
    assert.equal(reopened.assignedUserId, null);
  }
});

test("Supervisor vê conversas assumidas só nas áreas que gerencia e não acessa a Visão de equipe", async () => {
  const [agent, supervisor, master] = await Promise.all([
    createUser("Atendente da área", { categories: [support] }),
    createUser("Supervisor da área", { role: "SUPERVISOR", categories: [support], canViewTeamActivity: true }),
    createUser("Master equipe", { role: "ADMIN" }),
  ]);
  const inArea = await createConversation("supervisor-area", support.id);
  const outArea = await createConversation("supervisor-fora", commercial.id);
  const message = await customerMessage(inArea.id, "Preciso de ajuda com o relógio");
  await prisma.conversation.updateMany({ where: { id: { in: [inArea.id, outArea.id] } }, data: { assignedUserId: agent.id, status: "EM_ATENDIMENTO" } });

  const list = await inbox.listConversations({}, supervisor);
  assert.ok(list.some(({ id }) => id === inArea.id), "Supervisor deveria ver a conversa assumida na área dele");
  assert.equal(list.some(({ id }) => id === outArea.id), false);
  const detail = await inbox.getConversation(inArea.id, supervisor);
  assert.ok(ids(detail.messages).includes(message.id));
  await assert.rejects(() => authorization.assertCanViewConversation(supervisor, outArea.id), { statusCode: 404 });

  // Atendente comum da mesma área continua sem ver a conversa do colega.
  const otherAgent = await createUser("Outro atendente da área", { categories: [support] });
  assert.equal((await inbox.listConversations({}, otherAgent)).some(({ id }) => id === inArea.id), false);

  // Visão de equipe: só Master, mesmo com o flag antigo ligado.
  await assert.rejects(() => users.listTeamActivity(supervisor), { statusCode: 403 });
  await assert.rejects(() => inbox.listConversations({ assignedUser: agent.id }, supervisor), { statusCode: 403 });
  assert.ok(Array.isArray(await users.listTeamActivity(master)));
});

test("regra de início do histórico: o mais antigo ponto de acesso vence (unitário)", () => {
  const t = (seconds) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));
  const noHistory = (to, at) => ({ action: "CONVERSATION_TRANSFERRED", createdAt: at, details: { toUserId: to, historyShared: false } });
  const withHistory = (to, at) => ({ action: "CONVERSATION_TRANSFERRED", createdAt: at, details: { toUserId: to, historyShared: true } });
  const claim = (to, at) => ({ action: "CONVERSATION_CLAIMED", createdAt: at, details: { toUserId: to } });

  // B recebeu sem histórico: vê a partir da transferência.
  assert.deepEqual(inbox.resolveHistoryStart({ viewerId: "B", activities: [claim("A", t(1)), noHistory("B", t(10))], legacyStart: null }), t(10));
  // B recebeu com histórico: completo.
  assert.equal(inbox.resolveHistoryStart({ viewerId: "B", activities: [withHistory("B", t(10))], legacyStart: null }), null);
  // A assumiu da fila, depois voltou sem histórico: completo (acesso original vale).
  assert.equal(inbox.resolveHistoryStart({ viewerId: "A", activities: [claim("A", t(1)), noHistory("B", t(10)), noHistory("A", t(20))], legacyStart: null }), null);
  // A tinha acesso só a partir de t(5): volta vendo desde t(5), incluindo a etapa do B.
  assert.deepEqual(inbox.resolveHistoryStart({ viewerId: "A", activities: [noHistory("A", t(5)), noHistory("B", t(10)), noHistory("A", t(20))], legacyStart: null }), t(5));
  // Sem nenhuma transferência explícita: regra anterior (legacyStart) prevalece.
  assert.deepEqual(inbox.resolveHistoryStart({ viewerId: "A", activities: [], legacyStart: t(3) }), t(3));
  // Mensagem enviada antes pelo próprio atendente também conta como acesso.
  assert.deepEqual(inbox.resolveHistoryStart({ viewerId: "B", activities: [noHistory("B", t(10))], legacyStart: null, firstOwnMessageAt: t(4) }), t(4));
});
