// Supervisão de equipes: vínculo Supervisor → Atendentes (só o Master
// edita), visão "Minha equipe" (Supervisor) / "Equipes" (Master), atendimentos
// por atendente (atuais + histórico real por períodos) e a linha do tempo
// ("Histórico de atendimento") de uma conversa.
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const audit = require("./audit-service");
const periods = require("./assignment-period-service");

const IN_PROGRESS = ["EM_ATENDIMENTO", "AGUARDANDO_CLIENTE"];
const WAITING = ["NOVO", "AGUARDANDO_EQUIPE", "HANDOFF_BOT"];
const PAGE_SIZE = 30;

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function assertSupervisorOrMaster(user) {
  if (!authorization.isMaster(user) && user?.role !== "SUPERVISOR") throw authorization.forbidden("Área exclusiva de Supervisor e Master.");
}

// ------------------------------------------------------------- Equipes

async function listTeams(actor) {
  authorization.assertMaster(actor);
  const supervisors = await prisma.user.findMany({
    where: { role: "SUPERVISOR" }, orderBy: { name: "asc" },
    select: {
      id: true, name: true, email: true, active: true,
      supervisedMembers: { orderBy: { member: { name: "asc" } }, select: { createdAt: true, member: { select: { id: true, name: true, email: true, role: true, active: true } } } },
    },
  });
  return supervisors.map(({ supervisedMembers, ...supervisor }) => ({ ...supervisor, members: supervisedMembers.map(({ member, createdAt }) => ({ ...member, linkedAt: createdAt })) }));
}

async function searchAssignableUsers(actor, query) {
  authorization.assertMaster(actor);
  const q = String(query || "").trim().slice(0, 100);
  return prisma.user.findMany({
    where: {
      role: { in: ["ATENDENTE", "SUPERVISOR"] },
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] } : {}),
    },
    orderBy: [{ active: "desc" }, { name: "asc" }], take: 30,
    select: { id: true, name: true, email: true, role: true, active: true, supervisors: { select: { supervisor: { select: { id: true, name: true } } } } },
  }).then((users) => users.map(({ supervisors, ...user }) => ({ ...user, supervisors: supervisors.map(({ supervisor }) => supervisor) })));
}

async function loadSupervisorAndMember(supervisorId, memberId) {
  const [supervisor, member] = await Promise.all([
    prisma.user.findUnique({ where: { id: String(supervisorId) }, select: { id: true, name: true, role: true } }),
    prisma.user.findUnique({ where: { id: String(memberId) }, select: { id: true, name: true, role: true } }),
  ]);
  if (!supervisor || supervisor.role !== "SUPERVISOR") throw fail("Supervisor não encontrado.", 404);
  if (!member || !["ATENDENTE", "SUPERVISOR"].includes(member.role)) throw fail("Atendente não encontrado.", 404);
  if (supervisor.id === member.id) throw fail("O Supervisor não pode ser membro da própria equipe.");
  return { supervisor, member };
}

// Somente o Master altera equipes — o Supervisor nunca se autoatribui pessoas.
async function addTeamMember(actor, supervisorId, memberId) {
  authorization.assertMaster(actor);
  const { supervisor, member } = await loadSupervisorAndMember(supervisorId, memberId);
  const existing = await prisma.supervisorTeamMember.findUnique({ where: { supervisorId_memberId: { supervisorId: supervisor.id, memberId: member.id } } });
  if (existing) return { added: false };
  await prisma.$transaction(async (transaction) => {
    await transaction.supervisorTeamMember.create({ data: { supervisorId: supervisor.id, memberId: member.id, createdById: actor.id } });
    await audit.recordAudit({
      actor, action: "SUPERVISOR_TEAM_MEMBER_ADDED", entityType: "USER", entityId: supervisor.id,
      summary: `Adicionou ${member.name} à equipe do Supervisor ${supervisor.name}`,
      details: { supervisorId: supervisor.id, supervisor: supervisor.name, memberId: member.id, member: member.name },
    }, transaction);
  });
  return { added: true };
}

