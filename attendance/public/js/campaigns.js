// Mesma biblioteca e editor para as duas telas, sem duplicar JS ou consultas.
const TEMPLATE_LIBRARY_MODE = /^\/templates(?:\.html)?\/?$/i.test(location.pathname);
const state = {
  campaigns: [], selected: null, templates: [], categories: [], bots: [],
  importHeaders: [], importCsvText: "", importFileName: "", importErrors: [],
  templatesAvailable: false, templateSync: null,
  // Estados de carga e sequências: respostas atrasadas nunca sobrescrevem a
  // seleção atual (troca rápida de número/campanha).
  listStatus: "loading", listError: "", listSeq: 0, selectSeq: 0, templatesSeq: 0,
  templateFilter: "APPROVED", templateSearch: "", exampleValues: {},
};
const $ = (selector) => document.querySelector(selector);

const statusLabels = {
  DRAFT: "RASCUNHO", SCHEDULED: "AGENDADA", QUEUED: "NA FILA", RUNNING: "EM ENVIO",
  PAUSED: "PAUSADA", COMPLETED: "CONCLUÍDA", CANCELLED: "CANCELADA", FAILED: "FALHOU",
};
const templateStatusLabels = { APPROVED: "Aprovado", PENDING: "Pendente", REJECTED: "Rejeitado", PAUSED: "Pausado", DISABLED: "Desativado" };

async function api(url, options = {}) {
  const isForm = options.body instanceof FormData;
  const headers = { ...(options.body && !isForm ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) { location.replace("/login.html"); throw new Error("Sessão encerrada."); }
  if (response.headers.get("content-type")?.includes("text/csv")) return response;
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(body?.error || "Não foi possível concluir a operação."); error.metaError = body?.metaError || null; error.status = response.status; throw error; }
  return body;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show${error ? " error" : ""}`;
  element.setAttribute("role", error ? "alert" : "status");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = "toast"; }, 3600);
}

// Um clique = uma requisição: o botão fica desabilitado com rótulo de
// progresso até a resposta (cliques repetidos são ignorados).
async function withBusy(button, label, action) {
  if (button?.dataset.busy === "true") return undefined;
  const original = button?.textContent;
  if (button) { button.dataset.busy = "true"; button.disabled = true; if (label) button.textContent = label; }
  try { return await action(); }
  finally { if (button) { button.dataset.busy = "false"; button.disabled = false; if (label) button.textContent = original; } }
}

function metricTile(value, label) {
  return `<div class="metric-tile"><b>${escapeHtml(value ?? "-")}</b><span>${escapeHtml(label)}</span></div>`;
}

// ===== Multiempresa (item 35/36): empresa primeiro; depois só números,
// templates (WABA do número), setores e Bots daquela empresa. =====
state.companyFilter = "ALL";
state.accounts = [];

async function loadCampaignAccounts() {
  await window.CompanyContext.load();
  state.accounts = await api("/api/campaign-accounts").catch(() => []);
  const companyIds = new Set(state.accounts.map((account) => account.companyId));
  const companies = window.CompanyContext.companies.filter((company) => companyIds.has(company.id));
  $("#campaign-company").innerHTML = (companies.length > 1 ? `<option value="">Selecione a empresa</option>` : "")
    + companies.map((company) => `<option value="${escapeHtml(company.id)}">${escapeHtml(company.name)}</option>`).join("");
  state.companyFilter = window.CompanyContext.mountFilter($("#campaign-company-filter"), (slug) => {
    state.companyFilter = slug;
    if (!TEMPLATE_LIBRARY_MODE) return loadCampaigns();
    const company = companies.find((item) => item.slug === slug) || companies[0];
    const account = state.accounts.find((item) => item.companyId === company?.id);
    applyCampaignCompany(company?.id || "", account?.id || "").catch((error) => toast(error.message, true));
  }, "ALL");
}

function renderCampaignAccounts(companyId, selectedId = "") {
  const accounts = state.accounts.filter((account) => account.companyId === companyId);
  $("#campaign-account").innerHTML = (accounts.length > 1 ? `<option value="">Selecione o número</option>` : "")
    + accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}${account.displayNumber ? ` · ${escapeHtml(account.displayNumber)}` : ""}</option>`).join("");
  if (selectedId && accounts.some((account) => account.id === selectedId)) $("#campaign-account").value = selectedId;
  // Setor e Bot de resposta: só os da empresa (o backend também valida).
  [...$("#campaign-reply-category").options].forEach((option) => { option.hidden = Boolean(option.value) && option.dataset.companyId !== companyId; });
  [...$("#campaign-reply-bot").options].forEach((option) => { option.hidden = Boolean(option.value) && option.dataset.companyId !== companyId; });
}

async function applyCampaignCompany(companyId, accountId = "") {
  $("#campaign-company").value = companyId || "";
  renderCampaignAccounts(companyId, accountId);
  await ensureTemplatesLoaded();
}

$("#campaign-company").addEventListener("change", () => {
  $("#campaign-reply-category").value = ""; $("#campaign-reply-bot").value = "";
  applyCampaignCompany($("#campaign-company").value).catch((error) => toast(error.message, true));
});
// Trocar o número muda a WABA: o template escolhido só continua se existir
// (mesmo nome e idioma, aprovado) na nova conta — nunca persiste em silêncio.
$("#campaign-account").addEventListener("change", () => {
  const previous = selectedTemplate();
  ensureTemplatesLoaded({ keep: previous ? { name: previous.name, language: previous.language } : null }).catch((error) => toast(error.message, true));
});

// ===== Lista de campanhas =====

async function loadCampaigns() {
  const seq = ++state.listSeq;
  const status = $("#campaign-status-filter").value;
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (state.companyFilter !== "ALL") params.set("company", state.companyFilter);
  if (state.listStatus !== "ready") { state.listStatus = "loading"; renderCampaignList(); }
  try {
    const rows = await api(`/api/campaigns${params.toString() ? `?${params}` : ""}`);
    if (seq !== state.listSeq) return;
    state.campaigns = Array.isArray(rows) ? rows : [];
    state.listStatus = "ready";
  } catch (error) {
    if (seq !== state.listSeq) return;
    state.campaigns = [];
    state.listStatus = error.status === 403 ? "forbidden" : "error";
    state.listError = error.message;
  }
  renderCampaignList();
}

function campaignListStateMarkup() {
  if (state.listStatus === "loading") return '<div class="skeleton-list" aria-label="Carregando campanhas"><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div></div>';
  if (state.listStatus === "forbidden") return '<div class="list-state error" role="alert"><b>Acesso restrito</b><p>Seu usuário não tem permissão para gerenciar campanhas.</p></div>';
  if (state.listStatus === "error") return `<div class="list-state error" role="alert"><b>Não foi possível carregar as campanhas.</b><p>${escapeHtml(state.listError)}</p><button type="button" data-campaign-retry>Tentar novamente</button></div>`;
  if ($("#campaign-status-filter").value || state.companyFilter !== "ALL") return '<div class="list-state"><b>Nenhuma campanha neste filtro.</b><p>Altere o status ou a empresa para ver outras campanhas.</p></div>';
  return '<div class="list-state"><b>Nenhuma campanha criada.</b><p>Use “+ Nova” para criar a primeira.</p></div>';
}

const campaignStartFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short",
});

function campaignStartMarkup(campaign) {
  if (!campaign.startedAt) return "";
  const start = new Date(campaign.startedAt);
  if (Number.isNaN(start.getTime())) return "";
  return `Iniciada em <time datetime="${start.toISOString()}">${campaignStartFormatter.format(start)}</time>`;
}

function renderCampaignList() {
  $("#campaign-count").textContent = state.listStatus === "ready" ? `${state.campaigns.length} campanha(s)` : state.listStatus === "loading" ? "Carregando..." : "Lista indisponível";
  $("#campaign-list").setAttribute("aria-busy", String(state.listStatus === "loading"));
  $("#campaign-list").innerHTML = state.listStatus === "ready" && state.campaigns.length ? state.campaigns.map((campaign) => `
    <button class="bot-card ${state.selected?.id === campaign.id ? "active" : ""}" type="button" data-campaign-id="${escapeHtml(campaign.id)}" ${state.selected?.id === campaign.id ? 'aria-current="true"' : ""}>
      <header><b>${escapeHtml(campaign.name)}</b>${window.CompanyContext.badge(campaign.company)}<span class="mini-status ${campaign.status}">${statusLabels[campaign.status]}</span></header>
      <small>${escapeHtml(campaign.templateName)}${campaign.channelAccount ? ` · ${escapeHtml(campaign.channelAccount.name)}` : ""}</small>
      ${campaign.startedAt ? `<small>${campaignStartMarkup(campaign)}</small>` : ""}
      <div class="bot-meta"><span>${campaign._count?.contacts ?? 0} contato(s)</span></div>
    </button>
  `).join("") : campaignListStateMarkup();
}

