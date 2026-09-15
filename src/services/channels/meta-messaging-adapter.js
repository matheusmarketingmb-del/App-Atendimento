// Adapters REAIS para as 4 contas Meta "novas" (item 6/19): Instagram
// Direct, Instagram Comentários, Facebook Messenger, Facebook Comentários.
// Antes, todas as 4 eram tratadas pela mesma classe do WhatsApp
// (MetaAdapter), que declarava capabilities completas sem nenhuma chamada
// real por trás — corrigido aqui: cada classe só declara o que de fato
// implementa, e cada uma usa MetaGraphMessagingChannel (Página/Perfil Access
// Token por ChannelAccount), nunca o token global do WhatsApp.
const axios = require("axios");
const { ChannelAdapter } = require("./channel-adapter");
const { channelError } = require("./channel-constants");
const MetaGraphMessagingChannel = require("../../channels/meta-graph-messaging");

function buildChannel(account) {
  return new MetaGraphMessagingChannel({
    config: account?.config || {},
    secrets: account?.secrets || {},
  });
}

function mapTestConnectionError(error) {
  const status = error.response?.status;
  if (status === 401) throw channelError("TOKEN_EXPIRED", "Token de página/perfil da Meta expirado ou inválido.");
  if (status === 403) throw channelError("PERMISSION_DENIED", "Sem permissão para esta página/perfil — verifique os escopos do token.");
  if (status === 429) throw channelError("RATE_LIMIT", "A Meta limitou as requisições no momento.");
  throw channelError("PROVIDER_ERROR", "Não foi possível validar a conta na Meta agora.");
}

// canPublicReply/canPrivateReply/canDelete/canHide/canLike (item 6/23 do
// plano Social) — matriz explícita do que cada adapter de fato implementa
// (ver meta-graph-messaging.js), nunca por omissão. A UI só pode mostrar um
// botão de ação quando o campo correspondente aqui for true; moderação
// (delete/hide/like) não está implementada em nenhum dos 4 adapters ainda.
class FacebookMessengerAdapter extends ChannelAdapter {
  capabilities() {
    return {
      canReceiveMessages: true, canSendMessages: true, canReceiveMedia: true, canSendMedia: true,
      canMarkRead: true, supportsPublicQuestions: false, supportsReviews: false,
      supportsOAuth: true, supportsWebhook: true,
      canPublicReply: false, canPrivateReply: true, canDelete: false, canHide: false, canLike: false,
    };
  }

  async testConnection() {
    const pageId = this.account?.config?.pageId;
    const token = this.account?.secrets?.pageAccessToken;
    if (!pageId || !token) throw channelError("AUTH_ERROR", "Conta do Facebook Messenger sem pageId/pageAccessToken configurado.");
    try {
      const response = await axios.get(`https://graph.facebook.com/${process.env.GRAPH_VERSION || "v21.0"}/${pageId}`, {
        params: { fields: "id,name", access_token: token }, timeout: 8000,
      });
      return { status: "CONNECTED", externalAccountId: String(response.data?.id || pageId) };
    } catch (error) { mapTestConnectionError(error); }
  }

  async sendMessage({ to, text }) {
    if (!to || !text) throw channelError("INVALID_PAYLOAD", "to e text são obrigatórios para enviar no Messenger.");
    return buildChannel(this.account).sendMessengerText(to, text);
  }

  async sendMedia({ to, type, url }) {
    if (!to) throw channelError("INVALID_PAYLOAD", "to é obrigatório para enviar mídia no Messenger.");
    return buildChannel(this.account).sendMessengerMedia(to, { type, url });
  }

  // Params diferem do WhatsApp de propósito: Messenger marca "visto" por
  // destinatário (PSID), não por id de mensagem específica.
  async markAsRead({ to }) {
    if (!to) throw channelError("INVALID_PAYLOAD", "to (PSID) é obrigatório para marcar como lido no Messenger.");
    return buildChannel(this.account).markMessengerSeen(to);
  }

  normalizeInboundEvent(rawPayload) {
    const events = buildChannel(this.account).parseMessagingWebhook(rawPayload);
    return events.map((event) => ({
      channel: "FACEBOOK_MESSENGER",
      externalConversationId: event.senderExternalId,
      externalMessageId: event.externalId,
      senderExternalId: event.senderExternalId,
      direction: "RECEBIDA",
      type: event.mediaType ? (["image", "video", "audio", "file"].includes(event.mediaType) ? event.mediaType : "document") : "text",
      text: event.text,
      media: event.mediaUrl ? { url: event.mediaUrl, type: event.mediaType } : null,
      occurredAt: event.occurredAt,
      metadata: event.rawPayload,
    }));
  }

  validateWebhook(req) {
    return MetaGraphMessagingChannel.verifySignature(req);
  }

  matchesWebhookPayload(rawPayload) {
    const pageId = this.account?.config?.pageId;
    if (!pageId) return true;
    return (rawPayload?.entry || []).some((entry) => String(entry?.id) === String(pageId));
  }

