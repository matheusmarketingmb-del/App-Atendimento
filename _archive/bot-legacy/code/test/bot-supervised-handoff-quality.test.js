require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const prisma = require("../src/database/prisma");
const { orchestrate } = require("../src/services/bot-orchestrator-service");
const { observeIncomingMessage } = require("../src/services/bot-observation-service");
const { analyzeConversation } = require("../src/services/bot-learning-service");
const { getLatestSuggestion, recordSuggestionFeedback } = require("../src/services/bot-suggestion-service");
const { qualityMetrics } = require("../src/services/bot-quality-service");
const { ratingMetrics } = require("../src/services/bot-rating-service");
const registry = require("../src/services/bot-tools/tool-registry");

const botNamePrefix = "Bot Supervisao Teste";
const externalId = "bot-supervisao-test-contact";
const masterEmail = "master-supervisao-test@teste.local";
let master;

async function cleanup() {
  await prisma.bot.deleteMany({ where: { name: { startsWith: botNamePrefix } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: externalId } } });
  await prisma.quickReply.deleteMany({ where: { name: { startsWith: "QR Supervisao" } } });
}

test.before(async () => {
  master = await prisma.user.upsert({
    where: { email: masterEmail }, update: {}, create: { name: "Master Supervisao", email: masterEmail, role: "ADMIN" },
  });
  await prisma.botGlobalSettings.upsert({
    where: { id: "singleton" }, update: { ratingsEnabled: true, learningEnabled: true, observationEnabled: true },
    create: { id: "singleton", ratingsEnabled: true, learningEnabled: true, observationEnabled: true },
  });
});

test.after(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { email: masterEmail } });
  await prisma.$disconnect();
});

let phoneCounter = 0;
async function seedConversation() {
  phoneCounter += 1;
  const contact = await prisma.contact.create({
    data: { externalId: `${externalId}-${phoneCounter}`, phone: `5511955500${String(phoneCounter).padStart(3, "0")}`, name: "Cliente" },
  });
  return prisma.conversation.create({ data: { contactId: contact.id } });
}

async function sendMessage(conversation, text) {
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id, externalId: `sup-${conversation.id}-${Math.random()}`,
      direction: "RECEBIDA", status: "RECEBIDA", type: "text", text, occurredAt: new Date(),
    },
  });
  return orchestrate({ conversationId: conversation.id, messageId: message.id, message: text });
}

// Passa pelo caminho REAL do webhook (bot-observation-service.js), que é o
// único lugar que persiste BotObservation — usado nos testes que verificam
// Observação/sugestão de resposta, que dependem dessa persistência.
async function observeMessage(conversation, text) {
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id, externalId: `obs-${conversation.id}-${Math.random()}`,
      direction: "RECEBIDA", status: "RECEBIDA", type: "text", text, occurredAt: new Date(),
    },
  });
  return observeIncomingMessage({ type: "text", text }, message);
}

