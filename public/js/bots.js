// Tela de Bots (Flow Builder como único modelo). O Bot aqui é só identidade,
// canais, horário, status e o interruptor de resposta automática — todo o
// comportamento é montado no Editor Visual (/flow-builder). Também gerencia
// a biblioteca "Respostas do Bot", os endpoints do nó Webhook/API e mostra
// (somente leitura) os Bots antigos arquivados.
const MARKETPLACE_UI_ENABLED = window.MIBRO_FEATURES?.marketplaces !== false;
const isMarketplaceChannel = (channel) => window.isMarketplaceFeatureChannel?.(channel) === true;

const $ = (selector, root = document) => root.querySelector(selector);
const state = {
  bots: [], selected: null, settings: null,
  responses: [], editingResponseId: null,
  webhooks: [], editingWebhookId: null,
  legacyLoaded: false,
};
const STATUS_LABELS = { ACTIVE: "ATIVO", PAUSED: "PAUSADO", DRAFT: "RASCUNHO" };
const FLOW_STATUS_LABELS = { DRAFT: "rascunho", ACTIVE: "ativo", INACTIVE: "inativo" };
const RESPONSE_CATEGORIES = ["GERAL", "ATENDIMENTO", "SUPORTE", "COMERCIAL", "GARANTIA", "PEDIDOS", "MARKETING", "PARCERIAS"];
const CHANNEL_LABELS = {
  META: "WhatsApp", INSTAGRAM_DIRECT: "Instagram Direct", FACEBOOK_MESSENGER: "Facebook Messenger", EMAIL: "E-mail",
  INSTAGRAM_COMMENTS: "Instagram Comentários", FACEBOOK_COMMENTS: "Facebook Comentários",
  MERCADO_LIVRE: "Mercado Livre", TIKTOK_SHOP: "TikTok Shop", AMAZON_MARKETPLACE: "Amazon", SHOPEE: "Shopee",
  SHEIN_MARKETPLACE: "SHEIN", GOOGLE_REVIEWS: "Google Reviews", RECLAME_AQUI: "Reclame Aqui",
};
const DAY_NAMES = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

// ---------- utilidades --------------------------------------------------------
async function api(url, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}) };
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) { location.replace("/login.html"); throw new Error("Sessão encerrada."); }
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || "Não foi possível concluir a operação.");
  return body;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = "toast"; }, 3600);
}
const visibleChannels = () => Object.keys(CHANNEL_LABELS).filter((channel) => MARKETPLACE_UI_ENABLED || !isMarketplaceChannel(channel));
function channelChecklist(container, selected) {
  container.innerHTML = visibleChannels().map((channel) => `
    <label class="checkbox"><input type="checkbox" value="${channel}" ${selected.includes(channel) ? "checked" : ""}><span>${escapeHtml(CHANNEL_LABELS[channel])}${channel === "META" ? " <small>(responde automaticamente)</small>" : ""}</span></label>`).join("");
}
const checkedValues = (container) => [...container.querySelectorAll("input:checked")].map((input) => input.value);
const editorUrl = (botId, flowId) => `/flow-builder?botId=${encodeURIComponent(botId)}${flowId ? `&flowId=${encodeURIComponent(flowId)}` : ""}`;

// ---------- abas ------------------------------------------------------------------
function showTab(name) {
  document.querySelectorAll(".tab-button").forEach((button) => button.classList.toggle("active", button.dataset.tab === name));
  document.querySelectorAll("[data-panel]").forEach((panel) => { panel.hidden = panel.dataset.panel !== name; });
  if (name === "responses") loadResponses();
  if (name === "webhooks") loadWebhooks();
  if (name === "legacy" && !state.legacyLoaded) loadLegacy();
}
$(".workspace-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-tab]");
  if (button) showTab(button.dataset.tab);
});

// ---------- lista de Bots ------------------------------------------------------------
function renderBotList() {
  $("#bot-count").textContent = `${state.bots.length} Bot(s)`;
  $("#bot-list").innerHTML = state.bots.length ? state.bots.map((bot) => `
    <button type="button" class="bot-card ${state.selected?.id === bot.id ? "active" : ""}" data-bot="${escapeHtml(bot.id)}">
      <header><b>${escapeHtml(bot.name)}</b><span class="mini-status ${bot.status}">${STATUS_LABELS[bot.status] || bot.status}</span></header>
      <small>${escapeHtml(bot.channels.map((channel) => CHANNEL_LABELS[channel] || channel).join(", "))}</small>
      <div class="bot-meta">${bot.flows.length} fluxo(s) • ${bot.autoReplyEnabled ? "respondendo clientes" : "resposta automática desligada"}${bot.isSystem ? " • sistema" : ""}</div>
    </button>`).join("") : '<div class="intent-empty">Nenhum Bot ainda.</div>';
}
$("#bot-list").addEventListener("click", (event) => {
  const card = event.target.closest("[data-bot]");
  if (card) selectBot(card.dataset.bot);
});

