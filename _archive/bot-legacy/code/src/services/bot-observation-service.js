const prisma = require("../database/prisma");
const { orchestrate } = require("./bot-orchestrator-service");
const { suggestQuickReplyForIntent } = require("./quick-reply-service");

// Nunca pode derrubar a observação: se a Resposta Rápida sugerida falhar ao
// ser resolvida, a observação continua normalmente sem a sugestão (item 33).
async function suggestQuickReplySafely(intentId) {
  if (!intentId) return null;
  try { return await suggestQuickReplyForIntent(intentId); }
  catch (_error) { return null; }
}

// Roda o motor de interpretação (orquestrador -> interpretador -> decisão)
// do Bot ativo do canal em paralelo à triagem real, apenas para
// log/comparação. Nunca envia mensagem, nunca altera Conversation/Message,
// nunca chama uma tool externa e nunca pode derrubar o processamento real
// do webhook. Evolução do observador da Fase 2 (mesma responsabilidade,
// agora orientada pelo motor de interpretação em vez de match literal puro).
async function observeIncomingMessage(event, message, { now = new Date(), channel = "META" } = {}) {
  try {
    if (event.type !== "text" || !event.text) return null;

    const result = await orchestrate({
      conversationId: message.conversationId,
      messageId: message.id,
      channel,
      message: event.text,
      now,
      executionMode: "OBSERVATION",
    });
    if (!result) return null;
    // Toggle global + por Bot ("Observação"). Interpretar continua rodando
    // (é o que garante o estado da conversa/proteções ficarem corretos), só
    // o registro/log é que fica condicionado ao toggle.
    if (!result.observationAllowed) return result;

    console.log("[BOT_OBSERVATION]", JSON.stringify({
      conversationId: message.conversationId,
      botId: result.botId,
      botName: result.botName,
      switchedFromBotId: result.switchedFromBotId,
      withinHours: result.withinHours,
      intent: result.intentName,
      socialBehavior: result.socialBehavior,
      confidence: result.confidence,
      action: result.action,
      category: result.categoryName,
      provider: result.provider,
      status: result.status,
      toolName: result.toolName || null,
      knowledgeSourceId: result.knowledgeSourceId || null,
      calledExternalAi: Boolean(result.calledExternalAi),
      externalProvider: result.externalProvider || null,
      externalAccepted: Boolean(result.externalAccepted),
      externalStatus: result.externalStatus || null,
      externalErrorCode: result.externalErrorCode || null,
      flowResolutionStatus: result.flowResolutionStatus || null,
    }));

    const suggestionsAllowed = result.agentSuggestionsAllowed !== false;
    const suggestedQuickReply = suggestionsAllowed ? await suggestQuickReplySafely(result.intentId) : null;

    await prisma.botObservation.create({
      data: {
        conversationId: message.conversationId,
        messageId: message.id,
        botId: result.botId,
        botName: result.botName,
        channel: "META",
        withinHours: result.withinHours ?? true,
        intentId: result.intentId,
        intentName: result.intentName,
        socialBehavior: result.socialBehavior,
        matchedExample: result.matchedExample,
        categoryId: result.categoryId,
        categoryName: result.categoryName,
        fallbackAction: null,
        confidence: result.confidence,
        action: result.action,
        extractedEntities: result.extractedEntities || {},
        toolName: result.toolName || null,
        knowledgeSourceId: result.knowledgeSourceId || null,
        knowledgeSourceTitle: result.knowledgeSourceTitle || null,
        calledExternalAi: Boolean(result.calledExternalAi),
        flowStepId: result.flowStepId || null,
        flowResolutionStatus: result.flowResolutionStatus || null,
        // Item 7 (sugestão para o atendente): o texto que o motor calcularia
        // para esta mensagem — nunca enviado automaticamente, só fica
        // disponível para o atendente usar quando já assumiu a conversa
        // (bot-suggestion-service.js). Item 4: se esta mensagem trocou de
        // assunto no meio de um fluxo em andamento.
        suggestedResponseText: suggestionsAllowed ? (result.suggestedResponseText || null) : null,
        topicSwitchDetected: Boolean(result.topicSwitchDetected),
        provider: result.provider,
        mode: "OBSERVATION",
        status: result.status,
        errorCode: result.errorCode,
        suggestedQuickReplyId: suggestedQuickReply?.id || null,
        suggestedQuickReplyName: suggestedQuickReply?.name || null,
      },
    });

    return result;
  } catch (error) {
    console.error("[BOT_OBSERVATION] falha ao interpretar (ignorada)", error.message);
    try {
      await prisma.botObservation.create({
        data: {
          conversationId: message.conversationId,
          messageId: message.id,
          botName: "Erro na observação",
          channel: "META",
          withinHours: true,
          mode: "OBSERVATION",
          status: "ERROR",
          errorCode: error.code || "OBSERVATION_FAILED",
        },
      });
    } catch (_persistError) {
      // Se nem o registro de erro puder ser gravado, apenas seguimos: o
      // webhook nunca pode ser afetado pelo modo observação.
    }
    return null;
  }
}

module.exports = { observeIncomingMessage };
