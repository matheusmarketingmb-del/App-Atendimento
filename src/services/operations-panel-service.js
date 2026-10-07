// Central de Operação (Painel Operacional) — visão de "o que precisa de
// atenção agora" para Supervisor e Master.
//
// Escopo (sempre no backend):
//   - Master: todas as empresas (ou a filtrada).
//   - Supervisor: SÓ as empresas em que é Supervisor, e dentro delas só o
//     que o escopo de conversa já lhe dá (setores que gerencia + o que é
//     dele) — authorization.conversationScope. Nunca globaliza.
//   - Demais: 403.
// Nada aqui devolve texto/prévia/anexo de mensagem: só contagens, tempos e
// metadados da conversa (cliente, empresa, setor, responsável). Por isso o
// Financeiro protegido aparece apenas como contagem/linha "Financeiro" para
// quem já enxerga a conversa.
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const companyService = require("./company-service");
const privateSegments = require("./private-segment-service");
const { getConversationSettings } = require("./conversation-settings-service");
const { computeConversationMetrics, loadMessagesByConversation } = require("./conversation-analytics-service");

const ACTIVE_STATUSES = ["NOVO", "EM_ATENDIMENTO", "AGUARDANDO_EQUIPE", "AGUARDANDO_CLIENTE", "HANDOFF_BOT"];
const WAITING_TEAM = ["NOVO", "AGUARDANDO_EQUIPE", "HANDOFF_BOT"];
const STATUS_FILTERS = new Set([...ACTIVE_STATUSES, "BOT", "FINALIZADO"]);
const WORKING_SET_LIMIT = 2000;
const METRICS_COHORT_LIMIT = 500;
const TIME_ZONE = "America/Sao_Paulo";

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Empresas que o usuário pode acompanhar no painel (null = não pode).
async function operableCompanyIds(viewer) {
  const access = await companyService.companyAccess(viewer);
  if (authorization.isMaster(viewer)) return access.map(({ companyId }) => companyId);
  return access.filter(({ role }) => role === "SUPERVISOR").map(({ companyId }) => companyId);
}

async function canOpenPanel(viewer) {
  return (await operableCompanyIds(viewer)).length > 0;
}

