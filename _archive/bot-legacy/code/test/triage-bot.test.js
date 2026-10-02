require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { seedTriageBot } = require("../prisma/seed");
const {
  businessHoursText, categoryReplyId, handleIncomingTriage, isBusinessHours,
} = require("../src/services/triage-bot-service");

const externalId = "triage-bot-test-contact";
const afterHoursExternalId = "triage-bot-after-hours-contact";
const concurrentExternalId = "triage-bot-concurrent-contact";

// Alguns outros arquivos de teste fazem `prisma.bot.deleteMany()` sem
// filtro (ex.: bot-flow-simulator.test.js, bot-simulator-endpoint.test.js)
// para isolar o próprio cenário — isso também apaga o Bot de sistema
// SYSTEM_TRIAGE seedado por prisma/seed.js no início da suíte. Recria aqui
// para este arquivo não depender da ordem em que os testes rodam.
test.before(async () => { await seedTriageBot(prisma); });

test.after(async () => {
  await prisma.auditLog.deleteMany({ where: { actorUserId: null } });
  await prisma.contact.deleteMany({ where: { externalId: { in: [externalId, afterHoursExternalId, concurrentExternalId] } } });
  await prisma.$disconnect();
});

test("envia apenas uma triagem quando duas mensagens chegam ao mesmo tempo", async () => {
  await prisma.contact.deleteMany({ where: { externalId: concurrentExternalId } });
  const contact = await prisma.contact.create({
    data: { externalId: concurrentExternalId, phone: "5511988887799", name: "Cliente Rápido" },
  });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
  const messages = await Promise.all(["one", "two"].map((suffix) => prisma.message.create({ data: {
    conversationId: conversation.id, externalId: `wamid.triage.concurrent.${suffix}`,
    direction: "RECEBIDA", status: "RECEBIDA", type: "text", text: "Olá", occurredAt: new Date(),
  } })));
  let menusSent = 0;
  const channel = { sendList: async () => {
    menusSent += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { externalId: `wamid.triage.concurrent.menu.${menusSent}`, data: { ok: true } };
  } };
  const results = await Promise.all(messages.map((message) => handleIncomingTriage(
    {}, message, channel, { now: new Date("2026-08-12T14:00:00.000Z") },
  )));
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(menusSent, 1);
  assert.equal(await prisma.message.count({
    where: { conversationId: conversation.id, direction: "ENVIADA", type: "interactive" },
  }), 1);
});

