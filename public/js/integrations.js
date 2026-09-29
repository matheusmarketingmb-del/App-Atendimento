const $ = (selector) => document.querySelector(selector);
const MARKETPLACE_UI_ENABLED = window.MIBRO_FEATURES?.marketplaces !== false;
const isMarketplaceChannel = (channel) => window.isMarketplaceFeatureChannel?.(channel) === true;
const state = { overview: [], settings: null, users: [], categories: [], editingChannel: null, editingAccountId: null, accessAccountId: null };

const CHANNEL_LABELS = {
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
  GOOGLE_REVIEWS: "Google Reviews / Perfil da Empresa",
  RECLAME_AQUI: "Reclame Aqui",
};

const STATUS_LABELS = {
  DISABLED: "Desativado", NOT_CONFIGURED: "Não configurado", CONFIGURED: "Configurado, aguardando teste",
  AUTH_PENDING: "Autorização pendente", CONNECTED: "Conectado", DEGRADED: "Degradado",
  ERROR: "Erro", RECONNECT_REQUIRED: "Reconexão necessária", NOT_SUPPORTED: "Ainda não suportado",
  NEEDS_APPROVAL: "Aguardando aprovação da plataforma", NEEDS_CONTRACT: "Exige contrato comercial",
};

// Providers OAuth permitidos por canal (espelha OAUTH_PROVIDERS_BY_CHANNEL
// do integrations-controller.js — front só decide QUAL botão mostrar, o
// backend valida de novo antes de aceitar).
const OAUTH_OPTIONS_BY_CHANNEL = {
  EMAIL: [
    { provider: "GOOGLE", label: "Conectar com Google" },
    { provider: "MICROSOFT", label: "Conectar com Microsoft" },
  ],
  GOOGLE_REVIEWS: [{ provider: "GOOGLE", label: "Conectar com Google" }],
  MERCADO_LIVRE: [{ provider: "MERCADO_LIVRE", label: "Conectar com Mercado Livre" }],
  AMAZON_MARKETPLACE: [{ provider: "AMAZON", label: "Conectar com Amazon" }],
  INSTAGRAM_DIRECT: [{ provider: "META", label: "Conectar com Meta" }],
  INSTAGRAM_COMMENTS: [{ provider: "META", label: "Conectar com Meta" }],
  FACEBOOK_MESSENGER: [{ provider: "META", label: "Conectar com Meta" }],
  FACEBOOK_COMMENTS: [{ provider: "META", label: "Conectar com Meta" }],
};