async function loadBots(selectId) {
  state.bots = await api("/api/bots");
  renderBotList();
  const target = selectId || state.selected?.id || state.bots[0]?.id;
  if (target && state.bots.some((bot) => bot.id === target)) await selectBot(target);
  else { state.selected = null; $("#editor").hidden = true; $("#empty-state").hidden = false; }
}

async function selectBot(botId) {
  state.selected = await api(`/api/bots/${encodeURIComponent(botId)}`);
  renderBotList();
  renderEditor();
  showTab("bot");
}

// ---------- editor do Bot ------------------------------------------------------------
function renderEditor() {
  const bot = state.selected;
  $("#empty-state").hidden = true;
  $("#editor").hidden = false;
  $("#editor-title").textContent = bot.name;
  $("#editor-description").textContent = bot.description || "Sem descrição.";
  $("#system-bot-badge").hidden = !bot.isSystem;
  $("#status-badge").textContent = STATUS_LABELS[bot.status] || bot.status;
  $("#status-badge").className = `status-badge ${bot.status}`;
  $("#toggle-status").textContent = bot.status === "ACTIVE" ? "Pausar Bot" : "Ativar Bot";
  $("#open-flow-builder").href = editorUrl(bot.id, bot.defaultFlowId);
  $("#delete-bot").hidden = bot.isSystem;

  $("#auto-reply").checked = bot.autoReplyEnabled;
  $("#auto-reply-label").textContent = bot.autoReplyEnabled ? "Ligada — o fluxo padrão responde clientes" : "Desligada — nenhuma mensagem é enviada a clientes";
  const automationOff = state.settings && !state.settings.automationEnabled;
  $("#auto-reply-help").innerHTML = [
    bot.readyToRespond ? "" : "Para ligar, publique e ative o <b>fluxo padrão</b> no Editor Visual.",
    bot.status !== "ACTIVE" ? "O Bot está pausado: mesmo ligada, a resposta automática não roda." : "",
    automationOff ? "A automação geral dos Bots está DESLIGADA (barra lateral)." : "",
    "Teste sempre no simulador do Editor Visual antes de ligar.",
  ].filter(Boolean).join(" ");

  $("#flow-list").innerHTML = bot.flows.length ? bot.flows.map((flow) => `
    <div class="flow-row">
      <div><b>${escapeHtml(flow.name)}</b>${flow.isDefault ? ' <span class="mini-status ACTIVE">PADRÃO</span>' : ""}
        <small>${FLOW_STATUS_LABELS[flow.status] || flow.status} • ${flow.activeVersion ? `versão publicada v${flow.activeVersion}` : "nunca publicado"}</small></div>
      <div class="flow-row-actions">
        ${flow.isDefault ? "" : `<button type="button" data-default-flow="${escapeHtml(flow.id)}">Tornar padrão</button>`}
        <a class="flow-builder-link" href="${editorUrl(bot.id, flow.id)}">Editar</a>
      </div>
    </div>`).join("") : '<p class="card-help">Nenhum fluxo.</p>';

  $("#bot-name").value = bot.name;
  $("#bot-description").value = bot.description || "";
  $("#bot-timezone").value = bot.timezone || "America/Sao_Paulo";
  channelChecklist($("#bot-channels"), bot.channels);
  renderSchedules();
  renderHolidays();
}

function renderSchedules() {
  const byDay = new Map((state.selected.schedules || []).map((item) => [item.dayOfWeek, item]));
  $("#schedule-list").innerHTML = DAY_NAMES.map((name, day) => {
    const item = byDay.get(day) || { enabled: false, startTime: "08:00", endTime: "17:00" };
    return `<div class="schedule-row" data-day="${day}"><input type="checkbox" ${item.enabled ? "checked" : ""} aria-label="${name}"><b>${name}</b>
      <input type="time" value="${item.startTime}" aria-label="Início"><input type="time" value="${item.endTime}" aria-label="Fim"></div>`;
  }).join("");
}

