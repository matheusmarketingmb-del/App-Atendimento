// Única fonte de verdade de QUAL sender pode ser chamado. Três modos:
//   SHADOW  — só gera/loga, nunca chama nenhum sender (comportamento
//             original de bot-ai-shadow-service.js antes desta etapa).
//   DRY_RUN — roda o caminho de decisão completo (gate + Planner) e, quando
//             shouldSend=true, chama o sender FALSO (dry-run-sender.js).
//             Nunca toca WhatsApp/Meta/Instagram/e-mail/qualquer canal real.
//   LIVE    — enviaria de verdade. NÃO IMPLEMENTADO NESTA ETAPA DE
//             PROPÓSITO: resolveSender(LIVE) devolve uma função que sempre
//             lança erro, então mesmo que alguém troque CURRENT_SEND_MODE
//             para "LIVE" por engano, nenhuma chamada real acontece — é
//             impossível enviar por acidente (item de segurança explícito).
const SEND_MODES = Object.freeze({ SHADOW: "SHADOW", DRY_RUN: "DRY_RUN", LIVE: "LIVE" });

// Modo ativo do sistema hoje — sempre DRY_RUN. Trocar isto para "LIVE" não
// basta para enviar de verdade (ver blockedRealSender abaixo); é só o
// primeiro de dois travamentos intencionais.
const CURRENT_SEND_MODE = SEND_MODES.DRY_RUN;

function getSendMode() {
  return CURRENT_SEND_MODE;
}

// Sender "real" nunca foi implementado/conectado nesta etapa — chamar isto
// SEMPRE lança, em qualquer modo, inclusive se getSendMode() um dia
// devolver "LIVE". Conectar um sender de verdade (message-service.js
// sendText) é uma mudança deliberada e futura, fora do escopo pedido aqui.
function blockedRealSender() {
  throw new Error(
    "[SEND_MODE] Sender real não está implementado/conectado nesta etapa — nenhuma chamada real é permitida, mesmo em modo LIVE."
  );
}

// Resolve qual função de envio usar para o modo atual. SHADOW/DRY_RUN
// sempre usam o dry-run (nunca um canal real); só "LIVE" tentaria o sender
// real — que está permanentemente bloqueado acima.
function resolveSender(mode, { dryRunSender }) {
  if (mode === SEND_MODES.LIVE) return blockedRealSender;
  return dryRunSender;
}

module.exports = { SEND_MODES, getSendMode, resolveSender, blockedRealSender };
