// Separa os dois controles pedidos explicitamente pelo usuário:
//   useAi           = a IA participa do Bot (interpreta/decide/redige)
//   autoReplyEnabled = a IA (ou qualquer motor) pode REALMENTE enviar ao cliente
// Função pura, sem I/O — usada tanto pelo modo shadow (só para registrar
// `autoReplyEligible`/o motivo, nunca para enviar nada) quanto, no futuro,
// por um dispatcher de auto-resposta real. Nunca decide "trocar de
// provider": IA local offline nunca vira uma chamada silenciosa a
// Gemini/OpenAI/Anthropic — a única saída aqui é permitir, ou apontar por
// que não pode.
//
// Motivos de bloqueio usam vocabulário canônico (reaproveitado por
// resolveSendDecision abaixo) — nunca só `allowed=false` sem explicar por quê.
function resolveAutoReplyEligibility({ bot, flags, globalAutomationEnabled, localAiStatus }) {
  if (!globalAutomationEnabled) return { allowed: false, reason: "GLOBAL_AUTOMATION_DISABLED" };
  if (!bot.autoReplyEnabled) return { allowed: false, reason: "AUTO_REPLY_DISABLED" };

  if (!flags.useAi || flags.aiMode === "OFF") {
    // IA desligada neste Bot: a elegibilidade de auto-resposta depende só do
    // motor local (decide()/Flow/Knowledge) — sempre permitido nesta camada.
    // (bot-ai-shadow-service.js nem chega a chamar isto nesse caso — já
    // retorna cedo com motivo conceitual BOT_AI_DISABLED antes de qualquer
    // log, então este ramo aqui só importa para outros chamadores futuros.)
    return { allowed: true, reason: null };
  }

  if (localAiStatus === "ONLINE") return { allowed: true, reason: null };

  // useAi=true e o provider está OFFLINE/DEGRADED.
  if (!flags.requiresAi && flags.aiOfflineBehavior === "LOCAL_FLOW") {
    return { allowed: true, reason: null }; // segue sem IA, com o motor local.
  }
  if (flags.aiOfflineBehavior === "HUMAN_HANDOFF") return { allowed: false, reason: "AI_OFFLINE_FORCES_HANDOFF" };
  return { allowed: false, reason: "PROVIDER_OFFLINE" };
}

// Ações que podem virar mensagem automática — HANDOFF e CLARIFY nunca
// entram aqui: HANDOFF por definição precisa de humano (needsHuman=true já
// garante isso na checagem abaixo), RESOLVE é encerramento (não é mensagem
// operacional nova), CLARIFY fica de fora mesmo com confiança alta por
// decisão explícita (pedido do usuário: a allowlist de actions enviáveis é
// só RESPOND/ASK/WAIT — nunca "só quando a confiança for baixa", sempre).
const SENDABLE_ACTIONS = new Set(["RESPOND", "ASK", "WAIT"]);

// Segundo gate — DEPOIS do planner-output-guard já ter normalizado
// action/confidence/needsHuman/reason. resolveAutoReplyEligibility() acima
// só sabe se o Bot/automação/provider PODERIAM enviar; este aqui olha o que
// a IA realmente decidiu para este turno específico. Os dois precisam
// concordar — nenhum sozinho autoriza o envio. Nunca devolve só
// `shouldSend=false`: sempre um `reason` do vocabulário canônico abaixo.
function resolveSendDecision({ eligibility, plannerResult }) {
  if (!eligibility?.allowed) return { shouldSend: false, reason: eligibility?.reason || "NOT_ELIGIBLE" };
  if (!plannerResult) return { shouldSend: false, reason: "NO_PLANNER_RESULT" };
  if (typeof plannerResult.answer !== "string" || !plannerResult.answer.trim()) {
    return { shouldSend: false, reason: "EMPTY_RESPONSE" };
  }
  if (plannerResult.needsHuman) return { shouldSend: false, reason: "NEEDS_HUMAN" };
  if (plannerResult.confidence === "LOW") return { shouldSend: false, reason: "LOW_CONFIDENCE" };
  if (!SENDABLE_ACTIONS.has(plannerResult.action)) {
    return { shouldSend: false, reason: "ACTION_NOT_ALLOWED", blockedAction: plannerResult.action };
  }
  return { shouldSend: true, reason: null };
}

module.exports = { resolveAutoReplyEligibility, resolveSendDecision, SENDABLE_ACTIONS };
