const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const audit = require("./audit-service");

const KNOWLEDGE_SOURCE_TYPES = new Set(["FAQ", "MANUAL", "PRODUCT", "POLICY", "WARRANTY", "PROCEDURE", "GENERAL", "OTHER"]);
const ACCESS_INCLUDE = {
  botAccesses: {
    include: { bot: { select: { id: true, name: true, status: true, archivedAt: true } } },
  },
};

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function assertBotManager(viewer) {
  if (!authorization.isMaster(viewer)) {
    throw authorization.forbidden("Somente uma conta Master pode gerenciar Bots.");
  }
}

function isActiveNow(source, now = new Date()) {
  if (!source.active) return false;
  if (source.validFrom && now < new Date(source.validFrom)) return false;
  if (source.validUntil && now > new Date(source.validUntil)) return false;
  return true;
}

function withActiveNow(source) {
  const { botAccesses = [], ...rest } = source;
  const bots = botAccesses
    .map((access) => access.bot)
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const botIds = bots.length ? bots.map((bot) => bot.id) : (rest.botId ? [rest.botId] : []);
  return { ...rest, botIds, bots, accessMode: botIds.length ? "SELECTED" : "ALL", activeNow: isActiveNow(rest) };
}

function normalizeBotIds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw fail("Selecione os Bots em uma lista válida.");
  return [...new Set(value.map((id) => String(id || "").trim()).filter(Boolean))].slice(0, 200);
}

async function assertBotsExist(botIds, client = prisma) {
  if (!botIds?.length) return;
  const bots = await client.bot.findMany({
    where: { id: { in: botIds }, archivedAt: null },
    select: { id: true },
  });
  if (bots.length !== botIds.length) throw fail("Um ou mais Bots selecionados não existem ou estão arquivados.");
}

async function listKnowledgeSources(filters, viewer) {
  assertBotManager(viewer);
  const where = {};
  const and = [];
  if (filters.botId) {
    and.push({
      OR: [
        { botAccesses: { some: { botId: filters.botId } } },
        { botId: filters.botId },
        { AND: [{ botId: null }, { botAccesses: { none: {} } }] },
      ],
    });
  }
  if (filters.type) where.type = filters.type;
  if (filters.category) where.category = filters.category;
  if (filters.product) where.product = filters.product;
  if (filters.intentId) where.intentId = filters.intentId;
  if (filters.globalIntentId) where.globalIntentId = filters.globalIntentId;
  if (filters.active === "true" || filters.active === true) where.active = true;
  if (filters.active === "false" || filters.active === false) where.active = false;
  if (filters.q) {
    const term = String(filters.q).trim();
    if (term) {
      and.push({
        OR: [
          { title: { contains: term, mode: "insensitive" } },
          { content: { contains: term, mode: "insensitive" } },
          { product: { contains: term, mode: "insensitive" } },
          { category: { contains: term, mode: "insensitive" } },
          { tags: { has: term.toLowerCase() } },
        ],
      });
    }
  }
  if (and.length) where.AND = and;
  const rows = await prisma.knowledgeSource.findMany({
    where,
    include: ACCESS_INCLUDE,
    orderBy: [{ active: "desc" }, { updatedAt: "desc" }],
  });
  return rows.map(withActiveNow);
}

