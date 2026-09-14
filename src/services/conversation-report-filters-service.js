// Filtros compartilhados do Relatório de Conversas — único lugar que
// interpreta query params (período/vendedor/canal/categoria/status/
// prioridade) e monta o WHERE do Prisma. Todo endpoint do relatório usa
// isto, nunca reimplementa o parsing — garante que "o mesmo filtro sempre
// significa a mesma coisa" em todo o dashboard (item 2 do pedido: "os
// filtros devem afetar TODO o dashboard").
const { CONVERSATION_STATUSES, CONVERSATION_PRIORITIES, CHANNELS } = require("./conversation-report-constants");

const PERIOD_PRESETS = new Set(["today", "yesterday", "7d", "30d", "this_month", "last_month", "all", "custom"]);

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}
function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Retorna { start, end, previousStart, previousEnd, label } — `end` é
// EXCLUSIVO (< end), nunca inclusivo, para nunca depender de milissegundos
// exatos de "fim do dia". O período anterior tem sempre a MESMA duração do
// período atual, imediatamente antes dele (item 3: "variação vs período
// anterior" nunca compara janelas de tamanhos diferentes).
function resolvePeriod({ period = "7d", startDate, endDate } = {}) {
  const now = new Date();
  const preset = PERIOD_PRESETS.has(period) ? period : "7d";
  let start;
  let end;

  if (preset === "today") { start = startOfDay(now); end = addDays(start, 1); }
  else if (preset === "yesterday") { start = addDays(startOfDay(now), -1); end = startOfDay(now); }
  else if (preset === "7d") { end = addDays(startOfDay(now), 1); start = addDays(end, -7); }
  else if (preset === "30d") { end = addDays(startOfDay(now), 1); start = addDays(end, -30); }
  else if (preset === "this_month") { start = new Date(now.getFullYear(), now.getMonth(), 1); end = addDays(startOfDay(now), 1); }
  else if (preset === "last_month") {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 1);
  } else if (preset === "all") { start = new Date(2000, 0, 1); end = addDays(startOfDay(now), 1); }
  else {
    // custom
    const parsedStart = startDate ? startOfDay(new Date(startDate)) : addDays(startOfDay(now), -7);
    const parsedEnd = endDate ? addDays(startOfDay(new Date(endDate)), 1) : addDays(startOfDay(now), 1);
    start = Number.isNaN(parsedStart.getTime()) ? addDays(startOfDay(now), -7) : parsedStart;
    end = Number.isNaN(parsedEnd.getTime()) || parsedEnd <= start ? addDays(start, 1) : parsedEnd;
  }

  const durationMs = end.getTime() - start.getTime();
  const previousEnd = start;
  const previousStart = new Date(start.getTime() - durationMs);

  const fmt = (date) => date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const label = preset === "all" ? "Todo o histórico" : `${fmt(start)} a ${fmt(endOfDay(new Date(end.getTime() - 1)))}`;

  return { start, end, previousStart, previousEnd, preset, label };
}

// `agentId="unassigned"` filtra conversas sem responsável — vocabulário
// controlado próprio (nunca confundido com um id real de usuário).
function buildConversationWhere({ agentId, channel, categoryId, status, priority } = {}) {
  const where = {};
  if (agentId === "unassigned") where.assignedUserId = null;
  else if (agentId) where.assignedUserId = agentId;
  if (channel && CHANNELS.includes(channel)) where.channel = channel;
  if (categoryId) where.categoryId = categoryId;
  if (status && CONVERSATION_STATUSES.includes(status)) where.status = status;
  if (priority && CONVERSATION_PRIORITIES.includes(priority)) where.priority = priority;
  return where;
}

function resolveFilters(query = {}) {
  const period = resolvePeriod(query);
  const dimensions = buildConversationWhere(query);
  return { ...period, dimensions, raw: query };
}

module.exports = { resolvePeriod, buildConversationWhere, resolveFilters, PERIOD_PRESETS };