$("#campaign-list").addEventListener("click", (event) => {
  const card = event.target.closest("[data-campaign-id]");
  if (card) return selectCampaign(card.dataset.campaignId);
  if (event.target.closest("[data-campaign-retry]")) loadCampaigns();
});

// ===== Templates da WABA =====

function setTemplatesAvailability(available, message = "", { notice = false } = {}) {
  state.templatesAvailable = available;
  $("#campaign-save-button").disabled = !available;
  $("#campaign-preview-button").disabled = !available || !selectedTemplate();
  // O aviso da barra lateral é para indisponibilidade real da integração,
  // não para "ainda não escolheu o número".
  const element = $("#campaign-api-notice");
  element.hidden = available || !notice;
  element.querySelector("span").textContent = message || "A integração de templates da Meta ainda não está disponível. Você pode consultar campanhas, métricas, configurações e opt-outs normalmente; criação, edição e preview ficam liberados quando a API for configurada.";
}

// Carrega os templates do número escolhido. Nunca assume formato da
// resposta; erro vira estado visível com "Tentar novamente". O valor do
// <select> é o `id` do template (nunca nome/idioma concatenados).
async function ensureTemplatesLoaded({ keep = null } = {}) {
  const seq = ++state.templatesSeq;
  closeRoutingModal();
  state.templatesAccountId = null;
  const select = $("#campaign-template");
  const status = $("#campaign-templates-status");
  const retry = $("#campaign-templates-retry");
  const syncButton = $("#sync-templates");
  $("#template-compat-warning").hidden = true;
  setTemplatesAvailability(false);
  status.textContent = "";
  retry.hidden = true;
  const accountId = $("#campaign-account").value;
  if (!accountId) {
    syncButton.disabled = false;
    syncButton.textContent = "Sincronizar templates";
    $("#template-catalog").removeAttribute("aria-busy");
    state.templates = []; state.routingOrphans = []; state.templatesAccountId = null;
    select.innerHTML = `<option value="">Selecione a empresa e o número de envio</option>`;
    $("#template-catalog").innerHTML = `<p class="catalog-message">Selecione a empresa e o número de envio para ver os templates da WABA.</p>`;
    $("#template-sync-summary").textContent = "Os templates aparecem após escolher o número.";
    renderSelectedTemplate();
    return;
  }
  select.innerHTML = `<option value="">Carregando templates...</option>`;
  $("#template-catalog").setAttribute("aria-busy", "true");
  $("#template-catalog").innerHTML = `<p class="catalog-message" role="status"><span class="inline-spinner" aria-hidden="true"></span> Carregando templates da Meta…</p>`;
  syncButton.disabled = true;
  syncButton.textContent = "Sincronizando...";
  try {
    const response = await api(`/api/campaign-templates?channelAccountId=${encodeURIComponent(accountId)}`);
    if (seq !== state.templatesSeq) return;
    const templates = Array.isArray(response?.templates) ? response.templates : [];
    state.templateSync = response?.sync || null;
    state.templates = templates;
    state.templatesAccountId = accountId;
    state.routingCanEdit = TEMPLATE_LIBRARY_MODE && Boolean(response?.routingCanEdit);
    state.routingOrphans = Array.isArray(response?.routingOrphans) ? response.routingOrphans : [];
    state.routingError = response?.routingError || "";
    const approved = templates.filter((template) => template.status === "APPROVED");
    const choices = TEMPLATE_LIBRARY_MODE ? templates : approved;
    select.innerHTML = `<option value="">Selecione um template${TEMPLATE_LIBRARY_MODE ? "" : " aprovado"}</option>${choices.map((template) => (
      `<option value="${escapeHtml(template.id)}">${escapeHtml(template.name)} (${escapeHtml(template.language)}) — ${escapeHtml(template.category)}</option>`
    )).join("")}`;
    if (keep) {
      const match = approved.find((template) => template.name === keep.name && template.language === keep.language);
      if (match) select.value = match.id;
      else showCompatWarning(`O template “${keep.name}” (${keep.language}) não está aprovado na WABA deste número. Selecione outro template.`);
    }
    if (!approved.length && !TEMPLATE_LIBRARY_MODE) {
      status.textContent = "Nenhum template APROVADO foi encontrado na conta da Meta deste número. Crie/aprove um template no WhatsApp Manager e tente novamente.";
      retry.hidden = false;
      setTemplatesAvailability(false, status.textContent, { notice: true });
    } else {
      status.textContent = TEMPLATE_LIBRARY_MODE ? `${templates.length} template(s) encontrado(s), ${approved.length} aprovado(s).` : `${approved.length} template(s) aprovado(s) disponível(is).`;
      setTemplatesAvailability(true);
    }
    renderTemplateCatalog();
    onTemplateChanged();
  } catch (error) {
    if (seq !== state.templatesSeq) return;
    state.templates = [];
    state.routingOrphans = [];
    select.innerHTML = `<option value="">Templates da Meta indisponíveis</option>`;
    status.textContent = error.message || "Não foi possível carregar os templates da Meta.";
    setTemplatesAvailability(false, `${status.textContent} A área de Campanhas permanece disponível em modo limitado.`, { notice: true });
    retry.hidden = false;
    if (keep) showCompatWarning(`Não foi possível confirmar o template “${keep.name}” neste número. Tente novamente.`);
    renderTemplateCatalog(error);
    onTemplateChanged();
  } finally {
    if (seq === state.templatesSeq) {
      $("#template-catalog").removeAttribute("aria-busy");
      syncButton.disabled = false;
      syncButton.textContent = "Sincronizar templates";
    }
  }
}
$("#campaign-templates-retry").addEventListener("click", () => ensureTemplatesLoaded());
$("#sync-templates").addEventListener("click", () => {
  const previous = selectedTemplate();
  ensureTemplatesLoaded({ keep: previous ? { name: previous.name, language: previous.language } : null });
});

function showCompatWarning(message) {
  $("#template-compat-warning").textContent = message;
  $("#template-compat-warning").hidden = false;
}

function templateRateLabel(template) {
  const pricing = template?.pricing;
  if (!pricing || !Number.isFinite(Number(pricing.rate))) return "Tarifa indisponível";
  return `Tarifa base Brasil: ${new Intl.NumberFormat("pt-BR", { style:"currency", currency:pricing.currency || "BRL", minimumFractionDigits:4 }).format(Number(pricing.rate))} por mensagem entregue`;
}

// Nomes de template usam "_": permite quebrar a linha depois dele, nunca no meio da palavra.
const breakableName = (name) => escapeHtml(name).replace(/_/g, "_<wbr>");
const templateComponents = (template) => (Array.isArray(template?.components) ? template.components : []);
const templateComponent = (template, type) => templateComponents(template).find((component) => component.type === type) || null;
const templateBodyText = (template) => templateComponent(template, "BODY")?.text || "";
const normalizeSearch = (value) => String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const templateFilters = {
  ALL: () => true,
  APPROVED: (template) => template.status === "APPROVED",
  MARKETING: (template) => template.category === "MARKETING",
  UTILITY: (template) => template.category === "UTILITY",
  AUTHENTICATION: (template) => template.category === "AUTHENTICATION",
  ROUTED: (template) => Boolean(template.routing),
  UNROUTED: (template) => !template.routing,
};

function visibleTemplates() {
  const term = normalizeSearch(state.templateSearch.trim());
  const filter = templateFilters[state.templateFilter] || templateFilters.ALL;
  return state.templates.filter((template) => filter(template) && (!term || [
    template.name, template.language, template.category, metaCategoryLabels[template.category],
    ...templateComponents(template).map((component) => component.text),
    template.routing?.categoryName, template.routing?.subcategoryName,
  ].some((field) => normalizeSearch(field).includes(term))));
}

function templateCardMarkup(template) {
  const selected = $("#campaign-template").value === template.id;
  const approved = template.status === "APPROVED";
  const routing = template.routing;
  const summary = templateBodyText(template).replace(/\s+/g, " ").trim() || "Sem texto no corpo.";
  const canEdit = state.routingCanEdit && (routing || approved);
  return `<article class="template-card ${selected ? "selected" : ""} ${approved ? "" : "not-selectable"}">
    <button type="button" class="template-card-select" role="radio" aria-checked="${selected}" data-template-id="${escapeHtml(template.id)}" ${approved || TEMPLATE_LIBRARY_MODE ? "" : 'aria-disabled="true"'}>
      <span class="template-card-top"><b class="template-card-name">${breakableName(template.name)}</b><span class="template-status ${escapeHtml(template.status)}">${escapeHtml(templateStatusLabels[template.status] || template.status || "Desconhecido")}</span></span>
      <span class="template-card-badges"><span class="badge">${escapeHtml(metaCategoryLabels[template.category] || template.category || "Sem categoria")}</span><span class="badge">${escapeHtml(template.language || "Sem idioma")}</span>${routing ? `<span class="badge routing-badge ${escapeHtml(routing.state)}">${routing.state === "ACTIVE" ? "Roteamento automático" : escapeHtml(routingStateLabels[routing.state] || routing.state)}</span>` : ""}</span>
      <span class="template-card-summary">${escapeHtml(summary)}</span>
      <span class="template-card-routing">${routing ? `Destino: ${escapeHtml(routing.categoryName || "—")}${routing.subcategoryName ? ` → ${escapeHtml(routing.subcategoryName)}` : ""}` : "Sem destino fixo"}</span>
    </button>
    ${selected ? '<span class="template-card-check" aria-hidden="true">✓ Selecionado</span>' : ""}
    ${canEdit ? `<button type="button" class="template-card-edit" data-edit-routing="${escapeHtml(encodeURIComponent(JSON.stringify([template.name, template.language])))}" aria-label="Editar destino de ${escapeHtml(template.name)}">Editar destino</button>` : ""}
  </article>`;
}

