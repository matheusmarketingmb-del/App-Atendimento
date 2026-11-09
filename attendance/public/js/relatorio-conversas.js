const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const STATUS_LABELS = {
  NOVO: "Novo", EM_ATENDIMENTO: "Em atendimento", AGUARDANDO_EQUIPE: "Aguardando equipe",
  AGUARDANDO_CLIENTE: "Aguardando cliente", HANDOFF_BOT: "Encaminhado (Bot)", BOT: "Com o Bot", FINALIZADO: "Finalizado",
};
const STATUS_COLORS = { NOVO: "--rp-s1", EM_ATENDIMENTO: "--rp-s2", AGUARDANDO_EQUIPE: "--rp-s4", AGUARDANDO_CLIENTE: "--rp-s7", HANDOFF_BOT: "--rp-s5", BOT: "--rp-s3", FINALIZADO: "--rp-good", NEVER_ANSWERED: "--rp-bad" };
const CHANNEL_LABELS = {
  META: "WhatsApp", INSTAGRAM_DIRECT: "Instagram (Direct)", INSTAGRAM_COMMENTS: "Instagram (Comentários)",
  FACEBOOK_MESSENGER: "Facebook (Messenger)", FACEBOOK_COMMENTS: "Facebook (Comentários)", EMAIL: "E-mail",
  MERCADO_LIVRE: "Mercado Livre", TIKTOK_SHOP: "TikTok Shop", AMAZON_MARKETPLACE: "Amazon",
  SHOPEE: "Shopee", SHEIN_MARKETPLACE: "Shein", GOOGLE_REVIEWS: "Google Reviews", RECLAME_AQUI: "Reclame Aqui", ZENVIA: "Zenvia (legado)",
};
const WEEKDAY_LABELS = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];

