// Flags dos recursos de chat. Tudo desligado por padrão: a Central se comporta
// como antes até cada módulo ser ligado por variável de ambiente.
const FLAGS = Object.freeze({
  reply: "CHAT_REPLY_ENABLED",
  reactions: "CHAT_REACTIONS_ENABLED",
  stickers: "CHAT_STICKERS_ENABLED",
  gifs: "CHAT_GIFS_ENABLED",
  stars: "CHAT_STARS_ENABLED",
  pins: "CHAT_PINS_ENABLED",
  search: "CHAT_SEARCH_ENABLED",
  forward: "CHAT_FORWARD_ENABLED",
  emoji: "CHAT_EMOJI_ENABLED",
  media: "CHAT_MEDIA_VIEWER_ENABLED",
  internalReactions: "CHAT_INTERNAL_REACTIONS_ENABLED",
});

const META_CONTEXT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
let configured = Object.freeze({});

function setConfigured(values) {
  configured = Object.freeze(Object.fromEntries(Object.keys(FLAGS)
    .filter(key => typeof values?.[key] === "boolean").map(key => [key, values[key]])));
}

function isEnabled(name) {
  return configured[name] ?? (process.env[FLAGS[name]] === "true");
}

function assertEnabled(name) {
  if (isEnabled(name)) return;
  throw Object.assign(new Error("Este recurso não está habilitado."), { statusCode: 404, code: "FEATURE_DISABLED" });
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function publicFeatures() {
  return {
    ...Object.fromEntries(Object.keys(FLAGS).map((name) => [name, isEnabled(name)])),
    pinLimit: pinLimit(),
  };
}

function pinLimit() {
  return numberEnv("CHAT_PIN_LIMIT", 3);
}

// Mídia enviada guarda `contaId:wamid`; texto guarda o wamid cru. A Meta só
// conhece o wamid cru: nunca usar o ID interno nem o prefixado em chamadas.
function rawWamid(message) {
  const value = message?.externalId;
  if (!value) return null;
  const account = message.channelAccountId;
  const raw = account && value.startsWith(`${account}:`) ? value.slice(account.length + 1) : value;
  return raw.startsWith("wamid.") ? raw : null;
}

function externalIdCandidates(wamid, channelAccountId) {
  return channelAccountId ? [wamid, `${channelAccountId}:${wamid}`] : [wamid];
}

// Um único emoji (grafema), ou vazio para remover. Sequências com ZWJ, tons de
// pele e bandeiras contam como um grafema.
function normalizeEmoji(value) {
  if (value === "" || value === null || value === undefined) return "";
  if (typeof value !== "string" || value.length > 32) throw invalidEmoji();
  const text = value.trim();
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
  if (graphemes.length !== 1 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(text)) throw invalidEmoji();
  return text;
}

function invalidEmoji() {
  return Object.assign(new Error("Escolha um único emoji."), { statusCode: 400, code: "INVALID_EMOJI" });
}

function olderThanMetaContext(occurredAt, now = new Date()) {
  return now.getTime() - new Date(occurredAt).getTime() > META_CONTEXT_MAX_AGE_MS;
}

module.exports = {
  FLAGS, META_CONTEXT_MAX_AGE_MS, assertEnabled, externalIdCandidates, isEnabled, normalizeEmoji,
  numberEnv, olderThanMetaContext, pinLimit, publicFeatures, rawWamid, setConfigured,
};
