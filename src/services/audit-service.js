const prisma = require("../database/prisma");
const authorization = require("./authorization-service");

const entityTypes = new Set(["USER", "CONVERSATION", "CATEGORY", "NOTE", "BOT", "CHANNEL_ACCOUNT", "INTEGRATION", "QUICK_REPLY", "CAMPAIGN_SETTINGS", "CONVERSATION_SETTINGS", "CONTACT", "INTERNAL_CHAT"]);

function actorSnapshot(actor) {
  return {
    actorUserId: actor?.id || null,
    actorName: actor?.name || null,
    actorEmail: actor?.email || null,
  };
}

async function recordAudit({ actor, action, entityType, entityId, summary, details }, client = prisma) {
  return client.auditLog.create({
    data: {
      ...actorSnapshot(actor),
      action,
      entityType,
      entityId: entityId || null,
      summary,
      details: details || undefined,
    },
  });
}

async function listAuditLogs({ entityType, action, search, limit }, viewer) {
  authorization.assertMaster(viewer);
  const where = {};
  if (entityType) {
    if (!entityTypes.has(entityType)) {
      throw Object.assign(new Error("Tipo de auditoria inválido."), { statusCode: 400 });
    }
    where.entityType = entityType;
  }
  if (action) where.action = String(action).slice(0, 80);
  if (search?.trim()) {
    const term = search.trim().slice(0, 120);
    where.OR = [
      { summary: { contains: term, mode: "insensitive" } },
      { actorName: { contains: term, mode: "insensitive" } },
      { actorEmail: { contains: term, mode: "insensitive" } },
    ];
  }
  const take = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
  return prisma.auditLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
  });
}

module.exports = { listAuditLogs, recordAudit };