// Semântica de cada KPI para a seta/cor de variação — nunca interpretar
// tempo menor como algo ruim, nem volume maior como bom ou ruim sozinho.
const KPI_SEMANTICS = {
  resolved: "higher-better", resolutionRate: "higher-better", responseRate: "higher-better", slaMetPercent: "higher-better",
  neverAnswered: "higher-worse", resolvedWithoutAgentResponse: "higher-worse",
  firstResponseAvgSeconds: "lower-better", responseAvgSeconds: "lower-better", resolutionAvgSeconds: "lower-better",
  conversationsReceived: "neutral", newConversations: "neutral", awaitingTeam: "neutral", awaitingCustomer: "neutral",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function toast(message, error = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = `rp-toast show${error ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 3200);
}
async function api(url) {
  const response = await fetch(url);
  if (response.status === 401) { location.replace("/login.html"); throw new Error("Sessão encerrada."); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || "Não foi possível carregar os dados.");
  return body;
}
function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
function formatPercent(value, digits = 1) { return value === null || value === undefined ? "—" : `${value.toFixed(digits)}%`; }
function formatDateTime(value) { return value ? new Date(value).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"; }
function formatDate(value) { return value ? new Date(value).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "—"; }
function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// ---------------------------------------------------------------------
// Estado + sincronização com a URL (item 2: "permitir compartilhar uma
// visão filtrada")
// ---------------------------------------------------------------------
const state = {
  period: "7d", startDate: "", endDate: "", company: "", agentId: "", channel: "", categoryId: "", status: "", priority: "",
  metric: "conversations_received", granularity: "", compare: false,
  conversationsPage: 1, conversationsPageSize: 25, conversationsSort: "lastMessageAt", conversationsDir: "desc", conversationsSearch: "",
  statusClickFilter: null, selectedAgents: new Set(), prodGranularity: "",
};
const PREFERENCE_KEY = "productivity-filters";
const URL_KEYS = ["period", "company", "agentId", "channel", "categoryId", "status", "priority", "startDate", "endDate", "metric", "granularity", "prodGranularity"];

// Sem filtros na URL, volta para o último período/empresa usados neste
// navegador (conveniência local; o backend revalida tudo).
function readStateFromUrl() {
  let params = new URLSearchParams(location.search);
  if (![...params.keys()].length) {
    try { params = new URLSearchParams(localStorage.getItem(PREFERENCE_KEY) || ""); } catch { /* ignore */ }
  }
  for (const key of URL_KEYS) {
    if (params.has(key)) state[key] = params.get(key);
  }
  if (params.has("compare")) state.compare = params.get("compare") === "true";
}
function writeStateToUrl() {
  const params = new URLSearchParams();
  for (const key of URL_KEYS) {
    if (state[key]) params.set(key, state[key]);
  }
  if (state.compare) params.set("compare", "true");
  history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
  try {
    const saved = new URLSearchParams();
    for (const key of ["period", "company", "startDate", "endDate", "prodGranularity"]) if (state[key]) saved.set(key, state[key]);
    localStorage.setItem(PREFERENCE_KEY, saved.toString());
  } catch { /* ignore */ }
}
function queryFromState(extra = {}) {
  const params = new URLSearchParams();
  if (state.period) params.set("period", state.period);
  if (state.period === "custom") { if (state.startDate) params.set("startDate", state.startDate); if (state.endDate) params.set("endDate", state.endDate); }
  if (state.company) params.set("company", state.company);
  if (state.agentId) params.set("agentId", state.agentId);
  if (state.channel) params.set("channel", state.channel);
  if (state.categoryId) params.set("categoryId", state.categoryId);
  if (state.status) params.set("status", state.status);
  if (state.priority) params.set("priority", state.priority);
  for (const [key, value] of Object.entries(extra)) if (value !== undefined && value !== null && value !== "") params.set(key, value);
  return params.toString();
}

// ---------------------------------------------------------------------
// Filtros: chips + clear + selects
// ---------------------------------------------------------------------
const FILTER_LABELS = {
  company: (value, ctx) => `Empresa: ${(ctx.companies || []).find((c) => c.slug === value)?.name || value}`,
  agentId: (value, ctx) => `Atendente: ${ctx.agents.find((a) => a.id === value)?.name || (value === "unassigned" ? "sem responsável" : "selecionado")}`,
  channel: (value) => `Canal: ${CHANNEL_LABELS[value] || value}`,
  categoryId: (value, ctx) => `Equipe: ${ctx.categories.find((c) => c.id === value)?.name || (value === "UNCATEGORIZED" ? "Sem categoria" : value)}`,
  status: (value) => `Status: ${STATUS_LABELS[value] || value}`,
  priority: (value) => `Prioridade: ${value}`,
};
let filterContext = { agents: [], categories: [] };
function renderChips() {
  const chips = [];
  for (const key of Object.keys(FILTER_LABELS)) {
    if (state[key]) chips.push({ key, label: FILTER_LABELS[key](state[key], filterContext) });
  }
  $("#filter-chips").innerHTML = chips.map((chip) => `<span class="rp-chip">${escapeHtml(chip.label)}<button data-clear="${chip.key}" type="button">&times;</button></span>`).join("");
  $$("#filter-chips button").forEach((btn) => btn.addEventListener("click", () => { state[btn.dataset.clear] = ""; $(`#f-${btn.dataset.clear === "categoryId" ? "category" : btn.dataset.clear === "agentId" ? "agent" : btn.dataset.clear}`).value = ""; onFiltersChanged(); }));
}

async function populateFilterOptions() {
  const [categories, companyData] = await Promise.all([
    api(`/api/categories${state.company ? `?company=${encodeURIComponent(state.company)}` : ""}`).catch(() => []),
    api("/api/companies").catch(() => ({ companies: [] })),
  ]);
  filterContext.categories = categories;
  // Multiempresa (item 40): filtro de empresa — "todas" soma, com quebra abaixo.
  filterContext.companies = companyData.companies || [];
  $("#f-company").innerHTML = '<option value="">Empresa: todas as autorizadas</option>' + filterContext.companies.map((c) => `<option value="${escapeHtml(c.slug)}">${escapeHtml(c.name)}</option>`).join("");
  $("#f-company").hidden = filterContext.companies.length < 2;
  $("#f-company").value = state.company;
  $("#f-channel").innerHTML = '<option value="">Canal: todos</option>' + Object.entries(CHANNEL_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  // Equipe = setor principal; subcategorias aparecem recuadas logo abaixo.
  const roots = categories.filter((c) => !c.parentId);
  const companyName = (id) => (filterContext.companies.length > 1 ? (filterContext.companies.find((c) => c.id === id)?.displayName || "") : "");
  $("#f-category").innerHTML = '<option value="">Equipe: todas</option><option value="UNCATEGORIZED">Sem categoria</option>' + roots.map((root) => {
    const children = categories.filter((c) => c.parentId === root.id);
    const prefix = companyName(root.companyId);
    return `<option value="${root.id}">${escapeHtml(prefix ? `${root.name} · ${prefix}` : root.name)}</option>`
      + children.map((child) => `<option value="${child.id}">&nbsp;&nbsp;↳ ${escapeHtml(child.name)}</option>`).join("");
  }).join("");
  $("#f-status").innerHTML = '<option value="">Status: todos</option>' + Object.entries(STATUS_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  $("#f-priority").innerHTML = '<option value="">Prioridade: todas</option>' + ["NORMAL", "ALTA", "URGENTE"].map((p) => `<option value="${p}">${p}</option>`).join("");
  $("#f-agent").hidden = !reportAccess.canCompare;
  if (reportAccess.canCompare) syncAgentOptions([]);

  $("#f-period").value = state.period;
  $("#f-channel").value = state.channel;
  $("#f-category").value = state.categoryId;
  $("#f-status").value = state.status;
  $("#f-priority").value = state.priority;
  $("#f-start").hidden = state.period !== "custom"; $("#f-end").hidden = state.period !== "custom";
  if (state.startDate) $("#f-start").value = state.startDate;
  if (state.endDate) $("#f-end").value = state.endDate;
}

$("#f-period").addEventListener("change", (e) => { state.period = e.target.value; $("#f-start").hidden = state.period !== "custom"; $("#f-end").hidden = state.period !== "custom"; if (state.period !== "custom") onFiltersChanged(); });
$("#f-start").addEventListener("change", (e) => { state.startDate = e.target.value; if (state.period === "custom") onFiltersChanged(); });
$("#f-end").addEventListener("change", (e) => { state.endDate = e.target.value; if (state.period === "custom") onFiltersChanged(); });
$("#f-agent").addEventListener("change", (e) => { state.agentId = e.target.value; onFiltersChanged(); });
$("#f-channel").addEventListener("change", (e) => { state.channel = e.target.value; onFiltersChanged(); });
$("#f-company").addEventListener("change", async (e) => { state.company = e.target.value; state.categoryId = ""; knownAgents.clear(); await populateFilterOptions(); onFiltersChanged(); });
$("#f-category").addEventListener("change", (e) => { state.categoryId = e.target.value; onFiltersChanged(); });
$("#f-status").addEventListener("change", (e) => { state.status = e.target.value; onFiltersChanged(); });
$("#f-priority").addEventListener("change", (e) => { state.priority = e.target.value; onFiltersChanged(); });
$("#f-clear").addEventListener("click", () => {
  Object.assign(state, { period: "7d", startDate: "", endDate: "", company: "", agentId: "", channel: "", categoryId: "", status: "", priority: "" });
  populateFilterOptions();
  onFiltersChanged();
});
$("#theme-toggle").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try { localStorage.setItem("mibro-theme", dark ? "dark" : "light"); } catch { /* ignore */ }
});
$("#refresh").addEventListener("click", () => loadAll());
// Mobile: filtros recolhíveis (no desktop ficam sempre visíveis).
$("#filters-toggle").addEventListener("click", () => {
  const open = !$("#filters-bar").classList.contains("open");
  $("#filters-bar").classList.toggle("open", open);
  $("#filters-toggle").setAttribute("aria-expanded", String(open));
});

function onFiltersChanged() {
  $("#f-category").value = state.categoryId;
  writeStateToUrl(); renderChips(); state.conversationsPage = 1; loadAll();
}

// ---------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------
const MAIN_KPI_DEFS = [
  ["conversationsReceived", "Conversas recebidas"], ["newConversations", "Novas conversas"], ["resolved", "Conversas resolvidas"],
  ["awaitingTeam", "Aguardando equipe"], ["awaitingCustomer", "Aguardando cliente"], ["neverAnswered", "Nunca respondidas"],
];
const QUALITY_KPI_DEFS = [
  ["firstResponseAvgSeconds", "1ª resposta média", "duration"], ["responseAvgSeconds", "Tempo médio de resposta", "duration"],
  ["resolutionAvgSeconds", "Tempo médio de resolução", "duration"], ["resolutionRate", "Taxa de resolução", "percent"],
  // "SLA cumprido" por conversa saiu daqui: os flags de SLA zeram quando a
  // empresa responde (dava ~100% sempre). O indicador correto, por resposta,
  // fica nos cards de Produtividade acima.
  ["responseRate", "Taxa de resposta", "percent"],
  ["resolvedWithoutAgentResponse", "Finalizadas sem vendedor", "count"],
];

function kpiDeltaHtml(key, value) {
  if (value === null || value === undefined) return "";
  const semantics = KPI_SEMANTICS[key] || "neutral";
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  const arrow = rounded > 0 ? "↑" : rounded < 0 ? "↓" : "→";
  let cls = "flat";
  let suffix = "vs período anterior";
  if (semantics === "higher-better") cls = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  else if (semantics === "higher-worse") cls = rounded > 0 ? "down" : rounded < 0 ? "up" : "flat";
  else if (semantics === "lower-better") { cls = rounded < 0 ? "up" : rounded > 0 ? "down" : "flat"; suffix = rounded !== 0 ? (rounded < 0 ? "melhor" : "pior") + " vs período anterior" : suffix; }
  else cls = "neutral-note";
  return `<span class="rp-kpi-delta ${cls}">${arrow} ${Math.abs(rounded).toFixed(1)}% ${suffix}</span>`;
}
function renderKpis(containerId, defs, data, compact) {
  const container = $(`#${containerId}`);
  if (!data) { container.innerHTML = defs.map(() => '<div class="rp-kpi rp-skel" style="height:70px"></div>').join(""); return; }
  container.innerHTML = defs.map(([key, label, format]) => {
    const raw = data.current[key];
    const value = format === "duration" ? formatDuration(raw) : format === "percent" ? formatPercent(raw) : (raw ?? "—");
    return `<div class="rp-kpi${compact ? " compact" : ""}"><label>${escapeHtml(label)}</label><div class="rp-kpi-value">${value}</div>${kpiDeltaHtml(key, data.changes?.[key])}</div>`;
  }).join("");
}

// ---------------------------------------------------------------------
// Gráfico principal (linha/área, SVG puro)
// ---------------------------------------------------------------------
const GRANULARITIES = ["hour", "day", "week", "month"];
function renderGranularityOptions(active) {
  $("#chart-granularity").innerHTML = GRANULARITIES.map((g) => `<button data-value="${g}" class="${g === active ? "active" : ""}">${{ hour: "Hora", day: "Dia", week: "Semana", month: "Mês" }[g]}</button>`).join("");
}
function renderMainChart(data) {
  const svg = $("#main-chart");
  const points = data.points;
  renderGranularityOptions(data.granularity);
  if (!points.length) { svg.innerHTML = ""; return; }
  const width = 960; const height = 220; const padTop = 16; const padBottom = 28; const padLeft = 8; const padRight = 8;
  const maxValue = Math.max(1, ...points.map((p) => Math.max(p.value, p.previousValue || 0)));
  const stepX = (width - padLeft - padRight) / Math.max(1, points.length - 1);
  const yFor = (value) => height - padBottom - (value / maxValue) * (height - padTop - padBottom);
  const xFor = (index) => padLeft + index * stepX;

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(p.value).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${xFor(points.length - 1).toFixed(1)},${height - padBottom} L${xFor(0)},${height - padBottom} Z`;
  const accent = cssVar("--rp-accent") || "#8a8e97";
  let previousLine = "";
  if (points[0].previousValue !== undefined && points[0].previousValue !== null) {
    previousLine = `<path d="${points.map((p, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(p.previousValue || 0).toFixed(1)}`).join(" ")}" fill="none" stroke="${cssVar("--rp-muted") || "#8b93a1"}" stroke-width="2" stroke-dasharray="4 4" stroke-linecap="round"/>`;
  }
  const everyNth = Math.max(1, Math.ceil(points.length / 8));
  const labels = points.map((p, i) => (i % everyNth === 0 || i === points.length - 1) ? `<text x="${xFor(i).toFixed(1)}" y="${height - 8}" font-size="9" fill="${cssVar("--rp-muted") || "#8b93a1"}" text-anchor="middle">${escapeHtml(p.label)}</text>` : "").join("");

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `
    <defs><linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.28"/><stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${areaPath}" fill="url(#areaFill)"/>
    ${previousLine}
    <path d="${linePath}" fill="none" stroke="${accent}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${labels}
    <rect id="chart-hit" x="0" y="0" width="${width}" height="${height}" fill="transparent"/>
  `;

  const tooltip = $("#chart-tooltip");
  const hit = $("#chart-hit", svg);
  hit.addEventListener("mousemove", (event) => {
    const rect = svg.getBoundingClientRect();
    const relX = ((event.clientX - rect.left) / rect.width) * width;
    const index = Math.max(0, Math.min(points.length - 1, Math.round((relX - padLeft) / stepX)));
    const point = points[index];
    tooltip.innerHTML = `<strong>${escapeHtml(point.label)}</strong>${point.value}${point.previousValue !== undefined && point.previousValue !== null ? ` <span style="color:var(--rp-muted)">(ant.: ${point.previousValue})</span>` : ""}`;
    tooltip.style.left = `${((xFor(index) / width) * 100).toFixed(2)}%`;
    tooltip.style.top = "0px";
    tooltip.classList.add("show");
  });
  hit.addEventListener("mouseleave", () => tooltip.classList.remove("show"));

  const metricLabels = { conversations_received: "Conversas recebidas", resolved: "Resolvidas", messages_received: "Mensagens recebidas", messages_sent: "Mensagens enviadas" };
  $("#chart-legend").innerHTML = `<span><i style="background:${accent}"></i>${metricLabels[data.metric] || data.metric}</span>${previousLine ? `<span><i style="background:${cssVar("--rp-muted")}"></i>Período anterior</span>` : ""}`;
}