async function removeTeamMember(actor, supervisorId, memberId) {
  authorization.assertMaster(actor);
  const { supervisor, member } = await loadSupervisorAndMember(supervisorId, memberId);
  const removed = await prisma.$transaction(async (transaction) => {
    const result = await transaction.supervisorTeamMember.deleteMany({ where: { supervisorId: supervisor.id, memberId: member.id } });
    if (result.count) {
      await audit.recordAudit({
        actor, action: "SUPERVISOR_TEAM_MEMBER_REMOVED", entityType: "USER", entityId: supervisor.id,
        summary: `Removeu ${member.name} da equipe do Supervisor ${supervisor.name}`,
        details: { supervisorId: supervisor.id, supervisor: supervisor.name, memberId: member.id, member: member.name },
      }, transaction);
    }
    return result.count > 0;
  });
  return { removed };
}

// ------------------------------------------------------- Visão de equipe

function todayRange(now = new Date()) {
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const start = new Date(`${key}T00:00:00-03:00`);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

/** Quem o usuário pode consultar: Master → qualquer um; Supervisor → equipe + ele mesmo. */
async function assertCanSeeMember(viewer, memberId) {
  if (authorization.isMaster(viewer)) return;
  assertSupervisorOrMaster(viewer);
  if (!(await authorization.supervisedUserIds(viewer)).includes(String(memberId))) {
    throw authorization.forbidden("Este usuário não faz parte da sua equipe.");
  }
}

/**
 * Master: equipe de um Supervisor (supervisorId) ou todos os atendentes.
 * Supervisor: sempre e somente a própria equipe (+ ele mesmo).
 * Contadores agregados em poucas consultas (sem N+1).
 */
async function teamOverview(viewer, { supervisorId } = {}) {
  assertSupervisorOrMaster(viewer);
  let memberIds;
  let supervisor = null;
  if (authorization.isMaster(viewer)) {
    if (supervisorId) {
      supervisor = await prisma.user.findUnique({ where: { id: String(supervisorId) }, select: { id: true, name: true, role: true } });
      if (!supervisor || supervisor.role !== "SUPERVISOR") throw fail("Supervisor não encontrado.", 404);
      memberIds = [supervisor.id, ...(await prisma.supervisorTeamMember.findMany({ where: { supervisorId: supervisor.id }, select: { memberId: true } })).map(({ memberId }) => memberId)];
    } else {
      memberIds = (await prisma.user.findMany({ where: { role: { in: ["ATENDENTE", "SUPERVISOR"] } }, select: { id: true } })).map(({ id }) => id);
    }
  } else {
    supervisor = { id: viewer.id, name: viewer.name };
    memberIds = await authorization.supervisedUserIds(viewer);
  }
  const { start, end } = todayRange();
  const [users, current, todayPeriods, todayMessages] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: memberIds } }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true, role: true, active: true } }),
    prisma.conversation.groupBy({ by: ["assignedUserId", "status"], where: { assignedUserId: { in: memberIds } }, _count: { _all: true } }),
    prisma.conversationAssignmentPeriod.findMany({
      where: { userId: { in: memberIds }, startedAt: { lt: end }, OR: [{ endedAt: null }, { endedAt: { gte: start } }] },
      select: { userId: true, conversationId: true }, distinct: ["userId", "conversationId"],
    }),
    prisma.message.findMany({
      where: { sentByUserId: { in: memberIds }, occurredAt: { gte: start, lt: end } },
      select: { sentByUserId: true, conversationId: true }, distinct: ["sentByUserId", "conversationId"],
    }),
  ]);
  const today = new Map();
  for (const { userId, conversationId } of todayPeriods) (today.get(userId) || today.set(userId, new Set()).get(userId)).add(conversationId);
  for (const { sentByUserId, conversationId } of todayMessages) (today.get(sentByUserId) || today.set(sentByUserId, new Set()).get(sentByUserId)).add(conversationId);
  return {
    supervisor,
    members: users.map((user) => {
      const rows = current.filter((row) => row.assignedUserId === user.id);
      const sum = (statuses) => rows.filter((row) => statuses.includes(row.status)).reduce((total, row) => total + row._count._all, 0);
      return { ...user, isSelf: user.id === (supervisor?.id || null), inProgress: sum(IN_PROGRESS), waiting: sum(WAITING), handledToday: today.get(user.id)?.size || 0 };
    }),
  };
}