function renderTemplateCatalog(error = null) {
  const catalog = $("#template-catalog");
  const summary = $("#template-sync-summary");
  if (error) {
    const meta = error.metaError?.message ? ` (${error.metaError.message})` : "";
    summary.textContent = "Falha na sincronização.";
    catalog.innerHTML = `<div class="template-sync-error" role="alert"><b>Não foi possível carregar os templates.</b><span>${escapeHtml(error.message + meta)}</span></div>`;
    return;
  }
  const sync = state.templateSync;
  if (TEMPLATE_LIBRARY_MODE) $("#campaign-count").textContent = `${state.templates.length} template(s) no número selecionado`;
  summary.textContent = sync ? `Última sincronização: ${new Date(sync.syncedAt).toLocaleString("pt-BR")} • ${sync.total} encontrado(s)` : `${state.templates.length} template(s) nesta WABA.`;
  document.querySelectorAll("[data-template-filter]").forEach((button) => {
    const active = button.dataset.templateFilter === state.templateFilter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const templates = visibleTemplates();
  const parts = [];
  if (state.routingError) parts.push(`<div class="template-sync-error">${escapeHtml(state.routingError)}</div>`);
  parts.push(templates.length ? templates.map(templateCardMarkup).join("") : `<p class="catalog-message">${state.templates.length ? "Nenhum template corresponde à pesquisa ou ao filtro." : "Nenhum template encontrado nesta WABA."}</p>`);
  const orphans = state.routingOrphans || [];
  if (orphans.length) parts.push(`<article class="routing-orphans"><header><b>Destinos preservados sem template disponível</b><small>O template não existe mais nesta WABA (removido ou renomeado na Meta). A regra fica guardada para análise e nunca é aplicada a outro template.</small></header>${orphans.map((route) => templateRoutingBlock({ name: route.templateName, language: route.templateLanguage, category: null, status: null, routing: route })).join("")}</article>`);
  catalog.innerHTML = parts.join("");
}

$("#template-search").addEventListener("input", (event) => {
  clearTimeout(event.target._t);
  event.target._t = setTimeout(() => { state.templateSearch = event.target.value; renderTemplateCatalog(); }, 150);
});
$("#template-filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-template-filter]");
  if (!button) return;
  state.templateFilter = button.dataset.templateFilter;
  renderTemplateCatalog();
});
$("#template-catalog").addEventListener("click", (event) => {
  const edit = event.target.closest("[data-edit-routing]");
  if (edit) {
    const [name, language] = JSON.parse(decodeURIComponent(edit.dataset.editRouting));
    return openRoutingModal(name, language, edit);
  }
  const card = event.target.closest("[data-template-id]");
  if (!card) return;
  if (card.getAttribute("aria-disabled") === "true") return toast("Só templates aprovados pela Meta podem ser usados em campanhas.", true);
  chooseTemplate(card.dataset.templateId);
});
// Setas do teclado entre os cards (padrão radiogroup).
$("#template-catalog").addEventListener("keydown", (event) => {
  if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(event.key) || !event.target.matches("[data-template-id]")) return;
  const cards = [...document.querySelectorAll("#template-catalog [data-template-id]")];
  const next = cards[(cards.indexOf(event.target) + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1) + cards.length) % cards.length];
  event.preventDefault();
  next?.focus();
});

function chooseTemplate(id) {
  if ($("#campaign-template").value === id) return;
  $("#campaign-template").value = id;
  $("#template-compat-warning").hidden = true;
  state.exampleValues = {};
  renderTemplateCatalog();
  // Chaves como "BODY:1" se repetem entre templates: não herdar o mapeamento.
  onTemplateChanged({});
  document.querySelector(`#template-catalog [data-template-id="${CSS.escape(id)}"]`)?.focus();
}

function onTemplateChanged(existingMapping) {
  renderVariableMapping(selectedTemplate(), existingMapping);
  renderSelectedTemplate();
  $("#campaign-preview-button").disabled = !state.templatesAvailable || !selectedTemplate();
}

// ===== Prévia no formato de mensagem do WhatsApp =====
// Valores de exemplo só para a prévia (nunca alteram o template oficial):
// exemplo editado > campo mapeado (dados fictícios) > exemplo da Meta.
const SAMPLE_VALUES = { firstName: "Gabriel", fullName: "Gabriel Souza", companyName: "Loja Exemplo", city: "São Paulo", state: "SP" };
const MAPPING_LABELS = { firstName: "Primeiro nome", fullName: "Nome completo", companyName: "Empresa", city: "Cidade", state: "UF" };

function variablePreview(variable, mapping = currentVariableMapping()) {
  const edited = state.exampleValues[variable.key];
  if (edited) return { value: edited, source: "Exemplo editado na prévia" };
  const field = mapping[variable.key];
  if (field?.startsWith("static:")) return field.length > 7 ? { value: field.slice(7), source: "Texto fixo" } : { value: "", source: "Texto fixo vazio" };
  if (field && SAMPLE_VALUES[field]) return { value: SAMPLE_VALUES[field], source: `Mapeado: ${MAPPING_LABELS[field]} (exemplo)` };
  if (variable.example) return { value: variable.example, source: "Exemplo da Meta" };
  return { value: "", source: "" };
}

