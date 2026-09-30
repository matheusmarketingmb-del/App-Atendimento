// Supervisão de equipes: vínculo Supervisor → Atendentes (Master), acesso de
// supervisão somente aos TRECHOS em que a equipe atendeu, histórico real por
// períodos, linha do tempo, RBAC e backfill.
require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const authorization = require("../src/services/authorization-service");
const inbox = require("../src/services/inbox-service");
const supervision = require("../src/services/supervision-service");
const messageService = require("../src/services/message-service");
const inboxEvents = require("../src/realtime/inbox-events");
const periods = require("../src/services/assignment-period-service");
const { runBackfill } = require("../scripts/backfill-assignment-periods");

const TAG = `sup-${Date.now().toString(36)}`;
const U = {};
let support; let commercial;
const created = { conversations: [], contacts: [] };
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const ids = (messages) => messages.map(({ id }) => id);

async function user(key, role, extra = {}) {
  U[key] = await prisma.user.create({ data: { name: `${key} ${TAG}`, email: `${key}.${TAG}@teste.local`, role, ...extra } });
  return U[key];
}
async function grant(userKey, ...categories) {
  await prisma.userCategoryAccess.createMany({ data: categories.map((category) => ({ userId: U[userKey].id, categoryId: category.id })) });
}
async function conversation(suffix, categoryId) {
  const contact = await prisma.contact.create({ data: { channel: "META", externalId: `55119${Date.now().toString().slice(-8)}${suffix}`.slice(0, 13), phone: `5511988${String(Math.random()).slice(2, 8)}`, name: `Cliente ${suffix} ${TAG}` } });
  created.contacts.push(contact.id);
  const row = await prisma.conversation.create({ data: { contactId: contact.id, channel: "META", channelScope: `LEGACY-${TAG}-${suffix}`, categoryId, status: "NOVO", lastMessageAt: new Date() } });
  created.conversations.push(row.id);
  return row;
}
async function customer(conversationId, text) {
  await tick();
  const message = await prisma.message.create({ data: { conversationId, channel: "META", direction: "RECEBIDA", status: "RECEBIDA", type: "text", text, occurredAt: new Date(), externalId: `wamid.${TAG}.${Math.random()}` } });
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: message.occurredAt } });
  await tick();
  return message;
}
async function agentSays(conversationId, userKey, text) {
  await tick();
  const occurredAt = new Date();
  const message = await prisma.message.create({ data: { conversationId, channel: "META", direction: "ENVIADA", status: "ENVIADA", type: "text", text, occurredAt, sentByUserId: U[userKey].id } });
  await messageService.updateConversationAfterSending({ conversationId, sentByUserId: U[userKey].id, occurredAt });
  await tick();
  return message;
}
const sees = async (userKey, conversationId) => {
  try { await authorization.assertCanViewConversation(U[userKey], conversationId); return true; } catch (error) { return error.statusCode; }
};

let X; // conversa principal: Ana → Carlos → Pedro
const M = {};

test.before(async () => {
  support = await prisma.category.create({ data: { code: `suporte-${TAG}`, name: `Suporte ${TAG}` } });
  commercial = await prisma.category.create({ data: { code: `comercial-${TAG}`, name: `Comercial ${TAG}` } });
  await user("master", "ADMIN");
  await user("joao", "SUPERVISOR");
  await user("maria", "SUPERVISOR");
  await user("semEquipe", "SUPERVISOR");
  await user("ana", "ATENDENTE", { canTransferConversations: true });
  await user("carlos", "ATENDENTE", { canTransferConversations: true });
  await user("pedro", "ATENDENTE");
  await user("outro", "ATENDENTE");
  await grant("ana", support);
  await grant("carlos", support, commercial);
  await grant("pedro", support, commercial);
  await grant("outro", support);
  await grant("joao", support);
  await grant("semEquipe", support);
});

test.after(async () => {
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: created.conversations } }, { actorUserId: { in: Object.values(U).map(({ id }) => id) } }] } });
  await prisma.contact.deleteMany({ where: { id: { in: created.contacts } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(U).map(({ id }) => id) } } });
  await prisma.category.deleteMany({ where: { id: { in: [support.id, commercial.id] } } });
  await prisma.$disconnect();
});

