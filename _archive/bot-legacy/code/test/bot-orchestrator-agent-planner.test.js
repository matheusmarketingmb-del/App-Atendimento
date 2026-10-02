// Testa o Agent Planner (item 3 do plano de Inteligência de Bots) ponta a
// ponta, dentro do orquestrador real (orchestrate()), atrás da flag
// agentPlannerEnabled (default false — nada aqui muda o comportamento de um
// Bot que não ligar isso explicitamente). Cobre os cenários centrais do
// item 13: entender apesar de typo, não perguntar de novo o que já é
// conhecido, ambiguidade tratada com CLARIFY, e handoff continua igual.
require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { orchestrate } = require("../src/services/bot-orchestrator-service");
const { emptyCaseState } = require("../src/services/bot-case-state-service");

const botNamePrefix = "Bot Agent Planner Teste";
const externalId = "bot-agent-planner-test-contact";

async function cleanup() {
  await prisma.bot.deleteMany({ where: { name: { startsWith: botNamePrefix } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: externalId } } });
  await prisma.knowledgeSource.deleteMany({ where: { title: { startsWith: "Agent Planner Teste" } } });
}

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

let phoneCounter = 0;
async function seedConversation() {
  phoneCounter += 1;
  const contact = await prisma.contact.create({
    data: { externalId: `${externalId}-${phoneCounter}`, phone: `5511988800${String(phoneCounter).padStart(3, "0")}`, name: "Cliente" },
  });
  return prisma.conversation.create({ data: { contactId: contact.id } });
}

async function addMessage(conversation, text) {
  return prisma.message.create({
    data: {
      conversationId: conversation.id, externalId: `plan-${conversation.id}-${Math.random()}`,
      direction: "RECEBIDA", status: "RECEBIDA", type: "text", text, occurredAt: new Date(),
    },
  });
}

// Escopo desta fase (Fase 1/2 do plano): o reforço semântico melhora o
// RECONHECIMENTO DA INTENT (bot-semantic-normalizer.js/bot-intent-ranking-
// service.js) — ainda não a BUSCA da Base de Conhecimento em si
// (bot-knowledge-response-service.js/knowledge-provider.js continuam
// puramente lexicais sobre a mensagem crua; isso é a Fase 3, "Knowledge-
// first" semântico, ainda não implementada). Por isso o teste comprova (a)
// que a intent certa é encontrada apesar do typo forte, com confiança alta,
// e (b) que, uma vez a intent certa roteada, o caminho de Knowledge de
// sempre (resolveKnowledgeResponse) continua funcionando de ponta a ponta
// quando o conteúdo cadastrado compartilha vocabulário literal com a
// mensagem.
test("typo forte ('meu relogio nao conect') ainda encontra a intent certa, com confiança alta", async () => {
  await cleanup();
  await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Conectividade`, status: "ACTIVE", channel: "META", autoReplyEnabled: true,
      featureFlags: { agentPlannerEnabled: true, knowledgeBaseEnabled: true },
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{
        name: "Problema de conectividade", active: true, priority: 1,
        examples: { create: [{ text: "meu relógio não conecta" }, { text: "não consigo parear o relógio" }] },
      }] },
    },
  });

  const conversation = await seedConversation();
  const message = await addMessage(conversation, "meu relogio nao conect");
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });

  assert.equal(result.intentName, "Problema de conectividade");
  assert.ok(result.confidence > 0.8, `confiança deveria ser alta mesmo com typo, veio ${result.confidence}`);
  assert.equal(result.plannerAction, "SEARCH_KNOWLEDGE");
});

test("intent corretamente roteada apesar do typo -> Knowledge com vocabulário compartilhado ainda é encontrada e usada", async () => {
  await cleanup();
  await prisma.bot.create({
    data: {
      name: `${botNamePrefix} ConectividadeKS`, status: "ACTIVE", channel: "META", autoReplyEnabled: true,
      featureFlags: { agentPlannerEnabled: true, knowledgeBaseEnabled: true },
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{
        name: "Problema de conectividade", active: true, priority: 1,
        examples: { create: [{ text: "meu relógio não conecta" }, { text: "não consigo parear o relógio" }] },
      }] },
    },
  });
  await prisma.knowledgeSource.create({
    data: {
      title: "Agent Planner Teste Conectividade", type: "PRODUCT", source: "Manual",
      content: "Se o relógio não conecta, reinicie o Bluetooth do celular e tente parear novamente pelo aplicativo.",
    },
  });

  const conversation = await seedConversation();
  const message = await addMessage(conversation, "meu relogio nao conect");
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });

  assert.equal(result.action, "RESPOND");
  assert.equal(result.knowledgeSourceTitle, "Agent Planner Teste Conectividade");
  assert.equal(result.response, "Se o relógio não conecta, reinicie o Bluetooth do celular e tente parear novamente pelo aplicativo.");
});

test("entidade já conhecida pelo Case State: não pergunta de novo, vai direto para USE_TOOL", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Produto`, status: "ACTIVE", channel: "META", autoReplyEnabled: true, toolsEnabled: true,
      toolPermissions: { ProductTool: true },
      featureFlags: { agentPlannerEnabled: true },
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{
        name: "Consultar produto", active: true, priority: 1, toolName: "ProductTool",
        examples: { create: [{ text: "quero saber sobre o produto" }, { text: "informações do produto" }] },
      }] },
    },
  });
  const conversation = await seedConversation();
  // Simula que o produto já foi capturado num turno anterior (Case State
  // já existia antes desta mensagem).
  await prisma.conversationBotState.create({
    data: { conversationId: conversation.id, activeBotId: bot.id, caseState: { ...emptyCaseState(), product: "GS Pro 2" } },
  });

  const message = await addMessage(conversation, "quero saber sobre o produto");
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });

  // resolveToolDecision (reaproveitado sem mudanças) sempre resolve QUERY_TOOL
  // para RESPOND no final (com dado real ou fallback seguro, nunca inventa)
  // — o que prova que o Planner NÃO pediu esclarecimento é `plannerAction`
  // ter sido "USE_TOOL" (não "ASK") e `toolName` estar preenchido: a Tool
  // foi consultada direto, sem perguntar de novo o produto já conhecido.
  assert.notEqual(result.action, "ASK_CLARIFICATION");
  assert.equal(result.plannerAction, "USE_TOOL");
  assert.equal(result.toolName, "ProductTool");

  const state = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.equal(state.caseState.product, "GS Pro 2", "produto continua conhecido depois do turno");
});