// Campos por canal (item 6/9) — nenhum canal aqui aceita um endpoint
// inventado: os que ainda não têm API confirmada (Shopee, Reclame Aqui)
// só guardam configuração básica para quando o acesso for liberado.
const CHANNEL_FIELDS = {
  META: [
    { key: "config.phoneNumberId", label: "Phone Number ID" },
    { key: "config.wabaId", label: "WABA ID" },
    { key: "config.displayPhoneNumber", label: "Número exibido (opcional)", optional: true },
    { key: "config.graphVersion", label: "Graph API version (opcional)", optional: true },
    { key: "secrets.accessToken", label: "Access token da conta", secret: true },
  ],
  EMAIL: [
    { key: "config.provider", label: "Provedor (GMAIL ou MICROSOFT_365)", secret: false },
    { key: "config.gmailSyncLabel", label: "Marcador do Gmail a importar (padrão: Shopify)", secret: false, optional: true },
    { key: "secrets.accessToken", label: "Access token (OAuth)", secret: true },
    { key: "secrets.refreshToken", label: "Refresh token (OAuth)", secret: true, optional: true },
  ],
  MERCADO_LIVRE: [
    { key: "config.sellerId", label: "Seller ID (opcional)", secret: false, optional: true },
    { key: "secrets.accessToken", label: "Access token (OAuth)", secret: true },
    { key: "secrets.refreshToken", label: "Refresh token (OAuth)", secret: true, optional: true },
  ],
  TIKTOK_SHOP: [
    { key: "config.appKey", label: "App Key" },
    { key: "secrets.appSecret", label: "App Secret", secret: true },
    { key: "config.shopId", label: "Shop ID" },
    { key: "secrets.accessToken", label: "Access token (OAuth)", secret: true, optional: true },
  ],
  AMAZON_MARKETPLACE: [
    { key: "config.lwaClientId", label: "LWA Client ID" },
    { key: "secrets.lwaClientSecret", label: "LWA Client Secret", secret: true },
    { key: "secrets.refreshToken", label: "Refresh token (gerado no Seller Central)", secret: true },
  ],
  SHOPEE: [
    { key: "config.partnerId", label: "Partner ID", optional: true },
    { key: "config.shopId", label: "Shop ID", optional: true },
    { key: "secrets.partnerKey", label: "Partner Key", secret: true, optional: true },
  ],
  GOOGLE_REVIEWS: [
    { key: "secrets.accessToken", label: "Access token (OAuth)", secret: true },
    { key: "secrets.refreshToken", label: "Refresh token (OAuth)", secret: true, optional: true },
  ],
  RECLAME_AQUI: [
    { key: "config.companyId", label: "ID da empresa no Reclame Aqui", optional: true },
  ],
  // Instagram/Facebook (contas novas, item 6/19) reaproveitam o app Meta do
  // WhatsApp — só pedem o id da página/perfil e o token de acesso dela,
  // obtidos manualmente no Meta Business Suite/Graph API Explorer. Sem
  // Fallback manual só é renderizado quando o provider não está no registro OAuth oficial.
  FACEBOOK_MESSENGER: [
    { key: "config.pageId", label: "ID da Página do Facebook" },
    { key: "secrets.pageAccessToken", label: "Page Access Token", secret: true },
  ],
  FACEBOOK_COMMENTS: [
    { key: "config.pageId", label: "ID da Página do Facebook" },
    { key: "secrets.pageAccessToken", label: "Page Access Token", secret: true },
  ],
  INSTAGRAM_DIRECT: [
    { key: "config.igUserId", label: "ID da conta comercial do Instagram" },
    { key: "secrets.igAccessToken", label: "Access token do Instagram", secret: true },
  ],
  INSTAGRAM_COMMENTS: [
    { key: "config.igUserId", label: "ID da conta comercial do Instagram" },
    { key: "secrets.igAccessToken", label: "Access token do Instagram", secret: true },
  ],
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

function statusBadgeClass(status) {
  if (status === "CONNECTED") return "status-ok";
  if (["ERROR", "DEGRADED"].includes(status)) return "status-error";
  if (["AUTH_PENDING", "CONFIGURED"].includes(status)) return "status-pending";
  if (["NEEDS_APPROVAL", "NEEDS_CONTRACT"].includes(status)) return "status-approval";
  return "status-idle";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}


function oauthButtons(entry) {
  return (OAUTH_OPTIONS_BY_CHANNEL[entry.channel] || []).map((option) => `
    <button type="button" class="oauth-connect" data-channel="${escapeHtml(entry.channel)}" data-provider="${escapeHtml(option.provider)}">
      ${escapeHtml(option.label)}
    </button>`).join("");
}

function openOAuthSelection(result) {
  const dialog = $("#oauth-selection-dialog");
  $("#oauth-selection-options").innerHTML = (result.candidates || []).map((candidate) => `
    <button type="button" data-candidate-id="${escapeHtml(candidate.id)}">
      <strong>${escapeHtml(candidate.name)}</strong>
      ${candidate.username ? `<span>${escapeHtml(candidate.username)}</span>` : ""}
    </button>`).join("");
  dialog.dataset.accountId = result.channelAccountId;
  dialog.showModal();
}

function renderCards() {
  const container = $("#channel-cards");
  container.innerHTML = state.overview.map((entry) => {
    const isMeta = entry.channel === "META";
    const allowManualMetaTest = ["INSTAGRAM_DIRECT", "INSTAGRAM_COMMENTS", "FACEBOOK_MESSENGER", "FACEBOOK_COMMENTS"].includes(entry.channel);
    const accounts = entry.accounts || [];
    const capabilities = entry.capabilities || {};
    const capBadges = Object.entries(capabilities)
      .filter(([, value]) => value)
      .map(([key]) => `<span class="cap-badge">${escapeHtml(key.replace(/^can|^supports/, "").replace(/([A-Z])/g, " $1").trim())}</span>`)
      .join("");

    const accountsHtml = accounts.length ? accounts.map((account) => `
      <div class="account-row" data-account-id="${escapeHtml(account.id)}">
        <div class="account-row-main">
          <strong>${escapeHtml(account.name)}</strong>
          <span class="status-pill ${statusBadgeClass(account.status)}">${escapeHtml(STATUS_LABELS[account.status] || account.status)}</span>
          <span class="enabled-pill ${account.enabled ? "on" : "off"}">${account.enabled ? "Ativado" : "Desativado"}</span>
        </div>
        <div class="account-row-meta">
          ${account.oauthProvider ? `<span>Provider: ${escapeHtml(account.oauthProvider)}</span>` : ""}${account.providerMetadata?.username ? `<span>Conta: ${escapeHtml(account.providerMetadata.username)}</span>` : ""}${account.externalAccountId ? `<span>ID externo: ${escapeHtml(account.externalAccountId)}</span>` : ""}${account.lastSyncAt ? `<span>Última sincronização: ${escapeHtml(new Date(account.lastSyncAt).toLocaleString("pt-BR"))}</span>` : ""}${["EMAIL", "META"].includes(entry.channel) ? `<span>Atendentes: ${account.allowedUsers?.length ? escapeHtml(account.allowedUsers.map((item) => item.user?.name).filter(Boolean).join(", ")) : "somente Master"}</span><span>Áreas: ${account.allowedCategoryIds?.length ? escapeHtml(state.categories.filter((item) => account.allowedCategoryIds.includes(item.id)).map((item) => item.name).join(", ")) : "todas"}</span>` : ""}
          ${account.lastErrorMessage ? `<span class="error-text">Erro: ${escapeHtml(account.lastErrorMessage)}</span>` : ""}
        </div>
        <div class="account-row-actions">
          ${["EMAIL", "META"].includes(entry.channel) ? `<button type="button" data-action="access" data-id="${escapeHtml(account.id)}">Gerenciar acesso</button>` : ""}
          <button type="button" data-action="test" data-id="${escapeHtml(account.id)}">Testar conexão</button>
          <button type="button" data-action="reconnect" data-id="${escapeHtml(account.id)}" data-channel="${escapeHtml(entry.channel)}">Reconectar</button>
          <button type="button" data-action="toggle" data-id="${escapeHtml(account.id)}" data-enabled="${account.enabled}">${account.enabled ? "Desativar" : "Ativar"}</button>
          <button type="button" data-action="delete" data-id="${escapeHtml(account.id)}" class="danger">Remover</button>
        </div>
      </div>
    `).join("") : `<p class="no-accounts">Nenhuma conta configurada.</p>`;

    return `
      <section class="channel-card ${isMeta ? "channel-card-meta" : ""}">
        <header>
          <h2>${escapeHtml(CHANNEL_LABELS[entry.channel] || entry.channel)}</h2>
          ${entry.adapterAvailable ? "" : '<span class="status-pill status-idle">Sem adapter</span>'}
        </header>
        <div class="cap-badges">${capBadges || '<span class="cap-badge cap-badge-empty">Sem capacidades ativas nesta fase</span>'}</div>
        ${isMeta ? '<p class="meta-note">O número principal atual continua ativo pelas variáveis ENV. Números adicionais ficam isolados por conta abaixo.</p>' : ""}
        <div class="account-list">${accountsHtml}</div>
        ${oauthButtons(entry) ? `<div class="oauth-actions">${oauthButtons(entry)}</div>` : ""}
        ${!oauthButtons(entry) || allowManualMetaTest
          ? `<details class="advanced-config"><summary>Configuração avançada</summary><button type="button" class="add-account" data-channel="${escapeHtml(entry.channel)}">${isMeta ? "Adicionar número WhatsApp" : (allowManualMetaTest ? "Adicionar com token de teste" : "Adicionar manualmente")}</button></details>`
          : ""}      </section>
    `;
  }).join("");

  container.querySelectorAll(".oauth-connect").forEach((button) => (
    button.addEventListener("click", () => startOAuth(null, button.dataset.channel, button.dataset.provider))
  ));
  container.querySelectorAll(".add-account").forEach((button) => (
    button.addEventListener("click", () => openAccountDialog(button.dataset.channel))
  ));
  container.querySelectorAll('[data-action="access"]').forEach((button) => (
    button.addEventListener("click", () => openAccessDialog(button.dataset.id))
  ));
  container.querySelectorAll('[data-action="test"]').forEach((button) => (
    button.addEventListener("click", () => testConnection(button.dataset.id))
  ));
  container.querySelectorAll('[data-action="reconnect"]').forEach((button) => (
    button.addEventListener("click", () => reconnectAccount(button.dataset.id, button.dataset.channel))
  ));
  container.querySelectorAll('[data-action="toggle"]').forEach((button) => (
    button.addEventListener("click", () => toggleAccount(button.dataset.id, button.dataset.enabled !== "true"))
  ));
  container.querySelectorAll('[data-action="delete"]').forEach((button) => (
    button.addEventListener("click", () => deleteAccount(button.dataset.id))
  ));
}

// account = null => criar conta nova. account preenchido => "Reconectar":
// reabre o mesmo formulário para atualizar nome/config/segredos (campos de
// segredo ficam opcionais — em branco mantém o valor cifrado já salvo).
function openAccountDialog(channel, account = null) {
  state.editingChannel = channel;
  state.editingAccountId = account?.id || null;
  $("#account-dialog-title").textContent = account ? "Reconectar conta" : "Nova conta";
  $("#account-dialog-channel").textContent = CHANNEL_LABELS[channel] || channel;
  $("#account-name").value = account?.name || "";
  const fields = CHANNEL_FIELDS[channel] || [];
  $("#account-secret-fields").innerHTML = fields.map((field) => {
    const [group, key] = field.key.split(".");
    const currentValue = group === "config" ? (account?.config?.[key] ?? "") : "";
    const placeholder = account && field.secret ? "Deixe em branco para manter o valor salvo" : "";
    return `
    <label>${field.label}${field.optional || account ? " (opcional)" : ""}
      <input type="${field.secret ? "password" : "text"}" data-field-key="${field.key}"
        value="${escapeHtml(currentValue)}" placeholder="${escapeHtml(placeholder)}"
        ${field.optional || account ? "" : "required"}>
    </label>`;
  }).join("");
  $("#account-dialog").showModal();
}

async function saveAccount(event) {
  event.preventDefault();
  const channel = state.editingChannel;
  const accountId = state.editingAccountId;
  const name = $("#account-name").value.trim();
  if (!name) return toast("Informe um nome para a conta.", true);

  const config = {};
  const secrets = {};
  document.querySelectorAll("#account-secret-fields [data-field-key]").forEach((input) => {
    const value = input.value.trim();
    if (!value) return;
    const [group, key] = input.dataset.fieldKey.split(".");
    if (group === "secrets") secrets[key] = value;
    else config[key] = value;
  });

  try {
    if (accountId) {
      await api(`/api/integrations/accounts/${accountId}`, { method: "PATCH", body: JSON.stringify({ name, config, secrets }) });
      toast("Conta atualizada. Use \"Testar conexão\" para validar.");
    } else {
      await api("/api/integrations/accounts", { method: "POST", body: JSON.stringify({ channel, name, config, secrets }) });
      toast("Conta criada. Use \"Testar conexão\" para validar as credenciais.");
    }
    $("#account-dialog").close();
    await loadOverview();
  } catch (error) { toast(error.message, true); }
}

// Reconectar usa o provider já salvo; sem OAuth cai no formulário avançado.
async function reconnectAccount(accountId, channel) {
  const entry = state.overview.find((item) => item.channel === channel);
  const account = entry?.accounts?.find((item) => item.id === accountId);
  if (account?.oauthProvider) return startOAuth(accountId, channel, account.oauthProvider);
  const provider = account?.config?.provider === "GMAIL" ? "GOOGLE"
    : account?.config?.provider === "MICROSOFT_365" ? "MICROSOFT" : null;
  if (provider) return startOAuth(accountId, channel, provider);
  openAccountDialog(channel, account || { id: accountId, name: "", config: {} });
}

async function startOAuth(accountId, channel, provider) {
  if (!provider) return toast("OAuth ainda não está disponível para este canal. Use Configuração avançada.", true);
  try {
    const result = await api("/api/integrations/oauth/start", {
      method: "POST", body: JSON.stringify({ channel, channelAccountId: accountId || null, provider }),
    });
    const popup = window.open(result.url, "mibro-oauth", "width=560,height=720");
    if (!popup) return toast("O navegador bloqueou a janela de autorização. Permita pop-ups para este site.", true);
    const onMessage = async (event) => {
      if (event.origin !== location.origin || event.data?.source !== "mibro-oauth-callback") return;
      window.removeEventListener("message", onMessage);
      if (!event.data.ok) return toast(event.data.error || "Falha ao concluir a autorização OAuth.", true);
      if (event.data.result?.selectionRequired) openOAuthSelection(event.data.result);
      else toast("Conta conectada via OAuth.");
      await loadOverview();
    };
    window.addEventListener("message", onMessage);
  } catch (error) { toast(error.message, true); }
}

async function selectOAuthCandidate(candidateId) {
  const dialog = $("#oauth-selection-dialog");
  try {
    await api(`/api/integrations/oauth/accounts/${dialog.dataset.accountId}/select`, {
      method: "POST", body: JSON.stringify({ candidateId }),
    });
    dialog.close();
    toast("Conta conectada via OAuth.");
    await loadOverview();
  } catch (error) { toast(error.message, true); }
}

function openAccessDialog(accountId) {
  const account = state.overview.flatMap((entry) => entry.accounts || []).find((item) => item.id === accountId);
  if (!account) return;
  state.accessAccountId = accountId;
  const selectedUsers = new Set((account.allowedUsers || []).map((item) => item.userId));
  const selectedCategories = new Set(account.allowedCategoryIds || []);
  $("#account-access-name").textContent = account.name;
  $("#account-access-users").innerHTML = state.users.map((user) => {
    const master = user.role === "ADMIN";
    return `
    <label class="access-user-option${master ? " master-access" : ""}"><input type="checkbox" value="${escapeHtml(user.id)}" ${master || selectedUsers.has(user.id) ? "checked" : ""} ${master ? "disabled" : ""}>
      <span><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(master ? `${user.email} — Master, acesso permanente` : `${user.email} — ${user.role}`)}</small></span>
    </label>`;
  }).join("") || '<p class="no-accounts">Nenhum usuário ativo disponível.</p>';
  $("#account-access-categories").innerHTML = state.categories.filter((category) => category.active !== false).map((category) => `
    <label class="access-user-option"><input type="checkbox" value="${escapeHtml(category.id)}" ${selectedCategories.has(category.id) ? "checked" : ""}>
      <span><strong>${escapeHtml(category.parentId ? `↳ ${category.name}` : category.name)}</strong><small>${category.parentId ? "Subcategoria" : "Categoria principal"}</small></span>
    </label>`).join("") || '<p class="no-accounts">Nenhuma categoria ativa disponível.</p>';
  $("#account-access-dialog").showModal();
}

async function saveAccountAccess(event) {
  event.preventDefault();
  const userIds = [...document.querySelectorAll("#account-access-users input:checked")].map((input) => input.value);
  const categoryIds = [...document.querySelectorAll("#account-access-categories input:checked")].map((input) => input.value);
  try {
    await api(`/api/integrations/accounts/${state.accessAccountId}/access`, { method: "PATCH", body: JSON.stringify({ userIds, categoryIds }) });
    $("#account-access-dialog").close();
    toast("Atendentes e áreas da conta atualizados.");
    await loadOverview();
  } catch (error) { toast(error.message, true); }
}

async function loadUsers() {
  const [users, categories] = await Promise.all([api("/api/users"), api("/api/categories")]);
  state.users = users;
  state.categories = categories;
}
async function testConnection(accountId) {
  try {
    const result = await api(`/api/integrations/accounts/${accountId}/test-connection`, { method: "POST" });
    toast(`Status: ${STATUS_LABELS[result.status] || result.status}${result.message ? ` — ${result.message}` : ""}`, result.status !== "CONNECTED");
  } catch (error) { toast(error.message, true); }
  await loadOverview();
}

async function toggleAccount(accountId, enabled) {
  try {
    await api(`/api/integrations/accounts/${accountId}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled }) });
    toast(enabled ? "Conta ativada." : "Conta desativada.");
    await loadOverview();
  } catch (error) { toast(error.message, true); }
}

async function deleteAccount(accountId) {
  if (!confirm("Remover esta conta de integração? As credenciais salvas serão apagadas.")) return;
  try {
    await api(`/api/integrations/accounts/${accountId}`, { method: "DELETE" });
    toast("Conta removida.");
    await loadOverview();
  } catch (error) { toast(error.message, true); }
}

async function loadOverview() {
  const overview = await api("/api/integrations/overview");
  state.overview = MARKETPLACE_UI_ENABLED ? overview : overview.filter((entry) => !isMarketplaceChannel(entry.channel));
  renderCards();
}

async function loadSettings() {
  state.settings = await api("/api/integrations/settings");
  $("#new-channels-toggle").checked = Boolean(state.settings.newChannelsEnabled);
  $("#social-auto-reply-toggle").checked = Boolean(state.settings.socialAutoReplyEnabled);
  $("#social-comment-auto-reply-toggle").checked = Boolean(state.settings.socialCommentAutoReplyEnabled);
  $("#social-private-auto-reply-toggle").checked = Boolean(state.settings.socialPrivateAutoReplyEnabled);
}

$("#account-form").addEventListener("submit", saveAccount);
$("#account-access-form").addEventListener("submit", saveAccountAccess);
$("#account-access-cancel").addEventListener("click", () => $("#account-access-dialog").close());
$("#account-cancel").addEventListener("click", () => $("#account-dialog").close());
$("#oauth-selection-cancel").addEventListener("click", () => $("#oauth-selection-dialog").close());
$("#oauth-selection-options").addEventListener("click", (event) => {
  const button = event.target.closest("[data-candidate-id]");
  if (button) selectOAuthCandidate(button.dataset.candidateId);
});
$("#new-channels-toggle").addEventListener("change", async (event) => {
  try {
    await api("/api/integrations/settings", { method: "PATCH", body: JSON.stringify({ newChannelsEnabled: event.target.checked }) });
    toast(event.target.checked ? "Novos canais permitidos." : "Novos canais bloqueados (WhatsApp continua ativo).");
  } catch (error) {
    event.target.checked = !event.target.checked;
    toast(error.message, true);
  }
});

function socialReplyFlagToggle(elementId, key, label) {
  $(elementId).addEventListener("change", async (event) => {
    try {
      await api("/api/integrations/settings/social-reply", { method: "PATCH", body: JSON.stringify({ [key]: event.target.checked }) });
      toast(`${label} ${event.target.checked ? "ativado" : "desativado"}.`);
    } catch (error) {
      event.target.checked = !event.target.checked;
      toast(error.message, true);
    }
  });
}
socialReplyFlagToggle("#social-auto-reply-toggle", "socialAutoReplyEnabled", "Auto-reply social");
socialReplyFlagToggle("#social-comment-auto-reply-toggle", "socialCommentAutoReplyEnabled", "Auto-reply em comentários");
socialReplyFlagToggle("#social-private-auto-reply-toggle", "socialPrivateAutoReplyEnabled", "Auto-reply em Direct/Messenger");

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

const MAPPING_CHANNEL_LABELS = {
  INSTAGRAM_COMMENTS: "Instagram · Comentários", FACEBOOK_COMMENTS: "Facebook · Comentários",
  INSTAGRAM_DIRECT: "Instagram · Direct", FACEBOOK_MESSENGER: "Facebook · Messenger",
};

async function loadSocialMappings() {
  state.socialMappings = await api("/api/social-content-mappings");
  renderSocialMappings();
}

function renderSocialMappings() {
  const list = $("#social-mapping-list");
  if (!state.socialMappings?.length) { list.innerHTML = `<div class="empty-list">Nenhuma publicação mapeada ainda.</div>`; return; }
  list.innerHTML = state.socialMappings.map((mapping) => `
    <div class="social-mapping-row" data-active="${mapping.active}">
      <b>${escapeHtml(mapping.title || mapping.externalPostId)}</b>
      <span class="mapping-meta">${escapeHtml(MAPPING_CHANNEL_LABELS[mapping.channel] || mapping.channel)} &bull; produto: ${escapeHtml(mapping.product || "—")} &bull; post: ${escapeHtml(mapping.externalPostId)}</span>
      <button type="button" data-toggle-mapping="${mapping.id}" data-active="${mapping.active}">${mapping.active ? "Desativar" : "Reativar"}</button>
      <button type="button" data-remove-mapping="${mapping.id}">Remover</button>
    </div>`).join("");
}

$("#social-mapping-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/social-content-mappings", { method: "POST", body: JSON.stringify({
      channel: $("#mapping-channel").value, externalPostId: $("#mapping-post-id").value.trim(),
      title: $("#mapping-title").value.trim(), product: $("#mapping-product").value.trim(),
      permalink: $("#mapping-permalink").value.trim(),
    }) });
    event.target.reset();
    toast("Publicação mapeada.");
    await loadSocialMappings();
  } catch (error) { toast(error.message, true); }
});

$("#social-mapping-list").addEventListener("click", async (event) => {
  const toggleId = event.target.dataset.toggleMapping;
  const removeId = event.target.dataset.removeMapping;
  try {
    if (toggleId) {
      await api(`/api/social-content-mappings/${toggleId}/active`, { method: "PATCH", body: JSON.stringify({ active: event.target.dataset.active !== "true" }) });
      await loadSocialMappings();
    } else if (removeId) {
      await api(`/api/social-content-mappings/${removeId}`, { method: "DELETE" });
      await loadSocialMappings();
    }
  } catch (error) { toast(error.message, true); }
});

(async () => {
  try {
    const status = await api("/api/auth/status");
    if (!status.authenticated || !status.user.isMaster) return location.replace("/");
    $("#current-user").textContent = status.user.name;
    await loadUsers();
    await Promise.all([loadOverview(), loadSettings(), loadSocialMappings()]);
  } catch (error) {
    if ($("#channel-cards").querySelector(".skeleton-list")) $("#channel-cards").innerHTML = `<div class="empty-list">Não foi possível carregar as integrações.</div>`;
    toast(error.message, true);
  }
})();
