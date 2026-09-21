// Adapter que ENVOLVE a integração Meta/WhatsApp já existente
// (src/channels/meta-cloud-channel.js) na nova interface ChannelAdapter,
// preservando o fluxo legado por ENV e permitindo credenciais isoladas por conta. Todo
// método aqui delega para a classe já testada e em produção.
const { ChannelAdapter } = require("./channel-adapter");
const MetaCloudChannel = require("../../channels/meta-cloud-channel");

class MetaAdapter extends ChannelAdapter {
  constructor(account, channel = null) {
    super(account);
    this.channel = channel || new MetaCloudChannel(account ? {
      graphVersion: account.config?.graphVersion,
      phoneNumberId: account.config?.phoneNumberId || account.externalAccountId,
      wabaId: account.config?.wabaId,
      accessToken: account.secrets?.accessToken,
    } : {});
  }

  capabilities() {
    return {
      canReceiveMessages: true,
      canSendMessages: true,
      canReceiveMedia: true,
      canSendMedia: true,
      canMarkRead: true,
      supportsPublicQuestions: false,
      supportsReviews: false,
      supportsOAuth: false,
      supportsWebhook: true,
    };
  }

  async listMessageTemplates() { return this.channel.listMessageTemplates(); }
  async listAllMessageTemplates() { return this.channel.listAllMessageTemplates(); }
  async inspectAccessTokenScopes() { return this.channel.inspectAccessTokenScopes(); }
  async sendTemplate({ to, name, language, components }) { return this.channel.sendTemplate(to, { name, language, components }); }

  async sendMessage({ to, text }) {
    return this.channel.sendText(to, text);
  }

  async sendMedia({ to, type, buffer, mimeType, fileName, caption }) {
    const method = { image: "sendImage", video: "sendVideo", document: "sendDocument" }[type];
    if (!method) throw new Error(`Tipo de mídia não suportado pelo WhatsApp: ${type}`);
    return this.channel[method](to, { buffer, mimeType, fileName, caption });
  }

  async markAsRead({ externalMessageId }) {
    return this.channel.markAsRead(externalMessageId);
  }

  normalizeInboundEvent(rawPayload) {
    // A Meta já é tratada pelo webhook/pipeline próprios (app.js + message-
    // service.js); este método existe só para completude da interface —
    // não é usado no fluxo real do WhatsApp nesta fase.
    return this.channel.parseWebhook(rawPayload);
  }

  async testConnection() {
    this.channel.assertConfigured();
    const phone = await this.channel.getPhoneNumberProfile();
    if (!phone?.id || phone.id !== this.channel.phoneNumberId) {
      throw Object.assign(new Error("O Phone Number ID retornado pela Meta não corresponde à conta configurada."), {
        statusCode: 400, channelErrorCode: "ACCOUNT_MISMATCH",
      });
    }
    if (this.channel.wabaId) {
      const phones = await this.channel.listWabaPhoneNumbers();
      if (!phones.some((item) => item.id === this.channel.phoneNumberId)) {
        throw Object.assign(new Error("O número não pertence ao WABA configurado."), {
          statusCode: 400, channelErrorCode: "ACCOUNT_MISMATCH",
        });
      }
    }
    return {
      status: "CONNECTED",
      externalAccountId: phone.id,
      providerMetadata: {
        displayName: phone.verified_name || this.account?.name || null,
        username: phone.display_phone_number || this.account?.config?.displayPhoneNumber || null,
        qualityRating: phone.quality_rating || null,
      },
      message: `Número ${phone.display_phone_number || phone.id} validado diretamente na Meta.`,
    };
  }
}

module.exports = { MetaAdapter };
