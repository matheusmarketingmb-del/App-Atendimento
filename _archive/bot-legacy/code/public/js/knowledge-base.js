const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[char]);
const state = { sources: [], bots: [], selected: null };

const TYPE_LABELS = {
  FAQ: "Pergunta frequente",
  MANUAL: "Manual",
  PRODUCT: "Produto",
  POLICY: "Política",
  WARRANTY: "Garantia",
  PROCEDURE: "Procedimento",
  GENERAL: "Informação geral",
  OTHER: "Outro",
};

async function api(url, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    location.replace("/login.html");
    throw new Error("Sessão encerrada.");
  }
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || "Não foi possível concluir a operação.");
  return body;
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = "toast show" + (error ? " error" : "");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = "toast"; }, 3200);
}

function typeOptions(selected = "GENERAL") {
  return Object.entries(TYPE_LABELS).map(([value, label]) => (
    '<option value="' + value + '"' + (value === selected ? " selected" : "") + ">" + escapeHtml(label) + "</option>"
  )).join("");
}

function formatDateInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function currentFilters() {
  return {
    q: $("#knowledge-search").value.trim(),
    type: $("#knowledge-filter-type").value,
    botId: $("#knowledge-filter-bot").value,
    active: $("#knowledge-filter-active").value,
  };
}

function renderFilterOptions() {
  $("#knowledge-filter-type").innerHTML = '<option value="">Todos os tipos</option>' + typeOptions("");
  $("#knowledge-filter-bot").innerHTML = '<option value="">Todos os acessos</option>' + state.bots.map((bot) => (
    '<option value="' + escapeHtml(bot.id) + '">' + escapeHtml(bot.name) + "</option>"
  )).join("");
  $("#knowledge-type").innerHTML = typeOptions();
}

function accessLabel(item) {
  if (item.accessMode === "ALL") return "Todos os Bots";
  const names = (item.bots || []).map((bot) => bot.name);
  if (!names.length) return "Bots selecionados";
  return names.length <= 2 ? names.join(", ") : names.slice(0, 2).join(", ") + " +" + (names.length - 2);
}

function renderList() {
  $("#knowledge-count").textContent = state.sources.length + " informaç" + (state.sources.length === 1 ? "ão" : "ões") + " encontrada" + (state.sources.length === 1 ? "" : "s");
  $("#knowledge-list").innerHTML = state.sources.length ? state.sources.map((item) => (
    '<button class="bot-card ' + (state.selected?.id === item.id ? "active" : "") + '" type="button" data-source-id="' + escapeHtml(item.id) + '">' +
      "<header><b>" + escapeHtml(item.title) + '</b><span class="mini-status ' + (item.activeNow ? "ACTIVE" : "PAUSED") + '">' + (item.activeNow ? "ATIVA" : "INATIVA") + "</span></header>" +
      '<small class="knowledge-card-type">' + escapeHtml(TYPE_LABELS[item.type] || item.type) + "</small>" +
      '<div class="bot-meta knowledge-card-access"><span>' + escapeHtml(item.product || "Geral") + "</span><span>•</span><span>" + escapeHtml(accessLabel(item)) + "</span></div>" +
    "</button>"
  )).join("") : '<div class="intent-empty">Nenhuma informação encontrada.</div>';
  document.querySelectorAll("[data-source-id]").forEach((button) => button.addEventListener("click", () => selectSource(button.dataset.sourceId)));
}

async function loadList(preferredId = state.selected?.id) {
  state.sources = await api("/api/knowledge-sources?" + new URLSearchParams(currentFilters()));
  state.selected = preferredId ? state.sources.find((item) => item.id === preferredId) || null : null;
  renderList();
  if (state.selected) renderEditor();
}

function renderBotChecklist(selected = []) {
  $("#knowledge-bots-checklist").innerHTML = state.bots.length ? state.bots.map((bot) => (
    '<label><input type="checkbox" value="' + escapeHtml(bot.id) + '"' + (selected.includes(bot.id) ? " checked" : "") + "><span>" +
      escapeHtml(bot.name) + "<small>" + escapeHtml(bot.channel) + " • " + escapeHtml(bot.status) + "</small></span></label>"
  )).join("") : '<p class="card-help">Nenhum Bot cadastrado.</p>';
}

function syncAccessMode() {
  const global = $("#knowledge-access-mode").value === "ALL";
  $("#knowledge-bots-checklist").classList.toggle("is-global", global);
  $("#knowledge-bots-checklist").querySelectorAll("input").forEach((input) => { input.disabled = global; });
  $("#access-help").textContent = global
    ? "Todos os Bots poderão consultar esta informação quando a Base de conhecimento estiver ativada neles."
    : "Somente os Bots marcados abaixo poderão consultar esta informação.";
  updateSummary();
}

function updateSummary() {
  const selectedCount = document.querySelectorAll("#knowledge-bots-checklist input:checked").length;
  const access = $("#knowledge-access-mode").value === "ALL" ? "Todos" : selectedCount + " Bot(s)";
  $("#knowledge-access-summary").textContent = access;
  $("#knowledge-availability").textContent = $("#knowledge-active").checked ? "Ativa" : "Inativa";
}

