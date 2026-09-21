const MARKETPLACE_UI_ENABLED = window.MIBRO_FEATURES?.marketplaces !== false;
const isMarketplaceChannel = (channel) => window.isMarketplaceFeatureChannel?.(channel) === true;
if (MARKETPLACE_UI_ENABLED) document.querySelectorAll("[data-marketplace-feature]").forEach((element) => { element.hidden = false; });

const state = {
  bots: [], categories: [], selected: null,
  simulatorHistory: [], simulatorState: null,
  // Fluxo de atendimento (Flow Engine).
  flowSteps: [], flowStepsCache: new Map(), tools: [], knowledgeSources: [],
  guidedConfig: { responseBlocks: [], synonymGroups: [] },
  aiProviderOptions: null,
  personalityPresets: null,
};
const flowActionLabels = {
  ASK_QUESTION: "Perguntar", SHOW_OPTIONS: "Mostrar opções", USE_KNOWLEDGE: "Usar conhecimento",
  USE_RESPONSE_BLOCK: "Usar bloco", QUERY_TOOL: "Consultar Tool",
  RESPOND: "Responder", RESOLVED: "Resolvido", HANDOFF_HUMAN: "Encaminhar humano", GOTO_STEP: "Ir para etapa",
};
const actionLabels = {
  RESPOND: "Responder",
  ASK_CLARIFICATION: "Pedir esclarecimento",
  HANDOFF_HUMAN: "Encaminhar para humano",
  SWITCH_BOT: "Trocar de Bot",
  QUERY_TOOL: "Consultar ferramenta",
  NO_ACTION: "Nenhuma ação",
};
const $ = (selector) => document.querySelector(selector);
const statusLabels = { DRAFT: "RASCUNHO", ACTIVE: "ATIVO", PAUSED: "PAUSADO" };
const channelLabels = {
  META: "WhatsApp (Meta)",
  INSTAGRAM_DIRECT: "Instagram Direct",
  INSTAGRAM_COMMENTS: "Instagram Comentários",
  FACEBOOK_MESSENGER: "Facebook Messenger",
  FACEBOOK_COMMENTS: "Facebook Comentários",
  EMAIL: "E-mail",
  MERCADO_LIVRE: "Mercado Livre",
  TIKTOK_SHOP: "TikTok Shop",
  AMAZON_MARKETPLACE: "Amazon Marketplace",
  SHOPEE: "Shopee",
  SHEIN_MARKETPLACE: "SHEIN Marketplace",
  GOOGLE_REVIEWS: "Google Reviews / Perfil da Empresa",
  RECLAME_AQUI: "Reclame Aqui",
};
const dayNames = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

async function api(url, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) { location.replace("/login.html"); throw new Error("Sessão encerrada."); }
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || "Não foi possível concluir a operação.");
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
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = "toast"; }, 3200);
}

function categoryOptions(selected = "") {
  return `<option value="">Sem categoria padrão</option>${state.categories.map((category) => (
    `<option value="${escapeHtml(category.id)}" ${category.id === selected ? "selected" : ""}>${escapeHtml(category.parentId ? `- ${category.name}` : category.name)}</option>`
  )).join("")}`;
}