  async refreshCredentials() {
    throw channelError("NOT_SUPPORTED", "Token de página é configurado manualmente — reconecte com um novo token gerado no Business Manager.");
  }
}

class InstagramDirectAdapter extends ChannelAdapter {
  capabilities() {
    return {
      canReceiveMessages: true, canSendMessages: true, canReceiveMedia: true, canSendMedia: true,
      canMarkRead: true, supportsPublicQuestions: false, supportsReviews: false,
      supportsOAuth: true, supportsWebhook: true,
      canPublicReply: false, canPrivateReply: true, canDelete: false, canHide: false, canLike: false,
    };
  }

  async testConnection() {
    const igUserId = this.account?.config?.igUserId;
    const token = this.account?.secrets?.igAccessToken;
    if (!igUserId || !token) throw channelError("AUTH_ERROR", "Conta do Instagram Direct sem igUserId/igAccessToken configurado.");
    try {
      const response = await axios.get(`https://graph.facebook.com/${process.env.GRAPH_VERSION || "v21.0"}/${igUserId}`, {
        params: { fields: "id,username", access_token: token }, timeout: 8000,
      });
      return { status: "CONNECTED", externalAccountId: String(response.data?.id || igUserId) };
    } catch (error) { mapTestConnectionError(error); }
  }

  async sendMessage({ to, text }) {
    if (!to || !text) throw channelError("INVALID_PAYLOAD", "to e text são obrigatórios para enviar no Instagram Direct.");
    return buildChannel(this.account).sendInstagramText(to, text);
  }

  async sendMedia({ to, type, url }) {
    if (!to) throw channelError("INVALID_PAYLOAD", "to é obrigatório para enviar mídia no Instagram Direct.");
    return buildChannel(this.account).sendInstagramMedia(to, { type, url });
  }

  async markAsRead({ to }) {
    if (!to) throw channelError("INVALID_PAYLOAD", "to (IGSID) é obrigatório para marcar como lido no Instagram Direct.");
    return buildChannel(this.account).markInstagramSeen(to);
  }

  normalizeInboundEvent(rawPayload) {
    const events = buildChannel(this.account).parseMessagingWebhook(rawPayload);
    return events.map((event) => ({
      channel: "INSTAGRAM_DIRECT",
      externalConversationId: event.senderExternalId,
      externalMessageId: event.externalId,
      senderExternalId: event.senderExternalId,
      direction: "RECEBIDA",
      type: event.mediaType ? (["image", "video", "audio", "file"].includes(event.mediaType) ? event.mediaType : "document") : "text",
      text: event.text,
      media: event.mediaUrl ? { url: event.mediaUrl, type: event.mediaType } : null,
      occurredAt: event.occurredAt,
      metadata: event.rawPayload,
    }));
  }

  validateWebhook(req) {
    return MetaGraphMessagingChannel.verifySignature(req);
  }

  matchesWebhookPayload(rawPayload) {
    const igUserId = this.account?.config?.igUserId;
    if (!igUserId) return true;
    return (rawPayload?.entry || []).some((entry) => String(entry?.id) === String(igUserId));
  }

  async refreshCredentials() {
    throw channelError("NOT_SUPPORTED", "Token de perfil é configurado manualmente — reconecte com um novo token.");
  }
}

class FacebookCommentsAdapter extends ChannelAdapter {
  capabilities() {
    return {
      canReceiveMessages: true, canSendMessages: true, canReceiveMedia: false, canSendMedia: false,
      canMarkRead: false, supportsPublicQuestions: true, supportsReviews: false,
      supportsOAuth: true, supportsWebhook: true,
      // Facebook é o único dos dois com endpoint de "curtir comentário"
      // (POST /{comment-id}/likes) — Instagram não tem isso na Graph API.
      canPublicReply: true, canPrivateReply: false, canDelete: true, canHide: true, canLike: true,
    };
  }

  async testConnection() {
    const pageId = this.account?.config?.pageId;
    const token = this.account?.secrets?.pageAccessToken;
    if (!pageId || !token) throw channelError("AUTH_ERROR", "Conta do Facebook Comentários sem pageId/pageAccessToken configurado.");
    try {
      const response = await axios.get(`https://graph.facebook.com/${process.env.GRAPH_VERSION || "v21.0"}/${pageId}`, {
        params: { fields: "id,name", access_token: token }, timeout: 8000,
      });
      return { status: "CONNECTED", externalAccountId: String(response.data?.id || pageId) };
    } catch (error) { mapTestConnectionError(error); }
  }

  // sendMessage aqui é "responder ao comentário" — params: {commentId, text}.
  async sendMessage({ commentId, text }) {
    if (!commentId || !text) throw channelError("INVALID_PAYLOAD", "commentId e text são obrigatórios para responder um comentário do Facebook.");
    return buildChannel(this.account).replyToFacebookComment(commentId, text);
  }

