// Motor de agregação do Relatório de Conversas. Todo cálculo aqui é sobre
// dados REAIS já existentes (Conversation/Message/ConversationActivity) —
// nunca inventa métrica que o schema não sustente (ver docs/
// CONVERSATION_REPORT.md para a auditoria completa e a classificação
// A/B/C/D de cada métrica).
//
// Vocabulário fixo (documentado no pedido original, item 21/22/23):
//   BOT      = Message.direction=ENVIADA E sentByUserId IS NULL
//   HUMAN    = Message.direction=ENVIADA E sentByUserId IS NOT NULL
//   CUSTOMER = Message.direction=RECEBIDA
//   SYSTEM   = eventos de ConversationActivity (nunca uma linha de Message)
// Mensagem do Bot NUNCA conta como resposta do vendedor em nenhuma métrica
// abaixo.
const prisma = require("../database/prisma");
const { resolvePeriod, buildConversationWhere } = require("./conversation-report-filters-service");
const { STATUS_LABELS, CHANNEL_LABELS } = require("./conversation-report-constants");

// Acima disto, cálculos que exigem ler mensagem por mensagem (tempo de
// resposta/resolução) são pulados — item 26 do pedido ("não carregar
// milhares de conversas completas inicialmente"). As contagens baseadas só
// em `Conversation` (recebidas/novas/status) continuam saindo normalmente
// (são um groupBy/count, nunca escalam com o nº de mensagens).
const MAX_MESSAGE_COHORT = 4000;
// Teto de mensagens cruas lidas para o heatmap (item 17) — evita puxar anos
// de histórico de uma vez quando o período for "Todo o histórico".
const MAX_HEATMAP_MESSAGES = 30000;

function average(numbers) {
  if (!numbers.length) return null;
  return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
}
function percentChange(current, previous) {
  if (previous === 0 || previous === null || previous === undefined) return current > 0 ? null : 0;
  return ((current - previous) / previous) * 100;
}
function classify(message) {
  if (message.direction === "RECEBIDA") return "CUSTOMER";
  return message.sentByUserId ? "HUMAN" : "BOT";
}

// -----------------------------------------------------------------------
// Cohort: conversas com atividade (criadas OU com última mensagem) dentro
// da janela, já filtradas pelas dimensões (vendedor/canal/categoria/status/
// prioridade). Mesma base usada por summary/timeseries de status/heatmap de
// alto nível — nunca duas definições de "conversa do período" diferentes.
// -----------------------------------------------------------------------
async function loadCohort({ start, end, dimensions }, client = prisma) {
  return client.conversation.findMany({
    where: {
      ...dimensions,
      OR: [{ createdAt: { gte: start, lt: end } }, { lastMessageAt: { gte: start, lt: end } }],
    },
    select: {
      id: true, companyId: true, status: true, priority: true, channel: true, categoryId: true, assignedUserId: true,
      createdAt: true, lastMessageAt: true, finalizedAt: true,
      firstResponseSlaBreached: true, responseSlaBreached: true,
    },
  });
}

// Lê TODAS as mensagens de uma lista de conversas, agrupadas por
// conversationId, ordenadas por occurredAt — base para todo cálculo de
// tempo (primeira resposta / tempo de resposta / distinção Bot x Humano).
async function loadMessagesByConversation(conversationIds, client = prisma) {
  const map = new Map();
  if (!conversationIds.length) return map;
  const messages = await client.message.findMany({
    where: { conversationId: { in: conversationIds } },
    orderBy: [{ conversationId: "asc" }, { occurredAt: "asc" }],
    select: { conversationId: true, direction: true, sentByUserId: true, occurredAt: true, text: true, type: true },
  });
  for (const message of messages) {
    if (!map.has(message.conversationId)) map.set(message.conversationId, []);
    map.get(message.conversationId).push(message);
  }
  return map;
}

