// Aprendizado supervisionado: observa conversas reais já finalizadas,
// analisa (fora do caminho quente do webhook) e GERA SUGESTÕES — nunca
// altera a configuração do Bot sozinho. Fluxo: conversas -> análise ->
// sugestões -> revisão humana -> aprovação -> aí sim vira conhecimento.
//
// Diferença para bot-observation-service.js: observação responde "o que o
// bot teria feito nesta mensagem?"; aprendizado responde "o que podemos
// aprender com o jeito que um humano resolveu esta conversa?".
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const { normalizeText } = require("./bot-simulator-service");
const { similarity } = require("./ai/local-fallback-provider");
const { sanitizeForLearning } = require("./bot-learning-sanitizer");
const { getGlobalSettings, resolveFeatureFlags } = require("./bot-governance-service");
const { addExampleToGlobalIntent } = require("./global-intent-service");
const {
  DEFAULT_HIGH_CONFIDENCE_THRESHOLD, LEARNING_MESSAGE_LIMIT, LEARNING_SIMILARITY_CONTENT_THRESHOLD,
  LEARNING_SIMILARITY_TOPIC_THRESHOLD, RESOLUTION_NEGATIVE_PATTERNS, RESOLUTION_POSITIVE_PATTERNS,
} = require("./bot-constants");

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function assertBotManager(viewer) {
  if (!authorization.isMaster(viewer)) {
    throw authorization.forbidden("Somente uma conta Master pode gerenciar o aprendizado dos Bots.");
  }
}