function renderHolidays() {
  const holidays = state.selected.holidays || [];
  $("#holiday-list").innerHTML = holidays.length ? holidays.map((holiday, index) => `
    <div class="holiday-row ${holiday.enabled ? "" : "inactive"}"><time>${holiday.date.split("-").reverse().join("/")}</time>
      <div><b>${escapeHtml(holiday.name)}</b></div><button type="button" data-remove-holiday="${index}">Remover</button></div>`).join("")
    : '<p class="card-help">Nenhum feriado cadastrado.</p>';
}

async function refreshSelected(updated) {
  state.selected = updated;
  const index = state.bots.findIndex((bot) => bot.id === updated.id);
  if (index >= 0) state.bots[index] = updated;
  renderBotList();
  renderEditor();
}

$("#toggle-status").addEventListener("click", async () => {
  const next = state.selected.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
  try { await refreshSelected(await api(`/api/bots/${state.selected.id}/status`, { method: "PATCH", body: JSON.stringify({ status: next }) })); toast(next === "ACTIVE" ? "Bot ativado." : "Bot pausado."); }
  catch (error) { toast(error.message, true); }
});

$("#auto-reply").addEventListener("change", async (event) => {
  const enabled = event.target.checked;
  if (enabled && !window.confirm(`Ligar a resposta automática do Bot "${state.selected.name}"?\n\nA partir de agora o fluxo padrão publicado responde clientes reais no WhatsApp.`)) {
    event.target.checked = false;
    return;
  }
  try { await refreshSelected(await api(`/api/bots/${state.selected.id}/auto-reply`, { method: "PATCH", body: JSON.stringify({ enabled }) })); toast(enabled ? "Resposta automática ligada." : "Resposta automática desligada."); }
  catch (error) { event.target.checked = !enabled; toast(error.message, true); }
});

$("#bot-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await refreshSelected(await api(`/api/bots/${state.selected.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: $("#bot-name").value, description: $("#bot-description").value, timezone: $("#bot-timezone").value, channels: checkedValues($("#bot-channels")) }),
    }));
    toast("Bot salvo.");
  } catch (error) { toast(error.message, true); }
});

$("#delete-bot").addEventListener("click", async () => {
  if (!window.confirm(`Excluir o Bot "${state.selected.name}"? Ele para de responder e sai da lista (o histórico é mantido).`)) return;
  try { await api(`/api/bots/${state.selected.id}`, { method: "DELETE" }); state.selected = null; await loadBots(); toast("Bot excluído."); }
  catch (error) { toast(error.message, true); }
});

$("#save-schedules").addEventListener("click", async () => {
  const schedules = [...document.querySelectorAll(".schedule-row")].map((row) => {
    const [enabled, start, end] = row.querySelectorAll("input");
    return { dayOfWeek: Number(row.dataset.day), enabled: enabled.checked, startTime: start.value, endTime: end.value };
  });
  try { await refreshSelected(await api(`/api/bots/${state.selected.id}/schedules`, { method: "PUT", body: JSON.stringify({ schedules }) })); toast("Horários salvos."); }
  catch (error) { toast(error.message, true); }
});

async function saveHolidays(holidays) {
  await refreshSelected(await api(`/api/bots/${state.selected.id}/holidays`, {
    method: "PUT", body: JSON.stringify({ holidays: holidays.map(({ date, name, enabled }) => ({ date, name, enabled })) }),
  }));
}
$("#holiday-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await saveHolidays([...(state.selected.holidays || []), { date: $("#holiday-date").value, name: $("#holiday-name").value, enabled: true }]);
    event.target.reset();
    toast("Feriado adicionado.");
  } catch (error) { toast(error.message, true); }
});
$("#holiday-list").addEventListener("click", async (event) => {
  const index = event.target.closest("[data-remove-holiday]")?.dataset.removeHoliday;
  if (index === undefined) return;
  try { await saveHolidays(state.selected.holidays.filter((_item, position) => position !== Number(index))); toast("Feriado removido."); }
  catch (error) { toast(error.message, true); }
});

