const axios = require("axios");

// Multiempresa: uma instância pode ficar ligada a um número específico
// (forAccount) — phoneNumberId/wabaId/token da ChannelAccount. Sem conta,
// usa o .env (número original), exatamente como antes.
class MetaCloudChannel {
  constructor({ phoneNumberId = null, wabaId = null, token = null, accountId = null } = {}) {
    this.boundPhoneNumberId = phoneNumberId;
    this.boundWabaId = wabaId;
    this.boundToken = token;
    this.accountId = accountId;
  }

  forAccount(account) {
    const accounts = require("../services/whatsapp-account-service");
    return new MetaCloudChannel({
      accountId: account?.id || null,
      phoneNumberId: accounts.phoneNumberIdOf(account),
      wabaId: accounts.wabaIdOf(account),
      token: accounts.accessTokenOf(account),
    });
  }

  phoneNumberId() { return this.boundPhoneNumberId || process.env.PHONE_NUMBER_ID; }
  wabaId() { return this.boundWabaId || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID; }
  token() { return this.boundToken || process.env.WHATSAPP_TOKEN; }

  assertConfigured() {
    if (!process.env.GRAPH_VERSION) {
      throw Object.assign(new Error("Integração com a Meta não está configurada (variável ausente: GRAPH_VERSION)."), { statusCode: 503 });
    }
    if (!this.phoneNumberId()) {
      throw Object.assign(new Error("Número de WhatsApp sem Phone Number ID configurado."), { statusCode: 503 });
    }
    if (!this.token()) {
      throw Object.assign(new Error("Integração com a Meta não está configurada (token de acesso ausente)."), { statusCode: 503 });
    }
  }

  assertTemplatesConfigured() {
    this.assertConfigured();
    if (!this.wabaId()) {
      throw Object.assign(new Error("Configure o WABA ID deste número para consultar os templates da Meta."), { statusCode: 503 });
    }
  }

  apiUrl(resource) {
    return `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${resource}`;
  }

  authHeaders() {
    return { Authorization: `Bearer ${this.token()}` };
  }

  // Mapeia falhas da Graph API para uma mensagem clara e um status HTTP
  // previsível, sem nunca vazar o token/credencial — o log (sanitizado,
  // sem o corpo bruto da resposta nem headers de auth) fica só no servidor;
  // o cliente recebe apenas mensagem + status.
  providerFailure(error, fallback) {
    const status = error.response?.status;
    const providerError = error.response?.data?.error;
    console.error("Falha segura na Meta Cloud API:", {
      status, code: providerError?.code, type: providerError?.type, traceId: providerError?.fbtrace_id,
    });
    let message = fallback;
    let statusCode = 502;
    if (status === 401) {
      message = "A Meta recusou a credencial do WhatsApp. Atualize o token de acesso.";
    } else if (status === 403) {
      message = "A conta não tem permissão para esta operação na Meta — verifique os escopos do token e o acesso ao WABA.";
    } else if (status === 404) {
      message = "Recurso não encontrado na Meta — verifique o WABA ID / Phone Number ID configurados.";
    } else if (status === 429) {
      message = "A Meta limitou as requisições no momento (rate limit). Tente novamente em instantes.";
      statusCode = 429;
    } else if (status >= 500) {
      message = "A Meta está indisponível no momento. Tente novamente em instantes.";
    } else if (status === 400) {
      // error_user_msg é o único campo do erro da Meta pensado para ser
      // mostrado ao usuário final — nunca repassamos o corpo bruto do erro.
      message = providerError?.error_user_msg || fallback;
    }
    return Object.assign(new Error(message), { statusCode, metaStatus: status || null, metaErrorCode: providerError?.code || null });
  }

  parseWebhook(body) {
    const events = [];
    for (const entry of body?.entry || []) for (const change of entry?.changes || []) {
      const value = change?.value || {};
      // Multiempresa: número que recebeu o evento — define a ChannelAccount
      // (e portanto a empresa) da conversa.
      const phoneNumberId = value.metadata?.phone_number_id || null;
      const displayPhoneNumber = value.metadata?.display_phone_number || null;
      const contacts = new Map((value.contacts || []).map((item) => [item.wa_id, item]));
      for (const message of value.messages || []) {
        const contact = contacts.get(message.from) || value.contacts?.[0];
        const media = ({ image: message.image, audio: message.audio, video: message.video, sticker: message.sticker, document: message.document })[message.type] || null;
        const interactiveReply = message.interactive?.button_reply || message.interactive?.list_reply || null;
        const reaction = message.type === "reaction" ? message.reaction : null;
        events.push({
          kind: "message", externalId: message.id, contactExternalId: message.from, phoneNumberId, displayPhoneNumber,
          phone: message.from, contactName: contact?.profile?.name || message.from,
          type: message.type,
          text: message.type === "text" ? message.text?.body
            : reaction ? reaction.emoji || "" : interactiveReply?.title || media?.caption || `[${message.type}]`,
          interactiveReplyId: interactiveReply?.id || null,
          reactionToExternalId: reaction?.message_id || null,
          reactionEmoji: reaction?.emoji ?? null,
          mediaId: media?.id, mediaMimeType: media?.mime_type,
          mediaFileName: media?.filename || null,
          occurredAt: new Date(Number(message.timestamp) * 1000), rawPayload: message,
        });
      }
      for (const status of value.statuses || []) events.push({
        kind: "status", externalId: status.id, status: status.status, phoneNumberId,
        occurredAt: new Date(Number(status.timestamp) * 1000), rawPayload: status,
      });
    }
    return events;
  }