$("#chart-metric").addEventListener("click", (e) => {
  const btn = e.target.closest("button"); if (!btn) return;
  state.metric = btn.dataset.value;
  $$("#chart-metric button").forEach((b) => b.classList.toggle("active", b === btn));
  loadTimeseries();
});
$("#chart-granularity").addEventListener("click", (e) => {
  const btn = e.target.closest("button"); if (!btn) return;
  state.granularity = btn.dataset.value;
  loadTimeseries();
});
$("#chart-compare").addEventListener("change", (e) => { state.compare = e.target.checked; loadTimeseries(); });

async function loadTimeseries() {
  try {
    const data = await api(`/api/reports/conversations/timeseries?${queryFromState({ metric: state.metric, granularity: state.granularity, compare: state.compare })}`);
    state.granularity = data.granularity;
    renderMainChart(data);
  } catch (error) { toast(error.message, true); }
}

// ---------------------------------------------------------------------
// Situação (donut)
// ---------------------------------------------------------------------
function renderStatusDonut(data) {
  const items = data.items.filter((i) => i.key !== "NEVER_ANSWERED");
  const total = items.reduce((sum, i) => sum + i.count, 0) || 1;
  const radius = 70; const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const segments = items.map((item) => {
    const fraction = item.count / total;
    const dash = fraction * circumference;
    const segment = `<circle cx="90" cy="90" r="${radius}" fill="none" stroke="var(${STATUS_COLORS[item.key] || "--rp-s1"})" stroke-width="22" stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 90 90)"><title>${escapeHtml(item.label)}: ${item.count}</title></circle>`;
    offset += dash;
    return segment;
  }).join("");
  $("#status-donut").innerHTML = `${segments}<text x="90" y="86" text-anchor="middle" font-size="22" font-weight="800" fill="var(--rp-ink)">${data.total}</text><text x="90" y="104" text-anchor="middle" font-size="9" fill="var(--rp-muted)">conversas</text>`;

  $("#status-list").innerHTML = data.items.map((item) => `
    <div class="rp-donut-row" data-status="${item.key}">
      <i style="background:var(${STATUS_COLORS[item.key] || "--rp-s1"})"></i>
      <span class="rp-donut-name">${escapeHtml(item.label)}</span>
      <span class="rp-donut-count">${item.count}</span>
    </div>`).join("");
  $$("#status-list .rp-donut-row").forEach((row) => row.addEventListener("click", () => {
    const key = row.dataset.status;
    if (key === "NEVER_ANSWERED") { toast("Use o card \"Precisam de atenção\" para ver as nunca respondidas."); return; }
    state.status = state.status === key ? "" : key;
    $("#f-status").value = state.status;
    onFiltersChanged();
  }));
}

// ---------------------------------------------------------------------
// Rankings (canal / categoria)
// ---------------------------------------------------------------------
function renderRank(containerId, items, { valueKey = "count", metaFn, onClick, emptyLabel }) {
  const container = $(`#${containerId}`);
  if (!items.length) { container.innerHTML = `<p class="rp-empty">${emptyLabel}</p>`; return; }
  const max = Math.max(...items.map((i) => i[valueKey])) || 1;
  container.innerHTML = items.map((item, index) => `
    <div class="rp-rank-row" data-index="${index}">
      <span class="rp-rank-name">${escapeHtml(item.label)}</span>
      <span class="rp-rank-track"><span class="rp-rank-fill" style="width:${Math.max(4, Math.round((item[valueKey] / max) * 100))}%"></span></span>
      <span class="rp-rank-meta">${metaFn(item)}</span>
    </div>`).join("");
  if (onClick) $$(`#${containerId} .rp-rank-row`).forEach((row) => row.addEventListener("click", () => onClick(items[Number(row.dataset.index)])));
}

// ---------------------------------------------------------------------
// Produtividade (por ciclo de atendimento) — /api/reports/productivity
// ---------------------------------------------------------------------
let reportAccess = { mode: "MASTER", canCompare: true, agentId: null };
let productivityData = null;
let agentRows = [];
let agentSort = { field: "name", dir: "asc" };
const knownAgents = new Map();

const PROD_SEMANTICS = {
  finalized: "neutral", claimed: "neutral", cyclesStarted: "neutral", transfersOut: "neutral",
  reopened: "higher-worse", reopenRate: "higher-worse", slaBreached: "higher-worse",
  firstResponseAvgSeconds: "lower-better", responseAvgSeconds: "lower-better", handlingAvgSeconds: "neutral", slaMetPercent: "higher-better",
};
function samplesNote(n) { return n ? `n = ${n}` : "sem amostras"; }
function prodKpi(label, value, { key, data, note, title } = {}) {
  const delta = key && data?.changes ? deltaHtml(PROD_SEMANTICS[key] || "neutral", data.changes[key]) : "";
  return `<div class="rp-kpi"${title ? ` title="${escapeHtml(title)}"` : ""}><label>${escapeHtml(label)}</label><div class="rp-kpi-value">${value}</div>${note ? `<span class="rp-kpi-note">${note}</span>` : ""}${delta}</div>`;
}
function deltaHtml(semantics, value) {
  if (value === null || value === undefined) return "";
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  const arrow = rounded > 0 ? "↑" : rounded < 0 ? "↓" : "→";
  let cls = "neutral-note";
  if (semantics === "higher-better") cls = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  else if (semantics === "higher-worse") cls = rounded > 0 ? "down" : rounded < 0 ? "up" : "flat";
  else if (semantics === "lower-better") cls = rounded < 0 ? "up" : rounded > 0 ? "down" : "flat";
  return `<span class="rp-kpi-delta ${cls}">${arrow} ${Math.abs(rounded).toFixed(1)}% vs período anterior</span>`;
}

