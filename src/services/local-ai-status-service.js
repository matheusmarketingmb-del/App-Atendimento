// Monitor de disponibilidade da IA local (LOCAL_QWEN/Ollama). Estado em
// MEMÓRIA do processo — nunca persistido em Bot/BotGlobalSettings: ligar ou
// desligar o PC do operador NUNCA altera bot.enabled/autoReplyEnabled de
// nenhum Bot (regra explícita do usuário). Um único monitor compartilhado
// por toda a aplicação, independente de quantos Bots usem LOCAL_QWEN.
const axios = require("axios");
const { getSettings } = require("./local-ai-settings-service");

const HEALTHY_INTERVAL_MS = 45000;
const UNHEALTHY_INTERVAL_MS = 120000;
const HEALTHCHECK_TIMEOUT_MS = 5000;
const OFFLINE_AFTER_CONSECUTIVE_FAILURES = 4;
const DEGRADED_AFTER_CONSECUTIVE_FAILURES = 2;

let state = {
  status: "OFFLINE", // ONLINE | DEGRADED | OFFLINE
  lastCheckAt: null,
  lastSuccessAt: null,
  latencyMs: null,
  consecutiveFailures: 0,
  lastError: null,
  model: null,
};
let timer = null;
let inferenceFailuresWindow = []; // timestamps de timeouts/erros de inferência (não de healthcheck) na última janela de 10min — item 13.

function getState() {
  return { ...state };
}

// Item 13: "3 timeouts de inferência em 10 min" também degrada, mesmo com
// healthcheck OK (o /api/tags responder não significa que o modelo consegue
// gerar dentro do timeout configurado — VRAM/fila podem estar saturadas).
function recordInferenceOutcome(outcome) {
  const now = Date.now();
  if (outcome === "TIMEOUT" || outcome === "ERROR") {
    inferenceFailuresWindow.push(now);
  }
  inferenceFailuresWindow = inferenceFailuresWindow.filter((ts) => now - ts < 10 * 60 * 1000);
  if (inferenceFailuresWindow.length >= 3 && state.status === "ONLINE") {
    state.status = "DEGRADED";
  }
}

async function checkOnce() {
  const settings = await getSettings();
  state.model = settings.defaultModel;
  if (!settings.enabled || !settings.baseUrl) {
    state = { ...state, status: "OFFLINE", lastCheckAt: new Date(), lastError: "IA local desabilitada ou sem endereço configurado." };
    return state;
  }
  const startedAt = Date.now();
  try {
    await axios.get(`${settings.baseUrl}/api/tags`, { timeout: HEALTHCHECK_TIMEOUT_MS });
    const latencyMs = Date.now() - startedAt;
    state = {
      ...state, latencyMs, lastCheckAt: new Date(), lastSuccessAt: new Date(),
      consecutiveFailures: 0, lastError: null,
      status: state.status === "DEGRADED" && inferenceFailuresWindow.length >= 3 ? "DEGRADED" : "ONLINE",
    };
  } catch (error) {
    const consecutiveFailures = state.consecutiveFailures + 1;
    const status = consecutiveFailures >= OFFLINE_AFTER_CONSECUTIVE_FAILURES
      ? "OFFLINE"
      : (consecutiveFailures >= DEGRADED_AFTER_CONSECUTIVE_FAILURES ? "DEGRADED" : state.status);
    state = {
      ...state, consecutiveFailures, lastCheckAt: new Date(),
      lastError: error.message, status,
    };
  }
  return state;
}

function scheduleNext() {
  const delay = state.status === "ONLINE" ? HEALTHY_INTERVAL_MS : UNHEALTHY_INTERVAL_MS;
  timer = setTimeout(async () => {
    try { await checkOnce(); } catch (_error) { /* checkOnce já trata erro internamente */ }
    scheduleNext();
  }, delay);
  if (timer.unref) timer.unref();
}

// Chamado uma única vez no boot (src/app.js) — nunca pode derrubar a
// aplicação se a IA local nunca tiver sido configurada.
function start() {
  if (timer) return;
  checkOnce().catch(() => {}).finally(scheduleNext);
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { start, stop, getState, checkOnce, recordInferenceOutcome };
