// Mapeamento manual post/reel -> produto (item 10/11 do plano Social).
// SEMPRE cadastro manual — nunca inferido automaticamente com baixa
// confiança (pedido explícito). Serve para o comentário chegar à Central já
// com contexto ("Post: Mibro GS Pro 2" + "tem gps?"), em vez de só o texto
// cru — ver resolveForPost(), consumido por inbox-controller.js#detail.
const prisma = require("../../database/prisma");
const authorization = require("../authorization-service");
const audit = require("../audit-service");

const SOCIAL_CONTENT_CHANNELS = Object.freeze(["INSTAGRAM_DIRECT", "INSTAGRAM_COMMENTS", "FACEBOOK_MESSENGER", "FACEBOOK_COMMENTS"]);

function assertManager(actor) {
  if (!authorization.isMaster(actor)) {
    throw authorization.forbidden("Somente uma conta Master pode gerenciar o mapeamento de publicações.");
  }
}

function assertValidChannel(channel) {
  if (!SOCIAL_CONTENT_CHANNELS.includes(channel)) {
    throw Object.assign(new Error("Canal inválido para mapeamento de publicação — use um canal social (Instagram/Facebook)."), { statusCode: 400 });
  }
}

async function listMappings({ channel, active } = {}, viewer) {
  assertManager(viewer);
  const where = {};
  if (channel) { assertValidChannel(channel); where.channel = channel; }
  if (typeof active === "boolean") where.active = active;
  return prisma.socialContentMapping.findMany({ where, orderBy: { updatedAt: "desc" }, take: 200 });
}

async function createMapping({ channel, externalPostId, title, product, permalink }, actor) {
  assertManager(actor);
  assertValidChannel(channel);
  const postId = String(externalPostId || "").trim();
  if (!postId) throw Object.assign(new Error("externalPostId é obrigatório."), { statusCode: 400 });
  const mapping = await prisma.socialContentMapping.upsert({
    where: { channel_externalPostId: { channel, externalPostId: postId } },
    update: { title: title?.trim() || null, product: product?.trim() || null, permalink: permalink?.trim() || null, active: true },
    create: {
      channel, externalPostId: postId, title: title?.trim() || null, product: product?.trim() || null,
      permalink: permalink?.trim() || null, createdByUserId: actor.id,
    },
  });
  await audit.recordAudit({
    actor, action: "SOCIAL_CONTENT_MAPPING_SAVED", entityType: "INTEGRATION", entityId: mapping.id,
    summary: `Mapeou a publicação ${postId} (${channel}) ao produto "${mapping.product || "(sem produto)"}"`,
  });
  return mapping;
}

async function setMappingActive(id, active, actor) {
  assertManager(actor);
  const mapping = await prisma.socialContentMapping.update({ where: { id }, data: { active: Boolean(active) } });
  await audit.recordAudit({
    actor, action: active ? "SOCIAL_CONTENT_MAPPING_ENABLED" : "SOCIAL_CONTENT_MAPPING_DISABLED",
    entityType: "INTEGRATION", entityId: mapping.id, summary: `${active ? "Reativou" : "Desativou"} o mapeamento da publicação ${mapping.externalPostId}.`,
  });
  return mapping;
}

async function deleteMapping(id, actor) {
  assertManager(actor);
  const mapping = await prisma.socialContentMapping.delete({ where: { id } });
  await audit.recordAudit({
    actor, action: "SOCIAL_CONTENT_MAPPING_DELETED", entityType: "INTEGRATION", entityId: id,
    summary: `Removeu o mapeamento da publicação ${mapping.externalPostId} (${mapping.channel}).`,
  });
  return { deleted: true };
}

// Leitura simples, sem RBAC (mesma visibilidade da conversa que a usa) —
// chamada de dentro de inbox-controller.js#detail para todo mundo que já
// pode ver a conversa, nunca exposta como endpoint aberto próprio.
async function resolveForPost(channel, externalPostId) {
  if (!externalPostId || !SOCIAL_CONTENT_CHANNELS.includes(channel)) return null;
  return prisma.socialContentMapping.findUnique({
    where: { channel_externalPostId: { channel, externalPostId } },
  });
}

module.exports = { createMapping, deleteMapping, listMappings, resolveForPost, setMappingActive, SOCIAL_CONTENT_CHANNELS };
