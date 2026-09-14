// Vocabulário controlado do Relatório de Conversas — espelha os enums do
// schema.prisma (nunca strings soltas na validação de filtros nem na UI).
const CONVERSATION_STATUSES = ["NOVO", "EM_ATENDIMENTO", "AGUARDANDO_EQUIPE", "AGUARDANDO_CLIENTE", "HANDOFF_BOT", "BOT", "FINALIZADO"];
const CONVERSATION_PRIORITIES = ["NORMAL", "ALTA", "URGENTE"];
const CHANNELS = [
  "META", "INSTAGRAM_DIRECT", "INSTAGRAM_COMMENTS", "FACEBOOK_MESSENGER", "FACEBOOK_COMMENTS", "EMAIL",
  "MERCADO_LIVRE", "TIKTOK_SHOP", "AMAZON_MARKETPLACE", "SHOPEE", "SHEIN_MARKETPLACE", "GOOGLE_REVIEWS", "RECLAME_AQUI", "ZENVIA",
];

const STATUS_LABELS = {
  NOVO: "Novo", EM_ATENDIMENTO: "Em atendimento", AGUARDANDO_EQUIPE: "Aguardando equipe",
  AGUARDANDO_CLIENTE: "Aguardando cliente", HANDOFF_BOT: "Encaminhado (Bot)", BOT: "Com o Bot", FINALIZADO: "Finalizado",
};
const CHANNEL_LABELS = {
  META: "WhatsApp", INSTAGRAM_DIRECT: "Instagram (Direct)", INSTAGRAM_COMMENTS: "Instagram (Comentários)",
  FACEBOOK_MESSENGER: "Facebook (Messenger)", FACEBOOK_COMMENTS: "Facebook (Comentários)", EMAIL: "E-mail",
  MERCADO_LIVRE: "Mercado Livre", TIKTOK_SHOP: "TikTok Shop", AMAZON_MARKETPLACE: "Amazon",
  SHOPEE: "Shopee", SHEIN_MARKETPLACE: "Shein", GOOGLE_REVIEWS: "Google Reviews", RECLAME_AQUI: "Reclame Aqui", ZENVIA: "Zenvia (legado)",
};

module.exports = { CONVERSATION_STATUSES, CONVERSATION_PRIORITIES, CHANNELS, STATUS_LABELS, CHANNEL_LABELS };