// Sem "Sem categoria" — uma opção de triagem sempre precisa de destino
// válido (item "não permitir destino inválido").
function triageCategoryOptions(selected = "") {
  const byId = new Map(state.categories.map((category) => [category.id, category]));
  return state.categories.filter((category) => {
    const parent = category.parentId ? byId.get(category.parentId) : null;
    return category.active && !category.masterOnly && (!parent || (parent.active && !parent.masterOnly));
  }).map((category) => {
    const parent = category.parentId ? byId.get(category.parentId) : null;
    const label = parent ? `Subcategoria - ${parent.name} / ${category.name}` : `Categoria - ${category.name}`;
    return `<option value="${escapeHtml(category.id)}" ${category.id === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
}

function renderTriageSubcategoryChoices(categoryId) {
  const field = $("#triage-subcategory-field");
  const container = $("#triage-subcategory-options");
  const category = state.categories.find((item) => item.id === categoryId);
  const children = state.categories.filter((item) => item.parentId === categoryId
    && item.active && !item.masterOnly);
  const enabledIds = new Set((state.selected?.triageOptions || [])
    .filter((option) => option.enabled).map((option) => option.categoryId));
  const hidden = !category || Boolean(category.parentId) || !children.length;
  field.hidden = hidden;
  if (hidden) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = children.map((child) => `
    <label>
      <input type="checkbox" data-triage-child="${escapeHtml(child.id)}" ${enabledIds.has(child.id) ? "checked" : ""}>
      <span>${escapeHtml(child.name)}</span>
    </label>
  `).join("");
}

function scheduleSummary(schedules = []) {
  const enabled = schedules.filter((item) => item.enabled).sort((left, right) => left.dayOfWeek - right.dayOfWeek);
  if (!enabled.length) return "Sem horário configurado";
  const consecutive = enabled.length >= 2 && enabled.every((item, index) => index === 0 || item.dayOfWeek === enabled[index - 1].dayOfWeek + 1);
  const sameHours = enabled.every((item) => item.startTime === enabled[0].startTime && item.endTime === enabled[0].endTime);
  const dayLabel = (dayOfWeek) => dayNames[dayOfWeek].slice(0, 3);
  const range = consecutive ? `${dayLabel(enabled[0].dayOfWeek)}–${dayLabel(enabled[enabled.length - 1].dayOfWeek)}` : enabled.map((item) => dayLabel(item.dayOfWeek)).join(",");
  return sameHours ? `${range} ${enabled[0].startTime}–${enabled[0].endTime}` : range;
}

function renderBotList() {
  $("#bot-count").textContent = `${state.bots.length} Bot${state.bots.length === 1 ? "" : "s"} configurado${state.bots.length === 1 ? "" : "s"}`;
  $("#bot-list").innerHTML = state.bots.length ? state.bots.map((bot) => `
    <button class="bot-card ${state.selected?.id === bot.id ? "active" : ""}" type="button" data-bot-id="${escapeHtml(bot.id)}">
      <header><b>${escapeHtml(bot.name)}</b><span class="mini-status ${bot.status}">${statusLabels[bot.status]}</span></header>
      ${bot.isSystem ? String.raw`<span class="mini-status SYSTEM">Bot do sistema</span>` : ""}
      ${!bot.autoReplyEnabled && bot.type !== "SYSTEM_TRIAGE" ? String.raw`<span class="mini-status SYSTEM">Observa&ccedil;&atilde;o</span>` : ""}
      <small>${escapeHtml(bot.description || "Sem descrição")}</small>
      <div class="bot-meta"><span>${escapeHtml(channelLabels[bot.channel] || "Canal legado")}</span><span>\u2022</span>${bot.type === "SYSTEM_TRIAGE" ? `<span>${bot._count.triageOptions} opcao(oes)</span><span>\u2022</span><span>${escapeHtml(scheduleSummary(bot.schedules || []))}</span>` : `<span>${bot._count.intents} intenção(ões)</span>`}</div>
    </button>
  `).join("") : '<div class="intent-empty">Nenhum Bot criado.</div>';
  document.querySelectorAll("[data-bot-id]").forEach((button) => button.addEventListener("click", () => selectBot(button.dataset.botId)));
}

function renderSchedules(schedules = []) {
  const byDay = new Map(schedules.map((item) => [item.dayOfWeek, item]));
  $("#schedule-list").innerHTML = dayNames.map((name, dayOfWeek) => {
    const row = byDay.get(dayOfWeek);
    return `<label class="schedule-row" data-day="${dayOfWeek}">
      <input class="schedule-enabled" type="checkbox" ${row?.enabled ? "checked" : ""}>
      <b>${name}</b>
      <input class="schedule-start" type="time" value="${row?.startTime || "08:00"}" aria-label="Início">
      <input class="schedule-end" type="time" value="${row?.endTime || "17:00"}" aria-label="Fim">
    </label>`;
  }).join("");
}

function holidayDateLabel(value) {
  const [year, month, day] = String(value || "").split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function holidayPayload(item) {
  return { date: item.date, name: item.name, enabled: item.enabled !== false };
}

function closeHolidayForm() {
  $("#holiday-form").hidden = true;
  $("#holiday-form").reset();
  $("#holiday-original-date").value = "";
  $("#holiday-enabled").checked = true;
}

function renderHolidays() {
  const holidays = [...(state.selected?.holidays || [])].sort((left, right) => left.date.localeCompare(right.date));
  $("#holiday-list").innerHTML = holidays.length ? holidays.map((holiday) => `
    <article class="holiday-row ${holiday.enabled ? "" : "inactive"}">
      <time datetime="${escapeHtml(holiday.date)}">${escapeHtml(holidayDateLabel(holiday.date))}</time>
      <b>${escapeHtml(holiday.name)}</b>
      <div><button type="button" data-edit-holiday="${escapeHtml(holiday.date)}">Editar</button><button type="button" data-delete-holiday="${escapeHtml(holiday.date)}">Excluir</button></div>
    </article>
  `).join("") : '<div class="intent-empty">Nenhum feriado configurado.</div>';
  document.querySelectorAll("[data-edit-holiday]").forEach((button) => button.addEventListener("click", () => editHoliday(button.dataset.editHoliday)));
  document.querySelectorAll("[data-delete-holiday]").forEach((button) => button.addEventListener("click", () => removeHoliday(button.dataset.deleteHoliday)));
}

function editHoliday(date) {
  const holiday = state.selected.holidays.find((item) => item.date === date);
  if (!holiday) return;
  $("#holiday-original-date").value = holiday.date;
  $("#holiday-date").value = holiday.date;
  $("#holiday-name").value = holiday.name;
  $("#holiday-enabled").checked = holiday.enabled;
  $("#holiday-form").hidden = false;
  $("#holiday-name").focus();
}

async function saveHolidaysList(holidays) {
  try {
    await api(`/api/bots/${state.selected.id}/holidays`, { method: "PUT", body: JSON.stringify({ holidays }) });
    toast("Feriados atualizados.");
    await selectBot(state.selected.id);
  } catch (error) { toast(error.message, true); }
}

async function removeHoliday(date) {
  if (!confirm("Remover este feriado?")) return;
  await saveHolidaysList(state.selected.holidays.filter((item) => item.date !== date).map(holidayPayload));
}

function renderIntents() {
  const intents = state.selected?.intents || [];
  $("#intent-list").innerHTML = intents.length ? intents.map((intent) => `
    <article class="intent-card ${intent.active ? "" : "inactive"}">
      <div><b>${escapeHtml(intent.name)}</b><small>${escapeHtml(intent.category?.name || "Sem categoria")} \u2022 prioridade ${intent.priority} \u2022 ${intent.examples.length} exemplo(s)</small></div>
      <div><button type="button" data-edit-intent="${escapeHtml(intent.id)}">Editar</button><button type="button" data-delete-intent="${escapeHtml(intent.id)}">Excluir</button></div>
    </article>
  `).join("") : '<div class="intent-empty">Nenhuma intenção configurada.</div>';
  document.querySelectorAll("[data-edit-intent]").forEach((button) => button.addEventListener("click", () => editIntent(button.dataset.editIntent)));
  document.querySelectorAll("[data-delete-intent]").forEach((button) => button.addEventListener("click", () => removeIntent(button.dataset.deleteIntent)));
}

const booleanFeatureFlags = [
  "interpretationEnabled", "conversationalBehaviorEnabled", "contextEnabled", "autoSwitchEnabled",
  "observationEnabled", "learningEnabled", "agentSuggestionsEnabled", "knowledgeSuggestionsEnabled", "knowledgeBaseEnabled",
  "handoffAutoPauseEnabled", "autoFinalizeOnResolution", "externalAiFallbackEnabled",
];
const numericFeatureFlags = {
  contextMaxMessages: 10, contextExpirationMinutes: 120, maxSwitchesPerWindow: 3, switchWindowMinutes: 10,
  externalAiThreshold: 0.7,
};
const defaultBooleanFeatureFlags = {
  interpretationEnabled: true, conversationalBehaviorEnabled: true, contextEnabled: true, autoSwitchEnabled: true,
  observationEnabled: true, learningEnabled: true, agentSuggestionsEnabled: true, knowledgeSuggestionsEnabled: true, knowledgeBaseEnabled: false,
  handoffAutoPauseEnabled: true, autoFinalizeOnResolution: false, externalAiFallbackEnabled: false,
};
// Item 3 (Motor de IA): provider externo escolhido por Bot — "GEMINI" é a
// configuração sugerida inicial (item 8), mas só é chamado de verdade se
// "IA externa como fallback" também estiver ligado.
const defaultExternalAiProvider = "GEMINI";

function renderChannelsChecklist(selectedChannels = []) {
  const primary = $("#bot-channel").value;
  $("#bot-channels-checklist").innerHTML = Object.entries(channelLabels)
    .filter(([value]) => value !== primary && (MARKETPLACE_UI_ENABLED || !isMarketplaceChannel(value)))
    .map(([value, label]) => `
      <label class="checkbox"><input type="checkbox" value="${value}" ${selectedChannels.includes(value) ? "checked" : ""}><span>${label}</span></label>
    `).join("");
}

function fillBotForm(bot = null) {
  $("#bot-name").value = bot?.name || "";
  $("#bot-description").value = bot?.description || "";
  $("#bot-channel").value = bot?.channel || "META";
  $("#bot-timezone").value = bot?.timezone || "America/Sao_Paulo";
  renderChannelsChecklist(bot?.channels || []);
  $("#bot-category").innerHTML = categoryOptions(bot?.defaultCategoryId || "");
  $("#bot-low-confidence").value = bot?.lowConfidenceThreshold ?? 0.55;
  $("#bot-high-confidence").value = bot?.highConfidenceThreshold ?? 0.8;
  $("#bot-initial").value = bot?.initialMessage || "";
  $("#bot-outside").value = bot?.outsideHoursMessage || "";
  $("#bot-holiday").value = bot?.holidayMessage || "";
  $("#bot-fallback").value = bot?.fallbackMessage || "";
  $("#bot-handoff").value = bot?.handoffMessage || "";
  $("#bot-run-new").checked = bot ? Boolean(bot.runOnNewConversation) : true;
  $("#bot-run-reopen").checked = bot ? Boolean(bot.runAfterReopen) : true;

  $("#bot-introduce").checked = Boolean(bot?.introduceWithName);
  $("#bot-reintroduce").checked = bot ? Boolean(bot.reintroduceOnNewSession) : true;
  $("#bot-presentation").value = bot?.presentationMessage || "";

  $("#flag-autoReplyEnabled").checked = Boolean(bot?.autoReplyEnabled);
  $("#flag-toolsEnabled").checked = Boolean(bot?.toolsEnabled);
  $("#flag-ratingEnabled").checked = Boolean(bot?.ratingEnabled);
  const flags = bot?.featureFlags || {};
  for (const key of booleanFeatureFlags) {
    $(`#flag-${key}`).checked = flags[key] !== undefined ? Boolean(flags[key]) : defaultBooleanFeatureFlags[key];
  }
  for (const [key, fallback] of Object.entries(numericFeatureFlags)) {
    $(`#flag-${key}`).value = flags[key] ?? fallback;
  }
  $("#flag-externalAiProvider").value = flags.externalAiProvider || defaultExternalAiProvider;
  $("#flag-externalAiModel").value = flags.externalAiModel || "";

  $("#rating-enabled").checked = Boolean(bot?.ratingEnabled);
  $("#rating-request-comment").checked = Boolean(bot?.requestRatingComment);
  $("#rating-request-on").value = bot?.requestRatingOn || "BOT_COMPLETED";
  $("#rating-message").value = bot?.ratingMessage || "";
  $("#rating-followup").value = bot?.ratingFollowupMessage || "";
}

function renderEditor() {
  const bot = state.selected;
  $("#empty-state").hidden = Boolean(bot) || $("#editor").dataset.creating === "true";
  $("#editor").hidden = !bot && $("#editor").dataset.creating !== "true";
  if (!bot) return;
  $("#editor").dataset.creating = "false";
  $("#editor-eyebrow").textContent = "BOT SELECIONADO";
  $("#editor-title").textContent = bot.name;
  $("#editor-description").textContent = bot.description || "Configuração administrativa isolada do atendimento real.";
  $("#status-actions").hidden = false;
  $("#status-badge").textContent = statusLabels[bot.status];
  $("#status-badge").className = `status-badge ${bot.status}`;
  document.querySelectorAll(".requires-bot").forEach((element) => { element.hidden = false; });
  // Bot de sistema (item "Bot de Sistema"): ativar/desativar continua
  // liberado, só a exclusão/arquivamento fica bloqueada na UI (o backend
  // também recusa em bot-service.archiveBot, essa é só a UX correspondente).
  $("#system-bot-badge").hidden = !bot.isSystem;
  $("#archive-bot").hidden = Boolean(bot.isSystem);
  const isTriage = bot.type === "SYSTEM_TRIAGE";
  $("#triage-only-fields").hidden = !isTriage;
  $("#triage-only-config").hidden = !isTriage;
  $("#triage-options-card").hidden = !isTriage;
  $("#triage-holidays-card").hidden = !isTriage;
  fillBotForm(bot);
  $("#intent-category").innerHTML = categoryOptions();
  $("#triage-option-category").innerHTML = triageCategoryOptions();
  renderSchedules(bot.schedules);
  if (isTriage) renderHolidays();
  renderIntents();
  renderGuidedConfig();
  if (isTriage) renderTriageOptions();
  renderBotList();
  renderAiProviderStatus();
}

// Item 3: popula o select "Provider de IA externa" só com providers
// REALMENTE implementados (LOCAL/ANTHROPIC/GEMINI) — nunca uma lista solta
// digitada na UI, sempre a mesma lista canônica do backend
// (AI_PROVIDER_OPTIONS em bot-constants.js).
const providerLabels = { LOCAL: "Local (sem IA externa)", ANTHROPIC: "Anthropic (Claude)", GEMINI: "Google Gemini", OPENAI: "OpenAI" };
async function ensureAiProviderOptionsLoaded() {
  if (state.aiProviderOptions) return state.aiProviderOptions;
  try {
    state.aiProviderOptions = await api("/api/bot-ai-providers");
  } catch {
    state.aiProviderOptions = ["LOCAL"];
  }
  $("#flag-externalAiProvider").innerHTML = state.aiProviderOptions
    .map((provider) => `<option value="${escapeHtml(provider)}">${escapeHtml(providerLabels[provider] || provider)}</option>`).join("");
  return state.aiProviderOptions;
}

// Item 5/14 (Motor de IA / Fallback externo): mostra provider/configurado/
// erro sem nunca expor a credencial — sempre do provider selecionado no
// select acima. O botão "Testar conexão" faz uma chamada real mínima, só
// quando o Master clicar (nunca automático).
async function renderAiProviderStatus() {
  const box = document.getElementById("ai-provider-status");
  if (!box) return;
  const provider = $("#flag-externalAiProvider").value || defaultExternalAiProvider;
  try {
    const status = await api(`/api/bot-ai-provider-status?provider=${encodeURIComponent(provider)}`);
    box.innerHTML = `
      <span>Provider<strong>${escapeHtml(providerLabels[status.provider] || status.provider)}</strong></span>
      <span>Status<strong>${status.configured ? "Configurado" : "Não configurado"}</strong></span>
      ${status.error ? `<span>Erro<strong>${escapeHtml(status.error)}</strong></span>` : ""}
    `;
  } catch (error) {
    box.innerHTML = `<span>Provider<strong>Indisponível</strong></span>`;
  }
}
document.getElementById("flag-externalAiProvider")?.addEventListener("change", renderAiProviderStatus);
function personalityListToText(items = []) {
  return Array.isArray(items) ? items.join("\n") : "";
}

function personalityTextToList(value) {
  return String(value || "").split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

function renderPersonalityCopySources() {
  const select = $("#personality-copy-source");
  select.innerHTML = '<option value="">Selecione...</option>' + state.bots
    .filter((bot) => bot.id !== state.selected?.id)
    .map((bot) => `<option value="${escapeHtml(bot.id)}">${escapeHtml(bot.name)}</option>`).join("");
}

async function ensurePersonalityPresetsLoaded() {
  if (!state.personalityPresets) state.personalityPresets = await api("/api/bot-personality-presets");
  $("#personality-preset").innerHTML = state.personalityPresets
    .map((item) => `<option value="${escapeHtml(item.preset)}">${escapeHtml(item.label)}</option>`).join("");
}

function fillPersonalityForm(configuration) {
  const current = configuration.effective || {};
  $("#personality-status").textContent = configuration.isDefault ? "Padr\u00e3o Mibro herdado" : "Personalidade pr\u00f3pria";
  $("#personality-status").classList.toggle("is-default", Boolean(configuration.isDefault));
  $("#personality-preset").value = current.preset || "PERSONALIZADO";
  $("#personality-assistant-name").value = current.assistantName || "";
  $("#personality-role").value = current.roleDescription || "";
  $("#personality-tone").value = personalityListToText(current.tone);
  $("#personality-style").value = personalityListToText(current.responseStyle);
  $("#personality-mandatory").value = personalityListToText(current.mandatoryBehaviors);
  $("#personality-forbidden").value = personalityListToText(current.forbiddenBehaviors);
  $("#personality-additional").value = current.additionalInstructions || "";
  $("#personality-response-length").value = current.responseLength || "MEDIUM";
  $("#apply-personality-preset").disabled = $("#personality-preset").value === "PERSONALIZADO";
  renderPersonalityCopySources();
}

async function loadPersonality() {
  if (!state.selected) return;
  const botId = state.selected.id;
  $("#personality-status").textContent = "Carregando";
  try {
    await ensurePersonalityPresetsLoaded();
    const configuration = await api(`/api/bots/${encodeURIComponent(botId)}/personality`);
    if (state.selected?.id === botId) fillPersonalityForm(configuration);
  } catch (error) {
    $("#personality-status").textContent = "Indispon\u00edvel";
    toast(error.message, true);
  }
}

function personalityPayload() {
  return {
    preset: "PERSONALIZADO",
    assistantName: $("#personality-assistant-name").value || null,
    roleDescription: $("#personality-role").value || null,
    tone: personalityTextToList($("#personality-tone").value),
    responseStyle: personalityTextToList($("#personality-style").value),
    mandatoryBehaviors: personalityTextToList($("#personality-mandatory").value),
    forbiddenBehaviors: personalityTextToList($("#personality-forbidden").value),
    additionalInstructions: $("#personality-additional").value || null,
    responseLength: $("#personality-response-length").value,
  };
}

$("#personality-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api(`/api/bots/${state.selected.id}/personality`, { method: "PUT", body: JSON.stringify(personalityPayload()) });
    toast("Personalidade atualizada.");
    await loadPersonality();
  } catch (error) { toast(error.message, true); }
});

$("#personality-preset").addEventListener("change", () => {
  $("#apply-personality-preset").disabled = $("#personality-preset").value === "PERSONALIZADO";
});

$("#apply-personality-preset").addEventListener("click", async () => {
  const preset = $("#personality-preset").value;
  if (!preset || preset === "PERSONALIZADO") return toast("Selecione um preset pronto.", true);
  if (!window.confirm("Aplicar este preset substituir\u00e1 todos os campos atuais da personalidade. Continuar?")) return;
  try {
    await api(`/api/bots/${state.selected.id}/personality/preset`, { method: "POST", body: JSON.stringify({ preset }) });
    toast("Preset aplicado.");
    await loadPersonality();
  } catch (error) { toast(error.message, true); }
});

$("#copy-personality").addEventListener("click", async () => {
  const sourceBotId = $("#personality-copy-source").value;
  if (!sourceBotId) return toast("Selecione o Bot de origem.", true);
  if (!window.confirm("Copiar a personalidade substituir\u00e1 todos os campos atuais. Continuar?")) return;
  try {
    await api(`/api/bots/${state.selected.id}/personality/copy`, { method: "POST", body: JSON.stringify({ sourceBotId }) });
    toast("Personalidade copiada.");
    await loadPersonality();
  } catch (error) { toast(error.message, true); }
});

$("#personality-form").addEventListener("input", (event) => {
  if (event.target.id === "personality-preset") return;
  $("#personality-preset").value = "PERSONALIZADO";
  $("#apply-personality-preset").disabled = true;
});