$("#flow-list").addEventListener("click", async (event) => {
  const flowId = event.target.closest("[data-default-flow]")?.dataset.defaultFlow;
  if (!flowId) return;
  try {
    await api(`/api/bots/${state.selected.id}/visual-flows/${encodeURIComponent(flowId)}/default`, { method: "POST", body: "{}" });
    await refreshSelected(await api(`/api/bots/${state.selected.id}`));
    toast("Fluxo padrão alterado.");
  } catch (error) { toast(error.message, true); }
});
$("#new-flow").addEventListener("click", async () => {
  const name = window.prompt("Nome do novo fluxo (ex.: Suporte, Comercial, Garantia):", "");
  if (!name?.trim()) return;
  try {
    const flow = await api(`/api/bots/${state.selected.id}/visual-flows`, { method: "POST", body: JSON.stringify({ name }) });
    location.href = editorUrl(state.selected.id, flow.id);
  } catch (error) { toast(error.message, true); }
});

// ---------- Novo Bot -> Editor Visual ----------------------------------------------
function openNewBot() {
  $("#new-bot-form").reset();
  channelChecklist($("#new-bot-channels"), ["META"]);
  $("#new-bot-dialog").showModal();
  $("#new-bot-name").focus();
}
$("#new-bot").addEventListener("click", openNewBot);
$("#empty-new-bot").addEventListener("click", openNewBot);
$("#cancel-new-bot").addEventListener("click", () => $("#new-bot-dialog").close());
$("#new-bot-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const bot = await api("/api/bots", {
      method: "POST",
      body: JSON.stringify({ name: $("#new-bot-name").value, description: $("#new-bot-description").value, channels: checkedValues($("#new-bot-channels")) }),
    });
    location.href = editorUrl(bot.id, bot.createdFlowId);
  } catch (error) { toast(error.message, true); }
});

// ---------- automação global ----------------------------------------------------
function renderGlobal() {
  const on = state.settings?.automationEnabled;
  $("#global-automation-status").textContent = on ? "LIGADA" : "DESLIGADA";
  $("#global-automation-status").className = `global-status-pill ${on ? "on" : "off"}`;
  $("#kill-switch").textContent = on ? "DESATIVAR AUTOMAÇÃO DOS BOTS" : "REATIVAR AUTOMAÇÃO DOS BOTS";
}
$("#kill-switch").addEventListener("click", async () => {
  const on = state.settings?.automationEnabled;
  if (!window.confirm(on ? "Desligar a resposta automática de TODOS os Bots agora?" : "Reativar a automação dos Bots? Só Bots com resposta automática ligada voltam a responder.")) return;
  try {
    state.settings = await api(`/api/bot-settings/kill-switch/${on ? "activate" : "deactivate"}`, { method: "POST" });
    renderGlobal();
    if (state.selected) renderEditor();
    toast(on ? "Automação dos Bots desativada." : "Automação dos Bots reativada.");
  } catch (error) { toast(error.message, true); }
});

// ---------- Respostas do Bot ------------------------------------------------------------
$("#response-filter").innerHTML += RESPONSE_CATEGORIES.map((category) => `<option value="${category}">${category}</option>`).join("");
$("#response-category").innerHTML = RESPONSE_CATEGORIES.map((category) => `<option value="${category}">${category}</option>`).join("");