test("equipes: somente o Master vincula atendentes (com auditoria); Supervisor não se autoatribui", async () => {
  await assert.rejects(() => supervision.addTeamMember(U.joao, U.joao.id, U.ana.id), { statusCode: 403 });
  await assert.rejects(() => supervision.addTeamMember(U.ana, U.joao.id, U.ana.id), { statusCode: 403 });
  assert.deepEqual(await supervision.addTeamMember(U.master, U.joao.id, U.ana.id), { added: true });
  assert.deepEqual(await supervision.addTeamMember(U.master, U.joao.id, U.ana.id), { added: false });
  await supervision.addTeamMember(U.master, U.maria.id, U.carlos.id);
  // Um atendente pode estar em mais de uma equipe (supervisores de áreas diferentes).
  await supervision.addTeamMember(U.master, U.maria.id, U.ana.id);
  await supervision.removeTeamMember(U.master, U.maria.id, U.ana.id);
  const logs = await prisma.auditLog.findMany({ where: { actorUserId: U.master.id, action: { in: ["SUPERVISOR_TEAM_MEMBER_ADDED", "SUPERVISOR_TEAM_MEMBER_REMOVED"] } } });
  assert.equal(logs.length, 4);
  assert.equal(logs.find((log) => log.action === "SUPERVISOR_TEAM_MEMBER_REMOVED").details.member, U.ana.name);
  const teams = await supervision.listTeams(U.master);
  assert.deepEqual(teams.find((team) => team.id === U.joao.id).members.map(({ id }) => id), [U.ana.id]);
  assert.deepEqual(teams.find((team) => team.id === U.semEquipe.id).members, [], "Supervisor pode existir sem atendentes");
  await assert.rejects(() => supervision.listTeams(U.joao), { statusCode: 403 });
});

test("1/2. Ana (equipe do João) assume: Ana, João e Master veem; outro atendente não", async () => {
  X = await conversation("x", support.id);
  M.c1 = await customer(X.id, "Oi, preciso de ajuda");
  await inbox.updateConversation(X.id, { assignedUserId: U.ana.id }, U.ana);
  const beforeReply = (await inbox.listConversations({}, U.joao)).find(({ id }) => id === X.id);
  assert.deepEqual(beforeReply.messages, [], "prévia não revela mensagem anterior ao trecho da equipe");
  M.a1 = await agentSays(X.id, "ana", "Olá! Sou a Ana.");
  M.c2 = await customer(X.id, "Meu relógio não liga");
  M.a2 = await agentSays(X.id, "ana", "Vou verificar.");
  assert.equal(await sees("ana", X.id), true);
  assert.equal(await sees("joao", X.id), true);
  assert.equal(await sees("master", X.id), true);
  assert.notEqual(await sees("outro", X.id), true);
  const open = await prisma.conversationAssignmentPeriod.findMany({ where: { conversationId: X.id } });
  assert.equal(open.length, 1);
  assert.equal(open[0].userId, U.ana.id);
  assert.equal(open[0].startReason, "CLAIMED");
  assert.equal(open[0].endedAt, null);
  // Supervisão é somente leitura: não responde, não assume, não altera.
  await assert.rejects(() => authorization.assertCanActOnConversation(U.joao, X.id), { statusCode: 403, code: "SUPERVISION_READ_ONLY" });
  await assert.rejects(() => inbox.updateConversation(X.id, { assignedUserId: U.joao.id }, U.joao), { statusCode: 403 });
  // Abrir por supervisão não zera as não lidas do atendente nem confirma leitura ao cliente.
  await prisma.conversation.update({ where: { id: X.id }, data: { unreadCount: 3 } });
  const receipts = [];
  const read = await inbox.markAsRead(X.id, { channel: { markAsRead: async (id) => receipts.push(id) }, viewer: U.joao });
  assert.equal(read.passive, true);
  assert.equal(receipts.length, 0);
  assert.equal((await prisma.conversation.findUnique({ where: { id: X.id } })).unreadCount, 3);
});

