// Constantes centralizadas da arquitetura omnichannel. Nada aqui deve ser
// duplicado com strings soltas espalhadas pelos adapters/controllers.

// META continua sendo o nome interno do WhatsApp (Meta Cloud API) — ver
// docs/integrations/architecture.md. Não renomeado nesta fase para não
// arriscar regressão na integração já produtiva. É o ÚNICO canal que fica
// fora do master switch/gating de "novos canais" (item 17): Instagram
// Direct/Comentários e Facebook Messenger/Comentários reaproveitam o mesmo
// app Meta/webhook genérico, mas são contas novas, com conta própria por
// página/perfil, e por isso entram em NEW_CHANNELS — precisam do master
// switch ligado e de uma ChannelAccount própria antes de enviar/receber
// qualquer coisa, exatamente como qualquer outro canal novo.
const META_CHANNELS = Object.freeze(["META"]);

const NEW_CHANNELS = Object.freeze([
  "INSTAGRAM_DIRECT", "INSTAGRAM_COMMENTS", "FACEBOOK_MESSENGER", "FACEBOOK_COMMENTS",
  "EMAIL", "MERCADO_LIVRE", "TIKTOK_SHOP", "AMAZON_MARKETPLACE", "SHOPEE", "GOOGLE_REVIEWS", "RECLAME_AQUI",
]);

const ALL_MANAGED_CHANNELS = Object.freeze([...META_CHANNELS, ...NEW_CHANNELS]);

const CHANNEL_LABELS = Object.freeze({
  META: "WhatsApp (Meta)",
  INSTAGRAM_DIRECT: "Instagram Direct",
  INSTAGRAM_COMMENTS: "Instagram Comentários",
  FACEBOOK_MESSENGER: "Facebook Messenger",
  FACEBOOK_COMMENTS: "Facebook Comentários",
  EMAIL: "E-mail",
  MERCADO_LIVRE: "Mercado Livre",
  TIKTOK_SHOP: "TikTok Shop",
  AMAZON_MARKETPLACE: "Amazon Marketplace",
  SHOPEE: "Shopee",
  GOOGLE_REVIEWS: "Google Reviews / Perfil da Empresa",
  RECLAME_AQUI: "Reclame Aqui",
  SHEIN_MARKETPLACE: "SHEIN (não integrado nesta fase)",
  ZENVIA: "Zenvia (legado)",
});

// Tipos internos de conteúdo (item 18) — Message.type continua sendo String
// livre no banco; esta lista é só o vocabulário controlado usado pelo app.
// "comment" cobre comentários públicos de Instagram/Facebook (distinto de
// "question", que é o Q&A do Mercado Livre) — ambos viram ConversationKind
// PUBLIC_QUESTION em omnichannel-message-service.js.
const MESSAGE_TYPES = Object.freeze([
  "text", "image", "video", "audio", "document", "product", "order", "question", "comment", "review", "system", "unknown",
]);

// Erros normalizados (item 40) — todo adapter deve lançar um destes em vez
// de deixar vazar o erro cru do provider. NEEDS_APPROVAL/NEEDS_CONTRACT
// espelham os status homônimos de ChannelAccountStatus (item 14) para uso
// dentro de channelError() quando uma ação falha por esse motivo específico.
const CHANNEL_ERROR_CODES = Object.freeze([
  "AUTH_ERROR", "TOKEN_EXPIRED", "RATE_LIMIT", "PERMISSION_DENIED", "INVALID_PAYLOAD",
  "NOT_SUPPORTED", "TEMPORARY_ERROR", "PROVIDER_ERROR", "NEEDS_APPROVAL", "NEEDS_CONTRACT",
]);

function channelError(code, message, extra = {}) {
  if (!CHANNEL_ERROR_CODES.includes(code)) code = "PROVIDER_ERROR";
  return Object.assign(new Error(message || code), { channelErrorCode: code, ...extra });
}

// Capabilities default — todo adapter parte daqui e só liga o que realmente
// suporta (item 3). Nunca assumir suporte por omissão.
const DEFAULT_CAPABILITIES = Object.freeze({
  canReceiveMessages: false,
  canSendMessages: false,
  canReceiveMedia: false,
  canSendMedia: false,
  canMarkRead: false,
  supportsPublicQuestions: false,
  supportsReviews: false,
  supportsOAuth: false,
  supportsWebhook: false,
  // Matriz de ações (item 6/23 — Social): resposta pública, resposta
  // privada e moderação (delete/hide/like) são capacidades independentes
  // de canSendMessages — um adapter pode enviar mensagem sem poder
  // moderar. Default false em tudo; cada adapter só liga o que implementa.
  canPublicReply: false,
  canPrivateReply: false,
  canDelete: false,
  canHide: false,
  canLike: false,
});

module.exports = {
  ALL_MANAGED_CHANNELS, CHANNEL_ERROR_CODES, CHANNEL_LABELS, DEFAULT_CAPABILITIES,
  META_CHANNELS, MESSAGE_TYPES, NEW_CHANNELS, channelError,
};