// Percorre as mensagens de UMA conversa e devolve as métricas de tempo.
// `firstResponseAgentId`/`responses[].agentId` atribuem cada resposta a
// quem REALMENTE a enviou (sentByUserId daquela mensagem específica) — não
// ao responsável atual da conversa, que pode ter mudado depois.
function computeConversationMetrics(messages, conversation) {
  let firstCustomerAt = null;
  let firstHumanAt = null;
  let firstResponseAgentId = null;
  let pendingCustomerAt = null;
  const responses = [];
  let answered = false;
  let answeredByAgent = false;

  for (const message of messages) {
    const kind = classify(message);
    if (kind === "CUSTOMER") {
      if (!firstCustomerAt) firstCustomerAt = message.occurredAt;
      if (pendingCustomerAt === null) pendingCustomerAt = message.occurredAt;
      continue;
    }
    if (kind === "BOT") { answered = true; continue; }
    answered = true;
    answeredByAgent = true;
    if (!firstHumanAt) { firstHumanAt = message.occurredAt; firstResponseAgentId = message.sentByUserId; }
    if (pendingCustomerAt !== null) {
      responses.push({ seconds: (message.occurredAt.getTime() - pendingCustomerAt.getTime()) / 1000, agentId: message.sentByUserId });
      pendingCustomerAt = null;
    }
  }

  const anchor = firstCustomerAt || conversation.createdAt;
  const firstResponseSeconds = firstHumanAt ? Math.max(0, (firstHumanAt.getTime() - anchor.getTime()) / 1000) : null;
  const resolutionSeconds = conversation.status === "FINALIZADO" && conversation.finalizedAt
    ? Math.max(0, (conversation.finalizedAt.getTime() - conversation.createdAt.getTime()) / 1000) : null;

  return {
    answered, answeredByAgent, firstResponseSeconds, firstResponseAgentId, responses, resolutionSeconds,
    lastMessage: messages[messages.length - 1] || null,
  };
}

async function computeCohortMetrics(cohort, client = prisma) {
  const truncated = cohort.length > MAX_MESSAGE_COHORT;
  if (truncated) return { metricsById: new Map(), truncated };
  const messagesByConversation = await loadMessagesByConversation(cohort.map((c) => c.id), client);
  const metricsById = new Map();
  for (const conversation of cohort) {
    metricsById.set(conversation.id, computeConversationMetrics(messagesByConversation.get(conversation.id) || [], conversation));
  }
  return { metricsById, truncated };
}

// -----------------------------------------------------------------------
// 1. Resumo / KPIs (item 3/4)
// -----------------------------------------------------------------------
async function summaryFor({ start, end, dimensions }, client = prisma) {
  const cohort = await loadCohort({ start, end, dimensions }, client);
  const { metricsById, truncated } = await computeCohortMetrics(cohort, client);

  const newConversations = cohort.filter((c) => c.createdAt >= start && c.createdAt < end).length;
  const resolved = cohort.filter((c) => c.status === "FINALIZADO").length;
  const awaitingTeam = cohort.filter((c) => c.status === "AGUARDANDO_EQUIPE").length;
  const awaitingCustomer = cohort.filter((c) => c.status === "AGUARDANDO_CLIENTE").length;

  let neverAnswered = null; let resolvedWithoutAgent = null; let answeredCount = null;
  let firstResponseAvg = null; let responseAvg = null; let resolutionAvg = null; let slaMet = null;
  if (!truncated) {
    const metrics = [...metricsById.values()];
    neverAnswered = metrics.filter((m) => !m.answered).length;
    resolvedWithoutAgent = cohort.filter((c) => c.status === "FINALIZADO" && !metricsById.get(c.id)?.answeredByAgent).length;
    answeredCount = metrics.filter((m) => m.answered).length;
    firstResponseAvg = average(metrics.map((m) => m.firstResponseSeconds).filter((v) => v !== null));
    responseAvg = average(metrics.flatMap((m) => m.responses.map((r) => r.seconds)));
    resolutionAvg = average(metrics.map((m) => m.resolutionSeconds).filter((v) => v !== null));
    const activeWithSla = cohort.filter((c) => c.firstResponseSlaBreached || c.responseSlaBreached);
    slaMet = cohort.length ? ((cohort.length - activeWithSla.length) / cohort.length) * 100 : null;
  }

  return {
    conversationsReceived: cohort.length,
    newConversations, resolved, awaitingTeam, awaitingCustomer,
    neverAnswered, resolvedWithoutAgentResponse: resolvedWithoutAgent,
    responseRate: cohort.length && answeredCount !== null ? (answeredCount / cohort.length) * 100 : null,
    resolutionRate: cohort.length ? (resolved / cohort.length) * 100 : null,
    firstResponseAvgSeconds: firstResponseAvg, responseAvgSeconds: responseAvg, resolutionAvgSeconds: resolutionAvg,
    slaMetPercent: slaMet,
    truncated,
  };
}

