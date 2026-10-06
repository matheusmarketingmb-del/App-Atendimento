require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const {
  checkFirstResponseSla, checkResponseSla, checkStalledConversationAlert, checkUnansweredConversationAlert,
  checkSlaNearBreachAlert, checkUnassignedConversationAlert,
} = require("../src/services/conversation-sla-service");
const { updateConversationAfterSending } = require("../src/services/message-service");

const testContacts = [
  "sla-first-response-test", "sla-response-test", "sla-internal-note-test", "sla-idempotent-test",
  "sla-near-breach-first-test", "sla-near-breach-response-test", "sla-unassigned-test", "sla-unassigned-new-test",
];

const baseSettings = {
  firstResponseSlaEnabled: true, firstResponseSlaMinutes: 10,
  responseSlaEnabled: true, responseSlaMinutes: 15,
  unansweredConversationAlertEnabled: true, unansweredConversationAlertMinutes: 30,
  stalledConversationAlertEnabled: true, stalledConversationAlertMinutes: 360,
  slaNearBreachAlertEnabled: true, slaNearBreachPercent: 80,
  unassignedConversationAlertEnabled: true, unassignedConversationAlertMinutes: 30,
  slaBusinessHoursOnly: false,
};

async function createContactAndConversation(externalId, phone, status, lastMessageAt, extra = {}) {
  const contact = await prisma.contact.create({ data: { companyId: "cmp_mibro", externalId, phone, name: `Cliente ${externalId}` } });
  const conversation = await prisma.conversation.create({
    data: { companyId: "cmp_mibro", contactId: contact.id, status, lastMessageAt, ...extra },
  });
  return { contact, conversation };
}

test.after(async () => {
  await prisma.contact.deleteMany({ where: { externalId: { in: testContacts } } });
  await prisma.$disconnect();
});

test("SLA de primeira resposta: inicia com mensagem do cliente (status NOVO) e some quando a empresa responde", async () => {
  const now = new Date("2026-08-20T12:00:00.000Z");
  const old = new Date("2026-08-20T11:00:00.000Z"); // 60min atrás, > 10min de SLA
  const { conversation } = await createContactAndConversation(testContacts[0], "5511900000001", "NOVO", old);

  const flagged = await checkFirstResponseSla({ now, settings: baseSettings });
  assert.ok(flagged >= 1);
  let updated = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(updated.firstResponseSlaBreached, true);

  // Empresa responde -> updateConversationAfterSending reseta o indicador.
  await updateConversationAfterSending({ conversationId: conversation.id, sentByUserId: null, occurredAt: now });
  updated = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(updated.firstResponseSlaBreached, false);
  assert.notEqual(updated.status, "FINALIZADO"); // nunca finaliza por causa da SLA
});

test("SLA de resposta durante atendimento: alerta quando AGUARDANDO_EQUIPE ultrapassa o prazo, nunca finaliza", async () => {
  const now = new Date("2026-08-20T12:00:00.000Z");
  const old = new Date("2026-08-20T11:30:00.000Z"); // 30min atrás, > 15min de SLA
  const { conversation } = await createContactAndConversation(testContacts[1], "5511900000002", "AGUARDANDO_EQUIPE", old);

  const flagged = await checkResponseSla({ now, settings: baseSettings });
  assert.ok(flagged >= 1);
  const activity = await prisma.conversationActivity.findFirst({
    where: { conversationId: conversation.id, action: "SLA_RESPONSE_BREACHED" },
  });
  assert.ok(activity, "deveria gravar SLA_RESPONSE_BREACHED");
  const updated = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(updated.status, "AGUARDANDO_EQUIPE");
  assert.notEqual(updated.status, "FINALIZADO");
});

test("mensagem interna (chat interno da equipe) não reseta o SLA de resposta em atendimento", async () => {
  const now = new Date("2026-08-20T12:00:00.000Z");
  const old = new Date("2026-08-20T11:30:00.000Z");
  const { conversation } = await createContactAndConversation(testContacts[2], "5511900000003", "AGUARDANDO_EQUIPE", old);

  const chat = await prisma.internalChat.create({ data: { key: `sla-test-chat-${conversation.id}`, type: "GENERAL" } });
  await prisma.internalMessage.create({
    data: { chatId: chat.id, conversationId: conversation.id, type: "USER", text: "Nota interna, cliente ainda não recebeu retorno" },
  });

  const untouched = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(untouched.status, "AGUARDANDO_EQUIPE");
  assert.equal(untouched.lastMessageAt.getTime(), old.getTime());

  const flagged = await checkResponseSla({ now, settings: baseSettings });
  assert.ok(flagged >= 1, "a mensagem interna não deveria ter resetado o SLA");
});