function renderProductivityKpis(data) {
  if (!data) {
    $("#kpi-productivity").innerHTML = Array.from({ length: 6 }, () => '<div class="rp-kpi rp-skel" style="height:86px"></div>').join("");
    $("#kpi-times").innerHTML = Array.from({ length: 5 }, () => '<div class="rp-kpi rp-skel" style="height:70px"></div>').join("");
    return;
  }
  const c = data.summary.current;
  $("#kpi-productivity").innerHTML = [
    prodKpi("Atendimentos finalizados", c.finalized, { key: "finalized", data: data.summary, note: c.finalizedWithoutHuman ? `${c.finalizedByHuman} com atendente · ${c.finalizedWithoutHuman} sem humano` : "", title: "Ciclos finalizados no período (manual, inatividade ou Bot)." }),
    prodKpi("Assumidos", c.claimed, { key: "claimed", data: data.summary, title: "Conversas assumidas da fila (manual ou ao responder primeiro)." }),
    prodKpi("Ativos agora", c.activeNow, { note: `${c.waitingTeamNow} aguardando a equipe`, title: "Situação atual, não depende do período." }),
    prodKpi("Atendimentos iniciados", c.cyclesStarted, { key: "cyclesStarted", data: data.summary, note: c.startedByAgent ? `${c.startedByAgent} iniciados pela equipe` : "", title: "Novos ciclos: primeiro contato ou cliente voltando após finalizar." }),
    prodKpi("Transferências", c.transfersOut, { key: "transfersOut", data: data.summary, title: "Transferências entre pessoas no período." }),
    prodKpi("Reabertos em 24h", c.reopened, { key: "reopened", data: data.summary, note: c.reopenRate === null ? "" : `${formatPercent(c.reopenRate)} dos finalizados com atendente`, title: "Cliente voltou em até 24h depois da finalização." }),
  ].join("");
  $("#kpi-times").innerHTML = [
    prodKpi("1ª resposta humana", formatDuration(c.firstResponseAvgSeconds), { key: "firstResponseAvgSeconds", data: data.summary, note: samplesNote(c.firstResponseSamples) }),
    prodKpi("Tempo médio de resposta", formatDuration(c.responseAvgSeconds), { key: "responseAvgSeconds", data: data.summary, note: samplesNote(c.responseSamples) }),
    prodKpi("Tempo médio de atendimento", formatDuration(c.handlingAvgSeconds), { key: "handlingAvgSeconds", data: data.summary, note: samplesNote(c.handlingSamples), title: "Do início do ciclo à finalização, contando somente o expediente configurado." }),
    prodKpi("SLA cumprido", formatPercent(c.slaMetPercent), { key: "slaMetPercent", data: data.summary, note: c.slaMeasured ? `${c.slaMeasured} respostas medidas` : "SLA não configurado ou sem respostas" }),
    prodKpi("Fora do SLA", c.slaMeasured ? c.slaBreached : "—", { key: "slaBreached", data: data.summary, note: c.slaNear ? `${c.slaNear} perto do limite` : "" }),
  ].join("");
}

// Barras (uma série, cor neutra de destaque) — Atendimentos finalizados.
function renderFinalizedChart(series) {
  const svg = $("#finalized-chart");
  const tooltip = $("#finalized-tooltip");
  const points = series.points;
  const total = points.reduce((sum, p) => sum + p.finalized, 0);
  if (!points.length || !total) { svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" fill="var(--rp-muted)" font-size="12">Sem atendimentos finalizados no período.</text>`; svg.setAttribute("viewBox", "0 0 960 220"); return; }
  // Largura real do gráfico (texto legível no celular, sem distorcer).
  const width = Math.max(320, Math.round(svg.clientWidth || 960)); const height = 220; const padTop = 18; const padBottom = 28; const padX = 8;
  const max = Math.max(1, ...points.map((p) => p.finalized));
  const slot = (width - padX * 2) / points.length;
  const barWidth = Math.max(2, Math.min(36, slot - 2));
  const yFor = (value) => height - padBottom - (value / max) * (height - padTop - padBottom);
  const everyNth = Math.max(1, Math.ceil(points.length / Math.max(3, Math.floor(width / 90))));
  const peak = points.reduce((best, p, i) => (p.finalized > points[best].finalized ? i : best), 0);
  const bars = points.map((p, i) => {
    const x = padX + i * slot + (slot - barWidth) / 2;
    const y = yFor(p.finalized);
    const h = height - padBottom - y;
    const r = Math.min(4, barWidth / 2, h);
    const path = h <= 0 ? "" : `M${x},${height - padBottom} V${y + r} Q${x},${y} ${x + r},${y} H${x + barWidth - r} Q${x + barWidth},${y} ${x + barWidth},${y + r} V${height - padBottom} Z`;
    const label = (i % everyNth === 0 || i === points.length - 1) ? `<text x="${(x + barWidth / 2).toFixed(1)}" y="${height - 8}" font-size="9" fill="var(--rp-muted)" text-anchor="middle">${escapeHtml(p.label)}</text>` : "";
    const peakLabel = i === peak && p.finalized ? `<text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" font-size="10" font-weight="700" fill="var(--rp-ink)" text-anchor="middle">${p.finalized}</text>` : "";
    return `<path d="${path}" fill="var(--rp-accent)" opacity=".85"/>${label}${peakLabel}<rect class="rp-hit" data-i="${i}" x="${(padX + i * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${height}" fill="transparent"/>`;
  }).join("");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `<line x1="${padX}" x2="${width - padX}" y1="${height - padBottom}" y2="${height - padBottom}" stroke="var(--rp-line)"/>${bars}`;
  $$(".rp-hit", svg).forEach((hit) => {
    hit.addEventListener("mouseenter", () => {
      const p = points[Number(hit.dataset.i)];
      tooltip.innerHTML = `<strong>${escapeHtml(p.label)}</strong>${p.finalized} finalizado${p.finalized === 1 ? "" : "s"}`;
      tooltip.style.left = `${(((Number(hit.getAttribute("x")) + slot / 2) / width) * 100).toFixed(2)}%`;
      tooltip.style.top = "0px";
      tooltip.classList.add("show");
    });
    hit.addEventListener("mouseleave", () => tooltip.classList.remove("show"));
  });
}

// Linha da 1ª resposta média; pontos sem amostra ficam fora (sem inventar zero).
function renderFirstResponseChart(series) {
  const svg = $("#first-response-chart");
  const tooltip = $("#first-response-tooltip");
  const points = series.points;
  const measured = points.filter((p) => p.firstResponseAvgSeconds !== null);
  const width = Math.max(300, Math.round(svg.clientWidth || 480)); const height = 180;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  if (!measured.length) { svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="var(--rp-muted)" font-size="12">Sem primeiras respostas humanas no período.</text>'; return; }
  const padTop = 16; const padBottom = 24; const padX = 10;
  const max = Math.max(1, ...measured.map((p) => p.firstResponseAvgSeconds));
  const stepX = (width - padX * 2) / Math.max(1, points.length - 1);
  const xFor = (i) => padX + i * stepX;
  const yFor = (v) => height - padBottom - (v / max) * (height - padTop - padBottom);
  let path = ""; let pen = false;
  points.forEach((p, i) => {
    if (p.firstResponseAvgSeconds === null) { pen = false; return; }
    path += `${pen ? "L" : "M"}${xFor(i).toFixed(1)},${yFor(p.firstResponseAvgSeconds).toFixed(1)} `;
    pen = true;
  });
  const dots = points.map((p, i) => (p.firstResponseAvgSeconds === null ? "" : `<circle cx="${xFor(i).toFixed(1)}" cy="${yFor(p.firstResponseAvgSeconds).toFixed(1)}" r="4" fill="var(--rp-accent)" stroke="var(--rp-surface)" stroke-width="2"/>`)).join("");
  const everyNth = Math.max(1, Math.ceil(points.length / Math.max(3, Math.floor(width / 80))));
  const labels = points.map((p, i) => ((i % everyNth === 0 || i === points.length - 1) ? `<text x="${xFor(i).toFixed(1)}" y="${height - 6}" font-size="9" fill="var(--rp-muted)" text-anchor="middle">${escapeHtml(p.label)}</text>` : "")).join("");
  svg.innerHTML = `<line x1="${padX}" x2="${width - padX}" y1="${height - padBottom}" y2="${height - padBottom}" stroke="var(--rp-line)"/>
    <text x="${padX}" y="${padTop - 4}" font-size="9" fill="var(--rp-muted)">máx. ${formatDuration(max)}</text>
    <path d="${path}" fill="none" stroke="var(--rp-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>${dots}${labels}
    <line id="fr-cross" x1="0" x2="0" y1="${padTop}" y2="${height - padBottom}" stroke="var(--rp-muted)" stroke-dasharray="3 3" opacity="0"/>
    <rect id="fr-hit" x="0" y="0" width="${width}" height="${height}" fill="transparent"/>`;
  const cross = $("#fr-cross", svg);
  $("#fr-hit", svg).addEventListener("mousemove", (event) => {
    const rect = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((((event.clientX - rect.left) / rect.width) * width) - padX) / stepX)));
    const p = points[i];
    cross.setAttribute("x1", xFor(i)); cross.setAttribute("x2", xFor(i)); cross.setAttribute("opacity", "1");
    tooltip.innerHTML = `<strong>${escapeHtml(p.label)}</strong>${p.firstResponseAvgSeconds === null ? "Sem dados" : `${formatDuration(p.firstResponseAvgSeconds)} · n = ${p.firstResponseSamples}`}`;
    tooltip.style.left = `${((xFor(i) / width) * 100).toFixed(2)}%`;
    tooltip.style.top = "0px";
    tooltip.classList.add("show");
  });
  $("#fr-hit", svg).addEventListener("mouseleave", () => { tooltip.classList.remove("show"); cross.setAttribute("opacity", "0"); });
}

