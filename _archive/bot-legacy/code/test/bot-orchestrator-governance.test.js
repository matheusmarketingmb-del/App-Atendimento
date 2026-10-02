require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { orchestrate } = require("../src/services/bot-orchestrator-service");
const governance = require("../src/services/bot-governance-service");

const botNamePrefix = "Bot Governança Teste";
const externalId = "bot-governance-test-contact";

async function cleanup() {
  await prisma.bot.deleteMany({ where: { name: { startsWith: botNamePrefix } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: externalId } } });
}

test.after(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { email: { in: ["governanca-agente@teste.local", "master-governanca-test@teste.local"] } } });
  await prisma.$disconnect();
});

let phoneCounter = 0;
async function seedConversation(overrides = {}) {
  phoneCounter += 1;
  const contact = await prisma.contact.create({ data: {
    externalId: `${externalId}-${phoneCounter}`, phone: `5511900000${String(phoneCounter).padStart(3, "0")}`, name: "Cliente",
  } });
  return prisma.conversation.create({ data: { contactId: contact.id, ...overrides } });
}

async function addMessage(conversation, text, occurredAt = new Date()) {
  return prisma.message.create({ data: {
    conversationId: conversation.id, externalId: `gov-${conversation.id}-${Math.random()}`,
    direction: "RECEBIDA", status: "RECEBIDA", type: "text", text, occurredAt,
  } });
}

test("apresentação: liga uma vez, não repete na mesma sessão, nunca aparece quando desligada", async () => {
  await cleanup();
  const withName = await prisma.bot.create({ data: {
    name: `${botNamePrefix} Apresentação ON`, status: "ACTIVE", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    introduceWithName: true, presentationMessage: "Oi! Eu sou a {{botName}}.",
  } });
  const conversation = await seedConversation();
  // Fixa explicitamente o Bot ativo desta conversa: evita depender da
  // ordenação implícita de resolveBot() ("Bot ACTIVE mais antigo do canal"),
  // que pode escolher outro Bot ACTIVE remanescente no banco de teste.
  await prisma.conversationBotState.create({ data: { conversationId: conversation.id, activeBotId: withName.id } });
  const message1 = await addMessage(conversation, "bom dia");
  const first = await orchestrate({ conversationId: conversation.id, messageId: message1.id, message: message1.text });
  assert.match(first.response, /Eu sou a Bot Governança Teste Apresentação ON/);

  const message2 = await addMessage(conversation, "tudo bem?", new Date(Date.now() + 1000));
  const second = await orchestrate({ conversationId: conversation.id, messageId: message2.id, message: message2.text });
  assert.doesNotMatch(second.response, /Eu sou a/, "não deveria se apresentar de novo na mesma sessão");

  const withoutName = await prisma.bot.create({ data: {
    name: `${botNamePrefix} Apresentação OFF`, status: "ACTIVE", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    introduceWithName: false,
  } });
  const conversation2 = await seedConversation();
  await prisma.conversationBotState.create({ data: { conversationId: conversation2.id, activeBotId: withoutName.id } });
  const message3 = await addMessage(conversation2, "bom dia");
  const third = await orchestrate({ conversationId: conversation2.id, messageId: message3.id, message: message3.text });
  assert.doesNotMatch(third.response || "", /Eu sou a/);

  await prisma.bot.update({ where: { id: withName.id }, data: { archivedAt: new Date() } });
  await prisma.bot.update({ where: { id: withoutName.id }, data: { archivedAt: new Date() } });
});