test("alertas não duplicam em execuções repetidas do monitor (idempotência)", async () => {
  const now = new Date("2026-08-20T12:00:00.000Z");
  const old = new Date("2026-08-20T05:00:00.000Z"); // 7h atrás, > 6h de stalled
  const { conversation } = await createContactAndConversation(testContacts[3], "5511900000004", "EM_ATENDIMENTO", old);

  await checkStalledConversationAlert({ now, settings: baseSettings });
  await checkStalledConversationAlert({ now, settings: baseSettings });
  await checkUnansweredConversationAlert({ now, settings: { ...baseSettings, unansweredConversationAlertMinutes: 30 } });

  const stalledCount = await prisma.conversationActivity.count({
    where: { conversationId: conversation.id, action: "STALLED_CONVERSATION_ALERT" },
  });
  assert.equal(stalledCount, 1, "não deveria duplicar o alerta de conversa parada");
});

test("SLA próximo do limite (primeira resposta): alerta ao passar 80% do prazo, mas nunca marca como estourado", async () => {
  const now = new Date("2026-08-20T12:00:00.000Z");
  // 9min atrás, 90% de 10min — passou de 80% mas não estourou ainda (10min).
  const old = new Date("2026-08-20T11:51:00.000Z");
  const { conversation } = await createContactAndConversation(testContacts[4], "5511900000005", "NOVO", old);

  const flagged = await checkSlaNearBreachAlert({ now, settings: baseSettings });
  assert.ok(flagged >= 1);
  const activity = await prisma.conversationActivity.findFirst({
    where: { conversationId: conversation.id, action: "SLA_NEAR_BREACH_FIRST_RESPONSE" },
  });
  assert.ok(activity, "deveria gravar SLA_NEAR_BREACH_FIRST_RESPONSE");
  const updated = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(updated.firstResponseSlaBreached, false, "próximo do limite não é a mesma coisa que estourado");
});

test("SLA próximo do limite (resposta durante atendimento): mesma lógica para AGUARDANDO_EQUIPE/HANDOFF_BOT", async () => {
  const now = new Date("2026-08-20T12:00:00.000Z");
  // 13min atrás, ~87% de 15min.
  const old = new Date("2026-08-20T11:47:00.000Z");
  const { conversation } = await createContactAndConversation(testContacts[5], "5511900000006", "HANDOFF_BOT", old);

  const flagged = await checkSlaNearBreachAlert({ now, settings: baseSettings });
  assert.ok(flagged >= 1);
  const activity = await prisma.conversationActivity.findFirst({
    where: { conversationId: conversation.id, action: "SLA_NEAR_BREACH_RESPONSE" },
  });
  assert.ok(activity, "deveria gravar SLA_NEAR_BREACH_RESPONSE para HANDOFF_BOT também");
  const updated = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(updated.responseSlaBreached, false);
});

test("conversa sem responsável: alerta interno quando ativa e sem assignedUserId há tempo suficiente, nunca para NOVO nem FINALIZADO", async () => {
  const now = new Date("2026-08-20T12:00:00.000Z");
  const old = new Date("2026-08-20T11:00:00.000Z"); // 60min atrás, > 30min do alerta
  const { conversation } = await createContactAndConversation(
    testContacts[6], "5511900000007", "AGUARDANDO_EQUIPE", old, { assignedUserId: null },
  );
  // NOVO já aparece naturalmente na fila (sempre sem responsável) — não deve
  // gerar este alerta específico, para não duplicar sinal.
  const { conversation: novaConversation } = await createContactAndConversation(
    testContacts[7], "5511900000008", "NOVO", old, { assignedUserId: null },
  );

  const flagged = await checkUnassignedConversationAlert({ now, settings: baseSettings });
  assert.ok(flagged >= 1);
  const activity = await prisma.conversationActivity.findFirst({
    where: { conversationId: conversation.id, action: "UNASSIGNED_CONVERSATION_ALERT" },
  });
  assert.ok(activity, "deveria gravar UNASSIGNED_CONVERSATION_ALERT");
  const novaActivity = await prisma.conversationActivity.findFirst({
    where: { conversationId: novaConversation.id, action: "UNASSIGNED_CONVERSATION_ALERT" },
  });
  assert.equal(novaActivity, null, "conversa NOVO não deveria gerar este alerta específico");
});
