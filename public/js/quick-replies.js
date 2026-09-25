const $ = (selector) => document.querySelector(selector);
const MARKETPLACE_UI_ENABLED = window.MIBRO_FEATURES?.marketplaces !== false;
const isMarketplaceChannel = (channel) => window.isMarketplaceFeatureChannel?.(channel) === true;
const visibleChannelEntries = () => Object.entries(CHANNEL_LABELS).filter(([channel]) => MARKETPLACE_UI_ENABLED || !isMarketplaceChannel(channel));
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[char]);
const state = { quickReplies: [], categories: [], intents: [], selected: null };

const CHANNEL_LABELS = {
  META: "WhatsApp (Meta)", INSTAGRAM_DIRECT: "Instagram Direct", INSTAGRAM_COMMENTS: "Instagram Comentários",
  FACEBOOK_MESSENGER: "Facebook Messenger", FACEBOOK_COMMENTS: "Facebook Comentários", EMAIL: "E-mail",
  MERCADO_LIVRE: "Mercado Livre", TIKTOK_SHOP: "TikTok Shop", AMAZON_MARKETPLACE: "Amazon Marketplace",
  SHOPEE: "Shopee", GOOGLE_REVIEWS: "Google Reviews / Perfil da Empresa", RECLAME_AQUI: "Reclame Aqui",
};

async function api(url, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) { location.replace("/login.html"); throw new Error("Sessão encerrada."); }
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || "Não foi possível concluir a operação.");
  return body;
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = "toast"; }, 3200);
}

function categoryOptions(selected = "") {
  return `<option value="">Todas as categorias</option>${state.categories.map((category) => (
    `<option value="${escapeHtml(category.id)}" ${category.id === selected ? "selected" : ""}>${escapeHtml(category.parentId ? `- ${category.name}` : category.name)}</option>`
  )).join("")}`;
}

function renderCategoriesChecklist(selected = []) {
  const selectedIds = new Set(selected);
  const parentsWithChildren = new Set(state.categories.filter((category) => category.parentId).map((category) => category.parentId));
  $("#qr-categories-checklist").innerHTML = state.categories.map((category) => `
    <label class="qr-category-option ${category.parentId ? "child" : "parent"}">
      <input type="checkbox" value="${escapeHtml(category.id)}" ${selectedIds.has(category.id) ? "checked" : ""}>
      <span>${escapeHtml(category.name)}</span>
      ${parentsWithChildren.has(category.id) ? '<small>inclui subcategorias</small>' : ""}
    </label>
  `).join("");
}

function currentFilters() {
  return {
    search: $("#qr-search").value.trim(),
    categoryId: $("#qr-filter-category").value,
    channel: $("#qr-filter-channel").value,
    active: $("#qr-filter-active").value,
    includeArchived: "false",
  };
}

function renderFilterOptions() {
  $("#qr-filter-category").innerHTML = `<option value="">Todas as categorias</option>${state.categories.map((category) => (
    `<option value="${escapeHtml(category.id)}">${escapeHtml(category.parentId ? `- ${category.name}` : category.name)}</option>`
  )).join("")}`;
  $("#qr-filter-channel").innerHTML = `<option value="">Todos os canais</option>${visibleChannelEntries().map(([value, label]) => (
    `<option value="${value}">${escapeHtml(label)}</option>`
  )).join("")}`;
}

function renderList() {
  $("#qr-count").textContent = `${state.quickReplies.length} resposta${state.quickReplies.length === 1 ? "" : "s"} configurada${state.quickReplies.length === 1 ? "" : "s"}`;
  $("#qr-list").innerHTML = state.quickReplies.length ? state.quickReplies.map((item) => `
    <button class="bot-card ${state.selected?.id === item.id ? "active" : ""}" type="button" data-qr-id="${escapeHtml(item.id)}">
      <header><b>${escapeHtml(item.name)}</b><span class="mini-status ${item.active ? "ACTIVE" : "PAUSED"}">${item.active ? "ATIVA" : "INATIVA"}</span></header>
      <small class="qr-shortcut-pill">${escapeHtml(item.shortcut)}</small>
      <div class="bot-meta"><span>${escapeHtml(item.categories?.length ? item.categories.map((category) => category.name).join(", ") : (item.category?.name || "Todos os setores"))}</span><span>•</span><span>${item.usageCount} uso(s)</span></div>
    </button>
  `).join("") : '<div class="intent-empty">Nenhuma resposta encontrada.</div>';
  document.querySelectorAll("[data-qr-id]").forEach((button) => button.addEventListener("click", () => selectQuickReply(button.dataset.qrId)));
}