// ------------------------------------------ Atendimentos por atendente

function csv(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function dateOrNull(value, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const date = new Date(`${value}T00:00:00-03:00`);
  return endOfDay ? new Date(date.getTime() + 86_400_000) : date;
}

/**
 * ATUAIS: conversas hoje atribuídas ao atendente. HISTÓRICO: todas as
 * conversas pelas quais ele passou (períodos de responsabilidade + mensagens
 * que ele enviou), inclusive transferidas depois e finalizadas.
 */
async function memberConversations(viewer, memberId, query = {}) {
  await assertCanSeeMember(viewer, memberId);
  const id = String(memberId);
  const tab = query.tab === "history" ? "history" : "current";
  const page = Math.max(Number(query.page) || 1, 1);
  const from = dateOrNull(query.from);
  const to = dateOrNull(query.to, true);
  const participation = { OR: [
    { assignmentPeriods: { some: { userId: id, ...(to ? { startedAt: { lt: to } } : {}), ...(from ? { OR: [{ endedAt: null }, { endedAt: { gte: from } }] } : {}) } } },
    ...(!from && !to ? [{ messages: { some: { sentByUserId: id } } }] : [{ messages: { some: { sentByUserId: id, occurredAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } } }]),
  ] };
  const AND = [tab === "current" ? { assignedUserId: id } : participation];
  // Supervisor: além de o atendente ser da equipe, a conversa precisa estar
  // no escopo de leitura dele (nunca categorias exclusivas do Master).
  if (!authorization.isMaster(viewer)) AND.push(await authorization.conversationScope(viewer));
  const statuses = csv(query.status);
  if (statuses.length) AND.push({ status: { in: statuses } });
  const priorities = csv(query.priority);
  if (priorities.length) AND.push({ priority: { in: priorities } });
  if (query.categoryId === "none") AND.push({ categoryId: null });
  else if (query.categoryId) AND.push({ OR: [{ categoryId: String(query.categoryId) }, { category: { is: { parentId: String(query.categoryId) } } }] });
  if (query.assignedUserId === "none") AND.push({ assignedUserId: null });
  else if (query.assignedUserId) AND.push({ assignedUserId: String(query.assignedUserId) });
  if (query.state === "active") AND.push({ status: { not: "FINALIZADO" } });
  if (query.state === "finished") AND.push({ status: "FINALIZADO" });
  if (query.state === "transferred") AND.push({ NOT: { assignedUserId: id } }, { assignedUserId: { not: null } });
  const q = String(query.q || "").trim();
  if (q) AND.push({ contact: { is: { OR: [{ name: { contains: q, mode: "insensitive" } }, { customName: { contains: q, mode: "insensitive" } }, { phone: { contains: q.replace(/\D/g, "") || q } }, { email: { contains: q, mode: "insensitive" } }] } } });

  const where = { AND };
  const [total, conversations] = await Promise.all([
    prisma.conversation.count({ where }),
    prisma.conversation.findMany({
      where, orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }], take: PAGE_SIZE, skip: (page - 1) * PAGE_SIZE,
      select: {
        id: true, channel: true, status: true, priority: true, lastMessageAt: true, createdAt: true, finalizedAt: true,
        contact: { select: { name: true, customName: true, phone: true, email: true } },
        category: { select: { id: true, name: true, color: true, parent: { select: { name: true } } } },
        channelAccount: { select: { name: true } },
        assignedUser: { select: { id: true, name: true } },
      },
    }),
  ]);
  const ids = conversations.map(({ id: conversationId }) => conversationId);
  const [memberPeriods, sentCounts, firstLastMessages] = ids.length ? await Promise.all([
    prisma.conversationAssignmentPeriod.findMany({ where: { conversationId: { in: ids }, userId: id }, select: { conversationId: true, startedAt: true, endedAt: true } }),
    prisma.message.groupBy({ by: ["conversationId"], where: { conversationId: { in: ids }, sentByUserId: id }, _count: { _all: true } }),
    prisma.message.groupBy({ by: ["conversationId"], where: { conversationId: { in: ids }, sentByUserId: id }, _min: { occurredAt: true }, _max: { occurredAt: true } }),
  ]) : [[], [], []];
  const sent = new Map(sentCounts.map((row) => [row.conversationId, row._count._all]));
  const messageSpan = new Map(firstLastMessages.map((row) => [row.conversationId, row]));
  const master = authorization.isMaster(viewer);
  return {
    tab, total, page, pageSize: PAGE_SIZE,
    rows: conversations.map((conversation) => {
      const own = memberPeriods.filter((period) => period.conversationId === conversation.id);
      const span = messageSpan.get(conversation.id);
      const starts = [...own.map((period) => period.startedAt), span?._min.occurredAt].filter(Boolean).map((date) => date.getTime());
      const open = own.some((period) => !period.endedAt);
      const ends = [...own.map((period) => period.endedAt), span?._max.occurredAt].filter(Boolean).map((date) => date.getTime());
      return {
        id: conversation.id,
        contact: conversation.contact.customName || conversation.contact.name || conversation.contact.email || conversation.contact.phone,
        phone: conversation.contact.phone || conversation.contact.email || null,
        channel: conversation.channel,
        channelAccount: conversation.channelAccount?.name || null,
        category: conversation.category ? { ...conversation.category, label: conversation.category.parent ? `${conversation.category.parent.name} › ${conversation.category.name}` : conversation.category.name } : null,
        status: conversation.status,
        priority: conversation.priority,
        currentAssignee: conversation.assignedUser,
        transferred: Boolean(conversation.assignedUser && conversation.assignedUser.id !== id),
        firstParticipationAt: starts.length ? new Date(Math.min(...starts)) : null,
        lastParticipationAt: open ? null : ends.length ? new Date(Math.max(...ends)) : null,
        inProgressWithMember: open,
        periods: own.sort((a, b) => a.startedAt - b.startedAt),
        messagesSentByMember: sent.get(conversation.id) || 0,
        // Supervisor não vê o horário de atividade fora do trecho da equipe.
        lastMessageAt: master ? conversation.lastMessageAt : null,
        finalizedAt: conversation.finalizedAt,
      };
    }),
  };
}

