require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const bots = require("../src/services/bot-service");

const botNamePrefix = "Bot Feedback Teste";
const externalId = "bot-feedback-test-contact";
const masterEmail = "master-feedback-test@teste.local";
let master;

async function cleanup() {
  await prisma.botLearningSuggestion.deleteMany({ where: { bot: { name: { startsWith: botNamePrefix } } } });
  await prisma.bot.deleteMany({ where: { name: { startsWith: botNamePrefix } } });
  await prisma.contact.deleteMany({ where: { externalId } });
}

test.before(async () => {
  master = await prisma.user.upsert({
    where: { email: masterEmail }, update: {},
    create: { name: "Master Feedback Teste", email: masterEmail, role: "ADMIN" },
  });
});

test.after(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { email: masterEmail } });
  await prisma.$disconnect();
});

test("marcar observação como incorreta com a intenção correta cria sugestão de exemplo", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} A`, status: "ACTIVE", channel: "META",
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{ name: "Rastreamento", active: true, examples: { create: [{ text: "rastrear pedido" }] } }] },
    },
    include: { intents: true },
  });
  const intent = bot.intents[0];
  const contact = await prisma.contact.create({ data: { externalId, phone: "5511999990000", name: "Cliente" } });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
  const message = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: "feedback-msg-1", direction: "RECEBIDA", status: "RECEBIDA",
    type: "text", text: "cade meu relogio", occurredAt: new Date(),
  } });
  const observation = await prisma.botObservation.create({ data: {
    conversationId: conversation.id, messageId: message.id, botId: bot.id, botName: bot.name,
    withinHours: true, intentId: null, confidence: 0,
  } });

  const updated = await bots.recordObservationFeedback(observation.id, {
    feedback: "INCORRECT", correctedIntentId: intent.id, addAsExample: true,
  }, master);
  assert.equal(updated.feedback, "INCORRECT");
  assert.equal(updated.feedbackIntentId, intent.id);
  assert.equal(updated.feedbackByUserId, master.id);

  const suggestions = await prisma.botLearningSuggestion.findMany({ where: { intentId: intent.id, type: "INTENT_EXAMPLE" } });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].suggestedContent, "cade meu relogio");
  assert.equal(suggestions[0].metadata?.source, "OBSERVATION_FEEDBACK");
});

test("marcar observação como correta não cria sugestão nenhuma", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} B`, status: "ACTIVE", channel: "META",
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    },
  });
  const contact = await prisma.contact.create({ data: { externalId, phone: "5511999990001", name: "Cliente" } });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
  const message = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: "feedback-msg-2", direction: "RECEBIDA", status: "RECEBIDA",
    type: "text", text: "onde esta meu pedido", occurredAt: new Date(),
  } });
  const observation = await prisma.botObservation.create({ data: {
    conversationId: conversation.id, messageId: message.id, botId: bot.id, botName: bot.name, withinHours: true,
  } });

  const updated = await bots.recordObservationFeedback(observation.id, { feedback: "CORRECT" }, master);
  assert.equal(updated.feedback, "CORRECT");
  const suggestions = await prisma.botLearningSuggestion.findMany({ where: { conversationId: conversation.id } });
  assert.equal(suggestions.length, 0);
});

test("observationMetrics não expõe percentual de acerto com poucas revisões", async () => {
  const metrics = await bots.observationMetrics(master);
  assert.ok(typeof metrics.total === "number");
  if (metrics.reviewed < 5) assert.equal(metrics.accuracy, null);
});
