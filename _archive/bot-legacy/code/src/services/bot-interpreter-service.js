// Camada de INTERPRETAÇÃO: transforma uma mensagem em { intentId, confidence,
// entities }. Não decide ação (bot-decision-service.js) nem monta texto de
// resposta (bot-response-service.js). Nunca lança erro para quem chama: toda
// falha vira { status: "PROVIDER_ERROR", ... } com fallback local aplicado.
const { normalizeText } = require("./bot-simulator-service");
const { extractEntities, mergeEntities } = require("./bot-entity-extractor");
const { getPrimaryProvider, getFallbackProvider } = require("./ai/get-ai-provider");
const { DEFAULT_HIGH_CONFIDENCE_THRESHOLD, DEFAULT_EXTERNAL_AI_THRESHOLD } = require("./bot-constants");
const { detectSocialBehavior } = require("./bot-social-behavior-service");
const { rankIntentCandidates } = require("./bot-intent-ranking-service");

function findIntent(bot, intentId) {
  if (!intentId) return null;
  return (bot.intents || []).find((intent) => intent.id === intentId) || null;
}

// Curto-circuito de contexto: "sim"/"ss"/"correto" após uma pergunta de
// esclarecimento deve reafirmar a última intenção, sem precisar de provider.
function carryOverFromContext(bot, socialBehavior, state) {
  if (socialBehavior !== "CONFIRMATION") return null;
  if (!state?.pendingClarification || !state?.lastIntentId) return null;
  const intent = findIntent(bot, state.lastIntentId);
  if (!intent) return null;
  return {
    intentId: intent.id,
    confidence: Math.max(
      state.lastConfidence || 0,
      bot.highConfidenceThreshold ?? DEFAULT_HIGH_CONFIDENCE_THRESHOLD,
    ),
    matchedExample: null,
    providerName: "CONTEXT_CARRYOVER",
    entities: {},
  };
}

async function runProvider(providerEntry, { bot, message, context }) {
  const classification = await providerEntry.provider.classifyIntent({ bot, message, context });
  return classification ? { ...classification, providerName: providerEntry.name } : null;
}

// Núcleo testável: recebe os providers já resolvidos (permite injetar dublês
// nos testes sem depender de rede ou de variáveis de ambiente). `interpret()`
// abaixo é a versão de uso normal, que resolve os providers reais.
async function interpretWithProviders({ bot, message, context = [], state = null, primary, fallback }) {
  const normalizedMessage = normalizeText(message);
  const localEntities = extractEntities(message);

  if (!normalizedMessage) {
    return {
      intentId: null, intentName: null, confidence: 0, matchedExample: null,
      entities: localEntities, provider: "NONE", status: "EMPTY_MESSAGE", errorCode: null,
      socialBehavior: null,
    };
  }

  const { socialBehavior, greetingReply } = detectSocialBehavior(message);

  const carryOver = carryOverFromContext(bot, socialBehavior, state);
  if (carryOver) {
    return {
      intentId: carryOver.intentId,
      intentName: findIntent(bot, carryOver.intentId)?.name || null,
      confidence: carryOver.confidence,
      matchedExample: null,
      entities: mergeEntities(localEntities, carryOver.entities),
      provider: carryOver.providerName,
      status: "OK",
      errorCode: null,
      socialBehavior,
      greetingReply,
    };
  }

  let result = null;
  let status = "OK";
  let errorCode = null;
  let providerAttempted = null;

  try {
    providerAttempted = primary.name;
    result = await runProvider(primary, { bot, message, context });
  } catch (error) {
    status = "PROVIDER_ERROR";
    errorCode = error.code || "PROVIDER_REQUEST_FAILED";
  }

  if ((!result || status === "PROVIDER_ERROR") && primary.name !== fallback.name) {
    try {
      const fallbackResult = await runProvider(fallback, { bot, message, context });
      if (fallbackResult) {
        result = fallbackResult;
        if (status !== "PROVIDER_ERROR") status = "OK";
      }
    } catch (_error) {
      // O fallback local não deveria falhar; se falhar, seguimos sem intenção.
    }
  } else if (!result && status === "OK") {
    // Provider único (ou já era o fallback) respondeu sem intenção correspondente.
    status = "OK";
  }

  if (!result) {
    return {
      intentId: null, intentName: null, confidence: 0, matchedExample: null,
      entities: localEntities, provider: status === "PROVIDER_ERROR" ? fallback.name : primary.name,
      status, errorCode, socialBehavior, greetingReply, providerAttempted,
    };
  }

  const intent = findIntent(bot, result.intentId);
  return {
    intentId: intent ? intent.id : null,
    intentName: intent ? intent.name : null,
    confidence: intent ? Math.min(1, Math.max(0, Number(result.confidence) || 0)) : 0,
    matchedExample: result.matchedExample || null,
    entities: mergeEntities(localEntities, result.entities),
    provider: result.providerName,
    status,
    errorCode,
    socialBehavior,
    greetingReply,
    usage: result.usage || null,
    providerAttempted,
  };
}

