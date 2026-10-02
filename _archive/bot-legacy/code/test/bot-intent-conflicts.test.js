require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const bots = require("../src/services/bot-service");

const botNamePrefix = "Bot Conflito Teste";
const masterEmail = "master-conflito-test@teste.local";
let master;

async function cleanup() {
  await prisma.bot.deleteMany({ where: { name: { startsWith: botNamePrefix } } });
}

test.before(async () => {
  master = await prisma.user.upsert({
    where: { email: masterEmail }, update: {}, create: { name: "Master Conflito Teste", email: masterEmail, role: "ADMIN" },
  });
});
test.after(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { email: masterEmail } });
  await prisma.$disconnect();
});

test("aponta conflito entre intenções muito parecidas, sem bloquear nada", async () => {
  await cleanup();
  const bot = await prisma.bot.create({ data: {
    name: `${botNamePrefix} A`, status: "DRAFT", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    intents: { create: [
      { name: "Acompanhar pedido", description: "cliente quer saber onde está o pedido", active: true,
        examples: { create: [{ text: "onde esta meu pedido" }, { text: "cade meu pedido" }] } },
      { name: "Atraso do pedido", description: "cliente quer saber onde está o pedido atrasado", active: true,
        examples: { create: [{ text: "meu pedido esta atrasado" }, { text: "cade meu pedido atrasado" }] } },
      { name: "Garantia", description: "cliente quer acionar a garantia do produto", active: true,
        examples: { create: [{ text: "quero acionar a garantia" }] } },
    ] },
  } });

  const conflicts = await bots.listIntentConflicts(bot.id, master);
  assert.ok(conflicts.length >= 1, "deveria identificar ao menos um par de intenções parecidas");
  const names = conflicts[0];
  assert.ok(
    [names.intentAName, names.intentBName].includes("Acompanhar pedido")
    && [names.intentAName, names.intentBName].includes("Atraso do pedido"),
  );
  assert.ok(conflicts[0].similarity >= 0.5);
  assert.ok(!conflicts.some((c) => [c.intentAName, c.intentBName].includes("Garantia")), "garantia não deveria conflitar com as outras");
});

test("métricas por intenção separam diagnóstico (observação) de sinal real (rating)", async () => {
  await cleanup();
  const bot = await prisma.bot.create({ data: {
    name: `${botNamePrefix} B`, status: "ACTIVE", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    intents: { create: [{ name: "Suporte", active: true, examples: { create: [{ text: "preciso de suporte" }] } }] },
  }, include: { intents: true } });
  const intent = bot.intents[0];

  const contact = await prisma.contact.create({ data: { externalId: "conflict-metrics-contact", phone: "5511900003001", name: "Cliente" } });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
  const message = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: "conflict-metrics-msg", direction: "RECEBIDA", status: "RECEBIDA",
    type: "text", text: "preciso de suporte", occurredAt: new Date(),
  } });
  await prisma.botObservation.create({ data: {
    conversationId: conversation.id, messageId: message.id, botId: bot.id, botName: bot.name, withinHours: true,
    intentId: intent.id, intentName: intent.name, confidence: 0.9, action: "RESPOND",
  } });

  const metrics = await bots.intentMetrics(bot.id, master);
  const row = metrics.find((item) => item.intentId === intent.id);
  assert.ok(row);
  assert.equal(row.triggeredCount, 1);
  assert.equal(row.ratingsCount, 0);

  await prisma.contact.deleteMany({ where: { externalId: "conflict-metrics-contact" } });
});

test("conflitos e métricas de intenção exigem conta Master", async () => {
  const attendant = { id: "atendente-conflito-test", role: "ATENDENTE" };
  await assert.rejects(() => bots.listIntentConflicts("qualquer-id", attendant), (error) => error.statusCode === 403);
  await assert.rejects(() => bots.intentMetrics("qualquer-id", attendant), (error) => error.statusCode === 403);
});
