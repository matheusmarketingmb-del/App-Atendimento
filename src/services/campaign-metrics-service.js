// Métricas de campanha (item 23) — números simples, sem dashboard pesado.
// Nunca mostra conversão financeira (não há fonte real de receita neste
// projeto) — só o que os próprios dados de envio garantem.
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const { findCampaignOr404 } = require("./campaign-service");

function rate(numerator, denominator) {
  if (!denominator) return null;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

async function campaignMetrics(campaignId, viewer) {
  await findCampaignOr404(campaignId, prisma, viewer);

  const grouped = await prisma.campaignContact.groupBy({
    by: ["status"], where: { campaignId, isTest: false }, _count: { _all: true },
  });
  const byStatus = Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));
  const total = await prisma.campaignContact.count({ where: { campaignId, isTest: false } });
  const eligible = await prisma.campaignContact.count({ where: { campaignId, isTest: false, optOut: false } });

  const sent = (byStatus.SENT || 0) + (byStatus.DELIVERED || 0) + (byStatus.READ || 0) + (byStatus.REPLIED || 0);
  const delivered = (byStatus.DELIVERED || 0) + (byStatus.READ || 0) + (byStatus.REPLIED || 0);
  const read = (byStatus.READ || 0) + (byStatus.REPLIED || 0);
  const replied = byStatus.REPLIED || 0;
  const failed = byStatus.FAILED || 0;
  const optOut = byStatus.OPTED_OUT || 0;
  const queued = (byStatus.PENDING || 0) + (byStatus.QUEUED || 0) + (byStatus.SENDING || 0);
  const skipped = byStatus.SKIPPED || 0;

  return {
    total, eligible, ignored: total - eligible, queued, sent, delivered, read, replied, failed, optOut, skipped,
    deliveryRate: rate(delivered, sent), readRate: rate(read, delivered), replyRate: rate(replied, sent), failureRate: rate(failed, sent + failed),
  };
}

module.exports = { campaignMetrics };