  async deleteComment({ commentId }) {
    if (!commentId) throw channelError("INVALID_PAYLOAD", "commentId é obrigatório para apagar um comentário do Facebook.");
    return buildChannel(this.account).deleteFacebookComment(commentId);
  }

  async hideComment({ commentId, hidden = true }) {
    if (!commentId) throw channelError("INVALID_PAYLOAD", "commentId é obrigatório para ocultar um comentário do Facebook.");
    return buildChannel(this.account).setFacebookCommentHidden(commentId, hidden);
  }

  async likeComment({ commentId, liked = true }) {
    if (!commentId) throw channelError("INVALID_PAYLOAD", "commentId é obrigatório para curtir um comentário do Facebook.");
    return buildChannel(this.account).setFacebookCommentLiked(commentId, liked);
  }

  normalizeInboundEvent(rawPayload) {
    const events = buildChannel(this.account).parseCommentsWebhook(rawPayload);
    return events.map((event) => ({
      channel: "FACEBOOK_COMMENTS",
      externalConversationId: event.externalConversationId,
      externalMessageId: event.externalId,
      senderExternalId: event.senderExternalId,
      senderName: event.senderName,
      direction: "RECEBIDA",
      type: "comment",
      text: event.text,
      occurredAt: event.occurredAt,
      metadata: event.rawPayload,
    }));
  }

  validateWebhook(req) {
    return MetaGraphMessagingChannel.verifySignature(req);
  }

  matchesWebhookPayload(rawPayload) {
    const pageId = this.account?.config?.pageId;
    if (!pageId) return true;
    return (rawPayload?.entry || []).some((entry) => String(entry?.id) === String(pageId));
  }

  async refreshCredentials() {
    throw channelError("NOT_SUPPORTED", "Token de página é configurado manualmente — reconecte com um novo token.");
  }
}

class InstagramCommentsAdapter extends ChannelAdapter {
  capabilities() {
    return {
      canReceiveMessages: true, canSendMessages: true, canReceiveMedia: false, canSendMedia: false,
      canMarkRead: false, supportsPublicQuestions: true, supportsReviews: false,
      supportsOAuth: true, supportsWebhook: true,
      canPublicReply: true, canPrivateReply: false, canDelete: true, canHide: true, canLike: false,
    };
  }

  async testConnection() {
    const igUserId = this.account?.config?.igUserId;
    const token = this.account?.secrets?.igAccessToken;
    if (!igUserId || !token) throw channelError("AUTH_ERROR", "Conta do Instagram Comentários sem igUserId/igAccessToken configurado.");
    try {
      const response = await axios.get(`https://graph.facebook.com/${process.env.GRAPH_VERSION || "v21.0"}/${igUserId}`, {
        params: { fields: "id,username", access_token: token }, timeout: 8000,
      });
      return { status: "CONNECTED", externalAccountId: String(response.data?.id || igUserId) };
    } catch (error) { mapTestConnectionError(error); }
  }

  async sendMessage({ commentId, text }) {
    if (!commentId || !text) throw channelError("INVALID_PAYLOAD", "commentId e text são obrigatórios para responder um comentário do Instagram.");
    return buildChannel(this.account).replyToInstagramComment(commentId, text);
  }

  async deleteComment({ commentId }) {
    if (!commentId) throw channelError("INVALID_PAYLOAD", "commentId é obrigatório para apagar um comentário do Instagram.");
    return buildChannel(this.account).deleteInstagramComment(commentId);
  }

  async hideComment({ commentId, hidden = true }) {
    if (!commentId) throw channelError("INVALID_PAYLOAD", "commentId é obrigatório para ocultar um comentário do Instagram.");
    return buildChannel(this.account).setInstagramCommentHidden(commentId, hidden);
  }

  normalizeInboundEvent(rawPayload) {
    const events = buildChannel(this.account).parseCommentsWebhook(rawPayload);
    return events.map((event) => ({
      channel: "INSTAGRAM_COMMENTS",
      externalConversationId: event.externalConversationId,
      externalMessageId: event.externalId,
      senderExternalId: event.senderExternalId,
      senderName: event.senderName,
      direction: "RECEBIDA",
      type: "comment",
      text: event.text,
      occurredAt: event.occurredAt,
      metadata: event.rawPayload,
    }));
  }

  validateWebhook(req) {
    return MetaGraphMessagingChannel.verifySignature(req);
  }

  matchesWebhookPayload(rawPayload) {
    const igUserId = this.account?.config?.igUserId;
    if (!igUserId) return true;
    return (rawPayload?.entry || []).some((entry) => String(entry?.id) === String(igUserId));
  }

  async refreshCredentials() {
    throw channelError("NOT_SUPPORTED", "Token de perfil é configurado manualmente — reconecte com um novo token.");
  }
}

module.exports = { FacebookMessengerAdapter, InstagramDirectAdapter, FacebookCommentsAdapter, InstagramCommentsAdapter };