function fillForm(item = null) {
  $("#knowledge-title").value = item?.title || "";
  $("#knowledge-type").innerHTML = typeOptions(item?.type || "GENERAL");
  $("#knowledge-source").value = item?.source || "";
  $("#knowledge-product").value = item?.product || "";
  $("#knowledge-category").value = item?.category || "";
  $("#knowledge-tags").value = (item?.tags || []).join(", ");
  $("#knowledge-content").value = item?.content || "";
  $("#knowledge-valid-from").value = formatDateInput(item?.validFrom);
  $("#knowledge-valid-until").value = formatDateInput(item?.validUntil);
  $("#knowledge-active").checked = item ? item.active : true;
  $("#knowledge-access-mode").value = item?.accessMode || "ALL";
  renderBotChecklist(item?.botIds || []);
  $("#knowledge-version").textContent = item?.version || 1;
  syncAccessMode();
}

function renderEditor() {
  const item = state.selected;
  const creating = $("#editor").dataset.creating === "true";
  $("#empty-state").hidden = Boolean(item) || creating;
  $("#editor").hidden = !item && !creating;
  if (!item) return;
  $("#editor").dataset.creating = "false";
  $("#editor-eyebrow").textContent = "INFORMAÇÃO SELECIONADA";
  $("#editor-title").textContent = item.title;
  $("#editor-description").textContent = (TYPE_LABELS[item.type] || item.type) + " • " + (item.source || "Sem origem");
  $("#status-actions").hidden = false;
  $("#status-badge").textContent = item.activeNow ? "ATIVA" : "INATIVA";
  $("#status-badge").className = "status-badge " + (item.activeNow ? "ACTIVE" : "PAUSED");
  fillForm(item);
}

function selectSource(id) {
  state.selected = state.sources.find((item) => item.id === id) || null;
  renderEditor();
  renderList();
}

function startNew() {
  state.selected = null;
  $("#editor").dataset.creating = "true";
  $("#empty-state").hidden = true;
  $("#editor").hidden = false;
  $("#editor-eyebrow").textContent = "NOVA INFORMAÇÃO";
  $("#editor-title").textContent = "Cadastrar conhecimento";
  $("#editor-description").textContent = "Informe o conteúdo e escolha quais Bots terão acesso.";
  $("#status-actions").hidden = true;
  fillForm();
  renderList();
}

function formPayload() {
  const selectedBotIds = Array.from(document.querySelectorAll("#knowledge-bots-checklist input:checked")).map((input) => input.value);
  if ($("#knowledge-access-mode").value === "SELECTED" && !selectedBotIds.length) {
    throw new Error("Selecione ao menos um Bot ou escolha acesso para todos.");
  }
  const tags = $("#knowledge-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean);
  return {
    title: $("#knowledge-title").value,
    type: $("#knowledge-type").value,
    source: $("#knowledge-source").value,
    product: $("#knowledge-product").value || null,
    category: $("#knowledge-category").value || null,
    tags,
    content: $("#knowledge-content").value,
    validFrom: $("#knowledge-valid-from").value || null,
    validUntil: $("#knowledge-valid-until").value || null,
    active: $("#knowledge-active").checked,
    botIds: $("#knowledge-access-mode").value === "ALL" ? [] : selectedBotIds,
  };
}

$("#new-knowledge").addEventListener("click", startNew);
$("#empty-new-knowledge").addEventListener("click", startNew);
$("#knowledge-search").addEventListener("input", () => {
  clearTimeout($("#knowledge-search")._timer);
  $("#knowledge-search")._timer = setTimeout(() => loadList(null), 250);
});
$("#knowledge-filter-type").addEventListener("change", () => loadList(null));
$("#knowledge-filter-bot").addEventListener("change", () => loadList(null));
$("#knowledge-filter-active").addEventListener("change", () => loadList(null));
$("#knowledge-access-mode").addEventListener("change", syncAccessMode);
$("#knowledge-active").addEventListener("change", updateSummary);
$("#knowledge-bots-checklist").addEventListener("change", updateSummary);

$("#knowledge-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = formPayload();
    const saved = state.selected
      ? await api("/api/knowledge-sources/" + encodeURIComponent(state.selected.id), { method: "PATCH", body: JSON.stringify(payload) })
      : await api("/api/knowledge-sources", { method: "POST", body: JSON.stringify(payload) });
    toast(state.selected ? "Informação atualizada." : "Informação criada.");
    $("#editor").dataset.creating = "false";
    await loadList(saved.id);
  } catch (error) {
    toast(error.message, true);
  }
});

$("#delete-knowledge").addEventListener("click", async () => {
  if (!state.selected) return;
  if (!confirm('Excluir "' + state.selected.title + '"? Essa informação deixará de ser usada por todos os Bots.')) return;
  try {
    await api("/api/knowledge-sources/" + encodeURIComponent(state.selected.id), { method: "DELETE" });
    toast("Informação excluída.");
    state.selected = null;
    $("#editor").dataset.creating = "false";
    $("#editor").hidden = true;
    $("#empty-state").hidden = false;
    await loadList(null);
  } catch (error) {
    toast(error.message, true);
  }
});

$("#theme-toggle").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try { localStorage.setItem("mibro-theme", dark ? "dark" : "light"); } catch {}
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
    state.bots = await api("/api/bots");
    renderFilterOptions();
    await loadList(null);
  } catch (error) {
    if ($("#knowledge-list").querySelector(".skeleton-list")) {
      $("#knowledge-list").innerHTML = '<div class="empty-list">Não foi possível carregar a base de conhecimento.</div>';
    }
    toast(error.message, true);
  }
})();
