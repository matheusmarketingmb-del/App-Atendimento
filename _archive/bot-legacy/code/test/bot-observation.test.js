require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { observeIncomingMessage } = require("../src/services/bot-observation-service");

const botName = "Bot Observação Teste";
const externalId = "bot-observation-test-contact";

async function cleanup() {
  await prisma.bot.deleteMany({ where: { name: botName } });
  await prisma.contact.deleteMany({ where: { externalId } });
}

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function seedConversation(phone, text, externalMessageId) {
  const contact = await prisma.contact.create({ data: { externalId, phone, name: "Cliente Observação" } });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
  const message = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: externalMessageId, direction: "RECEBIDA",
    status: "RECEBIDA", type: "text", text, occurredAt: new Date(),
  } });
  return { contact, conversation, message };
}

test("observa a intenção do Bot ativo, persiste a observação e não altera a conversa nem envia mensagem", async (t) => {
  await cleanup();
  const { conversation, message } = await seedConversation("5511988880000", "quero rastrear meu pedido", "wamid.observation.incoming");
  const category = await prisma.category.findFirst();
  const bot = await prisma.bot.create({
    data: {
      name: botName,
      status: "ACTIVE",
      channel: "META",
      initialMessage: "Olá!",
      outsideHoursMessage: "Fora do horário.",
      fallbackMessage: "Não entendi.",
      defaultCategoryId: category?.id || null,
      intents: {
        create: [{
          name: "Rastreamento",
          priority: 1,
          active: true,
          fallbackAction: "USE_BOT_FALLBACK",
          examples: { create: [{ text: "rastrear meu pedido" }] },
        }],
      },
    },
  });

  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args));

  const result = await observeIncomingMessage(
    { type: "text", text: message.text }, message, { now: new Date("2026-08-12T14:00:00.000Z") },
  );

  assert.equal(result.intentName, "Rastreamento");
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], "[BOT_OBSERVATION]");

  const observation = await prisma.botObservation.findUnique({ where: { messageId: message.id } });
  assert.ok(observation, "deveria persistir a observação para comparação futura");
  assert.equal(observation.conversationId, conversation.id);
  assert.equal(observation.botId, bot.id);
  assert.equal(observation.botName, botName);
  assert.equal(observation.withinHours, true);
  assert.equal(observation.intentName, "Rastreamento");
  assert.equal(observation.mode, "OBSERVATION");
  assert.equal(observation.status, "OK");
  assert.equal(observation.provider, "LOCAL_FALLBACK");
  assert.ok(observation.confidence > 0);
  assert.equal(observation.action, "RESPOND");

  const conversationAfter = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(conversationAfter.status, "NOVO");
  assert.equal(conversationAfter.categoryId, null);
  assert.equal(conversationAfter.assignedUserId, null);
  assert.equal(await prisma.message.count({ where: { conversationId: conversation.id } }), 1, "nenhuma mensagem deve ser enviada pelo modo observação");
});

test("persiste ASK_CLARIFICATION quando nenhuma intenção é reconhecida, sem alterar a conversa", async () => {
  await cleanup();
  const { conversation, message } = await seedConversation("5511988880002", "mensagem sem intenção cadastrada", "wamid.observation.fallback");
  const bot = await prisma.bot.create({
    data: {
      name: botName, status: "ACTIVE", channel: "META",
      initialMessage: "Olá!", outsideHoursMessage: "Fora do horário.", fallbackMessage: "Não entendi.",
    },
  });

  const result = await observeIncomingMessage(
    { type: "text", text: message.text }, message, { now: new Date("2026-08-12T14:00:00.000Z") },
  );

  assert.equal(result.intentId, null);
  assert.equal(result.action, "ASK_CLARIFICATION");

  const observation = await prisma.botObservation.findUnique({ where: { messageId: message.id } });
  assert.ok(observation);
  assert.equal(observation.botId, bot.id);
  assert.equal(observation.intentName, null);
  assert.equal(observation.action, "ASK_CLARIFICATION");

  const conversationAfter = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(conversationAfter.status, "NOVO");
  assert.equal(conversationAfter.categoryId, null);
});

test("reconhece pedido explícito de atendente humano e sinaliza HANDOFF_HUMAN sem transferir de verdade", async () => {
  await cleanup();
  const { conversation, message } = await seedConversation("5511988880003", "quero falar com um atendente", "wamid.observation.human");
  await prisma.bot.create({
    data: {
      name: botName, status: "ACTIVE", channel: "META",
      initialMessage: "Olá!", outsideHoursMessage: "Fora do horário.", fallbackMessage: "Não entendi.",
    },
  });

  const result = await observeIncomingMessage({ type: "text", text: message.text }, message, { now: new Date("2026-08-12T14:00:00.000Z") });
  assert.equal(result.action, "HANDOFF_HUMAN");
  assert.equal(result.shouldHandoff, true);

  const conversationAfter = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(conversationAfter.status, "NOVO");
  assert.equal(conversationAfter.assignedUserId, null, "o modo observação nunca pode assumir a conversa");
});

test("ignora mensagens que não são texto e retorna null sem consultar o Bot", async () => {
  const result = await observeIncomingMessage({ type: "reaction", text: null }, { conversationId: "irrelevant" });
  assert.equal(result, null);
});

test("retorna null quando não há Bot ativo do canal META", async () => {
  await cleanup();
  const { message } = await seedConversation("5511988880001", "oi", "wamid.observation.no-bot");
  const result = await observeIncomingMessage({ type: "text", text: message.text }, message);
  assert.equal(result, null);
});