test("3/4/7. transferência SEM histórico para Carlos (equipe da Maria): cada um vê o seu trecho", async () => {
  await inbox.updateConversation(X.id, { assignedUserId: U.carlos.id, shareHistory: false, transferReason: "Assunto comercial" }, U.ana);
  M.c3 = await customer(X.id, "Quero comprar mais 10");
  M.k1 = await agentSays(X.id, "carlos", "Oi, Carlos aqui.");

  // Carlos recebeu sem histórico: não vê a etapa da Ana.
  const carlos = await inbox.getConversation(X.id, U.carlos);
  assert.deepEqual(ids(carlos.messages).filter((id) => [M.c1.id, M.a1.id, M.c2.id, M.a2.id].includes(id)), []);
  assert.ok(ids(carlos.messages).includes(M.k1.id));

  // João (supervisor da Ana) continua vendo SÓ o trecho da Ana, com datas.
  assert.equal(await sees("joao", X.id), true);
  const joao = await inbox.getConversation(X.id, U.joao);
  assert.equal(joao.accessMode, "SUPERVISION");
  assert.deepEqual(ids(joao.messages), [M.c1.id, M.a1.id, M.c2.id, M.a2.id].filter((id) => ids(joao.messages).includes(id)));
  assert.ok([M.a1.id, M.c2.id, M.a2.id].every((id) => ids(joao.messages).includes(id)));
  assert.ok(![M.c3.id, M.k1.id].some((id) => ids(joao.messages).includes(id)), "trecho do Carlos não aparece para o João");
  assert.equal(joao.visibleWindows.length, 1);
  assert.ok(joao.visibleWindows[0].to, "trecho da Ana tem data de fim");

  // Maria (supervisora do Carlos) passa a supervisionar — só o trecho do Carlos.
  const maria = await inbox.getConversation(X.id, U.maria);
  assert.ok([M.c3.id, M.k1.id].every((id) => ids(maria.messages).includes(id)));
  assert.ok(![M.a1.id, M.a2.id].some((id) => ids(maria.messages).includes(id)));

  // Master vê tudo.
  const master = await inbox.getConversation(X.id, U.master);
  assert.ok([M.c1.id, M.a1.id, M.c3.id, M.k1.id].every((id) => ids(master.messages).includes(id)));

  // Anexo/mensagem por ID fora do trecho: bloqueado ao João.
  await assert.rejects(() => inbox.assertCanViewMessage(U.joao, M.k1.id), { statusCode: 404 });
  assert.ok(await inbox.assertCanViewMessage(U.joao, M.a1.id));

  // Na lista, a prévia do João é do trecho da Ana (nunca a mensagem do Carlos).
  const card = (await inbox.listConversations({}, U.joao)).find(({ id }) => id === X.id);
  assert.equal(card.accessMode, "SUPERVISION");
  assert.equal(card.messages[0].id, M.a2.id);
  assert.equal(card.unreadCount, 0);
});

test("5/6. finalizada: continua no histórico de Ana e Carlos; Master vê pela Ana mesmo com outro responsável", async () => {
  await inbox.updateConversation(X.id, { assignedUserId: U.pedro.id }, U.carlos);
  await inbox.updateConversation(X.id, { status: "FINALIZADO" }, U.pedro);
  const forAna = await supervision.memberConversations(U.master, U.ana.id, { tab: "history" });
  const row = forAna.rows.find(({ id }) => id === X.id);
  assert.ok(row, "conversa aparece no histórico da Ana");
  assert.equal(row.currentAssignee.id, U.pedro.id);
  assert.equal(row.transferred, true);
  assert.equal(row.messagesSentByMember, 2);
  assert.ok(row.firstParticipationAt && row.lastParticipationAt);
  assert.equal(row.status, "FINALIZADO");
  assert.ok(forAna.rows[0].lastMessageAt !== undefined);
  assert.equal((await supervision.memberConversations(U.master, U.ana.id, { tab: "current" })).rows.some(({ id }) => id === X.id), false);
  assert.ok((await supervision.memberConversations(U.master, U.carlos.id, { tab: "history", state: "finished" })).rows.some(({ id }) => id === X.id));
  // Supervisor consulta só a própria equipe.
  assert.ok((await supervision.memberConversations(U.joao, U.ana.id, { tab: "history" })).rows.some(({ id }) => id === X.id));
  await assert.rejects(() => supervision.memberConversations(U.joao, U.carlos.id, { tab: "history" }), { statusCode: 403 });
  await assert.rejects(() => supervision.memberConversations(U.outro, U.ana.id, {}), { statusCode: 403 });
  // Participação real registrada, mesmo após trocas de responsável.
  const participants = await prisma.conversationAssignmentPeriod.findMany({ where: { conversationId: X.id }, orderBy: { startedAt: "asc" } });
  assert.deepEqual(participants.map(({ userId }) => userId), [U.ana.id, U.carlos.id, U.pedro.id]);
  assert.deepEqual(participants.map(({ endReason }) => endReason), ["TRANSFERRED", "TRANSFERRED", null]);
});