// Bot com duas intenções, cada uma com seu próprio fluxo — usado nos testes
// de troca de assunto/pilha e contexto de produto.
async function createTwoIntentBot(overrides = {}) {
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} ${Date.now()}-${Math.random()}`, status: "ACTIVE", channel: "META",
      autoReplyEnabled: true, toolsEnabled: false,
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      ...overrides,
      intents: {
        create: [
          {
            name: "Suporte de conexão", active: true, priority: 1,
            examples: { create: [{ text: "meu relogio nao conecta" }, { text: "nao consigo conectar o relogio" }] },
          },
          {
            name: "Acompanhar pedido", active: true, priority: 1, responseMessage: "Seu pedido está a caminho!",
            examples: { create: [{ text: "onde esta meu pedido" }, { text: "cade minha encomenda" }] },
          },
        ],
      },
    },
    include: { intents: { orderBy: { createdAt: "asc" } } },
  });
  const conexaoIntent = bot.intents.find((intent) => intent.name === "Suporte de conexão");
  const pedidoIntent = bot.intents.find((intent) => intent.name === "Acompanhar pedido");

  const ask = await prisma.botFlowStep.create({
    data: {
      intentId: conexaoIntent.id, name: "Modelo", order: 1, action: "ASK_QUESTION",
      question: "Qual o modelo do seu relógio?", entityKey: "productName",
    },
  });
  const resolved = await prisma.botFlowStep.create({
    data: { intentId: conexaoIntent.id, name: "Resolvido", order: 2, action: "RESOLVED", responseMessage: "Ótimo, consegui te ajudar!" },
  });
  await prisma.botFlowStep.update({ where: { id: ask.id }, data: { nextStepId: resolved.id } });

  return { bot, conexaoIntent, pedidoIntent };
}

// Item 4/5: troca de assunto no meio de um fluxo deve iniciar a nova
// intenção sem perder o fluxo pausado, e retomar a pergunta pendente depois.
test("troca de assunto: nova intenção não é tratada como resposta à etapa pendente, e o fluxo anterior é retomado", async () => {
  await cleanup();
  const { bot } = await createTwoIntentBot();
  const conversation = await seedConversation();

  const first = await sendMessage(conversation, "meu relogio nao conecta");
  assert.match(first.response, /Qual o modelo/);

  const second = await sendMessage(conversation, "onde esta meu pedido");
  assert.equal(second.topicSwitchDetected, true, "deveria detectar troca de assunto");
  assert.equal(second.intentName, "Acompanhar pedido");
  assert.match(second.response, /pedido está a caminho/);
  // Item 5: a pergunta do fluxo pausado volta a aparecer no mesmo turno em
  // que a nova intenção termina (não perde o contexto anterior).
  assert.match(second.response, /Qual o modelo/);

  const state = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.equal(state.activeFlowIntentId, (await prisma.botIntent.findFirst({ where: { botId: bot.id, name: "Suporte de conexão" } })).id);
  assert.ok(state.currentFlowStepId, "o fluxo de conexão deveria estar retomado, aguardando o modelo");
  await prisma.bot.delete({ where: { id: bot.id } });
});

// Item 6: produto informado numa intenção fica disponível para outra
// intenção/fluxo depois, sem perguntar de novo — respeita o mesmo TTL do
// resto do contexto.
test("contexto de produto: modelo informado numa etapa continua disponível depois de trocar de intenção", async () => {
  await cleanup();
  const { bot } = await createTwoIntentBot();
  const conversation = await seedConversation();

  await sendMessage(conversation, "meu relogio nao conecta");
  await sendMessage(conversation, "GS Pro 2"); // responde a etapa -> RESOLVED, fecha o fluxo

  const state = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.equal(state.contextEntities.productName, "GS Pro 2");

  // Reabre o mesmo fluxo — a etapa que pede o modelo deve ser pulada porque
  // o contexto da conversa já sabe o produto.
  const third = await sendMessage(conversation, "meu relogio nao conecta");
  assert.doesNotMatch(third.response || "", /Qual o modelo/);
  await prisma.bot.delete({ where: { id: bot.id } });
});

// Item 3: humano assumiu -> Flow Engine e Tools ficam congelados, nunca
// executam de verdade, mas a Observação continua rodando.
test("humano assumiu a conversa: o Flow Engine para de avançar e a Tool nunca executa de verdade", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Pausa ${Date.now()}`, status: "ACTIVE", channel: "META",
      autoReplyEnabled: true, toolsEnabled: true, toolPermissions: { OrderTool: true },
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{
        name: "Rastrear pedido", active: true, priority: 1,
        examples: { create: [{ text: "quero rastrear meu pedido" }] },
      }] },
    },
    include: { intents: true },
  });
  const intentId = bot.intents[0].id;
  const ask = await prisma.botFlowStep.create({
    data: { intentId, name: "Número do pedido", order: 1, action: "ASK_QUESTION", question: "Qual o número do pedido?", entityKey: "orderNumber" },
  });
  const query = await prisma.botFlowStep.create({ data: { intentId, name: "Consulta", order: 2, action: "QUERY_TOOL", toolName: "OrderTool" } });
  await prisma.botFlowStep.update({ where: { id: ask.id }, data: { nextStepId: query.id } });

  const agent = await prisma.user.upsert({
    where: { email: "atendente-pausa-teste@teste.local" }, update: {},
    create: { name: "Atendente Pausa", email: "atendente-pausa-teste@teste.local", role: "ATENDENTE" },
  });
  const conversation = await seedConversation();
  await sendMessage(conversation, "quero rastrear meu pedido"); // inicia o fluxo, pede o número
  await prisma.conversation.update({ where: { id: conversation.id }, data: { assignedUserId: agent.id, status: "EM_ATENDIMENTO" } });

  let executed = false;
  const tool = registry.tools.OrderTool;
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (...args) => { executed = true; return originalExecute(...args); };
  try {
    const stateBefore = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
    const result = await observeMessage(conversation, "123456789");
    assert.equal(result.humanPaused, true);
    assert.equal(executed, false, "a Tool nunca deveria executar de verdade enquanto um humano está com a conversa");

    const stateAfter = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
    assert.equal(stateAfter.currentFlowStepId, stateBefore.currentFlowStepId, "o Flow Engine deveria ficar congelado, nunca avançar sozinho");

    // Observação continua: a interpretação ainda é registrada.
    const observation = await prisma.botObservation.findFirst({ where: { conversationId: conversation.id }, orderBy: { createdAt: "desc" } });
    assert.ok(observation, "a Observação deveria continuar registrando mesmo com o humano na conversa");
  } finally {
    tool.execute = originalExecute;
  }
  await prisma.bot.delete({ where: { id: bot.id } });
});

