// Períodos de responsabilidade por conversa (ConversationAssignmentPeriod).
// Único ponto que abre/fecha períodos — chamado dentro da MESMA transação
// que muda Conversation.assignedUserId (assumir, transferir, responder,
// remover responsável, reabertura, campanha, nova conversa). A auditoria
// continua em ConversationActivity/AuditLog; isto é só o índice que permite
// responder "por quem esta conversa passou, e quando" sem varrer JSON.
const prisma = require("../database/prisma");

/**
 * Registra a troca de responsável: fecha os períodos em aberto de quem não
 * é mais o responsável e abre um para o novo (se ainda não houver).
 */
async function recordAssignmentChange(client, { conversationId, toUserId = null, at = new Date(), reason, endReason, transferredById = null }) {
  if (!conversationId) return;
  await client.conversationAssignmentPeriod.updateMany({
    where: { conversationId, endedAt: null, ...(toUserId ? { userId: { not: toUserId } } : {}) },
    data: { endedAt: at, endReason: endReason || reason },
  });
  if (!toUserId) return;
  const open = await client.conversationAssignmentPeriod.findFirst({
    where: { conversationId, userId: toUserId, endedAt: null }, select: { id: true },
  });
  if (open) return;
  await client.conversationAssignmentPeriod.create({
    data: { conversationId, userId: toUserId, startedAt: at, startReason: reason, transferredById },
  });
}

// ------------------------------------------------------------ Janelas
// Janela = { from: Date|null, to: Date|null } (null = sem limite). Usadas
// para recortar mensagens/eventos/anexos que o Supervisor pode ler.

function mergeWindows(windows) {
  const sorted = windows
    .map((window) => ({ from: window.from ? new Date(window.from) : null, to: window.to ? new Date(window.to) : null }))
    .sort((a, b) => (a.from?.getTime() ?? -Infinity) - (b.from?.getTime() ?? -Infinity));
  const merged = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    const startsInsideLast = last && (last.to === null || (window.from?.getTime() ?? -Infinity) <= last.to.getTime());
    if (!startsInsideLast) { merged.push({ ...window }); continue; }
    if (last.to !== null && (window.to === null || window.to > last.to)) last.to = window.to;
  }
  return merged;
}

function isFullWindow(windows) {
  return windows.length === 1 && windows[0].from === null && windows[0].to === null;
}

function withinWindows(date, windows) {
  if (!windows) return true;
  const time = new Date(date).getTime();
  return windows.some((window) => (!window.from || time >= window.from.getTime()) && (!window.to || time < window.to.getTime()));
}

/** Filtro Prisma de data para as janelas (campo `occurredAt` ou `createdAt`). */
function windowsWhere(windows, field) {
  if (!windows) return undefined;
  if (!windows.length) return { id: "__nenhuma_janela__" };
  return { OR: windows.map((window) => ({ [field]: { ...(window.from ? { gte: window.from } : {}), ...(window.to ? { lt: window.to } : {}) } })) };
}

/**
 * Janelas de supervisão: períodos em que alguém de `userIds` (equipe do
 * Supervisor + ele próprio) foi responsável. Conversa atribuída a alguém da
 * equipe antes deste recurso existir (sem período gravado) cai no último
 * evento de atribuição conhecido — ou na conversa inteira, se não houver.
 */
async function supervisionWindows(conversation, userIds, client = prisma) {
  if (!userIds.length) return [];
  const periods = await client.conversationAssignmentPeriod.findMany({
    where: { conversationId: conversation.id, userId: { in: userIds } },
    select: { userId: true, startedAt: true, endedAt: true },
  });
  const windows = periods.map((period) => ({ from: period.startedAt, to: period.endedAt }));
  const assignedInTeam = conversation.assignedUserId && userIds.includes(conversation.assignedUserId);
  const hasOpenForAssignee = periods.some((period) => period.userId === conversation.assignedUserId && !period.endedAt);
  if (assignedInTeam && !hasOpenForAssignee) {
    const lastAssignment = await client.conversationActivity.findFirst({
      where: {
        conversationId: conversation.id, action: { in: ["CONVERSATION_CLAIMED", "CONVERSATION_TRANSFERRED"] },
        details: { path: ["toUserId"], equals: conversation.assignedUserId },
      },
      orderBy: { createdAt: "desc" }, select: { createdAt: true },
    });
    windows.push({ from: lastAssignment?.createdAt || null, to: null });
  }
  return mergeWindows(windows);
}