async function getSummary(query) {
  const filters = resolvePeriod(query);
  const dimensions = buildConversationWhere(query);
  const [current, previous] = await Promise.all([
    summaryFor({ start: filters.start, end: filters.end, dimensions }),
    filters.preset === "all" ? null : summaryFor({ start: filters.previousStart, end: filters.previousEnd, dimensions }),
  ]);
  const keys = [
    "conversationsReceived", "newConversations", "resolved", "awaitingTeam", "awaitingCustomer", "neverAnswered",
    "resolvedWithoutAgentResponse", "responseRate", "resolutionRate", "firstResponseAvgSeconds", "responseAvgSeconds",
    "resolutionAvgSeconds", "slaMetPercent",
  ];
  const changes = {};
  if (previous) for (const key of keys) changes[key] = percentChange(current[key], previous[key]);
  return { period: { start: filters.start, end: filters.end, label: filters.label, preset: filters.preset }, current, previous, changes };
}

// -----------------------------------------------------------------------
// 2. Série temporal (item 5)
// -----------------------------------------------------------------------
function bucketKeyFor(date, granularity) {
  const d = new Date(date);
  if (granularity === "hour") return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
  if (granularity === "month") return `${d.getFullYear()}-${d.getMonth()}`;
  if (granularity === "week") {
    const diffToMonday = (d.getDay() + 6) % 7;
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diffToMonday);
    return `${monday.getFullYear()}-${monday.getMonth()}-${monday.getDate()}`;
  }
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; // day
}
function bucketLabelFor(date, granularity) {
  if (granularity === "hour") return date.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit" }) + "h";
  if (granularity === "month") return date.toLocaleDateString("pt-BR", { month: "short", year: "numeric" });
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}
function defaultGranularity(preset) {
  if (preset === "today" || preset === "yesterday") return "hour";
  if (preset === "this_month" || preset === "last_month" || preset === "30d") return "day";
  if (preset === "all") return "month";
  return "day";
}

