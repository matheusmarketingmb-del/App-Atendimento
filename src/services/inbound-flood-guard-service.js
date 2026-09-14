// Proteção contra flood de mensagens de UM MESMO remetente (item de
// segurança: "derrubar o app por envio em excesso de mensagens"). O
// rate-limit por IP (ver app.js) protege a CAMADA HTTP, mas o webhook da
// Meta chega de poucos IPs compartilhados entre muitos clientes — limitar
// só por IP arriscaria throttlar tráfego legítimo de outras empresas ou
// nunca conter um único número malicioso escondido atrás desse IP
// compartilhado. Esta camada complementa limitando por CONTATO (telefone/id
// externo): processamento caro (Bot/IA/Tools) é pulado além de um limite,
// mas a mensagem em si nunca é perdida (saveIncoming continua rodando —
// quem decide pular é sempre o chamador, nunca este módulo).
//
// Puramente em memória (nunca no banco — decisão de custo/latência: isto
// roda no caminho quente do webhook, uma consulta extra por mensagem seria
// desperdício). Aceitável perder o contador num restart do processo: o pior
// caso é permitir uma rajada extra logo após o deploy, nunca menos proteção
// que "sem limite nenhum".
const WINDOW_MS = 60 * 1000;
const MAX_EVENTS_PER_WINDOW = 20;

const history = new Map();

function pruneOld(timestamps, now) {
  return timestamps.filter((timestamp) => now - timestamp < WINDOW_MS);
}

// Sempre REGISTRA o evento (o contador precisa refletir a realidade mesmo
// quando já está throttled), retorna se este evento específico deveria
// pular o processamento caro.
function checkInboundFlood(key, now = Date.now()) {
  if (!key) return { throttled: false, count: 0 };
  const kept = pruneOld(history.get(key) || [], now);
  kept.push(now);
  history.set(key, kept);
  return { throttled: kept.length > MAX_EVENTS_PER_WINDOW, count: kept.length };
}

// Evita crescimento sem limite do Map ao longo da vida do processo (muitos
// contatos distintos ao longo do tempo, a maioria já fora da janela).
function pruneAll(now = Date.now()) {
  for (const [key, timestamps] of history) {
    const kept = pruneOld(timestamps, now);
    if (kept.length) history.set(key, kept);
    else history.delete(key);
  }
}

function resetForTests() {
  history.clear();
}

let cleanupTimer = null;
function startPeriodicCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => pruneAll(), 5 * 60 * 1000);
  cleanupTimer.unref?.();
}

module.exports = {
  WINDOW_MS, MAX_EVENTS_PER_WINDOW, checkInboundFlood, pruneAll, resetForTests, startPeriodicCleanup,
};
