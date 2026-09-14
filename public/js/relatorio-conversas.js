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
  period: "7d", startDate: "", endDate: "", agentId: "", channel: "", categoryId: "", status: "", priority: "",
  metric: "conversations_received", granularity: "", compare: false,
  conversationsPage: 1, conversationsPageSize: 25, conversationsSort: "lastMessageAt", conversationsDir: "desc", conversationsSearch: "",
  statusClickFilter: null, selectedAgents: new Set(),
};

function readStateFromUrl() {
  const params = new URLSearchParams(location.search);
  for (const key of ["period", "agentId", "channel", "categoryId", "status", "priority", "startDate", "endDate", "metric", "granularity"]) {
    if (params.has(key)) state[key] = params.get(key);
  }
  if (params.has("compare")) state.compare = params.get("compare") === "true";
}
function writeStateToUrl() {
  const params = new URLSearchParams();
  for (const key of ["period", "agentId", "channel", "categoryId", "status", "priority", "startDate", "endDate", "metric", "granularity"]) {
    if (state[key]) params.set(key, state[key]);
  }
  if (state.compare) params.set("compare", "true");
  history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
}
function queryFromState(extra = {}) {
  const params = new URLSearchParams();
  if (state.period) params.set("period", state.period);
  if (state.period === "custom") { if (state.startDate) params.set("startDate", state.startDate); if (state.endDate) params.set("endDate", state.endDate); }
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
  agentId: (value, ctx) => `Vendedor: ${ctx.agents.find((a) => a.id === value)?.name || value}`,
  channel: (value) => `Canal: ${CHANNEL_LABELS[value] || value}`,
  categoryId: (value, ctx) => `Categoria: ${ctx.categories.find((c) => c.id === value)?.name || value}`,
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
  const [users, categories] = await Promise.all([api("/api/users"), api("/api/categories")]);
  filterContext = { agents: users, categories };
  $("#f-agent").innerHTML = '<option value="">Vendedor: todos</option><option value="unassigned">Sem responsável</option>'
    + users.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("");
  $("#f-channel").innerHTML = '<option value="">Canal: todos</option>' + Object.entries(CHANNEL_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  $("#f-category").innerHTML = '<option value="">Categoria: todas</option>' + categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  $("#f-status").innerHTML = '<option value="">Status: todos</option>' + Object.entries(STATUS_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  $("#f-priority").innerHTML = '<option value="">Prioridade: todas</option>' + ["NORMAL", "ALTA", "URGENTE"].map((p) => `<option value="${p}">${p}</option>`).join("");

  $("#f-period").value = state.period;
  $("#f-agent").value = state.agentId;
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
$("#f-category").addEventListener("change", (e) => { state.categoryId = e.target.value; onFiltersChanged(); });
$("#f-status").addEventListener("change", (e) => { state.status = e.target.value; onFiltersChanged(); });
$("#f-priority").addEventListener("change", (e) => { state.priority = e.target.value; onFiltersChanged(); });
$("#f-clear").addEventListener("click", () => {
  Object.assign(state, { period: "7d", startDate: "", endDate: "", agentId: "", channel: "", categoryId: "", status: "", priority: "" });
  populateFilterOptions();
  onFiltersChanged();
});
$("#theme-toggle").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try { localStorage.setItem("mibro-theme", dark ? "dark" : "light"); } catch { /* ignore */ }
});
$("#refresh").addEventListener("click", () => loadAll());

function onFiltersChanged() { writeStateToUrl(); renderChips(); state.conversationsPage = 1; loadAll(); }

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
  ["responseRate", "Taxa de resposta", "percent"], ["slaMetPercent", "SLA cumprido", "percent"],
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
  const accent = cssVar("--rp-accent") || "#ef5b2a";
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
// Vendedores
// ---------------------------------------------------------------------
let agentRows = [];
let agentSort = { field: "attended", dir: "desc" };
function renderAgentsTable() {
  const sorted = [...agentRows].sort((a, b) => {
    const av = a[agentSort.field]; const bv = b[agentSort.field];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === "string") return agentSort.dir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    return agentSort.dir === "asc" ? av - bv : bv - av;
  });
  $("#agents-tbody").innerHTML = sorted.map((agent) => `
    <tr data-user="${agent.userId}">
      <td><input type="checkbox" class="agent-select" data-user="${agent.userId}" ${state.selectedAgents.has(agent.userId) ? "checked" : ""}></td>
      <td data-label="Vendedor">${escapeHtml(agent.name)}</td>
      <td data-label="Atendidas">${agent.attended}</td>
      <td data-label="Assumidas">${agent.claimed}</td>
      <td data-label="Resolvidas">${agent.resolved}</td>
      <td data-label="Finalizadas">${agent.finalized}</td>
      <td data-label="Mensagens">${agent.messagesSent}</td>
      <td data-label="1ª resposta">${formatDuration(agent.firstResponseAvgSeconds)}</td>
      <td data-label="Resposta">${formatDuration(agent.responseAvgSeconds)}</td>
      <td data-label="Resolução">${formatDuration(agent.resolutionAvgSeconds)}</td>
      <td data-label="Taxa resolução">${formatPercent(agent.resolutionRate)}</td>
      <td data-label="SLA">${formatPercent(agent.slaMetPercent)}</td>
      <td data-label="Nunca respondidas">${agent.neverAnswered}</td>
    </tr>`).join("") || '<tr><td colspan="13" class="rp-empty">Nenhum vendedor com atividade no período.</td></tr>';

  $$(".agent-select").forEach((box) => box.addEventListener("click", (event) => {
    event.stopPropagation();
    const id = box.dataset.user;
    if (box.checked) { if (state.selectedAgents.size >= 3) { box.checked = false; toast("Selecione no máximo 3 vendedores para comparar.", true); return; } state.selectedAgents.add(id); }
    else state.selectedAgents.delete(id);
    $("#agents-compare-btn").disabled = state.selectedAgents.size < 2;
  }));
  $$("#agents-tbody tr[data-user]").forEach((row) => row.addEventListener("click", (event) => {
    if (event.target.classList.contains("agent-select")) return;
    openAgentDrawer(row.dataset.user);
  }));
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
$("#agents-export").addEventListener("click", () => { location.href = `/api/reports/conversations/agents/export?${queryFromState()}`; });
$("#agents-compare-btn").addEventListener("click", async () => {
  try {
    const rows = await api(`/api/reports/conversations/agents/compare?${queryFromState({ userIds: [...state.selectedAgents].join(",") })}`);
    const columns = [["attended", "Conversas"], ["resolved", "Resolvidas"], ["firstResponseAvgSeconds", "1ª resposta", "duration"], ["resolutionRate", "Resolução", "percent"], ["slaMetPercent", "SLA", "percent"]];
    const wrap = $("#agents-compare-result");
    wrap.hidden = false;
    wrap.innerHTML = `<table class="rp-table"><thead><tr><th></th>${rows.map((r) => `<th>${escapeHtml(r.name)}</th>`).join("")}</tr></thead><tbody>
      ${columns.map(([key, label, format]) => `<tr><td>${label}</td>${rows.map((r) => `<td>${format === "duration" ? formatDuration(r[key]) : format === "percent" ? formatPercent(r[key]) : (r[key] ?? "—")}</td>`).join("")}</tr>`).join("")}
    </tbody></table>`;
  } catch (error) { toast(error.message, true); }
});

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
          <div class="rp-kpi compact"><label>Tempo total</label><div class="rp-kpi-value" style="font-size:13px">${formatDuration(m.resolutionSeconds)}</div></div>
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
    const data = await api(`/api/reports/conversations/agents/${userId}?${queryFromState()}`);
    const s = data.stats;
    drawer.innerHTML = `
      <div class="rp-drawer-head"><div><h2>${escapeHtml(data.user.name)}</h2><p>${escapeHtml(data.user.email || "")} &bull; ${escapeHtml(data.user.role)}</p></div><button class="rp-drawer-close" id="drawer-close-2">&times;</button></div>
      <div class="rp-drawer-section"><h4>Desempenho no período</h4>
        <div class="rp-drawer-kpis">
          <div class="rp-kpi compact"><label>Atendidas</label><div class="rp-kpi-value" style="font-size:16px">${s.attended}</div></div>
          <div class="rp-kpi compact"><label>Resolvidas</label><div class="rp-kpi-value" style="font-size:16px">${s.resolved}</div></div>
          <div class="rp-kpi compact"><label>Nunca respondidas</label><div class="rp-kpi-value" style="font-size:16px">${s.neverAnswered}</div></div>
          <div class="rp-kpi compact"><label>1ª resposta média</label><div class="rp-kpi-value" style="font-size:16px">${formatDuration(s.firstResponseAvgSeconds)}</div></div>
          <div class="rp-kpi compact"><label>Resposta média</label><div class="rp-kpi-value" style="font-size:16px">${formatDuration(s.responseAvgSeconds)}</div></div>
          <div class="rp-kpi compact"><label>SLA cumprido</label><div class="rp-kpi-value" style="font-size:16px">${formatPercent(s.slaMetPercent)}</div></div>
        </div>
      </div>
      <div class="rp-drawer-section"><h4>Distribuição por categoria</h4><div class="rp-rank" id="agent-drawer-categories"></div></div>
      <div class="rp-drawer-section"><h4>Distribuição por canal</h4><div class="rp-rank" id="agent-drawer-channels"></div></div>
      <div class="rp-drawer-section"><h4>Atendimentos recentes</h4><div id="agent-drawer-recent"></div></div>
    `;
    $("#drawer-close-2").addEventListener("click", closeDrawers);
    renderRank("agent-drawer-categories", data.categoryBreakdown, { metaFn: (i) => `${i.count} (${i.percent.toFixed(0)}%)`, emptyLabel: "Sem dados." });
    renderRank("agent-drawer-channels", data.channelBreakdown, { metaFn: (i) => `${i.count} (${i.percent.toFixed(0)}%)`, emptyLabel: "Sem dados." });
    $("#agent-drawer-recent").innerHTML = data.recentConversations.map((c) => `
      <div class="rp-timeline-item" style="border-left:none;padding-left:0;margin-left:0">
        <strong>${escapeHtml(c.contactName)}</strong> — ${escapeHtml(c.categoryName || "Sem categoria")} &bull; ${escapeHtml(CHANNEL_LABELS[c.channel] || c.channel)}<br>
        <span style="color:var(--rp-muted)">${escapeHtml(STATUS_LABELS[c.status] || c.status)} &bull; ${formatDateTime(c.lastMessageAt)}</span>
      </div>`).join("") || '<p class="rp-empty">Nenhum atendimento recente.</p>';
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
  try {
    const [summary, status, channels, categories, agents, heatmap, waitBuckets, alerts] = await Promise.all([
      api(`/api/reports/conversations/summary?${queryFromState()}`),
      api(`/api/reports/conversations/status-breakdown?${queryFromState()}`),
      api(`/api/reports/conversations/channel-breakdown?${queryFromState()}`),
      api(`/api/reports/conversations/category-breakdown?${queryFromState()}`),
      api(`/api/reports/conversations/agents?${queryFromState()}`),
      api(`/api/reports/conversations/heatmap?${queryFromState()}`),
      api(`/api/reports/conversations/wait-time-buckets?${queryFromState()}`),
      api(`/api/reports/conversations/alerts?${queryFromState()}`),
    ]);
    renderKpis("kpi-main", MAIN_KPI_DEFS, summary, false);
    renderKpis("kpi-quality", QUALITY_KPI_DEFS, summary, true);
    if (summary.current.truncated) toast("Período muito grande — tempos de resposta não puderam ser calculados. Refine o filtro de período.", true);
    renderStatusDonut(status);
    renderRank("channel-rank", channels.items, { metaFn: (i) => `${i.count} &bull; ${formatDuration(i.firstResponseAvgSeconds)}`, onClick: (item) => { state.channel = state.channel === item.channel ? "" : item.channel; $("#f-channel").value = state.channel; onFiltersChanged(); }, emptyLabel: "Sem conversas no período." });
    renderRank("category-rank", categories.items, { metaFn: (i) => `${i.percent.toFixed(0)}% &bull; ${formatDuration(i.resolutionAvgSeconds)}`, onClick: (item) => { state.categoryId = state.categoryId === item.categoryId ? "" : (item.categoryId || ""); $("#f-category").value = state.categoryId; onFiltersChanged(); }, emptyLabel: "Sem conversas no período." });
    agentRows = agents.agents;
    renderAgentsTable();
    renderHeatmap(heatmap);
    renderRank("wait-buckets", waitBuckets.items, { metaFn: (i) => `${i.count} (${i.percent.toFixed(0)}%)`, emptyLabel: "Sem dados suficientes." });
    renderAlerts(alerts);
  } catch (error) { toast(error.message, true); }
  loadTimeseries();
  loadConversations();
}

(async function boot() {
  try {
    const authStatus = await api("/api/auth/status");
    if (!authStatus.user.isMaster) { document.body.innerHTML = '<div class="rp-empty" style="padding:60px">Acesso restrito a conta Master.</div>'; return; }
    readStateFromUrl();
    await populateFilterOptions();
    renderChips();
    loadAll();
  } catch (error) { toast(error.message, true); }
})();