test("entidade obrigatória desconhecida: pergunta uma única vez e registra a pergunta no Case State", async () => {
  await cleanup();
  await prisma.bot.create({
    data: {
      name: `${botNamePrefix} ProdutoSemDado`, status: "ACTIVE", channel: "META", autoReplyEnabled: true, toolsEnabled: true,
      toolPermissions: { ProductTool: true },
      featureFlags: { agentPlannerEnabled: true },
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{
        name: "Consultar produto", active: true, priority: 1, toolName: "ProductTool",
        examples: { create: [{ text: "quero saber sobre o produto" }, { text: "informações do produto" }] },
      }] },
    },
  });
  const conversation = await seedConversation();
  const message = await addMessage(conversation, "quero saber sobre o produto");
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });

  assert.equal(result.action, "ASK_CLARIFICATION");
  assert.equal(result.plannerAction, "ASK");
  assert.match(result.response, /produto/i);

  const state = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.ok(state.caseState.questionsAsked.length >= 1, "a pergunta feita deveria ficar registrada no Case State");
});

test("handoff explícito continua funcionando igual com o Agent Planner ligado", async () => {
  await cleanup();
  await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Handoff`, status: "ACTIVE", channel: "META", autoReplyEnabled: true,
      featureFlags: { agentPlannerEnabled: true },
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    },
  });
  const conversation = await seedConversation();
  const message = await addMessage(conversation, "preciso falar com um atendente");
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });

  assert.equal(result.action, "HANDOFF_HUMAN");
  assert.equal(result.plannerAction, "HANDOFF");
  assert.match(result.response, /encaminhar.*atendente/i);
});

test("mensagem sem nenhuma relação com as intents cadastradas -> CLARIFY (nunca finge que entendeu)", async () => {
  await cleanup();
  await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Desconhecido`, status: "ACTIVE", channel: "META", autoReplyEnabled: true,
      featureFlags: { agentPlannerEnabled: true },
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{
        name: "Consultar garantia", active: true, priority: 1, responseMessage: "Sua garantia é de 12 meses.",
        examples: { create: [{ text: "qual o prazo de garantia" }] },
      }] },
    },
  });
  const conversation = await seedConversation();
  const message = await addMessage(conversation, "voces vendem carro importado");
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });

  assert.equal(result.action, "ASK_CLARIFICATION");
  assert.equal(result.plannerAction, "CLARIFY");
});

test("Bot sem agentPlannerEnabled (default) continua usando o decide() legado, sem plannerAction", async () => {
  await cleanup();
  await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Legado`, status: "ACTIVE", channel: "META", autoReplyEnabled: true,
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{
        name: "Consultar garantia", active: true, priority: 1, responseMessage: "Sua garantia é de 12 meses.",
        examples: { create: [{ text: "qual o prazo de garantia" }] },
      }] },
    },
  });
  const conversation = await seedConversation();
  const message = await addMessage(conversation, "qual o prazo de garantia");
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });

  assert.equal(result.response, "Sua garantia é de 12 meses.");
  assert.equal(result.plannerAction, null);
});
