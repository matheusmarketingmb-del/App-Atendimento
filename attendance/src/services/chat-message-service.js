// Citações, reações, favoritos, fixadas, busca e encaminhamento. Usa a mesma
// integração Meta da Central (channel-message-service / MetaCloudChannel) e as
// mesmas regras de leitura de inbox-service.
const fs = require("node:fs/promises");
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const features = require("./chat-features");
const paging = require("./inbox-pagination");
const whatsappAccounts = require("./whatsapp-account-service");
const channelMessageService = require("./channels/channel-message-service");
const { assertFreeFormAllowed } = require("./meta-template-service");
const { resolveMedia } = require("./media-storage-service");

const inbox = () => require("./inbox-service");
const messages = () => require("./message-service");
const fail = (message, statusCode = 400, code) => Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });

const PREVIEW_SELECT = {
  id: true, type: true, text: true, direction: true, mediaFileName: true, mediaMimeType: true,
  mediaStorageKey: true, occurredAt: true, sentByUser: { select: { id: true, name: true } },
};
const PENDING_REACTION_TTL_MS = 30000;
const FORWARDABLE_TYPES = new Set(["text", "image", "video", "document", "audio", "sticker"]);

function trimText(value, size) {
  const text = String(value || "").trim();
  return text.length > size ? `${text.slice(0, size - 1)}…` : text;
}

function placeholderText(text) {
  return /^\[[a-z_]+\]$/.test(String(text || "")) ? "" : text;
}

function messagePreview(message) {
  return {
    id: message.id, type: message.type, direction: message.direction,
    text: trimText(placeholderText(message.text), 160),
    fileName: message.mediaFileName || null, hasMedia: Boolean(message.mediaStorageKey),
    author: message.direction === "ENVIADA" ? (message.sentByUser?.name || "Equipe") : "Cliente",
    occurredAt: message.occurredAt,
  };
}

// O número legado grava channelAccountId nulo; uma conta com a flag legada e o
// nulo representam o mesmo remetente.
async function sameSender(left, right) {
  if ((left || null) === (right || null)) return true;
  const legacy = await whatsappAccounts.getLegacyAccount();
  const normalize = (value) => (value && value === legacy?.id ? null : value || null);
  return normalize(left) === normalize(right);
}

async function loadMessage(id) {
  const message = await prisma.message.findUnique({
    where: { id },
    include: { conversation: { select: { id: true, companyId: true, contactId: true, channel: true, contact: { select: { phone: true, whatsappInboxId: true } } } } },
  });
  if (!message) throw fail("Mensagem não encontrada.", 404);
  return message;
}

function rootConversationId(message) {
  return message.conversation.contact?.whatsappInboxId || message.conversationId;
}

// ===== Citação =====

// Valida a mensagem citada. O número de envio é conferido depois, em
// assertReplySender, quando o remetente real da conversa já foi escolhido.
async function resolveReplyTarget(viewer, conversationId, replyToMessageId) {
  if (!replyToMessageId) return null;
  features.assertEnabled("reply");
  if (typeof replyToMessageId !== "string" || replyToMessageId.length > 64) throw fail("Mensagem citada inválida.");
  await inbox().assertCanViewMessage(viewer, replyToMessageId);
  const target = await loadMessage(replyToMessageId);
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { contactId: true, channel: true } });
  if (!conversation || conversation.channel !== "META" || target.conversation.channel !== "META" || target.conversation.contactId !== conversation.contactId) {
    throw fail("Só é possível citar mensagens desta conversa.", 409, "REPLY_TARGET_MISMATCH");
  }
  const wamid = features.rawWamid(target);
  if (!wamid || target.type === "reaction" || target.status === "FALHOU") {
    throw fail("Esta mensagem não pode ser citada no WhatsApp.", 409, "REPLY_TARGET_UNAVAILABLE");
  }
  if (features.olderThanMetaContext(target.occurredAt)) {
    throw fail("Mensagens com mais de 30 dias não podem ser citadas no WhatsApp.", 409, "REPLY_TARGET_TOO_OLD");
  }
  return { id: target.id, wamid, channelAccountId: target.channelAccountId };
}