// Item 2: o handoff carrega um resumo estruturado (produto, etapa, motivo)
// em vez de obrigar o atendente a reler a conversa inteira.
test("handoff inteligente: contexto capturado inclui produto, etapa e resumo do fluxo", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Handoff ${Date.now()}`, status: "ACTIVE", channel: "META",
      autoReplyEnabled: true,
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{
        name: "Suporte de conexão", active: true, priority: 1,
        examples: { create: [{ text: "relogio nao conecta" }] },
      }] },
    },
    include: { intents: true },
  });
  const intentId = bot.intents[0].id;
  const ask = await prisma.botFlowStep.create({
    data: { intentId, name: "Modelo", order: 1, action: "ASK_QUESTION", question: "Qual o modelo?", entityKey: "productName" },
  });
  const handoffStep = await prisma.botFlowStep.create({
    data: { intentId, name: "Encaminhar", order: 2, action: "HANDOFF_HUMAN", responseMessage: "Vou te encaminhar." },
  });
  await prisma.botFlowStep.update({ where: { id: ask.id }, data: { nextStepId: handoffStep.id } });

  const conversation = await seedConversation();
  await sendMessage(conversation, "relogio nao conecta");
  await sendMessage(conversation, "GS Pro 2");

  const handoff = await prisma.botHandoffContext.findFirst({ where: { conversationId: conversation.id }, orderBy: { createdAt: "desc" } });
  assert.ok(handoff, "deveria ter capturado o contexto do handoff");
  assert.equal(handoff.product, "GS Pro 2");
  assert.equal(handoff.flowResolutionStatus, "HANDED_OFF");
  assert.equal(handoff.currentStepName, "Encaminhar", "deve registrar a etapa terminal HANDOFF_HUMAN, não a tentativa anterior");
  assert.match(handoff.summary, /GS Pro 2/);
  await prisma.bot.delete({ where: { id: bot.id } });
});

// Item 9: pede a avaliação uma única vez, interpreta a resposta 1-5 como
// nota (não como intenção), e nunca pede de novo na mesma conversa.
test("avaliação do cliente: pede uma vez, registra a nota 1-5 e nunca repete", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Rating ${Date.now()}`, status: "ACTIVE", channel: "META",
      autoReplyEnabled: true, ratingEnabled: true, requestRatingOn: "BOT_COMPLETED",
      ratingMessage: "De 1 a 5, como foi o atendimento?", ratingFollowupMessage: "Valeu pela nota!",
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{
        name: "Suporte de conexão", active: true, priority: 1,
        examples: { create: [{ text: "relogio nao conecta" }] },
      }] },
    },
    include: { intents: true },
  });
  const intentId = bot.intents[0].id;
  const resolved = await prisma.botFlowStep.create({
    data: { intentId, name: "Resolvido", order: 1, action: "RESOLVED", responseMessage: "Show, resolvido!" },
  });
  void resolved;

  const conversation = await seedConversation();
  const first = await sendMessage(conversation, "relogio nao conecta");
  assert.equal(first.ratingRequested, true);
  assert.match(first.response, /De 1 a 5/);

  const stateAfter = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.equal(stateAfter.awaitingRatingScore, true);
  assert.ok(stateAfter.ratingRequestedAt);

  const ratingReply = await sendMessage(conversation, "5");
  assert.equal(ratingReply.response, "Valeu pela nota!");
  const rating = await prisma.botRating.findUnique({ where: { conversationId: conversation.id } });
  assert.ok(rating, "deveria ter registrado a avaliação");
  assert.equal(rating.score, 5);

  const stateFinal = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.equal(stateFinal.awaitingRatingScore, false);
  assert.ok(stateFinal.ratingRequestedAt, "ratingRequestedAt nunca deveria ser limpo — impede pedir de novo");
  await prisma.bot.delete({ where: { id: bot.id } });
});

