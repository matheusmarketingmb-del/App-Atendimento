// Camada de DECISÃO: recebe uma interpretação já pronta e decide o que fazer
// (bot-interpreter-service.js não sabe nada sobre ações). Não gera texto de
// resposta (isso é bot-response-service.js) nem envia nada a ninguém.
const { scheduleState } = require("./bot-simulator-service");
const { detectSocialBehavior } = require("./bot-social-behavior-service");
const { MAX_FAILED_INTERPRETATIONS, confidenceBand } = require("./bot-constants");

function findIntent(bot, intentId) {
  return (bot.intents || []).find((intent) => intent.id === intentId) || null;
}

function decide({ bot, interpretation, message, state = null, now = new Date(), flags = {} }) {
  if (bot.status !== "ACTIVE") {
    return {
      action: "NO_ACTION", categoryId: null, needsClarification: false,
      shouldHandoff: false, withinHours: null, summary: "Bot pausado ou arquivado: nenhuma ação é tomada.",
    };
  }

  const hours = scheduleState(bot, now);
  if (!hours.withinHours) {
    return {
      action: "RESPOND", categoryId: null, needsClarification: false, shouldHandoff: false,
      withinHours: false, outsideHours: true, summary: "Fora do horário configurado para este Bot.",
    };
  }

  const { socialBehavior, greetingReply } = detectSocialBehavior(message);

  if (socialBehavior === "HUMAN_REQUEST") {
    return {
      action: "HANDOFF_HUMAN", categoryId: bot.defaultCategoryId || null, needsClarification: false,
      shouldHandoff: true, withinHours: true, socialBehavior,
      summary: "Cliente pediu para falar com um atendente humano.",
    };
  }

  const priorFailures = state?.failedInterpretations || 0;
  const band = interpretation.intentId ? confidenceBand(bot, interpretation.confidence) : "LOW";

  // Mensagem puramente social (ex.: "bom dia", "obrigado", "oi tudo bem"):
  // responde com o comportamento social e NÃO conta como falha de
  // interpretação. Antes só entrava aqui quando NENHUMA intenção tinha sido
  // casada — como o classificador local é heurístico, uma saudação podia
  // "casar" por acidente com uma intenção de negócio de baixa/média
  // confiança (ex.: uma palavra genérica em comum) e nunca cair neste
  // atalho, respondendo com a intenção errada em vez da saudação. Agora só
  // uma intenção de ALTA confiança (band === "HIGH") tem prioridade sobre o
  // comportamento social — um match fraco/ambíguo nunca vence uma saudação
  // clara. Desligável por Bot (conversationalBehaviorEnabled) —
  // HUMAN_REQUEST acima nunca é afetado.
  if (
    flags.conversationalBehaviorEnabled !== false && socialBehavior && socialBehavior !== "NEGATION"
    && (!interpretation.intentId || band !== "HIGH")
  ) {
    return {
      action: "RESPOND", categoryId: null, needsClarification: false, shouldHandoff: false,
      withinHours: true, socialBehavior, greetingReply,
      summary: `Comportamento social identificado (${socialBehavior}), sem intenção de negócio associada.`,
    };
  }

  if (!interpretation.intentId || band === "LOW") {
    const failureCount = priorFailures + 1;
    // Item 9 (Handoff automático on/off): quando desligado, o Bot continua
    // pedindo esclarecimento em vez de escalar sozinho após falhas repetidas
    // — HUMAN_REQUEST explícito do cliente (acima) nunca é afetado por este
    // flag, é sempre respeitado.
    if (failureCount >= MAX_FAILED_INTERPRETATIONS && flags.handoffEnabled !== false) {
      return {
        action: "HANDOFF_HUMAN", categoryId: bot.defaultCategoryId || null, needsClarification: false,
        shouldHandoff: true, withinHours: true, failureCount, socialBehavior,
        summary: "Cliente não foi compreendido após múltiplas tentativas; encaminhar para humano.",
      };
    }
    return {
      action: "ASK_CLARIFICATION", categoryId: null, needsClarification: true, shouldHandoff: false,
      withinHours: true, failureCount, socialBehavior,
      summary: socialBehavior === "NEGATION"
        ? "Cliente indicou que a intenção sugerida está errada; pedir para descrever o que precisa."
        : (failureCount >= 2
          ? "Segunda tentativa sem entender o cliente; fazer uma pergunta mais objetiva."
          : "Mensagem não identificada com confiança; pedir esclarecimento ao cliente."),
    };
  }

  const intent = findIntent(bot, interpretation.intentId);
  const categoryId = intent?.categoryId || null;

  if (band === "MEDIUM") {
    return {
      action: "ASK_CLARIFICATION", categoryId, needsClarification: true, shouldHandoff: false,
      withinHours: true, socialBehavior, greetingReply,
      summary: `Confiança média para "${intent?.name}"; confirmar com o cliente antes de prosseguir.`,
    };
  }

  if (intent?.fallbackAction === "TRANSFER_TO_HUMAN" && flags.handoffEnabled !== false) {
    return {
      action: "HANDOFF_HUMAN", categoryId, needsClarification: false, shouldHandoff: true,
      withinHours: true, socialBehavior, greetingReply,
      summary: `Intenção "${intent.name}" configurada para encaminhamento humano.`,
    };
  }

  if (flags.autoSwitchEnabled !== false && intent?.fallbackAction === "TRANSFER_TO_CATEGORY" && categoryId) {
    return {
      action: "SWITCH_BOT", categoryId, needsClarification: false, shouldHandoff: false,
      withinHours: true, socialBehavior, greetingReply,
      summary: `Cliente deseja tratar de "${intent.name}"; avaliar troca de Bot responsável pela categoria.`,
    };
  }

  // Itens 5-8: intenção associada a uma Tool (bot-tools/tool-registry.js).
  // A decisão aqui só SUGERE a consulta — quem valida permissão/riskLevel/
  // entidades obrigatórias e efetivamente chama a Tool é o backend
  // (bot-tool-orchestrator-service.js), nunca a IA. Se faltar alguma
  // entidade obrigatória, o orquestrador troca a ação para
  // ASK_CLARIFICATION antes mesmo de tentar a Tool.
  if (flags.toolsFeatureEnabled !== false && intent?.toolName) {
    return {
      action: "QUERY_TOOL", categoryId, needsClarification: false, shouldHandoff: false,
      withinHours: true, socialBehavior, greetingReply, toolName: intent.toolName,
      entities: interpretation.entities || {},
      summary: `Cliente demonstrou a intenção "${intent?.name}"; consultar a Tool "${intent.toolName}".`,
    };
  }

  return {
    action: "RESPOND", categoryId, needsClarification: false, shouldHandoff: false,
    withinHours: true, socialBehavior, greetingReply,
    summary: `Cliente demonstrou a intenção "${intent?.name}".`,
  };
}

module.exports = { decide };