async function assertReplySender(replyTo, conversation) {
  if (!replyTo) return;
  if (!(await sameSender(replyTo.channelAccountId, conversation.channelAccountId))) {
    throw fail("Esta mensagem foi trocada com outro número da empresa e não pode ser citada pelo número atual.", 409, "REPLY_SENDER_MISMATCH");
  }
}

function replyFields(replyTo) {
  return replyTo ? { replyToMessageId: replyTo.id, replyToExternalId: replyTo.wamid } : {};
}

// Só leitura: roda dentro da transação de recebimento.
async function inboundReplyFields(tx, { replyToExternalId, contactId, channelAccountId }) {
  if (!replyToExternalId) return {};
  const target = await tx.message.findFirst({
    where: { externalId: { in: features.externalIdCandidates(replyToExternalId, channelAccountId) }, conversation: { contactId, channel: "META" } },
    select: { id: true },
  });
  return { replyToExternalId, replyToMessageId: target?.id || null };
}

// ===== Dados anexados às mensagens da conversa =====

function reactionView(row, users) {
  const failedRemoval = row.status === "FAILED" && !row.emoji;
  const emoji = failedRemoval ? row.previousEmoji : row.emoji;
  if (!emoji) return null;
  return {
    emoji, side: row.side, status: failedRemoval ? "REMOVAL_FAILED" : row.status,
    errorCode: row.errorCode || null, user: row.userId ? users.get(row.userId) || null : null,
  };
}

// Citação antiga (antes desta versão) existe só em rawPayload.context.id.
function replyWamidOf(message) {
  return message.replyToExternalId || message.rawPayload?.context?.id || null;
}

async function attachReplies(rows, viewer, conversationId) {
  const citing = rows.filter((row) => row.replyToMessageId || replyWamidOf(row));
  if (!citing.length) return;
  // A citação segue a regra de leitura: trecho oculto vira "indisponível".
  const { where } = await inbox().readableMessageScope(conversationId, viewer);
  const ids = [...new Set(citing.map((row) => row.replyToMessageId).filter(Boolean))];
  const externalIds = [...new Set(citing.filter((row) => !row.replyToMessageId).flatMap((row) => features.externalIdCandidates(replyWamidOf(row), row.channelAccountId)))];
  const targets = await prisma.message.findMany({
    where: { AND: [where, { OR: [{ id: { in: ids } }, { externalId: { in: externalIds } }] }] },
    select: { ...PREVIEW_SELECT, externalId: true },
  });
  const byId = new Map(targets.map((target) => [target.id, target]));
  const byExternalId = new Map(targets.filter((target) => target.externalId).map((target) => [target.externalId, target]));
  for (const row of citing) {
    const wamid = replyWamidOf(row);
    const target = byId.get(row.replyToMessageId)
      || (wamid ? features.externalIdCandidates(wamid, row.channelAccountId).map((id) => byExternalId.get(id)).find(Boolean) : null);
    row.replyPreview = target ? messagePreview(target) : { unavailable: true };
  }
}

