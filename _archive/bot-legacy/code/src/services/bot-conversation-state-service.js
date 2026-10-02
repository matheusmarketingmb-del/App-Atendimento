// Estado operacional do Bot dentro de uma conversa real (ConversationBotState).
// Reaproveitado pelo orquestrador; o simulador NÃO usa esta tabela — ele
// mantém um estado temporário só na memória da sessão de simulação.
const prisma = require("../database/prisma");
const { CONTEXT_MESSAGE_LIMIT } = require("./bot-constants");

async function getState(conversationId, client = prisma) {
  return client.conversationBotState.findUnique({ where: { conversationId } });
}

// `operational` carrega os campos de governança calculados pelo orquestrador
// (apresentação, loop guard, janela de troca de Bot) — mantidos aqui como um
// objeto à parte para não inflar a assinatura desta função a cada novo
// controle adicionado.
// `flow` (bot-flow-service.js) só vem preenchido em turnos conduzidos pelo
// Flow Engine — quando ausente, os campos flow* de ConversationBotState
// simplesmente não são tocados neste upsert (nem apagados, nem herdados
// incorretamente: um fluxo só é iniciado/continuado explicitamente).
// Item 6 (contexto de produto): mescla entidades novas por cima das já
// conhecidas da conversa inteira — nunca sobrescreve um valor já capturado
// com `null`/vazio, e uma entidade nova sempre pode atualizar uma antiga
// (ex.: cliente troca de produto no meio da conversa).
function mergeContextEntities(existing, incoming) {
  const merged = { ...(existing || {}) };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value === undefined || value === null || value === "") continue;
    merged[key] = value;
  }
  return merged;
}

// `flowStack` (item 5, opcional): quando informado (mesmo `[]`), sobrescreve
// a pilha de fluxos pausados — undefined = não mexer na pilha atual.
async function persistDecision({
  conversationId, bot, interpretation, decision, operational = {}, flow = null, contextEntities = undefined,
  flowStack = undefined, caseState = undefined,
}, client = prisma) {
  const failedInterpretations = decision.action === "ASK_CLARIFICATION" || decision.action === "HANDOFF_HUMAN"
    ? (decision.failureCount ?? 0)
    : 0;
  const shared = {
    activeBotId: bot.id,
    lastIntentId: interpretation.intentId || null,
    lastConfidence: interpretation.confidence ?? null,
    failedInterpretations,
    pendingClarification: decision.needsClarification || false,
    extractedEntities: interpretation.entities || {},
    // Item 1 (estado da conversa): última ação decidida pelo motor, dentro
    // ou fora de um fluxo — só auditoria/depuração, nunca decide nada sozinha.
    lastBotAction: decision.action || null,
    ...operational,
    ...(contextEntities !== undefined ? { contextEntities } : {}),
    ...(flowStack !== undefined ? { flowStack } : {}),
    ...(caseState !== undefined ? { caseState } : {}),
    ...(flow ? {
      activeFlowIntentId: flow.intentId,
      currentFlowStepId: flow.currentStepId,
      flowCollectedEntities: flow.collectedEntities,
      flowAskedQuestions: flow.askedQuestions,
      flowAttemptedSolutions: flow.attemptedSolutions,
      flowFailedSteps: flow.failedSteps,
      flowStepAttempts: flow.stepAttempts,
      flowResolutionStatus: flow.resolutionStatus,
      pendingQuestion: flow.pendingQuestion ?? null,
    } : {}),
  };
  return client.conversationBotState.upsert({
    where: { conversationId },
    create: { conversationId, ...shared },
    update: shared,
  });
}

// Retorna as últimas mensagens (mais antiga primeiro), limitadas a uma
// quantidade fixa para não crescer indefinidamente com o histórico completo.
async function getRecentContext(conversationId, { limit = CONTEXT_MESSAGE_LIMIT, beforeMessageId = null } = {}, client = prisma) {
  const rows = await client.message.findMany({
    where: {
      conversationId,
      type: "text",
      ...(beforeMessageId ? { id: { not: beforeMessageId } } : {}),
    },
    orderBy: { occurredAt: "desc" },
    take: limit,
    select: { direction: true, text: true, occurredAt: true },
  });
  return rows.reverse();
}

module.exports = { getRecentContext, getState, mergeContextEntities, persistDecision };