test("sessão expirada respeita reintroduceOnNewSession", async () => {
  await cleanup();
  const bot = await prisma.bot.create({ data: {
    name: botNamePrefix + " Reapresentação", status: "ACTIVE", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    introduceWithName: true, presentationMessage: "Eu sou {{botName}}.",
    reintroduceOnNewSession: false, featureFlags: { contextExpirationMinutes: 30 },
  } });
  const conversation = await seedConversation();
  const oldDate = new Date(Date.now() - 60 * 60 * 1000);
  await prisma.conversationBotState.create({ data: {
    conversationId: conversation.id, activeBotId: bot.id, introducedAt: oldDate, updatedAt: oldDate,
  } });

  const firstMessage = await addMessage(conversation, "bom dia");
  const withoutReintroduction = await orchestrate({
    conversationId: conversation.id, messageId: firstMessage.id, message: firstMessage.text,
  });
  assert.doesNotMatch(withoutReintroduction.response, /Eu sou Bot Governança Teste Reapresentação/);

  await prisma.bot.update({ where: { id: bot.id }, data: { reintroduceOnNewSession: true } });
  await prisma.conversationBotState.update({
    where: { conversationId: conversation.id }, data: { introducedAt: oldDate, updatedAt: oldDate },
  });
  const secondMessage = await addMessage(conversation, "olá novamente", new Date(Date.now() + 1000));
  const withReintroduction = await orchestrate({
    conversationId: conversation.id, messageId: secondMessage.id, message: secondMessage.text,
  });
  assert.match(withReintroduction.response, /Eu sou Bot Governança Teste Reapresentação/);
});
test("contexto expira: falhas antigas não contam para uma mensagem após a janela de expiração", async () => {
  await cleanup();
  const bot = await prisma.bot.create({ data: {
    name: `${botNamePrefix} Expiração`, status: "ACTIVE", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    featureFlags: { contextExpirationMinutes: 30 },
  } });
  const conversation = await seedConversation();
  await prisma.conversationBotState.create({ data: {
    conversationId: conversation.id, activeBotId: bot.id, failedInterpretations: 2, pendingClarification: true,
    updatedAt: new Date(Date.now() - 60 * 60 * 1000), // 1h atrás, além dos 30min configurados
  } });
  const message = await addMessage(conversation, "mensagem totalmente aleatoria sem sentido algum");
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });
  assert.equal(result.action, "ASK_CLARIFICATION", "sessão expirada deveria reiniciar o contador de falhas (não pular direto para handoff)");

  const state = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.equal(state.failedInterpretations, 1);
});