function validateInput(data, { partial = false } = {}) {
  const input = {};
  if (!partial || data.title !== undefined) {
    const title = String(data.title || "").trim();
    if (!title) throw fail("Título é obrigatório.");
    input.title = title.slice(0, 200);
  }
  if (!partial || data.type !== undefined) {
    if (!KNOWLEDGE_SOURCE_TYPES.has(data.type)) throw fail("Tipo de fonte de conhecimento inválido.");
    input.type = data.type;
  }
  if (!partial || data.source !== undefined) {
    const source = String(data.source || "").trim();
    if (!source) throw fail("Informe a origem desta fonte de conhecimento.");
    input.source = source.slice(0, 500);
  }
  if (data.globalIntentId !== undefined) input.globalIntentId = data.globalIntentId || null;
  if (data.intentId !== undefined) input.intentId = data.intentId || null;
  if (data.category !== undefined) input.category = data.category ? String(data.category).trim().slice(0, 200) : null;
  if (data.product !== undefined) input.product = data.product ? String(data.product).trim().slice(0, 200) : null;
  if (data.tags !== undefined) {
    if (!Array.isArray(data.tags)) throw fail("Tags devem ser uma lista.");
    input.tags = [...new Set(data.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 30);
  }
  if (data.content !== undefined) input.content = data.content ? String(data.content).trim().slice(0, 8000) : null;
  if (data.active !== undefined) {
    if (typeof data.active !== "boolean") throw fail("Informe se a fonte está ativa.");
    input.active = data.active;
  }
  if (data.validFrom !== undefined) {
    input.validFrom = data.validFrom ? new Date(data.validFrom) : null;
    if (input.validFrom && Number.isNaN(input.validFrom.getTime())) throw fail("Data inicial inválida.");
  }
  if (data.validUntil !== undefined) {
    input.validUntil = data.validUntil ? new Date(data.validUntil) : null;
    if (input.validUntil && Number.isNaN(input.validUntil.getTime())) throw fail("Data final inválida.");
  }
  if (input.validFrom && input.validUntil && input.validFrom > input.validUntil) {
    throw fail("A validade inicial deve ser anterior à validade final.");
  }
  const fallbackBotIds = data.botId !== undefined ? (data.botId ? [data.botId] : []) : undefined;
  return { input, botIds: normalizeBotIds(data.botIds !== undefined ? data.botIds : fallbackBotIds) };
}

async function createKnowledgeSource(data, actor) {
  assertBotManager(actor);
  const { input, botIds = [] } = validateInput(data);
  const created = await prisma.$transaction(async (tx) => {
    await assertBotsExist(botIds, tx);
    return tx.knowledgeSource.create({
      data: {
        ...input,
        botId: botIds.length === 1 ? botIds[0] : null,
        botAccesses: { create: botIds.map((botId) => ({ botId })) },
      },
      include: ACCESS_INCLUDE,
    });
  });
  await audit.recordAudit({
    actor,
    action: "BOT_KNOWLEDGE_SOURCE_CREATED",
    entityType: "BOT",
    entityId: botIds.length === 1 ? botIds[0] : null,
    summary: "Criou a fonte de conhecimento \"" + created.title + "\"",
    details: { id: created.id, type: created.type, botIds, accessMode: botIds.length ? "SELECTED" : "ALL" },
  });
  return withActiveNow(created);
}

async function updateKnowledgeSource(id, data, actor) {
  assertBotManager(actor);
  const existing = await prisma.knowledgeSource.findUnique({ where: { id } });
  if (!existing) throw fail("Fonte de conhecimento não encontrada.", 404);
  const { input, botIds } = validateInput(data, { partial: true });
  if (!Object.keys(input).length && botIds === undefined) throw fail("Informe ao menos um campo para atualizar.");
  const nextValidFrom = input.validFrom === undefined ? existing.validFrom : input.validFrom;
  const nextValidUntil = input.validUntil === undefined ? existing.validUntil : input.validUntil;
  if (nextValidFrom && nextValidUntil && nextValidFrom > nextValidUntil) {
    throw fail("A validade inicial deve ser anterior à validade final.");
  }
  const updated = await prisma.$transaction(async (tx) => {
    await assertBotsExist(botIds, tx);
    const updateData = { ...input, version: { increment: 1 } };
    if (botIds !== undefined) {
      updateData.botId = botIds.length === 1 ? botIds[0] : null;
      updateData.botAccesses = {
        deleteMany: {},
        create: botIds.map((botId) => ({ botId })),
      };
    }
    return tx.knowledgeSource.update({ where: { id }, data: updateData, include: ACCESS_INCLUDE });
  });
  const view = withActiveNow(updated);
  await audit.recordAudit({
    actor,
    action: "BOT_KNOWLEDGE_SOURCE_UPDATED",
    entityType: "BOT",
    entityId: view.botIds.length === 1 ? view.botIds[0] : null,
    summary: "Atualizou a fonte de conhecimento \"" + updated.title + "\"",
    details: { id, botIds: view.botIds, accessMode: view.accessMode },
  });
  return view;
}

async function deleteKnowledgeSource(id, actor) {
  assertBotManager(actor);
  const existing = await prisma.knowledgeSource.findUnique({ where: { id } });
  if (!existing) throw fail("Fonte de conhecimento não encontrada.", 404);
  await prisma.knowledgeSource.delete({ where: { id } });
  await audit.recordAudit({
    actor,
    action: "BOT_KNOWLEDGE_SOURCE_DELETED",
    entityType: "BOT",
    entityId: existing.botId,
    summary: "Removeu a fonte de conhecimento \"" + existing.title + "\"",
    details: { id },
  });
  return { deleted: true };
}

module.exports = {
  KNOWLEDGE_SOURCE_TYPES,
  createKnowledgeSource,
  deleteKnowledgeSource,
  isActiveNow,
  listKnowledgeSources,
  updateKnowledgeSource,
};