// Início do dia no fuso da operação (sem depender do fuso do servidor).
function startOfToday(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", timeZoneName: "longOffset",
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  const offset = (parts.timeZoneName || "GMT").replace("GMT", "") || "+00:00";
  return new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00${offset}`);
}

function contactName(contact) {
  return contact?.customName || contact?.name || contact?.email || contact?.phone || "Cliente";
}

function minutesSince(date, now) {
  return date ? Math.max(0, Math.round((now.getTime() - new Date(date).getTime()) / 60000)) : null;
}

// SLA restante em minutos (negativo = estourado) — mesma régua do card da
// lista (inbox-service.computeSlaMinutesRemaining) e do monitor de SLA.
function slaState(conversation, settings, now) {
  if (conversation.firstResponseSlaBreached || conversation.responseSlaBreached) return "BREACHED";
  const since = (conversation.lastMessageAt || conversation.createdAt).getTime();
  let limit = null;
  if (conversation.status === "NOVO" && settings.firstResponseSlaEnabled) limit = settings.firstResponseSlaMinutes;
  if (["AGUARDANDO_EQUIPE", "HANDOFF_BOT"].includes(conversation.status) && settings.responseSlaEnabled) limit = settings.responseSlaMinutes;
  if (!limit) return "NONE";
  const elapsed = (now.getTime() - since) / 60000;
  if (elapsed >= limit) return "BREACHED";
  const percent = Math.min(Math.max(settings.slaNearBreachPercent || 80, 1), 99) / 100;
  return elapsed >= limit * percent ? "NEAR" : "OK";
}

// Motivo principal de atenção de uma conversa ativa (ou null). Ordem =
// prioridade: SLA estourado (vermelho) > próximo do limite (laranja) >
// cliente fixo aguardando > setor protegido aguardando > sem categoria >
// sem responsável.
function attentionReason(conversation, sla) {
  const waiting = WAITING_TEAM.includes(conversation.status);
  if (sla === "BREACHED" && (waiting || conversation.status === "EM_ATENDIMENTO")) return { reason: "SLA_BREACHED", severity: "critical" };
  if (sla === "NEAR") return { reason: "SLA_NEAR", severity: "warning" };
  const contact = conversation.contact;
  if (waiting && contact?.preferredAssigneeEnabled && contact.preferredAssigneeId && conversation.assignedUserId === contact.preferredAssigneeId) {
    return { reason: "PREFERRED_WAITING", severity: "neutral" };
  }
  if (waiting && privateSegments.privateRootOf(conversation.category)) return { reason: "PRIVATE_WAITING", severity: "neutral" };
  if (!conversation.categoryId && conversation.status !== "BOT") return { reason: "UNCATEGORIZED", severity: "neutral" };
  if (waiting && !conversation.assignedUserId) return { reason: "UNASSIGNED", severity: "neutral" };
  return null;
}

const SEVERITY_ORDER = { critical: 0, warning: 1, neutral: 2 };

async function resolveScope(viewer, { company, categoryId, assigneeId, status } = {}) {
  const operable = await operableCompanyIds(viewer);
  if (!operable.length) throw authorization.forbidden("Somente Supervisor ou Master acessam a Central de Operação.");
  let companyIds = operable;
  if (company && company !== companyService.ALL_COMPANIES) {
    const requested = await companyService.resolveCompanyFilter(viewer, company);
    companyIds = requested.filter((id) => operable.includes(id));
    if (!companyIds.length) throw authorization.forbidden("Você não acompanha a operação desta empresa.");
  }
  const filters = [await authorization.conversationScope(viewer), { companyId: { in: companyIds } }];
  if (categoryId === "UNCATEGORIZED") filters.push({ categoryId: null });
  else if (categoryId) filters.push({ OR: [{ categoryId }, { category: { is: { parentId: categoryId } } }] });
  if (assigneeId === "NONE") filters.push({ assignedUserId: null });
  else if (assigneeId) filters.push({ assignedUserId: assigneeId });
  if (status) {
    if (!STATUS_FILTERS.has(status)) throw fail("Status inválido.");
    filters.push({ status });
  }
  return { where: { AND: filters }, companyIds };
}

const WORKING_SET_SELECT = {
  id: true, companyId: true, status: true, categoryId: true, assignedUserId: true, priority: true,
  lastMessageAt: true, createdAt: true, firstResponseSlaBreached: true, responseSlaBreached: true,
  company: { select: { id: true, name: true, slug: true, displayName: true, primaryColor: true } },
  category: { select: { id: true, name: true, color: true, visibilityMode: true, parentId: true, parent: { select: { id: true, name: true, visibilityMode: true } } } },
  assignedUser: { select: { id: true, name: true } },
  contact: { select: {
    customName: true, name: true, phone: true, email: true,
    preferredAssigneeId: true, preferredAssigneeEnabled: true, preferredAssignee: { select: { id: true, name: true } },
  } },
};

async function getOverview(viewer, query = {}, { now = new Date(), onlineUserIds = null } = {}) {
  const { where, companyIds } = await resolveScope(viewer, query);
  const today = startOfToday(now);
  const active = { AND: [where, { status: { in: ACTIVE_STATUSES } }] };

  const [openCount, finalizedToday, waitingClient, waitingTeam, transfersToday, working] = await Promise.all([
    prisma.conversation.count({ where: active }),
    prisma.conversation.count({ where: { AND: [where, { status: "FINALIZADO", finalizedAt: { gte: today } }] } }),
    prisma.conversation.count({ where: { AND: [where, { status: "AGUARDANDO_CLIENTE" }] } }),
    prisma.conversation.count({ where: { AND: [where, { status: { in: WAITING_TEAM } }] } }),
    prisma.conversationActivity.count({ where: {
      action: { in: ["CONVERSATION_TRANSFERRED", "CATEGORY_CHANGED", "BOT_FLOW_TRANSFERRED", "BOT_FLOW_TRANSFERRED_TO_USER"] },
      createdAt: { gte: today }, conversation: { is: where },
    } }),
    // Conjunto de trabalho limitado (só conversas ativas, só metadados).
    prisma.conversation.findMany({
      where: active, select: WORKING_SET_SELECT,
      orderBy: [{ lastMessageAt: "asc" }], take: WORKING_SET_LIMIT + 1,
    }),
  ]);
  const truncated = working.length > WORKING_SET_LIMIT;
  const conversations = working.slice(0, WORKING_SET_LIMIT);

  const settingsByCompany = new Map();
  for (const companyId of new Set(conversations.map((conversation) => conversation.companyId))) {
    settingsByCompany.set(companyId, await getConversationSettings(prisma, companyId));
  }

  const cards = {
    waitingService: 0, unassigned: 0, slaCritical: 0, slaNear: 0, uncategorized: 0,
    preferredWaiting: 0, privateSectorPending: 0, open: openCount, finalizedToday, waitingClient, waitingTeam,
  };
  const attention = [];
  const team = new Map();
  const teamEntry = (user) => {
    if (!team.has(user.id)) team.set(user.id, { id: user.id, name: user.name, open: 0, slaCritical: 0, privateSector: 0, pending: 0 });
    return team.get(user.id);
  };

  for (const conversation of conversations) {
    const sla = slaState(conversation, settingsByCompany.get(conversation.companyId), now);
    const waiting = WAITING_TEAM.includes(conversation.status);
    const isPrivate = Boolean(privateSegments.privateRootOf(conversation.category));
    if (waiting) cards.waitingService += 1;
    if (waiting && !conversation.assignedUserId) cards.unassigned += 1;
    if (sla === "BREACHED") cards.slaCritical += 1;
    if (sla === "NEAR") cards.slaNear += 1;
    if (!conversation.categoryId) cards.uncategorized += 1;
    if (isPrivate && waiting) cards.privateSectorPending += 1;
    const contact = conversation.contact;
    const preferredWaiting = waiting && contact?.preferredAssigneeEnabled && contact.preferredAssigneeId
      && conversation.assignedUserId === contact.preferredAssigneeId;
    if (preferredWaiting) cards.preferredWaiting += 1;

    if (conversation.assignedUser) {
      const entry = teamEntry(conversation.assignedUser);
      entry.open += 1;
      if (sla === "BREACHED") entry.slaCritical += 1;
      if (isPrivate) entry.privateSector += 1;
      if (waiting) entry.pending += 1;
    }

    const flagged = attentionReason(conversation, sla);
    if (flagged) {
      attention.push({
        conversationId: conversation.id,
        contactName: contactName(contact),
        company: conversation.company,
        category: conversation.category ? { id: conversation.category.id, name: conversation.category.parent ? `${conversation.category.parent.name}: ${conversation.category.name}` : conversation.category.name, color: conversation.category.color } : null,
        privateSector: isPrivate,
        assignee: conversation.assignedUser,
        preferredAssignee: contact?.preferredAssigneeEnabled ? contact.preferredAssignee : null,
        status: conversation.status,
        priority: conversation.priority,
        waitingMinutes: minutesSince(conversation.lastMessageAt || conversation.createdAt, now),
        ...flagged,
      });
    }
  }

  attention.sort((left, right) => (SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity])
    || ((right.waitingMinutes || 0) - (left.waitingMinutes || 0)));
  const limit = Math.min(Math.max(Number(query.attentionLimit) || 20, 1), 100);
  const offset = Math.max(Number(query.attentionOffset) || 0, 0);

  // Equipe: quem tem conversa no escopo + (Supervisor) membros dos setores
  // que ele gerencia / (Master) usuários das empresas filtradas.
  const memberWhere = authorization.isMaster(viewer)
    ? { active: true, role: { not: "BOT" }, OR: [{ role: "ADMIN" }, { companyAccess: { some: { companyId: { in: companyIds }, active: true } } }] }
    : { active: true, role: { not: "BOT" }, categoryAccess: { some: { categoryId: { in: await authorization.allowedCategoryIds(viewer) }, category: { is: { companyId: { in: companyIds } } } } } };
  const members = await prisma.user.findMany({ where: memberWhere, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 200 });
  for (const member of members) teamEntry(member);
  const online = onlineUserIds || require("../realtime/inbox-events").connectedUserIds();
  const teamRows = [...team.values()]
    .map((entry) => ({ ...entry, online: online.has(entry.id) }))
    .sort((left, right) => (right.slaCritical - left.slaCritical) || (right.open - left.open) || left.name.localeCompare(right.name, "pt-BR"));

  return {
    generatedAt: now, truncated, companyIds,
    cards,
    attention: { total: attention.length, offset, limit, items: attention.slice(offset, offset + limit) },
    team: teamRows,
    metrics: await todayMetrics(where, today),
  };
}

// Métricas do dia (coorte limitada): primeira resposta e tempo de
// atendimento médios, transferências, conversas por atendente. Só tempos —
// nenhum conteúdo de mensagem sai daqui.
async function todayMetrics(where, today) {
  const [byAgent, cohort, transfers] = await Promise.all([
    prisma.conversation.groupBy({ by: ["assignedUserId"], where: { AND: [where, { status: { in: ACTIVE_STATUSES } }, { assignedUserId: { not: null } }] }, _count: { _all: true } }),
    prisma.conversation.findMany({
      where: { AND: [where, { OR: [{ createdAt: { gte: today } }, { finalizedAt: { gte: today } }] }] },
      select: { id: true, status: true, createdAt: true, finalizedAt: true },
      take: METRICS_COHORT_LIMIT + 1,
    }),
    prisma.conversationActivity.count({ where: { action: "CONVERSATION_TRANSFERRED", createdAt: { gte: today }, conversation: { is: where } } }),
  ]);
  const sample = cohort.slice(0, METRICS_COHORT_LIMIT);
  const messages = await loadMessagesByConversation(sample.map(({ id }) => id));
  const firstResponses = [];
  const handling = [];
  for (const conversation of sample) {
    const metrics = computeConversationMetrics(messages.get(conversation.id) || [], conversation);
    if (metrics.firstResponseSeconds !== null && conversation.createdAt >= today) firstResponses.push(metrics.firstResponseSeconds);
    if (metrics.resolutionSeconds !== null && conversation.finalizedAt >= today) handling.push(metrics.resolutionSeconds);
  }
  const average = (values) => (values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null);
  const users = byAgent.length ? await prisma.user.findMany({ where: { id: { in: byAgent.map(({ assignedUserId }) => assignedUserId) } }, select: { id: true, name: true } }) : [];
  const names = new Map(users.map(({ id, name }) => [id, name]));
  return {
    avgFirstResponseSeconds: average(firstResponses),
    avgHandlingSeconds: average(handling),
    transfersToday: transfers,
    sampleTruncated: cohort.length > METRICS_COHORT_LIMIT,
    conversationsByAgent: byAgent.map((row) => ({ userId: row.assignedUserId, name: names.get(row.assignedUserId) || "—", open: row._count._all }))
      .sort((left, right) => right.open - left.open),
  };
}

// Opções dos filtros (empresas, setores e responsáveis do escopo do painel).
async function getFilterOptions(viewer) {
  const companyIds = await operableCompanyIds(viewer);
  if (!companyIds.length) throw authorization.forbidden("Somente Supervisor ou Master acessam a Central de Operação.");
  const companies = (await companyService.companyAccess(viewer)).filter(({ companyId }) => companyIds.includes(companyId)).map(({ company }) => company);
  const allowed = await authorization.allowedCategoryIds(viewer);
  const categories = await prisma.category.findMany({
    where: { companyId: { in: companyIds }, active: true, parentId: null, ...(allowed === null ? {} : { OR: [{ id: { in: allowed } }, { children: { some: { id: { in: allowed } } } }] }) },
    select: { id: true, name: true, companyId: true }, orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
  });
  return { companies, categories };
}

module.exports = { attentionReason, canOpenPanel, getFilterOptions, getOverview, operableCompanyIds, slaState, startOfToday };