document.getElementById("test-ai-provider")?.addEventListener("click", async () => {
  if (!window.confirm("Este teste fará uma chamada real e poderá gerar um pequeno custo no provider de IA. Deseja continuar?")) return;
  const button = document.getElementById("test-ai-provider");
  const provider = $("#flag-externalAiProvider").value || defaultExternalAiProvider;
  button.disabled = true;
  try {
    const result = await api("/api/bot-ai-provider-status/test", { method: "POST", body: JSON.stringify({ confirmRealCall: true, provider }) });
    toast(result.ok ? `Conexão OK (${result.latencyMs}ms).` : `Falha: ${result.error}`, !result.ok);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

// ===== Cofre de credenciais de IA (aba "Chaves de IA", só Master) =====
// Global: uma credencial por provider para toda a instalação — nunca
// mostra a chave inteira, só os últimos 4 caracteres.
async function loadAiKeys() {
  const box = document.getElementById("ai-keys-list");
  if (!box) return;
  box.innerHTML = "<p>Carregando...</p>";
  try {
    const list = await api("/api/bot-ai-credentials");
    box.innerHTML = list.map((item) => `
      <article class="learning-card" data-ai-key-provider="${escapeHtml(item.provider)}">
        <header>
          <b>${escapeHtml(providerLabels[item.provider] || item.provider)}</b>
          <span class="learning-type ${item.configured ? "" : "learning-conflict"}">${item.configured ? "Configurado" : "Não configurado"}</span>
        </header>
        <p class="learning-meta">
          ${item.configured ? `Terminada em ••••${escapeHtml(item.lastFour || "")} · origem: ${escapeHtml(item.source === "PAINEL" ? "Painel" : "Variável de ambiente")}` : "Nenhuma chave cadastrada."}
          ${item.defaultModel ? ` · modelo padrão: ${escapeHtml(item.defaultModel)}` : ""}
          ${item.updatedBy ? ` · alterado por ${escapeHtml(item.updatedBy)} em ${new Date(item.updatedAt).toLocaleString("pt-BR")}` : ""}
        </p>
        <div class="learning-actions">
          <input type="password" placeholder="Nova API Key" data-ai-key-input maxlength="4000" style="flex:1;min-width:180px">
          <input type="text" placeholder="Modelo padrão (opcional)" data-ai-key-model maxlength="120" style="width:180px">
          <button type="button" data-ai-key-save>Salvar / substituir</button>
          ${item.source === "PAINEL" ? '<button type="button" class="secondary" data-ai-key-remove>Remover</button>' : ""}
          <button type="button" class="secondary" data-ai-key-test>Testar conexão</button>
        </div>
      </article>
    `).join("");

    document.querySelectorAll("[data-ai-key-save]").forEach((button) => button.addEventListener("click", async () => {
      const card = button.closest("[data-ai-key-provider]");
      const provider = card.dataset.aiKeyProvider;
      const apiKey = card.querySelector("[data-ai-key-input]").value;
      const defaultModel = card.querySelector("[data-ai-key-model]").value;
      if (!apiKey.trim()) { toast("Informe a API Key.", true); return; }
      try {
        await api(`/api/bot-ai-credentials/${encodeURIComponent(provider)}`, { method: "PUT", body: JSON.stringify({ apiKey, defaultModel: defaultModel || null }) });
        toast("Chave salva.");
        await loadAiKeys();
      } catch (error) { toast(error.message, true); }
    }));

    document.querySelectorAll("[data-ai-key-remove]").forEach((button) => button.addEventListener("click", async () => {
      const card = button.closest("[data-ai-key-provider]");
      const provider = card.dataset.aiKeyProvider;
      if (!window.confirm(`Remover a chave de API do ${provider}? Bots configurados para usá-lo deixarão de ter fallback externo até uma nova chave ser cadastrada.`)) return;
      try {
        await api(`/api/bot-ai-credentials/${encodeURIComponent(provider)}`, { method: "DELETE" });
        toast("Chave removida.");
        await loadAiKeys();
      } catch (error) { toast(error.message, true); }
    }));

    document.querySelectorAll("[data-ai-key-test]").forEach((button) => button.addEventListener("click", async () => {
      if (!window.confirm("Este teste fará uma chamada real e poderá gerar um pequeno custo no provider de IA. Deseja continuar?")) return;
      const card = button.closest("[data-ai-key-provider]");
      const provider = card.dataset.aiKeyProvider;
      button.disabled = true;
      try {
        const result = await api("/api/bot-ai-provider-status/test", { method: "POST", body: JSON.stringify({ confirmRealCall: true, provider }) });
        toast(result.ok ? `Conexão OK (${result.latencyMs}ms).` : `Falha: ${result.error}`, !result.ok);
      } catch (error) {
        toast(error.message, true);
      } finally {
        button.disabled = false;
      }
    }));
  } catch (error) {
    box.innerHTML = `<div class="intent-empty">Não foi possível carregar (${escapeHtml(error.message)}).</div>`;
  }
}

async function loadBots(selectId = state.selected?.id) {
  const bots = await api("/api/bots");
  state.bots = MARKETPLACE_UI_ENABLED ? bots : bots.filter((bot) => !isMarketplaceChannel(bot.channel));
  renderBotList();
  if (selectId && state.bots.some((bot) => bot.id === selectId)) await selectBot(selectId);
  else if (state.bots.length) await selectBot(state.bots[0].id);
  else if (!state.bots.length) {
    state.selected = null;
    $("#editor").dataset.creating = "false";
    $("#editor").hidden = true;
    $("#empty-state").hidden = false;
  }
}

function resetSimulator() {
  state.simulatorHistory = [];
  state.simulatorState = null;
  $("#simulator-transcript").innerHTML = "";
  $("#simulator-result").innerHTML = "<p>O resultado da simulação aparecerá aqui.</p>";
  const localAi = document.getElementById("simulator-local-ai");
  if (localAi) { localAi.hidden = true; localAi.innerHTML = ""; }
  const flowInfo = document.getElementById("simulator-flow-info");
  if (flowInfo) { flowInfo.hidden = true; flowInfo.innerHTML = ""; }
}

function renderSimulatorCategory() {
  const field = document.getElementById("simulator-category-field");
  const select = document.getElementById("simulator-category");
  if (!field || !select) return;
  const enabled = state.selected?.id === "mibro-assistant-observer";
  field.hidden = !enabled;
  select.required = enabled;
  const supported = new Set(["SUPORTE", "ATENDIMENTO", "COMERCIAL", "PARCERIAS"]);
  const eligible = state.categories.filter((category) => {
    const parent = state.categories.find((item) => item.id === category.parentId);
    return category.active !== false && (
      supported.has(String(category.code || category.name || "").toUpperCase())
      || supported.has(String(parent?.code || parent?.name || "").toUpperCase())
    );
  });
  select.innerHTML = `<option value="">Selecione o setor</option>${eligible
    .map((category) => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)}</option>`)
    .join("")}`;
}

async function selectBot(botId) {
  state.selected = await api(`/api/bots/${encodeURIComponent(botId)}`);
  try { state.guidedConfig = await api(`/api/bots/${encodeURIComponent(botId)}/guided-config`); }
  catch { state.guidedConfig = { responseBlocks: [], synonymGroups: [] }; }
  closeIntentForm();
  closeTriageOptionForm();
  resetSimulator();
  renderEditor();
  renderSimulatorCategory();
  await loadPersonality();
}

function startNewBot() {
  state.selected = null;
  $("#editor").dataset.creating = "true";
  $("#empty-state").hidden = true;
  $("#editor").hidden = false;
  $("#editor-eyebrow").textContent = "NOVO BOT";
  $("#editor-title").textContent = "Criar Bot";
  $("#editor-description").textContent = "O novo Bot começará como rascunho e permanecerá desconectado do webhook.";
  $("#status-actions").hidden = true;
  $("#system-bot-badge").hidden = true;
  $("#triage-only-fields").hidden = true;
  $("#triage-only-config").hidden = true;
  document.querySelectorAll(".requires-bot").forEach((element) => { element.hidden = true; });
  fillBotForm();
  setConfigSection("general");
  renderBotList();
}

function botPayload() {
  const featureFlags = {};
  for (const key of booleanFeatureFlags) featureFlags[key] = $(`#flag-${key}`).checked;
  for (const key of Object.keys(numericFeatureFlags)) featureFlags[key] = Number($(`#flag-${key}`).value);
  featureFlags.externalAiProvider = $("#flag-externalAiProvider").value || defaultExternalAiProvider;
  featureFlags.externalAiModel = $("#flag-externalAiModel").value.trim();
  return {
    name: $("#bot-name").value,
    description: $("#bot-description").value,
    channel: $("#bot-channel").value,
    channels: Array.from(document.querySelectorAll("#bot-channels-checklist input:checked")).map((input) => input.value),
    timezone: $("#bot-timezone").value,
    defaultCategoryId: $("#bot-category").value || null,
    lowConfidenceThreshold: Number($("#bot-low-confidence").value),
    highConfidenceThreshold: Number($("#bot-high-confidence").value),
    initialMessage: $("#bot-initial").value,
    outsideHoursMessage: $("#bot-outside").value,
    holidayMessage: $("#bot-holiday").value || null,
    fallbackMessage: $("#bot-fallback").value,
    handoffMessage: $("#bot-handoff").value || null,
    runOnNewConversation: $("#bot-run-new").checked,
    runAfterReopen: $("#bot-run-reopen").checked,
    introduceWithName: $("#bot-introduce").checked,
    reintroduceOnNewSession: $("#bot-reintroduce").checked,
    presentationMessage: $("#bot-presentation").value || null,
    autoReplyEnabled: $("#flag-autoReplyEnabled").checked,
    toolsEnabled: $("#flag-toolsEnabled").checked,
    ratingEnabled: $("#flag-ratingEnabled").checked,
    featureFlags,
  };
}

function closeIntentForm() {
  $("#intent-form").hidden = true;
  $("#intent-form").reset();
  $("#intent-id").value = "";
  $("#intent-priority").value = "0";
  $("#intent-active").checked = true;
  $("#intent-flow-section").hidden = true;
  closeFlowStepForm();
  state.flowSteps = [];
}

async function editIntent(intentId) {
  const intent = state.selected.intents.find((item) => item.id === intentId);
  if (!intent) return;
  $("#intent-id").value = intent.id;
  $("#intent-name").value = intent.name;
  $("#intent-description").value = intent.description || "";
  $("#intent-response").value = intent.responseMessage || "";
  $("#intent-priority").value = intent.priority;
  $("#intent-action").value = intent.fallbackAction;
  $("#intent-category").innerHTML = categoryOptions(intent.categoryId || "");
  $("#intent-examples").value = intent.examples.map(({ text }) => text).join("\n");
  $("#intent-active").checked = intent.active;
  $("#intent-form").hidden = false;
  $("#intent-name").focus();

  // Item 7 (UI): "Fluxo de atendimento" só existe para intenções já salvas
  // (as etapas pertencem a um intentId real).
  $("#intent-flow-section").hidden = false;
  closeFlowStepForm();
  try {
    await Promise.all([loadFlowSteps(intentId), ensureToolsLoaded(), ensureKnowledgeSourcesLoaded()]);
    populateFlowStepSelects();
  } catch (error) { toast(error.message, true); }
}

async function removeIntent(intentId) {
  if (!confirm("Remover esta intenção?")) return;
  try {
    await api(`/api/bots/${state.selected.id}/intents/${intentId}`, { method: "DELETE" });
    toast("Intenção removida.");
    await selectBot(state.selected.id);
  } catch (error) { toast(error.message, true); }
}

// ===== Opções de triagem (Bot de Triagem) =====
// PUT /triage-options substitui a lista inteira (mesmo padrão de
// replaceSchedules) — toda mutação (adicionar/editar/excluir/reordenar/
// habilitar) monta a lista completa em memória e envia de uma vez.

function renderTriageOptions() {
  const options = state.selected?.triageOptions || [];
  $("#triage-option-list").innerHTML = options.length ? options.map((option, index) => `
    <article class="intent-card triage-option-card ${option.category?.parentId ? "triage-option-child" : "triage-option-parent"} ${options.some((child) => child.category?.parentId === option.categoryId) ? "has-children" : ""} ${option.enabled ? "" : "inactive"}" style="--triage-color:${/^#[\da-f]{6}$/i.test(option.category?.color || "") ? option.category.color : "#ef5b2a"}">
      <div><b>${option.order}. ${escapeHtml(option.label)}</b><small>${escapeHtml(option.category?.name || "Categoria removida")}${option.description ? ` • ${escapeHtml(option.description)}` : ""}${option.enabled ? "" : " • desabilitada"}</small></div>
      <div>
        <button type="button" data-move-triage-option="${escapeHtml(option.id)}" data-direction="up" ${index === 0 ? "disabled" : ""}>&uarr;</button>
        <button type="button" data-move-triage-option="${escapeHtml(option.id)}" data-direction="down" ${index === options.length - 1 ? "disabled" : ""}>&darr;</button>
        <button type="button" data-edit-triage-option="${escapeHtml(option.id)}">Editar</button>
        <button type="button" data-delete-triage-option="${escapeHtml(option.id)}">Excluir</button>
      </div>
    </article>
  `).join("") : '<div class="intent-empty">Nenhuma opção configurada — a triagem usará a mensagem de fallback.</div>';
  document.querySelectorAll("[data-edit-triage-option]").forEach((button) => button.addEventListener("click", () => editTriageOption(button.dataset.editTriageOption)));
  document.querySelectorAll("[data-delete-triage-option]").forEach((button) => button.addEventListener("click", () => removeTriageOption(button.dataset.deleteTriageOption)));
  document.querySelectorAll("[data-move-triage-option]").forEach((button) => button.addEventListener("click", () => moveTriageOption(button.dataset.moveTriageOption, button.dataset.direction)));
}

function closeTriageOptionForm() {
  $("#triage-option-form").hidden = true;
  $("#triage-subcategory-field").hidden = true;
  $("#triage-subcategory-options").innerHTML = "";
  $("#triage-option-form").reset();
  $("#triage-option-id").value = "";
  $("#triage-option-order").value = String(((state.selected?.triageOptions || []).length + 1) * 10);
  $("#triage-option-enabled").checked = true;
}

function editTriageOption(optionId) {
  const option = state.selected.triageOptions.find((item) => item.id === optionId);
  if (!option) return;
  $("#triage-option-id").value = option.id;
  $("#triage-option-label").value = option.label;
  $("#triage-option-description").value = option.description || "";
  $("#triage-option-order").value = option.order;
  $("#triage-option-category").innerHTML = triageCategoryOptions(option.categoryId);
  renderTriageSubcategoryChoices(option.categoryId);
  $("#triage-option-enabled").checked = option.enabled;
  $("#triage-option-form").hidden = false;
  $("#triage-option-label").focus();
}

// Envia sempre a lista completa (existentes + a alteração atual) para
// PUT /triage-options — a resposta já vem com os ids reais, então
// recarregamos o Bot inteiro para manter tudo (schedules/intents/opções)
// sincronizado, igual ao padrão do resto da tela.
async function saveTriageOptionsList(options) {
  try {
    await api(`/api/bots/${state.selected.id}/triage-options`, {
      method: "PUT", body: JSON.stringify({ options }),
    });
    toast("Opções de triagem atualizadas.");
    await selectBot(state.selected.id);
  } catch (error) { toast(error.message, true); }
}

function triageOptionToPayload(option) {
  return {
    categoryId: option.categoryId, label: option.label, description: option.description || null,
    enabled: option.enabled, order: option.order,
  };
}

async function removeTriageOption(optionId) {
  if (!confirm("Remover esta opção de triagem?")) return;
  const remaining = state.selected.triageOptions.filter((item) => item.id !== optionId).map(triageOptionToPayload);
  await saveTriageOptionsList(remaining);
}

async function moveTriageOption(optionId, direction) {
  const options = [...state.selected.triageOptions].sort((left, right) => left.order - right.order);
  const index = options.findIndex((item) => item.id === optionId);
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || targetIndex < 0 || targetIndex >= options.length) return;
  const orders = options.map((item) => item.order);
  [orders[index], orders[targetIndex]] = [orders[targetIndex], orders[index]];
  const payload = options.map((item, position) => ({ ...triageOptionToPayload(item), order: orders[position] }));
  await saveTriageOptionsList(payload);
}