test("webhook em observação nunca pede nem captura avaliação como se uma resposta tivesse sido enviada", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Rating Observação ${Date.now()}`, status: "ACTIVE", channel: "META",
      autoReplyEnabled: true, ratingEnabled: true, requestRatingOn: "BOT_COMPLETED",
      ratingMessage: "De 1 a 5, como foi o atendimento?",
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{
        name: "Resolver em observação", active: true, priority: 1,
        examples: { create: [{ text: "resolver em observacao" }] },
        flowSteps: { create: [{ name: "Resolvido", order: 1, action: "RESOLVED", responseMessage: "Resolvido." }] },
      }] },
    },
  });
  const conversation = await seedConversation();
  const result = await observeMessage(conversation, "resolver em observacao");
  const state = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.equal(result.ratingRequested, false);
  assert.equal(state.awaitingRatingScore, false);
  assert.equal(state.ratingRequestedAt, null);
  await prisma.bot.delete({ where: { id: bot.id } });
});

// Item 10: ausência de avaliação nunca vira negativo — só entra na conta
// quando o cliente realmente avaliou.
test("ausência de avaliação nunca é contabilizada como negativa", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} SemRating ${Date.now()}`, status: "ACTIVE", channel: "META", ratingEnabled: true,
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    },
  });
  const metrics = await ratingMetrics(bot.id, {}, master);
  assert.equal(metrics.ratings.total, 0);
  assert.equal(metrics.ratings.negative, 0);
  assert.equal(metrics.ratings.average, null, "sem nenhuma avaliação, nunca deveria inventar uma média");
  await prisma.bot.delete({ where: { id: bot.id } });
});

// Item 7/8: sugestão de resposta para o atendente nunca é enviada sozinha —
// só fica disponível para consulta/feedback.
test("sugestão de resposta: fica disponível para o atendente, e o feedback 👍/👎 não duplica", async () => {
  await cleanup();
  const { bot } = await createTwoIntentBot();
  const conversation = await seedConversation();
  await observeMessage(conversation, "onde esta meu pedido");

  const suggestion = await getLatestSuggestion(conversation.id, master);
  assert.ok(suggestion, "deveria existir uma sugestão calculada pelo motor");
  assert.match(suggestion.suggestedResponseText, /pedido está a caminho/);

  const first = await recordSuggestionFeedback({ observationId: suggestion.id, helpful: true }, master);
  const second = await recordSuggestionFeedback({
    observationId: suggestion.id, helpful: false, action: "EDITED", finalResponseText: "Resposta final revisada.",
  }, master);
  const third = await recordSuggestionFeedback({ observationId: suggestion.id, helpful: true }, master);
  assert.equal(first.id, second.id, "o mesmo atendente+sugestão nunca deveria duplicar, só atualizar");
  assert.equal(second.id, third.id);
  assert.equal(third.helpful, true);
  assert.equal(third.action, "EDITED");
  assert.equal(third.finalResponseText, "Resposta final revisada.", "feedback posterior não deve apagar a resposta enviada");

  const count = await prisma.botSuggestionFeedback.count({ where: { observationId: suggestion.id } });
  assert.equal(count, 1);

  await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: `agent-${conversation.id}-${Math.random()}`,
    direction: "ENVIADA", status: "ENVIADA", type: "text", text: "Resposta enviada pelo atendente.",
    occurredAt: new Date(Date.now() + 1000),
  } });
  assert.equal(await getLatestSuggestion(conversation.id, master), null, "sugestão antiga deve sumir depois da resposta do atendente");
  await prisma.bot.delete({ where: { id: bot.id } });
});

test("Central de atendimento expõe sugestão supervisionada sem envio automático", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const js = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");
  assert.match(html, /id="bot-suggestion-card"/);
  assert.match(html, /id="use-bot-suggestion"/);
  assert.match(html, /id="edit-bot-suggestion"/);
  assert.match(html, /id="ignore-bot-suggestion"/);
  assert.match(js, /pendingBotSuggestion/);
  assert.match(js, /action = text === pendingSuggestion\.originalText\.trim\(\) \? "USED" : "EDITED"/);
  assert.match(js, /\/api\/bot-suggestion-feedback/);
  const botsHtml = fs.readFileSync(path.join(__dirname, "..", "public", "bots.html"), "utf8");
  const botsJs = fs.readFileSync(path.join(__dirname, "..", "public", "js", "bots.js"), "utf8");
  assert.match(botsHtml, /id="flag-agentSuggestionsEnabled"/);
  assert.match(botsJs, /agentSuggestionsEnabled/);
});