test("faz a triagem somente pelos quatro setores e registra o encaminhamento", async () => {
  await prisma.contact.deleteMany({ where: { externalId } });
  const contact = await prisma.contact.create({
    data: { externalId, phone: "5511988887777", name: "Cliente Triagem" },
  });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
  const incoming = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: "wamid.triage.incoming", direction: "RECEBIDA",
    status: "RECEBIDA", type: "text", text: "Olá", occurredAt: new Date(),
  } });
  const sentLists = [];
  const sentTexts = [];
  const channel = {
    sendList: async (phone, payload) => {
      sentLists.push({ phone, ...payload });
      return { externalId: `wamid.triage.menu.${sentLists.length}`, data: { ok: true } };
    },
    sendText: async (phone, text) => {
      sentTexts.push({ phone, text });
      return { externalId: `wamid.triage.confirmation.${sentTexts.length}`, data: { ok: true } };
    },
  };

  const duringBusinessHours = new Date("2026-08-12T14:00:00.000Z");
  assert.equal(await handleIncomingTriage({}, incoming, channel, { now: duringBusinessHours }), true);
  assert.deepEqual(sentLists[0].rows.map(({ title }) => title), [
    "Atendimento", "Suporte", "Comercial", "Parcerias",
  ]);
  assert.match(sentLists[0].body, /bem-vindo\(a\) à Mibro Brasil/i);
  assert.match(sentLists[0].body, new RegExp(businessHoursText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal((await prisma.conversation.findUnique({ where: { id: conversation.id } })).status, "BOT");

  const wholesale = await prisma.category.findUnique({ where: { code: "ATACADO" } });
  const invalidReply = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: "wamid.triage.invalid", direction: "RECEBIDA",
    status: "RECEBIDA", type: "interactive", text: "Atacado", occurredAt: new Date(),
  } });
  await handleIncomingTriage(
    { interactiveReplyId: categoryReplyId(wholesale.id) }, invalidReply, channel, { now: duringBusinessHours },
  );
  assert.equal(sentLists.length, 2);
  assert.equal((await prisma.conversation.findUnique({ where: { id: conversation.id } })).categoryId, null);

  const support = await prisma.category.findUnique({ where: { code: "SUPORTE" } });
  const validReply = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: "wamid.triage.valid", direction: "RECEBIDA",
    status: "RECEBIDA", type: "interactive", text: "Suporte", occurredAt: new Date(),
  } });
  await handleIncomingTriage(
    { interactiveReplyId: categoryReplyId(support.id) }, validReply, channel, { now: duringBusinessHours },
  );
  const completed = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(completed.categoryId, support.id);
  assert.equal(completed.status, "NOVO");
  assert.equal(completed.assignedUserId, null);
  assert.match(sentTexts[0].text, /Encaminhamos seu atendimento para o setor Suporte/);
  // Mensagem ao cliente não deve mais mencionar o prazo/finalização
  // automática — a regra real continua ativa (ver conversation-inactivity.test.js),
  // só o texto exibido foi removido.
  assert.doesNotMatch(sentTexts[0].text, /24 horas/);
  assert.doesNotMatch(sentTexts[0].text, /finalizada automaticamente/);
  assert.equal(await prisma.message.count({
    where: { conversationId: conversation.id, direction: "ENVIADA", type: "interactive" },
  }), 2);
  assert.equal(await prisma.conversationActivity.count({
    where: { conversationId: conversation.id, action: "BOT_TRIAGE_COMPLETED" },
  }), 1);
  const auditEntry = await prisma.auditLog.findFirst({
    where: { entityId: conversation.id, action: "CONVERSATION_CATEGORY_CHANGED" },
  });
  assert.ok(auditEntry);
  assert.match(auditEntry.summary, /Bot encaminhou/);
});

test("identifica o horário comercial de Brasília e avisa fora do expediente", async () => {
  assert.equal(isBusinessHours(new Date("2026-08-12T11:00:00.000Z")), true);
  assert.equal(isBusinessHours(new Date("2026-08-12T19:59:00.000Z")), true);
  assert.equal(isBusinessHours(new Date("2026-08-12T20:00:00.000Z")), false);
  assert.equal(isBusinessHours(new Date("2026-08-15T14:00:00.000Z")), false);

  const contact = await prisma.contact.create({
    data: { externalId: afterHoursExternalId, phone: "5511988887778", name: "Marina Silva" },
  });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
  const incoming = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: "wamid.triage.after-hours", direction: "RECEBIDA",
    status: "RECEBIDA", type: "text", text: "Olá", occurredAt: new Date(),
  } });
  let notice;
  let menuCount = 0;
  const channel = {
    sendText: async (_phone, text) => {
      notice = text;
      return { externalId: "wamid.triage.after-hours.notice", data: { ok: true } };
    },
    sendList: async () => {
      menuCount += 1;
      return { externalId: "wamid.triage.after-hours.next-day-menu", data: { ok: true } };
    },
  };
  await handleIncomingTriage({}, incoming, channel, { now: new Date("2026-08-12T20:01:00.000Z") });
  assert.match(notice, /Olá, Marina/);
  assert.match(notice, /não está online/);
  assert.match(notice, /segunda a sexta-feira, das 8h às 17h/);
  assert.equal((await prisma.conversation.findUnique({ where: { id: conversation.id } })).status, "BOT");

  const nextDayMessage = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: "wamid.triage.after-hours.next-day",
    direction: "RECEBIDA", status: "RECEBIDA", type: "text", text: "Olá novamente", occurredAt: new Date(),
  } });
  assert.equal(await handleIncomingTriage(
    {}, nextDayMessage, channel, { now: new Date("2026-08-13T14:00:00.000Z") },
  ), true);
  assert.equal(menuCount, 1);
});
