const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { assessFileRisk } = require("./file-risk-service");

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_STICKER_SIZE = 500 * 1024;
const MAX_AUDIO_SIZE = 16 * 1024 * 1024;
const MAX_VIDEO_SIZE = 16 * 1024 * 1024;
const MAX_DOCUMENT_SIZE = 100 * 1024 * 1024;
const MAX_INTERNAL_FILE_SIZE = 100 * 1024 * 1024;
const documentMimeTypes = new Set([
  "text/plain", "application/pdf", "application/msword", "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const mediaExtensions = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["audio/aac", ".aac"],
  ["audio/mp4", ".m4a"],
  ["audio/mpeg", ".mp3"],
  ["audio/amr", ".amr"],
  ["audio/ogg", ".ogg"],
  ["video/mp4", ".mp4"],
  ["video/3gpp", ".3gp"],
  ["video/3gp", ".3gp"],
  ["application/pdf", ".pdf"],
  ["text/plain", ".txt"],
  ["application/msword", ".doc"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["application/vnd.ms-excel", ".xls"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  ["application/vnd.ms-powerpoint", ".ppt"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
]);

function normalizeMimeType(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function validateImage({ buffer, mimeType }) {
  mimeType = normalizeMimeType(mimeType);
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw Object.assign(new Error("A imagem está vazia."), { statusCode: 400 });
  }
  if (buffer.length > MAX_IMAGE_SIZE) {
    throw Object.assign(new Error("A imagem deve ter no máximo 5 MB."), { statusCode: 413 });
  }
  if (!["image/jpeg", "image/png"].includes(mimeType)) {
    throw Object.assign(new Error("Envie uma imagem JPG ou PNG."), { statusCode: 400 });
  }
  const validJpeg = mimeType === "image/jpeg" && buffer.length >= 3
    && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const validPng = mimeType === "image/png" && buffer.length >= pngSignature.length
    && buffer.subarray(0, pngSignature.length).equals(pngSignature);
  if (!validJpeg && !validPng) {
    throw Object.assign(new Error("O arquivo não contém uma imagem JPG ou PNG válida."), { statusCode: 400 });
  }
}

function validateAudio({ buffer, mimeType }) {
  mimeType = normalizeMimeType(mimeType);
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw Object.assign(new Error("O áudio está vazio."), { statusCode: 400 });
  }
  if (buffer.length > MAX_AUDIO_SIZE) {
    throw Object.assign(new Error("O áudio deve ter no máximo 16 MB."), { statusCode: 413 });
  }
  if (!mediaExtensions.has(mimeType) || !mimeType.startsWith("audio/")) {
    throw Object.assign(new Error("Formato de áudio não suportado."), { statusCode: 400 });
  }
}

function validateSticker({ buffer, mimeType }) {
  mimeType = normalizeMimeType(mimeType);
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw Object.assign(new Error("A figurinha está vazia."), { statusCode: 400 });
  }
  if (buffer.length > MAX_STICKER_SIZE) {
    throw Object.assign(new Error("A figurinha deve ter no máximo 500 KB."), { statusCode: 413 });
  }
  const validWebp = mimeType === "image/webp" && buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  if (!validWebp) {
    throw Object.assign(new Error("A figurinha não contém um arquivo WebP válido."), { statusCode: 400 });
  }
}

function validateVideo({ buffer, mimeType }) {
  mimeType = normalizeMimeType(mimeType);
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw Object.assign(new Error("O vídeo está vazio."), { statusCode: 400 });
  }
  if (buffer.length > MAX_VIDEO_SIZE) {
    throw Object.assign(new Error("O vídeo deve ter no máximo 16 MB."), { statusCode: 413 });
  }
  if (!mediaExtensions.has(mimeType) || !mimeType.startsWith("video/")) {
    throw Object.assign(new Error("Formato de vídeo não suportado."), { statusCode: 400 });
  }
}

function validateDocument({ buffer, mimeType }) {
  mimeType = normalizeMimeType(mimeType);
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw Object.assign(new Error("O documento está vazio."), { statusCode: 400 });
  }
  if (buffer.length > MAX_DOCUMENT_SIZE) {
    throw Object.assign(new Error("O documento deve ter no máximo 100 MB."), { statusCode: 413 });
  }
  if (!documentMimeTypes.has(mimeType)) {
    throw Object.assign(new Error("Formato de documento não suportado."), { statusCode: 400 });
  }
  const isPdf = mimeType === "application/pdf";
  const isText = mimeType === "text/plain";
  const isOpenXml = mimeType.startsWith("application/vnd.openxmlformats-officedocument.");
  const isLegacyOffice = ["application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"].includes(mimeType);
  const validPdf = !isPdf || (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-");
  const validText = !isText || !buffer.includes(0);
  const validOpenXml = !isOpenXml || (buffer.length >= 4
    && buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])));
  const oleSignature = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const validLegacyOffice = !isLegacyOffice || (buffer.length >= oleSignature.length
    && buffer.subarray(0, oleSignature.length).equals(oleSignature));
  if (!validPdf || !validText || !validOpenXml || !validLegacyOffice) {
    throw Object.assign(new Error("O conteúdo do documento não corresponde ao formato informado."), { statusCode: 400 });
  }
}

function storageRoot() {
  return path.resolve(process.env.MEDIA_STORAGE_DIR || path.join(process.cwd(), "storage", "media"));
}