async function loadList() {
  state.quickReplies = await api(`/api/quick-replies?${new URLSearchParams(currentFilters())}`);
  renderList();
}

function renderChannelsChecklist(selected = []) {
  $("#qr-channels-checklist").innerHTML = visibleChannelEntries().map(([value, label]) => `
    <label class="checkbox"><input type="checkbox" value="${value}" ${selected.includes(value) ? "checked" : ""}><span>${label}</span></label>
  `).join("");
}

function renderIntentsChecklist(selected = []) {
  if (!state.intents.length) {
    $("#qr-intents-checklist").innerHTML = '<p class="card-help">Nenhuma intenção de Bot cadastrada ainda.</p>';
    return;
  }
  $("#qr-intents-checklist").innerHTML = state.intents.map((intent) => `
    <label class="checkbox"><input type="checkbox" value="${escapeHtml(intent.id)}" ${selected.includes(intent.id) ? "checked" : ""}><span>${escapeHtml(intent.botName)} — ${escapeHtml(intent.name)}</span></label>
  `).join("");
}

function fillForm(item = null) {
  $("#qr-name").value = item?.name || "";
  $("#qr-shortcut").value = item?.shortcut || "";
  renderCategoriesChecklist(item?.categoryIds || (item?.categoryId ? [item.categoryId] : []));
  $("#qr-type").value = item?.type || "QUICK_REPLY";
  $("#qr-text").value = item?.text || "";
  $("#qr-available-agents").checked = item ? item.availableToAgents : true;
  $("#qr-available-bots").checked = item ? item.availableToBots : false;
  renderChannelsChecklist(item?.channels || []);
  renderIntentsChecklist(item?.intentIds || []);
  renderPreview();
  $("#qr-usage-count").textContent = item?.usageCount ?? 0;
  $("#qr-favorite-count").textContent = item?.favoriteCount ?? 0;
}

async function renderPreview() {
  const text = $("#qr-text").value;
  if (!text.trim()) { $("#qr-preview").innerHTML = "<p>Digite o texto para ver o preview.</p>"; return; }
  try {
    const result = await api("/api/quick-replies/preview", { method: "POST", body: JSON.stringify({ text }) });
    $("#qr-preview").innerHTML = `<p>${escapeHtml(result.text).replace(/\n/g, "<br>")}</p>${result.unresolved.length ? `<p style="color:var(--danger)">Variável(is) sem dado fictício: ${result.unresolved.join(", ")}</p>` : ""}`;
  } catch (error) { $("#qr-preview").innerHTML = `<p>${escapeHtml(error.message)}</p>`; }
}

function renderEditor() {
  const item = state.selected;
  $("#empty-state").hidden = Boolean(item) || $("#editor").dataset.creating === "true";
  $("#editor").hidden = !item && $("#editor").dataset.creating !== "true";
  if (!item) return;
  $("#editor").dataset.creating = "false";
  $("#editor-eyebrow").textContent = "RESPOSTA SELECIONADA";
  $("#editor-title").textContent = item.name;
  $("#editor-description").textContent = `${item.shortcut} — criado por ${item.createdBy?.name || "—"}`;
  $("#status-actions").hidden = false;
  $("#status-badge").textContent = item.active ? "ATIVA" : "INATIVA";
  $("#status-badge").className = `status-badge ${item.active ? "ACTIVE" : "PAUSED"}`;
  fillForm(item);
}