async function loadResponses() {
  try { state.responses = await api("/api/bot-responses"); renderResponses(); }
  catch (error) { toast(error.message, true); }
}
function renderResponses() {
  const category = $("#response-filter").value;
  const term = $("#response-search").value.trim().toLowerCase();
  const rows = state.responses.filter((item) => (!category || item.category === category)
    && (!term || `${item.key} ${item.title} ${item.text}`.toLowerCase().includes(term)));
  const groups = new Map();
  for (const item of rows) { if (!groups.has(item.category)) groups.set(item.category, []); groups.get(item.category).push(item); }
  $("#response-list").innerHTML = rows.length ? [...groups].map(([group, items]) => `
    <h4 class="library-group">${escapeHtml(group)}</h4>
    ${items.map((item) => `<button type="button" class="library-item ${item.active ? "" : "inactive"} ${state.editingResponseId === item.id ? "active" : ""}" data-response="${escapeHtml(item.id)}">
      <b>${escapeHtml(item.key)}</b><span>${escapeHtml(item.title)}${item.active ? "" : " • inativa"}</span><small>${escapeHtml(item.text.slice(0, 140))}</small></button>`).join("")}`).join("")
    : '<p class="card-help">Nenhuma resposta cadastrada.</p>';
}
function editResponse(item) {
  state.editingResponseId = item?.id || null;
  $("#response-form-kicker").textContent = item ? "EDITAR RESPOSTA" : "NOVA RESPOSTA";
  $("#response-form-title").textContent = item ? item.key : "Cadastrar resposta";
  $("#response-key").value = item?.key || "";
  $("#response-key").disabled = Boolean(item);
  $("#response-category").value = item?.category || "GERAL";
  $("#response-title").value = item?.title || "";
  $("#response-text").value = item?.text || "";
  $("#response-active").checked = item ? item.active : true;
  $("#delete-response").hidden = !item;
  renderResponses();
}
$("#response-filter").addEventListener("change", renderResponses);
$("#response-search").addEventListener("input", renderResponses);
$("#new-response").addEventListener("click", () => editResponse(null));
$("#response-list").addEventListener("click", (event) => {
  const id = event.target.closest("[data-response]")?.dataset.response;
  if (id) editResponse(state.responses.find((item) => item.id === id));
});
$("#response-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = { category: $("#response-category").value, title: $("#response-title").value, text: $("#response-text").value, active: $("#response-active").checked };
  try {
    const saved = state.editingResponseId
      ? await api(`/api/bot-responses/${state.editingResponseId}`, { method: "PATCH", body: JSON.stringify(body) })
      : await api("/api/bot-responses", { method: "POST", body: JSON.stringify({ ...body, key: $("#response-key").value }) });
    await loadResponses();
    editResponse(state.responses.find((item) => item.id === saved.id));
    toast("Resposta salva.");
  } catch (error) { toast(error.message, true); }
});
$("#delete-response").addEventListener("click", async () => {
  if (!state.editingResponseId || !window.confirm("Excluir esta resposta? (Bloqueado se algum fluxo a usa.)")) return;
  try { await api(`/api/bot-responses/${state.editingResponseId}`, { method: "DELETE" }); editResponse(null); await loadResponses(); toast("Resposta excluída."); }
  catch (error) { toast(error.message, true); }
});

// ---------- Webhooks ------------------------------------------------------------------
async function loadWebhooks() {
  try { state.webhooks = await api("/api/bot-webhooks"); renderWebhooks(); }
  catch (error) { toast(error.message, true); }
}
function renderWebhooks() {
  $("#webhook-list").innerHTML = state.webhooks.length ? state.webhooks.map((item) => `
    <button type="button" class="library-item ${item.active ? "" : "inactive"} ${state.editingWebhookId === item.id ? "active" : ""}" data-webhook="${escapeHtml(item.id)}">
      <b>${escapeHtml(item.key)}</b><span>${escapeHtml(item.name)} • ${item.method}${item.active ? "" : " • inativo"}</span><small>${escapeHtml(item.url)}</small></button>`).join("")
    : '<p class="card-help">Nenhum endpoint cadastrado.</p>';
}
function headerRow(name = "") {
  return `<div class="kv-row"><input placeholder="Nome (ex.: Authorization)" value="${escapeHtml(name)}" data-header-name><input placeholder="Valor" type="password" autocomplete="off" data-header-value><button type="button" class="link-button" data-remove-header>✕</button></div>`;
}
function editWebhook(item) {
  state.editingWebhookId = item?.id || null;
  $("#webhook-form-kicker").textContent = item ? "EDITAR ENDPOINT" : "NOVO ENDPOINT";
  $("#webhook-form-title").textContent = item ? item.key : "Cadastrar endpoint";
  $("#webhook-key").value = item?.key || "";
  $("#webhook-key").disabled = Boolean(item);
  $("#webhook-name").value = item?.name || "";
  $("#webhook-url").value = item?.url || "";
  $("#webhook-method").value = item?.method || "POST";
  $("#webhook-timeout").value = item?.timeoutMs || 5000;
  $("#webhook-active").checked = item ? item.active : true;
  $("#webhook-headers-current").textContent = item?.headerKeys?.length ? `Cabeçalhos configurados (valores ocultos): ${item.headerKeys.join(", ")}` : "Nenhum cabeçalho configurado.";
  $("#webhook-change-headers").checked = false;
  $("#webhook-headers").innerHTML = headerRow();
  $("#webhook-headers").hidden = true;
  $("#webhook-add-header").hidden = true;
  $("#delete-webhook").hidden = !item;
  renderWebhooks();
}
$("#webhook-change-headers").addEventListener("change", (event) => {
  $("#webhook-headers").hidden = !event.target.checked;
  $("#webhook-add-header").hidden = !event.target.checked;
});
$("#webhook-add-header").addEventListener("click", () => $("#webhook-headers").insertAdjacentHTML("beforeend", headerRow()));
$("#webhook-headers").addEventListener("click", (event) => { if (event.target.closest("[data-remove-header]")) event.target.closest(".kv-row").remove(); });
$("#new-webhook").addEventListener("click", () => editWebhook(null));
$("#webhook-list").addEventListener("click", (event) => {
  const id = event.target.closest("[data-webhook]")?.dataset.webhook;
  if (id) editWebhook(state.webhooks.find((item) => item.id === id));
});
$("#webhook-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = {
    name: $("#webhook-name").value, url: $("#webhook-url").value, method: $("#webhook-method").value,
    timeoutMs: Number($("#webhook-timeout").value), active: $("#webhook-active").checked,
  };
  if ($("#webhook-change-headers").checked) {
    body.headers = [...document.querySelectorAll("#webhook-headers .kv-row")].map((row) => ({
      name: $("[data-header-name]", row).value.trim(), value: $("[data-header-value]", row).value,
    })).filter((item) => item.name);
  }
  try {
    const saved = state.editingWebhookId
      ? await api(`/api/bot-webhooks/${state.editingWebhookId}`, { method: "PATCH", body: JSON.stringify(body) })
      : await api("/api/bot-webhooks", { method: "POST", body: JSON.stringify({ ...body, key: $("#webhook-key").value }) });
    await loadWebhooks();
    editWebhook(state.webhooks.find((item) => item.id === saved.id));
    toast("Endpoint salvo.");
  } catch (error) { toast(error.message, true); }
});
$("#delete-webhook").addEventListener("click", async () => {
  if (!state.editingWebhookId || !window.confirm("Excluir este endpoint? (Bloqueado se algum fluxo o usa.)")) return;
  try { await api(`/api/bot-webhooks/${state.editingWebhookId}`, { method: "DELETE" }); editWebhook(null); await loadWebhooks(); toast("Endpoint excluído."); }
  catch (error) { toast(error.message, true); }
});

