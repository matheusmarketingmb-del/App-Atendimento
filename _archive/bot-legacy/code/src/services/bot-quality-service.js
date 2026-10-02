// Itens 11/12 (métricas + alertas de qualidade): agrega sinais que já
// existem em outras tabelas (BotObservation, BotHandoffContext,
// BotSuggestionFeedback, BotRating) — nunca duplica contagem nem inventa
// percentual sem amostra suficiente. Sem dashboard pesado: só números
// simples e um punhado de alertas por limiar configurável.
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const { suggestionFeedbackSummary } = require("./bot-suggestion-service");
const { DEFAULT_LOW_CONFIDENCE_THRESHOLD, MINIMUM_RATINGS_FOR_METRICS_PERCENTAGE } = require("./bot-constants");

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function assertBotManager(viewer) {
  if (!authorization.isMaster(viewer)) {
    throw authorization.forbidden("Somente uma conta Master pode ver métricas de qualidade dos Bots.");
  }
}

// Item 11: visão consolidada por Bot — atendimentos, handoffs, fallback,
// troca de assunto, sugestões (aceitas/editadas/ignoradas), feedback do
// atendente, etapa/conhecimento mais usados nos handoffs registrados.
async function qualityMetrics(botId, viewer) {
  assertBotManager(viewer);
  if (!botId) throw fail("Bot é obrigatório.");
  const bot = await prisma.bot.findFirst({ where: { id: botId, archivedAt: null }, select: { id: true, lowConfidenceThreshold: true } });
  if (!bot) throw fail("Bot não encontrado.", 404);

  const [
    started, resolvedByFlow, handoffs, fallbacks, lowConfidence, topicSwitches,
    handoffSteps, knowledgeUsage, suggestionFeedback,
  ] = await Promise.all([
    prisma.botObservation.count({ where: { botId } }),
    prisma.botObservation.count({ where: { botId, flowResolutionStatus: "RESOLVED" } }),
    prisma.botObservation.count({ where: { botId, action: "HANDOFF_HUMAN" } }),
    prisma.botObservation.count({ where: { botId, intentId: null } }),
    prisma.botObservation.count({ where: { botId, confidence: { lt: bot.lowConfidenceThreshold ?? DEFAULT_LOW_CONFIDENCE_THRESHOLD } } }),
    prisma.botObservation.count({ where: { botId, topicSwitchDetected: true } }),
    prisma.botHandoffContext.groupBy({ by: ["currentStepName"], where: { botId, currentStepName: { not: null } }, _count: { _all: true } }),
    prisma.botObservation.groupBy({ by: ["knowledgeSourceId", "knowledgeSourceTitle"], where: { botId, knowledgeSourceId: { not: null } }, _count: { _all: true } }),
    suggestionFeedbackSummary(botId),
  ]);

  const topFailedStep = handoffSteps.sort((left, right) => right._count._all - left._count._all)[0] || null;
  const topKnowledge = knowledgeUsage.sort((left, right) => right._count._all - left._count._all)[0] || null;

  return {
    botId,
    started, resolvedByFlow, handoffs, fallbacks, lowConfidence, topicSwitches,
    topFailedStep: topFailedStep ? { name: topFailedStep.currentStepName, count: topFailedStep._count._all } : null,
    topKnowledge: topKnowledge
      ? { knowledgeSourceId: topKnowledge.knowledgeSourceId, title: topKnowledge.knowledgeSourceTitle, count: topKnowledge._count._all }
      : null,
    suggestions: suggestionFeedback,
  };
}

// Item 12: alertas simples por limiar — nunca automação destrutiva, só
// sinalização para revisão humana. `sampleMin` evita alertar com amostra
// pequena demais para significar algo.
async function qualityAlerts(botId, viewer, { sampleMin = MINIMUM_RATINGS_FOR_METRICS_PERCENTAGE } = {}) {
  assertBotManager(viewer);
  if (!botId) throw fail("Bot é obrigatório.");
  const metrics = await qualityMetrics(botId, viewer);
  const alerts = [];

  if (metrics.started >= sampleMin) {
    const fallbackRate = metrics.fallbacks / metrics.started;
    if (fallbackRate >= 0.3) {
      alerts.push({ type: "HIGH_FALLBACK", severity: "WARNING", message: `${Math.round(fallbackRate * 100)}% das mensagens não reconheceram nenhuma intenção.` });
    }
    const handoffRate = metrics.handoffs / metrics.started;
    if (handoffRate >= 0.4) {
      alerts.push({ type: "HIGH_HANDOFF", severity: "WARNING", message: `${Math.round(handoffRate * 100)}% dos atendimentos foram encaminhados para humano.` });
    }
  }

  if (metrics.topFailedStep && metrics.topFailedStep.count >= sampleMin) {
    alerts.push({
      type: "STEP_HIGH_FAILURE", severity: "INFO",
      message: `A etapa "${metrics.topFailedStep.name}" apareceu em ${metrics.topFailedStep.count} handoff(s) — vale revisar o fluxo.`,
    });
  }

  if (metrics.suggestions.negative >= sampleMin && metrics.suggestions.negative > metrics.suggestions.positive) {
    alerts.push({
      type: "SUGGESTIONS_POOR_FEEDBACK", severity: "WARNING",
      message: `Atendentes marcaram ${metrics.suggestions.negative} sugestão(ões) como não úteis (mais que as ${metrics.suggestions.positive} úteis).`,
    });
  }

  const ratingTrend = await prisma.botRating.findMany({
    where: { botId }, orderBy: { createdAt: "desc" }, take: sampleMin * 2, select: { score: true },
  });
  if (ratingTrend.length >= sampleMin * 2) {
    const recent = ratingTrend.slice(0, sampleMin);
    const older = ratingTrend.slice(sampleMin, sampleMin * 2);
    const avg = (rows) => rows.reduce((acc, row) => acc + row.score, 0) / rows.length;
    const recentAvg = avg(recent);
    const olderAvg = avg(older);
    if (olderAvg - recentAvg >= 0.5) {
      alerts.push({
        type: "RATING_DROP", severity: "WARNING",
        message: `A avaliação média caiu de ${olderAvg.toFixed(2)} para ${recentAvg.toFixed(2)} nas últimas ${sampleMin} avaliações.`,
      });
    }
  }

  return { botId, alerts };
}

module.exports = { qualityMetrics, qualityAlerts };
