// Central de Operação — só apresentação. Escopo (empresa, setor, Supervisor x
// Master) e privacidade são decididos no backend (operations-panel-service).
const $ = (selector) => document.querySelector(selector);
const esc = (value = "") => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

const ATTENTION_PAGE = 20;
const state = { company: "ALL", attentionLimit: ATTENTION_PAGE, loading: false, pending: false };

async function api(url, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  if (response.status === 401) { location.replace("/login.html"); throw new Error("Sessão encerrada."); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || "Não foi possível concluir a operação.");
  return body;
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 3200);
}

function duration(minutes) {
  if (minutes === null || minutes === undefined) return "—";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

function seconds(value) {
  return value === null || value === undefined ? "—" : duration(Math.round(value / 60));
}

const CARD_DEFS = [
  ["waitingService", "Aguardando atendimento", (cards) => (cards.slaCritical ? "critical" : "")],
  ["unassigned", "Sem responsável", () => ""],
  ["slaCritical", "SLA crítico", (cards) => (cards.slaCritical ? "critical" : "")],
  ["slaNear", "SLA próximo do limite", (cards) => (cards.slaNear ? "warning" : "")],
  ["uncategorized", "Sem categoria", () => ""],
  ["preferredWaiting", "Clientes fixos aguardando", () => ""],
  ["privateSectorPending", "Setor protegido pendente", () => ""],
  ["open", "Conversas abertas", () => ""],
  ["finalizedToday", "Finalizadas hoje", () => ""],
  ["waitingTeam", "Aguardando equipe", () => ""],
  ["waitingClient", "Aguardando cliente", () => ""],
];

function renderCards(cards) {
  $("#ops-cards").innerHTML = CARD_DEFS.map(([key, label, tone]) => `
    <article class="ops-card ${tone(cards)}"><span>${esc(label)}</span><strong>${Number(cards[key] || 0)}</strong></article>`).join("");
}

const REASON_LABELS = {
  SLA_BREACHED: "SLA estourado",
  SLA_NEAR: "SLA próximo do limite",
  PREFERRED_WAITING: "Cliente fixo aguardando",
  PRIVATE_WAITING: "Setor protegido aguardando",
  UNCATEGORIZED: "Sem categoria",
  UNASSIGNED: "Sem responsável",
};

function companyBadge(company) {
  return window.CompanyContext?.multi() ? window.CompanyContext.badge(company) : "";
}

function renderAttention(attention) {
  $("#ops-attention-count").textContent = attention.total ? `${attention.total} conversa(s)` : "";
  $("#ops-attention").innerHTML = attention.items.length ? attention.items.map((item) => `
    <a class="ops-attention-item ${esc(item.severity)}" href="/?conversation=${encodeURIComponent(item.conversationId)}"${window.CompanyContext?.styleAttr(item.company) || ""}>
      <span class="ops-attention-main"><strong>${esc(item.contactName)}</strong>${companyBadge(item.company)}</span>
      <span class="ops-attention-meta">
        <b>${esc(REASON_LABELS[item.reason] || item.reason)}</b>
        ${item.category ? `<span>${item.privateSector ? "🔒 " : ""}${esc(item.category.name)}</span>` : "<span>Sem categoria</span>"}
        ${item.preferredAssignee ? `<span>Atendente fixo: ${esc(item.preferredAssignee.name)}</span>` : ""}
        <span>${item.assignee ? `Responsável: ${esc(item.assignee.name)}` : "Sem responsável"}</span>
      </span>
      <span class="ops-attention-wait">Aguardando há ${esc(duration(item.waitingMinutes))}</span>
    </a>`).join("") : `<div class="ops-empty">Nada precisando de atenção agora. 🎉</div>`;
  $("#ops-attention-more").hidden = attention.items.length >= attention.total;
}

function renderTeam(team) {
  $("#ops-team").innerHTML = team.length ? team.map((member) => `
    <article class="ops-member">
      <span class="ops-presence ${member.online ? "online" : ""}" aria-hidden="true"></span>
      <div><strong>${esc(member.name)}</strong><small>${member.online ? "Online" : "Offline"}</small></div>
      <ul>
        <li>${member.open} conversa(s)</li>
        ${member.pending ? `<li>${member.pending} pendente(s)</li>` : ""}
        ${member.slaCritical ? `<li class="critical">${member.slaCritical} SLA crítico</li>` : ""}
        ${member.privateSector ? `<li>${member.privateSector} setor protegido</li>` : ""}
      </ul>
    </article>`).join("") : `<div class="ops-empty">Nenhum membro de equipe neste filtro.</div>`;
}

function renderMetrics(metrics, cards) {
  const rows = [
    ["Primeira resposta (média)", seconds(metrics.avgFirstResponseSeconds)],
    ["Tempo de atendimento (média)", seconds(metrics.avgHandlingSeconds)],
    ["SLA estourado agora", cards.slaCritical],
    ["Transferências", metrics.transfersToday],
    ["Finalizadas", cards.finalizedToday],
    ["Aguardando cliente", cards.waitingClient],
    ["Aguardando equipe", cards.waitingTeam],
  ];
  $("#ops-metrics").innerHTML = rows.map(([label, value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");
  $("#ops-metrics-note").textContent = metrics.sampleTruncated ? "Médias calculadas sobre as primeiras 500 conversas do dia." : "";
  $("#ops-by-agent").innerHTML = metrics.conversationsByAgent.length
    ? `<h3>Conversas por atendente</h3>${metrics.conversationsByAgent.map((row) => `<div class="ops-bar"><span>${esc(row.name)}</span><i style="--value:${Math.min(100, row.open * 10)}%"></i><b>${row.open}</b></div>`).join("")}`
    : "";
}

function query() {
  const params = new URLSearchParams();
  if (state.company && state.company !== "ALL") params.set("company", state.company);
  for (const [key, selector] of [["categoryId", "#ops-category"], ["assigneeId", "#ops-assignee"], ["status", "#ops-status"]]) {
    if ($(selector).value) params.set(key, $(selector).value);
  }
  params.set("attentionLimit", String(state.attentionLimit));
  return params.toString();
}

async function load() {
  if (state.loading) { state.pending = true; return; }
  state.loading = true;
  try {
    const data = await api(`/api/operations/overview?${query()}`);
    renderCards(data.cards);
    renderAttention(data.attention);
    renderTeam(data.team);
    renderMetrics(data.metrics, data.cards);
    $("#ops-truncated").hidden = !data.truncated;
    $("#ops-updated").textContent = `Atualizado às ${new Intl.DateTimeFormat("pt-BR", { timeStyle: "short" }).format(new Date(data.generatedAt))}`;
    const assignee = $("#ops-assignee");
    const current = assignee.value;
    assignee.innerHTML = `<option value="">Todos</option><option value="NONE">Sem responsável</option>${data.team.map((member) => `<option value="${esc(member.id)}">${esc(member.name)}</option>`).join("")}`;
    assignee.value = [...assignee.options].some((option) => option.value === current) ? current : "";
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.loading = false;
    if (state.pending) { state.pending = false; load(); }
  }
}

function renderCategoryOptions(options) {
  const select = $("#ops-category");
  const companyId = window.CompanyContext?.companies.find((company) => company.slug === state.company)?.id;
  const categories = options.categories.filter((category) => !companyId || category.companyId === companyId);
  const multi = window.CompanyContext?.multi();
  select.innerHTML = `<option value="">Todos os setores</option><option value="UNCATEGORIZED">Sem categoria</option>${categories.map((category) => {
    const company = multi ? window.CompanyContext.byId(category.companyId) : null;
    return `<option value="${esc(category.id)}">${esc(category.name)}${company ? ` · ${esc(company.displayName)}` : ""}</option>`;
  }).join("")}`;
}

// Atualização: aviso do SSE (sem conteúdo) com debounce + rede de segurança
// a cada 60 s. Nada é carregado além do resumo paginado.
function listenRealtime() {
  let timer;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(load, 1500); };
  try {
    const events = new EventSource("/api/events");
    events.addEventListener("inbox.updated", schedule);
  } catch { /* sem SSE: só o intervalo */ }
  setInterval(() => { if (!document.hidden) load(); }, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
}

$("#theme-toggle").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try { localStorage.setItem("mibro-theme", dark ? "dark" : "light"); } catch { /* ignore */ }
  $("#theme-toggle").textContent = dark ? "☾" : "☀";
});
$("#logout").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.replace("/login.html");
});
$("#ops-refresh").addEventListener("click", load);
$("#ops-filters").addEventListener("change", () => { state.attentionLimit = ATTENTION_PAGE; load(); });
$("#ops-attention-more").addEventListener("click", () => { state.attentionLimit += ATTENTION_PAGE; load(); });

(async () => {
  try {
    const status = await api("/api/auth/status");
    $("#current-user").textContent = status.user.name;
    await window.CompanyContext.load();
    const options = await api("/api/operations/options");
    // Supervisor só filtra pelas empresas que supervisiona.
    window.CompanyContext.companies = window.CompanyContext.companies.filter((company) => options.companies.some(({ id }) => id === company.id));
    state.company = window.CompanyContext.preference || "ALL";
    if (!options.companies.some((company) => company.slug === state.company)) state.company = "ALL";
    window.CompanyContext.mountFilter($("#ops-company-filter"), (slug) => {
      state.company = slug;
      renderCategoryOptions(options);
      load();
    }, state.company);
    renderCategoryOptions(options);
    if (!status.user.isMaster) $("#ops-subtitle").textContent = "Somente as empresas e setores que você supervisiona.";
    await load();
    listenRealtime();
  } catch (error) {
    toast(error.message, true);
  }
})();
