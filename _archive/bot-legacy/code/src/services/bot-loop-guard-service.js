// Proteção contra loop e ping-pong de troca de Bot. Funções puras — quem
// decide o que fazer com o resultado é o orquestrador/decision service.
const crypto = require("node:crypto");
const { normalizeText } = require("./bot-simulator-service");
const { LOOP_REPEAT_LIMIT } = require("./bot-constants");

function hashResponse(text) {
  if (!text) return null;
  return crypto.createHash("sha1").update(normalizeText(text)).digest("hex");
}

// Compara a resposta que estamos prestes a repetir com a última registrada.
// Retorna o repeatCount atualizado e se o limite foi estourado.
function checkResponseLoop(state, responseText) {
  const hash = hashResponse(responseText);
  if (!hash) return { hash: state?.lastResponseHash || null, repeatCount: 0, looped: false };
  const repeatCount = hash === state?.lastResponseHash ? (state.lastResponseRepeatCount || 0) + 1 : 0;
  return { hash, repeatCount, looped: repeatCount >= LOOP_REPEAT_LIMIT };
}

// Janela deslizante simples: se passou do switchWindowMinutes desde a
// primeira troca contada, a janela reinicia. Impede o ping-pong
// Bot A -> B -> A -> B sem precisar guardar um histórico completo.
function checkSwitchWindow(state, { maxSwitchesPerWindow, switchWindowMinutes }, now = new Date()) {
  const windowStart = state?.switchWindowStartedAt ? new Date(state.switchWindowStartedAt) : null;
  const withinWindow = windowStart && (now.getTime() - windowStart.getTime()) <= switchWindowMinutes * 60 * 1000;
  const currentCount = withinWindow ? (state?.switchCount || 0) : 0;
  const nextCount = currentCount + 1;
  return {
    allowed: nextCount <= maxSwitchesPerWindow,
    switchCount: nextCount,
    switchWindowStartedAt: withinWindow ? windowStart : now,
  };
}

module.exports = { checkResponseLoop, checkSwitchWindow, hashResponse };