// Texto do WhatsApp com variáveis: escapa tudo, aplica *negrito*, _itálico_,
// ~tachado~, ```mono``` e links, e destaca cada variável preenchida.
function renderWhatsappText(text, variables) {
  const mapping = variables.length ? currentVariableMapping() : {};
  const byPlaceholder = new Map(variables.map((variable) => [variable.placeholder, variable]));
  const tokens = [];
  const withTokens = String(text || "").replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (match, placeholder) => {
    tokens.push(placeholder);
    return `\u0000${tokens.length - 1}\u0000`;
  });
  const formatted = escapeHtml(withTokens)
    .replace(/```([^`]+)```/g, "<code>$1</code>")
    .replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s>])_([^_\n]+)_/g, "$1<em>$2</em>")
    .replace(/~([^~\n]+)~/g, "<s>$1</s>")
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\n/g, "<br>");
  return formatted.replace(/\u0000(\d+)\u0000/g, (match, index) => {
    const placeholder = tokens[Number(index)];
    const variable = byPlaceholder.get(placeholder);
    const { value } = variable ? variablePreview(variable, mapping) : { value: "" };
    return value
      ? `<span class="wa-var" title="{{${escapeHtml(placeholder)}}}">${escapeHtml(value)}</span>`
      : `<span class="wa-var missing" title="Variável sem valor de exemplo">{{${escapeHtml(placeholder)}}}</span>`;
  });
}

const buttonIcons = { URL: "↗", PHONE_NUMBER: "☎", QUICK_REPLY: "↩", COPY_CODE: "⧉", OTP: "⧉" };

function renderSelectedTemplate() {
  const panel = $("#template-selected");
  const template = selectedTemplate();
  renderReview();
  if (!template) {
    panel.innerHTML = `<div class="template-selected-empty"><b>Nenhum template selecionado</b><p>Escolha um template na lista para ver a mensagem completa, as variáveis e o destino automático.</p></div>`;
    return;
  }
  const variables = Array.isArray(template.variables) ? template.variables : [];
  const header = templateComponent(template, "HEADER");
  const footer = templateComponent(template, "FOOTER");
  const buttons = templateComponent(template, "BUTTONS")?.buttons || [];
  const routing = template.routing;
  const account = $("#campaign-account").selectedOptions[0]?.textContent || "—";
  const headerMarkup = !header ? "" : header.format && header.format !== "TEXT"
    ? `<div class="wa-media">${{ IMAGE: "🖼️ Imagem", VIDEO: "🎬 Vídeo", DOCUMENT: "📄 Documento", LOCATION: "📍 Localização" }[header.format] || header.format} no cabeçalho</div>`
    : `<div class="wa-header">${renderWhatsappText(header.text, variables)}</div>`;
  const missing = variables.filter((variable) => ["BODY", "HEADER"].includes(variable.component) && !variablePreview(variable).value);
  panel.innerHTML = `
    <header class="selected-head">
      <span>TEMPLATE SELECIONADO</span>
      <h4 class="selected-name">${breakableName(template.name)}</h4>
      <dl class="selected-meta">
        <div><dt>Categoria Meta</dt><dd>${escapeHtml(metaCategoryLabels[template.category] || template.category || "—")}</dd></div>
        <div><dt>Idioma</dt><dd>${escapeHtml(template.language || "—")}</dd></div>
        <div><dt>Status</dt><dd><span class="template-status ${escapeHtml(template.status)}">${escapeHtml(templateStatusLabels[template.status] || template.status)}</span></dd></div>
        <div><dt>Número de envio</dt><dd>${escapeHtml(account)}</dd></div>
        <div class="wide"><dt>Destino automático</dt><dd>${routing ? `${escapeHtml(routing.categoryName || "—")}${routing.subcategoryName ? ` → ${escapeHtml(routing.subcategoryName)}` : ""} · <span class="routing-state ${escapeHtml(routing.state)}">${escapeHtml(routingStateLabels[routing.state] || routing.state)}</span>` : "Sem destino fixo (vale a regra do número ou a triagem)"}</dd></div>
      </dl>
      ${routing?.issue ? `<p class="routing-issue">${escapeHtml(routing.issue)}</p>` : ""}
      ${template.unsupportedReason ? `<p class="routing-issue">${escapeHtml(template.unsupportedReason)}</p>` : ""}
      <p class="selected-price">${escapeHtml(templateRateLabel(template))}</p>
      ${state.routingCanEdit && (routing || template.status === "APPROVED") ? `<button type="button" class="selected-edit-routing" data-edit-routing="${escapeHtml(encodeURIComponent(JSON.stringify([template.name, template.language])))}">Editar destino automático</button>` : ""}
    </header>
    <div class="wa-preview" aria-label="Prévia da mensagem no WhatsApp">
      <div class="wa-bubble">
        ${headerMarkup}
        <div class="wa-body">${renderWhatsappText(templateBodyText(template), variables) || "<em>Sem texto no corpo.</em>"}</div>
        ${footer?.text ? `<div class="wa-footer">${escapeHtml(footer.text)}</div>` : ""}
      </div>
      ${buttons.length ? `<div class="wa-buttons">${buttons.map((button) => `<span class="wa-button"><i aria-hidden="true">${buttonIcons[button.type] || "•"}</i>${escapeHtml(button.text || button.type)}</span>`).join("")}</div>` : ""}
    </div>
    ${variables.length ? `<div class="example-values">
      <div class="example-values-head"><b>Valores de exemplo</b><small>Só para esta prévia — o template oficial não muda.</small></div>
      ${variables.map((variable) => {
        const preview = variablePreview(variable);
        return `<label class="example-value"><span>${escapeHtml(variable.label)}</span>
          <input data-example-key="${escapeHtml(variable.key)}" value="${escapeHtml(state.exampleValues[variable.key] || "")}" placeholder="${escapeHtml(preview.value || "Digite um valor de exemplo")}">
          <small class="${preview.value ? "" : "missing"}">${preview.value ? escapeHtml(preview.source) : "Variável sem valor de exemplo."}</small></label>`;
      }).join("")}
      ${missing.length ? `<p class="example-warning">${missing.length === 1 ? "1 variável está" : `${missing.length} variáveis estão`} sem valor de exemplo. Isso não invalida o template: mapeie a origem na etapa 4 ou digite um exemplo acima.</p>` : ""}
    </div>` : ""}`;
}

$("#template-selected").addEventListener("input", (event) => {
  const input = event.target.closest("[data-example-key]");
  if (!input) return;
  state.exampleValues[input.dataset.exampleKey] = input.value;
  // Atualiza só a bolha e as dicas, sem recriar o campo em edição.
  const template = selectedTemplate();
  const variables = template?.variables || [];
  $("#template-selected .wa-body").innerHTML = renderWhatsappText(templateBodyText(template), variables);
  const header = templateComponent(template, "HEADER");
  if (header?.text && $("#template-selected .wa-header")) $("#template-selected .wa-header").innerHTML = renderWhatsappText(header.text, variables);
  for (const variable of variables) {
    const hint = document.querySelector(`[data-example-key="${CSS.escape(variable.key)}"] + small`);
    const preview = variablePreview(variable);
    if (hint) { hint.textContent = preview.value ? preview.source : "Variável sem valor de exemplo."; hint.classList.toggle("missing", !preview.value); }
  }
});
$("#template-selected").addEventListener("click", (event) => {
  const edit = event.target.closest("[data-edit-routing]");
  if (!edit) return;
  const [name, language] = JSON.parse(decodeURIComponent(edit.dataset.editRouting));
  openRoutingModal(name, language, edit);
});

// ===== Destino automático do atendimento (categoria interna fixa) =====
// Categoria Meta (MARKETING/UTILITY/AUTHENTICATION) é da Meta: cobrança e
// aprovação. A categoria do atendimento é interna da Central e só define em
// que setor nasce o novo atendimento aberto por este template.
const routingStateLabels = { ACTIVE: "Ativado", DISABLED: "Desativado", INVALID: "Inválido", TEMPLATE_UNAVAILABLE: "Template indisponível" };
const metaCategoryLabels = { MARKETING: "Marketing", UTILITY: "Utilidade", AUTHENTICATION: "Autenticação" };

function templateRoutingBlock(template) {
  const routing = template.routing;
  const canEdit = state.routingCanEdit && (routing || template.status === "APPROVED");
  const key = encodeURIComponent(JSON.stringify([template.name, template.language]));
  return `<section class="template-routing" aria-label="Destino automático do atendimento">
    <dl>
      <div><dt>Template</dt><dd>${escapeHtml(template.name)} (${escapeHtml(template.language)})</dd></div>
      <div><dt>Categoria do atendimento</dt><dd>${escapeHtml(routing?.categoryName || "Sem destino fixo")}${routing?.protected ? " 🔒" : ""}</dd></div>
      <div><dt>Subcategoria</dt><dd>${escapeHtml(routing?.subcategoryName || "—")}</dd></div>
      <div><dt>Roteamento</dt><dd><span class="routing-state ${escapeHtml(routing?.state || "NONE")}">${escapeHtml(routing ? routingStateLabels[routing.state] || routing.state : "Não configurado")}</span></dd></div>
    </dl>
    ${routing?.issue ? `<p class="routing-issue">${escapeHtml(routing.issue)}</p>` : ""}
    ${canEdit ? `<button type="button" class="template-card-edit" data-edit-routing="${key}">Editar destino</button>` : ""}
  </section>`;
}

function findRoutingTarget(name, language) {
  const template = state.templates.find((item) => item.name === name && item.language === language);
  if (template) return template;
  const route = (state.routingOrphans || []).find((item) => item.templateName === name && item.templateLanguage === language);
  return route ? { name, language, category: null, status: null, routing: route } : null;
}

function fillRoutingSubcategories(selectedId = "") {
  const category = (state.routingOptions?.categories || []).find((item) => item.id === $("#routing-category").value);
  const subcategories = category?.subcategories || [];
  $("#routing-subcategory").innerHTML = `<option value="">${category ? "Sem subcategoria" : "Selecione a categoria primeiro"}</option>${subcategories.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")}`;
  $("#routing-subcategory").disabled = !subcategories.length;
  $("#routing-subcategory").value = subcategories.some((item) => item.id === selectedId) ? selectedId : "";
  $("#routing-subcategory-hint").textContent = !category ? "Selecione a categoria primeiro." : subcategories.length ? "Opcional. Só aparecem subcategorias desta categoria." : "Esta categoria não tem subcategorias ativas.";
  $("#routing-protected-note").hidden = !category?.protected;
}

const routingDialog = $("#template-routing-modal");
const routingUi = { saving: false, opening: false, trigger: null };

function setRoutingError(message = "") {
  $("#routing-error").textContent = message;
  $("#routing-error").hidden = !message;
}