// Item 12/13 (IA externa como fallback INTELIGENTE, nunca em toda mensagem):
// 1) regras locais/contexto (carryOverFromContext, acima) já resolvidas por
// interpretWithProviders(); 2) SEMPRE roda o provider LOCAL primeiro aqui —
// nunca o externo; 3) só tenta um provider externo quando TODAS as condições
// abaixo são verdadeiras:
//   - flags.externalAiFallbackEnabled === true (default false: nunca chama);
//   - o resultado local não achou intenção OU a confiança ficou abaixo de
//     flags.externalAiThreshold (default DEFAULT_EXTERNAL_AI_THRESHOLD);
//   - existe um provider externo de fato configurado (getPrimaryProvider()
//     só devolve algo != LOCAL_FALLBACK quando a credencial existe — ver
//     ai/get-ai-provider.js; sem credencial, a app nunca quebra, só não
//     tenta o externo).
// Nunca troca um resultado local válido por um resultado externo pior: só
// substitui quando o provider externo realmente classificou algo.
async function interpretCore({ bot, message, context = [], state = null, flags = {} }) {
  const local = getFallbackProvider();
  const localResult = await interpretWithProviders({ bot, message, context, state, primary: local, fallback: local });

  if (localResult.provider === "CONTEXT_CARRYOVER" || localResult.status === "EMPTY_MESSAGE") {
    return { ...localResult, calledExternalAi: false };
  }

  const threshold = Number.isFinite(flags.externalAiThreshold) ? flags.externalAiThreshold : DEFAULT_EXTERNAL_AI_THRESHOLD;
  const shouldTryExternal = flags.externalAiFallbackEnabled === true
    && (!localResult.intentId || localResult.confidence < threshold);
  if (!shouldTryExternal) return { ...localResult, calledExternalAi: false };

  const external = await getPrimaryProvider(flags.externalAiProvider, flags.externalAiModel || undefined);
  if (external.name === "LOCAL_FALLBACK") return { ...localResult, calledExternalAi: false };

  const aiOutcome = await interpretWithProviders({ bot, message, context, state, primary: external, fallback: local });
  if (aiOutcome.provider === external.name && aiOutcome.intentId) {
    return {
      ...aiOutcome, calledExternalAi: true, externalProvider: external.name,
      externalAccepted: true, externalStatus: aiOutcome.status,
      externalErrorCode: aiOutcome.errorCode, aiUsage: aiOutcome.usage || null,
    };
  }
  // A tentativa externa não confirmou nada de novo (erro, timeout ou "não
  // sei") — mantém o resultado local em vez de piorar a resposta, mas marca
  // que a chamada externa realmente aconteceu (item 15: métrica de uso).
  const calledExternalAi = aiOutcome.providerAttempted === external.name;
  return {
    ...localResult, calledExternalAi,
    externalProvider: calledExternalAi ? external.name : null,
    externalAccepted: false,
    externalStatus: aiOutcome.status,
    externalErrorCode: aiOutcome.errorCode,
    aiUsage: aiOutcome.usage || null,
  };
}

// Fase 1 (item 2 do plano de Inteligência): "Intent não é resposta" — a
// interpretação passa a carregar, ALÉM do vencedor único de sempre
// (intentId/confidence, consumido sem mudança por bot-decision-service.js),
// os candidatos top-N com evidência e um status OK/AMBIGUOUS/UNKNOWN
// (bot-intent-ranking-service.js). Puramente ADITIVO: nenhum campo existente
// muda de valor/formato, então nada que já lê `interpretation.intentId`
// quebra. Quem quiser decidir com mais nuance (bot-agent-planner-service.js,
// fase 2) usa `intentCandidates`/`status`/`semantic`; o resto do motor
// continua ignorando esses campos como sempre ignorou campos novos.
async function interpret(input) {
  const result = await interpretCore(input);
  const ranking = rankIntentCandidates(input.bot, input.message);
  return {
    ...result,
    intentCandidates: ranking.candidates,
    intentStatus: ranking.status,
    semantic: { normalized: ranking.semantic.normalized, concepts: ranking.semantic.concepts },
  };
}

module.exports = { interpret, interpretWithProviders };