// ===== Fluxo de atendimento (Flow Engine) =====

function renderGuidedConfig() {
  const blocks = state.guidedConfig?.responseBlocks || [];
  const groups = state.guidedConfig?.synonymGroups || [];
  const blockList = $("#response-block-list");
  const synonymList = $("#synonym-list");
  if (!blockList || !synonymList) return;
  blockList.innerHTML = blocks.length ? blocks.map((block) => `<article class="intent-card ${block.active ? "" : "inactive"}"><div><b>${escapeHtml(block.code)}</b><small>${escapeHtml(block.name)} • ${escapeHtml(block.kind)}</small></div><div><button type="button" data-edit-response-block="${escapeHtml(block.id)}">Editar</button><button type="button" data-delete-response-block="${escapeHtml(block.id)}">Excluir</button></div></article>`).join("") : '<div class="intent-empty">Nenhum bloco configurado.</div>';
  synonymList.innerHTML = groups.length ? groups.map((group) => `<article class="intent-card ${group.active ? "" : "inactive"}"><div><b>${escapeHtml(group.key)}</b><small>${escapeHtml(group.terms.join(", "))}</small></div><div><button type="button" data-edit-synonym="${escapeHtml(group.id)}">Editar</button><button type="button" data-delete-synonym="${escapeHtml(group.id)}">Excluir</button></div></article>`).join("") : '<div class="intent-empty">Nenhum grupo configurado.</div>';
  document.querySelectorAll("[data-edit-response-block]").forEach((button) => button.addEventListener("click", () => openResponseBlockForm(button.dataset.editResponseBlock)));
  document.querySelectorAll("[data-delete-response-block]").forEach((button) => button.addEventListener("click", () => deleteGuidedResource("response-blocks", button.dataset.deleteResponseBlock)));
  document.querySelectorAll("[data-edit-synonym]").forEach((button) => button.addEventListener("click", () => openSynonymForm(button.dataset.editSynonym)));
  document.querySelectorAll("[data-delete-synonym]").forEach((button) => button.addEventListener("click", () => deleteGuidedResource("synonyms", button.dataset.deleteSynonym)));
}

async function reloadGuidedConfig() {
  state.guidedConfig = await api(`/api/bots/${state.selected.id}/guided-config`);
  renderGuidedConfig();
  populateFlowStepSelects();
}

function closeResponseBlockForm() { $("#response-block-form").hidden = true; $("#response-block-form").reset(); $("#response-block-id").value = ""; }
function openResponseBlockForm(id = "") {
  const block = (state.guidedConfig.responseBlocks || []).find((item) => item.id === id);
  $("#response-block-id").value = block?.id || ""; $("#response-block-code").value = block?.code || "";
  $("#response-block-name").value = block?.name || ""; $("#response-block-kind").value = block?.kind || "RESPONSE";
  $("#response-block-content").value = block?.content || ""; $("#response-block-active").checked = block ? block.active : true;
  $("#response-block-form").hidden = false; $("#response-block-code").focus();
}
function closeSynonymForm() { $("#synonym-form").hidden = true; $("#synonym-form").reset(); $("#synonym-id").value = ""; }
function openSynonymForm(id = "") {
  const group = (state.guidedConfig.synonymGroups || []).find((item) => item.id === id);
  $("#synonym-id").value = group?.id || ""; $("#synonym-key").value = group?.key || "";
  $("#synonym-label").value = group?.label || ""; $("#synonym-terms").value = (group?.terms || []).join(", ");
  $("#synonym-active").checked = group ? group.active : true; $("#synonym-form").hidden = false; $("#synonym-key").focus();
}
async function deleteGuidedResource(resource, id) {
  if (!confirm("Excluir esta configuração?")) return;
  try { await api(`/api/bots/${state.selected.id}/${resource}/${id}`, { method: "DELETE" }); await reloadGuidedConfig(); toast("Configuração removida."); }
  catch (error) { toast(error.message, true); }
}

$("#new-response-block").addEventListener("click", () => openResponseBlockForm());
$("#cancel-response-block").addEventListener("click", closeResponseBlockForm);
$("#response-block-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const id = $("#response-block-id").value;
  const body = { code: $("#response-block-code").value, name: $("#response-block-name").value, kind: $("#response-block-kind").value, content: $("#response-block-content").value, active: $("#response-block-active").checked };
  try { await api(`/api/bots/${state.selected.id}/response-blocks${id ? `/${id}` : ""}`, { method: id ? "PATCH" : "POST", body: JSON.stringify(body) }); closeResponseBlockForm(); await reloadGuidedConfig(); toast("Bloco salvo."); }
  catch (error) { toast(error.message, true); }
});
$("#new-synonym").addEventListener("click", () => openSynonymForm());
$("#cancel-synonym").addEventListener("click", closeSynonymForm);
$("#synonym-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const id = $("#synonym-id").value;
  const body = { key: $("#synonym-key").value, label: $("#synonym-label").value, terms: $("#synonym-terms").value.split(",").map((item) => item.trim()).filter(Boolean), active: $("#synonym-active").checked };
  try { await api(`/api/bots/${state.selected.id}/synonyms${id ? `/${id}` : ""}`, { method: id ? "PATCH" : "POST", body: JSON.stringify(body) }); closeSynonymForm(); await reloadGuidedConfig(); toast("Sinônimos salvos."); }
  catch (error) { toast(error.message, true); }
});

async function ensureToolsLoaded() {
  if (state.tools.length) return state.tools;
  try { state.tools = await api("/api/bot-tools"); } catch { state.tools = []; }
  return state.tools;
}

async function ensureKnowledgeSourcesLoaded() {
  try {
    state.knowledgeSources = await api(`/api/knowledge-sources?botId=${encodeURIComponent(state.selected.id)}&active=true`);
  } catch { state.knowledgeSources = []; }
  return state.knowledgeSources;
}

function renderFlowSteps() {
  const intentId = $("#intent-id").value;
  const steps = state.flowSteps;
  $("#flow-step-list").innerHTML = steps.length ? steps.map((step) => `
    <article class="intent-card ${step.active ? "" : "inactive"}">
      <div><b>${step.order}. ${escapeHtml(step.name)}</b><small>${escapeHtml(flowActionLabels[step.action] || step.action)}${step.entityKey ? ` • entidade: ${escapeHtml(step.entityKey)}` : ""}</small></div>
      <div><button type="button" data-edit-flow-step="${escapeHtml(step.id)}">Editar</button><button type="button" data-delete-flow-step="${escapeHtml(step.id)}">Excluir</button></div>
    </article>
  `).join("") : '<div class="intent-empty">Nenhuma etapa configurada — a intenção responde uma única vez, como hoje.</div>';
  document.querySelectorAll("[data-edit-flow-step]").forEach((button) => button.addEventListener("click", () => openFlowStepForm(button.dataset.editFlowStep)));
  document.querySelectorAll("[data-delete-flow-step]").forEach((button) => button.addEventListener("click", () => removeFlowStep(button.dataset.deleteFlowStep)));
  populateFlowStepSelects(intentId);
}

async function loadFlowSteps(intentId) {
  state.flowSteps = await api(`/api/bots/${state.selected.id}/intents/${intentId}/flow-steps`);
  state.flowStepsCache.set(intentId, state.flowSteps);
  renderFlowSteps();
}

function populateFlowStepSelects(currentStepId) {
  const stepOptions = (placeholder) => `<option value="">${placeholder}</option>` + state.flowSteps
    .filter((step) => step.id !== $("#flow-step-id").value)
    .map((step) => `<option value="${escapeHtml(step.id)}" ${step.id === currentStepId ? "" : ""}>${step.order}. ${escapeHtml(step.name)}</option>`).join("");
  $("#flow-step-next").innerHTML = stepOptions("Encerra o fluxo");
  $("#flow-step-on-success").innerHTML = stepOptions('Usar "Próxima etapa"');
  $("#flow-step-on-failure").innerHTML = stepOptions('Usar "Próxima etapa"');
  $("#flow-step-goto").innerHTML = `<option value="">Selecione</option>` + state.flowSteps
    .filter((step) => step.id !== $("#flow-step-id").value)
    .map((step) => `<option value="${escapeHtml(step.id)}">${step.order}. ${escapeHtml(step.name)}</option>`).join("");
  $("#flow-step-knowledge").innerHTML = `<option value="">Buscar automaticamente pela intenção</option>` + state.knowledgeSources
    .map((source) => `<option value="${escapeHtml(source.id)}">${escapeHtml(source.title)}</option>`).join("");
  $("#flow-step-tool").innerHTML = `<option value="">Nenhuma</option>` + state.tools
    .map((tool) => `<option value="${escapeHtml(tool.name)}">${escapeHtml(tool.name)}${tool.enabled ? "" : " (desativada)"}</option>`).join("");
  $("#flow-step-block").innerHTML = `<option value="">Nenhum</option>` + (state.guidedConfig.responseBlocks || [])
    .filter((block) => block.active).map((block) => `<option value="${escapeHtml(block.id)}">${escapeHtml(block.code)} — ${escapeHtml(block.name)}</option>`).join("");
}

function flowDestinationOptions(selected = "") {
  const intentOptions = (state.selected?.intents || []).map((intent) => `<option value="intent:${escapeHtml(intent.id)}" ${selected === `intent:${intent.id}` ? "selected" : ""}>Fluxo: ${escapeHtml(intent.name)}</option>`).join("");
  const stepOptions = state.flowSteps.filter((step) => step.id !== $("#flow-step-id").value).map((step) => `<option value="step:${escapeHtml(step.id)}" ${selected === `step:${step.id}` ? "selected" : ""}>Etapa: ${escapeHtml(step.name)}</option>`).join("");
  return `<option value="">Handoff</option>${intentOptions}${stepOptions}`;
}

