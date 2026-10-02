require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { shadowIncomingMessage } = require("../src/services/bot-ai-shadow-service");

// Valida o item "preparar ativação controlada" / "gate de segurança para
// envio" com um Bot de teste real, autoReplyEnabled=TRUE (só neste registro
// isolado — nenhum Bot de produção é tocado). Cobre os caminhos que não
// dependem do RAG Server/Ollama estarem no ar (os 4 casos determinísticos
// de planner-hint-service.js) — nunca chama Meta/WhatsApp real em nenhum
// cenário (dry-run-sender.js é sempre um mock).
const botName = "Bot Shadow Send Gate Teste";
const externalId = "bot-shadow-send-gate-test-contact";

async function cleanup() {
  await prisma.bot.deleteMany({ where: { name: botName } });
  await prisma.contact.deleteMany({ where: { externalId } });
}

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function seedConversation(text, externalMessageId) {
  const contact = await prisma.contact.create({ data: { externalId, phone: "5511999990000", name: "Cliente Shadow Gate" } });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id, externalId: externalMessageId, direction: "RECEBIDA",
      status: "RECEBIDA", type: "text", text, occurredAt: new Date(),
    },
  });
  return { contact, conversation, message };
}

async function seedBotWithAutoReplyEnabled() {
  const category = await prisma.category.findFirst();
  return prisma.bot.create({
    data: {
      name: botName, status: "ACTIVE", channel: "META", initialMessage: "Olá!",
      outsideHoursMessage: "Fora do horário.", fallbackMessage: "Não entendi.",
      defaultCategoryId: category?.id || null, autoReplyEnabled: true,
      featureFlags: { useAi: true, aiMode: "PRIMARY", aiProvider: "LOCAL_QWEN" },
    },
  });
}

async function activateBotForConversation(conversationId, botId) {
  await prisma.conversationBotState.upsert({
    where: { conversationId },
    create: { conversationId, activeBotId: botId },
    update: { activeBotId: botId },
  });
}

test("CASO 2/3: HANDOFF (pedido de humano/risco) nunca envia mesmo com autoReplyEnabled=true no Bot", async () => {
  await cleanup();
  const bot = await seedBotWithAutoReplyEnabled();
  const { conversation, message } = await seedConversation("quero falar com atendente", "wamid.shadow.human");
  await activateBotForConversation(conversation.id, bot.id);

  const result = await shadowIncomingMessage({ type: "text", text: message.text }, message);

  assert.equal(result.action, "HANDOFF");
  assert.equal(result.needsHuman, true);
  assert.equal(result.sendDecision.shouldSend, false);
  // A razão exata depende de qual gate bloqueou primeiro (elegibilidade de
  // provider, sem poller de health-check rodando neste processo de teste
  // isolado, vs. needsHuman) — o que importa é que NUNCA envia num HANDOFF.
  assert.ok(["NEEDS_HUMAN", "PROVIDER_OFFLINE", "AI_OFFLINE_FORCES_HANDOFF"].includes(result.sendDecision.reason));
  assert.equal(result.sendDecision.simulated, null);

  const log = await prisma.botAiShadowLog.findFirst({ where: { messageId: message.id } });
  assert.ok(log, "deveria ter persistido o shadow log");
  assert.equal(log.missingInformation.wouldSend, false);
  assert.equal(log.missingInformation.sendMode, "DRY_RUN");
});

test("CASO 3: risco de segurança nunca envia mesmo com autoReplyEnabled=true", async () => {
  await cleanup();
  const bot = await seedBotWithAutoReplyEnabled();
  const { conversation, message } = await seedConversation("meu relogio esta muito quente", "wamid.shadow.safety");
  await activateBotForConversation(conversation.id, bot.id);

  const result = await shadowIncomingMessage({ type: "text", text: message.text }, message);

  assert.equal(result.action, "HANDOFF");
  assert.equal(result.reason, "safety_issue");
  assert.equal(result.sendDecision.shouldSend, false);
});

test("autoReplyEnabled=false no Bot: sendDecision nunca é elegível, independente da action", async () => {
  await cleanup();
  const category = await prisma.category.findFirst();
  const bot = await prisma.bot.create({
    data: {
      name: botName, status: "ACTIVE", channel: "META", initialMessage: "Olá!",
      outsideHoursMessage: "Fora do horário.", fallbackMessage: "Não entendi.",
      defaultCategoryId: category?.id || null, autoReplyEnabled: false,
      featureFlags: { useAi: true, aiMode: "PRIMARY", aiProvider: "LOCAL_QWEN" },
    },
  });
  const { conversation, message } = await seedConversation("quero falar com atendente", "wamid.shadow.disabled");
  await activateBotForConversation(conversation.id, bot.id);

  const result = await shadowIncomingMessage({ type: "text", text: message.text }, message);

  assert.equal(result.sendDecision.shouldSend, false);
  assert.equal(result.sendDecision.reason, "AUTO_REPLY_DISABLED");
});

test("nenhum cliente real recebe mensagem: dry-run-sender nunca é chamado quando shouldSend=false", async () => {
  await cleanup();
  const bot = await seedBotWithAutoReplyEnabled();
  const { conversation, message } = await seedConversation("quero falar com atendente", "wamid.shadow.nosend");
  await activateBotForConversation(conversation.id, bot.id);

  const result = await shadowIncomingMessage({ type: "text", text: message.text }, message);

  assert.equal(result.sendDecision.simulated, null, "simulateSend só deve rodar quando shouldSend=true");
});
