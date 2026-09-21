// MODO SHADOW: roda a IA local (LOCAL_QWEN) para um Bot com featureFlags.
// useAi=true, em paralelo ao atendimento real, registrando o que ela
// TERIA respondido — nunca envia nada ao cliente. Espelha o espírito de
// bot-observation-service.js (nunca deve derrubar o webhook, nunca decide
// nada sozinho), mas é um caminho independente do interpretador legado:
// enquanto aiMode=PRIMARY, é o RAG SERVER (rag_server.py — busca na
// Knowledge própria dele + Qwen3 14B) quem decide o texto da resposta, não
// interpret()/decide() nem a Knowledge do app (KnowledgeSource). O app não
// monta prompt, não busca Knowledge e não chama o Ollama aqui — só envia a
// mensagem do cliente ao RAG Server e registra o que voltou.
//
// A separação pedida explicitamente pelo usuário é respeitada em toda a
// função: useAi controla só se a IA RODA; autoReplyEnabled (bot-ai-gate-
// service.js) controla só se ela PODERIA enviar — aqui ela nunca envia,
// mesmo quando autoReplyEligible sai `true`.
const prisma = require("../database/prisma");
const { resolveBot } = require("./bot-orchestrator-service");
const { resolveFeatureFlags, getGlobalSettings } = require("./bot-governance-service");
const { getRecentContext } = require("./bot-conversation-state-service");
const { resolveLocalQwenInstance } = require("./ai/get-ai-provider");
const { getState: getLocalAiState } = require("./local-ai-status-service");
const { resolveAutoReplyEligibility, resolveSendDecision } = require("./bot-ai-gate-service");
const { normalizePlannerOutput } = require("./ai/planner-output-guard");
const { computePlannerHint } = require("./ai/planner-hint-service");
const { simulateSend } = require("./ai/dry-run-sender");

// Proxy numérico só para a coluna `confidence` (Float) existente do log —
// a banda literal (HIGH/MEDIUM/LOW) que o Planner realmente decide vai em
// `missingInformation.confidenceBand` (ver persistLog abaixo), nunca perdida.
const CONFIDENCE_SCORE = { HIGH: 0.9, MEDIUM: 0.6, LOW: 0.3 };

async function persistLog(data, client = prisma) {
  try {
    await client.botAiShadowLog.create({ data });
  } catch (error) {
    // Falha ao registrar o shadow log nunca pode propagar — é só auditoria.
    console.error("[BOT_AI_SHADOW] falha ao gravar log (ignorada)", error.message);
  }
}

// Item "preparar ativação controlada": decide se ESTE turno enviaria de
// verdade (gate + resultado do Planner já normalizado) e, só quando a
// decisão for positiva, chama o sender FALSO (dry-run-sender.js — nunca a
// API real do WhatsApp/Meta). autoReplyEnabled continua false em todo Bot
// hoje, então `gate.allowed` já é false na imensa maioria dos casos; isto
// existe para já validar o caminho de decisão sem esperar a ativação real.
function applySendDecision({ gate, plannerResult, conversationId, messageId, botId, contactId }) {
  const decision = resolveSendDecision({ eligibility: gate, plannerResult });
  const simulated = decision.shouldSend
    ? simulateSend({ conversationId, messageId, botId, phone: contactId, text: plannerResult.answer })
    : null;
  return { ...decision, simulated };
}