  async sendText(to, text) {
    this.assertConfigured();
    try {
      const response = await axios.post(this.apiUrl(`${this.phoneNumberId()}/messages`), {
        messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: text },
      }, { headers: { ...this.authHeaders(), "Content-Type": "application/json" } });
      return { externalId: response.data?.messages?.[0]?.id, data: response.data };
    } catch (error) {
      throw this.providerFailure(error, "A Meta não aceitou o envio da mensagem.");
    }
  }

  async sendList(to, { body, button, rows }) {
    this.assertConfigured();
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 10) {
      throw Object.assign(new Error("A lista interativa deve ter entre 1 e 10 opções."), { statusCode: 400 });
    }
    try {
      const response = await axios.post(this.apiUrl(`${this.phoneNumberId()}/messages`), {
        messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive",
        interactive: {
          type: "list", body: { text: body },
          action: { button, sections: [{ title: "Setores", rows }] },
        },
      }, { headers: { ...this.authHeaders(), "Content-Type": "application/json" } });
      return { externalId: response.data?.messages?.[0]?.id, data: response.data };
    } catch (error) {
      throw this.providerFailure(error, "A Meta não aceitou o envio da lista de setores.");
    }
  }

  async listMessageTemplates() {
    this.assertTemplatesConfigured();
    const templates = [];
    let after;
    try {
      for (let page = 0; page < 20; page += 1) {
        const response = await axios.get(this.apiUrl(`${this.wabaId()}/message_templates`), {
          headers: this.authHeaders(),
          params: {
            fields: "id,name,language,status,category,components",
            limit: 100,
            ...(after ? { after } : {}),
          },
        });
        const page_data = Array.isArray(response.data?.data) ? response.data.data : [];
        templates.push(...page_data);
        const nextAfter = response.data?.paging?.cursors?.after;
        if (!response.data?.paging?.next || !nextAfter || nextAfter === after) break;
        after = nextAfter;
      }
      // Item 3 (só templates utilizáveis por padrão): filtra por status e
      // descarta qualquer item malformado (sem id/name) antes de devolver —
      // nunca deixa um item quebrado derrubar o normalizador no service.
      return templates.filter((template) => template && typeof template === "object" && template.status === "APPROVED" && template.id && template.name);
    } catch (error) {
      if (error.statusCode) throw error;
      throw this.providerFailure(error, "Não foi possível consultar os templates aprovados na Meta.");
    }
  }

  async sendTemplate(to, { name, language, components = [] }) {
    this.assertConfigured();
    try {
      const response = await axios.post(this.apiUrl(`${this.phoneNumberId()}/messages`), {
        messaging_product: "whatsapp", recipient_type: "individual", to, type: "template",
        template: {
          name,
          language: { code: language },
          ...(components.length ? { components } : {}),
        },
      }, { headers: { ...this.authHeaders(), "Content-Type": "application/json" } });
      return { externalId: response.data?.messages?.[0]?.id, data: response.data };
    } catch (error) {
      throw this.providerFailure(error, "A Meta não aceitou o envio do template.");
    }
  }

  async markAsRead(messageId) {
    this.assertConfigured();
    try {
      const response = await axios.put(this.apiUrl(`${this.phoneNumberId()}/messages`), {
        messaging_product: "whatsapp", status: "read", message_id: messageId,
      }, { headers: { ...this.authHeaders(), "Content-Type": "application/json" } });
      return response.data;
    } catch (error) {
      throw this.providerFailure(error, "A Meta não aceitou a confirmação de leitura.");
    }
  }

  async downloadMedia(mediaId, { maxSize = 16 * 1024 * 1024 } = {}) {
    this.assertConfigured();
    try {
      const metadata = await axios.get(this.apiUrl(mediaId), {
        params: { phone_number_id: this.phoneNumberId() }, headers: this.authHeaders(),
      });
      const mediaUrl = new URL(metadata.data.url);
      const allowedHost = ["facebook.com", "fbcdn.net", "fbsbx.com"]
        .some((domain) => mediaUrl.hostname === domain || mediaUrl.hostname.endsWith(`.${domain}`));
      if (mediaUrl.protocol !== "https:" || !allowedHost) throw new Error("URL de mídia inesperada.");
      const media = await axios.get(mediaUrl.toString(), {
        responseType: "arraybuffer", headers: this.authHeaders(),
        maxContentLength: maxSize, maxBodyLength: maxSize,
      });
      const mimeType = String(metadata.data.mime_type || media.headers["content-type"] || "").split(";", 1)[0].toLowerCase();
      const extension = ({
        "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "audio/aac": "aac", "audio/mp4": "m4a",
        "audio/mpeg": "mp3", "audio/amr": "amr", "audio/ogg": "ogg",
        "video/mp4": "mp4", "video/3gpp": "3gp", "video/3gp": "3gp",
        "application/pdf": "pdf", "text/plain": "txt", "application/msword": "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
        "application/vnd.ms-excel": "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
        "application/vnd.ms-powerpoint": "ppt",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
      })[mimeType] || "bin";
      const mediaKind = ["pdf", "txt", "doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(extension) ? "documento"
        : mimeType === "image/webp" ? "figurinha"
        : (mimeType.startsWith("audio/") ? "audio" : (mimeType.startsWith("video/") ? "video" : "imagem"));
      return {
        buffer: Buffer.from(media.data), mimeType,
        fileName: `${mediaKind}-${mediaId}.${extension}`,
      };
    } catch (error) {
      throw this.providerFailure(error, "Não foi possível baixar a mídia recebida.");
    }
  }

  async sendImage(to, { buffer, mimeType, fileName, caption }) {
    this.assertConfigured();
    try {
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("file", new Blob([buffer], { type: mimeType }), fileName);
      const upload = await axios.post(this.apiUrl(`${this.phoneNumberId()}/media`), form, {
        headers: this.authHeaders(), maxBodyLength: 5 * 1024 * 1024,
      });
      const response = await axios.post(this.apiUrl(`${this.phoneNumberId()}/messages`), {
        messaging_product: "whatsapp", recipient_type: "individual", to, type: "image",
        image: { id: upload.data.id, ...(caption ? { caption } : {}) },
      }, { headers: { ...this.authHeaders(), "Content-Type": "application/json" } });
      return { externalId: response.data?.messages?.[0]?.id, mediaId: upload.data.id, data: response.data };
    } catch (error) {
      throw this.providerFailure(error, "A Meta não aceitou o envio da imagem.");
    }
  }

  async sendVideo(to, { buffer, mimeType, fileName, caption }) {
    this.assertConfigured();
    try {
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("file", new Blob([buffer], { type: mimeType }), fileName);
      const upload = await axios.post(this.apiUrl(`${this.phoneNumberId()}/media`), form, {
        headers: this.authHeaders(), maxBodyLength: 17 * 1024 * 1024,
      });
      const response = await axios.post(this.apiUrl(`${this.phoneNumberId()}/messages`), {
        messaging_product: "whatsapp", recipient_type: "individual", to, type: "video",
        video: { id: upload.data.id, ...(caption ? { caption } : {}) },
      }, { headers: { ...this.authHeaders(), "Content-Type": "application/json" } });
      return { externalId: response.data?.messages?.[0]?.id, mediaId: upload.data.id, data: response.data };
    } catch (error) {
      throw this.providerFailure(error, "A Meta não aceitou o envio do vídeo.");
    }
  }

  // Áudio não aceita legenda na Cloud API. Formatos aceitos: AAC, AMR, MP3,
  // MP4 e OGG (somente Opus) — a normalização acontece antes, em
  // audio-normalization-service.js.
  async sendAudio(to, { buffer, mimeType, fileName }) {
    this.assertConfigured();
    try {
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("file", new Blob([buffer], { type: mimeType }), fileName);
      const upload = await axios.post(this.apiUrl(`${this.phoneNumberId()}/media`), form, {
        headers: this.authHeaders(), maxBodyLength: 17 * 1024 * 1024,
      });
      const response = await axios.post(this.apiUrl(`${this.phoneNumberId()}/messages`), {
        messaging_product: "whatsapp", recipient_type: "individual", to, type: "audio",
        audio: { id: upload.data.id },
      }, { headers: { ...this.authHeaders(), "Content-Type": "application/json" } });
      return { externalId: response.data?.messages?.[0]?.id, mediaId: upload.data.id, data: response.data };
    } catch (error) {
      throw this.providerFailure(error, "A Meta não aceitou o envio do áudio.");
    }
  }

  async sendDocument(to, { buffer, mimeType, fileName, caption }) {
    this.assertConfigured();
    try {
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("file", new Blob([buffer], { type: mimeType }), fileName);
      const upload = await axios.post(this.apiUrl(`${this.phoneNumberId()}/media`), form, {
        headers: this.authHeaders(), maxBodyLength: 101 * 1024 * 1024,
      });
      const response = await axios.post(this.apiUrl(`${this.phoneNumberId()}/messages`), {
        messaging_product: "whatsapp", recipient_type: "individual", to, type: "document",
        document: { id: upload.data.id, filename: fileName, ...(caption ? { caption } : {}) },
      }, { headers: { ...this.authHeaders(), "Content-Type": "application/json" } });
      return { externalId: response.data?.messages?.[0]?.id, mediaId: upload.data.id, data: response.data };
    } catch (error) {
      throw this.providerFailure(error, "A Meta não aceitou o envio do documento.");
    }
  }
}

module.exports = MetaCloudChannel;