// Um clique abre o modal na hora (com "Carregando…"); as opções chegam em
// seguida. Cliques repetidos enquanto abre são ignorados.
async function openRoutingModal(name, language, trigger = null) {
  const template = findRoutingTarget(name, language);
  if (!template || !state.templatesAccountId || routingUi.opening || routingDialog.open) return;
  routingUi.opening = true;
  routingUi.trigger = trigger;
  const editing = { name, language, channelAccountId: state.templatesAccountId };
  state.routingEditing = editing;
  const routing = template.routing;
  const accountName = state.accounts.find((account) => account.id === state.templatesAccountId)?.name || "número selecionado";
  $("#routing-template-title").textContent = name;
  $("#routing-template-meta").textContent = `Idioma ${language} · WABA de ${accountName}${template.category ? ` · Categoria Meta: ${metaCategoryLabels[template.category] || template.category}` : " · Template indisponível na Meta"}`;
  $("#routing-current").textContent = routing
    ? `Atual: ${routing.categoryName || "—"}${routing.subcategoryName ? ` → ${routing.subcategoryName}` : ""} · ${routingStateLabels[routing.state] || routing.state}${routing.updatedBy ? ` · alterado por ${routing.updatedBy}` : ""}`
    : "Atual: sem destino fixo (vale a regra do número ou a triagem).";
  $("#routing-category").innerHTML = `<option value="">Carregando…</option>`;
  $("#routing-category").disabled = true;
  $("#routing-subcategory").disabled = true;
  $("#save-template-routing").disabled = true;
  $("#routing-loading").hidden = false;
  $("#routing-history").hidden = true;
  $("#routing-history").innerHTML = "";
  $("#show-routing-history").textContent = "Ver histórico";
  setRoutingError();
  routingDialog.showModal();
  try {
    const options = await api(`/api/template-routing/options?channelAccountId=${encodeURIComponent(editing.channelAccountId)}`);
    if (state.routingEditing !== editing || !routingDialog.open || state.templatesAccountId !== editing.channelAccountId) return;
    state.routingOptions = options;
    const categories = [...(state.routingOptions.categories || [])];
    // Destino atual com setor desativado: continua selecionável para poder
    // apenas desativar a regra (o backend recusa reativar setor inativo).
    if (routing && !categories.some((item) => item.id === routing.categoryId)) {
      categories.unshift({ id: routing.categoryId, name: `${routing.categoryName || "Categoria atual"} (indisponível)`, protected: routing.protected,
        subcategories: routing.subcategoryId ? [{ id: routing.subcategoryId, name: `${routing.subcategoryName || "Subcategoria atual"} (indisponível)` }] : [] });
      state.routingOptions.categories = categories;
    }
    $("#routing-category").innerHTML = `<option value="">Selecione a categoria</option>${categories.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}${item.protected ? " 🔒" : ""}</option>`).join("")}`;
    $("#routing-category").value = categories.some((item) => item.id === routing?.categoryId) ? routing.categoryId : "";
    $("#routing-category").disabled = false;
    fillRoutingSubcategories(routing?.subcategoryId || "");
    $("#routing-enabled").checked = routing ? routing.enabled : true;
    $("#save-template-routing").disabled = false;
    $("#routing-category").focus();
  } catch (error) {
    if (state.routingEditing !== editing) return;
    setRoutingError(`Não foi possível carregar as categorias: ${error.message}`);
    $("#routing-category").innerHTML = `<option value="">Indisponível</option>`;
  } finally {
    if (state.routingEditing === editing) {
      routingUi.opening = false;
      $("#routing-loading").hidden = true;
    }
  }
}

function closeRoutingModal() {
  if (routingUi.saving) return;
  state.routingEditing = null;
  routingUi.opening = false;
  if (routingDialog.open) routingDialog.close();
}
routingDialog.addEventListener("close", () => {
  if (routingDialog.open) return;
  state.routingEditing = null;
  routingUi.opening = false;
  if (routingUi.trigger?.isConnected) routingUi.trigger.focus();
  routingUi.trigger = null;
});
// Esc: fecha, exceto durante o salvamento (o resultado precisa ser tratado).
routingDialog.addEventListener("cancel", (event) => { if (routingUi.saving) event.preventDefault(); });
routingDialog.addEventListener("click", (event) => { if (event.target === routingDialog) closeRoutingModal(); });
$("#close-template-routing").addEventListener("click", closeRoutingModal);
$("#cancel-template-routing").addEventListener("click", closeRoutingModal);
$("#routing-category").addEventListener("change", () => { setRoutingError(); fillRoutingSubcategories(); });

$("#template-routing-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.routingEditing || routingUi.saving) return;
  const categoryId = $("#routing-category").value;
  const subcategoryId = $("#routing-subcategory").value || null;
  const category = (state.routingOptions?.categories || []).find((item) => item.id === categoryId);
  if (!category) { setRoutingError("Selecione a categoria interna antes de salvar."); $("#routing-category").focus(); return; }
  if (subcategoryId && !(category.subcategories || []).some((item) => item.id === subcategoryId)) { setRoutingError("A subcategoria não pertence à categoria escolhida."); return; }
  const button = $("#save-template-routing");
  const editing = state.routingEditing;
  routingUi.saving = true;
  setRoutingError();
  button.disabled = true;
  button.textContent = "Salvando...";
  $("#cancel-template-routing").disabled = true;
  $("#close-template-routing").disabled = true;
  try {
    await api("/api/template-routing", { method: "PUT", body: JSON.stringify({
      channelAccountId: editing.channelAccountId, templateName: editing.name, templateLanguage: editing.language,
      categoryId, subcategoryId, enabled: $("#routing-enabled").checked,
    }) });
    routingUi.saving = false;
    closeRoutingModal();
    toast("Salvo com sucesso.");
    const previous = selectedTemplate();
    await ensureTemplatesLoaded({ keep: previous ? { name: previous.name, language: previous.language } : null });
  } catch (error) {
    setRoutingError(`Erro ao salvar: ${error.message}`);
  } finally {
    routingUi.saving = false;
    button.disabled = false;
    button.textContent = "Salvar configuração";
    $("#cancel-template-routing").disabled = false;
    $("#close-template-routing").disabled = false;
  }
});

$("#show-routing-history").addEventListener("click", (event) => {
  const box = $("#routing-history");
  if (!box.hidden) { box.hidden = true; event.currentTarget.textContent = "Ver histórico"; return; }
  const editing = state.routingEditing;
  if (!editing) return;
  const query = new URLSearchParams({ channelAccountId: editing.channelAccountId, templateName: editing.name, templateLanguage: editing.language });
  return withBusy(event.currentTarget, "Carregando...", async () => {
    try {
      const rows = await api(`/api/template-routing/history?${query}`);
      if (state.routingEditing !== editing || !routingDialog.open) return;
      box.innerHTML = rows.length
        ? rows.map((row) => `<p><b>${escapeHtml(new Date(row.createdAt).toLocaleString("pt-BR"))}</b> · ${escapeHtml(row.actorName || "Sistema")}<br>${escapeHtml(row.summary)}</p>`).join("")
        : `<p class="card-help">Nenhuma alteração registrada para este template.</p>`;
      box.hidden = false;
    } catch (error) { if (state.routingEditing === editing) setRoutingError(error.message); }
  }).then(() => { if (!box.hidden) $("#show-routing-history").textContent = "Ocultar histórico"; });
});

async function ensureCategoriesAndBotsLoaded() {
  try {
    state.categories = await api("/api/categories");
    $("#campaign-reply-category").innerHTML = `<option value="">Sem categoria automática</option>${state.categories.map((category) => (
      `<option value="${escapeHtml(category.id)}" data-company-id="${escapeHtml(category.companyId || "")}">${escapeHtml(category.name)}${category.company ? ` — ${escapeHtml(category.company.displayName)}` : ""}</option>`
    )).join("")}`;
  } catch { /* categorias são opcionais nesta tela */ }
  try {
    state.bots = await api("/api/bots");
    $("#campaign-reply-bot").innerHTML = `<option value="">Nenhum</option>${state.bots.map((bot) => (
      `<option value="${escapeHtml(bot.id)}" data-company-id="${escapeHtml(bot.companyId || "")}">${escapeHtml(bot.name)}${bot.company ? ` — ${escapeHtml(bot.company.displayName)}` : ""}</option>`
    )).join("")}`;
  } catch { /* bots são opcionais nesta tela */ }
}

// ===== Mapeamento de variáveis =====
// "Texto fixo…" ganha um campo próprio: antes o valor salvo era "static:"
// vazio e a variável seguia em branco no envio.
function renderVariableMapping(template, existingMapping) {
  const variables = Array.isArray(template?.variables) ? template.variables : [];
  const mapping = existingMapping || currentVariableMapping();
  if (!template || !variables.length) {
    $("#campaign-variables").innerHTML = `<p class="card-help">${template ? "Este template não tem variáveis." : "Selecione um template para mapear as variáveis."}</p>`;
    return;
  }
  $("#campaign-variables").innerHTML = variables.map((variable) => {
    const value = mapping[variable.key];
    const isStatic = typeof value === "string" && value.startsWith("static:");
    return `<div class="variable-mapping">
      <label><span>${escapeHtml(variable.label)}</span>
        <select data-variable-key="${escapeHtml(variable.key)}">
          <option value="">Usar exemplo da Meta (${escapeHtml(variable.example || "sem exemplo")})</option>
          ${Object.entries(MAPPING_LABELS).map(([field, label]) => `<option value="${field}" ${value === field ? "selected" : ""}>${label}</option>`).join("")}
          <option value="static:" ${isStatic ? "selected" : ""}>Texto fixo…</option>
        </select>
      </label>
      <label class="static-value" ${isStatic ? "" : "hidden"}><span>Texto fixo para {{${escapeHtml(variable.placeholder)}}}</span><input data-static-key="${escapeHtml(variable.key)}" maxlength="500" value="${escapeHtml(isStatic ? value.slice(7) : "")}" placeholder="Ex.: Equipe Comercial"></label>
    </div>`;
  }).join("");
}

$("#campaign-variables").addEventListener("change", (event) => {
  const select = event.target.closest("[data-variable-key]");
  if (!select) return;
  const field = select.closest(".variable-mapping").querySelector(".static-value");
  field.hidden = select.value !== "static:";
  if (!field.hidden) field.querySelector("input").focus();
  renderSelectedTemplate();
});
$("#campaign-variables").addEventListener("input", (event) => { if (event.target.matches("[data-static-key]")) renderSelectedTemplate(); });

// Correlaciona pelo `id` do template (valor real da <option>).
function selectedTemplate() {
  const id = $("#campaign-template").value || "";
  if (!id) return null;
  return (state.templates || []).find((template) => template.id === id) || null;
}

// Campanha salva guarda templateName/templateLanguage (o id da Meta muda se
// o template for recriado) — resolve de volta para o id atual.
function findTemplateOptionValue(name, language) {
  const found = (state.templates || []).find((template) => template.name === name && template.language === language && template.status === "APPROVED");
  return found ? found.id : "";
}

function currentVariableMapping() {
  const mapping = {};
  for (const select of document.querySelectorAll("[data-variable-key]")) {
    const key = select.dataset.variableKey;
    mapping[key] = select.value === "static:"
      ? `static:${document.querySelector(`[data-static-key="${CSS.escape(key)}"]`)?.value || ""}`
      : (select.value || undefined);
  }
  return mapping;
}

function renderReview() {
  const template = selectedTemplate();
  const variables = template?.variables || [];
  const mapping = currentVariableMapping();
  const missing = variables.filter((variable) => { const value = mapping[variable.key]; return value === "static:" || (!value && !variable.example); });
  const rows = [
    ["Campanha", $("#campaign-name").value.trim() || "Sem nome"],
    ["Empresa", $("#campaign-company").selectedOptions[0]?.textContent || "—"],
    ["Número de envio", $("#campaign-account").selectedOptions[0]?.textContent || "—"],
    ["Template", template ? `${template.name} (${template.language})` : "Nenhum selecionado"],
    ["Destino automático", template?.routing ? `${template.routing.categoryName || "—"}${template.routing.subcategoryName ? ` → ${template.routing.subcategoryName}` : ""} · ${routingStateLabels[template.routing.state] || template.routing.state}` : "Sem destino fixo"],
    ["Variáveis", !variables.length ? "Nenhuma" : missing.length ? `${missing.length} sem valor definido` : "Todas com origem definida"],
  ];
  $("#campaign-review").innerHTML = rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
}
$("#campaign-name").addEventListener("input", renderReview);

// ===== Editor =====

function resetEditor() {
  $("#campaign-name").value = ""; $("#campaign-category").value = ""; $("#campaign-description").value = "";
  $("#campaign-template").value = ""; state.exampleValues = {};
  $("#campaign-reply-category").value = ""; $("#campaign-reply-bot").value = "";
  $("#campaign-test-phone").value = ""; $("#campaign-batch-size").value = "";
  $("#template-search").value = ""; state.templateSearch = ""; state.templateFilter = "APPROVED";
  $("#template-compat-warning").hidden = true;
  $("#campaign-preview").innerHTML = "<p>Selecione um template e mapeie as variáveis.</p>";
}

function fillEditor(campaign) {
  $("#campaign-name").value = campaign.name;
  $("#campaign-category").value = campaign.category || "";
  $("#campaign-description").value = campaign.description || "";
  $("#campaign-template").value = findTemplateOptionValue(campaign.templateName, campaign.templateLanguage);
  if (!$("#campaign-template").value && campaign.templateName && state.templatesAvailable) {
    showCompatWarning(`O template salvo “${campaign.templateName}” (${campaign.templateLanguage}) não está aprovado nesta WABA. Selecione outro antes de salvar.`);
  }
  state.exampleValues = {};
  renderTemplateCatalog();
  onTemplateChanged(campaign.variableMapping || {});
  $("#campaign-reply-category").value = campaign.replyCategoryId || "";
  $("#campaign-reply-bot").value = campaign.replyBotId || "";
  $("#campaign-test-phone").value = campaign.testPhone || "";
  $("#campaign-batch-size").value = campaign.batchSize || "";
  renderReview();
}

async function selectCampaign(id) {
  const seq = ++state.selectSeq;
  document.querySelectorAll("[data-campaign-id]").forEach((card) => card.classList.toggle("active", card.dataset.campaignId === id));
  $("#editor").setAttribute("aria-busy", "true");
  try {
    const campaign = await api(`/api/campaigns/${encodeURIComponent(id)}`);
    if (seq !== state.selectSeq) return;
    state.selected = campaign;
    $("#editor").dataset.creating = "false";
    // Empresa de campanha existente é fixa; templates do número dela.
    $("#campaign-company").disabled = true;
    resetEditor();
    showEditor();
    await applyCampaignCompany(campaign.companyId, campaign.channelAccountId || "");
    if (seq !== state.selectSeq) return;
    renderEditor();
    await Promise.all([loadMetrics(), loadContacts()]);
  } catch (error) {
    if (seq === state.selectSeq) { toast(error.message, true); renderCampaignList(); }
  } finally {
    if (seq === state.selectSeq) $("#editor").removeAttribute("aria-busy");
  }
}

function showEditor() {
  $("#empty-state").hidden = true;
  $("#editor").hidden = false;
}

function renderEditor() {
  const campaign = state.selected;
  $("#empty-state").hidden = Boolean(campaign) || $("#editor").dataset.creating === "true";
  $("#editor").hidden = !campaign && $("#editor").dataset.creating !== "true";
  if (!campaign) return;
  $("#editor").dataset.creating = "false";
  $("#editor-eyebrow").textContent = "CAMPANHA SELECIONADA";
  $("#editor-title").textContent = campaign.name;
  $("#editor-description").textContent = campaign.description || "Sem descrição.";
  $("#editor-started-at").innerHTML = campaignStartMarkup(campaign);
  $("#editor-started-at").hidden = !$("#editor-started-at").textContent;
  $("#status-actions").hidden = false;
  $("#status-badge").textContent = statusLabels[campaign.status];
  document.querySelectorAll(".requires-bot").forEach((element) => { element.hidden = false; });
  fillEditor(campaign);
  renderCampaignList();
}

function startNewCampaign() {
  state.selectSeq++;
  state.selected = null;
  $("#editor").dataset.creating = "true";
  showEditor();
  $("#editor-eyebrow").textContent = "NOVA CAMPANHA";
  $("#editor-title").textContent = "Criar campanha";
  $("#editor-description").textContent = "Siga as etapas: identidade, número, template, variáveis e revisão.";
  $("#editor-started-at").hidden = true;
  $("#status-actions").hidden = true;
  document.querySelectorAll(".requires-bot").forEach((element) => { element.hidden = true; });
  resetEditor();
  $("#campaign-company").disabled = false;
  const preferred = window.CompanyContext.companies.find((company) => company.slug === state.companyFilter);
  const onlyOption = $("#campaign-company").options.length === 1 ? $("#campaign-company").options[0].value : "";
  applyCampaignCompany(preferred?.id || onlyOption).catch((error) => toast(error.message, true));
  renderCampaignList();
  $("#campaign-name").focus();
}

$("#new-campaign").addEventListener("click", startNewCampaign);
$("#empty-new-campaign").addEventListener("click", startNewCampaign);
$("#campaign-status-filter").addEventListener("change", () => loadCampaigns());

$("#campaign-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (TEMPLATE_LIBRARY_MODE) return;
  const template = selectedTemplate();
  if (!$("#campaign-name").value.trim()) { toast("Informe o nome da campanha.", true); $("#campaign-name").focus(); return; }
  if (!$("#campaign-account").value) { toast("Selecione o número de envio.", true); $("#campaign-account").focus(); return; }
  if (!template) { toast("Selecione um template aprovado.", true); $("#template-catalog").scrollIntoView({ block: "center" }); return; }
  const mapping = currentVariableMapping();
  const emptyStatic = Object.entries(mapping).find(([, value]) => value === "static:");
  if (emptyStatic) { toast("Preencha o texto fixo da variável ou escolha outra origem.", true); document.querySelector(`[data-static-key="${CSS.escape(emptyStatic[0])}"]`)?.focus(); return; }
  const payload = {
    ...(state.selected ? {} : { companyId: $("#campaign-company").value || undefined }),
    channelAccountId: $("#campaign-account").value || undefined,
    name: $("#campaign-name").value,
    category: $("#campaign-category").value || null,
    description: $("#campaign-description").value || null,
    templateName: template.name, templateLanguage: template.language,
    variableMapping: mapping,
    replyCategoryId: $("#campaign-reply-category").value || null,
    replyBotId: $("#campaign-reply-bot").value || null,
    testPhone: $("#campaign-test-phone").value || null,
    batchSize: $("#campaign-batch-size").value || null,
  };
  withBusy($("#campaign-save-button"), "Salvando...", async () => {
    try {
      if (state.selected) {
        state.selected = await api(`/api/campaigns/${state.selected.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        toast("Campanha atualizada.");
      } else {
        state.selected = await api("/api/campaigns", { method: "POST", body: JSON.stringify(payload) });
        toast("Campanha criada como rascunho. Nenhuma mensagem foi enviada.");
      }
      await loadCampaigns();
      renderEditor();
    } catch (error) { toast(error.message, true); }
  }).finally(() => { $("#campaign-save-button").disabled = !state.templatesAvailable; });
});