async function timeseriesFor({ start, end, dimensions, metric, granularity }, client = prisma) {
  const whereBase = { conversation: dimensions };
  let rows;
  if (metric === "conversations_received" || metric === "resolved") {
    rows = await client.conversation.findMany({
      where: { ...dimensions, ...(metric === "resolved" ? { status: "FINALIZADO", finalizedAt: { gte: start, lt: end } } : { createdAt: { gte: start, lt: end } }) },
      select: { createdAt: true, finalizedAt: true },
    });
    rows = rows.map((r) => ({ occurredAt: metric === "resolved" ? r.finalizedAt : r.createdAt }));
  } else {
    const direction = metric === "messages_sent" ? "ENVIADA" : "RECEBIDA";
    rows = await client.message.findMany({
      where: { direction, occurredAt: { gte: start, lt: end }, ...whereBase },
      select: { occurredAt: true },
      take: MAX_HEATMAP_MESSAGES,
    });
  }

  const buckets = new Map();
  for (const row of rows) {
    const key = bucketKeyFor(row.occurredAt, granularity);
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  return { rows, buckets };
}

async function getTimeseries(query) {
  const filters = resolvePeriod(query);
  const dimensions = buildConversationWhere(query);
  const metric = ["conversations_received", "resolved", "messages_received", "messages_sent"].includes(query.metric) ? query.metric : "conversations_received";
  const granularity = ["hour", "day", "week", "month"].includes(query.granularity) ? query.granularity : defaultGranularity(filters.preset);

  const { buckets } = await timeseriesFor({ start: filters.start, end: filters.end, dimensions, metric, granularity }, prisma);

  // Preenche TODOS os buckets do intervalo (nunca pula um dia/hora sem
  // dado — um gráfico com buraco silencioso é enganoso).
  const points = [];
  const cursor = new Date(filters.start);
  while (cursor < filters.end) {
    points.push({ key: bucketKeyFor(cursor, granularity), label: bucketLabelFor(cursor, granularity), value: buckets.get(bucketKeyFor(cursor, granularity)) || 0 });
    if (granularity === "hour") cursor.setHours(cursor.getHours() + 1);
    else if (granularity === "week") cursor.setDate(cursor.getDate() + 7);
    else if (granularity === "month") cursor.setMonth(cursor.getMonth() + 1);
    else cursor.setDate(cursor.getDate() + 1);
  }
  // dedupe (granularidade mês/semana pode gerar chave repetida ao avançar por dia dentro do mesmo bucket)
  const seen = new Map();
  for (const point of points) if (!seen.has(point.key)) seen.set(point.key, point);

  let comparePoints = null;
  if (query.compare === "true" && filters.preset !== "all") {
    const { buckets: previousBuckets } = await timeseriesFor({ start: filters.previousStart, end: filters.previousEnd, dimensions, metric, granularity }, prisma);
    comparePoints = [...seen.values()].map((point, index) => {
      const previousValues = [...previousBuckets.values()];
      return { ...point, previousValue: previousValues[index] ?? null };
    });
  }

  return { metric, granularity, points: comparePoints || [...seen.values()] };
}

// -----------------------------------------------------------------------
// 3. Situação / canais / categorias (itens 6/7/8)
// -----------------------------------------------------------------------
async function getStatusBreakdown(query) {
  const filters = resolvePeriod(query);
  const dimensions = buildConversationWhere(query);
  const cohort = await loadCohort({ start: filters.start, end: filters.end, dimensions });
  const { metricsById, truncated } = await computeCohortMetrics(cohort);
  const counts = {};
  for (const status of Object.keys(STATUS_LABELS)) counts[status] = 0;
  let neverAnswered = 0;
  for (const conversation of cohort) {
    counts[conversation.status] = (counts[conversation.status] || 0) + 1;
    if (!truncated && !metricsById.get(conversation.id)?.answered) neverAnswered += 1;
  }
  return {
    total: cohort.length, truncated,
    items: [
      ...Object.entries(counts).map(([status, count]) => ({ key: status, label: STATUS_LABELS[status], count })),
      ...(truncated ? [] : [{ key: "NEVER_ANSWERED", label: "Nunca respondidas", count: neverAnswered }]),
    ],
  };
}

async function getChannelBreakdown(query) {
  const filters = resolvePeriod(query);
  const dimensions = buildConversationWhere(query);
  const cohort = await loadCohort({ start: filters.start, end: filters.end, dimensions });
  const { metricsById, truncated } = await computeCohortMetrics(cohort);
  const byChannel = new Map();
  for (const conversation of cohort) {
    const entry = byChannel.get(conversation.channel) || { channel: conversation.channel, count: 0, resolved: 0, firstResponseSeconds: [] };
    entry.count += 1;
    if (conversation.status === "FINALIZADO") entry.resolved += 1;
    if (!truncated) {
      const seconds = metricsById.get(conversation.id)?.firstResponseSeconds;
      if (seconds !== null && seconds !== undefined) entry.firstResponseSeconds.push(seconds);
    }
    byChannel.set(conversation.channel, entry);
  }
  const items = [...byChannel.values()].map((entry) => ({
    channel: entry.channel, label: CHANNEL_LABELS[entry.channel] || entry.channel,
    count: entry.count, percent: cohort.length ? (entry.count / cohort.length) * 100 : 0,
    resolved: entry.resolved, firstResponseAvgSeconds: average(entry.firstResponseSeconds),
  })).sort((a, b) => b.count - a.count);
  return { total: cohort.length, truncated, items };
}

// Multiempresa (item 40/41): "Todas" soma tudo, mas também quebra por
// empresa — mesmas métricas da quebra por canal.
async function getCompanyBreakdown(query) {
  const filters = resolvePeriod(query);
  const dimensions = buildConversationWhere(query);
  const cohort = await loadCohort({ start: filters.start, end: filters.end, dimensions });
  const { metricsById, truncated } = await computeCohortMetrics(cohort);
  const companies = await prisma.company.findMany({ select: { id: true, name: true, slug: true, displayName: true, primaryColor: true } });
  const byCompany = new Map();
  for (const conversation of cohort) {
    const entry = byCompany.get(conversation.companyId) || { companyId: conversation.companyId, count: 0, open: 0, resolved: 0, firstResponseSeconds: [] };
    entry.count += 1;
    if (conversation.status === "FINALIZADO") entry.resolved += 1;
    else entry.open += 1;
    if (!truncated) {
      const seconds = metricsById.get(conversation.id)?.firstResponseSeconds;
      if (seconds !== null && seconds !== undefined) entry.firstResponseSeconds.push(seconds);
    }
    byCompany.set(conversation.companyId, entry);
  }
  const items = [...byCompany.values()].map((entry) => ({
    companyId: entry.companyId, company: companies.find((company) => company.id === entry.companyId) || null,
    count: entry.count, open: entry.open, resolved: entry.resolved,
    percent: cohort.length ? (entry.count / cohort.length) * 100 : 0,
    firstResponseAvgSeconds: average(entry.firstResponseSeconds),
  })).sort((a, b) => b.count - a.count);
  return { total: cohort.length, truncated, items };
}

async function getCategoryBreakdown(query) {
  const filters = resolvePeriod(query);
  const dimensions = buildConversationWhere(query);
  const cohort = await loadCohort({ start: filters.start, end: filters.end, dimensions });
  const { metricsById, truncated } = await computeCohortMetrics(cohort);
  const categoryIds = [...new Set(cohort.map((c) => c.categoryId).filter(Boolean))];
  const categories = categoryIds.length ? await prisma.category.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true, color: true } }) : [];
  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const byCategory = new Map();
  for (const conversation of cohort) {
    const key = conversation.categoryId || "UNCATEGORIZED";
    const entry = byCategory.get(key) || { categoryId: conversation.categoryId, count: 0, resolutionSeconds: [] };
    entry.count += 1;
    if (!truncated) {
      const seconds = metricsById.get(conversation.id)?.resolutionSeconds;
      if (seconds !== null && seconds !== undefined) entry.resolutionSeconds.push(seconds);
    }
    byCategory.set(key, entry);
  }
  const items = [...byCategory.values()].map((entry) => ({
    categoryId: entry.categoryId,
    label: entry.categoryId ? (categoryMap.get(entry.categoryId)?.name || "Categoria removida") : "Sem categoria",
    color: entry.categoryId ? categoryMap.get(entry.categoryId)?.color || null : null,
    count: entry.count, percent: cohort.length ? (entry.count / cohort.length) * 100 : 0,
    resolutionAvgSeconds: average(entry.resolutionSeconds),
  })).sort((a, b) => b.count - a.count);
  return { total: cohort.length, truncated, items };
}

