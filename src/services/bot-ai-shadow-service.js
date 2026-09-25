// MODO SHADOW: roda a IA local (LOCAL_QWEN) para um Bot com featureFlags.
// useAi=true, em paralelo ao atendimento real, registrando o que ela
// TERIA respondido — nunca envia nada ao cliente de verdade (sendMode
// atual é sempre DRY_RUN — ver send-mode-service.js; LIVE está bloqueado
// estruturalmente, não só por configuração). Espelha o espírito de
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
// service.js) controla só se ela PODERIA enviar; sendMode (send-mode-
// service.js) controla se um envio aprovado sai por um sender de verdade
// ou pelo dry-run — hoje sempre dry-run, em qualquer combinação dos outros dois.
//
// runShadowPipeline() é o núcleo puro (sem persistência) reaproveitado por
// dois chamadores: shadowIncomingMessage() (mensagem real do webhook, grava
// BotAiShadowLog) e previewShadowReply() (simulador do painel, nunca grava
// nada — mesma lógica, exatamente os mesmos gates, nunca duplicada).
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
const { getSendMode, resolveSender } = require("./ai/send-mode-service");

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

// Decide se ESTE turno enviaria de verdade (gate + resultado do Planner já
// normalizado) e, só quando a decisão for positiva, chama o sender
// resolvido pelo sendMode atual (hoje sempre o dry-run — nunca a API real
// do WhatsApp/Meta; ver send-mode-service.js para a trava estrutural).
function applySendDecision({ gate, plannerResult, conversationId, messageId, botId, contactId }) {
  const decision = resolveSendDecision({ eligibility: gate, plannerResult });
  const sendMode = getSendMode();
  const sender = resolveSender(sendMode, { dryRunSender: simulateSend });
  const simulated = decision.shouldSend
    ? sender({
      conversationId, messageId, botId, phone: contactId, text: plannerResult.answer,
      action: plannerResult.action, confidence: plannerResult.confidence, reason: plannerResult.reason,
    })
    : null;
  return { ...decision, sendMode, simulated };
}

// Núcleo puro (sem I/O de persistência — só a chamada ao RAG Server, que é
// leitura). `bot`/`flags` já resolvidos pelo chamador (nunca refaz a
// consulta); `history` já no formato [{role, content}]. Cobre os 4 casos
// determinísticos (hint), o provider offline, o provider não configurado,
// sucesso e erro de rede — sempre devolvendo o MESMO formato, para os dois
// chamadores (real e preview) tratarem igual.
async function runShadowPipeline({
  bot, flags, messageText, history, localAiStatus, globalAutomationEnabled, simulateAutoReplyEnabled = null,
}) {
  const usedSimulatedAutoReply = typeof simulateAutoReplyEnabled === "boolean";
  const effectiveBot = usedSimulatedAutoReply ? { ...bot, autoReplyEnabled: simulateAutoReplyEnabled } : bot;
  const gate = resolveAutoReplyEligibility({ bot: effectiveBot, flags, globalAutomationEnabled, localAiStatus });
  const hint = computePlannerHint({ message: messageText, history });
  const base = { gate, hint, providerStatus: localAiStatus, usedSimulatedAutoReply };

  if (hint.forceAction) {
    const forced = normalizePlannerOutput({
      message: messageText, history, signals: hint.detectedSignals,
      result: {
        answer: hint.forceAnswer, action: hint.forceAction, confidence: "HIGH",
        needsHuman: hint.forceNeedsHuman, reason: hint.forceReason, product: null, intent: null, sources: 0,
      },
    });
    const sendDecision = applySendDecision({ gate, plannerResult: forced });
    return { ...base, ok: true, status: "OK", errorCode: null, result: forced, rawResult: null, sendDecision, plannerHintApplied: true };
  }

  if (localAiStatus !== "ONLINE") {
    return {
      ...base, ok: false, status: localAiStatus, errorCode: `PROVIDER_${localAiStatus}`,
      result: null, rawResult: null, sendDecision: null, plannerHintApplied: false,
    };
  }

  try {
    const { provider } = await resolveLocalQwenInstance(flags.aiModel || undefined);
    if (!provider) {
      return {
        ...base, ok: false, status: "ERROR", errorCode: "PROVIDER_NOT_CONFIGURED",
        result: null, rawResult: null, sendDecision: null, plannerHintApplied: false,
      };
    }

    // Busca na Knowledge, prompt e geração já acontecem inteiramente dentro
    // do RAG Server (rag_server.py) — inclusive as regras de "não inventar",
    // "ausência de informação não é evidência negativa" e a decisão de ação
    // do Planner (RESPOND/ASK/CLARIFY/HANDOFF/WAIT/RESOLVE). O app só envia
    // a mensagem crua do cliente + histórico e recebe a resposta já pronta.
    const rawResult = await provider.askRag({ message: messageText, history });
    // Endurece action/confidence/needsHuman/reason DEPOIS do RAG Server —
    // nunca dentro dele (rag/ não é alterado por este caminho). Reaproveita
    // os mesmos sinais do hint (já computado acima) para exigir evidência
    // real de um HANDOFF antes de deixá-lo sobreviver.
    const result = normalizePlannerOutput({ message: messageText, history, signals: hint.detectedSignals, result: rawResult });
    const sendDecision = applySendDecision({ gate, plannerResult: result });
    return { ...base, ok: true, status: "OK", errorCode: null, result, rawResult, sendDecision, plannerHintApplied: false };
  } catch (error) {
    return {
      ...base, ok: false, status: "ERROR", errorCode: error.code || "PROVIDER_REQUEST_FAILED",
      result: null, rawResult: null, sendDecision: null, plannerHintApplied: false,
    };
  }
}