/**
 * Reconstrução (backfill) dos períodos de uma conversa antiga a partir do que
 * já existe: eventos de atribuição do ConversationActivity (fonte principal),
 * mensagens enviadas (sentByUserId) de quem não aparece nos eventos e o
 * responsável atual. Pura — o script decide se grava.
 */
function reconstructPeriods({ assignedUserId, createdAt }, activities, messageSpans) {
  const result = [];
  let open = null;
  const close = (at, reason) => { if (open) { open.endedAt = at; open.endReason = reason; result.push(open); open = null; } };
  const start = (userId, at, reason, transferredById = null) => {
    if (open?.userId === userId) return;
    close(at, "TRANSFERRED");
    open = { userId, startedAt: at, endedAt: null, startReason: reason, endReason: null, transferredById, basis: "ACTIVITY" };
  };
  for (const activity of [...activities].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))) {
    const d = activity.details || {};
    const at = new Date(activity.createdAt);
    if (activity.action === "CONVERSATION_CREATED" && d.assignedUserId) start(d.assignedUserId, at, "CREATED");
    else if (activity.action === "CONVERSATION_CLAIMED" && d.toUserId) start(d.toUserId, at, "CLAIMED");
    else if (activity.action === "CONVERSATION_TRANSFERRED" && d.toUserId) start(d.toUserId, at, "TRANSFERRED", d.transferredByUserId || activity.actorUserId || null);
    else if (activity.action === "ASSIGNEE_REMOVED" || activity.action === "REOPENED_BY_CUSTOMER_MESSAGE") close(at, activity.action === "ASSIGNEE_REMOVED" ? "REMOVED" : "REOPENED");
  }
  // Último responsável pelos eventos não é o atual: a troca não deixou
  // rastro — o período termina quando começar o próximo conhecido.
  if (open && open.userId !== assignedUserId) { open.endReason = "UNKNOWN"; result.push(open); open = null; }
  if (open) result.push(open);
  // Mensagens de quem nunca aparece nos eventos (dados anteriores à trilha).
  for (const span of messageSpans) {
    if (result.some((period) => period.userId === span.userId)) continue;
    const isCurrent = span.userId === assignedUserId;
    result.push({
      userId: span.userId, startedAt: new Date(span.first), endedAt: isCurrent ? null : new Date(span.last),
      startReason: "BACKFILL_MESSAGES", endReason: isCurrent ? null : "UNKNOWN", transferredById: null, basis: "MESSAGES",
    });
  }
  if (assignedUserId && !result.some((period) => period.userId === assignedUserId && !period.endedAt)) {
    result.push({ userId: assignedUserId, startedAt: new Date(createdAt), endedAt: null, startReason: "BACKFILL_CURRENT_ASSIGNEE", endReason: null, transferredById: null, basis: "CURRENT_ASSIGNEE" });
  }
  const ordered = result.sort((a, b) => a.startedAt - b.startedAt);
  ordered.forEach((period, index) => {
    if (period.endedAt === null && period.endReason === "UNKNOWN") {
      const next = ordered.slice(index + 1).find((item) => item.startedAt > period.startedAt);
      period.endedAt = next?.startedAt || period.startedAt;
    }
  });
  return ordered;
}

module.exports = { isFullWindow, mergeWindows, reconstructPeriods, recordAssignmentChange, supervisionWindows, windowsWhere, withinWindows };
