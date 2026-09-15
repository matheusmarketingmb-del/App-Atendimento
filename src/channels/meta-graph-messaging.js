// Mensageria/comentários da Meta via Graph API para contas NOVAS (Instagram
// Direct/Comentários, Facebook Messenger/Comentários) — item 6/25. Separado
// de meta-cloud-channel.js de propósito: aquele arquivo é o WhatsApp Cloud
// API já em produção e não deve ser tocado (mesmo app Meta, endpoints e
// forma de autenticação diferentes: Page/IG Access Token por conta, não um
// token único global). Reaproveita GRAPH_VERSION (mesma variável já usada
// pelo WhatsApp) e META_APP_SECRET (mesma validação HMAC de webhook).
const axios = require("axios");
const crypto = require("node:crypto");

function graphVersion() {
  return process.env.GRAPH_VERSION || "v21.0";
}

function apiUrl(resource) {
  return `https://graph.facebook.com/${graphVersion()}/${resource}`;
}

// Mesmo tratamento seguro de erro do meta-cloud-channel.js (nunca vaza
// token/corpo bruto ao cliente, loga só o essencial no servidor).
function providerFailure(error, fallback) {
  const status = error.response?.status;
  const providerError = error.response?.data?.error;
  console.error("Falha segura na Meta Graph API (mensageria):", {
    status, code: providerError?.code, type: providerError?.type, traceId: providerError?.fbtrace_id,
  });
  let message = fallback;
  let statusCode = 502;
  if (status === 401) message = "A Meta recusou o token de acesso da página/perfil. Reconecte a conta.";
  else if (status === 403) message = "Sem permissão para esta ação — verifique os escopos do token (pages_messaging, instagram_manage_messages, etc.).";
  else if (status === 404) message = "Recurso não encontrado na Meta — verifique o ID da página/perfil configurado.";
  else if (status === 429) { message = "A Meta limitou as requisições no momento (rate limit)."; statusCode = 429; }
  else if (status >= 500) message = "A Meta está indisponível no momento. Tente novamente em instantes.";
  else if (status === 400) message = providerError?.error_user_msg || fallback;
  return Object.assign(new Error(message), { statusCode, metaStatus: status || null, metaErrorCode: providerError?.code || null });
}

class MetaGraphMessagingChannel {
  constructor({ config = {}, secrets = {} } = {}) {
    this.pageId = config.pageId || null;
    this.igUserId = config.igUserId || null;
    this.pageAccessToken = secrets.pageAccessToken || null;
    this.igAccessToken = secrets.igAccessToken || null;
  }

  assertMessenger() {
    if (!this.pageId || !this.pageAccessToken) {
      throw Object.assign(new Error("Configure config.pageId e secrets.pageAccessToken para o Facebook Messenger/Comentários."), { statusCode: 400, channelErrorCode: "AUTH_ERROR" });
    }
  }

  assertInstagram() {
    if (!this.igUserId || !this.igAccessToken) {
      throw Object.assign(new Error("Configure config.igUserId e secrets.igAccessToken para o Instagram Direct/Comentários."), { statusCode: 400, channelErrorCode: "AUTH_ERROR" });
    }
  }

  async sendMessengerText(psid, text) {
    this.assertMessenger();
    try {
      const response = await axios.post(apiUrl(`${this.pageId}/messages`), {
        recipient: { id: psid }, message: { text }, messaging_type: "RESPONSE",
      }, { params: { access_token: this.pageAccessToken } });
      return { externalId: response.data?.message_id, data: response.data };
    } catch (error) {
      throw providerFailure(error, "A Meta não aceitou o envio da mensagem no Messenger.");
    }
  }

  // A Send API não tem campo de legenda para anexos (diferente do WhatsApp)
  // — qualquer "caption" recebido é ignorado de propósito, nunca inventado.
  async sendMessengerMedia(psid, { type = "image", url } = {}) {
    this.assertMessenger();
    if (!url) throw Object.assign(new Error("Envio de mídia no Messenger exige uma URL pública (upload direto ainda não implementado)."), { statusCode: 400, channelErrorCode: "INVALID_PAYLOAD" });
    try {
      const response = await axios.post(apiUrl(`${this.pageId}/messages`), {
        recipient: { id: psid },
        message: { attachment: { type, payload: { url, is_reusable: true } } },
        messaging_type: "RESPONSE",
      }, { params: { access_token: this.pageAccessToken } });
      return { externalId: response.data?.message_id, data: response.data };
    } catch (error) {
      throw providerFailure(error, "A Meta não aceitou o envio de mídia no Messenger.");
    }
  }

