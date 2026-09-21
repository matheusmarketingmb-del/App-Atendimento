// Sender FALSO — usado só para validar o caminho de decisão de envio
// (resolveSendDecision -> "enviaria isto para este número") sem jamais
// chamar a API do WhatsApp/Meta. Nunca importa channels/message-service
// nem qualquer client HTTP externo — se um dia isto precisar virar envio
// real, é só trocar esta chamada por sendText() (message-service.js), o
// resto do fluxo (gate, log) já está pronto.
function simulateSend({ conversationId, messageId, botId, phone, text }) {
  const payload = { conversationId, messageId, botId, phone: phone || null, text };
  // Log só para inspeção manual em dev — nunca usado como fonte de verdade
  // por nenhum outro serviço.
  console.log("[DRY_RUN_SEND] enviaria (simulado, nada saiu para o WhatsApp):", JSON.stringify(payload));
  return { simulated: true, wouldSend: payload, sentAt: new Date().toISOString() };
}

module.exports = { simulateSend };