test("proteção de loop: a mesma resposta repetida escalona para humano", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Loop`, status: "ACTIVE", channel: "META",
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{
        name: "Pedido", active: true, priority: 1, responseMessage: "Pode informar o número do pedido?",
        examples: { create: [{ text: "onde esta meu pedido" }] },
      }] },
    },
  });
  const conversation = await seedConversation();
  await prisma.conversationBotState.create({ data: { conversationId: conversation.id, activeBotId: bot.id } });
  let last;
  for (let i = 0; i < 3; i += 1) {
    const message = await addMessage(conversation, "onde esta meu pedido", new Date(Date.now() + i * 1000));
    last = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });
  }
  assert.equal(last.action, "HANDOFF_HUMAN", "a 3ª resposta idêntica seguida deveria acionar a proteção contra loop");
});

test("proteção de ping-pong: limite de trocas de Bot na janela escalona para humano", async () => {
  await cleanup();
  // Reaproveita categorias já seedadas (prisma/seed.js) em vez de criar uma
  // nova — evita inflar a contagem fixa de categorias usada em outros testes.
  const pedidos = await prisma.category.findUniqueOrThrow({ where: { code: "PEDIDOS" } });
  const suporte = await prisma.category.findUniqueOrThrow({ where: { code: "SUPORTE" } });
  const botA = await prisma.bot.create({ data: {
    name: `${botNamePrefix} PingPong A`, status: "ACTIVE", channel: "META", defaultCategoryId: suporte.id,
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    featureFlags: { maxSwitchesPerWindow: 1, switchWindowMinutes: 10 },
    intents: { create: [{
      name: "Vai para pedidos", active: true, priority: 1, fallbackAction: "TRANSFER_TO_CATEGORY", categoryId: pedidos.id,
      examples: { create: [{ text: "quero saber do pedido" }] },
    }] },
  } });
  await prisma.bot.create({ data: {
    name: `${botNamePrefix} PingPong B`, status: "ACTIVE", channel: "META", defaultCategoryId: pedidos.id,
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    featureFlags: { maxSwitchesPerWindow: 1, switchWindowMinutes: 10 },
    intents: { create: [{
      name: "Vai para suporte", active: true, priority: 1, fallbackAction: "TRANSFER_TO_CATEGORY", categoryId: suporte.id,
      examples: { create: [{ text: "quero suporte tecnico" }] },
    }] },
  } });
  const conversation = await seedConversation();

  const m1 = await addMessage(conversation, "quero saber do pedido", new Date(Date.now()));
  const r1 = await orchestrate({ conversationId: conversation.id, messageId: m1.id, message: m1.text });
  assert.equal(r1.action, "SWITCH_BOT");

  const m2 = await addMessage(conversation, "quero suporte tecnico", new Date(Date.now() + 1000));
  const r2 = await orchestrate({ conversationId: conversation.id, messageId: m2.id, message: m2.text });
  assert.equal(r2.action, "HANDOFF_HUMAN", "segunda troca na mesma janela deveria estourar o limite de ping-pong e ir para humano");

  await prisma.bot.updateMany({ where: { name: { startsWith: `${botNamePrefix} PingPong` } }, data: { archivedAt: new Date() } });
});

test("humano assumiu: sinaliza humanPaused sem deixar de interpretar/observar", async () => {
  await cleanup();
  const bot = await prisma.bot.create({ data: {
    name: `${botNamePrefix} HumanPause`, status: "ACTIVE", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
  } });
  const conversation = await seedConversation({ assignedUserId: null, status: "EM_ATENDIMENTO" });
  // Simula um humano assumindo (assignedUserId real precisa existir na tabela User).
  const agent = await prisma.user.upsert({
    where: { email: "governanca-agente@teste.local" }, update: {},
    create: { name: "Agente Governança", email: "governanca-agente@teste.local", role: "ATENDENTE" },
  });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { assignedUserId: agent.id } });
  await prisma.conversationBotState.create({ data: { conversationId: conversation.id, activeBotId: bot.id } });

  const message = await addMessage(conversation, "ainda preciso de ajuda");
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });
  assert.equal(result.humanPaused, true);
  assert.ok(result.intentName !== undefined, "interpretação deveria continuar rodando mesmo com humano pausando a automação");
  assert.equal(result.observationAllowed, true, "observação deve continuar permitida mesmo com o Bot pausado pela automação");

  await prisma.user.delete({ where: { id: agent.id } });
});

test("automationBlocked: reflete autoReplyEnabled do Bot e o kill switch global", async () => {
  await cleanup();
  // BotGlobalSettings é um singleton compartilhado entre execuções de teste;
  // garante que o teste começa com a automação ligada, independentemente do
  // estado deixado por uma execução anterior interrompida.
  await prisma.botGlobalSettings.upsert({
    where: { id: "singleton" }, update: { automationEnabled: true }, create: { id: "singleton", automationEnabled: true },
  });
  const bot = await prisma.bot.create({ data: {
    name: `${botNamePrefix} AutoReply`, status: "ACTIVE", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    autoReplyEnabled: false,
  } });
  const conversation = await seedConversation();
  await prisma.conversationBotState.create({ data: { conversationId: conversation.id, activeBotId: bot.id } });
  const message = await addMessage(conversation, "oi");
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });
  assert.equal(result.automationBlocked, true, "autoReplyEnabled=false (default seguro) deveria bloquear automação");

  await prisma.bot.update({ where: { id: bot.id }, data: { autoReplyEnabled: true } });
  const conversation2 = await seedConversation();
  await prisma.conversationBotState.create({ data: { conversationId: conversation2.id, activeBotId: bot.id } });
  const message2 = await addMessage(conversation2, "oi de novo");
  const beforeKillSwitch = await orchestrate({ conversationId: conversation2.id, messageId: message2.id, message: message2.text });
  assert.equal(beforeKillSwitch.automationBlocked, false);

  const master = await prisma.user.upsert({
    where: { email: "master-governanca-test@teste.local" }, update: {},
    create: { name: "Master Governança Teste", email: "master-governanca-test@teste.local", role: "ADMIN" },
  });
  await governance.deactivateAutomation(master);
  const conversation3 = await seedConversation();
  await prisma.conversationBotState.create({ data: { conversationId: conversation3.id, activeBotId: bot.id } });
  const message3 = await addMessage(conversation3, "oi mais uma vez");
  const afterKillSwitch = await orchestrate({ conversationId: conversation3.id, messageId: message3.id, message: message3.text });
  assert.equal(afterKillSwitch.automationBlocked, true, "kill switch global deveria bloquear mesmo com autoReplyEnabled=true no Bot");

  const auditEntries = await prisma.auditLog.count({ where: { action: "BOT_KILL_SWITCH_ACTIVATED" } });
  assert.ok(auditEntries >= 1);

  await governance.reactivateAutomation(master);
  const reactivated = await governance.getGlobalSettings();
  assert.equal(reactivated.automationEnabled, true);
  assert.equal(reactivated.killSwitchActivatedAt, null);
  assert.equal(reactivated.killSwitchActivatedByUserId, null);
});
