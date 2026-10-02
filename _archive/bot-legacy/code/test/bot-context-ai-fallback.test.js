require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { orchestrate, simulateOrchestration } = require("../src/services/bot-orchestrator-service");
const { interpret, interpretWithProviders } = require("../src/services/bot-interpreter-service");
const { KnowledgeSourceProvider } = require("../src/services/bot-knowledge/knowledge-provider");
const { analyzeConversation } = require("../src/services/bot-learning-service");
const { recordAiUsage, usageSummary } = require("../src/services/bot-ai-usage-service");
const { detectFlowOutcome } = require("../src/services/bot-flow-service");
const { getPrimaryProvider } = require("../src/services/ai/get-ai-provider");
const botController = require("../src/controllers/bot-controller");

const botNamePrefix = "Bot Contexto IA Teste";
const externalId = "bot-contexto-ia-test-contact";
const knowledgeTitlePrefix = "Contexto IA Teste";

async function cleanup() {
  await prisma.bot.deleteMany({ where: { name: { startsWith: botNamePrefix } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: externalId } } });
  await prisma.knowledgeSource.deleteMany({ where: { title: { startsWith: knowledgeTitlePrefix } } });
  await prisma.botAiUsage.deleteMany({ where: { reason: "TESTE_CONTEXTO_IA" } });
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

// Isola cada teste que usa a Base de Conhecimento: sem isso, artigos
// genéricos deixados por um teste anterior (mesmo score, mesma
// especificidade) disparariam o detector de conflito (item 6) num teste
// seguinte que não tem nada a ver com conflito.
async function cleanupKnowledge() {
  await prisma.knowledgeSource.deleteMany({ where: { title: { startsWith: knowledgeTitlePrefix } } });
}

async function sendMessage(conversation, text) {
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id, externalId: `ctx-${conversation.id}-${Math.random()}`,
      direction: "RECEBIDA", status: "RECEBIDA", type: "text", text, occurredAt: new Date(),
    },
  });
  return orchestrate({ conversationId: conversation.id, messageId: message.id, message: text });
}