function safeFileName(value, mimeType) {
  const fallback = `arquivo${mediaExtensions.get(mimeType) || ".bin"}`;
  const name = path.basename(typeof value === "string" ? value : fallback)
    .replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 120);
  return name || fallback;
}

function detectSafeImageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= pngSignature.length && buffer.subarray(0, pngSignature.length).equals(pngSignature)) return "image/png";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

async function storeMedia({ buffer, mimeType, fileName, stableId, kind }) {
  mimeType = normalizeMimeType(mimeType);
  let fileRisk = null;
  if (kind === "audio") validateAudio({ buffer, mimeType });
  else if (kind === "video") validateVideo({ buffer, mimeType });
  else if (kind === "sticker") validateSticker({ buffer, mimeType });
  else if (kind === "document") validateDocument({ buffer, mimeType });
  else if (kind === "internal") fileRisk = validateInternalFile({ buffer, mimeType, fileName });
  else validateImage({ buffer, mimeType });
  const safeImageMimeType = kind === "internal" ? detectSafeImageMimeType(buffer) : null;
  if (safeImageMimeType) mimeType = safeImageMimeType;
  const extension = kind === "internal" ? ".bin" : mediaExtensions.get(mimeType);
  const identity = stableId
    ? crypto.createHash("sha256").update(String(stableId)).digest("hex")
    : crypto.randomUUID().replaceAll("-", "");
  const storageKey = `${identity}${extension}`;
  await fs.mkdir(storageRoot(), { recursive: true });
  await fs.writeFile(path.join(storageRoot(), storageKey), buffer);
  return {
    storageKey,
    mimeType: mimeType || "application/octet-stream",
    fileName: safeFileName(fileName, mimeType),
    size: buffer.length,
    ...(kind === "internal" ? {
      safeImage: Boolean(safeImageMimeType),
      suspicious: Boolean(fileRisk?.suspicious),
      suspiciousReason: fileRisk?.suspiciousReason || null,
    } : {}),
  };
}

async function storeImage(options) {
  return storeMedia({ ...options, kind: "image" });
}

async function storeAudio(options) {
  return storeMedia({ ...options, kind: "audio" });
}

async function storeVideo(options) {
  return storeMedia({ ...options, kind: "video" });
}
// Único ponto de upload/recebimento do sistema sem allowlist de tipo (chat
// interno entre atendentes + mídia recebida de canais além do WhatsApp/Meta
// — ver omnichannel-message-service.js): qualquer formato de arquivo de
// negócio legítimo precisa continuar passando (não dá para restringir por
// MIME como as demais categorias). A defesa aqui é por CONTEÚDO
// (file-risk-service.js#assessFileRisk) — nunca confia só no Content-Type
// que o remetente declarou. Retorna o resultado da avaliação (nunca lança
// para o caso "suspeito, mas não bloqueado") para quem chamou anexar o aviso
// à mensagem armazenada.
function validateInternalFile({ buffer, mimeType, fileName }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw Object.assign(new Error("O arquivo está vazio."), { statusCode: 400 });
  }
  if (buffer.length > MAX_INTERNAL_FILE_SIZE) {
    throw Object.assign(new Error("O arquivo deve ter no máximo 100 MB."), { statusCode: 413 });
  }
  const risk = assessFileRisk({ buffer, mimeType, fileName });
  if (risk.blocked) {
    console.warn(`[SECURITY] upload bloqueado (arquivo suspeito): ${risk.blockedReason} — fileName=${fileName || "(sem nome)"} mimeType=${mimeType || "(nenhum)"}`);
    throw Object.assign(new Error(`Arquivo bloqueado por segurança: ${risk.blockedReason}`), { statusCode: 400, code: "SUSPICIOUS_FILE" });
  }
  if (risk.suspicious) {
    console.warn(`[SECURITY] upload suspeito (permitido, marcado para revisão): ${risk.suspiciousReason} — fileName=${fileName || "(sem nome)"} mimeType=${mimeType || "(nenhum)"}`);
  }
  return risk;
}

async function storeInternalFile(options) { return storeMedia({ ...options, kind: "internal" }); }


async function storeSticker(options) {
  return storeMedia({ ...options, kind: "sticker" });
}

async function storeDocument(options) {
  return storeMedia({ ...options, kind: "document" });
}

function resolveMedia(storageKey) {
  if (!/^[a-f0-9]{32,64}\.(jpg|png|webp|aac|m4a|mp3|amr|ogg|mp4|3gp|pdf|txt|doc|docx|xls|xlsx|ppt|pptx|bin)$/.test(storageKey || "")) {
    throw Object.assign(new Error("Mídia inválida."), { statusCode: 404 });
  }
  return path.join(storageRoot(), storageKey);
}

const resolveImage = resolveMedia;

async function removeImage(storageKey) {
  try { await fs.unlink(resolveMedia(storageKey)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

module.exports = {
  MAX_AUDIO_SIZE, MAX_DOCUMENT_SIZE, MAX_IMAGE_SIZE, MAX_INTERNAL_FILE_SIZE, MAX_STICKER_SIZE, MAX_VIDEO_SIZE, detectSafeImageMimeType, documentMimeTypes, normalizeMimeType, removeImage, resolveImage, resolveMedia,
  storeAudio, storeDocument, storeImage, storeInternalFile, storeSticker, storeVideo, validateAudio, validateDocument, validateImage, validateInternalFile, validateSticker, validateVideo,
};
