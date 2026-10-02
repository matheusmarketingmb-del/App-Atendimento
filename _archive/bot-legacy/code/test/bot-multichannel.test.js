require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { orchestrate } = require("../src/services/bot-orchestrator-service");
const bots = require("../src/services/bot-service");

const botNamePrefix = "Bot Multicanal Teste";
const externalId = "bot-multichannel-test-contact";
const masterEmail = "master-multichannel@teste.local";
let masterViewer;

async function cleanup() {
  await prisma.bot.deleteMany({ where: { name: { startsWith: botNamePrefix } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: externalId } } });
}

test.before(async () => {
  masterViewer = await prisma.user.upsert({
    where: { email: masterEmail },
    update: {},
    create: { email: masterEmail, name: "Master Multicanal", role: "ADMIN", passwordHash: "x" },
  });
});

test.after(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { email: masterEmail } });
  await prisma.$disconnect();
});

async function seedConversation(channel) {
  const contact = await prisma.contact.create({ data: { externalId: `${externalId}-${channel}`, channel, phone: null, name: "Cliente Multicanal" } });
  return prisma.conversation.create({ data: { contactId: contact.id, channel } });
}

test("Bot criado só com o campo legado channel continua funcionando sem nunca precisar de channels[]", async () => {
  await cleanup();
  const created = await bots.createBot({
    name: `${botNamePrefix} Legado`, channel: "META", initialMessage: "Olá!",
    outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
  }, masterViewer);
  await bots.updateBotStatus(created.id, "ACTIVE", masterViewer);

  const conversation = await seedConversation("META");
  const result = await orchestrate({ conversationId: conversation.id, channel: "META", message: "oi", now: new Date("2026-08-12T14:00:00.000Z") });
  assert.ok(result.botId);
});

test("Bot com channels[] adicional (multi-canal) é encontrado no canal extra sem duplicar intents por canal", async () => {
  await cleanup();
  const created = await bots.createBot({
    name: `${botNamePrefix} Multi`, channel: "META", channels: ["MERCADO_LIVRE", "GOOGLE_REVIEWS"],
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
  }, masterViewer);
  assert.deepEqual(created.channels.sort(), ["GOOGLE_REVIEWS", "MERCADO_LIVRE"]);
  await bots.updateBotStatus(created.id, "ACTIVE", masterViewer);

  const conversation = await seedConversation("MERCADO_LIVRE");
  const result = await orchestrate({ conversationId: conversation.id, channel: "MERCADO_LIVRE", message: "oi", now: new Date("2026-08-12T14:00:00.000Z") });
  assert.equal(result.botId, created.id);
});

test("channels[] rejeita canal inválido e nunca aceita string fora do vocabulário controlado", async () => {
  await assert.rejects(() => bots.createBot({
    name: `${botNamePrefix} Inválido`, channel: "META", channels: ["CANAL_FALSO"],
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
  }, masterViewer), /Canal inválido em channels/);
});