test("toggle por Bot desativa sugestões ao atendente sem desligar a observação", async () => {
  await cleanup();
  const { bot } = await createTwoIntentBot({ featureFlags: { agentSuggestionsEnabled: false } });
  const conversation = await seedConversation();
  const result = await observeMessage(conversation, "onde esta meu pedido");
  assert.equal(result.agentSuggestionsAllowed, false);
  assert.equal(await getLatestSuggestion(conversation.id, master), null);
  const observation = await prisma.botObservation.findFirst({ where: { conversationId: conversation.id, botId: bot.id }, orderBy: { createdAt: "desc" } });
  assert.ok(observation, "a observação continua sendo registrada");
  assert.equal(observation.suggestedResponseText, null);
  assert.equal(observation.suggestedQuickReplyId, null);
  await prisma.bot.delete({ where: { id: bot.id } });
});
// Item 1: resposta de atendente que resolveu bem e não existe como Resposta
// Rápida ainda vira sugestão QUICK_REPLY, sempre PENDING (nunca criada
// sozinha) — e nunca duplicada se a conversa for reanalisada.
test("aprendizado real: resposta humana sem Resposta Rápida equivalente sugere criar uma nova (PENDING, sem duplicar)", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Aprendizado ${Date.now()}`, status: "ACTIVE", channel: "META",
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    },
  });
  const agent = await prisma.user.upsert({
    where: { email: "atendente-aprendizado-teste@teste.local" }, update: {},
    create: { name: "Atendente Aprendizado", email: "atendente-aprendizado-teste@teste.local", role: "ATENDENTE" },
  });
  const conversation = await seedConversation();
  const customerMsg = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: `learn-${conversation.id}-1`, direction: "RECEBIDA",
    status: "RECEBIDA", type: "text", text: "meu relogio nao carrega mais", occurredAt: new Date(Date.now() - 60000),
  } });
  await prisma.botObservation.create({ data: {
    conversationId: conversation.id, messageId: customerMsg.id, botId: bot.id, botName: bot.name,
    withinHours: true, confidence: 0.3, action: "ASK_CLARIFICATION",
  } });
  await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: `learn-${conversation.id}-2`, direction: "ENVIADA",
    status: "ENVIADA", type: "text", text: "Tente carregar com outro cabo USB-C original por 30 minutos e teste novamente.",
    sentByUserId: agent.id, occurredAt: new Date(Date.now() - 30000),
  } });
  await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: `learn-${conversation.id}-3`, direction: "RECEBIDA",
    status: "RECEBIDA", type: "text", text: "funcionou, obrigado!", occurredAt: new Date(),
  } });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "FINALIZADO" } });

  const analysis = await analyzeConversation(conversation.id, { force: true });
  assert.equal(analysis.analyzed, true);

  const suggestion = await prisma.botLearningSuggestion.findFirst({ where: { conversationId: conversation.id, type: "QUICK_REPLY" } });
  assert.ok(suggestion, "deveria sugerir uma nova Resposta Rápida");
  assert.equal(suggestion.status, "PENDING");
  assert.doesNotMatch(suggestion.suggestedContent, /\b\d{6,}\b/, "nunca deveria aprender um número longo (telefone/token) como exemplo");

  // Reanalisar (force) a mesma conversa não deveria duplicar a sugestão.
  await prisma.conversationLearningState.deleteMany({ where: { conversationId: conversation.id } });
  await analyzeConversation(conversation.id, { force: true });
  const total = await prisma.botLearningSuggestion.count({ where: { conversationId: conversation.id, type: "QUICK_REPLY" } });
  assert.equal(total, 1, "a mesma sugestão não deveria ser duplicada");
  await prisma.bot.delete({ where: { id: bot.id } });
});

// Item 11/12: métricas/alertas de qualidade agregam sinais existentes sem
// inventar percentuais.
test("métricas de qualidade: agregam handoffs/troca de assunto sem quebrar com pouco dado", async () => {
  await cleanup();
  const { bot } = await createTwoIntentBot();
  const conversation = await seedConversation();
  await observeMessage(conversation, "meu relogio nao conecta");
  await observeMessage(conversation, "onde esta meu pedido");

  const metrics = await qualityMetrics(bot.id, master);
  assert.ok(metrics.started >= 2);
  assert.equal(metrics.topicSwitches, 1);
  await prisma.bot.delete({ where: { id: bot.id } });
});