  async markMessengerSeen(psid) {
    this.assertMessenger();
    try {
      const response = await axios.post(apiUrl(`${this.pageId}/messages`), {
        recipient: { id: psid }, sender_action: "mark_seen",
      }, { params: { access_token: this.pageAccessToken } });
      return response.data;
    } catch (error) {
      throw providerFailure(error, "A Meta não aceitou a confirmação de leitura no Messenger.");
    }
  }

  async sendInstagramText(igsid, text) {
    this.assertInstagram();
    try {
      const response = await axios.post(apiUrl(`${this.igUserId}/messages`), {
        recipient: { id: igsid }, message: { text },
      }, { params: { access_token: this.igAccessToken } });
      return { externalId: response.data?.message_id, data: response.data };
    } catch (error) {
      throw providerFailure(error, "A Meta não aceitou o envio da mensagem no Instagram Direct.");
    }
  }

  async sendInstagramMedia(igsid, { type = "image", url } = {}) {
    this.assertInstagram();
    if (!url) throw Object.assign(new Error("Envio de mídia no Instagram Direct exige uma URL pública (upload direto ainda não implementado)."), { statusCode: 400, channelErrorCode: "INVALID_PAYLOAD" });
    try {
      const response = await axios.post(apiUrl(`${this.igUserId}/messages`), {
        recipient: { id: igsid }, message: { attachment: { type, payload: { url } } },
      }, { params: { access_token: this.igAccessToken } });
      return { externalId: response.data?.message_id, data: response.data };
    } catch (error) {
      throw providerFailure(error, "A Meta não aceitou o envio de mídia no Instagram Direct.");
    }
  }

  async markInstagramSeen(igsid) {
    this.assertInstagram();
    try {
      const response = await axios.post(apiUrl(`${this.igUserId}/messages`), {
        recipient: { id: igsid }, sender_action: "mark_seen",
      }, { params: { access_token: this.igAccessToken } });
      return response.data;
    } catch (error) {
      throw providerFailure(error, "A Meta não aceitou a confirmação de leitura no Instagram Direct.");
    }
  }

  // Reply público (cria um comentário-filho) — não é DM. Endpoints oficiais
  // e estáveis da Graph API: POST /{comment-id}/comments (Facebook) e
  // POST /{ig-comment-id}/replies (Instagram).
  async replyToFacebookComment(commentId, text) {
    this.assertMessenger();
    try {
      const response = await axios.post(apiUrl(`${commentId}/comments`), { message: text }, {
        params: { access_token: this.pageAccessToken },
      });
      return { externalId: response.data?.id, data: response.data };
    } catch (error) {
      throw providerFailure(error, "A Meta não aceitou a resposta ao comentário do Facebook.");
    }
  }

  async replyToInstagramComment(commentId, text) {
    this.assertInstagram();
    try {
      const response = await axios.post(apiUrl(`${commentId}/replies`), { message: text }, {
        params: { access_token: this.igAccessToken },
      });
      return { externalId: response.data?.id, data: response.data };
    } catch (error) {
      throw providerFailure(error, "A Meta não aceitou a resposta ao comentário do Instagram.");
    }
  }

  // Moderação (item 27/42 do plano Social) — só os endpoints que a Graph API
  // de fato documenta para comentário de Página/Instagram. Instagram NÃO tem
  // endpoint de "curtir comentário" pela API — por isso não existe
  // likeInstagramComment aqui (capabilities.canLike do adapter reflete isso).
  async deleteFacebookComment(commentId) {
    this.assertMessenger();
    try {
      const response = await axios.delete(apiUrl(commentId), { params: { access_token: this.pageAccessToken } });
      return { data: response.data };
    } catch (error) {
      throw providerFailure(error, "A Meta não aceitou apagar o comentário do Facebook.");
    }
  }