function addFlowOptionRow(option = {}) {
  const row = document.createElement("div"); row.className = "flow-option-row";
  row.dataset.value = option.value || ""; row.dataset.conditions = JSON.stringify(option.conditions || {});
  const selected = option.targetIntentId ? `intent:${option.targetIntentId}` : option.nextStepId ? `step:${option.nextStepId}` : "";
  const conditionEntries = Object.entries(option.conditions || {});
  const [conditionKey = "", conditionValue = ""] = conditionEntries[0] || [];
  row.innerHTML = `<input class="flow-option-label" maxlength="120" placeholder="Nome da opção" value="${escapeHtml(option.label || "")}" required><input class="flow-option-aliases" placeholder="sinônimos separados por vírgula" value="${escapeHtml((option.aliases || []).join(", "))}"><select class="flow-option-destination">${flowDestinationOptions(selected)}</select><input class="flow-option-condition-key" maxlength="60" placeholder="Condição: campo (opcional)" value="${escapeHtml(conditionKey)}"><input class="flow-option-condition-value" maxlength="120" placeholder="Condição: valor" value="${escapeHtml(conditionValue)}"><button type="button" aria-label="Remover opção">×</button>`;
  row.querySelector("button").addEventListener("click", () => row.remove());
  $("#flow-option-list").appendChild(row);
}

function readFlowOptions() {
  return Array.from(document.querySelectorAll("#flow-option-list .flow-option-row")).map((row, index) => {
    const label = row.querySelector(".flow-option-label").value.trim();
    const destination = row.querySelector(".flow-option-destination").value;
    const conditionKey = row.querySelector(".flow-option-condition-key").value.trim();
    const conditionValue = row.querySelector(".flow-option-condition-value").value.trim();
    const conditions = conditionKey ? { [conditionKey]: conditionValue } : {};
    return { label, value: row.dataset.value || label, aliases: row.querySelector(".flow-option-aliases").value.split(",").map((item) => item.trim()).filter(Boolean), order: index, active: true, nextStepId: destination.startsWith("step:") ? destination.slice(5) : null, targetIntentId: destination.startsWith("intent:") ? destination.slice(7) : null, conditions };
  });
}

function flowStepFieldVisibility() {
  const action = $("#flow-step-action").value;
  document.querySelectorAll(".flow-field-question").forEach((el) => { el.hidden = !["ASK_QUESTION", "SHOW_OPTIONS"].includes(action); });
  document.querySelectorAll(".flow-field-knowledge").forEach((el) => { el.hidden = action !== "USE_KNOWLEDGE"; });
  document.querySelectorAll(".flow-field-tool").forEach((el) => { el.hidden = action !== "QUERY_TOOL"; });
  document.querySelectorAll(".flow-field-response").forEach((el) => { el.hidden = !["RESPOND", "RESOLVED", "HANDOFF_HUMAN"].includes(action); });
  document.querySelectorAll(".flow-field-block").forEach((el) => { el.hidden = !["ASK_QUESTION", "SHOW_OPTIONS", "USE_RESPONSE_BLOCK", "RESPOND", "RESOLVED", "HANDOFF_HUMAN"].includes(action); });
  document.querySelectorAll(".flow-field-options").forEach((el) => { el.hidden = action !== "SHOW_OPTIONS"; });
  document.querySelectorAll(".flow-field-goto").forEach((el) => { el.hidden = action !== "GOTO_STEP"; });
  $("#flow-step-question").required = action === "ASK_QUESTION";
  $("#flow-step-tool").required = action === "QUERY_TOOL";
  $("#flow-step-response").required = action === "RESPOND";
  $("#flow-step-goto").required = action === "GOTO_STEP";
}

function closeFlowStepForm() {
  $("#flow-step-form").hidden = true;
  $("#flow-step-form").reset();
  $("#flow-step-id").value = "";
  $("#flow-option-list").innerHTML = "";
}

function openFlowStepForm(stepId = "") {
  const step = stepId ? state.flowSteps.find((item) => item.id === stepId) : null;
  $("#flow-step-id").value = step?.id || "";
  $("#flow-step-name").value = step?.name || "";
  $("#flow-step-action").value = step?.action || "ASK_QUESTION";
  $("#flow-step-question").value = step?.question || "";
  $("#flow-step-entity-key").value = step?.entityKey || "";
  $("#flow-step-required").checked = step ? step.required : true;
  $("#flow-step-response").value = step?.responseMessage || "";
  $("#flow-step-max-attempts").value = step?.maxAttempts ?? 3;
  $("#flow-step-active").checked = step ? step.active : true;
  populateFlowStepSelects();
  $("#flow-step-knowledge").value = step?.knowledgeSourceId || "";
  $("#flow-step-block").value = step?.responseBlockId || "";
  $("#flow-step-tool").value = step?.toolName || "";
  $("#flow-step-next").value = step?.nextStepId || "";
  $("#flow-step-on-success").value = step?.onSuccessStepId || "";
  $("#flow-step-on-failure").value = step?.onFailureStepId || "";
  $("#flow-step-goto").value = step?.gotoStepId || "";
  $("#flow-option-list").innerHTML = "";
  (step?.options || []).forEach(addFlowOptionRow);
  flowStepFieldVisibility();
  $("#flow-step-form").hidden = false;
  $("#flow-step-name").focus();
}

async function removeFlowStep(stepId) {
  if (!confirm("Remover esta etapa do fluxo?")) return;
  const intentId = $("#intent-id").value;
  try {
    await api(`/api/bots/${state.selected.id}/intents/${intentId}/flow-steps/${stepId}`, { method: "DELETE" });
    toast("Etapa removida.");
    await loadFlowSteps(intentId);
  } catch (error) { toast(error.message, true); }
}

$("#flow-step-action").addEventListener("change", flowStepFieldVisibility);
$("#add-flow-option").addEventListener("click", () => addFlowOptionRow());
$("#new-flow-step").addEventListener("click", async () => {
  await Promise.all([ensureToolsLoaded(), ensureKnowledgeSourcesLoaded()]);
  openFlowStepForm();
});
$("#cancel-flow-step").addEventListener("click", closeFlowStepForm);

$("#flow-step-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const intentId = $("#intent-id").value;
  const stepId = $("#flow-step-id").value;
  const payload = {
    name: $("#flow-step-name").value,
    action: $("#flow-step-action").value,
    question: $("#flow-step-question").value || null,
    entityKey: $("#flow-step-entity-key").value || null,
    required: $("#flow-step-required").checked,
    knowledgeSourceId: $("#flow-step-knowledge").value || null,
    responseBlockId: $("#flow-step-block").value || null,
    toolName: $("#flow-step-tool").value || null,
    responseMessage: $("#flow-step-response").value || null,
    nextStepId: $("#flow-step-next").value || null,
    onSuccessStepId: $("#flow-step-on-success").value || null,
    onFailureStepId: $("#flow-step-on-failure").value || null,
    gotoStepId: $("#flow-step-goto").value || null,
    maxAttempts: Number($("#flow-step-max-attempts").value) || 3,
    active: $("#flow-step-active").checked,
    options: readFlowOptions(),
  };
  try {
    const url = stepId
      ? `/api/bots/${state.selected.id}/intents/${intentId}/flow-steps/${stepId}`
      : `/api/bots/${state.selected.id}/intents/${intentId}/flow-steps`;
    await api(url, { method: stepId ? "PATCH" : "POST", body: JSON.stringify(payload) });
    toast(stepId ? "Etapa atualizada." : "Etapa criada.");
    closeFlowStepForm();
    await loadFlowSteps(intentId);
  } catch (error) { toast(error.message, true); }
});

$("#bot-channel").addEventListener("change", () => {
  const checked = Array.from(document.querySelectorAll("#bot-channels-checklist input:checked")).map((input) => input.value);
  renderChannelsChecklist(checked);
});

$("#bot-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const bot = state.selected
      ? await api(`/api/bots/${state.selected.id}`, { method: "PATCH", body: JSON.stringify(botPayload()) })
      : await api("/api/bots", { method: "POST", body: JSON.stringify(botPayload()) });
    toast(state.selected ? "Bot atualizado." : "Bot criado como rascunho.");
    await loadBots(bot.id);
  } catch (error) { toast(error.message, true); }
});

$("#rating-config-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api(`/api/bots/${state.selected.id}/rating-config`, {
      method: "PATCH",
      body: JSON.stringify({
        ratingEnabled: $("#rating-enabled").checked,
        requestRatingComment: $("#rating-request-comment").checked,
        requestRatingOn: $("#rating-request-on").value,
        ratingMessage: $("#rating-message").value || null,
        ratingFollowupMessage: $("#rating-followup").value || null,
      }),
    });
    toast("Configuração de avaliação salva.");
    await selectBot(state.selected.id);
  } catch (error) { toast(error.message, true); }
});

$("#schedule-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const schedules = [...document.querySelectorAll(".schedule-row")].map((row) => ({
    dayOfWeek: Number(row.dataset.day),
    enabled: row.querySelector(".schedule-enabled").checked,
    startTime: row.querySelector(".schedule-start").value,
    endTime: row.querySelector(".schedule-end").value,
  }));
  try {
    await api(`/api/bots/${state.selected.id}/schedules`, { method: "PUT", body: JSON.stringify({ schedules }) });
    toast("Horários atualizados.");
    await selectBot(state.selected.id);
  } catch (error) { toast(error.message, true); }
});

$("#new-holiday").addEventListener("click", () => {
  closeHolidayForm();
  $("#holiday-form").hidden = false;
  $("#holiday-date").focus();
});
$("#cancel-holiday").addEventListener("click", closeHolidayForm);
$("#holiday-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const originalDate = $("#holiday-original-date").value;
  const draft = { date: $("#holiday-date").value, name: $("#holiday-name").value, enabled: $("#holiday-enabled").checked };
  const current = (state.selected.holidays || []).filter((item) => item.date !== originalDate).map(holidayPayload);
  closeHolidayForm();
  await saveHolidaysList([...current, draft]);
});

$("#intent-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const intentId = $("#intent-id").value;
  const payload = {
    name: $("#intent-name").value,
    description: $("#intent-description").value,
    responseMessage: $("#intent-response").value,
    priority: Number($("#intent-priority").value),
    active: $("#intent-active").checked,
    fallbackAction: $("#intent-action").value,
    categoryId: $("#intent-category").value || null,
    examples: $("#intent-examples").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  };
  try {
    const url = intentId ? `/api/bots/${state.selected.id}/intents/${intentId}` : `/api/bots/${state.selected.id}/intents`;
    await api(url, { method: intentId ? "PATCH" : "POST", body: JSON.stringify(payload) });
    toast(intentId ? "Intenção atualizada." : "Intenção criada.");
    closeIntentForm();
    await selectBot(state.selected.id);
  } catch (error) { toast(error.message, true); }
});

$("#triage-option-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const optionId = $("#triage-option-id").value;
  const draft = {
    categoryId: $("#triage-option-category").value || null,
    label: $("#triage-option-label").value,
    description: $("#triage-option-description").value || null,
    enabled: $("#triage-option-enabled").checked,
    order: Number($("#triage-option-order").value) || 0,
  };
  const existing = (state.selected.triageOptions || []).map(triageOptionToPayload);
  let options = optionId
    ? existing.map((item, index) => (state.selected.triageOptions[index].id === optionId ? draft : item))
    : [...existing, draft];
  const selectedCategory = state.categories.find((item) => item.id === draft.categoryId);
  const children = selectedCategory?.parentId ? [] : state.categories.filter((item) =>
    item.parentId === draft.categoryId && item.active && !item.masterOnly);
  if (children.length) {
    const childIds = new Set(children.map((child) => child.id));
    const checkedIds = new Set(Array.from(document.querySelectorAll("[data-triage-child]:checked"))
      .map((input) => input.dataset.triageChild));
    options = options.filter((item) => !childIds.has(item.categoryId));
    children.filter((child) => checkedIds.has(child.id)).forEach((child, index) => {
      const previous = existing.find((item) => item.categoryId === child.id);
      options.push({
        categoryId: child.id, label: previous?.label || child.name.slice(0, 24),
        description: previous?.description || null, enabled: true,
        order: previous?.order ?? draft.order + index + 1,
      });
    });
  }
  closeTriageOptionForm();
  await saveTriageOptionsList(options);
});

$("#new-triage-option").addEventListener("click", () => {
  closeTriageOptionForm();
  $("#triage-option-category").innerHTML = triageCategoryOptions();
  renderTriageSubcategoryChoices($("#triage-option-category").value);
  $("#triage-option-form").hidden = false;
  $("#triage-option-label").focus();
});
$("#cancel-triage-option").addEventListener("click", closeTriageOptionForm);
$("#triage-option-category").addEventListener("change", (event) => {
  renderTriageSubcategoryChoices(event.target.value);
});

