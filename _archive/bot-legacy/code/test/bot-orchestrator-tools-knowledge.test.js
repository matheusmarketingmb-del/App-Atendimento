require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { orchestrate } = require("../src/services/bot-orchestrator-service");
const registry = require("../src/services/bot-tools/tool-registry");

const botNamePrefix = "Bot ToolsKnowledge Teste";
const externalId = "bot-tk-test-contact";

async function cleanup() {
  await prisma.bot.deleteMany({ where: { name: { startsWith: botNamePrefix } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: externalId } } });
  await prisma.knowledgeSource.deleteMany({ where: { title: { startsWith: "ToolsKnowledge Teste" } } });
}

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

let phoneCounter = 0;
async function seedConversation() {
  phoneCounter += 1;
  const contact = await prisma.contact.create({
    data: { externalId: `${externalId}-${phoneCounter}`, phone: `5511966600${String(phoneCounter).padStart(3, "0")}`, name: "Cliente" },
  });
  return prisma.conversation.create({ data: { contactId: contact.id } });
}

async function addMessage(conversation, text) {
  return prisma.message.create({
    data: {
      conversationId: conversation.id, externalId: `tk-${conversation.id}-${Math.random()}`,
      direction: "RECEBIDA", status: "RECEBIDA", type: "text", text, occurredAt: new Date(),
    },
  });
}

async function createOrderBot(overrides = {}) {
  return prisma.bot.create({
    data: {
      name: `${botNamePrefix} Pedido`, status: "ACTIVE", channel: "META", autoReplyEnabled: true, toolsEnabled: true,
      toolPermissions: { OrderTool: true },
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{
        name: "Acompanhar pedido", active: true, priority: 1, toolName: "OrderTool",
        examples: { create: [{ text: "onde esta meu pedido" }, { text: "onde esta o pedido" }] },
      }] },
      ...overrides,
    },
  });
}

test('fluxo "onde está meu pedido?": sem número do pedido, o Bot pede esclarecimento em vez de chamar a Tool', async () => {
  await cleanup();
  await createOrderBot();
  const conversation = await seedConversation();
  const message = await addMessage(conversation, "onde esta meu pedido");
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });

  assert.equal(result.action, "ASK_CLARIFICATION");
  assert.match(result.response, /número do pedido/i);
});

test("Tool sem integração real configurada (NOT_CONFIGURED): Bot nunca fabrica status de pedido, responde com segurança", async () => {
  await cleanup();
  await createOrderBot();
  const conversation = await seedConversation();
  const message = await addMessage(conversation, "onde esta o pedido 123456789");
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });

  // Como não há integração real (OrderTool NOT_CONFIGURED), a resposta cai
  // para a mensagem padrão do Bot — nunca inventa um status de pedido.
  assert.equal(result.response, "Não entendi.");
});

test("com uma Tool real conectada (injetada só para este teste), a resposta final usa o dado real devolvido por ela", async () => {
  await cleanup();
  await createOrderBot();
  const conversation = await seedConversation();

  const original = registry.tools.OrderTool;
  registry.tools.OrderTool = {
    name: "OrderTool", enabled: true, riskLevel: "READ_ONLY", requiredEntities: ["orderNumber"], supportedChannels: [],
    canExecute: (ctx) => (ctx.entities?.orderNumber ? { ok: true } : { ok: false, reason: "MISSING_ENTITIES", missing: ["orderNumber"] }),
    execute: async (input) => ({
      success: true, data: { status: "Em transporte" },
      message: `Seu pedido ${input.orderNumber} está em transporte.`,
    }),
  };
  try {
    const message = await addMessage(conversation, "onde esta o pedido 123456789");
    const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });
    assert.match(result.response, /123456789 está em transporte/);
  } finally {
    registry.tools.OrderTool = original;
  }
});

test("Base de Conhecimento desligada por padrão: um Bot novo nunca usa KnowledgeSource mesmo com conteúdo cadastrado", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Conhecimento`, status: "ACTIVE", channel: "META", autoReplyEnabled: true,
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{
        name: "Duvida sobre garantia", active: true, priority: 1,
        examples: { create: [{ text: "qual o prazo de garantia" }] },
      }] },
    },
  });
  await prisma.knowledgeSource.create({
    data: { title: "ToolsKnowledge Teste Garantia", type: "WARRANTY", source: "Manual", content: "A garantia é de 12 meses." },
  });
  const conversation = await seedConversation();
  const message = await addMessage(conversation, "qual o prazo de garantia");
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });

  assert.equal(result.response, "Não entendi.", "sem knowledgeBaseEnabled explicitamente ligado, o Bot não deveria usar a Base de Conhecimento");
});

test("Base de Conhecimento ligada: intenção sem resposta fixa usa o conteúdo real da KnowledgeSource", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} ConhecimentoOn`, status: "ACTIVE", channel: "META", autoReplyEnabled: true,
      featureFlags: { knowledgeBaseEnabled: true },
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{
        name: "Duvida sobre garantia", active: true, priority: 1,
        examples: { create: [{ text: "qual o prazo de garantia do produto" }] },
      }] },
    },
  });
  await prisma.knowledgeSource.create({
    data: { title: "ToolsKnowledge Teste Garantia On", type: "WARRANTY", source: "Manual", content: "A garantia do produto é de 12 meses a partir da compra." },
  });
  const conversation = await seedConversation();
  const message = await addMessage(conversation, "qual o prazo de garantia do produto");
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });

  assert.match(result.response, /12 meses/);
});
