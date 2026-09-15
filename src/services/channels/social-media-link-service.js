// Link público e temporário de mídia (item 46 do plano Social) — a Send API
// do Instagram Direct/Facebook Messenger não aceita upload de buffer como o
// WhatsApp: exige uma URL pública que o servidor da Meta busca sozinho (ver
// meta-graph-messaging.js#sendInstagramMedia/sendMessengerMedia). O arquivo
// já é salvo localmente por media-storage-service.js (mesmo storage do
// WhatsApp) — aqui só assinamos um link de curta duração para esse mesmo
// arquivo, nunca deixando a pasta de mídia inteira pública.
//
// Token = HMAC-SHA256(storageKey + expiresAt) com uma subchave derivada de
// INTEGRATION_ENCRYPTION_KEY (nunca a chave de cifra AES-GCM diretamente —
// contexto de uso diferente). Sem essa variável configurada, envio de mídia
// nestes canais falha com erro claro em vez de usar uma chave fraca.
const crypto = require("node:crypto");
const { channelError } = require("./channel-constants");

const DEFAULT_TTL_SECONDS = 15 * 60;

function loadSigningKey() {
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!raw) {
    throw channelError("NOT_SUPPORTED", "INTEGRATION_ENCRYPTION_KEY não configurada — necessária para gerar o link público de mídia.");
  }
  const material = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  // Subchave derivada (contexto próprio) — nunca reaproveita a chave AES-GCM
  // de segredos de integração diretamente para outro propósito criptográfico.
  return crypto.createHmac("sha256", material).update("social-media-public-link").digest();
}

function sign(storageKey, expiresAt) {
  return crypto.createHmac("sha256", loadSigningKey()).update(`${storageKey}.${expiresAt}`).digest("hex");
}

function buildPublicMediaUrl(storageKey, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  const baseUrl = process.env.PUBLIC_APP_URL;
  if (!baseUrl) {
    throw channelError("NOT_SUPPORTED", "PUBLIC_APP_URL não configurada — necessária para enviar mídia no Instagram/Facebook (a Meta busca a URL publicamente).");
  }
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const token = sign(storageKey, expiresAt);
  return `${baseUrl.replace(/\/+$/, "")}/public/media/${storageKey}/${expiresAt}/${token}`;
}

function verifyMediaToken(storageKey, expiresAtRaw, token) {
  const expiresAt = Number(expiresAtRaw);
  if (!storageKey || !Number.isFinite(expiresAt) || expiresAt < Date.now() || !token) return false;
  const expected = Buffer.from(sign(storageKey, expiresAt));
  const provided = Buffer.from(String(token));
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

module.exports = { buildPublicMediaUrl, verifyMediaToken };
