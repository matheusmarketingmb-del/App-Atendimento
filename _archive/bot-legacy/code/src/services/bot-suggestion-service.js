// Item 7/8 (sugestão de resposta para o atendente + feedback 👍/👎): reaproveita
// o resultado que o motor de interpretação JÁ calcula para toda mensagem real
// (bot-orchestrator-service.js/bot-observation-service.js) — nunca roda uma
// segunda interpretação nem chama o Bot de novo. Só expõe o que já foi
// registrado em BotObservation.suggestedResponseText para o atendente decidir
// [Usar]/[Editar]/[Ignorar] — nunca enviado sozinho.
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const { resolveFeatureFlags } = require("./bot-governance-service");

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Só devolve sugestão para a mensagem MAIS RECENTE da conversa. Se o
// atendente já respondeu ou chegou outra mensagem sem sugestão, a anterior
// não pode reaparecer como se ainda estivesse pendente.
async function getLatestSuggestion(conversationId, viewer, client = prisma) {
  await authorization.assertCanViewConversation(viewer, conversationId);
  const [latestMessage, suggestion] = await Promise.all([
    client.message.findFirst({
      where: { conversationId }, orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }], select: { id: true },
    }),
    client.botObservation.findFirst({
      where: { conversationId, suggestedResponseText: { not: null } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, messageId: true, botId: true, intentId: true, intentName: true,
        knowledgeSourceId: true, knowledgeSourceTitle: true, toolName: true, suggestedResponseText: true,
        topicSwitchDetected: true, confidence: true, provider: true, createdAt: true,
        bot: { select: { featureFlags: true } },
      },
    }),
  ]);
  if (latestMessage?.id !== suggestion?.messageId || !suggestion?.bot) return null;
  if (!resolveFeatureFlags(suggestion.bot).agentSuggestionsEnabled) return null;
  const { bot: _bot, ...visibleSuggestion } = suggestion;
  return visibleSuggestion;
}

const SUGGESTION_ACTIONS = new Set(["USED", "EDITED", "IGNORED"]);

// Item 7/8: uma linha por atendente+sugestão — reenviar feedback/ação para a
// mesma observação atualiza (nunca duplica), permitindo o atendente corrigir
// o próprio voto. `helpful` (👍/👎) e `action` (o que fez com a sugestão na
// UI) são independentes; pelo menos um dos dois precisa vir preenchido.
async function recordSuggestionFeedback({ observationId, helpful, action, finalResponseText }, actor, client = prisma) {
  if (typeof helpful !== "boolean" && !SUGGESTION_ACTIONS.has(action)) {
    throw fail("Informe o feedback (👍/👎) ou a ação (usar/editar/ignorar) sobre a sugestão.");
  }
  const observation = await client.botObservation.findUnique({
    where: { id: observationId }, select: { id: true, botId: true, conversationId: true, suggestedResponseText: true },
  });
  if (!observation) throw fail("Sugestão não encontrada.", 404);
  if (!observation.suggestedResponseText) throw fail("Esta observação não tem uma sugestão de resposta associada.");
  await authorization.assertCanViewConversation(actor, observation.conversationId);

  const hasFinalText = typeof finalResponseText === "string";
  const finalText = hasFinalText ? finalResponseText.trim().slice(0, 4000) || null : null;
  const data = {
    ...(typeof helpful === "boolean" ? { helpful } : {}),
    ...(SUGGESTION_ACTIONS.has(action) ? { action } : {}),
    ...(hasFinalText ? { finalResponseText: finalText } : {}),
  };

  return client.botSuggestionFeedback.upsert({
    where: { observationId_userId: { observationId, userId: actor.id } },
    create: {
      observationId, botId: observation.botId, conversationId: observation.conversationId,
      userId: actor.id, ...data,
    },
    update: data,
  });
}

// Item 11/12: contagem simples de feedback positivo/negativo e de
// usado/editado/ignorado por Bot — usada nas métricas de qualidade
// (bot-quality-service.js), sem dashboard pesado.
async function suggestionFeedbackSummary(botId, client = prisma) {
  const [feedbackGrouped, actionGrouped] = await Promise.all([
    client.botSuggestionFeedback.groupBy({ by: ["helpful"], where: { botId, helpful: { not: null } }, _count: { _all: true } }),
    client.botSuggestionFeedback.groupBy({ by: ["action"], where: { botId, action: { not: null } }, _count: { _all: true } }),
  ]);
  const positive = feedbackGrouped.find((row) => row.helpful === true)?._count._all || 0;
  const negative = feedbackGrouped.find((row) => row.helpful === false)?._count._all || 0;
  const used = actionGrouped.find((row) => row.action === "USED")?._count._all || 0;
  const edited = actionGrouped.find((row) => row.action === "EDITED")?._count._all || 0;
  const ignored = actionGrouped.find((row) => row.action === "IGNORED")?._count._all || 0;
  return { positive, negative, used, edited, ignored };
}

module.exports = { getLatestSuggestion, recordSuggestionFeedback, suggestionFeedbackSummary };