async function selectQuickReply(id) {
  state.selected = await api(`/api/quick-replies/${encodeURIComponent(id)}`);
  renderEditor();
  renderList();
}

function startNew() {
  state.selected = null;
  $("#editor").dataset.creating = "true";
  $("#empty-state").hidden = true;
  $("#editor").hidden = false;
  $("#editor-eyebrow").textContent = "NOVA RESPOSTA";
  $("#editor-title").textContent = "Criar resposta rápida";
  $("#editor-description").textContent = "Defina nome, atalho e texto — o atalho precisa começar com \"/\".";
  $("#status-actions").hidden = true;
  fillForm();
  renderList();
}

function formPayload() {
  return {
    name: $("#qr-name").value,
    shortcut: $("#qr-shortcut").value,
    categoryIds: Array.from(document.querySelectorAll("#qr-categories-checklist input:checked")).map((input) => input.value),
    type: $("#qr-type").value,
    text: $("#qr-text").value,
    channels: Array.from(document.querySelectorAll("#qr-channels-checklist input:checked")).map((input) => input.value),
    availableToAgents: $("#qr-available-agents").checked,
    availableToBots: $("#qr-available-bots").checked,
    intentIds: Array.from(document.querySelectorAll("#qr-intents-checklist input:checked")).map((input) => input.value),
  };
}

$("#new-qr").addEventListener("click", startNew);
$("#empty-new-qr").addEventListener("click", startNew);
$("#qr-search").addEventListener("input", () => { clearTimeout($("#qr-search")._t); $("#qr-search")._t = setTimeout(loadList, 250); });
$("#qr-filter-category").addEventListener("change", loadList);
$("#qr-filter-channel").addEventListener("change", loadList);
$("#qr-filter-active").addEventListener("change", loadList);
$("#qr-text").addEventListener("input", () => { clearTimeout($("#qr-text")._t); $("#qr-text")._t = setTimeout(renderPreview, 250); });

$("#qr-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = formPayload();
    const saved = state.selected
      ? await api(`/api/quick-replies/${state.selected.id}`, { method: "PATCH", body: JSON.stringify(payload) })
      : await api("/api/quick-replies", { method: "POST", body: JSON.stringify(payload) });
    toast(state.selected ? "Resposta atualizada." : "Resposta criada.");
    await loadList();
    await selectQuickReply(saved.id);
  } catch (error) { toast(error.message, true); }
});

$("#toggle-active").addEventListener("click", async () => {
  if (!state.selected) return;
  try {
    const updated = await api(`/api/quick-replies/${state.selected.id}`, { method: "PATCH", body: JSON.stringify({ active: !state.selected.active }) });
    toast(updated.active ? "Resposta ativada." : "Resposta desativada.");
    await loadList();
    await selectQuickReply(updated.id);
  } catch (error) { toast(error.message, true); }
});

$("#archive-qr").addEventListener("click", async () => {
  if (!state.selected) return;
  if (!confirm(`Arquivar "${state.selected.name}"? Ela deixa de aparecer para atendentes, mas o histórico de uso é preservado.`)) return;
  try {
    await api(`/api/quick-replies/${state.selected.id}`, { method: "DELETE" });
    toast("Resposta arquivada.");
    state.selected = null;
    $("#editor").dataset.creating = "false";
    $("#editor").hidden = true;
    $("#empty-state").hidden = false;
    await loadList();
  } catch (error) { toast(error.message, true); }
});

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

(async () => {
  try {
    const status = await api("/api/auth/status");
    if (!status.authenticated || !status.user.isMaster) return location.replace("/");
    $("#current-user").textContent = status.user.name;
    state.categories = (await api("/api/categories")).filter((category) => category.active !== false);
    state.intents = await api("/api/bots/intents");
    renderFilterOptions();
    renderCategoriesChecklist();
    await loadList();
  } catch (error) {
    if ($("#qr-list").querySelector(".skeleton-list")) $("#qr-list").innerHTML = `<div class="empty-list">Não foi possível carregar as respostas rápidas.</div>`;
    toast(error.message, true);
  }
})();