async function shadowIncomingMessage(
  event, message, { now = new Date(), channel = "META", simulateAutoReplyEnabled = null } = {},
) {
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

  // Histórico recente da conversa (mesma fonte/limite do interpretador
  // legado — getRecentContext + flags.contextEnabled/contextMaxMessages,
  // nunca um caminho novo) — enviado ao RAG Server só para ele resolver
  // referência contextual ("qual modelo?" -> "GS Pro 2") e não repetir
  // pergunta já respondida. O app não decide nada com isso, só repassa.
  const context = flags.contextEnabled
    ? await getRecentContext(message.conversationId, { beforeMessageId: message.id, limit: flags.contextMaxMessages }, prisma)
    : [];
  const history = context
    .filter((row) => row.text)
    .map((row) => ({ role: row.direction === "RECEBIDA" ? "customer" : "assistant", content: row.text }));

  const outcome = await runShadowPipeline({
    bot, flags, messageText: event.text, history, localAiStatus,
    globalAutomationEnabled: globalSettings.automationEnabled, simulateAutoReplyEnabled,
  });

  const baseLog = {
    conversationId: message.conversationId, messageId: message.id, botId: bot.id,
    provider: "LOCAL_QWEN", model: flags.aiModel || null, aiMode: flags.aiMode,
    autoReplyEligible: outcome.gate.allowed, autoReplyBlockedReason: outcome.gate.allowed ? null : outcome.gate.reason,
  };

  if (!outcome.ok) {
    await persistLog({
      ...baseLog, status: outcome.status, errorCode: outcome.errorCode, latencyMs: Date.now() - startedAt,
      missingInformation: {
        sendMode: getSendMode(), wouldSend: false, sendBlockedReason: outcome.errorCode,
        eligible: outcome.gate.allowed, providerStatus: outcome.providerStatus,
      },
    });
    return null;
  }

  const { result, rawResult, sendDecision } = outcome;
  const latencyMs = Date.now() - startedAt;

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
      plannerHintApplied: outcome.plannerHintApplied, originalAction: rawResult?.action || null, finalAction: result.action,
      sendMode: sendDecision.sendMode, wouldSend: sendDecision.shouldSend,
      sendBlockedReason: sendDecision.reason, eligible: outcome.gate.allowed, providerStatus: outcome.providerStatus,
      usedSimulatedAutoReply: outcome.usedSimulatedAutoReply,
    },
  });

  return {
    action: result.action, response: result.answer, product: result.product, intent: result.intent,
    confidence: result.confidence, needsHuman: result.needsHuman, reason: result.reason,
    plannerNormalized: result.plannerNormalized, plannerHintApplied: outcome.plannerHintApplied, sendDecision,
  };
}

