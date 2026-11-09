// Biblioteca de figurinhas e GIFs por empresa. Arquivos ficam no armazenamento
// de mídia existente; no banco só metadados. Toda regra de acesso é aplicada
// aqui, nunca só na tela.
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const companyService = require("./company-service");
const features = require("./chat-features");
const { webpInfo } = require("./webp-info");
const { convertOutgoingMedia, run: runBinary } = require("./media-conversion-service");
const { resolveMedia, storeSticker, storeVideo } = require("./media-storage-service");

const KB = 1024;
const MB = 1024 * KB;
const KINDS = new Set(["STICKER", "GIF"]);
const SCOPES = new Set(["PERSONAL", "TEAM", "COMPANY"]);
const STATIC_STICKER_MAX = 100 * KB;
const ANIMATED_STICKER_MAX = 500 * KB;
const fail = (message, statusCode = 400, code) => Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function assertKindEnabled(kind) {
  if (!KINDS.has(kind)) throw fail("Tipo de biblioteca inválido.");
  features.assertEnabled(kind === "STICKER" ? "stickers" : "gifs");
}

// Limites da Cloud API (estática 100 KB, animada 500 KB). 512×512 não consta na
// página oficial atual, mas é o formato usado pelos clientes do WhatsApp.
function validateStickerFile(buffer) {
  const info = webpInfo(buffer);
  if (!info) throw fail("A figurinha precisa ser um arquivo WebP válido.", 400, "STICKER_FORMAT");
  const limit = info.animated ? ANIMATED_STICKER_MAX : STATIC_STICKER_MAX;
  if (buffer.length > limit) throw fail(`Figurinha ${info.animated ? "animada" : "estática"} acima do limite de ${limit / KB} KB.`, 413, "STICKER_SIZE");
  if (process.env.CHAT_STICKER_STRICT_SIZE !== "false" && (info.width !== 512 || info.height !== 512)) {
    throw fail("A figurinha precisa ter 512×512 pixels.", 400, "STICKER_DIMENSIONS");
  }
  return info;
}

function gifLimits() {
  return { maxBytes: features.numberEnv("CHAT_GIF_MAX_BYTES", 8 * MB), maxSeconds: features.numberEnv("CHAT_GIF_MAX_SECONDS", 30) };
}

function assertMp4Compatible(probe, limits = gifLimits()) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.filter((stream) => stream.codec_type === "video");
  const audio = streams.filter((stream) => stream.codec_type === "audio");
  if (video.length !== 1 || video[0].codec_name !== "h264") throw fail("O vídeo precisa usar o codec H.264.", 400, "GIF_CODEC");
  if (audio.length > 1 || audio.some((stream) => stream.codec_name !== "aac")) throw fail("O áudio do vídeo precisa ser AAC, em uma única faixa.", 400, "GIF_CODEC");
  if (Number(video[0].has_b_frames) > 0) throw fail("Este MP4 usa B-frames, que não reproduzem no WhatsApp Android. Envie o GIF original.", 400, "GIF_CODEC");
  const seconds = Number(probe.format?.duration || video[0].duration);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > limits.maxSeconds) throw fail(`A animação deve ter até ${limits.maxSeconds} segundos.`, 400, "GIF_DURATION");
  if (!(video[0].width > 0 && video[0].height > 0)) throw fail("Dimensões inválidas.", 400, "GIF_DIMENSIONS");
  return { width: video[0].width, height: video[0].height, durationMs: Math.round(seconds * 1000) };
}