// ------------------------------------------ Linha do tempo da conversa

const ACTIVITY_LABELS = {
  CONVERSATION_CREATED: "Conversa criada", CONVERSATION_CLAIMED: "assumiu a conversa", CONVERSATION_TRANSFERRED: "transferiu a conversa",
  ASSIGNEE_REMOVED: "removeu o responsável", CATEGORY_CHANGED: "alterou o setor", STATUS_CHANGED: "alterou o status", PRIORITY_CHANGED: "alterou a prioridade",
  REOPENED_BY_CUSTOMER_MESSAGE: "Cliente voltou a escrever (conversa reaberta)", AUTO_FINALIZED_INACTIVITY: "Finalizada automaticamente por inatividade",
  BOT_TRIAGE_COMPLETED: "Triagem do Bot concluída", NOTE_ADDED: "adicionou uma nota", CONVERSATION_FINALIZED: "finalizou a conversa",
};

function describe(activity) {
  const d = activity.details || {};
  const actor = activity.actorUser?.name || (d.automatic ? d.to : null);
  switch (activity.action) {
    case "CONVERSATION_CLAIMED": return `${d.to || actor || "Atendente"} assumiu a conversa${d.automatic ? " ao responder" : ""}`;
    case "CONVERSATION_TRANSFERRED": return `${actor || d.from || "Atendente"} transferiu de ${d.from || "—"} para ${d.to || "—"}${d.toCategory && d.toCategory !== d.fromCategory ? ` (${d.toCategory})` : ""}${d.historyShared === false ? " — sem compartilhar histórico" : ""}`;
    case "ASSIGNEE_REMOVED": return `${actor || "Alguém"} removeu ${d.from || "o responsável"} da conversa`;
    case "CATEGORY_CHANGED": return `${actor || "Sistema"} alterou o setor: ${d.from || "—"} → ${d.to || "—"}`;
    case "STATUS_CHANGED": return d.to === "FINALIZADO" ? `${actor || "Sistema"} finalizou a conversa` : `${actor || "Sistema"} alterou o status: ${d.from || "—"} → ${d.to || "—"}`;
    case "PRIORITY_CHANGED": return `${actor || "Alguém"} alterou a prioridade: ${d.from || "—"} → ${d.to || "—"}`;
    default: return `${actor ? `${actor} ` : ""}${ACTIVITY_LABELS[activity.action] || activity.action}`;
  }
}