async function shadowIncomingMessage(event, message, { now = new Date(), channel = "META" } = {}) {
  if (event.type !== "text" || !event.text) return null;

  const conversation = await prisma.conversation.findUnique({
    where: { id: message.conversationId },
    include: { botState: true },
  });
  if (!conversation) return null;

  const bot = await resolveBot(conversation.botState?.activeBotId || null, channel, prisma);
  if (!bot) return null;

  const flags = resolveFeatureFlags(bot);
  if (!flags.useAi || flags.aiMode === "OFF") return null;
  // Modo PRIMARY é o único implementado até aqui — FALLBACK/
  // UNDERSTANDING_ONLY/RESPONSE_ONLY ficam para uma próxima etapa, sem
  // fingir suporte que ainda não existe.
  if (flags.aiMode !== "PRIMARY") return null;
  // Mesmo raciocínio para o provider: só LOCAL_QWEN está implementado. Um
  // Bot que escolher outro valor de aiProvider simplesmente não roda IA
  // ainda — nunca cai silenciosamente em Gemini/OpenAI/Anthropic.
  if (flags.aiProvider !== "LOCAL_QWEN") return null;

  const startedAt = Date.now();
  const localAiStatus = getLocalAiState().status;
  const globalSettings = await getGlobalSettings(prisma);
  const gate = resolveAutoReplyEligibility({
    bot, flags, globalAutomationEnabled: globalSettings.automationEnabled, localAiStatus,
  });

  const baseLog = {
    conversationId: message.conversationId, messageId: message.id, botId: bot.id,
    provider: "LOCAL_QWEN", model: flags.aiModel || null, aiMode: flags.aiMode,
    autoReplyEligible: gate.allowed, autoReplyBlockedReason: gate.allowed ? null : gate.reason,
  };

  // Histórico recente da conversa (mesma fonte/limite do interpretador
  // legado — getRecentContext + flags.contextEnabled/contextMaxMessages,
  // nunca um caminho novo) — usado tanto pelo hint determinístico abaixo
  // quanto, depois, enviado ao RAG Server para ele resolver referência
  // contextual ("qual modelo?" -> "GS Pro 2").
  const context = flags.contextEnabled
    ? await getRecentContext(message.conversationId, { beforeMessageId: message.id, limit: flags.contextMaxMessages }, prisma)
    : [];
  const history = context
    .filter((row) => row.text)
    .map((row) => ({ role: row.direction === "RECEBIDA" ? "customer" : "assistant", content: row.text }));

  // Camada determinística ANTES do RAG/Qwen (planner-hint-service.js):
  // pedido explícito de humano, risco de segurança, confirmação inequívoca
  // de solução e status de pedido sem ferramenta real nunca dependem do
  // LLM — decididos aqui, e funcionam mesmo com o PC/RAG Server offline
  // (atendimento humano preservado mesmo sem IA local disponível).
  const hint = computePlannerHint({ message: event.text, history });
  if (hint.forceAction) {
    const forced = normalizePlannerOutput({
      message: event.text, history, signals: hint.detectedSignals,
      result: {
        answer: hint.forceAnswer, action: hint.forceAction, confidence: "HIGH",
        needsHuman: hint.forceNeedsHuman, reason: hint.forceReason, product: null, intent: null, sources: 0,
      },
    });
    const latencyMs = Date.now() - startedAt;
    const sendDecision = applySendDecision({
      gate, plannerResult: forced, conversationId: message.conversationId, messageId: message.id,
      botId: bot.id, contactId: conversation.contactId,
    });
    await persistLog({
      ...baseLog, status: "OK", latencyMs,
      action: forced.action, intent: forced.intent,
      confidence: CONFIDENCE_SCORE[forced.confidence] ?? null,
      responseText: forced.answer, entities: null, knowledgeUsed: null,
      missingInformation: {
        confidenceBand: forced.confidence, needsHuman: forced.needsHuman, reason: forced.reason,
        plannerNormalized: forced.plannerNormalized, plannerCorrections: forced.plannerCorrections,
        plannerHintApplied: true, forcedAction: hint.forceAction,
        sendDecision: sendDecision.shouldSend ? "SIMULATED_SEND" : "NOT_SENT", sendBlockedReason: sendDecision.reason,
      },
    });
    return {
      action: forced.action, response: forced.answer, product: forced.product, intent: forced.intent,
      confidence: forced.confidence, needsHuman: forced.needsHuman, reason: forced.reason,
      plannerNormalized: forced.plannerNormalized, plannerHintApplied: true, sendDecision,
    };
  }

  // PC/RAG Server desligado ou indisponível -> nunca chama a IA, só registra
  // o motivo. Nunca cai para outro provider (Gemini/OpenAI/Anthropic).
  if (localAiStatus !== "ONLINE") {
    await persistLog({ ...baseLog, status: localAiStatus, errorCode: "PROVIDER_" + localAiStatus, latencyMs: Date.now() - startedAt });
    return null;
  }

  try {
    const { provider, error } = await resolveLocalQwenInstance(flags.aiModel || undefined);
    if (!provider) {
      await persistLog({ ...baseLog, status: "ERROR", errorCode: "PROVIDER_NOT_CONFIGURED", latencyMs: Date.now() - startedAt });
      return null;
    }

    // Busca na Knowledge, prompt e geração já acontecem inteiramente dentro
    // do RAG Server (rag_server.py) — inclusive as regras de "não inventar",
    // "ausência de informação não é evidência negativa" e a decisão de ação
    // do Planner (RESPOND/ASK/CLARIFY/HANDOFF/WAIT/RESOLVE). O app só envia
    // a mensagem crua do cliente + histórico e recebe a resposta já pronta.
    const rawResult = await provider.askRag({ message: event.text, history });
    // Endurece action/confidence/needsHuman/reason DEPOIS do RAG Server —
    // nunca dentro dele (rag/ não é alterado por este caminho). Reaproveita
    // os mesmos sinais do hint (já computado acima) para exigir evidência
    // real de um HANDOFF antes de deixá-lo sobreviver.
    const result = normalizePlannerOutput({ message: event.text, history, signals: hint.detectedSignals, result: rawResult });
    const latencyMs = Date.now() - startedAt;
    const sendDecision = applySendDecision({
      gate, plannerResult: result, conversationId: message.conversationId, messageId: message.id,
      botId: bot.id, contactId: conversation.contactId,
    });

    await persistLog({
      ...baseLog, status: "OK", latencyMs,
      action: result.action,
      intent: result.intent,
      confidence: CONFIDENCE_SCORE[result.confidence] ?? null,
      responseText: result.answer,
      entities: result.product ? { product: result.product } : null,
      knowledgeUsed: Number.isFinite(result.sources) ? { sourcesCount: result.sources } : null,
      // Planner (action/confidence/needsHuman/reason + auditoria da
      // normalização) ainda não tem coluna dedicada — reaproveita
      // `missingInformation` (Json, sem uso neste caminho até aqui) em vez
      // de criar migration, como pedido explicitamente. O nome da coluna
      // não descreve 100% o conteúdo; este comentário evita confusão futura.
      missingInformation: {
        confidenceBand: result.confidence, needsHuman: result.needsHuman, reason: result.reason,
        plannerNormalized: result.plannerNormalized, plannerCorrections: result.plannerCorrections,
        plannerHintApplied: false, originalAction: rawResult.action, finalAction: result.action,
        sendDecision: sendDecision.shouldSend ? "SIMULATED_SEND" : "NOT_SENT", sendBlockedReason: sendDecision.reason,
      },
    });

    return {
      action: result.action, response: result.answer, product: result.product, intent: result.intent,
      confidence: result.confidence, needsHuman: result.needsHuman, reason: result.reason,
      plannerNormalized: result.plannerNormalized, plannerHintApplied: false, sendDecision,
    };
  } catch (error) {
    await persistLog({
      ...baseLog, status: "ERROR", errorCode: error.code || "PROVIDER_REQUEST_FAILED",
      latencyMs: Date.now() - startedAt,
    });
    return null;
  }
}

module.exports = { shadowIncomingMessage };