// Barra empilhada única + legenda com ícone, rótulo e contagem (nunca só cor).
function renderSlaChart(sla) {
  const container = $("#sla-chart");
  if (!sla?.measured) {
    container.innerHTML = '<p class="rp-empty">Sem respostas medidas. Ative os prazos de SLA em Configurações → Conversas para acompanhar este indicador.</p>';
    return;
  }
  const parts = [
    { key: "within", label: "Dentro do prazo", icon: "✓", value: sla.within, cls: "ok" },
    { key: "near", label: "Próximo do limite", icon: "!", value: sla.near, cls: "near" },
    { key: "breached", label: "Fora do prazo", icon: "×", value: sla.breached, cls: "bad" },
  ];
  container.innerHTML = `
    <div class="rp-stack" role="img" aria-label="${parts.map((p) => `${p.label}: ${p.value}`).join(", ")}">
      ${parts.filter((p) => p.value).map((p) => `<span class="rp-stack-seg ${p.cls}" style="flex:${p.value}" title="${p.label}: ${p.value} (${formatPercent((p.value / sla.measured) * 100)})"></span>`).join("")}
    </div>
    <div class="rp-stack-legend">
      ${parts.map((p) => `<div class="rp-stack-item"><i class="rp-sla-dot ${p.cls}" aria-hidden="true">${p.icon}</i><span>${p.label}</span><b>${p.value}</b><small>${formatPercent((p.value / sla.measured) * 100)}</small></div>`).join("")}
    </div>
    <p class="rp-footnote">${sla.measured} respostas humanas medidas no período.</p>`;
}

function renderProductivityCompanies(companies) {
  const card = $("#prod-companies-card");
  card.hidden = companies.length < 2 && reportAccess.mode !== "MASTER";
  $("#prod-companies").innerHTML = companies.map((row) => {
    const color = /^#[0-9a-f]{6}$/i.test(row.company.primaryColor || "") ? row.company.primaryColor : "var(--rp-line)";
    return `<div class="rp-company-card" style="--company:${color}">
      <h4>${escapeHtml(row.company.name)}</h4>
      <dl>
        <div><dt>Finalizados</dt><dd>${row.finalized}</dd></div>
        <div><dt>1ª resposta</dt><dd>${formatDuration(row.firstResponseAvgSeconds)}<small>${samplesNote(row.firstResponseSamples)}</small></dd></div>
        <div><dt>SLA cumprido</dt><dd>${formatPercent(row.slaMetPercent)}<small>${row.slaMeasured ? `${row.slaMeasured} medidas` : "não medido"}</small></dd></div>
        <div><dt>Reabertos 24h</dt><dd>${row.reopened}</dd></div>
      </dl>
    </div>`;
  }).join("") || '<p class="rp-empty">Sem atendimentos no período.</p>';
}

