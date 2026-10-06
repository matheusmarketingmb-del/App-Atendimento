// Lista de supressão POR EMPRESA (item 11/13; multiempresa 2026-10) — nunca
// por campanha. Sair da lista da Mibro não bloqueia a Sincrofit. Reaproveita
// normalizeText (bot-simulator-service.js) para detectar as palavras-chave
// de opt-out, mesma função usada em todo o motor de Bots — nunca duplica
// normalização de texto.
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const audit = require("./audit-service");
const { normalizeText } = require("./bot-schedule-utils");
const { OPT_OUT_PATTERNS } = require("./campaign-constants");

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Item 13: nunca depende de frase exata — mesmo espírito dos padrões de
// resolução do motor de Bots (RESOLUTION_POSITIVE_PATTERNS etc.).
function detectOptOutKeyword(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return OPT_OUT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function requireCompany(companyId) {
  if (!companyId) throw new Error("Opt-out exige companyId (supressão é por empresa).");
}

async function isOptedOut(phone, companyId, client = prisma) {
  if (!phone) return false;
  requireCompany(companyId);
  const row = await client.optOut.findUnique({ where: { companyId_phone: { companyId, phone } }, select: { removedAt: true } });
  return Boolean(row && !row.removedAt);
}

async function bulkOptedOutSet(phones, companyId, client = prisma) {
  if (!phones.length) return new Set();
  requireCompany(companyId);
  const rows = await client.optOut.findMany({
    where: { companyId, phone: { in: phones }, removedAt: null }, select: { phone: true },
  });
  return new Set(rows.map((row) => row.phone));
}

// Item 13: marca o contato, nunca apaga histórico — só cria/atualiza o
// registro de supressão (upsert: uma reversão manual anterior nunca é
// perdida, um novo opt-out simplesmente volta a valer).
async function registerOptOut({ phone, contactId = null, reason = null, source, companyId }, client = prisma) {
  if (!phone) return null;
  requireCompany(companyId);
  return client.optOut.upsert({
    where: { companyId_phone: { companyId, phone } },
    update: { removedAt: null, removedByUserId: null, removalReason: null, reason: reason || undefined, source },
    create: { companyId, phone, contactId, reason, source },
  });
}

async function listOptOuts(filters, viewer) {
  const { manageableCompanyIds } = require("./campaign-service");
  let companyIds = await manageableCompanyIds(viewer);
  if (!companyIds.length) throw authorization.forbidden("Você não tem permissão para gerenciar campanhas.");
  if (filters?.company && filters.company !== "ALL") {
    const requested = await require("./company-service").resolveCompanyFilter(viewer, filters.company);
    companyIds = companyIds.filter((id) => requested.includes(id));
  }
  const where = { companyId: { in: companyIds } };
  if (filters?.active === "true") where.removedAt = null;
  if (filters?.active === "false") where.removedAt = { not: null };
  if (filters?.phone) where.phone = { contains: String(filters.phone).replace(/\D/g, "") };
  const take = Math.min(Math.max(Number(filters?.limit) || 50, 1), 200);
  return prisma.optOut.findMany({
    where, orderBy: { createdAt: "desc" }, take,
    include: { company: { select: { id: true, slug: true, displayName: true, primaryColor: true } } },
  });
}

// Item 13: remoção manual só por usuário autorizado, sempre com motivo e
// auditoria — nunca apaga o registro (mantém o histórico completo).
async function removeOptOut(phone, data, actor) {
  const reason = String(data?.reason || "").trim();
  if (!reason) throw fail("Informe o motivo da remoção do opt-out.");
  const companyId = await require("./company-service").resolveCompanyForCreate(actor, data?.companyId);
  await require("./campaign-service").assertCampaignCompanyPermission(actor, companyId);
  const existing = await prisma.optOut.findUnique({ where: { companyId_phone: { companyId, phone } } });
  if (!existing) throw fail("Opt-out não encontrado.", 404);
  if (existing.removedAt) throw fail("Este opt-out já foi removido.");
  const updated = await prisma.optOut.update({
    where: { id: existing.id }, data: { removedAt: new Date(), removedByUserId: actor.id, removalReason: reason },
  });
  await audit.recordAudit({
    actor, action: "CAMPAIGN_OPT_OUT_REMOVED", entityType: "OPT_OUT", entityId: existing.id, companyId,
    summary: `Removeu o opt-out do telefone ${phone}`, details: { reason },
  });
  return updated;
}

module.exports = { bulkOptedOutSet, detectOptOutKeyword, isOptedOut, listOptOuts, registerOptOut, removeOptOut };