async function attachChatData(rows, viewer, conversationId) {
  // Com os módulos desligados, abrir uma conversa não faz nenhuma consulta extra.
  if (!["reply", "reactions", "stars", "pins"].some(features.isEnabled)) return rows;
  const visible = rows.filter((row) => !row.restricted);
  if (!visible.length) return rows;
  const ids = visible.map((row) => row.id);
  const [reactions, stars, pins] = await Promise.all([
    prisma.messageReaction.findMany({ where: { messageId: { in: ids } } }),
    prisma.messageStar.findMany({ where: { messageId: { in: ids }, userId: viewer.id }, select: { messageId: true } }),
    prisma.messagePin.findMany({ where: { messageId: { in: ids } }, select: { messageId: true } }),
  ]);
  const userIds = [...new Set(reactions.map((row) => row.userId).filter(Boolean))];
  const users = new Map(userIds.length ? (await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map((user) => [user.id, user]) : []);
  const reactionsByMessage = new Map();
  for (const row of reactions) {
    const view = reactionView(row, users);
    if (!view) continue;
    if (!reactionsByMessage.has(row.messageId)) reactionsByMessage.set(row.messageId, []);
    reactionsByMessage.get(row.messageId).push(view);
  }
  const starred = new Set(stars.map((row) => row.messageId));
  const pinned = new Set(pins.map((row) => row.messageId));
  for (const row of visible) {
    row.reactions = reactionsByMessage.get(row.id) || [];
    row.starred = starred.has(row.id);
    row.pinned = pinned.has(row.id);
  }
  await attachReplies(visible, viewer, conversationId);
  return rows;
}

// ===== Reações =====

function assertReactionTarget(message, now = new Date()) {
  if (message.channel !== "META" || message.conversation.channel !== "META") throw fail("Reações estão disponíveis apenas no WhatsApp.", 409, "REACTION_CHANNEL");
  if (message.direction !== "RECEBIDA") throw fail("A Meta só aceita reações a mensagens recebidas do cliente.", 409, "REACTION_DIRECTION");
  if (message.type === "reaction") throw fail("Não é possível reagir a uma reação.", 409, "REACTION_TARGET");
  if (!features.rawWamid(message)) throw fail("Esta mensagem não está disponível no WhatsApp.", 409, "REACTION_TARGET");
  if (features.olderThanMetaContext(message.occurredAt, now)) throw fail("Mensagens com mais de 30 dias não aceitam reação no WhatsApp.", 409, "REACTION_TOO_OLD");
}

async function providerReaction({ message, channel, emoji }) {
  const wamid = features.rawWamid(message);
  const to = message.conversation.contact.phone;
  const legacy = await whatsappAccounts.getLegacyAccount();
  const accountId = message.channelAccountId && message.channelAccountId !== legacy?.id ? message.channelAccountId : null;
  if (accountId) return channelMessageService.send({ channel: "META", channelAccountId: accountId, kind: "reaction", to, messageId: wamid, emoji });
  if (legacy && legacy.companyId !== message.conversation.companyId) throw fail("Esta conversa não tem número de WhatsApp da empresa vinculado.", 409);
  return channel.sendReaction(to, { messageId: wamid, emoji });
}

// Reação nunca aparece como confirmada antes da Meta: PENDING durante a
// chamada, ACCEPTED quando aceita e SENT quando o webhook confirmar.
async function reactToMessage({ messageId, emoji, viewer, channel, now = new Date() }) {
  features.assertEnabled("reactions");
  const normalized = features.normalizeEmoji(emoji);
  await inbox().assertCanViewMessage(viewer, messageId);
  const message = await loadMessage(messageId);
  const conversationId = rootConversationId(message);
  await authorization.assertCanActOnConversation(viewer, conversationId);
  assertReactionTarget(message, now);
  const legacy = await whatsappAccounts.getLegacyAccount();
  const windowAccountId = message.channelAccountId && message.channelAccountId !== legacy?.id ? message.channelAccountId : null;
  await assertFreeFormAllowed(conversationId, now, windowAccountId);

  const key = { messageId_side: { messageId, side: "BUSINESS" } };
  const claimed = await prisma.$transaction(async tx => {
    const [lock] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext(${"reaction:" + messageId})) AS locked`;
    if (!lock.locked) throw fail("Outra reação está sendo enviada. Aguarde.", 409, "REACTION_PENDING");
    const previous = await tx.messageReaction.findUnique({ where: key });
    if (previous?.status === "PENDING" && now.getTime() - previous.updatedAt.getTime() < PENDING_REACTION_TTL_MS) {
      throw fail("Aguarde a confirmação da reação anterior.", 409, "REACTION_PENDING");
    }
    if (!normalized && !previous?.emoji) return false;
    const previousEmoji = previous?.status === "FAILED" ? previous.previousEmoji : previous?.emoji;
    const pending = { emoji: normalized, previousEmoji: previousEmoji || null, status: "PENDING", userId: viewer.id, errorCode: null, externalId: null, occurredAt: now };
    await tx.messageReaction.upsert({
      where: key, update: pending,
      create: { ...pending, messageId, side: "BUSINESS", conversationId: message.conversationId, companyId: message.conversation.companyId },
    });
    return true;
  });
  if (!claimed) return { removed: true, noop: true };
  try {
    const result = await providerReaction({ message, channel, emoji: normalized });
    return await prisma.messageReaction.update({ where: key, data: { status: "ACCEPTED", externalId: result.externalId || null } });
  } catch (error) {
    await prisma.messageReaction.update({ where: key, data: { status: "FAILED", errorCode: String(error.metaErrorCode || error.code || "PROVIDER_ERROR").slice(0, 40) } });
    throw error;
  }
}

// Depois da transação de recebimento: a mensagem do tipo `reaction` já garante
// a idempotência por wamid; aqui só se atualiza o estado atual.
async function applyInboundReaction({ event, conversationId }) {
  if (event.type !== "reaction" || !event.reactionToExternalId) return null;
  const source = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { contactId: true } });
  const target = await prisma.message.findFirst({
    where: {
      externalId: { in: features.externalIdCandidates(event.reactionToExternalId, event.channelAccountId) },
      conversation: { contactId: source.contactId, channel: "META" },
    },
    select: { id: true, conversationId: true, conversation: { select: { companyId: true } } },
  });
  if (!target) {
    console.warn("[REACTION] mensagem alvo não localizada; reação mantida apenas no histórico bruto.");
    return null;
  }
  const key = { messageId_side: { messageId: target.id, side: "CUSTOMER" } };
  const existing = await prisma.messageReaction.findUnique({ where: key, select: { occurredAt: true } });
  // Webhook fora de ordem não sobrescreve uma reação mais nova.
  if (existing && existing.occurredAt > event.occurredAt) return null;
  const data = { emoji: event.reactionEmoji || "", status: "RECEIVED", externalId: event.externalId, occurredAt: event.occurredAt };
  return prisma.messageReaction.upsert({
    where: key, update: data,
    create: { ...data, messageId: target.id, side: "CUSTOMER", conversationId: target.conversationId, companyId: target.conversation.companyId },
  });
}

// Reação enviada só recebe o status `sent`; nunca delivered/read.
async function applyReactionStatus(event) {
  if (!event.externalId || !["sent", "failed"].includes(event.status)) return false;
  const failed = event.status === "failed";
  const result = await prisma.messageReaction.updateMany({
    where: { externalId: event.externalId, side: "BUSINESS", status: { in: failed ? ["PENDING", "ACCEPTED", "SENT"] : ["PENDING", "ACCEPTED"] } },
    data: failed
      ? { status: "FAILED", errorCode: String(event.rawPayload?.errors?.[0]?.code || "META_FAILED").slice(0, 40) }
      : { status: "SENT" },
  });
  return result.count > 0;
}

// ===== Favoritos =====

async function setStar({ messageId, starred, viewer }) {
  features.assertEnabled("stars");
  await inbox().assertCanViewMessage(viewer, messageId);
  const message = await loadMessage(messageId);
  const key = { messageId_userId: { messageId, userId: viewer.id } };
  if (starred) {
    const conversationId = rootConversationId(message);
    await prisma.messageStar.upsert({ where: key, update: {}, create: { messageId, userId: viewer.id, conversationId, companyId: message.conversation.companyId } });
  } else {
    await prisma.messageStar.deleteMany({ where: { messageId, userId: viewer.id } });
  }
  return { messageId, starred: Boolean(starred) };
}

async function listStars({ conversationId, viewer }) {
  features.assertEnabled("stars");
  const { where, conversation } = await inbox().readableMessageScope(conversationId, viewer);
  const rows = await prisma.message.findMany({
    where: { AND: [where, { stars: { some: { userId: viewer.id, conversationId: conversation.id } } }] },
    select: PREVIEW_SELECT, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 200,
  });
  return rows.map(messagePreview);
}

// ===== Fixadas =====

async function listPins({ conversationId, viewer }) {
  features.assertEnabled("pins");
  const { where, conversation } = await inbox().readableMessageScope(conversationId, viewer);
  const pins = await prisma.messagePin.findMany({
    where: { conversationId: conversation.id, message: where },
    include: { message: { select: PREVIEW_SELECT }, pinnedBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return pins.map((pin) => ({ id: pin.id, pinnedAt: pin.createdAt, pinnedBy: pin.pinnedBy, message: messagePreview(pin.message) }));
}

// Só conversas com alguma fixada pagam o custo do escopo de leitura.
async function pinsForConversation(conversationId, viewer) {
  if (!features.isEnabled("pins")) return [];
  const total = await prisma.messagePin.count({ where: { conversationId } });
  return total ? listPins({ conversationId, viewer }) : [];
}

async function setPin({ messageId, pinned, viewer }) {
  features.assertEnabled("pins");
  await inbox().assertCanViewMessage(viewer, messageId);
  const message = await loadMessage(messageId);
  const conversationId = rootConversationId(message);
  await authorization.assertCanActOnConversation(viewer, conversationId);
  if (message.type === "reaction") throw fail("Reações não podem ser fixadas.");
  const key = { conversationId_messageId: { conversationId, messageId } };
  const limit = features.pinLimit();
  const changed = await prisma.$transaction(async (tx) => {
    const existing = await tx.messagePin.findUnique({ where: key });
    if (pinned === Boolean(existing)) return false;
    if (pinned) {
      if (await tx.messagePin.count({ where: { conversationId } }) >= limit) throw fail(`Limite de ${limit} mensagens fixadas nesta conversa.`, 409, "PIN_LIMIT");
      await tx.messagePin.create({ data: { conversationId, messageId, companyId: message.conversation.companyId, pinnedByUserId: viewer.id } });
    } else {
      await tx.messagePin.delete({ where: key });
    }
    await tx.conversationActivity.create({ data: { conversationId, actorUserId: viewer.id, action: pinned ? "MESSAGE_PINNED" : "MESSAGE_UNPINNED", details: { messageId } } });
    return true;
  });
  return { messageId, pinned: Boolean(pinned), changed };
}

// ===== Busca =====

const SEARCH_TYPES = new Set(["text", "image", "video", "audio", "document", "sticker"]);
const likeEscape = (value) => value.replace(/[\\%_]/g, "\\$&");

function searchDate(value, label) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw fail(`${label} inválida.`);
  return date;
}

async function searchMessages({ conversationId, viewer, q, type, from, to, sender, cursor }) {
  features.assertEnabled("search");
  const term = String(q || "").trim();
  if (term.length > 100) throw fail("Pesquisa muito longa.");
  if (term && term.length < 2) throw fail("Digite ao menos 2 caracteres.");
  if (type && !SEARCH_TYPES.has(type)) throw fail("Tipo de mídia inválido.");
  const start = searchDate(from, "Data inicial");
  const end = searchDate(to, "Data final");
  if (!term && !type && !start && !end && !sender) throw fail("Informe um termo ou filtro.");
  const { where } = await inbox().readableMessageScope(conversationId, viewer);
  const conditions = [where, { type: { not: "reaction" } }];
  if (term) {
    const contains = { contains: likeEscape(term), mode: "insensitive" };
    conditions.push({ OR: [{ text: contains }, { mediaFileName: contains }] });
  }
  if (type) conditions.push({ type });
  if (start || end) conditions.push({ occurredAt: { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } });
  if (sender === "customer") conditions.push({ direction: "RECEBIDA" });
  else if (sender === "team") conditions.push({ direction: "ENVIADA" });
  else if (sender) conditions.push({ sentByUserId: String(sender).slice(0, 64) });
  const before = paging.decodeCursor(cursor);
  if (before) conditions.push(paging.historyWhere({ before }));
  const limit = 30;
  const rows = await prisma.message.findMany({
    where: { AND: conditions }, select: PREVIEW_SELECT,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: limit + 1,
  });
  const page = rows.slice(0, limit);
  return { results: page.map(messagePreview), nextCursor: rows.length > limit ? paging.encodeCursor(page.at(-1)) : null };
}

const LOCATE_MAX_NEWER = 1500;

// Devolve o cursor que a linha do tempo já entende (historyFrom). Muito longe
// do fim, a tela abre só o trecho, sem carregar milhares de mensagens.
async function locateMessage({ conversationId, messageId, viewer }) {
  const { where } = await inbox().readableMessageScope(conversationId, viewer);
  const target = await prisma.message.findFirst({ where: { AND: [where, { id: messageId }] }, select: { id: true, occurredAt: true } });
  if (!target) throw fail("Mensagem não encontrada.", 404);
  const newer = { OR: [{ occurredAt: { gt: target.occurredAt } }, { occurredAt: target.occurredAt, id: { gt: target.id } }] };
  const older = { OR: [{ occurredAt: { lt: target.occurredAt } }, { occurredAt: target.occurredAt, id: { lt: target.id } }] };
  const [newerCount, before] = await Promise.all([
    prisma.message.count({ where: { AND: [where, newer] } }),
    prisma.message.findMany({ where: { AND: [where, older] }, select: { id: true, occurredAt: true }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 10 }),
  ]);
  return { messageId, newerCount, tooFar: newerCount > LOCATE_MAX_NEWER, cursor: paging.encodeCursor(before.at(-1) || target) };
}

async function messageContext({ conversationId, messageId, viewer }) {
  const { where } = await inbox().readableMessageScope(conversationId, viewer);
  const target = await prisma.message.findFirst({ where: { AND: [where, { id: messageId }] }, select: { ...PREVIEW_SELECT } });
  if (!target) throw fail("Mensagem não encontrada.", 404);
  const reaction = { type: { not: "reaction" } };
  const [older, newer] = await Promise.all([
    prisma.message.findMany({ where: { AND: [where, reaction, { OR: [{ occurredAt: { lt: target.occurredAt } }, { occurredAt: target.occurredAt, id: { lt: target.id } }] }] }, select: PREVIEW_SELECT, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 15 }),
    prisma.message.findMany({ where: { AND: [where, reaction, { OR: [{ occurredAt: { gt: target.occurredAt } }, { occurredAt: target.occurredAt, id: { gt: target.id } }] }] }, select: PREVIEW_SELECT, orderBy: [{ occurredAt: "asc" }, { id: "asc" }], take: 15 }),
  ]);
  return { messageId, messages: [...older.reverse(), target, ...newer].map(messagePreview) };
}

// ===== Encaminhamento =====

// A Cloud API não tem encaminhar: é uma mensagem nova, sem o selo
// "Encaminhada" no WhatsApp do destinatário. O vínculo fica só na Central.
async function forwardMessage({ messageId, targetConversationId, confirmed, viewer, channel, requestId }) {
  features.assertEnabled("forward");
  if (confirmed !== true) throw fail("Confirme o destinatário antes de encaminhar.", 400, "FORWARD_CONFIRMATION_REQUIRED");
  if (typeof targetConversationId !== "string" || !targetConversationId) throw fail("Selecione a conversa de destino.");
  await inbox().assertCanViewMessage(viewer, messageId);
  const source = await loadMessage(messageId);
  await authorization.assertCanActOnConversation(viewer, targetConversationId);
  const target = await prisma.conversation.findUnique({ where: { id: targetConversationId }, select: { id: true, companyId: true, channel: true } });
  if (!target) throw fail("Conversa de destino não encontrada.", 404);
  if (target.companyId !== source.conversation.companyId) throw fail("Não é permitido encaminhar mensagens entre empresas.", 403, "FORWARD_CROSS_COMPANY");
  if (target.channel !== "META") throw fail("Encaminhamento disponível apenas para conversas de WhatsApp.", 409, "FORWARD_CHANNEL");
  if (target.id === source.conversationId) throw fail("Escolha outra conversa de destino.", 409, "FORWARD_SAME_CONVERSATION");
  // Conteúdo de setor privado (Financeiro) não sai do segmento dele.
  if (source.privateCategoryId) throw fail("Mensagens de setor restrito não podem ser encaminhadas.", 403, "FORWARD_PRIVATE");
  if (!FORWARDABLE_TYPES.has(source.type)) throw fail("Este tipo de mensagem não pode ser encaminhado.", 409, "FORWARD_TYPE");
  if (source.type !== "text" && !source.mediaStorageKey) throw fail("A mídia desta mensagem não está disponível.", 409, "FORWARD_MEDIA_UNAVAILABLE");
  if (source.type === "text" && !String(source.text || "").trim()) throw fail("Mensagem vazia.", 409, "FORWARD_TYPE");

  // Antes de reservar o envio: fora da janela nada é tentado na Meta.
  const sender = await prisma.conversation.findUnique({ where: { id: target.id } });
  await require("./whatsapp-inbox-service").applySender(sender, viewer.id);
  await assertFreeFormAllowed(target.id, new Date(), sender.channelAccountId);

  const send = async (beforeProviderSend = async () => {}) => {
    const shared = { conversationId: target.id, sentByUserId: viewer.id, channel, forwardedFromMessageId: source.id };
    let result;
    if (source.type === "text") {
      result = await messages().sendText({ ...shared, text: source.text, beforeProviderSend });
    } else {
      const buffer = await fs.readFile(resolveMedia(source.mediaStorageKey));
      const storedMedia = { storageKey: source.mediaStorageKey, mimeType: source.mediaMimeType, fileName: source.mediaFileName, size: source.mediaSize };
      const media = { ...shared, buffer, mimeType: source.mediaMimeType, fileName: source.mediaFileName, storedMedia };
      const caption = placeholderText(source.text) || undefined;
      await beforeProviderSend();
      if (source.type === "image") result = await messages().sendImage({ ...media, caption });
      else if (source.type === "video") result = await messages().sendVideo({ ...media, caption });
      else if (source.type === "document") result = await messages().sendDocument({ ...media, caption });
      else if (source.type === "sticker") result = await messages().sendSticker(media);
      else result = await messages().sendAudio({ ...media, durationMs: source.mediaDurationMs });
    }
    await prisma.conversationActivity.create({ data: { conversationId: target.id, actorUserId: viewer.id, action: "MESSAGE_FORWARDED", details: { sourceMessageId: source.id, sourceConversationId: source.conversationId, messageId: result.message.id } } });
    return result;
  };
  const { sendOnce } = require("./outbound-text-request-service");
  return sendOnce({ client: prisma, userId: viewer.id, conversationId: target.id, requestId, text: `forward:${source.id}`, send });
}

module.exports = {
  applyInboundReaction, applyReactionStatus, assertReactionTarget, assertReplySender, attachChatData, forwardMessage,
  inboundReplyFields, listPins, listStars, locateMessage, messageContext, messagePreview, pinsForConversation,
  reactToMessage, replyFields, resolveReplyTarget, sameSender, searchMessages, setPin, setStar,
};