function durationCell(seconds, samples) {
  return seconds === null || seconds === undefined ? "—" : `${formatDuration(seconds)} <small class="rp-n">n=${samples}</small>`;
}
function renderAgentsTable() {
  const sorted = [...agentRows].sort((a, b) => {
    const av = a[agentSort.field]; const bv = b[agentSort.field];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === "string") return agentSort.dir === "asc" ? av.localeCompare(bv, "pt-BR") : bv.localeCompare(av, "pt-BR");
    return agentSort.dir === "asc" ? av - bv : bv - av;
  });
  $("#agents-tbody").innerHTML = sorted.map((agent) => `
    <tr data-user="${agent.userId}" tabindex="0">
      <td data-label="Comparar">${reportAccess.canCompare ? `<input type="checkbox" class="agent-select" data-user="${agent.userId}" aria-label="Comparar ${escapeHtml(agent.name)}" ${state.selectedAgents.has(agent.userId) ? "checked" : ""}>` : ""}</td>
      <td data-label="Atendente"><strong>${escapeHtml(agent.name)}</strong><br><small class="rp-n">${escapeHtml(agent.role)}${agent.teams.length ? ` · ${escapeHtml(agent.teams.join(", "))}` : ""}</small></td>
      <td data-label="Finalizados">${agent.finalized}</td>
      <td data-label="Assumidos">${agent.claimed}</td>
      <td data-label="Ativos agora">${agent.activeNow}${agent.waitingNow ? ` <small class="rp-n">${agent.waitingNow} aguardando</small>` : ""}</td>
      <td data-label="Transferiu">${agent.transfersOut}</td>
      <td data-label="Recebeu">${agent.transfersIn}</td>
      <td data-label="Reabertos">${agent.reopened}</td>
      <td data-label="1ª resposta">${durationCell(agent.firstResponseAvgSeconds, agent.firstResponseSamples)}</td>
      <td data-label="Resposta">${durationCell(agent.responseAvgSeconds, agent.responseSamples)}</td>
      <td data-label="Atendimento">${durationCell(agent.handlingAvgSeconds, agent.handlingSamples)}</td>
      <td data-label="SLA">${agent.slaMeasured ? `${formatPercent(agent.slaMetPercent)} <small class="rp-n">n=${agent.slaMeasured}</small>` : "—"}</td>
    </tr>`).join("") || '<tr><td colspan="12" class="rp-empty">Nenhum atendente com atividade no período.</td></tr>';

  $$(".agent-select").forEach((box) => box.addEventListener("click", (event) => {
    event.stopPropagation();
    const id = box.dataset.user;
    if (box.checked) { if (state.selectedAgents.size >= 6) { box.checked = false; toast("Selecione no máximo 6 atendentes para comparar.", true); return; } state.selectedAgents.add(id); }
    else state.selectedAgents.delete(id);
    $("#agents-compare-btn").disabled = state.selectedAgents.size < 2;
  }));
  $$("#agents-tbody tr[data-user]").forEach((row) => {
    const open = (event) => { if (!event.target.classList.contains("agent-select")) openAgentDrawer(row.dataset.user); };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => { if (event.key === "Enter") open(event); });
  });
  $$("#agents-table thead th[data-sort]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === agentSort.field);
    th.classList.toggle("asc", th.dataset.sort === agentSort.field && agentSort.dir === "asc");
  });
}
$("#agents-table thead").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-sort]"); if (!th) return;
  agentSort = { field: th.dataset.sort, dir: agentSort.field === th.dataset.sort && agentSort.dir === "desc" ? "asc" : "desc" };
  renderAgentsTable();
});
$("#agents-export").addEventListener("click", () => { location.href = `/api/reports/productivity/export?${queryFromState()}`; });
$("#agents-compare-btn").addEventListener("click", () => {
  const rows = agentRows.filter((row) => state.selectedAgents.has(row.userId));
  const columns = [
    ["finalized", "Finalizados"], ["claimed", "Assumidos"], ["transfersOut", "Transferiu"], ["reopened", "Reabertos 24h"],
    ["firstResponseAvgSeconds", "1ª resposta", "duration", "firstResponseSamples"], ["responseAvgSeconds", "Resposta", "duration", "responseSamples"],
    ["handlingAvgSeconds", "Atendimento", "duration", "handlingSamples"], ["slaMetPercent", "SLA cumprido", "percent", "slaMeasured"],
  ];
  const wrap = $("#agents-compare-result");
  wrap.hidden = false;
  wrap.innerHTML = `<table class="rp-table rp-compare"><thead><tr><th>Indicador</th>${rows.map((r) => `<th>${escapeHtml(r.name)}</th>`).join("")}</tr></thead><tbody>
    ${columns.map(([key, label, format, samples]) => `<tr><td>${label}</td>${rows.map((r) => `<td data-label="${escapeHtml(r.name)}">${format === "duration" ? durationCell(r[key], r[samples]) : format === "percent" ? (r[samples] ? `${formatPercent(r[key])} <small class="rp-n">n=${r[samples]}</small>` : "—") : (r[key] ?? "—")}</td>`).join("")}</tr>`).join("")}
  </tbody></table>`;
  wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

function renderGranularity(active) {
  $("#prod-granularity").innerHTML = ["day", "week", "month"].map((g) => `<button data-value="${g}" class="${g === active ? "active" : ""}" aria-pressed="${g === active}">${{ day: "Dia", week: "Semana", month: "Mês" }[g]}</button>`).join("");
}
$("#prod-granularity").addEventListener("click", (e) => {
  const btn = e.target.closest("button"); if (!btn) return;
  state.prodGranularity = btn.dataset.value;
  loadProductivity();
});

function syncAgentOptions(agents) {
  for (const agent of agents) knownAgents.set(agent.userId, agent.name);
  filterContext.agents = [...knownAgents].map(([id, name]) => ({ id, name }));
  const select = $("#f-agent");
  select.innerHTML = '<option value="">Atendente: todos</option>' + [...knownAgents].sort((a, b) => a[1].localeCompare(b[1], "pt-BR"))
    .map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join("");
  select.value = state.agentId;
}

async function loadProductivity() {
  renderProductivityKpis(null);
  try {
    const data = await api(`/api/reports/productivity?${queryFromState({ granularity: state.prodGranularity })}`);
    productivityData = data;
    $("#productivity-notice").hidden = !data.truncated;
    if (data.truncated) {
      $("#productivity-notice").textContent = "Período grande demais para calcular os atendimentos com precisão. Escolha um período menor ou filtre por empresa/equipe.";
      $("#kpi-productivity").innerHTML = ""; $("#kpi-times").innerHTML = "";
      return;
    }
    renderProductivityKpis(data);
    renderGranularity(data.timeseries.granularity === "hour" ? "" : data.timeseries.granularity);
    $("#finalized-sub").textContent = `Ciclos de atendimento finalizados · ${data.period.label}`;
    renderFinalizedChart(data.timeseries);
    renderFirstResponseChart(data.timeseries);
    renderSlaChart(data.sla);
    const multiCompany = data.companies.length > 1;
    const companyLabel = (id) => data.companies.find((row) => row.company.id === id)?.company.displayName || "";
    renderRank("prod-categories", data.categories.map((item) => ({ ...item, count: item.finalized, label: multiCompany ? `${item.label} · ${companyLabel(item.companyId)}` : item.label })), {
      metaFn: (i) => `${i.finalized} (${(i.percent || 0).toFixed(0)}%)`, emptyLabel: "Sem atendimentos finalizados no período.",
    });
    renderProductivityCompanies(data.companies);
    agentRows = data.agents;
    if (reportAccess.canCompare && !state.agentId) syncAgentOptions(data.agents);
    renderAgentsTable();
  } catch (error) { toast(error.message, true); }
}

// ---------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------
function renderHeatmap(data) {
  const max = Math.max(1, ...data.grid.flat());
  let html = `<div class="rp-heatmap"><div></div>${Array.from({ length: 24 }, (_, h) => `<div class="rp-heat-hour">${h}</div>`).join("")}`;
  data.grid.forEach((row, dayIndex) => {
    html += `<div class="rp-heat-day">${WEEKDAY_LABELS[dayIndex].slice(0, 3)}</div>`;
    row.forEach((value) => {
      const intensity = value / max;
      html += `<div class="rp-heat-cell" title="${value} mensagens" style="background:color-mix(in srgb, var(--rp-accent) ${Math.round(intensity * 85)}%, var(--rp-surface-2))"></div>`;
    });
  });
  html += "</div>";
  $("#heatmap").innerHTML = html;
}

// ---------------------------------------------------------------------
// Alertas
// ---------------------------------------------------------------------
function renderAlerts(alerts) {
  $("#alerts").innerHTML = alerts.map((alert) => `
    <div class="rp-alert${alert.count === 0 ? " zero" : ""}" data-key="${alert.key}">
      <div class="rp-alert-count">${alert.count}</div><div class="rp-alert-label">${escapeHtml(alert.label)}</div>
    </div>`).join("");
  $$("#alerts .rp-alert").forEach((el) => el.addEventListener("click", () => {
    const alert = alerts.find((a) => a.key === el.dataset.key);
    if (!alert || alert.count === 0) return;
    if (alert.filter.status) { state.status = alert.filter.status; $("#f-status").value = state.status; onFiltersChanged(); }
    else { $("#conversations-search").focus(); document.getElementById("conversations-table").scrollIntoView({ behavior: "smooth", block: "start" }); toast(`Filtre manualmente por "${alert.label}" na tabela abaixo — filtro direto chega numa próxima versão.`); }
  }));
}

// ---------------------------------------------------------------------
// Tabela de conversas
// ---------------------------------------------------------------------
let conversationsSort = { field: "lastMessageAt", dir: "desc" };
function situationBadge(item) {
  if (item.status === "FINALIZADO") return '<span class="rp-badge ok">Resolvida</span>';
  return '<span class="rp-badge muted">—</span>';
}
async function loadConversations() {
  try {
    const data = await api(`/api/reports/conversations?${queryFromState({ page: state.conversationsPage, pageSize: state.conversationsPageSize, sortBy: conversationsSort.field, sortDir: conversationsSort.dir, search: state.conversationsSearch })}`);
    $("#conversations-count").textContent = `${data.total} conversa${data.total === 1 ? "" : "s"} no período`;
    $("#conversations-tbody").innerHTML = data.items.map((item) => `
      <tr data-id="${item.id}">
        <td data-label="Contato">${escapeHtml(item.contactName)}${item.contactPhone ? `<br><small style="color:var(--rp-muted)">${escapeHtml(item.contactPhone)}</small>` : ""}</td>
        <td data-label="Canal">${escapeHtml(item.channelLabel)}</td>
        <td data-label="Categoria">${escapeHtml(item.categoryName || "—")}</td>
        <td data-label="Última mensagem" class="rp-preview">${escapeHtml(item.lastMessagePreview || "—")}</td>
        <td data-label="Início">${formatDate(item.createdAt)}</td>
        <td data-label="Última atividade">${formatDateTime(item.lastMessageAt)}</td>
        <td data-label="Status">${escapeHtml(STATUS_LABELS[item.status] || item.status)}</td>
        <td data-label="Atendente">${escapeHtml(item.assignedUserName || "—")}</td>
        <td data-label="Situação">${situationBadge(item)}</td>
      </tr>`).join("") || '<tr><td colspan="9" class="rp-empty">Nenhuma conversa encontrada.</td></tr>';
    $$("#conversations-tbody tr[data-id]").forEach((row) => row.addEventListener("click", () => openConversationDrawer(row.dataset.id)));

    const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
    $("#conversations-pagination").innerHTML = `
      <button id="cp-prev" ${data.page <= 1 ? "disabled" : ""}>&larr; Anterior</button>
      <span>Página ${data.page} de ${totalPages}</span>
      <button id="cp-next" ${data.page >= totalPages ? "disabled" : ""}>Próxima &rarr;</button>`;
    $("#cp-prev")?.addEventListener("click", () => { state.conversationsPage -= 1; loadConversations(); });
    $("#cp-next")?.addEventListener("click", () => { state.conversationsPage += 1; loadConversations(); });
  } catch (error) { $("#conversations-tbody").innerHTML = `<tr><td colspan="9" class="rp-error">${escapeHtml(error.message)}</td></tr>`; }
}
$("#conversations-search").addEventListener("input", debounce((e) => { state.conversationsSearch = e.target.value; state.conversationsPage = 1; loadConversations(); }, 350));
$("#conversations-page-size").addEventListener("change", (e) => { state.conversationsPageSize = Number(e.target.value); state.conversationsPage = 1; loadConversations(); });
$("#conversations-export").addEventListener("click", () => { location.href = `/api/reports/conversations/export?${queryFromState()}`; });
$("#conversations-table thead").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-sort]"); if (!th) return;
  conversationsSort = { field: th.dataset.sort, dir: conversationsSort.field === th.dataset.sort && conversationsSort.dir === "desc" ? "asc" : "desc" };
  $$("#conversations-table thead th").forEach((h) => { h.classList.toggle("sorted", h === th); h.classList.toggle("asc", h === th && conversationsSort.dir === "asc"); });
  loadConversations();
});