$("#campaign-preview-button").addEventListener("click", (event) => {
  const template = selectedTemplate();
  if (!template) { toast("Selecione um template.", true); return; }
  $("#campaign-preview").innerHTML = `<p role="status"><span class="inline-spinner" aria-hidden="true"></span> Carregando preview...</p>`;
  withBusy(event.currentTarget, "Carregando...", async () => {
    try {
      const preview = await api("/api/campaign-templates/preview", {
        method: "POST",
        // Número/WABA explícito: sem ele o servidor buscava o template no número padrão.
        body: JSON.stringify({ templateName: template.name, templateLanguage: template.language, variableMapping: currentVariableMapping(), channelAccountId: $("#campaign-account").value || undefined, companyId: $("#campaign-company").value || undefined }),
      });
      const text = typeof preview?.renderedPreview === "string" ? preview.renderedPreview : "";
      $("#campaign-preview").innerHTML = text
        ? `<div class="wa-bubble standalone">${renderWhatsappText(text, [])}</div>`
        : `<p>Não foi possível montar o preview deste template.</p>`;
    } catch (error) {
      $("#campaign-preview").innerHTML = `<p>Não foi possível carregar o preview: ${escapeHtml(error.message)}</p>`;
    }
  });
});

// ===== Ações do ciclo de vida =====

