require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { orchestrate, shouldAutoRespond } = require("../src/services/bot-orchestrator-service");
const handoff = require("../src/services/bot-handoff-service");

const botNamePrefix = "Bot Handoff Teste";
const externalId = "bot-handoff-test-contact";
const masterEmail = "master-handoff-test@teste.local";
let master;

async function cleanup() {
  await prisma.bot.deleteMany({ where: { name: { startsWith: botNamePrefix } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: externalId } } });
}

test.before(async () => {
  master = await prisma.user.upsert({
    where: { email: masterEmail }, update: {},
    create: { name: "Master Handoff Teste", email: masterEmail, role: "ADMIN" },
  });
});
test.after(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { email: masterEmail } });
  await prisma.$disconnect();
});

let phoneCounter = 0;
async function seedConversation(overrides = {}) {
  phoneCounter += 1;
  const contact = await prisma.contact.create({
    data: { externalId: `${externalId}-${phoneCounter}`, phone: `5511977700${String(phoneCounter).padStart(3, "0")}`, name: "Cliente" },
  });
  return prisma.conversation.create({ data: { contactId: contact.id, ...overrides } });
}

async function addMessage(conversation, text, direction = "RECEBIDA", occurredAt = new Date()) {
  return prisma.message.create({
    data: {
      conversationId: conversation.id, externalId: `ho-${conversation.id}-${Math.random()}`,
      direction, status: direction === "RECEBIDA" ? "RECEBIDA" : "ENVIADA", type: "text", text, occurredAt,
    },
  });
}

test("HANDOFF_HUMAN captura contexto estruturado completo (bot, intenção, confiança, categoria, entidades, resumo factual)", async () => {
  await cleanup();
  const category = await prisma.category.findFirst();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Captura`, status: "ACTIVE", channel: "META", defaultCategoryId: category?.id || null,
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    },
  });
  const conversation = await seedConversation();
  await prisma.conversationBotState.create({ data: { conversationId: conversation.id, activeBotId: bot.id } });

  await addMessage(conversation, "Pode me dizer mais um detalhe?", "ENVIADA", new Date(Date.now() - 4000));
  await addMessage(conversation, "não entendi bem", "RECEBIDA", new Date(Date.now() - 3000));

  const message = await addMessage(conversation, "quero falar com um atendente humano", "RECEBIDA");
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });
  assert.equal(result.action, "HANDOFF_HUMAN");

  // Status operacional (item 8 do pedido de SLA/status/prioridade): handoff
  // real (execução LIVE, conversa ainda sem humano ativo) marca HANDOFF_BOT.
  const afterHandoff = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(afterHandoff.status, "HANDOFF_BOT");

  const contexts = await handoff.listHandoffContexts(conversation.id, master);
  assert.equal(contexts.length, 1);
  const context = contexts[0];
  assert.equal(context.botId, bot.id);
  assert.equal(context.botName, bot.name);
  assert.equal(context.lastRelevantInfo, "quero falar com um atendente humano");
  assert.ok(context.summary && context.summary.length > 0, "deveria gerar um resumo curto e factual");
  assert.ok(!/chain.of.thought/i.test(context.summary));
  assert.ok(Array.isArray(context.questionsAsked));
  assert.ok(context.questionsAsked.includes("Pode me dizer mais um detalhe?"));
});

test("Retomar Bot: ação humana explícita limpa a pausa e marca o handoff como retomado, nunca automática", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Retomar`, status: "ACTIVE", channel: "META",
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    },
  });
  const conversation = await seedConversation();
  await prisma.conversationBotState.create({
    data: { conversationId: conversation.id, activeBotId: bot.id, humanPausedAt: new Date() },
  });
  await prisma.botHandoffContext.create({
    data: { conversationId: conversation.id, botId: bot.id, botName: bot.name, summary: "Resumo de teste." },
  });

  const before = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.ok(before.humanPausedAt, "deveria começar pausado (humano assumiu)");

  await handoff.resumeBot(conversation.id, master);

  const after = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.equal(after.humanPausedAt, null, "retomar o Bot deveria limpar a pausa");

  const latestContext = await handoff.getLatestHandoffContext(conversation.id);
  assert.ok(latestContext.resumedAt, "o handoff deveria ficar marcado como retomado");
  assert.equal(latestContext.resumedByUserId, master.id);
});

test("humano assumiu a conversa: Bot para de responder automaticamente (shouldAutoRespond fica falso)", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} StopAuto`, status: "ACTIVE", channel: "META", autoReplyEnabled: true,
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    },
  });
  const conversation = await seedConversation({ status: "EM_ATENDIMENTO" });
  const agent = await prisma.user.upsert({
    where: { email: "handoff-agente-test@teste.local" }, update: {},
    create: { name: "Agente Handoff", email: "handoff-agente-test@teste.local", role: "ATENDENTE" },
  });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { assignedUserId: agent.id } });
  await prisma.conversationBotState.create({ data: { conversationId: conversation.id, activeBotId: bot.id } });

  const message = await addMessage(conversation, "ainda estou com dúvida");
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });

  assert.equal(result.humanPaused, true);
  assert.equal(shouldAutoRespond(result), false, "nunca deveria mandar resposta automática/duplicada por cima do atendimento humano");

  await prisma.user.deleteMany({ where: { email: "handoff-agente-test@teste.local" } });
});
