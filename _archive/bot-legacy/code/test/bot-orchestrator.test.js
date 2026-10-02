require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { orchestrate, simulateOrchestration, botInclude } = require("../src/services/bot-orchestrator-service");
const { getRecentContext } = require("../src/services/bot-conversation-state-service");

const botNamePrefix = "Bot Orquestrador Teste";
const externalId = "bot-orchestrator-test-contact";

async function cleanup() {
  await prisma.bot.deleteMany({ where: { name: { startsWith: botNamePrefix } } });
  await prisma.contact.deleteMany({ where: { externalId } });
}

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function seedConversation(phone) {
  const contact = await prisma.contact.create({ data: { externalId, phone, name: "Cliente Orquestrador" } });
  return prisma.conversation.create({ data: { contactId: contact.id } });
}

test("orchestrate() troca de Bot internamente (SWITCH_BOT) e persiste o estado da conversa", async () => {
  await cleanup();
  const conversation = await seedConversation("5511977770000");
  const pedidosCategory = await prisma.category.upsert({
    where: { code: "PEDIDOS" }, update: {}, create: { code: "PEDIDOS", name: "Pedidos", displayOrder: 1 },
  });

  const triageBot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Triagem`, status: "ACTIVE", channel: "META",
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: {
        create: [{
          name: "Acompanhar pedido", priority: 1, active: true,
          fallbackAction: "TRANSFER_TO_CATEGORY", categoryId: pedidosCategory.id,
          examples: { create: [{ text: "quero saber do meu pedido" }] },
        }],
      },
    },
  });
  const pedidosBot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Pedidos`, status: "ACTIVE", channel: "META", defaultCategoryId: pedidosCategory.id,
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    },
  });

  const result = await orchestrate({
    conversationId: conversation.id, channel: "META", message: "quero saber do meu pedido",
    now: new Date("2026-08-12T14:00:00.000Z"),
  });

  assert.equal(result.action, "SWITCH_BOT");
  assert.equal(result.botId, pedidosBot.id);
  assert.equal(result.switchedFromBotId, triageBot.id);

  const state = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.equal(state.activeBotId, pedidosBot.id);
  assert.equal(state.lastIntentId, (await prisma.botIntent.findFirst({ where: { botId: triageBot.id } })).id);
});

test("orchestrate() nunca altera Conversation e retorna null sem Bot ativo no canal", async () => {
  await cleanup();
  const conversation = await seedConversation("5511977770001");
  const result = await orchestrate({ conversationId: conversation.id, channel: "META", message: "oi" });
  assert.equal(result, null);
  const state = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.equal(state, null);
});

test("getRecentContext exclui a mensagem atual do histórico anterior", async () => {
  await cleanup();
  const conversation = await seedConversation("5511977770003");
  await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: "context.previous", direction: "RECEBIDA",
    status: "RECEBIDA", type: "text", text: "mensagem anterior", occurredAt: new Date("2026-08-25T10:00:00Z"),
  } });
  const current = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: "context.current", direction: "RECEBIDA",
    status: "RECEBIDA", type: "text", text: "mensagem atual", occurredAt: new Date("2026-08-25T10:01:00Z"),
  } });
  const context = await getRecentContext(conversation.id, { beforeMessageId: current.id });
  assert.deepEqual(context.map(({ text }) => text), ["mensagem anterior"]);
});

test("simulateOrchestration nunca grava ConversationBotState (estado fica só no retorno)", async () => {
  await cleanup();
  const conversation = await seedConversation("5511977770002");
  const bot = await prisma.bot.findFirst({
    where: { name: `${botNamePrefix} Triagem` },
    include: botInclude,
  }) || await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Simulador`, status: "DRAFT", channel: "META",
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    },
    include: botInclude,
  });

  const result = await simulateOrchestration({ bot, message: "oi, tudo bem?", now: new Date("2026-08-12T14:00:00.000Z") });
  assert.ok(result.nextState);
  assert.notEqual(result.action, "NO_ACTION", "o simulador deve testar Bots em rascunho");
  assert.equal(result.nextState.activeBotId, bot.id);

  const state = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.equal(state, null, "o simulador não deve tocar em ConversationBotState");
});