// Preview do simulador (painel Bots): MESMA pipeline de decisão, nunca
// persiste nada (nem BotAiShadowLog, nem estado de conversa) — `bot` e
// `history` já vêm resolvidos pelo chamador (bot-service.js#simulate),
// então nunca toca o banco além do necessário (getGlobalSettings). Devolve
// os detalhes de retrieval (sourceDetails/searchMs/generationMs) que o
// caminho real não precisa expor, mas a UI do simulador sim.
async function previewShadowReply({ bot, message, history = [], simulateAutoReplyEnabled = null }) {
  const flags = resolveFeatureFlags(bot);
  if (!flags.useAi || flags.aiMode === "OFF") return { supported: false, reason: "BOT_AI_DISABLED" };
  if (flags.aiMode !== "PRIMARY") return { supported: false, reason: "AI_MODE_NOT_PRIMARY" };
  if (flags.aiProvider !== "LOCAL_QWEN") return { supported: false, reason: "PROVIDER_NOT_LOCAL_QWEN" };

  const startedAt = Date.now();
  const localAiStatus = getLocalAiState().status;
  const globalSettings = await getGlobalSettings(prisma);

  const outcome = await runShadowPipeline({
    bot, flags, messageText: message, history, localAiStatus,
    globalAutomationEnabled: globalSettings.automationEnabled, simulateAutoReplyEnabled,
  });
  const latencyMs = Date.now() - startedAt;

  if (!outcome.ok) {
    return {
      supported: true, ok: false, status: outcome.status, errorCode: outcome.errorCode,
      providerStatus: outcome.providerStatus, sendMode: getSendMode(),
      eligible: outcome.gate.allowed, autoReplyBlockedReason: outcome.gate.allowed ? null : outcome.gate.reason,
      usedSimulatedAutoReply: outcome.usedSimulatedAutoReply, latencyMs,
    };
  }

  const { result, rawResult, sendDecision } = outcome;
  return {
    supported: true, ok: true,
    answer: result.answer, action: result.action, confidence: result.confidence, needsHuman: result.needsHuman,
    reason: result.reason, intent: result.intent, product: result.product,
    plannerNormalized: result.plannerNormalized, plannerCorrections: result.plannerCorrections,
    plannerHintApplied: outcome.plannerHintApplied,
    sourceDetails: rawResult?.sourceDetails || [],
    sources: result.sources,
    searchMs: rawResult?.searchMs ?? null, generationMs: rawResult?.generationMs ?? null,
    latencyMs: rawResult?.latencyMs ?? latencyMs,
    provider: "LOCAL_QWEN", model: flags.aiModel || "qwen3:14b",
    providerStatus: outcome.providerStatus, sendMode: sendDecision.sendMode,
    wouldSend: sendDecision.shouldSend, sendBlockedReason: sendDecision.reason,
    eligible: outcome.gate.allowed, autoReplyBlockedReason: outcome.gate.allowed ? null : outcome.gate.reason,
    usedSimulatedAutoReply: outcome.usedSimulatedAutoReply,
  };
}

// Nó "IA" do Flow Builder (bot-visual-flow-service.js): mesmo pipeline do
// shadow/preview (hint -> RAG Server -> planner-output-guard -> gate), sem
// IA paralela. O nó é o opt-in explícito de usar IA naquele ponto do fluxo,
// então não exige flags.useAi/aiMode do Bot — mas continua só LOCAL_QWEN e
// a decisão de envio continua presa ao send-mode atual (DRY_RUN): quem
// chama recebe `sendDecision`, nunca um envio real.
async function runFlowAiStep({ bot, message, history = [], model = null }) {
  const flags = { ...resolveFeatureFlags(bot), ...(model ? { aiModel: model } : {}) };
  const localAiStatus = getLocalAiState().status;
  const globalSettings = await getGlobalSettings(prisma);
  const outcome = await runShadowPipeline({
    bot, flags, messageText: message, history, localAiStatus,
    globalAutomationEnabled: globalSettings.automationEnabled,
  });
  if (!outcome.ok) return { ok: false, status: outcome.status, errorCode: outcome.errorCode, providerStatus: localAiStatus };
  const { result, sendDecision } = outcome;
  return {
    ok: true, answer: result.answer, action: result.action, intent: result.intent, product: result.product,
    confidence: result.confidence, needsHuman: Boolean(result.needsHuman), reason: result.reason,
    provider: "LOCAL_QWEN", model: flags.aiModel || "qwen3:14b",
    sendDecision: { shouldSend: sendDecision.shouldSend, reason: sendDecision.reason, sendMode: sendDecision.sendMode },
  };
}

module.exports = { shadowIncomingMessage, previewShadowReply, runFlowAiStep };