function renderSimulatorTranscript() {
  $("#simulator-transcript").innerHTML = state.simulatorHistory.map((entry) => (
    `<div class="transcript-bubble ${entry.direction === "ENVIADA" ? "bot" : "customer"}">${escapeHtml(entry.text)}</div>`
  )).join("");
  const transcript = $("#simulator-transcript");
  transcript.scrollTop = transcript.scrollHeight;
}

function entitiesSummary(entities) {
  const entries = Object.entries(entities || {});
  if (!entries.length) return "Nenhuma";
  return entries.map(([key, value]) => `${key}: ${value}`).join(", ");
}

function renderLocalAiSimulation(localAi) {
  const box = document.getElementById("simulator-local-ai");
  if (!box) return;
  box.hidden = false;
  if (!localAi) {
    box.innerHTML = `<div class="local-ai-heading"><b>Resposta da IA local — simulação</b><span class="local-ai-status error">ERRO</span></div><p>A simulação não retornou o diagnóstico da IA local.</p>`;
    return;
  }
  const statusClass = localAi.status === "OK" ? "ok" : (localAi.status === "DISABLED" ? "disabled" : "error");
  const response = localAi.response || (localAi.action === "HANDOFF"
    ? localAi.handoffReason
    : localAi.reason) || "A IA não produziu texto para este turno.";
  const knowledge = (localAi.knowledgeUsed || []).map((item) => item.title).filter(Boolean).join("; ") || "Nenhum trecho encontrado";
  box.innerHTML = `<div class="local-ai-heading"><b>Resposta da IA local — simulação</b><span class="local-ai-status ${statusClass}">${escapeHtml(localAi.status || "-")}</span></div>
    <p class="local-ai-response">${escapeHtml(response)}</p>
    <div class="result-grid">
      <span>Provider<strong>${escapeHtml(localAi.provider || "-")}</strong></span>
      <span>Modelo<strong>${escapeHtml(localAi.model || "-")}</strong></span>
      <span>Ação<strong>${escapeHtml(localAi.action || "-")}</strong></span>
      <span>Intenção<strong>${escapeHtml(localAi.intent || "-")}</strong></span>
      <span>Confiança<strong>${localAi.confidence != null ? `${Math.round(localAi.confidence * 100)}%` : "-"}</strong></span>
      <span>Tempo<strong>${localAi.latencyMs != null ? `${(localAi.latencyMs / 1000).toFixed(1)}s` : "-"}</strong></span>
      <span class="full-result">Conhecimento local<strong>${escapeHtml(knowledge)}</strong></span>
      <span>Resultado<strong>Resposta exibida somente no simulador</strong></span>
    </div>`;
}

$("#simulator-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("#simulator-message").value;
  if (!message.trim()) return;
  try {
    const result = await api(`/api/bots/${state.selected.id}/simulate`, {
      method: "POST",
      body: JSON.stringify({
        message,
        state: state.simulatorState,
        history: state.simulatorHistory,
        categoryId: $("#simulator-category")?.value || null,
      }),
    });
    state.simulatorHistory.push({ direction: "RECEBIDA", text: message });
    const simulatedReply = result.localAi?.status === "OK" && result.localAi?.response
      ? result.localAi.response : result.response;
    if (simulatedReply) state.simulatorHistory.push({ direction: "ENVIADA", text: simulatedReply });
    state.simulatorState = result.nextState;
    renderSimulatorTranscript();
    $("#simulator-message").value = "";

    $("#simulator-result").innerHTML = `<b>${escapeHtml(simulatedReply || "Sem resposta automática")}</b><div class="result-grid">
      <span>Bot<strong>${escapeHtml(result.botName || "-")}</strong></span>
      <span>Intenção<strong>${escapeHtml(result.intentName || "Nenhuma")}</strong></span>
      <span>Mensagem normalizada<strong>${escapeHtml(result.normalizedMessage || "-")}</strong></span>
      <span>Regra encontrada<strong>${escapeHtml(result.matchedRule || result.matchedExample || "Nenhuma")}</strong></span>
      <span>Confiança<strong>${result.confidence != null ? `${Math.round(result.confidence * 100)}%` : "-"}</strong></span>
      <span>Ação<strong>${escapeHtml(actionLabels[result.action] || result.action || "-")}</strong></span>
      <span>Categoria<strong>${escapeHtml(result.categoryName || "Nenhuma")}</strong></span>
      <span>Setor<strong>${escapeHtml(result.sector || "Nenhum")}</strong></span>
      <span>Assunto identificado<strong>${escapeHtml(result.issue || "Nenhum")}</strong></span>
      <span>Entidades<strong>${escapeHtml(entitiesSummary(result.extractedEntities))}</strong></span>
      <span>Tool<strong>${escapeHtml(result.toolName || "Nenhuma")}</strong></span>
      <span>Conhecimento<strong>${escapeHtml(result.knowledgeSourceTitle || "Nenhum")}</strong></span>
      <span>Fluxo escolhido<strong>${escapeHtml(result.selectedFlow || "Nenhum")}</strong></span>
      <span>Bloco usado<strong>${escapeHtml(result.responseBlockCode || "Nenhum")}</strong></span>
      <span>IA externa<strong>${result.calledExternalAi ? "Chamada" : "Não chamada"}</strong></span>
      <span>Provider<strong>${escapeHtml(result.provider || "-")}</strong></span>
    </div><p>${escapeHtml(result.warning)}</p>`;
    renderLocalAiSimulation(result.localAi);
    await renderSimulatorFlowInfo(result.nextState);
  } catch (error) { toast(error.message, true); }
});

// Item 8 (Simulador): mostra intenção/etapa atual/entidades coletadas/
// conhecimento usado/próxima ação do Flow Engine, quando houver um fluxo
// em andamento ou recém-concluído para a última mensagem simulada.
async function renderSimulatorFlowInfo(nextState) {
  const box = document.getElementById("simulator-flow-info");
  if (!box) return;
  if (!nextState?.activeFlowIntentId) { box.hidden = true; box.innerHTML = ""; return; }

  let steps = state.flowStepsCache.get(nextState.activeFlowIntentId);
  if (!steps) {
    try {
      steps = await api(`/api/bots/${state.selected.id}/intents/${nextState.activeFlowIntentId}/flow-steps`);
      state.flowStepsCache.set(nextState.activeFlowIntentId, steps);
    } catch { steps = []; }
  }
  const currentStep = steps.find((step) => step.id === nextState.currentFlowStepId);
  const lastKnowledge = [...(nextState.flowAttemptedSolutions || [])].reverse()
    .find((entry) => entry.action === "USE_KNOWLEDGE" && entry.outcome === "SUCCESS");
  const lastTool = [...(nextState.flowAttemptedSolutions || [])].reverse()
    .find((entry) => entry.action === "QUERY_TOOL");
  const status = !nextState.currentFlowStepId
    ? (nextState.flowResolutionStatus === "RESOLVED" ? "Resolvido" : nextState.flowResolutionStatus === "HANDED_OFF" ? "Encaminhado para humano" : "Em andamento")
    : "Aguardando resposta do cliente";

  box.hidden = false;
  box.innerHTML = `<b>Fluxo de atendimento</b><div class="result-grid">
    <span>Etapa atual<strong>${escapeHtml(currentStep ? `${currentStep.order}. ${currentStep.name}` : "—")}</strong></span>
    <span>Status<strong>${escapeHtml(status)}</strong></span>
    <span>Pergunta pendente<strong>${escapeHtml(nextState.pendingQuestion || "Nenhuma")}</strong></span>
    <span>Entidades coletadas<strong>${escapeHtml(entitiesSummary(nextState.flowCollectedEntities))}</strong></span>
    <span>Conhecimento usado<strong>${escapeHtml(lastKnowledge ? lastKnowledge.name : "Nenhum")}</strong></span>
    <span>Tool usada<strong>${escapeHtml(lastTool ? `${lastTool.name} (${lastTool.outcome})` : "Nenhuma")}</strong></span>
  </div>`;
}

$("#simulator-clear").addEventListener("click", resetSimulator);
$("#simulator-category").addEventListener("change", resetSimulator);

document.querySelectorAll("[data-status]").forEach((button) => button.addEventListener("click", async () => {
  try {
    await api(`/api/bots/${state.selected.id}/status`, { method: "PATCH", body: JSON.stringify({ status: button.dataset.status }) });
    toast("Status atualizado. O webhook permanece inalterado.");
    await loadBots(state.selected.id);
  } catch (error) { toast(error.message, true); }
}));

$("#archive-bot").addEventListener("click", async () => {
  if (!confirm("Arquivar este Bot? As configurações deixarão de aparecer na lista.")) return;
  try {
    await api(`/api/bots/${state.selected.id}`, { method: "DELETE" });
    toast("Bot arquivado.");
    state.selected = null;
    await loadBots();
  } catch (error) { toast(error.message, true); }
});

$("#new-intent").addEventListener("click", () => {
  closeIntentForm();
  $("#intent-category").innerHTML = categoryOptions();
  $("#intent-form").hidden = false;
  $("#intent-name").focus();
});
$("#cancel-intent").addEventListener("click", closeIntentForm);
$("#new-bot").addEventListener("click", startNewBot);
$("#empty-new-bot").addEventListener("click", startNewBot);
$("#theme-toggle").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme === "dark";
  document.documentElement.dataset.theme = dark ? "light" : "dark";
  localStorage.setItem("mibro-theme", dark ? "light" : "dark");
  $("#theme-toggle").textContent = dark ? "\u263e" : "\u2600";
});
$("#logout").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.replace("/login.html");
});

function confidenceClass(confidence) {
  if (confidence == null) return "";
  if (confidence >= 0.8) return "obs-confidence-high";
  if (confidence >= 0.55) return "obs-confidence-medium";
  return "obs-confidence-low";
}

function observationDetail(row) {
  const lines = [
    `Provider: ${row.provider || "-"}`,
    `Status: ${row.status || "-"}${row.errorCode ? ` (${row.errorCode})` : ""}`,
    `Comportamento social: ${row.socialBehavior || "Nenhum"}`,
    `Entidades: ${entitiesSummary(row.extractedEntities)}`,
  ];
  return lines.join("\n");
}

const botIntentsCache = new Map();
async function loadBotIntentsCached(botId) {
  if (!botId) return [];
  if (!botIntentsCache.has(botId)) botIntentsCache.set(botId, api(`/api/bots/${encodeURIComponent(botId)}`).then((bot) => bot.intents || []));
  return botIntentsCache.get(botId);
}

function feedbackButtonsHtml(row) {
  return `<div class="obs-feedback" data-obs-feedback="${escapeHtml(row.id)}">
    <button type="button" class="fb-correct ${row.feedback === "CORRECT" ? "active-correct" : ""}">Correto</button>
    <button type="button" class="fb-incorrect ${row.feedback === "INCORRECT" ? "active-incorrect" : ""}">Incorreto</button>
    <span class="fb-status">${row.feedback && row.feedback !== "UNREVIEWED" ? `Marcado como ${row.feedback === "CORRECT" ? "correto" : "incorreto"}` : "Ainda sem revisão"}</span>
  </div><div class="fb-correction" hidden></div>`;
}

async function submitObservationFeedback(observationId, payload, onDone) {
  try {
    await api(`/api/bot-observations/${observationId}/feedback`, { method: "POST", body: JSON.stringify(payload) });
    toast("Feedback registrado.");
    onDone?.();
    await loadObservationMetrics();
  } catch (error) { toast(error.message, true); }
}