function runCampaignAction(button, action, extra) {
  if (!state.selected) return;
  const buttons = [...document.querySelectorAll(".editor-actions button")];
  if (buttons.some((item) => item.dataset.busy === "true")) return;
  buttons.forEach((item) => { item.disabled = true; });
  withBusy(button, "Aguarde...", async () => {
    try {
      const campaignId=state.selected.id;
      if(['schedule','queue-now','resume'].includes(action)&&window.ContactWarning&&!(await window.ContactWarning.confirm({campaignId})))return;
      if(state.selected?.id!==campaignId)return;
      state.selected = await api(`/api/campaigns/${state.selected.id}/${action}`, { method: "POST", body: extra ? JSON.stringify(extra) : undefined });
      toast("Ação realizada.");
      await loadCampaigns();
      renderEditor();
    } catch (error) { toast(error.message, true); }
  }).finally(() => buttons.forEach((item) => { item.disabled = false; }));
}
$("#campaign-schedule").addEventListener("click", (event) => runCampaignAction(event.currentTarget, "schedule", { scheduledAt: $("#campaign-scheduled-at").value || null }));
$("#campaign-queue-now").addEventListener("click", (event) => runCampaignAction(event.currentTarget, "queue-now"));
$("#campaign-pause").addEventListener("click", (event) => runCampaignAction(event.currentTarget, "pause"));
$("#campaign-resume").addEventListener("click", (event) => runCampaignAction(event.currentTarget, "resume"));
$("#campaign-cancel").addEventListener("click", (event) => { if (confirm("Cancelar esta campanha? Os contatos ainda não enviados serão ignorados.")) runCampaignAction(event.currentTarget, "cancel"); });
$("#campaign-send-test").addEventListener("click", (event) => {
  if (!state.selected) return;
  withBusy(event.currentTarget, "Enviando...", async () => {
    try {
      await api(`/api/campaigns/${state.selected.id}/send-test`, { method: "POST" });
      toast("Mensagem de teste enviada — não conta como campanha real.");
    } catch (error) { toast(error.message, true); }
  });
});

// ===== Importação =====

$("#import-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file || !state.selected) return;
  state.importFileName = file.name;
  state.importCsvText = await file.text();
  const form = new FormData();
  form.append("file", file);
  try {
    const preview = await api(`/api/campaigns/${state.selected.id}/import/parse`, { method: "POST", body: form });
    state.importHeaders = preview.headers;
    $("#import-mapping").hidden = false;
    $("#import-mapping-fields").innerHTML = ["phone", "firstName", "fullName", "email", "companyName", "document", "city", "state", "source", "tags", "notes"].map((field) => `
      <label><span>${escapeHtml(field)}${field === "phone" ? " *" : ""}</span>
        <select data-import-field="${field}">
          <option value="">Não importar</option>
          ${preview.headers.map((header, index) => `<option value="${index}">${escapeHtml(header)}</option>`).join("")}
        </select>
      </label>
    `).join("");
    $("#import-summary").innerHTML = "";
    $("#import-commit").hidden = true;
    $("#import-download-errors").hidden = true;
  } catch (error) { toast(error.message, true); }
});

function currentImportMapping() {
  const mapping = {};
  for (const select of document.querySelectorAll("[data-import-field]")) {
    if (select.value !== "") mapping[select.dataset.importField] = select.value;
  }
  return mapping;
}

$("#import-validate").addEventListener("click", (event) => {
  if (!state.selected) return;
  const mapping = currentImportMapping();
  if (!mapping.phone) { toast("Mapeie a coluna de telefone (obrigatória).", true); return; }
  withBusy(event.currentTarget, "Validando...", async () => {
    try {
      const result = await api(`/api/campaigns/${state.selected.id}/import/validate`, {
        method: "POST", body: JSON.stringify({ csvText: state.importCsvText, mapping }),
      });
      state.importErrors = result.errors || [];
      $("#import-summary").innerHTML = [
        metricTile(result.totalRows, "Total"), metricTile(result.validRows, "Válidas"),
        metricTile(result.invalidRows, "Inválidas"), metricTile(result.duplicateRows, "Duplicadas"),
        metricTile(result.optOutRows, "Opt-out"), metricTile(result.alreadyInCampaignRows, "Já na campanha"),
      ].join("");
      $("#import-commit").hidden = result.validRows === 0;
      $("#import-download-errors").hidden = !state.importErrors.length;
    } catch (error) { toast(error.message, true); }
  });
});

$("#import-commit").addEventListener("click", (event) => {
  if (!state.selected) return;
  withBusy(event.currentTarget, "Importando...", async () => {
    try {
      const mapping = currentImportMapping();
      const result = await api(`/api/campaigns/${state.selected.id}/import/commit`, {
        method: "POST", body: JSON.stringify({ csvText: state.importCsvText, mapping, fileName: state.importFileName }),
      });
      toast(`${result.validRows} contato(s) importado(s).`);
      $("#import-file").value = "";
      $("#import-mapping").hidden = true;
      await selectCampaign(state.selected.id);
    } catch (error) { toast(error.message, true); }
  });
});

