// Exportação de contatos/resultados de campanha (item 9) — CSV apenas
// (mesmo corte de escopo do XLSX na importação). Nunca expõe token/segredo
// (não há nenhum nesses dados) e sempre sanitiza contra CSV formula
// injection via campaign-csv-service.js (item 28).
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const audit = require("./audit-service");
const { toCsv } = require("./campaign-csv-service");

const EXPORT_HEADERS = [
  "phone", "firstName", "fullName", "email", "companyName", "document", "city", "state",
  "status", "prospectStatus", "sentAt", "deliveredAt", "readAt", "repliedAt", "failedAt", "failureReason",
];

// Item 9: filtros de exportação — "todos" vs. um status técnico específico
// (enviados/entregues/lidos/responderam/falharam/opt-out) vs. status
// comercial "interessados".
function statusWhere(filter) {
  if (!filter || filter === "all") return {};
  if (filter === "interested") return { prospectStatus: "INTERESTED" };
  const map = {
    sent: { status: { in: ["SENT", "DELIVERED", "READ", "REPLIED"] } },
    delivered: { status: { in: ["DELIVERED", "READ", "REPLIED"] } },
    read: { status: { in: ["READ", "REPLIED"] } },
    replied: { status: "REPLIED" },
    failed: { status: "FAILED" },
    optOut: { status: "OPTED_OUT" },
  };
  return map[filter] || {};
}

async function exportCampaignContacts(campaignId, { filter } = {}, viewer) {
  const campaign = await require("./campaign-service").findCampaignOr404(campaignId, prisma, viewer);

  const rows = await prisma.campaignContact.findMany({
    where: { campaignId, isTest: false, ...statusWhere(filter) },
    orderBy: { createdAt: "asc" },
    take: 50000, // item 28: nunca exportação sem limite
  });

  const csv = toCsv(EXPORT_HEADERS, rows.map((row) => ({
    ...row,
    sentAt: row.sentAt?.toISOString() || "", deliveredAt: row.deliveredAt?.toISOString() || "",
    readAt: row.readAt?.toISOString() || "", repliedAt: row.repliedAt?.toISOString() || "",
    failedAt: row.failedAt?.toISOString() || "",
  })));

  await audit.recordAudit({
    actor: viewer, action: "CAMPAIGN_CONTACTS_EXPORTED", entityType: "CAMPAIGN", entityId: campaign.id,
    summary: `Exportou contatos da campanha "${campaign.name}" (filtro: ${filter || "all"})`,
    details: { filter: filter || "all", rows: rows.length },
  });

  return { csv, fileName: `campanha-${campaign.id}-${filter || "all"}.csv` };
}

module.exports = { exportCampaignContacts };