// -----------------------------------------------------------------------
// 4. Vendedores (itens 9/11/12/20)
// -----------------------------------------------------------------------
async function getAgentRanking(query) {
  const filters = resolvePeriod(query);
  const dimensions = buildConversationWhere(query);
  const cohort = await loadCohort({ start: filters.start, end: filters.end, dimensions });
  const { metricsById, truncated } = await computeCohortMetrics(cohort);

  const [claimedGroups, users] = await Promise.all([
    prisma.conversationActivity.groupBy({
      by: ["actorUserId"], where: { action: "CONVERSATION_CLAIMED", actorUserId: { not: null }, createdAt: { gte: filters.start, lt: filters.end } },
      _count: { _all: true },
    }),
    prisma.user.findMany({ where: { role: { in: ["ADMIN", "SUPERVISOR", "ATENDENTE"] } }, select: { id: true, name: true, email: true, role: true, active: true } }),
  ]);
  const claimedByAgent = new Map(claimedGroups.map((g) => [g.actorUserId, g._count._all]));

  const byAgent = new Map();
  const ensure = (id) => {
    if (!byAgent.has(id)) byAgent.set(id, {
      userId: id, attended: 0, resolved: 0, finalized: 0, messagesSent: 0,
      firstResponseSeconds: [], responseSeconds: [], resolutionSeconds: [], neverAnswered: 0, slaBreached: 0,
    });
    return byAgent.get(id);
  };

  for (const conversation of cohort) {
    if (!conversation.assignedUserId) continue;
    const stats = ensure(conversation.assignedUserId);
    stats.attended += 1;
    if (conversation.status === "FINALIZADO") {
      stats.finalized += 1;
      if (!truncated && metricsById.get(conversation.id)?.answeredByAgent) stats.resolved += 1;
    }
    if (conversation.firstResponseSlaBreached || conversation.responseSlaBreached) stats.slaBreached += 1;
    if (!truncated) {
      const metrics = metricsById.get(conversation.id);
      if (metrics && !metrics.answered) stats.neverAnswered += 1;
      if (metrics?.resolutionSeconds !== null && metrics?.resolutionSeconds !== undefined) stats.resolutionSeconds.push(metrics.resolutionSeconds);
    }
  }
  if (!truncated) {
    for (const metrics of metricsById.values()) {
      if (metrics.firstResponseAgentId) ensure(metrics.firstResponseAgentId).firstResponseSeconds.push(metrics.firstResponseSeconds);
      for (const response of metrics.responses) {
        if (response.agentId) ensure(response.agentId).responseSeconds.push(response.seconds);
      }
    }
  }
  for (const [agentId, count] of claimedByAgent) ensure(agentId).claimed = count;

  const userMap = new Map(users.map((u) => [u.id, u]));
  const rows = [...byAgent.entries()].map(([userId, stats]) => ({
    userId, name: userMap.get(userId)?.name || "Usuário removido", email: userMap.get(userId)?.email || null,
    role: userMap.get(userId)?.role || null, active: userMap.get(userId)?.active ?? null,
    attended: stats.attended, claimed: stats.claimed || 0, resolved: stats.resolved, finalized: stats.finalized,
    messagesSent: stats.messagesSent, neverAnswered: stats.neverAnswered,
    firstResponseAvgSeconds: average(stats.firstResponseSeconds), responseAvgSeconds: average(stats.responseSeconds),
    resolutionAvgSeconds: average(stats.resolutionSeconds),
    resolutionRate: stats.attended ? (stats.resolved / stats.attended) * 100 : null,
    slaMetPercent: stats.attended ? ((stats.attended - stats.slaBreached) / stats.attended) * 100 : null,
  }));

  // Mensagens enviadas: contagem separada (groupBy simples, cara barata) —
  // nunca depende do cohort truncado, então continua saindo mesmo quando o
  // período é grande demais para as métricas de tempo.
  const messageGroups = await prisma.message.groupBy({
    by: ["sentByUserId"], where: { direction: "ENVIADA", sentByUserId: { not: null }, occurredAt: { gte: filters.start, lt: filters.end } },
    _count: { _all: true },
  });
  for (const group of messageGroups) {
    const row = rows.find((r) => r.userId === group.sentByUserId);
    if (row) row.messagesSent = group._count._all;
    else rows.push({
      userId: group.sentByUserId, name: userMap.get(group.sentByUserId)?.name || "Usuário removido",
      email: userMap.get(group.sentByUserId)?.email || null, role: userMap.get(group.sentByUserId)?.role || null,
      active: userMap.get(group.sentByUserId)?.active ?? null, attended: 0, claimed: claimedByAgent.get(group.sentByUserId) || 0,
      resolved: 0, finalized: 0, messagesSent: group._count._all, neverAnswered: 0,
      firstResponseAvgSeconds: null, responseAvgSeconds: null, resolutionAvgSeconds: null, resolutionRate: null, slaMetPercent: null,
    });
  }

  rows.sort((a, b) => b.attended - a.attended);
  return { truncated, agents: rows };
}

