// Fila com concorrência limitada para chamadas à IA local — o PC do
// operador processa poucas inferências em paralelo (1 GPU, VRAM limitada).
// Sem dependência nova: a fila é só um contador + array de resolvers.
// Compartilhada por todos os Bots que usam LOCAL_QWEN (nunca uma fila por
// Bot, senão o limite de concorrência real do PC deixaria de valer).
const { getSettings } = require("./local-ai-settings-service");

const QUEUE_MAX = Number(process.env.LOCAL_AI_QUEUE_MAX) || 10;
const QUEUE_WAIT_TIMEOUT_MS = Number(process.env.LOCAL_AI_QUEUE_TIMEOUT_MS) || 20000;

let running = 0;
const waiting = [];

function queueDepth() {
  return waiting.length;
}

function runningCount() {
  return running;
}

async function acquire(maxConcurrency) {
  if (running < maxConcurrency) {
    running += 1;
    return;
  }
  if (waiting.length >= QUEUE_MAX) {
    throw Object.assign(new Error("Fila da IA local cheia."), { code: "QUEUE_FULL" });
  }
  await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      const index = waiting.indexOf(entry);
      if (index !== -1) waiting.splice(index, 1);
      reject(Object.assign(new Error("Tempo de espera na fila da IA local excedido."), { code: "QUEUE_TIMEOUT" }));
    }, QUEUE_WAIT_TIMEOUT_MS);
    const entry = { resolve: () => { clearTimeout(timeoutId); resolve(); }, reject };
    waiting.push(entry);
  });
  running += 1;
}

function release() {
  running = Math.max(0, running - 1);
  const next = waiting.shift();
  if (next) next.resolve();
}

// Executa `task` respeitando LocalAiProviderSettings.maxConcurrency —
// nunca lançado para fora sem antes liberar o slot (senão um erro de
// inferência vazaria concorrência disponível para sempre).
async function withQueue(task) {
  const settings = await getSettings();
  await acquire(Math.max(1, settings.maxConcurrency || 1));
  try {
    return await task();
  } finally {
    release();
  }
}

module.exports = { withQueue, queueDepth, runningCount };