// ---------------------------------------------------------------------
// Drawers
// ---------------------------------------------------------------------
function openDrawer(id) { $("#drawer-backdrop").classList.add("show"); $(`#${id}`).classList.add("show"); }
function closeDrawers() { $("#drawer-backdrop").classList.remove("show"); $$(".rp-drawer").forEach((d) => d.classList.remove("show")); }
$("#drawer-backdrop").addEventListener("click", closeDrawers);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawers(); });

async function openConversationDrawer(conversationId) {
  const drawer = $("#conversation-drawer");
  drawer.innerHTML = '<div class="rp-skel" style="height:200px"></div>';
  openDrawer("conversation-drawer");
  try {
    const data = await api(`/api/reports/conversations/${conversationId}`);
    const c = data.conversation; const m = data.metrics;
    drawer.innerHTML = `
      <div class="rp-drawer-head"><div><h2>${escapeHtml(c.contactName)}</h2><p>${escapeHtml(c.channelLabel)} &bull; ${escapeHtml(c.categoryName || "Sem categoria")}</p></div><button class="rp-drawer-close" id="drawer-close-1">&times;</button></div>
      <div class="rp-drawer-section"><h4>Resumo</h4>
        <div class="rp-drawer-kpis">
          <div class="rp-kpi compact"><label>Status</label><div class="rp-kpi-value" style="font-size:13px">${escapeHtml(STATUS_LABELS[c.status] || c.status)}</div></div>
          <div class="rp-kpi compact"><label>Prioridade</label><div class="rp-kpi-value" style="font-size:13px">${escapeHtml(c.priority)}</div></div>
          <div class="rp-kpi compact"><label>Atendente</label><div class="rp-kpi-value" style="font-size:13px">${escapeHtml(c.assignedUserName || "—")}</div></div>
          <div class="rp-kpi compact"><label>1ª resposta</label><div class="rp-kpi-value" style="font-size:13px">${formatDuration(m.firstResponseSeconds)}</div></div>
          <div class="rp-kpi compact"><label>Tempo de expediente</label><div class="rp-kpi-value" style="font-size:13px">${formatDuration(m.resolutionSeconds)}</div></div>
          <div class="rp-kpi compact"><label>Mensagens</label><div class="rp-kpi-value" style="font-size:13px">${m.messageCounts.customer} cliente / ${m.messageCounts.human} humano / ${m.messageCounts.bot} bot</div></div>
        </div>
      </div>
      <div class="rp-drawer-section"><h4>Linha do tempo</h4><div class="rp-timeline">
        ${data.timeline.map((event) => `<div class="rp-timeline-item"><time>${formatDateTime(event.at)}</time>${escapeHtml(event.label)}${event.actor ? ` — ${escapeHtml(event.actor)}` : ""}</div>`).join("")}
      </div></div>
      <a class="rp-btn primary" href="/?conversation=${c.id}" target="_blank" rel="noopener">Ver conversa completa</a>
    `;
    $("#drawer-close-1").addEventListener("click", closeDrawers);
  } catch (error) { drawer.innerHTML = `<p class="rp-error">${escapeHtml(error.message)}</p>`; }
}