async function getAgentDetail(userId, query) {
  const filters = resolvePeriod(query);
  const dimensions = buildConversationWhere({ ...query, agentId: userId });
  const [user, ranking, recentConversations] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, role: true, active: true } }),
    getAgentRanking({ ...query, agentId: userId }),
    prisma.conversation.findMany({
      where: dimensions, orderBy: { lastMessageAt: "desc" }, take: 20,
      select: {
        id: true, status: true, channel: true, lastMessageAt: true, createdAt: true, finalizedAt: true,
        contact: { select: { name: true, customName: true, phone: true, email: true } },
        category: { select: { name: true } },
      },
    }),
  ]);
  if (!user) return null;
  const stats = ranking.agents.find((a) => a.userId === userId) || null;

  const categoryBreakdown = await getCategoryBreakdown({ ...query, agentId: userId });
  const channelBreakdown = await getChannelBreakdown({ ...query, agentId: userId });
  const timeseries = await getTimeseries({ ...query, agentId: userId, metric: "conversations_received" });

  return {
    user, stats: stats || {
      userId, attended: 0, claimed: 0, resolved: 0, finalized: 0, messagesSent: 0, neverAnswered: 0,
      firstResponseAvgSeconds: null, responseAvgSeconds: null, resolutionAvgSeconds: null, resolutionRate: null, slaMetPercent: null,
    },
    categoryBreakdown: categoryBreakdown.items, channelBreakdown: channelBreakdown.items, timeseries: timeseries.points,
    recentConversations: recentConversations.map((c) => ({
      id: c.id, status: c.status, channel: c.channel, categoryName: c.category?.name || null,
      contactName: c.contact?.customName || c.contact?.name || c.contact?.phone || c.contact?.email || "Sem nome",
      lastMessageAt: c.lastMessageAt, createdAt: c.createdAt, finalizedAt: c.finalizedAt,
    })),
    period: { start: filters.start, end: filters.end, label: filters.label },
  };
}

async function compareAgents(userIds, query) {
  const ranking = await getAgentRanking(query);
  return ranking.agents.filter((a) => userIds.includes(a.userId));
}

// -----------------------------------------------------------------------
// 5. Horários de pico / tempo de espera / alertas (itens 17/18/19)
// -----------------------------------------------------------------------
async function getHeatmap(query) {
  const filters = resolvePeriod(query);
  const dimensions = buildConversationWhere(query);
  const messages = await prisma.message.findMany({
    where: { direction: "RECEBIDA", occurredAt: { gte: filters.start, lt: filters.end }, conversation: dimensions },
    select: { occurredAt: true }, take: MAX_HEATMAP_MESSAGES,
  });
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const message of messages) {
    const day = (message.occurredAt.getDay() + 6) % 7; // 0 = segunda
    grid[day][message.occurredAt.getHours()] += 1;
  }
  return { grid, truncated: messages.length >= MAX_HEATMAP_MESSAGES, sampledMessages: messages.length };
}