$("#import-download-errors").addEventListener("click", () => {
  const header = "linha,motivo,valor\n";
  const rows = state.importErrors.map((error) => `${error.row},${error.reason},"${(error.value || "").replace(/"/g, '""')}"`).join("\n");
  const blob = new Blob([header + rows], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = "erros-importacao.csv"; link.click();
  URL.revokeObjectURL(url);
});

// ===== Segmentação/público =====

$("#estimate-audience").addEventListener("click", (event) => {
  if (!state.selected) return;
  const filters = {
    city: $("#segment-city").value || undefined, state: $("#segment-state").value || undefined,
    companyName: $("#segment-company").value || undefined, source: $("#segment-source").value || undefined,
  };
  withBusy(event.currentTarget, "Estimando...", async () => {
    try {
      const result = await api(`/api/campaigns/${state.selected.id}/estimate-audience`, { method: "POST", body: JSON.stringify(filters) });
      $("#audience-result").innerHTML = metricTile(result.count, "Contatos elegíveis");
    } catch (error) { toast(error.message, true); }
  });
});

// ===== Métricas e destinatários =====

async function loadMetrics() {
  if (!state.selected) return;
  try {
    const metrics = await api(`/api/campaigns/${state.selected.id}/metrics`);
    $("#campaign-metrics").innerHTML = [
      metricTile(metrics.total, "Total"), metricTile(metrics.eligible, "Elegíveis"), metricTile(metrics.queued, "Na fila"),
      metricTile(metrics.sent, "Enviados"), metricTile(metrics.delivered, "Entregues"), metricTile(metrics.read, "Lidos"),
      metricTile(metrics.replied, "Responderam"), metricTile(metrics.failed, "Falharam"), metricTile(metrics.optOut, "Opt-out"),
      metricTile(metrics.deliveryRate != null ? `${metrics.deliveryRate}%` : "-", "Taxa de entrega"),
      metricTile(metrics.readRate != null ? `${metrics.readRate}%` : "-", "Taxa de leitura"),
      metricTile(metrics.replyRate != null ? `${metrics.replyRate}%` : "-", "Taxa de resposta"),
    ].join("");
  } catch (error) { $("#campaign-metrics").innerHTML = `<p class="card-help">Métricas indisponíveis: ${escapeHtml(error.message)}</p>`; }
}
$("#refresh-metrics").addEventListener("click", (event) => withBusy(event.currentTarget, "Atualizando...", loadMetrics));

async function loadContacts() {
  if (!state.selected) return;
  const status = $("#contacts-status-filter").value;
  try {
    const result = await api(`/api/campaigns/${state.selected.id}/contacts?${status ? `status=${status}&` : ""}limit=50`);
    $("#contacts-body").innerHTML = result.rows.length ? result.rows.map((row) => `
      <tr><td>${escapeHtml(row.phone)}</td><td>${escapeHtml(row.fullName || row.firstName || "-")}</td>
      <td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.prospectStatus)}</td>
      <td>${row.sentAt ? new Date(row.sentAt).toLocaleString("pt-BR") : "-"}</td>
      <td>${escapeHtml(row.failureReason || "-")}</td></tr>
    `).join("") : `<tr><td colspan="6">Nenhum contato.</td></tr>`;
  } catch (error) { $("#contacts-body").innerHTML = `<tr><td colspan="6">Não foi possível carregar os contatos: ${escapeHtml(error.message)}</td></tr>`; }
}
$("#contacts-status-filter").addEventListener("change", loadContacts);
$("#export-contacts").addEventListener("click", () => {
  if (!state.selected) return;
  const status = $("#contacts-status-filter").value;
  const map = { PENDING: "all", SENT: "sent", DELIVERED: "delivered", READ: "read", REPLIED: "replied", FAILED: "failed", OPTED_OUT: "optOut", SKIPPED: "all" };
  window.open(`/api/campaigns/${state.selected.id}/export?filter=${map[status] || "all"}`, "_blank");
});

// ===== Modais de configurações e opt-out =====
// Esc fecha o modal aberto (exceto durante um salvamento em andamento).
function openModal(id) { $(id).hidden = false; $(id).querySelector("button, input, select")?.focus(); }
function closeModal(id) { if ($(id).dataset.saving !== "true") $(id).hidden = true; }
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const id of ["#settings-modal", "#optouts-modal"]) if (!$(id).hidden) closeModal(id);
});
for (const id of ["#settings-modal", "#optouts-modal"]) $(id).addEventListener("click", (event) => { if (event.target === $(id)) closeModal(id); });

$("#campaign-settings-button").addEventListener("click", (event) => {
  withBusy(event.currentTarget, "Abrindo...", async () => {
    try {
      const settings = await api("/api/campaign-settings");
      $("#setting-mass-enabled").checked = settings.massMessagingEnabled;
      $("#setting-allow-scheduling").checked = settings.allowScheduling;
      $("#setting-allow-imports").checked = settings.allowImports;
      $("#setting-max-recipients").value = settings.maxCampaignRecipients;
      $("#setting-batch-size").value = settings.defaultBatchSize;
      $("#setting-delay").value = settings.defaultDelayBetweenBatchesSeconds;
      $("#setting-max-retries").value = settings.defaultMaxRetries;
      openModal("#settings-modal");
    } catch (error) { toast(error.message, true); }
  });
});
$("#close-settings").addEventListener("click", () => closeModal("#settings-modal"));
$("#save-settings").addEventListener("click", (event) => {
  $("#settings-modal").dataset.saving = "true";
  withBusy(event.currentTarget, "Salvando...", async () => {
    try {
      await api("/api/campaign-settings", { method: "PATCH", body: JSON.stringify({
        massMessagingEnabled: $("#setting-mass-enabled").checked,
        allowScheduling: $("#setting-allow-scheduling").checked,
        allowImports: $("#setting-allow-imports").checked,
        maxCampaignRecipients: Number($("#setting-max-recipients").value),
        defaultBatchSize: Number($("#setting-batch-size").value),
        defaultDelayBetweenBatchesSeconds: Number($("#setting-delay").value),
        defaultMaxRetries: Number($("#setting-max-retries").value),
      }) });
      toast("Configurações salvas.");
      $("#settings-modal").dataset.saving = "false";
      closeModal("#settings-modal");
    } catch (error) { toast(error.message, true); }
    finally { $("#settings-modal").dataset.saving = "false"; }
  });
});

async function loadOptOuts() {
  const rows = await api("/api/campaign-opt-outs?active=true");
  $("#optouts-list").innerHTML = `<table class="observations-table"><thead><tr><th>Telefone</th><th>Origem</th><th>Data</th><th></th></tr></thead><tbody>${
    rows.length ? rows.map((row) => `
      <tr><td>${escapeHtml(row.phone)}</td><td>${escapeHtml(row.source)}</td>
      <td>${new Date(row.createdAt).toLocaleDateString("pt-BR")}</td>
      <td><button type="button" data-remove-optout="${escapeHtml(row.phone)}">Remover</button></td></tr>
    `).join("") : '<tr><td colspan="4">Nenhum opt-out ativo.</td></tr>'
  }</tbody></table>`;
}
$("#campaign-optouts-button").addEventListener("click", (event) => {
  withBusy(event.currentTarget, "Abrindo...", async () => {
    try { await loadOptOuts(); openModal("#optouts-modal"); }
    catch (error) { toast(error.message, true); }
  });
});
$("#optouts-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-optout]");
  if (!button) return;
  const reason = prompt("Motivo da remoção do opt-out:");
  if (!reason) return;
  withBusy(button, "Removendo...", async () => {
    try {
      await api(`/api/campaign-opt-outs/${button.dataset.removeOptout}/remove`, { method: "POST", body: JSON.stringify({ reason }) });
      toast("Opt-out removido.");
      await loadOptOuts();
    } catch (error) { toast(error.message, true); }
  });
});
$("#close-optouts").addEventListener("click", () => closeModal("#optouts-modal"));

// ===== Boot =====

$("#theme-toggle").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try { localStorage.setItem("mibro-theme", dark ? "dark" : "light"); } catch { /* ignore */ }
  $("#theme-toggle").textContent = dark ? "☾" : "☀";
});
$("#logout").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.href = "/login.html";
});

// Carga inicial automática: lista de campanhas, números, setores e Bots.
// Os templates só carregam quando o editor abre (dependem do número).
function configureTemplateLibrary() {
  document.title = "Templates • Central de Atendimento";
  document.body.classList.add("template-library-page");
  document.querySelector(".brand small").textContent = "Templates";
  document.querySelector(".phase-badge").textContent = "WHATSAPP • TEMPLATES";
  document.querySelector(".sidebar-heading h1").textContent = "Templates";
  $("#campaign-count").textContent = "Escolha a empresa e o número";
  $("#templates-library-link").textContent = "📣 Campanhas";
  $("#templates-library-link").href = "/campaigns";
  for (const selector of ["#new-campaign", "#campaign-status-filter", "#campaign-list", "#campaign-settings-button", "#campaign-optouts-button", ".safety-note"]) $(selector).hidden = true;
  // Reaproveita os seletores reais: a conta continua explícita em cada API.
  const origin = $("#campaign-company").closest(".fields");
  origin.className = "fields template-library-origin";
  document.querySelector(".bots-sidebar").insertBefore(origin, $("#campaign-list"));
  for (const step of document.querySelectorAll(".campaign-step")) step.hidden = !step.classList.contains("template-step");
  for (const section of document.querySelectorAll(".requires-bot")) section.hidden = true;
  document.querySelector(".template-step .step-number").hidden = true;
  $("#template-step-title").textContent = "Biblioteca de templates";
  $("#editor-eyebrow").textContent = "WHATSAPP • META";
  $("#editor-title").textContent = "Templates e destinos automáticos";
  $("#editor-description").textContent = "Consulte os templates de cada número e configure a categoria interna de destino. Nenhuma mensagem é enviada nesta tela.";
  state.templateFilter = "ALL";
  $("#editor").dataset.creating = "true";
  showEditor();
}
(async function boot() {
  if (TEMPLATE_LIBRARY_MODE) configureTemplateLibrary();
  try {
    const status = await api("/api/auth/status");
    $("#current-user").textContent = status.user.name;
  } catch (error) { toast(error.message, true); }
  if (TEMPLATE_LIBRARY_MODE) {
    try {
      await loadCampaignAccounts();
      const companyId = $("#campaign-company").value || state.accounts[0]?.companyId || "";
      const accountId = state.accounts.find((account) => account.companyId === companyId)?.id || "";
      await applyCampaignCompany(companyId, accountId);
    } catch (error) { toast(error.message, true); }
    return;
  }
  await Promise.all([
    loadCampaignAccounts().catch((error) => toast(error.message, true)),
    ensureCategoriesAndBotsLoaded(),
  ]);
  await loadCampaigns();
})();
