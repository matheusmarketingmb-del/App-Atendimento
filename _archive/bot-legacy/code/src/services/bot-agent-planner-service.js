// Agent Planner (Fase 2, item 3 do plano de Inteligência de Bots): decide a
// PRÓXIMA AÇÃO a partir de contexto + candidatos de intent + conhecimento
// disponível + ferramentas — não gera texto (isso continua sendo
// bot-response-service.js) e não executa nada (Tools continuam validadas e
// executadas SÓ por bot-tool-orchestrator-service.js; Knowledge continua
// buscada SÓ por bot-knowledge-response-service.js — o planner nunca
// duplica essas checagens, só aponta a direção).
//
// Ativado por Bot via flags.agentPlannerEnabled (default false — ver
// bot-constants.js). Quando desligado, bot-orchestrator-service.js continua
// usando bot-decision-service.js#decide() exatamente como antes; ligado, a
// saída daqui é traduzida para o MESMO formato de decisão que o resto do
// motor já consome (ver planToLegacyDecision em bot-orchestrator-service.js)
// — Flow Engine, Tools e Knowledge nunca precisaram mudar uma linha.
const { getTool } = require("./bot-tools/tool-registry");
const { clarificationFor } = require("./bot-tool-orchestrator-service");

const PLANNER_ACTIONS = Object.freeze([
  "RESPOND", "ASK", "CLARIFY", "SEARCH_KNOWLEDGE", "USE_TOOL", "HANDOFF", "WAIT", "RESOLVE",
]);

function findIntent(bot, intentId) {
  return (bot.intents || []).find((intent) => intent.id === intentId) || null;
}

function baseResult(overrides) {
  return {
    action: "RESPOND", reason: "", intent: null, confidence: null,
    requiredInformation: null, knownEntities: {}, missingEntities: [],
    knowledgeIds: [], toolName: null, handoffReason: null, categoryId: null,
    ...overrides,
  };
}

// Funde entidades explícitas desta mensagem com o que o Case State já sabe
// (produto, no momento) — é isto que implementa "nunca perguntar de novo o
// que já é conhecido" no nível de entidade/dado.
function buildKnownEntities(interpretation, caseState) {
  const known = { ...(interpretation.entities || {}) };
  if (!known.productName && caseState?.product) known.productName = caseState.product;
  return known;
}

function planFromIntent({ intent, interpretation, caseState }) {
  const categoryId = intent.categoryId || null;
  const knownEntities = buildKnownEntities(interpretation, caseState);
  const intentRef = { id: intent.id, name: intent.name };

  if (intent.toolName) {
    const tool = getTool(intent.toolName);
    const requiredEntities = tool?.requiredEntities || [];
    const missing = requiredEntities.filter((key) => !knownEntities[key]);
    if (missing.length > 0) {
      return baseResult({
        action: "ASK",
        reason: `Faltam dados obrigatórios (${missing.join(", ")}) para consultar a Tool "${intent.toolName}".`,
        intent: intentRef, confidence: interpretation.confidence,
        requiredInformation: missing[0], knownEntities, missingEntities: missing, toolName: intent.toolName, categoryId,
      });
    }
    return baseResult({
      action: "USE_TOOL",
      reason: `Intenção "${intent.name}" está associada à Tool "${intent.toolName}" e todas as entidades obrigatórias já são conhecidas.`,
      intent: intentRef, confidence: interpretation.confidence, knownEntities, toolName: intent.toolName, categoryId,
    });
  }

  if (!intent.responseMessage) {
    // Otimista de propósito (mesmo espírito do decide() atual): quem
    // confirma se HÁ conhecimento de verdade é bot-knowledge-response-
    // service.js, logo depois, no mesmo caminho de sempre — o planner só
    // aponta a intenção (nunca duplica a busca).
    return baseResult({
      action: "SEARCH_KNOWLEDGE",
      reason: `Intenção "${intent.name}" não tem resposta fixa configurada; buscar na Base de Conhecimento.`,
      intent: intentRef, confidence: interpretation.confidence, knownEntities, categoryId,
    });
  }

  return baseResult({
    action: "RESPOND",
    reason: `Cliente demonstrou a intenção "${intent.name}"; resposta configurada é suficiente.`,
    intent: intentRef, confidence: interpretation.confidence, knownEntities, categoryId,
  });
}

// `interpretation` deve já vir de bot-interpreter-service.js#interpret()
// (traz intentCandidates/intentStatus/entities/socialBehavior). `caseState`
// vem de bot-case-state-service.js#getCaseState() (nunca null — vazio por
// padrão).
function plan({ bot, interpretation, caseState }) {
  if (interpretation.socialBehavior === "HUMAN_REQUEST") {
    return baseResult({
      action: "HANDOFF", reason: "Cliente pediu explicitamente para falar com um atendente humano.",
      knownEntities: interpretation.entities || {}, handoffReason: "CUSTOMER_REQUESTED_HUMAN",
    });
  }

  const status = interpretation.intentStatus || "UNKNOWN";
  const candidates = interpretation.intentCandidates || [];

  if (status === "UNKNOWN" || candidates.length === 0) {
    return baseResult({
      action: "CLARIFY", reason: "Nenhuma intenção reconhecida com confiança suficiente.",
      confidence: 0, requiredInformation: "topic", knownEntities: interpretation.entities || {},
    });
  }

  if (status === "AMBIGUOUS") {
    const top = candidates.slice(0, 2);
    return baseResult({
      action: "CLARIFY",
      reason: `Duas ou mais intenções muito próximas em confiança (${top.map((c) => c.intentName).join(" / ")}); preciso confirmar com o cliente antes de agir.`,
      confidence: top[0].confidence, requiredInformation: "disambiguation",
      knownEntities: interpretation.entities || {},
      candidates: top.map((c) => ({ intentId: c.intentId, intentName: c.intentName, confidence: c.confidence })),
    });
  }

  const best = candidates[0];
  const intent = findIntent(bot, best.intentId);
  if (!intent) {
    return baseResult({
      action: "CLARIFY", reason: "Intenção candidata não corresponde a nenhuma intenção ativa do Bot.",
      confidence: 0, requiredInformation: "topic", knownEntities: interpretation.entities || {},
    });
  }

  return planFromIntent({
    intent, interpretation: { ...interpretation, confidence: best.confidence }, caseState,
  });
}

module.exports = { plan, PLANNER_ACTIONS };