function renderObservations(rows) {
  $("#obs-empty").hidden = rows.length > 0;
  $("#obs-table-body").innerHTML = rows.map((row) => `
    <tr class="obs-row" data-obs-id="${escapeHtml(row.id)}">
      <td>${new Date(row.createdAt).toLocaleString("pt-BR")}</td>
      <td>${escapeHtml(row.contact || "-")}</td>
      <td class="obs-message">${escapeHtml(row.message || "-")}</td>
      <td>${escapeHtml(row.botName || "-")}</td>
      <td>${escapeHtml(row.intentName || "Nenhuma")}</td>
      <td class="${confidenceClass(row.confidence)}">${row.confidence != null ? `${Math.round(row.confidence * 100)}%` : "-"}</td>
      <td>${escapeHtml(actionLabels[row.action] || row.action || "-")}</td>
      <td>${escapeHtml(row.categoryName || "-")}</td>
      <td>${escapeHtml(row.status || "-")}</td>
    </tr>
  `).join("");
  document.querySelectorAll(".obs-row").forEach((tr) => tr.addEventListener("click", (event) => {
    if (event.target.closest(".obs-feedback, .fb-correction")) return;
    const next = tr.nextElementSibling;
    if (next?.classList.contains("obs-detail")) { next.remove(); return; }
    document.querySelectorAll(".obs-detail").forEach((detail) => detail.remove());
    const row = rows.find((item) => item.id === tr.dataset.obsId);
    const detailRow = document.createElement("tr");
    detailRow.className = "obs-detail";
    detailRow.innerHTML = `<td colspan="9">${escapeHtml(observationDetail(row))}${feedbackButtonsHtml(row)}</td>`;
    tr.after(detailRow);

    detailRow.querySelector(".fb-correct").addEventListener("click", () => (
      submitObservationFeedback(row.id, { feedback: "CORRECT" }, () => { row.feedback = "CORRECT"; tr.click(); tr.click(); })
    ));
    detailRow.querySelector(".fb-incorrect").addEventListener("click", async () => {
      const box = detailRow.querySelector(".fb-correction");
      if (!box.hidden) { box.hidden = true; return; }
      box.hidden = false;
      const intents = await loadBotIntentsCached(row.botId);
      box.innerHTML = `<label>Intenção correta:
        <select class="fb-intent"><option value="">Selecionar...</option>${intents.map((intent) => (
          `<option value="${escapeHtml(intent.id)}">${escapeHtml(intent.name)}</option>`
        )).join("")}</select>
      </label><label><input type="checkbox" class="fb-add-example" checked><span>Adicionar como exemplo dessa intenção</span></label>
      <button type="button" class="fb-save">Salvar</button>`;
      box.querySelector(".fb-save").addEventListener("click", () => {
        const intentId = box.querySelector(".fb-intent").value;
        if (!intentId) { toast("Selecione a intenção correta.", true); return; }
        submitObservationFeedback(row.id, {
          feedback: "INCORRECT", correctedIntentId: intentId, addAsExample: box.querySelector(".fb-add-example").checked,
        }, () => { row.feedback = "INCORRECT"; tr.click(); tr.click(); });
      });
    });
  }));
}

function metricTile(value, label) {
  return `<div class="metric-tile"><b>${escapeHtml(String(value))}</b><span>${escapeHtml(label)}</span></div>`;
}

async function loadObservationMetrics() {
  try {
    const metrics = await api("/api/bot-observations/metrics");
    $("#obs-metrics").innerHTML = [
      metricTile(metrics.total, "Total analisado"),
      metricTile(metrics.highConfidence, "Alta confiança"),
      metricTile(metrics.mediumConfidence, "Média confiança"),
      metricTile(metrics.lowConfidence, "Baixa confiança"),
      metricTile(metrics.correct, "Corretos"),
      metricTile(metrics.incorrect, "Incorretos"),
      metricTile(metrics.noIntent, "Sem classificação"),
      metricTile(metrics.humanRequests, "Pedidos de humano"),
      metricTile(metrics.accuracy != null ? `${Math.round(metrics.accuracy * 100)}%` : "-", "Precisão (feedback)"),
    ].join("");
  } catch (error) { toast(error.message, true); }
}

async function loadObservations() {
  const params = new URLSearchParams();
  const botId = $("#obs-filter-bot").value;
  const intentName = $("#obs-filter-intent").value.trim();
  const minConfidence = $("#obs-filter-confidence").value;
  const from = $("#obs-filter-from").value;
  const to = $("#obs-filter-to").value;
  if (botId) params.set("botId", botId);
  if (intentName) params.set("intentName", intentName);
  if (minConfidence) params.set("minConfidence", minConfidence);
  if (from) params.set("from", new Date(from).toISOString());
  if (to) params.set("to", new Date(`${to}T23:59:59`).toISOString());
  try {
    const rows = await api(`/api/bot-observations?${params.toString()}`);
    renderObservations(rows);
    await loadObservationMetrics();
  } catch (error) { toast(error.message, true); }
}

const learningTypeLabels = {
  INTENT_EXAMPLE: "Novo exemplo", NEW_INTENT: "Nova intenção", RESPONSE: "Resposta recomendada",
  CLARIFICATION: "Esclarecimento", KNOWLEDGE: "Conhecimento", ENTITY_PATTERN: "Padrão de entidade",
};

function renderLearningSuggestions(rows) {
  $("#learning-empty").hidden = rows.length > 0;
  $("#learning-list").innerHTML = rows.map((row) => `
    <article class="learning-card" data-suggestion-id="${escapeHtml(row.id)}">
      <header>
        <span class="learning-type">${escapeHtml(learningTypeLabels[row.type] || row.type)}</span>
        ${row.metadata?.conflict ? '<span class="learning-conflict">CONFLITO</span>' : ""}
        <span class="learning-meta">${escapeHtml(row.bot?.name || "Sem Bot")} ${row.intent ? `&bull; ${escapeHtml(row.intent.name)}` : ""} &bull; ${row.sourceCount} conversa(s) &bull; ${new Date(row.createdAt).toLocaleDateString("pt-BR")}</span>
      </header>
      <p><b>${escapeHtml(row.title)}</b></p>
      <textarea class="learning-content" ${row.status !== "PENDING" && row.status !== "EDITED" ? "disabled" : ""}>${escapeHtml(row.suggestedContent)}</textarea>
      ${row.status === "PENDING" || row.status === "EDITED" ? `
        <div class="learning-actions">
          ${row.type === "INTENT_EXAMPLE" ? `<select class="learning-intent-select"><option value="">Intenção...</option></select>` : ""}
          <button type="button" class="learning-approve">Aprovar</button>
          <button type="button" class="learning-edit secondary">Salvar edição</button>
          <button type="button" class="learning-reject reject">Ignorar</button>
        </div>` : `<p class="learning-meta">Status: ${escapeHtml(row.status)}</p>`}
    </article>
  `).join("");

  rows.forEach((row) => {
    const card = document.querySelector(`[data-suggestion-id="${row.id}"]`);
    if (!card) return;
    const select = card.querySelector(".learning-intent-select");
    if (select && row.botId) {
      loadBotIntentsCached(row.botId).then((intents) => {
        select.innerHTML = `<option value="">Intenção...</option>${intents.map((intent) => (
          `<option value="${escapeHtml(intent.id)}" ${intent.id === row.intentId ? "selected" : ""}>${escapeHtml(intent.name)}</option>`
        )).join("")}`;
      });
    }
    card.querySelector(".learning-approve")?.addEventListener("click", async () => {
      try {
        const intentId = select ? select.value : undefined;
        await api(`/api/bot-learning/suggestions/${row.id}/approve`, { method: "POST", body: JSON.stringify(intentId ? { intentId } : {}) });
        toast("Sugestão aprovada.");
        await loadLearning();
      } catch (error) { toast(error.message, true); }
    });
    card.querySelector(".learning-edit")?.addEventListener("click", async () => {
      try {
        const content = card.querySelector(".learning-content").value.trim();
        await api(`/api/bot-learning/suggestions/${row.id}`, { method: "PATCH", body: JSON.stringify({ suggestedContent: content }) });
        toast("Sugestão editada. Revise e aprove quando estiver pronta.");
        await loadLearning();
      } catch (error) { toast(error.message, true); }
    });
    card.querySelector(".learning-reject")?.addEventListener("click", async () => {
      try {
        await api(`/api/bot-learning/suggestions/${row.id}/reject`, { method: "POST" });
        toast("Sugestão ignorada.");
        await loadLearning();
      } catch (error) { toast(error.message, true); }
    });
  });
}

async function loadLearningMetrics() {
  try {
    const metrics = await api("/api/bot-learning/metrics");
    $("#learning-metrics").innerHTML = [
      metricTile(metrics.pending, "Pendentes"),
      metricTile(metrics.approved, "Aprovadas"),
      metricTile(metrics.rejected, "Rejeitadas"),
      metricTile(metrics.byType?.INTENT_EXAMPLE || 0, "Novos exemplos"),
      metricTile(metrics.byType?.NEW_INTENT || 0, "Novas intenções"),
    ].join("");
  } catch (error) { toast(error.message, true); }
}

async function loadLearning() {
  const params = new URLSearchParams();
  const status = $("#learning-filter-status").value;
  const type = $("#learning-filter-type").value;
  if (status) params.set("status", status);
  if (type) params.set("type", type);
  try {
    const rows = await api(`/api/bot-learning/suggestions?${params.toString()}`);
    renderLearningSuggestions(rows);
    await loadLearningMetrics();
  } catch (error) { toast(error.message, true); }
}

$("#analyze-conversation").addEventListener("click", async () => {
  const conversationId = $("#analyze-conversation-id").value.trim();
  if (!conversationId) { toast("Informe o ID da conversa.", true); return; }
  try {
    const result = await api(`/api/bot-learning/conversations/${encodeURIComponent(conversationId)}/analyze`, { method: "POST" });
    toast(result.analyzed ? `Análise concluída: ${result.suggestionsGenerated} sugestão(ões).` : `Não analisada: ${result.reason}`);
    await loadLearning();
  } catch (error) { toast(error.message, true); }
});
$("#learning-refresh").addEventListener("click", loadLearning);

const configSectionSelectors = {
  general: ["#bot-form"],
  personality: ["#personality-form"],
  intelligence: ["#test-ai-provider"],
  availability: ["#schedule-form", "#triage-holidays-card"],
  rules: ["#triage-options-card", ".intentions-card"],
  quality: ["#rating-config-form"],
  simulator: ["#simulator-form"],
};

function setConfigSection(section) {
  const target = configSectionSelectors[section] ? section : "general";
  $(".editor-grid").dataset.activeConfigSection = target;
  document.querySelectorAll("[data-config-section-target]").forEach((button) => {
    button.classList.toggle("active", button.dataset.configSectionTarget === target);
  });
  document.querySelectorAll("[data-config-section]").forEach((card) => {
    card.classList.toggle("config-section-active", card.dataset.configSection === target);
  });
  try { localStorage.setItem("mibro-bot-config-section", target); } catch {}
  document.querySelector(".bots-workspace").scrollTop = 0;
}

function initializeConfigurationLayout() {
  Object.entries(configSectionSelectors).forEach(([section, selectors]) => {
    selectors.forEach((selector) => {
      const element = document.querySelector(selector);
      const card = element?.classList.contains("card") ? element : element?.closest(".card");
      if (card) card.dataset.configSection = section;
    });
  });
  let initialSection = "general";
  try { initialSection = localStorage.getItem("mibro-bot-config-section") || initialSection; } catch {}
  setConfigSection(initialSection);
  document.querySelectorAll("[data-config-section-target]").forEach((button) => {
    button.addEventListener("click", () => setConfigSection(button.dataset.configSectionTarget));
  });

  document.querySelectorAll("#bot-form .fields-heading").forEach((heading) => {
    const panel = heading?.nextElementSibling;
    if (!heading || !panel || !panel.classList.contains("fields")) return;
    const title = heading.textContent.trim();
    heading.classList.add("config-accordion-toggle");
    heading.setAttribute("role", "button");
    heading.tabIndex = 0;
    heading.innerHTML = `<span>${escapeHtml(title)}</span><span class="config-accordion-icon"></span>`;
    const setExpanded = (expanded) => {
      heading.setAttribute("aria-expanded", String(expanded));
      panel.classList.toggle("config-accordion-collapsed", !expanded);
      heading.querySelector(".config-accordion-icon").textContent = expanded ? "-" : "+";
    };
    setExpanded(heading.id === "triage-only-fields");
    heading.addEventListener("click", () => setExpanded(heading.getAttribute("aria-expanded") !== "true"));
    heading.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      heading.click();
    });
  });

  const globalToggle = $("#toggle-global-settings");
  const globalBody = $("#global-settings-body");
  globalToggle.addEventListener("click", () => {
    const expanded = globalToggle.getAttribute("aria-expanded") !== "true";
    globalToggle.setAttribute("aria-expanded", String(expanded));
    globalToggle.classList.toggle("active", expanded);
    globalBody.hidden = !expanded;
  });
}

function setActiveTab(tab) {
  document.querySelectorAll(".tab-button").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  $("#observations-panel").hidden = tab !== "observations";
  $("#learning-panel").hidden = tab !== "learning";
  $("#performance-panel").hidden = tab !== "performance";
  $("#versions-panel").hidden = tab !== "versions";
  $("#ranking-panel").hidden = tab !== "ranking";
  $("#ai-keys-panel").hidden = tab !== "ai-keys";
  if (tab === "config") {
    renderEditor();
    return;
  }
  $("#empty-state").hidden = true;
  $("#editor").hidden = true;
  if (tab === "observations") {
    $("#obs-filter-bot").innerHTML = `<option value="">Todos os Bots</option>${state.bots.map((bot) => (
      `<option value="${escapeHtml(bot.id)}">${escapeHtml(bot.name)}</option>`
    )).join("")}`;
    loadObservations();
  } else if (tab === "learning") {
    loadLearning();
  } else if (tab === "performance") {
    loadPerformance();
  } else if (tab === "versions") {
    loadVersions();
  } else if (tab === "ranking") {
    loadRanking();
  } else if (tab === "ai-keys") {
    loadAiKeys();
  }
}