async function probeMp4(buffer, execute = runBinary) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "central-gif-"));
  try {
    const input = path.join(directory, "input.mp4");
    await fs.writeFile(input, buffer, { mode: 0o600 });
    const output = await execute("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-show_entries", "stream=codec_type,codec_name,width,height,duration,has_b_frames:format=duration", "-of", "json", input], 65536, undefined, 15000, directory);
    return JSON.parse(output.toString("utf8"));
  } catch (error) {
    if (error.statusCode === 503) throw error;
    throw fail("Não foi possível ler este vídeo. Reenvie em um formato compatível.", 400, "GIF_PROBE");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function prepareGif({ buffer, fileName, mimeType, convert = convertOutgoingMedia, probe = probeMp4 }) {
  const limits = gifLimits();
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw fail("O arquivo está vazio.");
  if (buffer.length > 16 * MB) throw fail("Arquivo acima do limite de 16 MB.", 413, "GIF_SIZE");
  const signature = buffer.subarray(0, 6).toString("ascii");
  const isGif = signature === "GIF87a" || signature === "GIF89a";
  const isMp4 = buffer.subarray(4, 8).toString("ascii") === "ftyp";
  if (!isGif && !isMp4) throw fail("Envie um arquivo GIF ou MP4.", 400, "GIF_FORMAT");
  const media = isGif ? await convert({ buffer, kind: "video", mimeType, fileName }) : { buffer, mimeType: "video/mp4", fileName };
  if (media.buffer.length > limits.maxBytes) throw fail(`A animação convertida passou de ${Math.round(limits.maxBytes / MB)} MB.`, 413, "GIF_SIZE");
  const details = assertMp4Compatible(await probe(media.buffer), limits);
  return { ...media, ...details, converted: isGif };
}

async function isManager(user, companyId) {
  if (authorization.isMaster(user)) return true;
  return (await companyService.roleInCompany(user, companyId)) === "SUPERVISOR";
}

async function teamKeys(user, companyId) {
  if (authorization.isMaster(user)) {
    return (await prisma.category.findMany({ where: { companyId, parentId: null }, select: { id: true } })).map(({ id }) => id);
  }
  const ids = await authorization.allowedCategoryIds(user);
  const rows = await prisma.category.findMany({ where: { id: { in: ids || [] }, companyId }, select: { id: true, parentId: true } });
  return [...new Set(rows.map((row) => row.parentId || row.id))];
}

// Visível = da empresa acessível e (pessoal do próprio usuário, ou do setor
// dele, ou da empresa inteira).
async function visibleWhere(user, companyId) {
  return {
    companyId, deletedAt: null,
    OR: [
      { scope: "COMPANY" },
      { scope: "PERSONAL", ownerKey: user.id },
      { scope: "TEAM", ownerKey: { in: await teamKeys(user, companyId) } },
    ],
  };
}

async function resolveCompany(user, { conversationId, company }) {
  if (conversationId) {
    await authorization.assertCanViewConversation(user, conversationId);
    return (await prisma.conversation.findUnique({ where: { id: conversationId }, select: { companyId: true } })).companyId;
  }
  return companyService.resolveWorkspace(user, company);
}

function publicAsset(asset, userId) {
  return {
    id: asset.id, kind: asset.kind, scope: asset.scope, name: asset.name, category: asset.category, tags: asset.tags,
    mimeType: asset.mimeType, size: asset.size, width: asset.width, height: asset.height, animated: asset.animated,
    durationMs: asset.durationMs, favorite: Boolean(asset.favorites?.length), lastUsedAt: asset.usages?.[0]?.lastUsedAt || null,
    canDelete: asset.canDelete, url: `/api/media-library/${encodeURIComponent(asset.id)}/file`, ownedByViewer: asset.scope === "PERSONAL" && asset.ownerKey === userId,
  };
}

async function canDelete(user, asset) {
  if (asset.scope === "PERSONAL") return asset.ownerKey === user.id;
  if (await isManager(user, asset.companyId)) return true;
  return asset.scope === "TEAM" && asset.createdByUserId === user.id;
}

async function listAssets(user, { kind, conversationId, company, q, category, view }) {
  assertKindEnabled(kind);
  const companyId = await resolveCompany(user, { conversationId, company });
  const conditions = [await visibleWhere(user, companyId), { kind }];
  const term = String(q || "").trim().slice(0, 60);
  if (term) conditions.push({ OR: [{ name: { contains: term, mode: "insensitive" } }, { category: { contains: term, mode: "insensitive" } }, { tags: { has: term.toLowerCase() } }] });
  if (category) conditions.push({ category: String(category).slice(0, 60) });
  if (view === "favorites") conditions.push({ favorites: { some: { userId: user.id } } });
  if (view === "recent") conditions.push({ usages: { some: { userId: user.id } } });
  if (["PERSONAL", "TEAM", "COMPANY"].includes(view)) conditions.push({ scope: view });
  const rows = await prisma.mediaAsset.findMany({
    where: { AND: conditions },
    include: { favorites: { where: { userId: user.id }, select: { userId: true } }, usages: { where: { userId: user.id }, select: { lastUsedAt: true } } },
    orderBy: [{ createdAt: "desc" }], take: 120,
  });
  if (view === "recent") rows.sort((a, b) => b.usages[0].lastUsedAt - a.usages[0].lastUsedAt);
  const manager = await isManager(user, companyId);
  const categories = await prisma.mediaAsset.findMany({ where: { AND: [await visibleWhere(user, companyId), { kind, category: { not: null } }] }, select: { category: true }, distinct: ["category"], take: 50 });
  const items = [];
  for (const row of rows) items.push(publicAsset({ ...row, canDelete: await canDelete(user, row) }, user.id));
  return { items, categories: categories.map((row) => row.category), canManageShared: manager, teams: await teamOptions(user, companyId) };
}

async function teamOptions(user, companyId) {
  const ids = await teamKeys(user, companyId);
  return prisma.category.findMany({ where: { id: { in: ids } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
}

async function assertQuota(companyId, size) {
  const limit = features.numberEnv("CHAT_LIBRARY_MAX_BYTES_PER_COMPANY", 1024 * MB);
  const total = await prisma.mediaAsset.aggregate({ where: { companyId, deletedAt: null }, _sum: { size: true } });
  if ((total._sum.size || 0) + size > limit) throw fail("A biblioteca desta empresa atingiu o limite de armazenamento.", 413, "LIBRARY_QUOTA");
}

async function ownerFor(user, companyId, scope, teamId) {
  if (!SCOPES.has(scope)) throw fail("Destino inválido.");
  if (scope === "PERSONAL") return user.id;
  if (scope === "COMPANY") {
    if (!(await isManager(user, companyId))) throw authorization.forbidden("Somente Supervisor ou Master pode adicionar à biblioteca da empresa.");
    return "company";
  }
  if (!(await teamKeys(user, companyId)).includes(teamId)) throw authorization.forbidden("Você não tem acesso a este setor.");
  return teamId;
}

function cleanTags(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(list.map((tag) => String(tag).trim().toLowerCase().slice(0, 30)).filter(Boolean))].slice(0, 10);
}

async function saveAsset({ user, companyId, kind, scope = "PERSONAL", teamId, name, category, tags, media, details, sourceMessageId }) {
  const ownerKey = await ownerFor(user, companyId, scope, teamId);
  await assertQuota(companyId, media.buffer.length);
  const digest = sha256(media.buffer);
  const identity = { companyId_kind_scope_ownerKey_sha256: { companyId, kind, scope, ownerKey, sha256: digest } };
  const existing = await prisma.mediaAsset.findUnique({ where: identity });
  if (existing && !existing.deletedAt) return existing;
  // Mesmo conteúdo da mesma empresa divide o arquivo; empresas nunca dividem.
  const stored = await (kind === "STICKER" ? storeSticker : storeVideo)({
    buffer: media.buffer, mimeType: media.mimeType, fileName: media.fileName, stableId: `library:${companyId}:${digest}`,
  });
  const data = {
    name: String(name || media.fileName || (kind === "STICKER" ? "Figurinha" : "GIF")).trim().slice(0, 80),
    category: String(category || "").trim().slice(0, 60) || null, tags: cleanTags(tags),
    storageKey: stored.storageKey, mimeType: stored.mimeType, size: stored.size, sha256: digest,
    width: details.width || null, height: details.height || null, animated: Boolean(details.animated),
    durationMs: details.durationMs || null, sourceMessageId: sourceMessageId || null, createdByUserId: user.id, deletedAt: null,
  };
  return prisma.mediaAsset.upsert({ where: identity, update: data, create: { ...data, companyId, kind, scope, ownerKey } });
}

async function uploadAsset(user, { file, kind, conversationId, company, scope, teamId, name, category, tags }) {
  assertKindEnabled(kind);
  if (!file?.buffer) throw fail("Selecione um arquivo.");
  const companyId = await resolveCompany(user, { conversationId, company });
  if (kind === "STICKER") {
    const details = validateStickerFile(file.buffer);
    return saveAsset({ user, companyId, kind, scope, teamId, name, category, tags, details, media: { buffer: file.buffer, mimeType: "image/webp", fileName: file.originalname } });
  }
  const media = await prepareGif({ buffer: file.buffer, mimeType: file.mimetype, fileName: file.originalname });
  const asset = await saveAsset({ user, companyId, kind, scope, teamId, name, category, tags, media, details: { ...media, animated: true } });
  return { ...asset, converted: media.converted };
}

async function saveStickerFromMessage(user, { messageId, scope, teamId, name, category, tags }) {
  features.assertEnabled("stickers");
  const allowed = await require("./inbox-service").assertCanViewMessage(user, messageId);
  const message = await prisma.message.findUnique({ where: { id: allowed.id }, select: { id: true, type: true, mediaStorageKey: true, mediaFileName: true, conversation: { select: { companyId: true } } } });
  if (message.type !== "sticker" || !message.mediaStorageKey) throw fail("Esta mensagem não contém uma figurinha disponível.", 409, "STICKER_UNAVAILABLE");
  const buffer = await fs.readFile(resolveMedia(message.mediaStorageKey));
  const details = validateStickerFile(buffer);
  return saveAsset({
    user, companyId: message.conversation.companyId, kind: "STICKER", scope, teamId, name: name || "Figurinha salva", category, tags, details,
    sourceMessageId: message.id, media: { buffer, mimeType: "image/webp", fileName: message.mediaFileName || "figurinha.webp" },
  });
}

async function loadVisibleAsset(user, assetId) {
  const asset = await prisma.mediaAsset.findUnique({ where: { id: String(assetId) } });
  if (!asset || asset.deletedAt) throw fail("Item não encontrado.", 404);
  assertKindEnabled(asset.kind);
  // 404 de propósito: não revela item de outra empresa ou de outro usuário.
  if (!(await companyService.canAccessCompany(user, asset.companyId))) throw fail("Item não encontrado.", 404);
  const visible = await prisma.mediaAsset.count({ where: { AND: [{ id: asset.id }, await visibleWhere(user, asset.companyId)] } });
  if (!visible) throw fail("Item não encontrado.", 404);
  return asset;
}

async function setFavorite(user, assetId, favorite) {
  const asset = await loadVisibleAsset(user, assetId);
  const key = { assetId_userId: { assetId: asset.id, userId: user.id } };
  if (favorite) await prisma.mediaAssetFavorite.upsert({ where: key, update: {}, create: { assetId: asset.id, userId: user.id } });
  else await prisma.mediaAssetFavorite.deleteMany({ where: { assetId: asset.id, userId: user.id } });
  return { id: asset.id, favorite: Boolean(favorite) };
}

async function removeAsset(user, assetId) {
  const asset = await loadVisibleAsset(user, assetId);
  if (!(await canDelete(user, asset))) throw authorization.forbidden("Você não pode remover este item.");
  await prisma.mediaAsset.update({ where: { id: asset.id }, data: { deletedAt: new Date() } });
  return { id: asset.id, removed: true };
}

async function recordUsage(userId, assetId) {
  const key = { assetId_userId: { assetId, userId } };
  await prisma.mediaAssetUsage.upsert({ where: key, update: { lastUsedAt: new Date(), useCount: { increment: 1 } }, create: { assetId, userId } });
}

// Envio pelo mecanismo oficial: figurinha como sticker, GIF como vídeo MP4.
async function sendAsset({ user, conversationId, assetId, replyTo, channel, confirmedVideo, beforeProviderSend = async () => {} }) {
  const asset = await loadVisibleAsset(user, assetId);
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { companyId: true, channel: true } });
  if (!conversation || conversation.companyId !== asset.companyId) throw fail("Item não encontrado.", 404);
  if (conversation.channel !== "META") throw fail("Disponível apenas em conversas de WhatsApp.", 409);
  if (asset.kind === "GIF" && confirmedVideo !== true) throw fail("Confirme o envio como vídeo.", 400, "GIF_CONFIRMATION_REQUIRED");
  const buffer = await fs.readFile(resolveMedia(asset.storageKey));
  const storedMedia = { storageKey: asset.storageKey, mimeType: asset.mimeType, fileName: asset.kind === "GIF" ? "animacao.mp4" : "figurinha.webp", size: asset.size };
  const media = { conversationId, buffer, mimeType: asset.mimeType, fileName: storedMedia.fileName, sentByUserId: user.id, channel, replyTo, storedMedia, beforeProviderSend };
  const messages = require("./message-service");
  const result = asset.kind === "STICKER" ? await messages.sendSticker(media) : await messages.sendVideo(media);
  await recordUsage(user.id, asset.id).catch(() => {});
  return result;
}

module.exports = {
  assertMp4Compatible, listAssets, loadVisibleAsset, prepareGif, removeAsset, saveStickerFromMessage, sendAsset, setFavorite,
  uploadAsset, validateStickerFile,
};
