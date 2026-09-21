// Monitor de disponibilidade da IA local. Checa o RAG SERVER (rag_server.py,
// GET /health) — NUNCA o Ollama diretamente: o app só considera a IA local
// ONLINE quando a API RAG (busca + Knowledge + Qwen) está de fato funcional
// de ponta a ponta, não só quando o Ollama sozinho responde. Estado em
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
  // Sub-status do último /health do RAG Server — usado pela UI (simulador)
  // pra distinguir "RAG respondeu mas Ollama caiu" de "Knowledge não
  // carregou", em vez de só um status combinado. Nunca a fonte de verdade
  // de `status` acima (isso continua sendo a regra em checkOnce()).
  ollamaOnline: null,
  knowledgeReady: null,
};
let timer = null;
let inferenceFailuresWindow = []; // timestamps de timeouts/erros de inferência (não de healthcheck) na última janela de 10min — item 13.

function getState() {
  return { ...state };
}

// Item 13: "3 timeouts de inferência em 10 min" também degrada, mesmo com
// healthcheck OK (o /health do RAG Server responder não significa que a
// geração consegue terminar dentro do timeout configurado — VRAM/fila
// podem estar saturadas).
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
    const response = await axios.get(`${settings.baseUrl}/health`, { timeout: HEALTHCHECK_TIMEOUT_MS });
    const latencyMs = Date.now() - startedAt;
    const body = response.data || {};

    // O RAG Server responder não basta — só ONLINE quando ELE MESMO diz
    // status "ONLINE" (ou seja: Ollama de pé e Knowledge carregada do lado
    // dele). Reachable-mas-não-funcional vira DEGRADED, nunca ONLINE — a
    // rede está OK, mas nenhuma resposta de verdade pode ser confiada agora.
    if (body.status === "ONLINE") {
      state = {
        ...state, latencyMs, lastCheckAt: new Date(), lastSuccessAt: new Date(),
        consecutiveFailures: 0, lastError: null,
        status: state.status === "DEGRADED" && inferenceFailuresWindow.length >= 3 ? "DEGRADED" : "ONLINE",
        ollamaOnline: Boolean(body.ollama), knowledgeReady: Boolean(body.knowledgeReady),
        model: body.generationModel || state.model,
      };
    } else {
      state = {
        ...state, latencyMs, lastCheckAt: new Date(), consecutiveFailures: 0,
        lastError: `RAG Server respondeu, mas não está pronto (ollama=${body.ollama}, knowledgeReady=${body.knowledgeReady}).`,
        status: "DEGRADED",
        ollamaOnline: Boolean(body.ollama), knowledgeReady: Boolean(body.knowledgeReady),
      };
    }
  } catch (error) {
    const consecutiveFailures = state.consecutiveFailures + 1;
    const status = consecutiveFailures >= OFFLINE_AFTER_CONSECUTIVE_FAILURES
      ? "OFFLINE"
      : (consecutiveFailures >= DEGRADED_AFTER_CONSECUTIVE_FAILURES ? "DEGRADED" : state.status);
    state = {
      ...state, consecutiveFailures, lastCheckAt: new Date(),
      lastError: error.message, status, ollamaOnline: false, knowledgeReady: false,
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