async function createConexaoBot({ botOverrides = {} } = {}) {
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} ${Date.now()}-${Math.random()}`, status: "ACTIVE", channel: "META",
      autoReplyEnabled: true, toolsEnabled: false,
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      featureFlags: { knowledgeBaseEnabled: true, contextExpirationMinutes: 5, ...botOverrides },
      intents: { create: [{
        name: "Suporte de conexão", active: true, priority: 1,
        examples: { create: [{ text: "não conecta" }, { text: "problema de conexão" }] },
      }] },
    },
    include: { intents: true },
  });
  const intentId = bot.intents[0].id;
  const ask = await prisma.botFlowStep.create({
    data: { intentId, name: "Modelo", order: 1, action: "ASK_QUESTION", question: "Qual o modelo?", entityKey: "productName" },
  });
  const useKnowledge = await prisma.botFlowStep.create({ data: { intentId, name: "Conhecimento", order: 2, action: "USE_KNOWLEDGE" } });
  const resolved = await prisma.botFlowStep.create({ data: { intentId, name: "Resolvido", order: 3, action: "RESOLVED", responseMessage: "Ótimo!" } });
  await prisma.botFlowStep.update({ where: { id: ask.id }, data: { nextStepId: useKnowledge.id } });
  await prisma.botFlowStep.update({ where: { id: useKnowledge.id }, data: { onSuccessStepId: resolved.id } });
  return { bot, intentId };
}

// Item 1/5: entidade coletada (productName) fica disponível para a busca de
// conhecimento da PRÓXIMA etapa e prioriza o artigo específico do produto.
test("contexto preserva o modelo informado e a Base de Conhecimento prioriza o artigo específico do produto", async () => {
  await cleanupKnowledge();
  await prisma.knowledgeSource.create({
    data: { title: `${knowledgeTitlePrefix} Genérico`, type: "PROCEDURE", content: "Procedimento genérico de conexão.", tags: ["conexao"] },
  });
  await prisma.knowledgeSource.create({
    data: { title: `${knowledgeTitlePrefix} Pareamento GS Pro 2`, type: "PROCEDURE", content: "Pareamento específico do GS Pro 2.", product: "GS Pro 2", tags: ["conexao"] },
  });

  const { bot } = await createConexaoBot();
  const conversation = await seedConversation();
  await sendMessage(conversation, "não conecta");
  const final = await sendMessage(conversation, "GS Pro 2");

  assert.equal(final.response.includes("Pareamento específico do GS Pro 2"), true, "deveria priorizar o conhecimento específico do produto coletado");

  const state = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.equal(state.flowCollectedEntities.productName, "GS Pro 2", "o modelo informado deveria ficar guardado no estado");
  await prisma.bot.delete({ where: { id: bot.id } });
});

// Item 6: dois artigos igualmente específicos e com conteúdo diferente nunca
// devem ser escolhidos "no escuro" — o provider sinaliza o conflito.
test("conflito entre duas fontes igualmente específicas: a busca nunca escolhe uma no escuro", async () => {
  await cleanupKnowledge();
  await prisma.knowledgeSource.create({
    data: { title: `${knowledgeTitlePrefix} Conflito A`, type: "PROCEDURE", content: "Instrução A para o mesmo produto.", product: "GS Pro 3" },
  });
  await prisma.knowledgeSource.create({
    data: { title: `${knowledgeTitlePrefix} Conflito B`, type: "PROCEDURE", content: "Instrução B, diferente, para o mesmo produto.", product: "GS Pro 3" },
  });
  const provider = new KnowledgeSourceProvider();
  const results = await provider.search("conexao", { product: "GS Pro 3" });
  assert.equal(results.conflict, true, "duas fontes válidas e igualmente específicas deveriam sinalizar conflito");
});

// Item 2: sessão expirada nunca reaproveita o fluxo/intenção antiga como se
// fosse atual — só o estado operacional é resetado, o histórico continua.
test("contexto expira: uma nova mensagem depois do TTL não reata o fluxo antigo", async () => {
  const { bot } = await createConexaoBot({ botOverrides: { contextExpirationMinutes: 5 } });
  const conversation = await seedConversation();
  await sendMessage(conversation, "não conecta");
  let state = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.ok(state.currentFlowStepId, "deveria estar aguardando o modelo");

  // Força a sessão a parecer expirada (mais de 5 minutos desde a última atualização).
  await prisma.conversationBotState.update({
    where: { conversationId: conversation.id }, data: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) },
  });

  await sendMessage(conversation, "GS Pro 2"); // mensagem solta, sem a intenção reconhecida
  state = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.equal(state.currentFlowStepId, null, "o fluxo antigo nunca deveria continuar depois da expiração");

  const history = await prisma.message.count({ where: { conversationId: conversation.id } });
  assert.equal(history, 2, "o histórico de mensagens reais nunca é apagado pela expiração");
  await prisma.bot.delete({ where: { id: bot.id } });
});

// Item 3: novos sinais de resolução (positivos e negativos) desta fase.
test("novos sinais de resolução: 'perfeito'/'voltou ao normal' resolvem, 'segue com problema' não resolve", () => {
  assert.equal(detectFlowOutcome("perfeito, muito obrigado"), "RESOLVED");
  assert.equal(detectFlowOutcome("voltou ao normal"), "RESOLVED");
  assert.equal(detectFlowOutcome("ainda segue com problema"), "NOT_RESOLVED");
});

// Item 4: RESOLVED nunca finaliza a conversa sozinho por padrão (flag OFF).
test("autoFinalizeOnResolution=OFF (default): RESOLVED responde mas não finaliza a conversa", async () => {
  await cleanupKnowledge();
  const { bot } = await createConexaoBot();
  await prisma.knowledgeSource.create({
    data: { title: `${knowledgeTitlePrefix} Padrão`, type: "PROCEDURE", content: "Procedimento padrão.", tags: ["conexao"] },
  });
  const conversation = await seedConversation();
  await sendMessage(conversation, "não conecta");
  await sendMessage(conversation, "GS Pro 2");
  const conversationRow = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.notEqual(conversationRow.status, "FINALIZADO", "sem o flag ligado, a conversa nunca deveria ser finalizada sozinha");
  await prisma.bot.delete({ where: { id: bot.id } });
});

test("autoFinalizeOnResolution=ON: sinaliza finalização, mas não finaliza antes de um envio confirmado", async () => {
  await cleanupKnowledge();
  const { bot } = await createConexaoBot({ botOverrides: { autoFinalizeOnResolution: true } });
  await prisma.knowledgeSource.create({
    data: { title: `${knowledgeTitlePrefix} Padrão2`, type: "PROCEDURE", content: "Procedimento padrão dois.", tags: ["conexao"] },
  });
  const conversation = await seedConversation();
  await sendMessage(conversation, "não conecta");
  const result = await sendMessage(conversation, "GS Pro 2");
  const conversationRow = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(result.autoFinalizeRequested, true);
  assert.notEqual(conversationRow.status, "FINALIZADO", "o observador nunca deve finalizar antes de um envio confirmado");
  await prisma.bot.delete({ where: { id: bot.id } });
});

function botFixtureForInterpret(overrides = {}) {
  return {
    id: "bot-ctx-ia", intents: [{
      id: "intent-pedido", name: "Acompanhar pedido", active: true, priority: 0,
      examples: [{ id: "ex-1", text: "onde esta meu pedido" }],
    }],
    ...overrides,
  };
}

// Item 12/13: IA externa OFF (default) nunca é chamada, mesmo com confiança
// baixa/local nula.
test("externalAiFallbackEnabled=OFF (default): a IA externa nunca é consultada", async () => {
  const result = await interpret({
    bot: botFixtureForInterpret(), message: "isso é algo totalmente não relacionado", flags: { externalAiFallbackEnabled: false },
  });
  assert.equal(result.calledExternalAi, false);
});

// Item 13: mesmo com o flag ligado, só chama a IA externa quando a
// confiança local ficar abaixo do threshold — nunca substitui um resultado
// local já confiante.
test("externalAiFallbackEnabled=ON: só tenta a IA externa quando a confiança local está abaixo do threshold", async () => {
  const confidentResult = await interpret({
    bot: botFixtureForInterpret(), message: "onde esta meu pedido",
    flags: { externalAiFallbackEnabled: true, externalAiThreshold: 0.7 },
  });
  assert.equal(confidentResult.calledExternalAi, false, "confiança local alta não deveria acionar a IA externa");
});

// Item 14: sem credencial configurada, a aplicação nunca quebra — o motor
// segue funcionando só com o provider local.
test("provider externo sem credencial configurada: getPrimaryProvider nunca lança e cai para o local", async () => {
  const { provider, name } = await getPrimaryProvider();
  assert.ok(provider);
  assert.ok(["LOCAL_FALLBACK", "ANTHROPIC"].includes(name));
  const result = await interpret({
    bot: botFixtureForInterpret(), message: "onde esta meu pedido", flags: { externalAiFallbackEnabled: true, externalAiThreshold: 0.99 },
  });
  assert.ok(result.status !== undefined, "a interpretação nunca deveria lançar mesmo tentando o fallback externo");
});

test("falha do provider externo ainda registra que a chamada real aconteceu", async () => {
  const local = { name: "LOCAL_FALLBACK", provider: { classifyIntent: async () => null } };
  const external = { name: "ANTHROPIC", provider: { classifyIntent: async () => { throw new Error("falha externa"); } } };
  const result = await interpretWithProviders({
    bot: botFixtureForInterpret(), message: "mensagem ambígua", primary: external, fallback: local,
  });
  assert.equal(result.providerAttempted, "ANTHROPIC");
});

test("teste de conexão da IA exige confirmação explícita antes da chamada real", async () => {
  let capturedError = null;
  await botController.testAiProvider(
    { user: { role: "ADMIN" }, body: {} },
    { json: () => assert.fail("não deveria chamar o provider sem confirmação") },
    (error) => { capturedError = error; },
  );
  assert.equal(capturedError?.statusCode, 400);
});

// Item 18: o simulador nunca envia mensagem real e expõe se a IA externa
// seria chamada, sem realmente registrar métrica de uso (isso só acontece
// em orchestrate(), nunca em simulateOrchestration()).
test("simulador nunca grava BotAiUsage mesmo quando calledExternalAi está no resultado", async () => {
  const before = await prisma.botAiUsage.count();
  await simulateOrchestration({
    bot: {
      id: "bot-sim-ctx", status: "ACTIVE", channel: "META", featureFlags: {},
      intents: [{ id: "intent-x", name: "Duvida", active: true, priority: 0, examples: [{ id: "e1", text: "duvida" }] }],
    },
    message: "mensagem qualquer",
  });
  const after = await prisma.botAiUsage.count();
  assert.equal(after, before, "o simulador nunca deveria gerar métrica de uso de IA");
});

// Item 15: métrica simples de uso é gravada e agregável por provider/motivo.
test("recordAiUsage grava e usageSummary agrega por provider/motivo", async () => {
  await recordAiUsage({ botId: null, provider: "ANTHROPIC_TESTE", reason: "TESTE_CONTEXTO_IA", usage: { inputTokens: 120, outputTokens: 40 } });
  const summary = await usageSummary({ provider: "ANTHROPIC_TESTE" });
  const row = summary.find((item) => item.reason === "TESTE_CONTEXTO_IA");
  assert.ok(row, "deveria existir um agrupamento para o motivo registrado");
  assert.equal(row.calls, 1);
  assert.equal(row.inputTokens, 120);
  assert.equal(row.outputTokens, 40);
  await prisma.botAiUsage.deleteMany({ where: { provider: "ANTHROPIC_TESTE" } });
});

// Item 16: fluxo RESOLVED gera sugestão de "solução recorrente" (KNOWLEDGE);
// fluxo HANDED_OFF gera sugestão de revisão (FLOW_REVIEW) — sempre PENDING,
// nunca aplicadas sozinhas.
test("Aprendizado: fluxo RESOLVED sugere conhecimento recorrente (PENDING, exige aprovação)", async () => {
  await cleanupKnowledge();
  const { bot, intentId } = await createConexaoBot();
  await prisma.knowledgeSource.create({
    data: { title: `${knowledgeTitlePrefix} Aprendizado`, type: "PROCEDURE", content: "Procedimento de aprendizado.", tags: ["conexao"] },
  });
  const conversation = await seedConversation();
  await sendMessage(conversation, "não conecta");
  await sendMessage(conversation, "GS Pro 2");
  await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "FINALIZADO" } });

  const analysis = await analyzeConversation(conversation.id, { force: true });
  assert.equal(analysis.analyzed, true);

  const suggestion = await prisma.botLearningSuggestion.findFirst({
    where: { conversationId: conversation.id, type: "KNOWLEDGE", intentId },
  });
  assert.ok(suggestion, "deveria gerar uma sugestão de conhecimento a partir do fluxo resolvido");
  assert.equal(suggestion.status, "PENDING", "sugestão nunca é aplicada sozinha — sempre exige aprovação humana");
  await prisma.bot.delete({ where: { id: bot.id } });
});

test("Aprendizado: fluxo HANDED_OFF sugere revisão do fluxo (FLOW_REVIEW, PENDING)", async () => {
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Handoff ${Date.now()}`, status: "ACTIVE", channel: "META",
      autoReplyEnabled: true, toolsEnabled: false,
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{
        name: "Suporte sem solução", active: true, priority: 1,
        examples: { create: [{ text: "não funciona nada" }] },
      }] },
    },
    include: { intents: true },
  });
  const intentId = bot.intents[0].id;
  await prisma.botFlowStep.create({ data: { intentId, name: "Encaminhar", order: 1, action: "HANDOFF_HUMAN", responseMessage: "Vou te encaminhar." } });

  const conversation = await seedConversation();
  await sendMessage(conversation, "não funciona nada");
  await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "FINALIZADO" } });

  const analysis = await analyzeConversation(conversation.id, { force: true });
  assert.equal(analysis.analyzed, true);

  const suggestion = await prisma.botLearningSuggestion.findFirst({
    where: { conversationId: conversation.id, type: "FLOW_REVIEW", intentId },
  });
  assert.ok(suggestion, "deveria gerar uma sugestão de revisão a partir do fluxo encaminhado para humano");
  assert.equal(suggestion.status, "PENDING");
  await prisma.bot.delete({ where: { id: bot.id } });
});