function requireSelectedBot() {
  if (!state.selected) { toast("Selecione um Bot primeiro.", true); return null; }
  return state.selected.id;
}

async function loadPerformance() {
  const botId = requireSelectedBot();
  if (!botId) return;
  const period = $("#perf-period").value;
  try {
    const [metrics, intentRows, conflicts, quality, qualityAlerts] = await Promise.all([
      api(`/api/bots/${botId}/rating-metrics?${period ? `preset=${period}` : ""}`),
      api(`/api/bots/${botId}/intent-metrics`),
      api(`/api/bots/${botId}/intent-conflicts`),
      api(`/api/bots/${botId}/quality-metrics`),
      api(`/api/bots/${botId}/quality-alerts`),
    ]);
    $("#perf-interpretation-metrics").innerHTML = [
      metricTile(metrics.interpretation.totalObserved, "Mensagens interpretadas (diagnóstico)"),
      metricTile(metrics.interpretation.handoffs, "Handoffs (interpretador)"),
      metricTile(metrics.interpretation.fallbacks, "Fallbacks (sem intenção)"),
      metricTile(metrics.interpretation.lowConfidence, "Baixa confiança"),
    ].join("");
    $("#perf-attendance-metrics").innerHTML = [
      metricTile(metrics.ratings.total, "Avaliações recebidas"),
      metricTile(metrics.ratings.average ?? "-", "Nota média"),
      metricTile(metrics.ratings.positive, "Ajudou (4-5★)"),
      metricTile(metrics.ratings.neutral, "Neutro (3★)"),
      metricTile(metrics.ratings.negative, "Não ajudou (1-2★)"),
      metricTile(metrics.attendance.resolvedByBot, "Atendimentos concluídos pelo Bot"),
      metricTile(metrics.attendance.handoffOccurred, "Handoffs (avaliados)"),
    ].join("");
    const maxCount = Math.max(1, ...Object.values(metrics.ratings.distribution));
    $("#perf-distribution").innerHTML = [5, 4, 3, 2, 1].map((score) => {
      const count = metrics.ratings.distribution[score] || 0;
      const pct = Math.round((count / maxCount) * 100);
      return `<div class="rating-distribution-row"><span>${score} estrela${score === 1 ? "" : "s"}</span><span class="rating-distribution-bar"><span style="width:${pct}%"></span></span><span>${count}</span></div>`;
    }).join("") + (metrics.ratings.sampleWarning ? `<p class="card-help">${escapeHtml(metrics.ratings.sampleWarning)}</p>` : "");

    $("#intent-metrics-body").innerHTML = intentRows.length ? intentRows.map((row) => `
      <tr><td>${escapeHtml(row.intentName)}</td><td>${row.triggeredCount}</td>
      <td>${row.averageConfidence != null ? `${Math.round(row.averageConfidence * 100)}%` : "-"}</td>
      <td>${row.handoffCount}</td><td>${row.ratingsCount}</td>
      <td>${row.averageRating != null ? row.averageRating : "-"}</td></tr>
    `).join("") : `<tr><td colspan="6">Sem dados ainda.</td></tr>`;

    $("#intent-conflicts-list").innerHTML = conflicts.length ? conflicts.map((conflict) => `
      <article class="learning-card"><p><b>${escapeHtml(conflict.intentAName)}</b> &harr; <b>${escapeHtml(conflict.intentBName)}</b>
      <span class="learning-conflict">${Math.round(conflict.similarity * 100)}% parecidas</span></p>
      <p class="learning-meta">${escapeHtml(conflict.reason)}</p></article>
    `).join("") : `<div class="intent-empty">Nenhum conflito identificado entre as intenções ativas.</div>`;

    $("#quality-metrics").innerHTML = [
      metricTile(quality.started, "Mensagens observadas"),
      metricTile(quality.resolvedByFlow, "Resolvidos pelo fluxo"),
      metricTile(quality.handoffs, "Handoffs"),
      metricTile(quality.topicSwitches, "Trocas de assunto"),
      metricTile(quality.suggestions.used, "Sugestões usadas"),
      metricTile(quality.suggestions.edited, "Sugestões editadas"),
      metricTile(quality.suggestions.ignored, "Sugestões ignoradas"),
      metricTile(quality.suggestions.positive, "Feedback 👍"),
      metricTile(quality.suggestions.negative, "Feedback 👎"),
    ].join("");
    $("#quality-alerts").innerHTML = qualityAlerts.alerts.length ? qualityAlerts.alerts.map((alert) => `
      <article class="learning-card"><p><b>${escapeHtml(alert.type)}</b> <span class="learning-conflict">${escapeHtml(alert.severity)}</span></p>
      <p class="learning-meta">${escapeHtml(alert.message)}</p></article>
    `).join("") : `<div class="intent-empty">Nenhum alerta no momento.</div>`;
  } catch (error) { toast(error.message, true); }
}
$("#perf-refresh").addEventListener("click", loadPerformance);

function renderVersions(rows) {
  $("#versions-empty").hidden = rows.length > 0;
  $("#versions-list").innerHTML = rows.map((row) => `
    <article class="learning-card">
      <header><span class="learning-type">v${row.version}</span>
      <span class="learning-meta">${row.createdByName ? escapeHtml(row.createdByName) : "-"} &bull; ${new Date(row.createdAt).toLocaleString("pt-BR")}${row.restoredFromVersion ? ` &bull; restaurada da v${row.restoredFromVersion}` : ""}</span></header>
      <p><b>${escapeHtml(row.label || "Sem rótulo")}</b></p>
      ${row.description ? `<p class="learning-meta">${escapeHtml(row.description)}</p>` : ""}
      <div class="learning-actions"><button type="button" class="restore-version" data-version="${row.version}">Restaurar esta versão</button></div>
    </article>
  `).join("");
  document.querySelectorAll(".restore-version").forEach((button) => button.addEventListener("click", async () => {
    const version = button.dataset.version;
    try {
      const preview = await api(`/api/bots/${state.selected.id}/versions/${version}/preview-restore`);
      const changed = Object.keys(preview.target).filter((key) => JSON.stringify(preview.target[key]) !== JSON.stringify(preview.current[key]));
      const confirmMessage = changed.length
        ? `Restaurar v${version} vai alterar: ${changed.join(", ")}. Isso cria uma nova versão (não apaga o histórico). Confirmar?`
        : `Restaurar v${version}? Isso cria uma nova versão (não apaga o histórico).`;
      if (!confirm(confirmMessage)) return;
      await api(`/api/bots/${state.selected.id}/versions/${version}/restore`, { method: "POST", body: JSON.stringify({}) });
      toast(`Versão restaurada a partir da v${version}.`);
      await loadVersions();
      await selectBot(state.selected.id);
    } catch (error) { toast(error.message, true); }
  }));
}

async function loadVersions() {
  const botId = requireSelectedBot();
  if (!botId) return;
  try {
    renderVersions(await api(`/api/bots/${botId}/versions`));
  } catch (error) { toast(error.message, true); }
}

$("#save-version").addEventListener("click", async () => {
  const botId = requireSelectedBot();
  if (!botId) return;
  try {
    await api(`/api/bots/${botId}/versions`, {
      method: "POST",
      body: JSON.stringify({ label: $("#version-label").value || undefined, description: $("#version-description").value || undefined }),
    });
    toast("Versão salva.");
    $("#version-label").value = ""; $("#version-description").value = "";
    await loadVersions();
  } catch (error) { toast(error.message, true); }
});

async function loadRanking() {
  try {
    const result = await api("/api/bot-ranking");
    $("#ranking-disabled-notice").hidden = result.enabled;
    if (!result.enabled) { $("#ranking-list").innerHTML = ""; $("#ranking-excluded-list").innerHTML = ""; $("#ranking-excluded-heading").hidden = true; return; }
    $("#ranking-list").innerHTML = result.ranked.length ? result.ranked.map((entry, index) => `
      <div class="ranking-card"><span class="ranking-position">${index + 1}</span>
      <div class="ranking-info"><b>${escapeHtml(entry.botName)}</b>
      <small>Nota ${entry.averageScore} &bull; ${entry.ratingsCount} avaliação(ões) &bull; score ${entry.rankingScore}</small></div></div>
    `).join("") : `<div class="intent-empty">Nenhum Bot atingiu a amostra mínima ainda.</div>`;
    $("#ranking-excluded-heading").hidden = result.excluded.length === 0;
    $("#ranking-excluded-list").innerHTML = result.excluded.map((entry) => `
      <div class="ranking-card"><span class="ranking-position">-</span>
      <div class="ranking-info"><b>${escapeHtml(entry.botName)}</b>
      <small>${entry.ratingsCount}/${result.minimumRatingsForRanking} avaliações &bull; Dados insuficientes para ranking</small></div></div>
    `).join("");
  } catch (error) { toast(error.message, true); }
}

async function loadGlobalSettings() {
  try {
    const settings = await api("/api/bot-settings");
    $("#global-automation").checked = settings.automationEnabled;
    $("#global-observation").checked = settings.observationEnabled;
    $("#global-learning").checked = settings.learningEnabled;
    $("#global-ratings").checked = settings.ratingsEnabled;
    $("#global-ranking").checked = settings.rankingEnabled;
    $("#global-min-ratings").value = settings.minimumRatingsForRanking;
    const pill = $("#global-automation-status");
    pill.textContent = settings.automationEnabled ? "AUTOMAÇÃO ON" : "AUTOMAÇÃO OFF";
    pill.className = `global-status-pill ${settings.automationEnabled ? "on" : "off"}`;
    const killSwitch = $("#kill-switch");
    killSwitch.dataset.automationEnabled = String(settings.automationEnabled);
    killSwitch.textContent = settings.automationEnabled
      ? "DESATIVAR AUTOMAÇÃO DOS BOTS"
      : "REATIVAR AUTOMAÇÃO DOS BOTS";
  } catch (error) { toast(error.message, true); }
}

$("#save-global-settings").addEventListener("click", async () => {
  try {
    await api("/api/bot-settings", {
      method: "PATCH",
      body: JSON.stringify({
        observationEnabled: $("#global-observation").checked,
        learningEnabled: $("#global-learning").checked,
        ratingsEnabled: $("#global-ratings").checked,
        rankingEnabled: $("#global-ranking").checked,
        minimumRatingsForRanking: Number($("#global-min-ratings").value),
      }),
    });
    toast("Configurações globais salvas.");
    await loadGlobalSettings();
  } catch (error) { toast(error.message, true); }
});

$("#kill-switch").addEventListener("click", async () => {
  const willActivate = $("#kill-switch").dataset.automationEnabled === "true";
  const action = willActivate ? "desativar" : "reativar";
  if (!confirm(`Tem certeza que deseja ${action} a automação de TODOS os Bots agora? Atendimento humano e recebimento de mensagens continuam funcionando normalmente.`)) return;
  try {
    if (willActivate) await api("/api/bot-settings/kill-switch/activate", { method: "POST" });
    else await api("/api/bot-settings/kill-switch/deactivate", { method: "POST" });
    toast(willActivate ? "Automação dos Bots desativada." : "Automação dos Bots reativada.");
    await loadGlobalSettings();
  } catch (error) { toast(error.message, true); }
});

document.querySelectorAll(".tab-button").forEach((button) => button.addEventListener("click", () => setActiveTab(button.dataset.tab)));
$("#obs-refresh").addEventListener("click", loadObservations);
initializeConfigurationLayout();

(async () => {
  try {
    const status = await api("/api/auth/status");
    if (!status.authenticated || !status.user.isMaster) return location.replace("/");
    $("#current-user").textContent = status.user.name;
    state.categories = (await api("/api/categories")).filter((category) => category.active !== false);
    $("#bot-category").innerHTML = categoryOptions();
    $("#intent-category").innerHTML = categoryOptions();
    renderSchedules();
    await ensureAiProviderOptionsLoaded();
    await loadBots();
    await loadGlobalSettings();
  } catch (error) {
    if ($("#bot-list").querySelector(".skeleton-list")) $("#bot-list").innerHTML = `<div class="empty-list">Não foi possível carregar os bots.</div>`;
    toast(error.message, true);
  }
})();
