// Backfill dos períodos de atendimento (ConversationAssignmentPeriod) para
// conversas anteriores ao recurso de supervisão. SEGURO POR PADRÃO:
//   node scripts/backfill-assignment-periods.js           → só simula e mostra o relatório
//   node scripts/backfill-assignment-periods.js --apply   → grava (source = BACKFILL)
// Nunca altera/apaga mensagens, atividades ou conversas; só INSERE períodos
// em conversas que ainda não têm nenhum (idempotente: pode rodar de novo).
require("dotenv").config({ quiet: true });
const prisma = require("../src/database/prisma");
const { reconstructPeriods } = require("../src/services/assignment-period-service");

const APPLY = process.argv.includes("--apply");
const BATCH = 200;
const ASSIGNMENT_ACTIONS = ["CONVERSATION_CREATED", "CONVERSATION_CLAIMED", "CONVERSATION_TRANSFERRED", "ASSIGNEE_REMOVED", "REOPENED_BY_CUSTOMER_MESSAGE"];

async function runBackfill({ apply = false, client = prisma, log = console.log } = {}) {
  const report = {
    mode: apply ? "APPLY" : "DRY_RUN", conversations: 0, skippedWithPeriods: 0, withoutParticipants: 0, periods: 0,
    byBasis: { ACTIVITY: 0, MESSAGES: 0, CURRENT_ASSIGNEE: 0 }, conversationsOnlyFromMessages: 0, inserted: 0,
  };
  let cursor = null;
  for (;;) {
    const conversations = await client.conversation.findMany({
      take: BATCH, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}), orderBy: { id: "asc" },
      select: { id: true, assignedUserId: true, createdAt: true, _count: { select: { assignmentPeriods: true } } },
    });
    if (!conversations.length) break;
    cursor = conversations[conversations.length - 1].id;
    const pending = conversations.filter((conversation) => {
      report.conversations += 1;
      if (conversation._count.assignmentPeriods) { report.skippedWithPeriods += 1; return false; }
      return true;
    });
    if (!pending.length) continue;
    const ids = pending.map(({ id }) => id);
    const [activities, spans] = await Promise.all([
      client.conversationActivity.findMany({ where: { conversationId: { in: ids }, action: { in: ASSIGNMENT_ACTIONS } }, select: { conversationId: true, action: true, details: true, createdAt: true, actorUserId: true } }),
      client.message.groupBy({ by: ["conversationId", "sentByUserId"], where: { conversationId: { in: ids }, sentByUserId: { not: null } }, _min: { occurredAt: true }, _max: { occurredAt: true } }),
    ]);
    const rows = [];
    for (const conversation of pending) {
      const periods = reconstructPeriods(
        conversation,
        activities.filter((activity) => activity.conversationId === conversation.id),
        spans.filter((span) => span.conversationId === conversation.id).map((span) => ({ userId: span.sentByUserId, first: span._min.occurredAt, last: span._max.occurredAt })),
      );
      if (!periods.length) { report.withoutParticipants += 1; continue; }
      if (periods.every((period) => period.basis !== "ACTIVITY")) report.conversationsOnlyFromMessages += 1;
      for (const period of periods) {
        report.periods += 1;
        report.byBasis[period.basis] += 1;
        rows.push({
          conversationId: conversation.id, userId: period.userId, startedAt: period.startedAt, endedAt: period.endedAt,
          startReason: period.startReason, endReason: period.endReason, transferredById: period.transferredById, source: "BACKFILL",
        });
      }
    }
    if (apply && rows.length) {
      // Usuário inexistente não gera período (FK) — descartado com segurança.
      const userIds = [...new Set(rows.flatMap((row) => [row.userId, row.transferredById]).filter(Boolean))];
      const existing = new Set((await client.user.findMany({ where: { id: { in: userIds } }, select: { id: true } })).map(({ id }) => id));
      const data = rows.filter((row) => existing.has(row.userId)).map((row) => ({ ...row, transferredById: existing.has(row.transferredById) ? row.transferredById : null }));
      const result = await client.conversationAssignmentPeriod.createMany({ data });
      report.inserted += result.count;
    }
  }
  log(JSON.stringify(report, null, 2));
  if (!apply) log("\nNada foi gravado. Revise o relatório e rode com --apply para gravar.");
  return report;
}

if (require.main === module) {
  runBackfill({ apply: APPLY }).catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
}

module.exports = { runBackfill };
