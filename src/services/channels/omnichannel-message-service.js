// Persiste uma NormalizedInboundMessage em Contact/Conversation/Message para
// os canais NOVOS (Mercado Livre, TikTok, e-mail, etc.). Deliberadamente
// separado de conversation-service.js/message-service.js (que continuam
// exclusivos do WhatsApp/Meta) — mesmo padrão comprovado (upsert por
// channel+externalId), sem tocar no código do canal já em produção.
const prisma = require("../../database/prisma");
const { NEW_CHANNELS, channelError } = require("./channel-constants");
const { assertNewChannelEnabled } = require("./integration-global-settings-service");
const { storeInternalFile } = require("../media-storage-service");

const kindByChannel = {
  INSTAGRAM_DIRECT: "PRIVATE_CONVERSATION",
  FACEBOOK_MESSENGER: "PRIVATE_CONVERSATION",
  INSTAGRAM_COMMENTS: "PUBLIC_QUESTION",
  FACEBOOK_COMMENTS: "PUBLIC_QUESTION",
  MERCADO_LIVRE: "PRIVATE_CONVERSATION",
  TIKTOK_SHOP: "PRIVATE_CONVERSATION",
  AMAZON_MARKETPLACE: "PRIVATE_CONVERSATION",
  SHOPEE: "PRIVATE_CONVERSATION",
  EMAIL: "EMAIL_THREAD",
  GOOGLE_REVIEWS: "REVIEW",
  RECLAME_AQUI: "COMPLAINT",
};

function conversationKindFor(channel, normalized) {
  if (normalized.type === "review") return "REVIEW";
  if (normalized.type === "question" || normalized.type === "comment") return "PUBLIC_QUESTION";
  return kindByChannel[channel] || "PRIVATE_CONVERSATION";
}

async function assertInboundEnabled(normalized, client) {
  if (!NEW_CHANNELS.includes(normalized.channel)) return;
  await assertNewChannelEnabled(normalized.channel);
  const account = normalized.channelAccountId
    ? await client.channelAccount.findUnique({ where: { id: normalized.channelAccountId } })
    : null;
  if (!account || account.channel !== normalized.channel) {
    throw channelError("INVALID_PAYLOAD", "Conta de canal inválida para a mensagem recebida.");
  }
  if (!account.enabled) throw channelError("NOT_SUPPORTED", "Conta de canal está desativada.");
}

async function findOrCreateChannelConversation(normalized, client = prisma) {
  const { channel, channelAccountId, senderExternalId, senderName } = normalized;
  if (!senderExternalId) throw new Error("senderExternalId é obrigatório para localizar/criar o contato.");
  if (NEW_CHANNELS.includes(channel) && !channelAccountId) {
    throw new Error("channelAccountId é obrigatório para conversas de novos canais.");
  }
  const channelScope = channelAccountId || "LEGACY";
  const contactExternalId = NEW_CHANNELS.includes(channel)
    ? channelScope + ":" + senderExternalId
    : senderExternalId;

  const contact = await client.contact.upsert({
    where: { channel_externalId: { channel, externalId: contactExternalId } },
    update: { ...(senderName ? { name: senderName } : {}), ...(channel === "EMAIL" ? { email: senderExternalId } : {}) },
    create: { channel, externalId: contactExternalId, name: senderName || senderExternalId, phone: null, ...(channel === "EMAIL" ? { email: senderExternalId } : {}) },
  });

  const conversation = await client.conversation.upsert({
    where: { contactId_channel_channelScope: { contactId: contact.id, channel, channelScope } },
    update: {
      ...(channelAccountId ? { channelAccountId } : {}),
      ...(normalized.externalConversationId ? { externalConversationId: normalized.externalConversationId } : {}),
    },
    create: {
      contactId: contact.id, channel, channelScope, channelAccountId: channelAccountId || null,
      externalConversationId: normalized.externalConversationId || null,
      kind: conversationKindFor(channel, normalized), status: "NOVO",
    },
  });

  return { contact, conversation };
}

// Idempotente por Message.externalId (mesma constraint unique já usada pelo
// WhatsApp) — reenvio do mesmo externalMessageId nunca duplica.
async function persistInboundMessage(normalized, client = prisma) {
  await assertInboundEnabled(normalized, client);
  const externalId = normalized.externalMessageId
    ? (normalized.channelAccountId || "LEGACY") + ":" + normalized.externalMessageId
    : null;
  if (externalId) {
    const existing = await client.message.findUnique({ where: { externalId } });
    if (existing) return { message: existing, duplicate: true, conversation: null };
  }

  const { contact, conversation } = await findOrCreateChannelConversation(normalized, client);
  const storedMedia = normalized.media?.buffer ? await storeInternalFile({
    buffer: normalized.media.buffer, mimeType: normalized.media.mimeType, fileName: normalized.media.fileName,
    stableId: externalId || `${conversation.id}:${normalized.occurredAt.getTime()}`,
  }) : null;

  const message = await client.message.create({
    data: {
      conversationId: conversation.id,
      externalId,
      channel: normalized.channel,
      channelAccountId: normalized.channelAccountId || null,
      direction: normalized.direction,
      status: normalized.direction === "RECEBIDA" ? "RECEBIDA" : "ENVIADA",
      type: normalized.type,
      text: normalized.text,
      ...(storedMedia ? {
        mediaStorageKey: storedMedia.storageKey, mediaMimeType: storedMedia.mimeType, mediaFileName: storedMedia.fileName,
        mediaSize: storedMedia.size, mediaSuspicious: Boolean(storedMedia.suspicious), mediaSuspiciousReason: storedMedia.suspiciousReason || null,
      } : {}),
      occurredAt: normalized.occurredAt,
      rawPayload: normalized.externalMessageId || normalized.senderExternalId
        ? {
            ...(normalized.metadata || {}),
            ...(normalized.externalMessageId ? { externalMessageId: normalized.externalMessageId } : {}),
            ...(normalized.senderExternalId ? { senderExternalId: normalized.senderExternalId } : {}),
          }
        : normalized.metadata || undefined,
    },
  });

  if (normalized.direction === "RECEBIDA") {
    await client.conversation.update({
      where: { id: conversation.id }, data: { unreadCount: { increment: 1 }, lastMessageAt: normalized.occurredAt },
    });
  }

  return { message, duplicate: false, conversation, contact };
}

module.exports = { findOrCreateChannelConversation, persistInboundMessage };
