// Sender FALSO — usado só para validar o caminho de decisão de envio
// (resolveSendDecision -> "enviaria isto para este número") sem jamais
// chamar a API do WhatsApp/Meta/Instagram/e-mail ou qualquer canal real.
// Nunca importa channels/message-service nem qualquer client HTTP externo.
// Só é chamado quando send-mode-service.js resolve o sender para SHADOW/
// DRY_RUN — em modo LIVE, quem resolve é blockedRealSender() (sempre
// lança), nunca isto.
function simulateSend({ conversationId, messageId, botId, channel = "WHATSAPP", phone, text, action, confidence, reason }) {
  const payload = {
    wouldSend: true, channel, text, conversationId, messageId, botId, phone: phone || null,
    action, confidence, reason,
  };
  // Log só para inspeção manual em dev — nunca usado como fonte de verdade
  // por nenhum outro serviço.
  console.log("[DRY_RUN_SEND] enviaria (simulado, nada saiu para o WhatsApp/Meta):", JSON.stringify(payload));
  return { simulated: true, ...payload, sentAt: new Date().toISOString() };
}

module.exports = { simulateSend };
