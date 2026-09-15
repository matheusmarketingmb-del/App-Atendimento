// Moderação de comentário público (item 27/42 do plano Social) — apagar,
// ocultar/reexibir e curtir/descurtir um comentário do Instagram/Facebook.
// Nunca disparado automaticamente por IA (item 27 do pedido original: "nunca
// executar moderação automaticamente por IA"); sempre uma ação explícita de
// um atendente/Master pelo painel.
const prisma = require("../../database/prisma");
const authorization = require("../authorization-service");
const audit = require("../audit-service");
const channelMessageService = require("./channel-message-service");
const inboxService = require("../inbox-service");

const COMMENT_CHANNELS = new Set(["INSTAGRAM_COMMENTS", "FACEBOOK_COMMENTS"]);

const CHANNEL_LABEL = { INSTAGRAM_COMMENTS: "Instagram", FACEBOOK_COMMENTS: "Facebook" };

const ACTIONS = Object.freeze({
  delete: { op: "deleteComment", capabilityKey: "canDelete", activity: "SOCIAL_COMMENT_DELETED", verb: "Apagou" },
  hide: { op: "hideComment", capabilityKey: "canHide", params: { hidden: true }, activity: "SOCIAL_COMMENT_HIDDEN", verb: "Ocultou" },
  unhide: { op: "hideComment", capabilityKey: "canHide", params: { hidden: false }, activity: "SOCIAL_COMMENT_UNHIDDEN", verb: "Reexibiu" },
  like: { op: "likeComment", capabilityKey: "canLike", params: { liked: true }, activity: "SOCIAL_COMMENT_LIKED", verb: "Curtiu" },
  unlike: { op: "likeComment", capabilityKey: "canLike", params: { liked: false }, activity: "SOCIAL_COMMENT_UNLIKED", verb: "Descurtiu" },
});

// Message.externalId é sempre "{channelAccountId}:{idCruDaGraphAPI}" (ver
// omnichannel-message-service.js#persistInboundMessage e
// message-service.js#sendText) — vale tanto para o comentário do cliente
// quanto para a nossa própria resposta (também é um comentário na Graph
// API), por isso dá para moderar os dois lados da thread.
function extractCommentId(message) {
  if (!message.externalId) return null;
  const prefix = `${message.channelAccountId}:`;
  return message.externalId.startsWith(prefix) ? message.externalId.slice(prefix.length) : message.externalId;
}

async function moderateMessage({ messageId, action, actor }) {
  const config = ACTIONS[action];
  if (!config) throw Object.assign(new Error("Ação de moderação inválida."), { statusCode: 400 });

  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) throw Object.assign(new Error("Mensagem não encontrada."), { statusCode: 404 });
  if (!COMMENT_CHANNELS.has(message.channel)) {
    throw Object.assign(new Error("Moderação só está disponível para comentários públicos do Instagram/Facebook."), { statusCode: 409 });
  }
  await authorization.assertCanViewConversation(actor, message.conversationId);
  // Apagar é irreversível e público — mesma régua de "excluir conversa"
  // (Master-only). Ocultar/curtir são reversíveis, ficam liberados para
  // quem já pode responder a conversa.
  if (action === "delete" && !authorization.isMaster(actor)) {
    throw authorization.forbidden("Somente uma conta Master pode apagar um comentário.");
  }

  const commentId = extractCommentId(message);
  if (!commentId) throw Object.assign(new Error("Não foi possível identificar o comentário na Meta para esta mensagem."), { statusCode: 409 });

  await channelMessageService.moderateComment({
    channel: message.channel, channelAccountId: message.channelAccountId,
    op: config.op, capabilityKey: config.capabilityKey, commentId, ...(config.params || {}),
  });

  await inboxService.recordConversationActivity({
    conversationId: message.conversationId, actorUserId: actor.id, action: config.activity, details: { messageId },
  });
  await audit.recordAudit({
    actor, action: config.activity, entityType: "CONVERSATION", entityId: message.conversationId,
    summary: `${config.verb} um comentário no ${CHANNEL_LABEL[message.channel]}.`,
  });
  return { moderated: true, action };
}

module.exports = { moderateMessage };
