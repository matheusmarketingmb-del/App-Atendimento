// Contrato interno que todo canal implementa (item 3). Nem todo adapter
// precisa suportar tudo — capabilities() diz honestamente o que cada um faz.
// A Central/Bot nunca falam com a API de terceiros diretamente: sempre por
// aqui.
const { DEFAULT_CAPABILITIES, channelError } = require("./channel-constants");

class ChannelAdapter {
  constructor(account) {
    this.account = account || null;
  }

  // Sobrescrever nos adapters concretos com só as capacidades reais.
  capabilities() {
    return { ...DEFAULT_CAPABILITIES };
  }

  async sendMessage(_params) {
    throw channelError("NOT_SUPPORTED", `${this.constructor.name} não suporta envio de mensagens.`);
  }

  async sendMedia(_params) {
    throw channelError("NOT_SUPPORTED", `${this.constructor.name} não suporta envio de mídia.`);
  }

  async markAsRead(_params) {
    throw channelError("NOT_SUPPORTED", `${this.constructor.name} não suporta marcar como lido.`);
  }

  // Moderação de comentário público (item 27/42) — cada método corresponde
  // 1:1 a uma capability (canDelete/canHide/canLike). Nunca sobrescrever sem
  // ligar a capability correspondente, e vice-versa.
  async deleteComment(_params) {
    throw channelError("NOT_SUPPORTED", `${this.constructor.name} não suporta apagar comentário.`);
  }

  async hideComment(_params) {
    throw channelError("NOT_SUPPORTED", `${this.constructor.name} não suporta ocultar comentário.`);
  }

  async likeComment(_params) {
    throw channelError("NOT_SUPPORTED", `${this.constructor.name} não suporta curtir comentário.`);
  }

  async fetchConversation(_params) {
    throw channelError("NOT_SUPPORTED", `${this.constructor.name} não suporta buscar conversa.`);
  }

  async fetchMessages(_params) {
    throw channelError("NOT_SUPPORTED", `${this.constructor.name} não suporta buscar mensagens.`);
  }

  // Converte o payload cru do provider em NormalizedInboundMessage[]
  // (ver channel-event-normalizer.js). Deve ser síncrono/puro sempre que
  // possível — I/O pesado não pertence aqui.
  normalizeInboundEvent(_rawPayload) {
    throw channelError("NOT_SUPPORTED", `${this.constructor.name} não implementa normalização de evento.`);
  }

  // Valida assinatura/origem do webhook quando o provider oferecer. Deve
  // retornar boolean — nunca lançar para não derrubar o endpoint.
  validateWebhook(_req) {
    return false;
  }

  // Quando um canal pode ter múltiplas ChannelAccount (ex.: duas Páginas do
  // Facebook), a rota genérica de webhook usa isto para descobrir qual conta
  // corresponde ao payload recebido, em vez de assumir "a primeira ativada".
  // Default true preserva o comportamento atual para todo adapter que não
  // sobrescreve isto (nenhuma regressão nos canais já existentes).
  matchesWebhookPayload(_rawPayload) {
    return true;
  }

  // Só verifica credenciais/escopo — nunca envia nada real (item 12).
  async testConnection() {
    throw channelError("NOT_SUPPORTED", `${this.constructor.name} não implementa teste de conexão.`);
  }

  async refreshCredentials() {
    throw channelError("NOT_SUPPORTED", `${this.constructor.name} não suporta refresh de credenciais.`);
  }
}

module.exports = { ChannelAdapter };