test("8/9/10. por ID: atendente fora e supervisor de outra equipe bloqueados; Master permitido", async () => {
  assert.notEqual(await sees("outro", X.id), true);
  assert.ok([403, 404].includes(await sees("outro", X.id)));
  assert.ok([403, 404].includes(await sees("semEquipe", X.id)));
  assert.equal(await sees("master", X.id), true);
  // Mesmo setor: a regra existente responde 403 "em atendimento por…" (sem conteúdo).
  await assert.rejects(() => inbox.getConversation(X.id, U.semEquipe), { statusCode: 403, code: "CONVERSATION_ASSIGNED_TO_OTHER" });
});

test("11. busca do Supervisor encontra a conversa histórica da equipe; supervisor de outra equipe não", async () => {
  const search = `Cliente x ${TAG}`;
  assert.ok((await inbox.listConversations({ search }, U.joao)).some(({ id }) => id === X.id));
  assert.equal((await inbox.listConversations({ search }, U.semEquipe)).some(({ id }) => id === X.id), false);
  assert.equal((await inbox.listConversations({ search }, U.outro)).some(({ id }) => id === X.id), false);
  assert.ok((await inbox.listConversations({ search }, U.master)).some(({ id }) => id === X.id));
});

test("12. realtime: o SSE não carrega conteúdo de conversa; cada tela recarrega pela API filtrada", async () => {
  const frames = [];
  const fake = (userId) => {
    const res = { destroyed: false, writableEnded: false, write: (frame) => frames.push({ userId, frame }), status() { return res; }, set() {}, flushHeaders() {}, once() {} };
    return res;
  };
  const listeners = [];
  const req = (userId) => ({ user: { id: userId }, once: (event, fn) => listeners.push(fn) });
  inboxEvents.handle(req(U.joao.id), fake(U.joao.id));
  inboxEvents.handle(req(U.semEquipe.id), fake(U.semEquipe.id));
  inboxEvents.publish();
  listeners.forEach((fn) => fn());
  const updates = frames.filter(({ frame }) => frame.includes("inbox.updated"));
  assert.equal(updates.length, 2);
  for (const { frame } of updates) {
    assert.doesNotMatch(frame, new RegExp(X.id));
    assert.deepEqual(Object.keys(JSON.parse(frame.split("data: ")[1])), ["at"]);
  }
  // O que cada um recarrega depois do aviso respeita a equipe.
  assert.equal((await inbox.listConversations({}, U.semEquipe)).some(({ id }) => id === X.id), false);
});

test("linha do tempo: Master completa; Supervisor só os eventos do trecho da equipe (incluindo a transferência que o encerrou)", async () => {
  const full = await supervision.conversationTimeline(U.master, X.id);
  assert.equal(full.scope, "FULL");
  assert.deepEqual(full.participants.map(({ user }) => user.id), [U.ana.id, U.carlos.id, U.pedro.id]);
  assert.ok(full.events.some((event) => /finalizou/.test(event.text)));
  assert.ok(full.events.some((event) => /sem compartilhar histórico/.test(event.text)));
  const joao = await supervision.conversationTimeline(U.joao, X.id);
  assert.equal(joao.scope, "TEAM_SEGMENTS");
  assert.deepEqual(joao.participants.map(({ user }) => user.id), [U.ana.id]);
  assert.ok(joao.events.some((event) => /assumiu/.test(event.text)));
  assert.ok(joao.events.some((event) => event.action === "CONVERSATION_TRANSFERRED" && /Carlos|carlos/.test(event.text)));
  assert.equal(joao.events.some((event) => /finalizou/.test(event.text)), false, "finalização pelo Pedro está fora do trecho da Ana");
  assert.deepEqual(joao.messagesByUser.map(({ userId, count }) => [userId, count]), [[U.ana.id, 2]]);
  await assert.rejects(() => supervision.conversationTimeline(U.ana, X.id), { statusCode: 403 });
});

test("visão Minha equipe (Supervisor) e Equipes (Master) com contadores; atendente não acessa", async () => {
  const Y = await conversation("y", support.id);
  await customer(Y.id, "Olá");
  await inbox.updateConversation(Y.id, { assignedUserId: U.ana.id }, U.ana);
  await agentSays(Y.id, "ana", "Oi!");
  const mine = await supervision.teamOverview(U.joao);
  assert.deepEqual(mine.members.map(({ id }) => id).sort(), [U.joao.id, U.ana.id].sort());
  const ana = mine.members.find(({ id }) => id === U.ana.id);
  assert.equal(ana.inProgress, 1);
  assert.ok(ana.handledToday >= 2);
  const joaoTeam = await supervision.teamOverview(U.master, { supervisorId: U.joao.id });
  assert.ok(joaoTeam.members.some(({ id }) => id === U.ana.id));
  assert.ok((await supervision.teamOverview(U.master)).members.some(({ id }) => id === U.carlos.id));
  await assert.rejects(() => supervision.teamOverview(U.ana), { statusCode: 403 });
  // Atuais x Histórico
  const current = await supervision.memberConversations(U.joao, U.ana.id, { tab: "current" });
  assert.deepEqual(current.rows.map(({ id }) => id), [Y.id]);
  const history = await supervision.memberConversations(U.joao, U.ana.id, { tab: "history" });
  assert.ok(history.rows.some(({ id }) => id === X.id) && history.rows.some(({ id }) => id === Y.id));
  const transferred = await supervision.memberConversations(U.joao, U.ana.id, { tab: "history", state: "transferred" });
  assert.deepEqual(transferred.rows.map(({ id }) => id), [X.id]);
  assert.equal(transferred.rows[0].lastMessageAt, null, "Supervisor não vê horário fora do trecho");
});

