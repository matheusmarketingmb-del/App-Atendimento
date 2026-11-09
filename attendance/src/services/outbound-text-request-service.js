const { createHash } = require("node:crypto");
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (message, code, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });

// Existing ledger's unique constraint claims the operation before the external
// side effect. A replay never sends again, even after process restart.
async function sendOnce({ client, userId, conversationId, requestId, text, crmProposal, replyToMessageId, send }) {
  if (requestId === undefined) return send(async () => {}); // older clients
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) {
    throw fail("Identificação do envio inválida. Atualize a página.", "INVALID_SEND_REQUEST", 400);
  }
  const conversation = await client.conversation.findUnique({ where: { id: conversationId }, select: { channel: true, channelAccountId: true, companyId: true } });
  if (!conversation) throw fail("Conversa não encontrada.", "CONVERSATION_NOT_FOUND", 404);
  const externalEventId = `outbound-text-v1:${digest([conversation.companyId, conversationId, userId, requestId])}`;
  const fingerprint = digest(replyToMessageId ? [text, crmProposal || null, replyToMessageId] : [text, crmProposal || null]);
  const where = { channel_externalEventId: { channel: conversation.channel, externalEventId } };
  let event;
  try {
    event = await client.externalChannelEvent.create({ data: {
      channel: conversation.channel, channelAccountId: conversation.channelAccountId,
      externalEventId, eventType: "OUTBOUND_TEXT_REQUEST", status: "RECEIVED",
      payload: { fingerprint, providerAttempted: false },
    } });
  } catch (error) {
    if (error.code !== "P2002") throw error;
    event = await client.externalChannelEvent.findUnique({ where });
    if (!event || event.payload?.fingerprint !== fingerprint) throw fail("Este envio já foi usado com outro conteúdo.", "SEND_REQUEST_CONFLICT");
    if (event.status === "PROCESSED") {
      if (typeof event.payload.messageId !== "string") throw fail("O envio já foi realizado. Confira o histórico antes de tentar novamente.", "SEND_RESULT_UNAVAILABLE");
      const message = await client.message.findFirst({ where: { id: event.payload.messageId, conversationId, sentByUserId: userId } });
      if (!message) throw fail("O envio já foi realizado. Confira o histórico antes de tentar novamente.", "SEND_RESULT_UNAVAILABLE");
      return { message, replayed: true };
    }
    if (event.status !== "ERROR" || event.payload?.retrySafe !== true) {
      throw fail("Este envio está em andamento ou aguardando confirmação. Confira o histórico antes de reenviar.", "SEND_ALREADY_PENDING");
    }
    const retry = await client.externalChannelEvent.updateMany({
      where: { id: event.id, status: "ERROR", payload: { path: ["retrySafe"], equals: true } },
      data: { status: "RECEIVED", payload: { fingerprint, providerAttempted: false } },
    });
    if (retry.count !== 1) throw fail("Este envio já está em andamento.", "SEND_ALREADY_PENDING");
  }
  let attempted = false;
  try {
    const result = await send(async () => {
      attempted = true;
      await client.externalChannelEvent.update({ where: { id: event.id }, data: { payload: { fingerprint, providerAttempted: true } } });
    });
    await client.externalChannelEvent.update({ where: { id: event.id }, data: {
      status: "PROCESSED", processedAt: new Date(), payload: { fingerprint, providerAttempted: attempted, messageId: result.message.id },
    } });
    return result;
  } catch (error) {
    await client.externalChannelEvent.update({ where: { id: event.id }, data: {
      status: "ERROR", errorCode: "OUTBOUND_SEND_ERROR", payload: { fingerprint, providerAttempted: attempted, retrySafe: !attempted },
    } }).catch(() => {});
    if (attempted) throw fail("Não foi possível confirmar o resultado do envio. Confira o histórico antes de reenviar.", "SEND_RESULT_UNCERTAIN");
    throw error;
  }
}

module.exports = { sendOnce };