async function openAgentDrawer(userId) {
  const drawer = $("#agent-drawer");
  drawer.innerHTML = '<div class="rp-skel" style="height:200px"></div>';
  openDrawer("agent-drawer");
  try {
    const data = await api(`/api/reports/productivity/agents/${userId}?${queryFromState({ agentId: "", granularity: state.prodGranularity })}`);
    const s = data.summary?.current;
    const prev = data.summary?.previous;
    const evolution = (key, semantics, format) => {
      if (!prev || prev[key] === null || prev[key] === undefined) return "";
      const label = format === "duration" ? formatDuration(prev[key]) : format === "percent" ? formatPercent(prev[key]) : prev[key];
      return `<small class="rp-n">antes: ${label}</small>${deltaHtml(semantics, data.summary.changes?.[key])}`;
    };
    const kpi = (label, value, extra = "") => `<div class="rp-kpi compact"><label>${label}</label><div class="rp-kpi-value" style="font-size:16px">${value}</div>${extra}</div>`;
    drawer.innerHTML = `
      <div class="rp-drawer-head"><div><h2>${escapeHtml(data.user.name)}</h2>
        <p>${escapeHtml(data.user.role)}${data.user.companies.length ? ` &bull; ${data.user.companies.map((c) => escapeHtml(c.name)).join(", ")}` : ""}${data.user.teams.length ? ` &bull; ${escapeHtml(data.user.teams.join(", "))}` : ""}${data.user.active ? "" : " &bull; conta inativa"}</p></div>
        <button class="rp-drawer-close" id="drawer-close-2" aria-label="Fechar">&times;</button></div>
      ${data.truncated || !s ? '<p class="rp-empty">Período grande demais para calcular. Escolha um período menor.</p>' : `
      <div class="rp-drawer-section"><h4>${escapeHtml(data.period.label)}</h4>
        <div class="rp-drawer-kpis">
          ${kpi("Finalizados", s.finalized, evolution("finalized", "neutral"))}
          ${kpi("Assumidos", s.claimed)}
          ${kpi("Ativos agora", s.activeNow, `<small class="rp-n">${s.waitingTeamNow} aguardando a equipe</small>`)}
          ${kpi("Transferiu / recebeu", `${s.transfersOut} / ${data.agents[0]?.transfersIn ?? 0}`)}
          ${kpi("Reabertos em 24h", s.reopened, evolution("reopened", "higher-worse"))}
          ${kpi("1ª resposta média", formatDuration(s.firstResponseAvgSeconds), `<small class="rp-n">${samplesNote(s.firstResponseSamples)}</small>${evolution("firstResponseAvgSeconds", "lower-better", "duration")}`)}
          ${kpi("Resposta média", formatDuration(s.responseAvgSeconds), `<small class="rp-n">${samplesNote(s.responseSamples)}</small>`)}
          ${kpi("Tempo de atendimento", formatDuration(s.handlingAvgSeconds), `<small class="rp-n">${samplesNote(s.handlingSamples)}</small>`)}
          ${kpi("SLA cumprido", formatPercent(s.slaMetPercent), `<small class="rp-n">${s.slaMeasured ? `${s.slaMeasured} medidas · ${s.slaBreached} fora` : "não medido"}</small>${evolution("slaMetPercent", "higher-better", "percent")}`)}
        </div>
      </div>
      <div class="rp-drawer-section"><h4>Finalizados por período</h4><div class="rp-mini-bars" id="agent-drawer-bars"></div></div>
      <div class="rp-drawer-section"><h4>Finalizados por equipe</h4><div class="rp-rank" id="agent-drawer-categories"></div></div>`}
    `;
    $("#drawer-close-2").addEventListener("click", closeDrawers);
    if (!s) return;
    const points = data.timeseries.points;
    const max = Math.max(1, ...points.map((p) => p.finalized));
    $("#agent-drawer-bars").innerHTML = points.some((p) => p.finalized)
      ? points.map((p) => `<span title="${escapeHtml(p.label)}: ${p.finalized}" style="height:${Math.max(2, Math.round((p.finalized / max) * 100))}%"></span>`).join("")
      : '<p class="rp-empty">Nenhum atendimento finalizado no período.</p>';
    renderRank("agent-drawer-categories", data.categories.map((item) => ({ ...item, count: item.finalized })), { metaFn: (i) => `${i.finalized} (${(i.percent || 0).toFixed(0)}%)`, emptyLabel: "Sem dados." });
  } catch (error) { drawer.innerHTML = `<p class="rp-error">${escapeHtml(error.message)}</p>`; }
}

// ---------------------------------------------------------------------
// Boot / orquestração
// ---------------------------------------------------------------------
async function loadAll() {
  writeStateToUrl();
  renderChips();
  renderKpis("kpi-main", MAIN_KPI_DEFS, null, false);
  renderKpis("kpi-quality", QUALITY_KPI_DEFS, null, true);
  loadProductivity();
  try {
    const [summary, status, channels, categories, heatmap, waitBuckets, alerts, companies] = await Promise.all([
      api(`/api/reports/conversations/summary?${queryFromState()}`),
      api(`/api/reports/conversations/status-breakdown?${queryFromState()}`),
      api(`/api/reports/conversations/channel-breakdown?${queryFromState()}`),
      api(`/api/reports/conversations/category-breakdown?${queryFromState()}`),
      api(`/api/reports/conversations/heatmap?${queryFromState()}`),
      api(`/api/reports/conversations/wait-time-buckets?${queryFromState()}`),
      api(`/api/reports/conversations/alerts?${queryFromState()}`),
      api(`/api/reports/conversations/company-breakdown?${queryFromState()}`),
    ]);
    renderRank("company-rank", companies.items.map((item) => ({ ...item, label: item.company?.name || "Sem empresa" })), {
      metaFn: (i) => `${i.count} &bull; ${i.open} abertas &bull; ${i.resolved} resolvidas &bull; ${formatDuration(i.firstResponseAvgSeconds)}`,
      onClick: (item) => { state.company = state.company === item.company?.slug ? "" : (item.company?.slug || ""); $("#f-company").value = state.company; onFiltersChanged(); },
      emptyLabel: "Sem conversas no período.",
    });
    // Barra de cada empresa na cor dela (só a barra; o painel segue neutro).
    $$("#company-rank .rp-rank-row").forEach((row, index) => {
      const color = companies.items[index]?.company?.primaryColor;
      if (/^#[0-9a-f]{6}$/i.test(color || "")) row.querySelector(".rp-rank-fill").style.background = color;
    });
    renderKpis("kpi-main", MAIN_KPI_DEFS, summary, false);
    renderKpis("kpi-quality", QUALITY_KPI_DEFS, summary, true);
    if (summary.current.truncated) toast("Período muito grande — tempos de resposta não puderam ser calculados. Refine o filtro de período.", true);
    renderStatusDonut(status);
    renderRank("channel-rank", channels.items, { metaFn: (i) => `${i.count} &bull; ${formatDuration(i.firstResponseAvgSeconds)}`, onClick: (item) => { state.channel = state.channel === item.channel ? "" : item.channel; $("#f-channel").value = state.channel; onFiltersChanged(); }, emptyLabel: "Sem conversas no período." });
    renderRank("category-rank", categories.items, { metaFn: (i) => `${i.percent.toFixed(0)}% &bull; ${formatDuration(i.resolutionAvgSeconds)}`, onClick: (item) => { state.categoryId = state.categoryId === item.categoryId ? "" : (item.categoryId || ""); $("#f-category").value = state.categoryId; onFiltersChanged(); }, emptyLabel: "Sem conversas no período." });
    renderHeatmap(heatmap);
    renderRank("wait-buckets", waitBuckets.items, { metaFn: (i) => `${i.count} (${i.percent.toFixed(0)}%)`, emptyLabel: "Sem dados suficientes." });
    renderAlerts(alerts);
  } catch (error) { toast(error.message, true); }
  loadTimeseries();
  loadConversations();
}

// Atendente (SELF): só "Meus números" — sem comparação nem quebra por
// empresa de terceiros. O backend já aplica o mesmo escopo.
function applyAccessMode() {
  const self = reportAccess.mode === "SELF";
  document.body.dataset.reportMode = reportAccess.mode;
  $("#team-title").textContent = self ? "Meus números" : "Comparação da equipe";
  $("#page-subtitle").textContent = self
    ? "Seus atendimentos por ciclo: do contato do cliente até a finalização."
    : reportAccess.mode === "SUPERVISOR" ? "Equipes que você supervisiona, por ciclo de atendimento." : "Atendimentos por ciclo: do contato do cliente até a finalização.";
  $("#agents-compare-btn").hidden = self;
  $("#agents-export").hidden = self;
  $("#company-rank-card").hidden = self;
}

(async function boot() {
  try {
    const authStatus = await api("/api/auth/status");
    if (!authStatus.authenticated) { location.replace("/login.html"); return; }
    readStateFromUrl();
    // Default to the active workspace; explicit report comparisons stay available.
    if (!state.company) state.company = authStatus.companyAccess?.preference || "";
    reportAccess = await api(`/api/reports/access${state.company ? `?company=${encodeURIComponent(state.company)}` : ""}`)
      .catch(async () => { state.company = ""; return api("/api/reports/access"); });
    applyAccessMode();
    await populateFilterOptions();
    renderChips();
    loadAll();
  } catch (error) { toast(error.message, true); }
})();