  async setFacebookCommentHidden(commentId, hidden) {
    this.assertMessenger();
    try {
      const response = await axios.post(apiUrl(commentId), null, {
        params: { is_hidden: Boolean(hidden), access_token: this.pageAccessToken },
      });
      return { data: response.data };
    } catch (error) {
      throw providerFailure(error, "A Meta não aceitou ocultar/reexibir o comentário do Facebook.");
    }
  }

  async setFacebookCommentLiked(commentId, liked) {
    this.assertMessenger();
    try {
      const config = { params: { access_token: this.pageAccessToken } };
      const response = liked
        ? await axios.post(apiUrl(`${commentId}/likes`), null, config)
        : await axios.delete(apiUrl(`${commentId}/likes`), config);
      return { data: response.data };
    } catch (error) {
      throw providerFailure(error, "A Meta não aceitou curtir/descurtir o comentário do Facebook.");
    }
  }

  async deleteInstagramComment(commentId) {
    this.assertInstagram();
    try {
      const response = await axios.delete(apiUrl(commentId), { params: { access_token: this.igAccessToken } });
      return { data: response.data };
    } catch (error) {
      throw providerFailure(error, "A Meta não aceitou apagar o comentário do Instagram.");
    }
  }

  async setInstagramCommentHidden(commentId, hidden) {
    this.assertInstagram();
    try {
      const response = await axios.post(apiUrl(commentId), null, {
        params: { hide: Boolean(hidden), access_token: this.igAccessToken },
      });
      return { data: response.data };
    } catch (error) {
      throw providerFailure(error, "A Meta não aceitou ocultar/reexibir o comentário do Instagram.");
    }
  }

  // entry[].messaging[] — formato comum a Messenger e Instagram Direct
  // (webhook object "page" ou "instagram"). Ignora silenciosamente subtipos
  // que não são mensagem de texto/mídia (delivery/read/postback) nesta fase.
  parseMessagingWebhook(body) {
    const events = [];
    for (const entry of body?.entry || []) {
      for (const item of entry?.messaging || []) {
        if (!item?.message || item.message.is_echo) continue; // ignora eco do próprio envio
        const attachment = item.message.attachments?.[0] || null;
        events.push({
          kind: "message",
          recipientEntryId: entry.id || null,
          externalId: item.message.mid,
          senderExternalId: item.sender?.id || null,
          text: item.message.text || (attachment ? `[${attachment.type}]` : ""),
          mediaUrl: attachment?.payload?.url || null,
          mediaType: attachment?.type || null,
          occurredAt: item.timestamp ? new Date(Number(item.timestamp)) : new Date(),
          rawPayload: item,
        });
      }
    }
    return events;
  }

  // entry[].changes[] com field "feed" (Facebook) ou "comments" (Instagram).
  parseCommentsWebhook(body) {
    const events = [];
    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        const value = change?.value || {};
        const isFacebookComment = change.field === "feed" && value.item === "comment" && value.verb === "add";
        const isInstagramComment = change.field === "comments";
        if (!isFacebookComment && !isInstagramComment) continue;
        const commentId = value.comment_id || value.id;
        if (!commentId) continue;
        events.push({
          kind: "comment",
          recipientEntryId: entry.id || null,
          externalId: commentId,
          externalConversationId: value.post_id || value.media?.id || null,
          senderExternalId: value.from?.id ? String(value.from.id) : null,
          senderName: value.from?.name || value.from?.username || null,
          text: value.message || value.text || "",
          occurredAt: value.created_time ? new Date(Number(value.created_time) * 1000) : new Date(),
          rawPayload: value,
        });
      }
    }
    return events;
  }

  // Mesma verificação HMAC do middleware/meta-signature.js (WhatsApp),
  // reimplementada aqui como função pura para uso pelos adapters de
  // Instagram/Facebook — não importa o middleware para não criar
  // acoplamento entre a rota própria do WhatsApp e o webhook genérico.
  static verifySignature(req) {
    const appSecret = process.env.META_APP_SECRET;
    if (!appSecret) return process.env.NODE_ENV !== "production";
    const provided = req.get ? req.get("x-hub-signature-256") : req.headers?.["x-hub-signature-256"];
    if (!provided || !req.rawBody) return false;
    const expected = `sha256=${crypto.createHmac("sha256", appSecret).update(req.rawBody).digest("hex")}`;
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);
    if (expectedBuffer.length !== providedBuffer.length) return false;
    return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  }
}

module.exports = MetaGraphMessagingChannel;