// ---------- Histórico técnico (Bots antigos) ------------------------------------------
async function loadLegacy() {
  try {
    const bots = await api("/api/bots-legacy");
    state.legacyLoaded = true;
    $("#legacy-list").innerHTML = bots.length ? bots.map((bot) => `
      <div class="library-item static">
        <b>${escapeHtml(bot.name)}</b>
        <span>${escapeHtml(bot.type)} • ${escapeHtml(bot.channels.map((channel) => CHANNEL_LABELS[channel] || channel).join(", "))}${bot.statusBeforeArchive ? ` • status antes do arquivo: ${escapeHtml(bot.statusBeforeArchive)}` : ""}${bot.deletedAt ? " • excluído" : ""}</span>
        <small>${bot.counts.intents} intenções • ${bot.counts.observations} observações • ${bot.counts.learningSuggestions} sugestões de aprendizado • ${bot.counts.knowledgeSources} fontes de conhecimento • ${bot.counts.versions} versões${bot.legacyArchivedAt ? ` • arquivado em ${new Date(bot.legacyArchivedAt).toLocaleString("pt-BR")}` : ""}</small>
      </div>`).join("") : '<p class="card-help">Nenhum Bot antigo arquivado.</p>';
  } catch (error) { toast(error.message, true); }
}

// ---------- tema / sessão / início --------------------------------------------------------
$("#theme-toggle").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme === "dark";
  document.documentElement.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("mibro-theme", dark ? "light" : "dark"); } catch { /* preferência só local */ }
  $("#theme-toggle").textContent = dark ? "☾" : "☀";
});
$("#logout").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.replace("/login.html");
});

(async () => {
  try {
    const status = await api("/api/auth/status");
    if (!status.authenticated || !status.user.isMaster) { location.replace("/"); return; }
    $("#current-user").textContent = status.user.name;
    state.settings = await api("/api/bot-settings");
    renderGlobal();
    editResponse(null);
    editWebhook(null);
    await loadBots(new URLSearchParams(location.search).get("botId"));
  } catch (error) {
    $("#bot-list").innerHTML = '<div class="intent-empty">Não foi possível carregar os Bots.</div>';
    toast(error.message, true);
  }
})();
