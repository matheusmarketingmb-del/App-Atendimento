// Separa os dois controles pedidos explicitamente pelo usuário:
//   useAi           = a IA participa do Bot (interpreta/decide/redige)
//   autoReplyEnabled = a IA (ou qualquer motor) pode REALMENTE enviar ao cliente
// Função pura, sem I/O — usada tanto pelo modo shadow (só para registrar
// `autoReplyEligible`/o motivo, nunca para enviar nada) quanto, no futuro,
// por um dispatcher de auto-resposta real. Nunca decide "trocar de
// provider": IA local offline nunca vira uma chamada silenciosa a
// Gemini/OpenAI/Anthropic — a única saída aqui é permitir, ou apontar por
// que não pode.
function resolveAutoReplyEligibility({ bot, flags, globalAutomationEnabled, localAiStatus }) {
  if (!globalAutomationEnabled) return { allowed: false, reason: "AUTOMATION_DISABLED_GLOBALLY" };
  if (!bot.autoReplyEnabled) return { allowed: false, reason: "BOT_AUTOREPLY_DISABLED" };

  if (!flags.useAi || flags.aiMode === "OFF") {
    // IA desligada neste Bot: a elegibilidade de auto-resposta depende só do
    // motor local (decide()/Flow/Knowledge) — sempre permitido nesta camada.
    return { allowed: true, reason: null };
  }

  if (localAiStatus === "ONLINE") return { allowed: true, reason: null };

  // useAi=true e o provider está OFFLINE/DEGRADED.
  if (!flags.requiresAi && flags.aiOfflineBehavior === "LOCAL_FLOW") {
    return { allowed: true, reason: null }; // segue sem IA, com o motor local.
  }
  if (flags.aiOfflineBehavior === "HUMAN_HANDOFF") return { allowed: false, reason: "AI_OFFLINE_FORCES_HANDOFF" };
  return { allowed: false, reason: "AI_OFFLINE_NO_AUTO_REPLY" };
}

module.exports = { resolveAutoReplyEligibility };