const WAIT_BUCKETS = [
  { key: "under5", label: "< 5 min", max: 5 * 60 },
  { key: "5to15", label: "5–15 min", max: 15 * 60 },
  { key: "15to30", label: "15–30 min", max: 30 * 60 },
  { key: "30to60", label: "30–60 min", max: 60 * 60 },
  { key: "over60", label: "> 1h", max: Infinity },
];
async function getWaitTimeBuckets(query) {
  const filters = resolvePeriod(query);
  const dimensions = buildConversationWhere(query);
  const cohort = await loadCohort({ start: filters.start, end: filters.end, dimensions });
  const { metricsById, truncated } = await computeCohortMetrics(cohort);
  if (truncated) return { truncated, total: 0, items: WAIT_BUCKETS.map((b) => ({ ...b, count: 0, percent: 0 })) };
  const seconds = [...metricsById.values()].map((m) => m.firstResponseSeconds).filter((v) => v !== null);
  const counts = WAIT_BUCKETS.map(() => 0);
  for (const value of seconds) {
    const index = WAIT_BUCKETS.findIndex((bucket) => value <= bucket.max);
    counts[index === -1 ? WAIT_BUCKETS.length - 1 : index] += 1;
  }
  return {
    truncated, total: seconds.length,
    items: WAIT_BUCKETS.map((bucket, index) => ({ key: bucket.key, label: bucket.label, count: counts[index], percent: seconds.length ? (counts[index] / seconds.length) * 100 : 0 })),
  };
}

async function getAlerts(query) {
  const dimensions = buildConversationWhere(query);
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
  const [neverAnswered, slaBreached, awaitingTeamLong, openOverADay] = await Promise.all([
    prisma.conversation.count({
      where: { ...dimensions, AND: [{ messages: { some: { direction: "RECEBIDA" } } }, { messages: { none: { direction: "ENVIADA" } } }] },
    }),
    prisma.conversation.count({ where: { ...dimensions, status: { not: "FINALIZADO" }, OR: [{ firstResponseSlaBreached: true }, { responseSlaBreached: true }] } }),
    prisma.conversation.count({ where: { ...dimensions, status: "AGUARDANDO_EQUIPE", lastMessageAt: { lte: thirtyMinAgo } } }),
    prisma.conversation.count({ where: { ...dimensions, status: { not: "FINALIZADO" }, createdAt: { lte: dayAgo } } }),
  ]);
  return [
    { key: "never_answered", label: "Nunca respondidas", count: neverAnswered, filter: { neverAnswered: true } },
    { key: "sla_breached", label: "SLA vencido", count: slaBreached, filter: { slaBreached: true } },
    { key: "awaiting_team_long", label: "Aguardando equipe há mais de 30 min", count: awaitingTeamLong, filter: { status: "AGUARDANDO_EQUIPE" } },
    { key: "open_over_a_day", label: "Abertas há mais de 24h", count: openOverADay, filter: { openOverADay: true } },
  ];
}

// -----------------------------------------------------------------------
// 6. Tabela de conversas / detalhe (itens 13/14/16)
// -----------------------------------------------------------------------
const SORTABLE_FIELDS = { lastMessageAt: "lastMessageAt", createdAt: "createdAt", status: "status", priority: "priority" };
async function listConversations(query) {
  const filters = resolvePeriod(query);
  const dimensions = buildConversationWhere(query);
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = [25, 50, 100].includes(Number(query.pageSize)) ? Number(query.pageSize) : 25;
  const sortField = SORTABLE_FIELDS[query.sortBy] || "lastMessageAt";
  const sortDir = query.sortDir === "asc" ? "asc" : "desc";

  const where = {
    ...dimensions,
    OR: [{ createdAt: { gte: filters.start, lt: filters.end } }, { lastMessageAt: { gte: filters.start, lt: filters.end } }],
    ...(query.search ? {
      contact: { OR: [{ name: { contains: query.search, mode: "insensitive" } }, { customName: { contains: query.search, mode: "insensitive" } }, { phone: { contains: query.search } }, { email: { contains: query.search, mode: "insensitive" } }] },
    } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.conversation.count({ where }),
    prisma.conversation.findMany({
      where, orderBy: { [sortField]: sortDir }, skip: (page - 1) * pageSize, take: pageSize,
      select: {
        id: true, status: true, priority: true, channel: true, createdAt: true, lastMessageAt: true, finalizedAt: true,
        contact: { select: { name: true, customName: true, phone: true, email: true } },
        category: { select: { name: true } },
        assignedUser: { select: { name: true } },
      },
    }),
  ]);

  const lastMessages = rows.length ? await prisma.message.findMany({
    where: { conversationId: { in: rows.map((r) => r.id) } }, orderBy: { occurredAt: "desc" }, distinct: ["conversationId"],
    select: { conversationId: true, text: true, type: true, direction: true, occurredAt: true },
  }) : [];
  const lastMessageMap = new Map(lastMessages.map((m) => [m.conversationId, m]));

  return {
    total, page, pageSize,
    items: rows.map((row) => ({
      id: row.id, status: row.status, priority: row.priority, channel: row.channel,
      channelLabel: CHANNEL_LABELS[row.channel] || row.channel, categoryName: row.category?.name || null,
      assignedUserName: row.assignedUser?.name || null,
      contactName: row.contact?.customName || row.contact?.name || row.contact?.phone || row.contact?.email || "Sem nome",
      contactPhone: row.contact?.phone || null,
      createdAt: row.createdAt, lastMessageAt: row.lastMessageAt, finalizedAt: row.finalizedAt,
      lastMessagePreview: lastMessageMap.get(row.id)?.text?.slice(0, 160) || (lastMessageMap.get(row.id) ? `[${lastMessageMap.get(row.id).type}]` : null),
    })),
  };
}