function titleFromText(text) {
  const words = text.split(" ").filter(Boolean).slice(0, 8).join(" ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Sugestão de aprendizado";
}

// Só considera as últimas mensagens do cliente: um "funcionou" no meio da
// conversa não deve contar mais que a palavra final dele.
function detectResolutionSignal(messages) {
  const customerTail = messages.filter((item) => item.direction === "RECEBIDA").slice(-3).reverse();
  for (const item of customerTail) {
    const normalized = normalizeText(item.text);
    if (RESOLUTION_NEGATIVE_PATTERNS.some((pattern) => pattern.test(normalized))) return "NEGATIVE";
    if (RESOLUTION_POSITIVE_PATTERNS.some((pattern) => pattern.test(normalized))) return "POSITIVE";
  }
  return null;
}

// Agrupa com uma sugestão PENDING parecida (mesmo tipo/bot/intenção) em vez
// de criar duplicata a cada conversa semelhante — isso é o sourceCount.
async function upsertSuggestion(client, { botId, intentId, type, title, suggestedContent, conversationId, confidence, metadata }) {
  const candidates = await client.botLearningSuggestion.findMany({
    where: { type, status: "PENDING", botId: botId ?? null, intentId: intentId ?? null },
    take: 50,
  });
  const normalizedCandidate = normalizeText(suggestedContent);
  let match = null;
  for (const candidate of candidates) {
    const score = similarity(normalizedCandidate, normalizeText(candidate.suggestedContent));
    if (score >= LEARNING_SIMILARITY_CONTENT_THRESHOLD && (!match || score > match.score)) match = { candidate, score };
  }
  if (match) {
    return client.botLearningSuggestion.update({
      where: { id: match.candidate.id },
      data: {
        sourceCount: { increment: 1 },
        confidence: Math.max(match.candidate.confidence || 0, confidence || 0) || null,
      },
    });
  }
  return client.botLearningSuggestion.create({
    data: {
      botId: botId ?? null, intentId: intentId ?? null, conversationId, type, title,
      suggestedContent, confidence: confidence ?? null, sourceCount: 1, metadata: metadata || undefined,
    },
  });
}

// RESPONSE agrupa por TÓPICO (o problema do cliente), não pela solução em
// si — soluções divergentes para o mesmo tópico viram CONFLITO em vez de
// serem aprendidas silenciosamente como se fossem a mesma coisa.
async function upsertResponseSuggestion(client, { botId, topic, content, conversationId }) {
  const candidates = await client.botLearningSuggestion.findMany({
    where: { type: "RESPONSE", status: "PENDING", botId: botId ?? null },
    take: 100,
  });
  const normalizedTopic = normalizeText(topic);
  let topicMatch = null;
  for (const candidate of candidates) {
    const candidateTopic = candidate.metadata?.topic;
    if (!candidateTopic) continue;
    const score = similarity(normalizedTopic, normalizeText(candidateTopic));
    if (score >= LEARNING_SIMILARITY_TOPIC_THRESHOLD && (!topicMatch || score > topicMatch.score)) topicMatch = { candidate, score };
  }
  if (!topicMatch) {
    return client.botLearningSuggestion.create({
      data: {
        botId: botId ?? null, conversationId, type: "RESPONSE", title: titleFromText(topic),
        suggestedContent: content, sourceCount: 1, metadata: { topic },
      },
    });
  }
  const contentScore = similarity(normalizeText(content), normalizeText(topicMatch.candidate.suggestedContent));
  if (contentScore >= LEARNING_SIMILARITY_CONTENT_THRESHOLD) {
    return client.botLearningSuggestion.update({
      where: { id: topicMatch.candidate.id },
      data: { sourceCount: { increment: 1 } },
    });
  }
  await client.botLearningSuggestion.update({
    where: { id: topicMatch.candidate.id },
    data: { metadata: { ...(topicMatch.candidate.metadata || {}), conflict: true } },
  });
  return client.botLearningSuggestion.create({
    data: {
      botId: botId ?? null, conversationId, type: "RESPONSE", title: titleFromText(topic),
      suggestedContent: content, sourceCount: 1, metadata: { topic, conflict: true },
    },
  });
}

// Item 1 desta fase (aprendizado real): a resposta de um atendente que
// resolveu bem o caso e não corresponde a NENHUMA Resposta Rápida ativa —
// sugere cadastrar uma nova (tipo QUICK_REPLY), sempre PENDING/revisão
// humana. Nunca cria a Resposta Rápida sozinho.
async function suggestQuickReplyIfNew(client, { botId, content, conversationId }) {
  const existing = await client.quickReply.findMany({ where: { active: true }, select: { text: true }, take: 500 });
  const normalizedContent = normalizeText(content);
  const alreadyCovered = existing.some((quickReply) => (
    similarity(normalizedContent, normalizeText(quickReply.text)) >= LEARNING_SIMILARITY_CONTENT_THRESHOLD
  ));
  if (alreadyCovered) return null;
  return upsertSuggestion(client, {
    botId, intentId: null, type: "QUICK_REPLY", title: titleFromText(content),
    suggestedContent: content, conversationId, confidence: null,
  });
}

// Item 16 (Aprendizado x Flow Engine): resultado ESTRUTURAL do fluxo
// (ConversationBotState.flowResolutionStatus), mais preciso que o sinal de
// texto (detectResolutionSignal) para conversas conduzidas por etapas.
// RESOLVED sugere "solução recorrente" (type KNOWLEDGE); HANDED_OFF sugere
// revisão manual do fluxo/conhecimento (type FLOW_REVIEW). Nunca altera o
// fluxo/conhecimento sozinho — sempre PENDING até um Master aprovar
// (approveSuggestion/rejectSuggestion), mesma exigência do restante deste
// módulo.
async function analyzeFlowOutcome(client, { conversationId }) {
  const botState = await client.conversationBotState.findUnique({
    where: { conversationId },
    select: {
      activeBotId: true, activeFlowIntentId: true, flowResolutionStatus: true,
      flowAttemptedSolutions: true, flowFailedSteps: true,
    },
  });
  if (!botState?.activeFlowIntentId || !["RESOLVED", "HANDED_OFF"].includes(botState.flowResolutionStatus)) return null;

  const bot = botState.activeBotId ? await client.bot.findUnique({ where: { id: botState.activeBotId }, select: { featureFlags: true } }) : null;
  if (bot && !resolveFeatureFlags(bot).learningEnabled) return null;

  const intent = await client.botIntent.findUnique({ where: { id: botState.activeFlowIntentId }, select: { name: true } });
  const intentName = intent?.name || "intenção";
  const attempted = Array.isArray(botState.flowAttemptedSolutions) ? botState.flowAttemptedSolutions : [];

  if (botState.flowResolutionStatus === "RESOLVED") {
    const lastSuccess = [...attempted].reverse().find((item) => item.outcome === "SUCCESS");
    const summary = lastSuccess?.knowledgeSourceTitle || lastSuccess?.name || intentName;
    const content = sanitizeForLearning(`Fluxo "${intentName}" resolvido com sucesso pela etapa "${summary}".`);
    if (!content) return null;
    return upsertSuggestion(client, {
      botId: botState.activeBotId, intentId: botState.activeFlowIntentId, type: "KNOWLEDGE",
      title: `Solução recorrente: ${intentName}`, suggestedContent: content, conversationId,
      confidence: null, metadata: { source: "FLOW_RESOLVED" },
    });
  }

  const failedNames = attempted.filter((item) => item.outcome === "FAILURE").map((item) => item.name);
  const content = sanitizeForLearning(
    `Fluxo "${intentName}" não resolveu automaticamente e foi encaminhado para atendimento humano. `
    + `Etapas que falharam: ${failedNames.length ? failedNames.join(", ") : "não identificadas"}.`,
  );
  if (!content) return null;
  return upsertSuggestion(client, {
    botId: botState.activeBotId, intentId: botState.activeFlowIntentId, type: "FLOW_REVIEW",
    title: `Revisar fluxo: ${intentName}`, suggestedContent: content, conversationId,
    confidence: null, metadata: { source: "FLOW_HANDED_OFF" },
  });
}

// Analisa UMA conversa já finalizada e gera no máximo algumas sugestões.
// Nunca lança: qualquer falha vira { analyzed: false, reason: "ERROR" }, e
// nunca escreve nada em Conversation/Message — só em tabelas próprias de
// aprendizado.
async function analyzeConversation(conversationId, { force = false, client = prisma } = {}) {
  try {
    const globalSettings = await getGlobalSettings(client);
    if (!globalSettings.learningEnabled) return { analyzed: false, reason: "LEARNING_DISABLED_GLOBALLY" };

    const conversation = await client.conversation.findUnique({
      where: { id: conversationId },
      include: {
        learningState: true,
        _count: { select: { messages: { where: { type: "text" } } } },
        messages: {
          where: { type: "text" },
          orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
          take: LEARNING_MESSAGE_LIMIT,
          select: { id: true, direction: true, text: true, sentByUserId: true },
        },
      },
    });
    if (!conversation) return { analyzed: false, reason: "CONVERSATION_NOT_FOUND" };
    if (conversation.status !== "FINALIZADO") return { analyzed: false, reason: "CONVERSATION_NOT_FINALIZED" };

    const messages = [...conversation.messages].reverse();
    const messageCount = conversation._count.messages;
    if (!messages.length) return { analyzed: false, reason: "NO_TEXT_MESSAGES" };
    if (!force && conversation.learningState?.messageCountAtAnalysis === messageCount) {
      return { analyzed: false, reason: "ALREADY_ANALYZED" };
    }

    const firstCustomerMessage = messages.find((item) => item.direction === "RECEBIDA");
    const resolutionSignal = detectResolutionSignal(messages);
    const suggestions = [];

    if (firstCustomerMessage && resolutionSignal === "POSITIVE") {
      const observation = await client.botObservation.findFirst({
        where: { messageId: firstCustomerMessage.id }, include: { bot: { select: { featureFlags: true } } },
      });
      const botLearningEnabled = !observation?.bot || resolveFeatureFlags(observation.bot).learningEnabled;
      const needsExample = botLearningEnabled && (!observation || observation.confidence == null || observation.confidence < DEFAULT_HIGH_CONFIDENCE_THRESHOLD);
      const sanitizedExample = sanitizeForLearning(firstCustomerMessage.text);
      if (needsExample && sanitizedExample) {
        const botId = observation?.botId || null;
        if (observation?.intentId) {
          const existingExamples = await client.botIntentExample.findMany({
            where: { intentId: observation.intentId }, select: { text: true },
          });
          const normalizedCandidate = normalizeText(sanitizedExample);
          const isDuplicate = existingExamples.some((example) => normalizeText(example.text) === normalizedCandidate);
          if (!isDuplicate) {
            suggestions.push(await upsertSuggestion(client, {
              botId, intentId: observation.intentId, type: "INTENT_EXAMPLE",
              title: `Novo exemplo para "${observation.intentName || "intenção"}"`,
              suggestedContent: sanitizedExample, conversationId, confidence: observation.confidence,
            }));
          }
        } else {
          suggestions.push(await upsertSuggestion(client, {
            botId, intentId: null, type: "NEW_INTENT", title: titleFromText(sanitizedExample),
            suggestedContent: sanitizedExample, conversationId, confidence: observation?.confidence ?? null,
          }));
        }
      }

      const lastAgentMessage = [...messages].reverse()
        .find((item) => item.direction === "ENVIADA" && item.sentByUserId && (item.text || "").trim().length > 15);
      const sanitizedSolution = lastAgentMessage ? sanitizeForLearning(lastAgentMessage.text) : null;
      if (botLearningEnabled && sanitizedSolution && sanitizedExample) {
        suggestions.push(await upsertResponseSuggestion(client, {
          botId: observation?.botId || null, topic: sanitizedExample, content: sanitizedSolution, conversationId,
        }));
        const quickReplySuggestion = await suggestQuickReplyIfNew(client, {
          botId: observation?.botId || null, content: sanitizedSolution, conversationId,
        });
        if (quickReplySuggestion) suggestions.push(quickReplySuggestion);
      }
    }

    const flowSuggestion = await analyzeFlowOutcome(client, { conversationId });
    if (flowSuggestion) suggestions.push(flowSuggestion);

    await client.conversationLearningState.upsert({
      where: { conversationId },
      create: { conversationId, lastAnalyzedAt: new Date(), messageCountAtAnalysis: messageCount, suggestionCount: suggestions.length },
      update: { lastAnalyzedAt: new Date(), messageCountAtAnalysis: messageCount, suggestionCount: { increment: suggestions.length } },
    });

    return { analyzed: true, resolutionSignal, suggestionsGenerated: suggestions.length };
  } catch (error) {
    console.error("[BOT_LEARNING] falha ao analisar conversa (ignorada)", error.message);
    return { analyzed: false, reason: "ERROR" };
  }
}

async function analyzeConversationManually(conversationId, viewer) {
  assertBotManager(viewer);
  return analyzeConversation(conversationId);
}

async function listSuggestions(filters, viewer) {
  assertBotManager(viewer);
  const where = {};
  if (filters.status) where.status = filters.status;
  if (filters.type) where.type = filters.type;
  if (filters.botId) where.botId = filters.botId;
  const take = filters.limit === undefined || filters.limit === "" ? 50 : Number(filters.limit);
  if (!Number.isInteger(take) || take < 1 || take > 200) throw fail("O limite deve ser um inteiro entre 1 e 200.");
  return prisma.botLearningSuggestion.findMany({
    where,
    include: {
      bot: { select: { id: true, name: true } },
      intent: { select: { id: true, name: true } },
    },
    orderBy: [{ status: "asc" }, { sourceCount: "desc" }, { createdAt: "desc" }],
    take,
  });
}

async function learningMetrics(viewer) {
  assertBotManager(viewer);
  const grouped = await prisma.botLearningSuggestion.groupBy({ by: ["status", "type"], _count: { _all: true } });
  const metrics = { pending: 0, approved: 0, rejected: 0, edited: 0, byType: {} };
  for (const row of grouped) {
    const key = row.status.toLowerCase();
    if (metrics[key] !== undefined) metrics[key] += row._count._all;
    metrics.byType[row.type] = (metrics.byType[row.type] || 0) + row._count._all;
  }
  return metrics;
}

async function ensureSuggestion(suggestionId) {
  const suggestion = await prisma.botLearningSuggestion.findUnique({ where: { id: suggestionId } });
  if (!suggestion) throw fail("Sugestão não encontrada.", 404);
  return suggestion;
}

async function editSuggestion(suggestionId, data, actor) {
  assertBotManager(actor);
  const suggestion = await ensureSuggestion(suggestionId);
  if (!["PENDING", "EDITED"].includes(suggestion.status)) throw fail("Só é possível editar sugestões pendentes.");
  const update = {};
  if (data.title !== undefined) update.title = String(data.title).trim().slice(0, 200) || suggestion.title;
  if (data.suggestedContent !== undefined) {
    const text = sanitizeForLearning(data.suggestedContent);
    if (!text) throw fail("O conteúdo da sugestão não pode ficar vazio após remover dados pessoais.");
    update.suggestedContent = text;
  }
  update.status = "EDITED";
  return prisma.botLearningSuggestion.update({ where: { id: suggestionId }, data: update });
}

// Aprovar uma INTENT_EXAMPLE é a única aprovação que já escreve
// conhecimento ativo (o exemplo na intenção). NEW_INTENT/RESPONSE/
// KNOWLEDGE/CLARIFICATION/ENTITY_PATTERN só marcam APPROVED — a criação
// real (nova intenção, futura base de conhecimento) continua manual, pelo
// formulário normal, pré-preenchido a partir da sugestão aprovada.
async function approveSuggestion(suggestionId, data, actor) {
  assertBotManager(actor);
  const suggestion = await ensureSuggestion(suggestionId);
  if (!["PENDING", "EDITED"].includes(suggestion.status)) throw fail("Esta sugestão já foi revisada.");
  const intentId = data?.intentId || suggestion.intentId;
  const suggestedContent = suggestion.suggestedContent;

  if (suggestion.type === "INTENT_EXAMPLE") {
    if (!intentId) throw fail("Selecione a intenção que deve receber este exemplo.");
    const intent = await prisma.botIntent.findFirst({
      where: { id: intentId, ...(suggestion.botId ? { botId: suggestion.botId } : {}) },
    });
    if (!intent) throw fail("Intenção não encontrada para este Bot.", 404);
    return prisma.$transaction(async (transaction) => {
      // Item 1 (aprendizado supervisionado): se esta BotIntent é uma
      // associação da Biblioteca Global, o exemplo aprovado melhora a
      // GlobalIntent e se propaga (deduplicado) para TODOS os Bots
      // associados a ela — não só para este Bot.
      if (intent.globalIntentId) {
        await addExampleToGlobalIntent(intent.globalIntentId, suggestedContent, transaction);
      } else {
        const existingExamples = await transaction.botIntentExample.findMany({ where: { intentId }, select: { text: true } });
        const normalizedCandidate = normalizeText(suggestedContent);
        const isDuplicate = existingExamples.some((example) => normalizeText(example.text) === normalizedCandidate);
        if (!isDuplicate) {
          await transaction.botIntentExample.create({ data: { intentId, text: suggestedContent } });
        }
      }
      return transaction.botLearningSuggestion.update({
        where: { id: suggestionId },
        data: { status: "APPROVED", intentId, reviewedAt: new Date(), reviewedByUserId: actor.id },
      });
    });
  }

  return prisma.botLearningSuggestion.update({
    where: { id: suggestionId },
    data: { status: "APPROVED", reviewedAt: new Date(), reviewedByUserId: actor.id },
  });
}

async function rejectSuggestion(suggestionId, actor) {
  assertBotManager(actor);
  const suggestion = await ensureSuggestion(suggestionId);
  if (!["PENDING", "EDITED"].includes(suggestion.status)) throw fail("Esta sugestão já foi revisada.");
  return prisma.botLearningSuggestion.update({
    where: { id: suggestionId },
    data: { status: "REJECTED", reviewedAt: new Date(), reviewedByUserId: actor.id },
  });
}

// Atalho da tela de Observações: "marcar incorreta + indicar intenção
// correta" vira uma sugestão de exemplo, reaproveitando o mesmo caminho de
// agrupamento/duplicidade usado pela análise de conversas.
async function createSuggestionFromObservationFeedback({ observationMessageText, botId, intentId, conversationId }, client = prisma) {
  const sanitized = sanitizeForLearning(observationMessageText);
  if (!sanitized || !intentId) return null;
  const existingExamples = await client.botIntentExample.findMany({ where: { intentId }, select: { text: true } });
  const normalizedCandidate = normalizeText(sanitized);
  if (existingExamples.some((example) => normalizeText(example.text) === normalizedCandidate)) return null;
  const intent = await client.botIntent.findUnique({ where: { id: intentId }, select: { name: true } });
  return upsertSuggestion(client, {
    botId, intentId, type: "INTENT_EXAMPLE",
    title: `Novo exemplo para "${intent?.name || "intenção"}" (feedback de observação)`,
    suggestedContent: sanitized, conversationId, confidence: null, metadata: { source: "OBSERVATION_FEEDBACK" },
  });
}

module.exports = {
  analyzeConversation,
  analyzeConversationManually,
  approveSuggestion,
  createSuggestionFromObservationFeedback,
  detectResolutionSignal,
  editSuggestion,
  learningMetrics,
  listSuggestions,
  rejectSuggestion,
};