test("atendente comum: regras atuais preservadas (sem visão de equipe, sem conversa de colega)", async () => {
  assert.equal(await sees("ana", X.id) === true, false, "Ana transferiu e deixou de ser responsável");
  await assert.rejects(() => supervision.teamOverview(U.outro), { statusCode: 403 });
  assert.equal((await inbox.listConversations({}, U.outro)).some(({ id }) => id === X.id), false);
});

test("janelas: união/sobreposição e filtro de datas (unitário)", () => {
  const d = (m) => new Date(Date.UTC(2026, 8, 30, 10, m));
  assert.deepEqual(periods.mergeWindows([{ from: d(0), to: d(20) }, { from: d(10), to: d(30) }, { from: d(40), to: null }]), [{ from: d(0), to: d(30) }, { from: d(40), to: null }]);
  assert.equal(periods.withinWindows(d(25), [{ from: d(0), to: d(20) }]), false);
  assert.equal(periods.withinWindows(d(5), [{ from: d(0), to: d(20) }]), true);
  assert.equal(periods.isFullWindow(periods.mergeWindows([{ from: null, to: null }, { from: d(1), to: d(2) }])), true);
});

test("backfill: reconstrói períodos de conversa antiga a partir das atividades/mensagens; simulação não grava; idempotente", async () => {
  const L = await conversation("legado", support.id);
  const base = Date.now();
  const t = (m) => new Date(base - (120 - m) * 60_000);
  await prisma.conversation.update({ where: { id: L.id }, data: { assignedUserId: U.pedro.id } });
  await prisma.conversationActivity.createMany({ data: [
    { conversationId: L.id, action: "CONVERSATION_CLAIMED", actorUserId: U.ana.id, details: { toUserId: U.ana.id }, createdAt: t(0) },
    { conversationId: L.id, action: "CONVERSATION_TRANSFERRED", actorUserId: U.ana.id, details: { fromUserId: U.ana.id, toUserId: U.carlos.id }, createdAt: t(20) },
    { conversationId: L.id, action: "CONVERSATION_TRANSFERRED", actorUserId: U.carlos.id, details: { fromUserId: U.carlos.id, toUserId: U.pedro.id }, createdAt: t(45) },
  ] });
  await prisma.message.create({ data: { conversationId: L.id, channel: "META", direction: "ENVIADA", status: "ENVIADA", type: "text", text: "legado", occurredAt: t(5), sentByUserId: U.ana.id } });
  const silent = () => {};
  const dry = await runBackfill({ log: silent });
  assert.equal(dry.mode, "DRY_RUN");
  assert.equal(await prisma.conversationAssignmentPeriod.count({ where: { conversationId: L.id } }), 0, "simulação não grava");
  await runBackfill({ apply: true, log: silent });
  const rebuilt = await prisma.conversationAssignmentPeriod.findMany({ where: { conversationId: L.id }, orderBy: { startedAt: "asc" } });
  assert.deepEqual(rebuilt.map(({ userId, source }) => [userId, source]), [[U.ana.id, "BACKFILL"], [U.carlos.id, "BACKFILL"], [U.pedro.id, "BACKFILL"]]);
  assert.deepEqual(rebuilt.map(({ endedAt }) => endedAt?.getTime() ?? null), [t(20).getTime(), t(45).getTime(), null]);
  // João (supervisor da Ana) passa a supervisionar o trecho histórico da Ana.
  assert.equal(await sees("joao", L.id), true);
  await runBackfill({ apply: true, log: silent });
  assert.equal(await prisma.conversationAssignmentPeriod.count({ where: { conversationId: L.id } }), 3, "rodar de novo não duplica");
});