async function getConversationDetail(conversationId) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true, status: true, priority: true, channel: true, createdAt: true, lastMessageAt: true, finalizedAt: true,
      contact: { select: { name: true, customName: true, phone: true, email: true } },
      category: { select: { name: true } },
      assignedUser: { select: { name: true } },
    },
  });
  if (!conversation) return null;
  const [messages, activities] = await Promise.all([
    prisma.message.findMany({ where: { conversationId }, orderBy: { occurredAt: "asc" }, select: { direction: true, sentByUserId: true, occurredAt: true, type: true } }),
    prisma.conversationActivity.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" }, include: { actorUser: { select: { name: true } } } }),
  ]);
  const metrics = computeConversationMetrics(messages, conversation);
  const counts = { customer: 0, bot: 0, human: 0 };
  for (const message of messages) {
    const kind = classify(message);
    if (kind === "CUSTOMER") counts.customer += 1; else if (kind === "BOT") counts.bot += 1; else counts.human += 1;
  }

  const timeline = [
    { type: "CONVERSATION_STARTED", at: conversation.createdAt, label: "Cliente iniciou a conversa" },
    ...activities.map((activity) => ({ type: activity.action, at: activity.createdAt, label: activity.summary || activity.action, actor: activity.actorUser?.name || null })),
  ];
  if (metrics.firstResponseSeconds !== null) {
    const firstHuman = messages.find((m) => classify(m) === "HUMAN");
    if (firstHuman) timeline.push({ type: "FIRST_HUMAN_RESPONSE", at: firstHuman.occurredAt, label: "Primeira resposta humana" });
  }
  if (conversation.finalizedAt) timeline.push({ type: "FINALIZED", at: conversation.finalizedAt, label: "Conversa finalizada" });
  timeline.sort((a, b) => a.at.getTime() - b.at.getTime());

  return {
    conversation: {
      id: conversation.id, status: conversation.status, priority: conversation.priority, channel: conversation.channel,
      channelLabel: CHANNEL_LABELS[conversation.channel] || conversation.channel,
      categoryName: conversation.category?.name || null, assignedUserName: conversation.assignedUser?.name || null,
      contactName: conversation.contact?.customName || conversation.contact?.name || conversation.contact?.phone || conversation.contact?.email || "Sem nome",
      contactPhone: conversation.contact?.phone || null, contactEmail: conversation.contact?.email || null,
      createdAt: conversation.createdAt, lastMessageAt: conversation.lastMessageAt, finalizedAt: conversation.finalizedAt,
    },
    metrics: {
      firstResponseSeconds: metrics.firstResponseSeconds, resolutionSeconds: metrics.resolutionSeconds,
      answered: metrics.answered, answeredByAgent: metrics.answeredByAgent, messageCounts: counts,
    },
    timeline,
  };
}

module.exports = {
  getSummary, getTimeseries, getStatusBreakdown, getChannelBreakdown, getCategoryBreakdown, getCompanyBreakdown,
  getAgentRanking, getAgentDetail, compareAgents, getHeatmap, getWaitTimeBuckets, getAlerts,
  listConversations, getConversationDetail,
  // Reaproveitados pelo Painel Operacional (operations-panel-service.js).
  computeConversationMetrics, loadMessagesByConversation,
  MAX_MESSAGE_COHORT,
};