/**
 * "Histórico de atendimento". Master: completo. Supervisor: somente os
 * eventos dentro dos trechos em que a equipe dele (ou ele) foi responsável
 * — a escolha "compartilhar histórico" do atendente não restringe isso.
 */
async function conversationTimeline(viewer, conversationId) {
  assertSupervisorOrMaster(viewer);
  const conversation = await authorization.assertCanViewConversation(viewer, String(conversationId));
  const master = authorization.isMaster(viewer);
  let windows = null;
  if (!master) {
    const { readVisibility } = require("./inbox-service");
    windows = (await readVisibility(conversation, viewer)).windows;
  }
  // Limite do trecho inclusivo na linha do tempo: o evento que ENCERROU o
  // trecho (ex.: a transferência) aparece para quem supervisiona.
  const inside = (date) => !windows || windows.some((window) => (!window.from || date >= window.from) && (!window.to || date <= window.to));
  const [activities, assignmentPeriods, sentGroups] = await Promise.all([
    prisma.conversationActivity.findMany({
      where: { conversationId: conversation.id, action: { notIn: ["NOTE_ADDED", "NOTE_DELETED"] } },
      orderBy: { createdAt: "asc" },
      select: { id: true, action: true, details: true, createdAt: true, actorUser: { select: { id: true, name: true } } },
    }),
    prisma.conversationAssignmentPeriod.findMany({
      where: { conversationId: conversation.id }, orderBy: { startedAt: "asc" },
      select: { userId: true, startedAt: true, endedAt: true, startReason: true, endReason: true, source: true, user: { select: { id: true, name: true } } },
    }),
    prisma.message.groupBy({ by: ["sentByUserId"], where: { conversationId: conversation.id, sentByUserId: { not: null } }, _count: { _all: true } }),
  ]);
  const team = master ? null : new Set(await authorization.supervisedUserIds(viewer));
  const users = new Map((await prisma.user.findMany({ where: { id: { in: sentGroups.map((row) => row.sentByUserId) } }, select: { id: true, name: true } })).map((user) => [user.id, user.name]));
  return {
    conversationId: conversation.id,
    scope: master ? "FULL" : windows ? "TEAM_SEGMENTS" : "FULL",
    windows,
    events: activities.filter((activity) => inside(activity.createdAt)).map((activity) => ({
      id: activity.id, at: activity.createdAt, action: activity.action, text: describe(activity), actor: activity.actorUser,
    })),
    participants: assignmentPeriods
      .filter((period) => master || team.has(period.userId))
      .map((period) => ({ user: period.user, startedAt: period.startedAt, endedAt: period.endedAt, startReason: period.startReason, endReason: period.endReason, source: period.source })),
    messagesByUser: sentGroups
      .filter((row) => master || team.has(row.sentByUserId))
      .map((row) => ({ userId: row.sentByUserId, name: users.get(row.sentByUserId) || "Usuário", count: row._count._all })),
  };
}

module.exports = {
  addTeamMember, conversationTimeline, listTeams, memberConversations, removeTeamMember, searchAssignableUsers, teamOverview,
  _internals: { describe, periods },
};
