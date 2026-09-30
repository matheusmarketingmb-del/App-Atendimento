const MARKETPLACE_UI_ENABLED = window.MIBRO_FEATURES?.marketplaces !== false;
const isMarketplaceChannel = (channel) => window.isMarketplaceFeatureChannel?.(channel) === true;
if (MARKETPLACE_UI_ENABLED) document.querySelectorAll("[data-marketplace-feature]").forEach((element) => { element.hidden = false; });

const state = {
  conversations: [], categories: [], transferCategories: [], users: [], currentUser: null,
  selectedId: null, selectedContactId: null, selectedCategoryId: "", status: "", category: "", search: "", channel: "", emailMailbox: "GENERAL",
  // Filtros combináveis adicionais (item 11): multi-select, somam-se ao filtro
  // de status principal (single-select, inalterado) em vez de substituí-lo —
  // o backend já aceita status/priority como CSV, então cada Set aqui só
  // precisa virar uma lista separada por vírgula na hora de montar a query.
  statusToggle: new Set(), priorityToggle: new Set(), slaBreached: false, unassigned: false,
  categorySignature: "", listSignature: "", selectedHeaderSignature: "",
  selectedMessagesSignature: "", selectedNotesSignature: "", selectedActivitiesSignature: "", selectedMessageItems: [],
  selectedMessages: [], selectedContactName: "", contactFilesTab: "media",
  expandedCategories: new Set(), adminUsers: [], auditLogs: [], editingUserId: null, assignedUser: "",
  assignedUserActiveOnly: false, alertCursor: null, checkingAlerts: false,
  customerServiceWindow: null, templates: [], selectedTemplate: null,
  outboundChannels: [], outboundTemplates: [], selectedOutboundTemplate: null, categoryVisibility: { hideUncategorized:false, hiddenCategoryIds:[] }, visibilityMode:false,
  quickReplies: [], quickReplyCategoryFilter: "", quickReplySearch: "",
  botSuggestion: null, pendingBotSuggestion: null,
  mergedDestinations: [],
};
const $ = (selector) => document.querySelector(selector);
const defaultDocumentTitle = document.title;
let waitingTitleTimer = null;
let waitingAlertCount = 0;
let conversationLoadSequence = 0;
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[char]);
const initials = (name = "?") => name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
const conversationTimeZone = "America/Sao_Paulo";
const time = (value) => value ? new Intl.DateTimeFormat("pt-BR", { hour:"2-digit", minute:"2-digit", timeZone:conversationTimeZone }).format(new Date(value)) : "";
const statusLabel = (value) => ({ NOVO:"Novo", EM_ATENDIMENTO:"Em atendimento", AGUARDANDO_EQUIPE:"Aguardando equipe", AGUARDANDO_CLIENTE:"Aguardando cliente", HANDOFF_BOT:"Bot transferiu", BOT:"Bot", FINALIZADO:"Finalizado" })[value] || value;
const categoryLabel = (category) => category?.parent?.name ? `${category.parent.name}: ${category.name}` : (category?.name || "Sem categoria");
// Indicador discreto de prioridade (item 5): só aparece quando != NORMAL — mesmo padrão de badge pequeno já usado para categoria/status/responsável.
const priorityLabels = { ALTA:"Alta", URGENTE:"Urgente" };
const priorityLabel = (value) => priorityLabels[value] || value;
const priorityBadge = (priority) => priority && priority !== "NORMAL"
  ? `<span class="priority-label priority-${priority.toLowerCase()}">${escapeHtml(priorityLabel(priority))}</span>` : "";
// Tempo decorrido desde a última mensagem, em formato curto (min/h/d) — usado no card da lista.
function elapsedShort(value) {
  if (!value) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
// Indicador de SLA (item 10): estourado (destaque de alerta) ou minutos restantes — null quando não há SLA aplicável ao status atual (ver computeSlaMinutesRemaining no backend).
function slaBadge(minutesRemaining) {
  if (minutesRemaining === null || minutesRemaining === undefined) return "";
  if (minutesRemaining < 0) return `<span class="sla-label sla-overdue">SLA estourado</span>`;
  return `<span class="sla-label">SLA: ${minutesRemaining}min restantes</span>`;
}
const channelBadgeLabels = {
  INSTAGRAM_DIRECT: "IG", INSTAGRAM_COMMENTS: "IG",
  FACEBOOK_MESSENGER: "FB", FACEBOOK_COMMENTS: "FB",
  EMAIL: "Email", MERCADO_LIVRE: "ML", TIKTOK_SHOP: "TikTok",
  AMAZON_MARKETPLACE: "Amazon", SHOPEE: "Shopee", SHEIN_MARKETPLACE: "Shein",
  GOOGLE_REVIEWS: "Google", RECLAME_AQUI: "RA", ZENVIA: "Zenvia",
};
// WhatsApp (META) é o canal padrão/legado: não recebe badge para não competir
// visualmente com os demais rótulos do card nem sinalizar "novidade".
const channelBadge = (channelValue) => channelBadgeLabels[channelValue] || "";
const documentTypeLabels = new Map([
  ["application/pdf", "PDF"], ["text/plain", "TXT"], ["application/msword", "DOC"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "DOCX"],
  ["application/vnd.ms-excel", "XLS"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "XLSX"],
  ["application/vnd.ms-powerpoint", "PPT"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "PPTX"],
]);
const isDocumentMime = (value) => documentTypeLabels.has(String(value || "").toLowerCase());
const documentTypeLabel = (mimeType, fileName = "") => documentTypeLabels.get(String(mimeType || "").toLowerCase())
  || fileName.split(".").pop()?.toUpperCase().slice(0, 5) || "DOC";
function orderedCategories(categories) {
  const roots = categories.filter((category) => !category.parentId);
  const nested = roots.flatMap((root) => [root, ...categories.filter((category) => category.parentId === root.id)]);
  const included = new Set(nested.map((category) => category.id));
  return [...nested, ...categories.filter((category) => !included.has(category.id))];
}
function populateSubcategorySelect(parentId, selectedId = "", categories = state.transferCategories) {
  const select = $("#subcategory-select");
  const children = categories.filter((category) => category.active && category.parentId === parentId && category.selectable !== false);
  select.innerHTML = `<option value="">Subcategoria (opcional)</option>` + children.map((category) => `<option value="${category.id}">${escapeHtml(category.name)}</option>`).join("");
  select.hidden = !parentId || !children.length;
  if (children.some((category) => category.id === selectedId)) select.value = selectedId;
}
function populateTransferCategorySelect(categories, selectedPrimaryId = "", selectedSubcategoryId = "") {
  const active = categories.filter((category) => category.active);
  const roots = active.filter((category) => !category.parentId);
  $("#category-select").innerHTML = `${state.currentUser?.canViewUncategorized ? '<option value="">Sem categoria</option>' : '<option value="" disabled>Selecione a categoria</option>'}` +
    roots.map((category) => `<option value="${category.id}" data-selectable="${category.selectable !== false}">${escapeHtml(category.name)}</option>`).join("");
  if (roots.some((category) => category.id === selectedPrimaryId)) $("#category-select").value = selectedPrimaryId;
  populateSubcategorySelect($("#category-select").value, selectedSubcategoryId, categories);
}
function pendingCategoryId() {
  return $("#subcategory-select").value || $("#category-select").value || "";
}
function syncCategoryConfirmation() {
  const primaryOption = $("#category-select").selectedOptions[0];
  const unavailableRoot = !$("#subcategory-select").value && primaryOption?.dataset.selectable === "false";
  $("#confirm-category").disabled = !state.selectedId || unavailableRoot
    || pendingCategoryId() === state.selectedCategoryId;
}
// Aviso no topo das mensagens: de quem veio a transferência, se o histórico
// foi compartilhado, motivo e resumo de handoff (visível mesmo quando o
// histórico anterior está oculto para este atendente).
function handoffNoticeMarkup(c) {
  const handoff = c.currentHandoff;
  const parts = [];
  if (handoff) {
    const origin = handoff.transferredBy || handoff.from;
    parts.push(`<b>Transferida${origin ? ` por ${escapeHtml(origin)}` : ""}</b>`);
    if (handoff.historyShared === true) parts.push("Histórico anterior compartilhado com você.");
    if (handoff.reason) parts.push(`Motivo: ${escapeHtml(handoff.reason)}`);
    if (handoff.handoffSummary) parts.push(`Resumo: ${escapeHtml(handoff.handoffSummary)}`);
  }
  if (c.accessMode === "SUPERVISION") {
    const format = (iso) => iso ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "";
    const windows = (c.visibleWindows || []).map((window) => `${window.from ? format(window.from) : "início"} → ${window.to ? format(window.to) : "agora"}`).join(" • ");
    return `<div class="supervision-notice"><b>Acompanhamento de supervisão — somente leitura.</b><br>Você vê apenas os trechos atendidos pela sua equipe${windows ? `: ${escapeHtml(windows)}` : "."}</div>`;
  }
  if (c.messageHistoryLimited) parts.push("As mensagens anteriores ao encaminhamento estão ocultas para esta conta.");
  return parts.length ? `<div class="limited-history-notice">${parts.join("<br>")}</div>` : "";
}

function closeConversationView() {
  conversationLoadSequence += 1;
  state.selectedId = null;
  state.selectedContactId = null;
  state.selectedCategoryId = "";
  state.selectedHeaderSignature = "";
  state.selectedMessagesSignature = "";
  state.selectedNotesSignature = "";
  state.selectedActivitiesSignature = "";
  state.selectedMessageItems = [];
  state.selectedMessages = [];
  state.selectedContactName = "";
  state.mergedDestinations = [];
  $("#merge-contact").hidden = true;
  $("#merged-channel-control").hidden = true;
  state.botSuggestion = null;
  state.pendingBotSuggestion = null;
  hideBotSuggestion();
  state.customerServiceWindow = null;
  syncCustomerServiceWindow();
  if ($("#contact-files-dialog")?.open) $("#contact-files-dialog").close();
  closeContextPanel();
  $("#chat-content").hidden = true;
  $("#empty-state").hidden = false;
  $("#chat-panel").classList.remove("open");
  $("#confirm-category").disabled = true;
}
function syncWaitingAttention(count) {
  const waitingCount = Number(count) || 0;
  waitingAlertCount = waitingCount;
  if (waitingCount && !waitingTitleTimer) {
    let warningVisible = false;
    waitingTitleTimer = setInterval(() => {
      warningVisible = !warningVisible;
      document.title = warningVisible ? `⚠ ${waitingAlertCount} AGUARDANDO RESPOSTA` : defaultDocumentTitle;
    }, 900);
  }
  if (!waitingCount && waitingTitleTimer) {
    clearInterval(waitingTitleTimer);
    waitingTitleTimer = null;
    document.title = defaultDocumentTitle;
  }
}
function deliveryStatus(status) {
  return ({
    PENDENTE:["◷", "Pendente", "pending"], ENVIADA:["✓", "Enviada", "sent"],
    ENTREGUE:["✓✓", "Entregue", "delivered"], LIDA:["✓✓", "Lida", "read"],
    FALHOU:["!", "Falhou", "failed"],
  })[status] || ["", "", ""];
}
function syncThemeToggle() {
  const dark = document.documentElement.dataset.theme === "dark";
  $("#theme-icon").textContent = dark ? "☀" : "☾";
  $("#theme-toggle").setAttribute("aria-label", dark ? "Usar tema claro" : "Usar tema escuro");
  $("#theme-toggle").title = dark ? "Usar tema claro" : "Usar tema escuro";
}

function setFiltersPanelCollapsed(collapsed, persist = true) {
  const workspace = $(".workspace");
  const button = $("#toggle-filters-panel");
  workspace.classList.toggle("filters-collapsed", collapsed);
  button.textContent = collapsed ? "\u203a" : "\u2039";
  button.setAttribute("aria-expanded", String(!collapsed));
  button.setAttribute("aria-label", collapsed ? "Mostrar filtros e categorias" : "Recolher filtros e categorias");
  button.title = collapsed ? "Mostrar filtros e categorias" : "Recolher filtros e categorias";
  if (persist) try { localStorage.setItem("mibro-filters-collapsed", collapsed ? "1" : "0"); } catch {}
}

function setConversationListCollapsed(collapsed) {
  if (collapsed && !state.selectedId) return;
  const workspace = $(".workspace");
  const button = $("#toggle-conversation-list");
  workspace.classList.toggle("conversation-list-collapsed", collapsed);
  button.textContent = collapsed ? "\u203a" : "\u2039";
  button.setAttribute("aria-expanded", String(!collapsed));
  button.title = collapsed ? "Mostrar lista de conversas" : "Recolher lista de conversas";
}

// Painel lateral direito (item 7 do redesign): abas Detalhes/Notas/Histórico/
// Bot/SLA/Arquivos substituindo as antigas gavetas independentes de
// notas/histórico. Os elementos #notes-panel/#history-panel/#bot-suggestion-card
// mantêm os mesmos IDs e lógica de dados — só passam a viver dentro de uma
// aba em vez de um painel deslizante próprio.
const CONTEXT_TABS = ["details", "notes", "history", "bot", "sla", "files"];
function setContextPanelOpen(open, persist = true) {
  const workspace = $(".workspace");
  workspace.classList.toggle("context-open", open);
  $("#context-panel").setAttribute("aria-hidden", String(!open));
  if (persist) try { localStorage.setItem("mibro-context-open", open ? "1" : "0"); } catch {}
}
function activeContextTab() {
  return document.querySelector("[data-context-tab].active")?.dataset.contextTab || "details";
}
function setContextTab(tab, { open = true } = {}) {
  if (!CONTEXT_TABS.includes(tab)) tab = "details";
  document.querySelectorAll("[data-context-tab]").forEach((button) => button.classList.toggle("active", button.dataset.contextTab === tab));
  document.querySelectorAll("[data-context-panel]").forEach((panel) => { panel.hidden = panel.dataset.contextPanel !== tab; });
  if (tab === "bot") $("[data-context-tab='bot']")?.classList.remove("has-update");
  try { localStorage.setItem("mibro-context-tab", tab); } catch {}
  if (open) setContextPanelOpen(true);
}
function closeContextPanel() { setContextPanelOpen(false); }
function toggleContextTab(tab) {
  if ($(".workspace").classList.contains("context-open") && activeContextTab() === tab) closeContextPanel();
  else setContextTab(tab);
}
document.querySelectorAll("[data-context-tab]").forEach((button) => button.addEventListener("click", () => setContextTab(button.dataset.contextTab)));
$("#context-panel-close").addEventListener("click", closeContextPanel);
$("#context-panel-toggle").addEventListener("click", () => toggleContextTab("details"));
$("#context-files-open-all").addEventListener("click", openContactFiles);
const messagePreview = (message) => {
  if (!message) return "Conversa sem mensagens";
  if (message.type === "image") return message.text && message.text !== "[image]" ? `📷 ${message.text}` : "📷 Imagem";
  if (message.type === "audio") return "▶ Áudio";
  if (message.type === "video") return message.text && message.text !== "[video]" ? `🎬 ${message.text}` : "🎬 Vídeo";
  if (message.type === "sticker") return "💟 Figurinha";
  if (message.type === "document") return `📄 ${message.mediaFileName || "Documento"}`;
  return message.text || `[${message.type}]`;
};

function formatFileSize(value, typeLabel = "ARQUIVO") {
  const bytes = Number(value) || 0;
  if (!bytes) return typeLabel;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB • ${typeLabel}`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".0", "")} MB • ${typeLabel}`;
}

function isConversationCategoryHidden(conversation) {
  const visibility = state.categoryVisibility;
  if (!conversation.categoryId) return Boolean(visibility.hideUncategorized);
  return visibility.hiddenCategoryIds.includes(conversation.categoryId);
}

function conversationSignature(conversation) {
  const lastMessage = conversation.messages?.[0];
  const note = conversation.contact.notes?.[0];
  return JSON.stringify([
    conversation.id, conversation.id === state.selectedId, conversation.status, conversation.channel, conversation.unreadCount, conversation.lastMessageAt,
    conversation.categoryId, conversation.category?.name, conversation.category?.color, conversation.category?.parent?.name,
    conversation.assignedUserId, conversation.assignedUser?.name, conversation.channelAccountId, conversation.channelAccount?.name,
    conversation.priority, conversation.firstResponseSlaBreached, conversation.responseSlaBreached, conversation.slaMinutesRemaining,
    conversation.isPinned,
    conversation.contact.customName, conversation.contact.name, conversation.contact.email, conversation.contact.phone, conversation.contact._count?.notes,
    note?.id, note?.content,
    lastMessage?.id, lastMessage?.text, lastMessage?.type,
  ]);
}

function conversationCardMarkup(c) {
  const last = c.messages[0]; const name = c.contact.customName || c.contact.name || c.contact.email || c.contact.phone; const note = c.contact.notes?.[0];
  return `<button class="conversation-card ${c.id === state.selectedId ? "active" : ""}" data-id="${escapeHtml(c.id)}">
    <span class="card-grip" aria-hidden="true"></span><span class="avatar">${escapeHtml(initials(name))}</span><span class="card-main">
    <span class="card-title"><strong>${c.isPinned ? `<i class="conversation-pin" title="Conversa fixada">★</i>` : ""}${escapeHtml(name)}</strong><small>${escapeHtml(c.contact.email || c.contact.phone || "")}</small></span>
    <span class="preview">${escapeHtml(messagePreview(last))}</span>
    <span class="card-labels">${channelBadge(c.channel) ? `<span class="channel-label">${escapeHtml(channelBadge(c.channel))}</span>` : ""}${c.channel === "META" && c.channelAccount?.name ? `<span class="channel-label">${escapeHtml(c.channelAccount.name)}</span>` : ""}<span class="category-label" style="color:${c.category?.color || "#666"};border-color:${c.category?.color || "#aaa"}">${escapeHtml(categoryLabel(c.category))}</span><span class="status-label">${escapeHtml(statusLabel(c.status))}</span>${c.assignedUser ? `<span class="assignee-label">${escapeHtml(c.assignedUser.name)}</span>` : ""}${priorityBadge(c.priority)}${slaBadge(c.slaMinutesRemaining)}</span></span>
    <span class="card-side"><span>${time(c.lastMessageAt)}</span><span class="card-elapsed">${escapeHtml(elapsedShort(c.lastMessageAt))}</span>${c.unreadCount ? `<span class="unread">${c.unreadCount}</span>` : ""}</span>
    <span class="note-preview"><b>NOTA</b> ${escapeHtml(note?.content || "Sem notas para este contato")}${c.contact._count?.notes ? `<i>${c.contact._count.notes}</i>` : ""}</span></button>`;
}
function renderConversationCards(conversations) {
  const list = $("#conversation-list");
  list.querySelector(".skeleton-list")?.remove();
  if (!conversations.length) {
    if (!list.querySelector(".empty-list")) list.innerHTML = `<div class="empty-list">Nenhuma conversa encontrada.</div>`;
    return;
  }
  list.querySelector(".empty-list")?.remove();
  const existing = new Map([...list.querySelectorAll(".conversation-card")].map((card) => [card.dataset.id, card]));
  const expectedIds = new Set(conversations.map((conversation) => conversation.id));
  let position = list.firstElementChild;
  for (const conversation of conversations) {
    const signature = conversationSignature(conversation);
    let card = existing.get(conversation.id);
    if (!card || card.dataset.renderSignature !== signature) {
      const replacesCurrentPosition = card === position;
      const template = document.createElement("template");
      template.innerHTML = conversationCardMarkup(conversation);
      const replacement = template.content.firstElementChild;
      replacement.dataset.renderSignature = signature;
      if (card) card.replaceWith(replacement);
      card = replacement;
      if (replacesCurrentPosition) position = card;
    }
    if (card !== position) list.insertBefore(card, position);
    position = card.nextElementSibling;
  }
  existing.forEach((card, id) => { if (!expectedIds.has(id)) card.remove(); });
}

function renderWhatsAppText(value) {
  const escaped = escapeHtml(String(value ?? ""));
  return escaped.split(/(```[\s\S]*?```)/g).map((part) => {
    if (part.startsWith("```") && part.endsWith("```") && part.length >= 6) {
      return `<code class="whatsapp-code">${part.slice(3, -3)}</code>`;
    }
    return part
      .replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>")
      .replace(/_([^_\n]+)_/g, "<em>$1</em>")
      .replace(/~([^~\n]+)~/g, "<s>$1</s>")
      .replace(/`([^`\n]+)`/g, '<code class="whatsapp-inline-code">$1</code>')
      .replace(/\n/g, "<br>");
  }).join("");
}

function messageContent(message) {
  const mediaUrl = `/api/messages/${encodeURIComponent(message.id)}/media`;
  if (message.type === "image" && message.mediaStorageKey) {
    return `<a class="message-image-link" href="${mediaUrl}" target="_blank" rel="noopener"><img class="message-image" src="${mediaUrl}" alt="${escapeHtml(message.text || "Imagem da conversa")}" loading="lazy"></a>${message.text && message.text !== "[image]" ? `<p>${renderWhatsAppText(message.text)}</p>` : ""}`;
  }
  if (message.type === "audio" && message.mediaStorageKey) {
    return `<audio class="message-audio" controls preload="metadata"><source src="${mediaUrl}" type="${escapeHtml(message.mediaMimeType || "audio/ogg")}">Seu navegador não conseguiu reproduzir este áudio.</audio><a class="audio-download" href="${mediaUrl}" download>Baixar áudio</a>`;
  }
  if (message.type === "video" && message.mediaStorageKey) {
    return `<video class="message-video" controls preload="metadata" playsinline><source src="${mediaUrl}" type="${escapeHtml(message.mediaMimeType || "video/mp4")}">Seu navegador não conseguiu reproduzir este vídeo.</video>${message.text && message.text !== "[video]" ? `<p>${renderWhatsAppText(message.text)}</p>` : ""}<a class="media-download" href="${mediaUrl}" download>Baixar vídeo</a>`;
  }
  if (message.type === "sticker" && message.mediaStorageKey) {
    return `<img class="message-sticker" src="${mediaUrl}" alt="Figurinha recebida" loading="lazy">`;
  }
  if (message.type === "document" && message.mediaStorageKey) {
    const fileName = message.mediaFileName || "documento";
    const typeLabel = documentTypeLabel(message.mediaMimeType, fileName);
    return `<a class="message-document" href="${mediaUrl}" target="_blank" rel="noopener"><span class="document-icon" aria-hidden="true">${escapeHtml(typeLabel)}</span><span class="document-details"><strong>${escapeHtml(fileName)}</strong><small>${escapeHtml(formatFileSize(message.mediaSize, typeLabel))}</small></span><span class="document-action">Abrir</span></a>${message.text && message.text !== "[document]" ? `<p>${renderWhatsAppText(message.text)}</p>` : ""}`;
  }
  if (message.type === "image") return "<p>[Imagem indisponível]</p>";
  if (message.type === "audio") return "<p>[Áudio indisponível]</p>";
  if (message.type === "video") return "<p>[Vídeo indisponível]</p>";
  if (message.type === "sticker") return "<p>[Figurinha indisponível]</p>";
  if (message.type === "document") return "<p>[Documento indisponível]</p>";
  return `<p>${renderWhatsAppText(message.text || `[${message.type}]`)}</p>`;
}

// Item 27/42 do plano Social — botões de moderação só aparecem quando a
// capability correspondente é realmente true (nunca por omissão) e a
// mensagem tem um id externo (é um comentário real na Graph API, não um
// registro interno). "Apagar" fica escondido para quem não é Master — o
// backend barra de qualquer forma, mas evita o atendente clicar e levar 403.
function moderationActionsMarkup(message) {
  if (!SOCIAL_COMMENT_CHANNELS.has(state.selectedChannel) || !message.externalId) return "";
  const caps = state.selectedChannelCapabilities || {};
  const buttons = [];
  if (caps.canHide) buttons.push(`<button type="button" class="moderate-comment" data-message-id="${escapeHtml(message.id)}" data-action="hide" title="Ocultar comentário">Ocultar</button>`);
  if (caps.canLike) buttons.push(`<button type="button" class="moderate-comment" data-message-id="${escapeHtml(message.id)}" data-action="like" title="Curtir comentário">Curtir</button>`);
  if (caps.canDelete && state.currentUser?.isMaster) buttons.push(`<button type="button" class="moderate-comment danger" data-message-id="${escapeHtml(message.id)}" data-action="delete" title="Apagar comentário (irreversível)">Apagar</button>`);
  return buttons.length ? `<div class="moderation-actions">${buttons.join("")}</div>` : "";
}

function messageRowMarkup(message) {
  const [symbol, label, statusClass] = deliveryStatus(message.status);
  return `<div class="message-row ${message.direction === "ENVIADA" ? "sent" : "received"}" data-message-id="${escapeHtml(message.id)}"><div class="bubble ${["image", "audio", "video", "sticker", "document"].includes(message.type) ? `${message.type}-bubble` : ""} ${message.reactionEmoji ? "has-reaction" : ""}">${messageContent(message)}<footer>${message.sentByUser ? `<span class="author">${escapeHtml(message.sentByUser.name)}</span>` : ""}<span>${time(message.occurredAt)}</span>${message.direction === "ENVIADA" ? `<span class="delivery-status ${statusClass}" title="${label}" aria-label="${label}">${symbol}</span>` : ""}</footer>${message.reactionEmoji ? `<span class="message-reaction" title="Reação do cliente">${escapeHtml(message.reactionEmoji)}</span>` : ""}${moderationActionsMarkup(message)}</div></div>`;
}

function messageDateKey(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year:"numeric", month:"2-digit", day:"2-digit", timeZone:conversationTimeZone,
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map(({ type, value: partValue }) => [type, partValue]));
  return `${values.year}-${values.month}-${values.day}`;
}

function messageDateLabel(value, now = new Date()) {
  const key = messageDateKey(value);
  const todayKey = messageDateKey(now);
  const dayNumber = (dateKey) => {
    const [year, month, day] = dateKey.split("-").map(Number);
    return Date.UTC(year, month - 1, day) / 86400000;
  };
  const difference = dayNumber(todayKey) - dayNumber(key);
  if (difference === 0) return "Hoje";
  if (difference === 1) return "Ontem";
  return new Intl.DateTimeFormat("pt-BR", {
    day:"2-digit", month:"long", year:"numeric", timeZone:conversationTimeZone,
  }).format(new Date(value));
}

function messageRowsMarkup(messages, previousMessage = null) {
  let previousDateKey = previousMessage ? messageDateKey(previousMessage.occurredAt) : "";
  return messages.map((message) => {
    const currentDateKey = messageDateKey(message.occurredAt);
    const label = messageDateLabel(message.occurredAt);
    const separator = currentDateKey === previousDateKey ? ""
      : `<div class="message-date-separator" role="separator" aria-label="${escapeHtml(label)}"><span>${escapeHtml(label)}</span></div>`;
    previousDateKey = currentDateKey;
    return `${separator}${messageRowMarkup(message)}`;
  }).join("");
}

function messagesWithReactions(messages) {
  const reactions = new Map();
  for (const message of messages) {
    if (message.type !== "reaction") continue;
    const targetId = message.rawPayload?.reaction?.message_id;
    const emoji = message.rawPayload?.reaction?.emoji ?? message.text ?? "";
    if (!targetId) continue;
    if (emoji) reactions.set(targetId, emoji); else reactions.delete(targetId);
  }
  return messages
    .filter((message) => message.type !== "reaction")
    .map((message) => ({ ...message, reactionEmoji: reactions.get(message.externalId) || "" }));
}

function sharedFileMeta(message) {
  const author = message.direction === "ENVIADA" ? (message.sentByUser?.name || "Equipe") : "Cliente";
  const occurredAt = new Intl.DateTimeFormat("pt-BR", {
    dateStyle:"short", timeStyle:"short", timeZone:conversationTimeZone,
  }).format(new Date(message.occurredAt));
  return `${author} • ${occurredAt}`;
}

function externalLinks(messages) {
  const found = new Map();
  const pattern = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
  for (const message of messages) {
    for (const match of String(message.text || "").match(pattern) || []) {
      const raw = match.replace(/[),.!?;:\]}]+$/g, "");
      const candidate = raw.toLowerCase().startsWith("www.") ? `https://${raw}` : raw;
      try {
        const parsed = new URL(candidate);
        if (!["http:", "https:"].includes(parsed.protocol)) continue;
        if (!found.has(parsed.href)) found.set(parsed.href, {
          href:parsed.href, label:raw, host:parsed.hostname.replace(/^www\./, ""), message,
        });
      } catch {}
    }
  }
  return [...found.values()];
}

function renderContactFiles(tab = "media") {
  state.contactFilesTab = tab;
  const messages = state.selectedMessages || [];
  const media = messages.filter((message) => ["image", "video"].includes(message.type) && message.mediaStorageKey);
  const documents = messages.filter((message) => message.type === "document" && message.mediaStorageKey);
  const links = externalLinks(messages);
  $("#media-files-count").textContent = media.length;
  $("#document-files-count").textContent = documents.length;
  $("#link-files-count").textContent = links.length;
  document.querySelectorAll("[data-files-tab]").forEach((button) => button.classList.toggle("active", button.dataset.filesTab === tab));

  let markup = "";
  if (tab === "media") {
    markup = media.length ? `<div class="shared-media-grid">${media.map((message) => {
      const url = `/api/messages/${encodeURIComponent(message.id)}/media`;
      const label = message.type === "video" ? "Vídeo" : "Imagem";
      const preview = message.type === "video"
        ? `<video controls preload="metadata" playsinline><source src="${url}" type="${escapeHtml(message.mediaMimeType || "video/mp4")}">Vídeo indisponível.</video>`
        : `<img src="${url}" alt="${escapeHtml(message.text || "Imagem da conversa")}" loading="lazy">`;
      const caption = message.text && !["[image]", "[video]"].includes(message.text) ? message.text : label;
      const wrapper = message.type === "image" ? "a" : "article";
      const linkAttributes = message.type === "image" ? ` href="${url}" target="_blank" rel="noopener"` : "";
      return `<${wrapper} class="shared-media-card"${linkAttributes}>${preview}<span class="shared-file-caption"><b>${escapeHtml(caption)}</b><small>${escapeHtml(sharedFileMeta(message))}</small></span></${wrapper}>`;
    }).join("")}</div>` : `<div class="shared-empty">Nenhuma imagem ou vídeo disponível nesta conversa.</div>`;
  } else if (tab === "documents") {
    markup = documents.length ? `<div class="shared-document-list">${documents.map((message) => {
      const url = `/api/messages/${encodeURIComponent(message.id)}/media`;
      const fileName = message.mediaFileName || "documento";
      const typeLabel = documentTypeLabel(message.mediaMimeType, fileName);
      return `<a class="shared-document-card" href="${url}" target="_blank" rel="noopener"><span class="shared-document-icon">${escapeHtml(typeLabel)}</span><span class="shared-file-details"><b>${escapeHtml(fileName)}</b><small>${escapeHtml(`${formatFileSize(message.mediaSize, typeLabel)} • ${sharedFileMeta(message)}`)}</small></span><span class="shared-open">Abrir</span></a>`;
    }).join("")}</div>` : `<div class="shared-empty">Nenhum documento disponível nesta conversa.</div>`;
  } else {
    markup = links.length ? `<div class="shared-link-list">${links.map((link) => `<a class="shared-link-card" href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer"><span class="shared-link-icon">↗</span><span class="shared-file-details"><b>${escapeHtml(link.label)}</b><small>${escapeHtml(`${link.host} • ${sharedFileMeta(link.message)}`)}</small></span><span class="shared-open">Abrir</span></a>`).join("")}</div>` : `<div class="shared-empty">Nenhum link encontrado nas mensagens desta conversa.</div>`;
  }
  $("#contact-files-content").innerHTML = markup;
}

function openContactFiles() {
  if (!state.selectedId) return;
  $("#contact-files-title").textContent = state.selectedContactName || "Arquivos da conversa";
  $("#contact-files-conversation-id").textContent = state.selectedId;
  $("#analyze-conversation-learning").hidden = !state.currentUser?.isMaster;
  renderContactFiles("media");
  $("#contact-files-dialog").showModal();
}

function syncMessageStatuses(messages) {
  const rows = new Map([...$("#messages").querySelectorAll("[data-message-id]")].map((row) => [row.dataset.messageId, row]));
  for (const message of messages) {
    if (message.direction !== "ENVIADA") continue;
    const status = rows.get(message.id)?.querySelector(".delivery-status");
    if (!status) continue;
    const [symbol, label, statusClass] = deliveryStatus(message.status);
    status.textContent = symbol; status.title = label; status.setAttribute("aria-label", label);
    status.className = `delivery-status ${statusClass}`;
  }
}

function renderFaq() {
  const user = state.currentUser;
  if (!user) return;
  const profile = ({ ADMIN:"Master", SUPERVISOR:"Supervisor", ATENDENTE:"Atendente" })[user.role] || user.role;
  const common = [
    ["Quais conversas aparecem para mim?", "Você vê conversas atribuídas a você ou pertencentes às categorias e aos números/canais liberados para sua conta. Categorias não liberadas não aparecem na barra lateral."],
    ["Posso transferir para uma categoria que não vejo?", "Sim. Ao abrir uma conversa, o seletor de destino mostra as categorias ativas permitidas para aquele canal. Categorias Somente Master não aparecem para Atendentes ou Supervisores."],
    ["O que acontece após transferir para uma categoria sem acesso?", "A transferência é concluída e a conversa sai da sua tela, pois você não possui acesso à fila de destino."],
    ["Transferir e sinalizar envio são iguais?", "Não. Transferir muda a categoria da conversa. Sinalizar envio apenas avisa o setor no chat interno."],
    ["O histórico anterior acompanha a conversa?", "Normalmente sim. Marque a opção de ocultar histórico apenas quando o setor de destino não puder consultar as mensagens anteriores."],
  ];
  const byRole = {
    ATENDENTE: [
      ["Como começo um atendimento?", "Abra a conversa, confira o canal e o cliente e use Assumir conversa quando ela ainda não tiver responsável."],
      ["Posso trocar o responsável?", user.canTransferConversations ? "Sim. Sua conta possui a permissão Alterar responsável." : "Não. Sua conta não possui a permissão Alterar responsável; solicite ao Master quando necessário."],
      ["Como uso uma resposta rápida?", "Clique no ícone de raio, escolha a resposta, revise o texto e envie. A seleção nunca envia automaticamente."],
    ],
    SUPERVISOR: [
      ["Como vejo conversas dos Atendentes?", user.canViewTeamActivity ? "Use o filtro de responsável. Você verá os membros dentro das categorias e canais liberados para sua conta." : "Sua conta precisa da permissão Acompanhar equipe, além dos acessos às categorias e canais supervisionados."],
      ["Posso alterar prioridades?", "Sim. Supervisores podem definir prioridade Normal, Alta ou Urgente."],
      ["Posso alterar configurações?", "Configurações de Conversas ficam disponíveis apenas para consulta. Alterações administrativas são feitas pelo Master."],
    ],
    ADMIN: [
      ["Como libero um novo usuário?", "Em Equipe, defina o perfil, as permissões, cada categoria/subcategoria e depois libere também os números ou contas de canal necessários."],
      ["Quando usar Somente Master?", "Use apenas para categorias realmente restritas. Elas não aparecem nem aceitam transferências feitas por Atendentes ou Supervisores."],
      ["Onde verifico alterações importantes?", "Use a Auditoria geral para consultar mudanças em usuários, conversas, categorias, Bots e configurações."],
    ],
  };
  const permissions = [
    ["Alterar responsável", user.canTransferConversations],
    ["Acompanhar equipe", user.canViewTeamActivity],
    ["Visualizar histórico", user.canViewConversationHistory],
    ["Ver mensagens anteriores", user.canViewPreviousMessages],
    ["Iniciar conversas", user.canStartConversations],
    ["Fundir contatos", user.canMergeContacts],
    ["Campanhas e templates", user.canManageCampaigns],
  ];
  $("#faq-role-label").textContent = `FAQ do perfil ${profile}`;
  $("#faq-profile-name").textContent = `${user.name} · ${profile}`;
  $("#faq-permissions").innerHTML = permissions.map(([label, enabled]) =>
    `<span class="faq-permission ${enabled ? "enabled" : ""}">${enabled ? "✓" : "–"} ${escapeHtml(label)}</span>`
  ).join("");
  $("#faq-content").innerHTML = [...common, ...(byRole[user.role] || [])].map(([question, answer], index) =>
    `<details class="faq-item" ${index === 0 ? "open" : ""}><summary>${escapeHtml(question)}</summary><p>${escapeHtml(answer)}</p></details>`
  ).join("");
}

async function loadCurrentUser() {
  const status = await api("/api/auth/status");
  if (!status.authenticated) return location.replace("/login.html");
  state.currentUser = status.user;
  $("#current-user").textContent = status.user.name;
  $("#bots-button").hidden = !status.user.isMaster;
  $("#quick-replies-admin-button").hidden = !status.user.isMaster;
  $("#knowledge-base-button").hidden = !status.user.isMaster;
  $("#integrations-button").hidden = !status.user.isMaster;
  $("#campaigns-button").hidden = !status.user.canManageCampaigns;
  $("#new-conversation").hidden = !(status.user.canStartConversations || status.user.canManageCampaigns);
  $("#conversation-settings-button").hidden = !status.user.isMaster && status.user.role !== "SUPERVISOR";
  $("#team-button").hidden = !status.user.isMaster;
  // Supervisão: Master → "Equipes" (todas); Supervisor → "Minha equipe" (só a dele).
  $("#supervision-button").hidden = !(status.user.isMaster || status.user.role === "SUPERVISOR");
  $("#supervision-button-label").textContent = status.user.isMaster ? "Equipes" : "Minha equipe";
  $("#assignment-timeline").hidden = !(status.user.isMaster || status.user.role === "SUPERVISOR");
  $("#open-audit").hidden = !status.user.isMaster;
  $("#manage-categories").hidden = !status.user.canManageCategories;
  $("#category-master-only-field").hidden = !status.user.isMaster;
  $("#assignee-select").disabled = !status.user.canTransferConversations;
  // Controle de prioridade fica visível para todos (mesmo padrão do
  // assignee-select acima) — só desabilitado quando o usuário não tem
  // permissão, já que o backend (assertCanSetPriority) barra o PATCH de
  // qualquer forma; mais simples do que esconder o controle inteiro.
  $("#priority-select").disabled = !(status.user.isMaster || status.user.role === "SUPERVISOR" || status.user.canSetConversationPriority);
  $("#history-toggle").hidden = !status.user.canViewConversationHistory;
  configureNotificationButton();
  const cursorKey = `mibro-alert-cursor:${status.user.id}`;
  let storedCursor = null;
  try { storedCursor = localStorage.getItem(cursorKey); } catch {}
  state.alertCursor = storedCursor && !Number.isNaN(new Date(storedCursor).getTime()) ? storedCursor : new Date().toISOString();
  try { localStorage.setItem(cursorKey, state.alertCursor); } catch {}
}

async function loadUsers() {
  state.users = await api("/api/users");
  $("#assignee-select").innerHTML = `<option value="">Sem responsável</option>` + state.users.map((user) => `<option value="${user.id}">${escapeHtml(user.name)}</option>`).join("");
}

async function api(path, options) {
  const headers = new Headers(options?.headers || {});
  if (options?.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Não foi possível concluir a operação.");
    error.code = data.code;
    error.status = response.status;
    error.customerServiceWindow = data.customerServiceWindow;
    throw error;
  }
  return data;
}
function toast(message, error = false) { const el = $("#toast"); el.textContent = message; el.className = `toast show${error ? " error" : ""}`; setTimeout(() => el.className = "toast", 2600); }

function syncCustomerServiceWindow() {
  const configured = Boolean(state.customerServiceWindow?.configured);
  const closed = Boolean(state.selectedId && state.customerServiceWindow?.requiresTemplate);
  const canUseTemplates = Boolean(state.currentUser?.canManageCampaigns);
  $("#open-templates").hidden = !configured || !canUseTemplates;
  $("#service-window-notice").hidden = !closed || !canUseTemplates;
  $("#composer").classList.toggle("window-closed", closed);
  $("#message-input").disabled = closed;
  $("#attachment-input").disabled = closed;
  $("#send-button").disabled = closed;
  $("#message-input").placeholder = closed ? (canUseTemplates ? "Use um template aprovado para retomar o contato" : "Envio indisponível") : "Digite uma mensagem...";
}

function templateRateLabel(template) {
  const pricing = template?.pricing;
  if (!pricing || !Number.isFinite(Number(pricing.rate))) return "Tarifa indisponível";
  const amount = new Intl.NumberFormat("pt-BR", { style:"currency", currency:pricing.currency || "BRL", minimumFractionDigits:4 }).format(Number(pricing.rate));
  return `Tarifa base Brasil: ${amount} por mensagem entregue`;
}

// Item 2/24 do plano Social — nunca deixar ambíguo se a resposta vai ficar
// pública (comentário do Instagram/Facebook) ou privada (Direct/Messenger).
const SOCIAL_COMMENT_CHANNELS = new Set(["INSTAGRAM_COMMENTS", "FACEBOOK_COMMENTS"]);
const SOCIAL_DIRECT_CHANNELS = new Set(["INSTAGRAM_DIRECT", "FACEBOOK_MESSENGER"]);

function syncSocialReplyMode(channel, capabilities) {
  const notice = $("#social-reply-mode-notice");
  const isComment = SOCIAL_COMMENT_CHANNELS.has(channel);
  const isDirect = SOCIAL_DIRECT_CHANNELS.has(channel);
  if (!isComment && !isDirect) { notice.hidden = true; notice.removeAttribute("data-mode"); return; }
  notice.hidden = false;
  notice.dataset.mode = isComment ? "public" : "private";
  $("#social-reply-mode-icon").textContent = isComment ? "🌐" : "🔒";
  $("#social-reply-mode-text").textContent = isComment
    ? "Resposta pública — esta resposta ficará visível para qualquer pessoa no comentário."
    : "Resposta privada — esta mensagem é visível somente para este cliente.";
  // Comentários não suportam mídia pela API (capabilities.canSendMedia) —
  // esconder o anexo evita o atendente tentar e só descobrir pelo erro.
  const canAttach = capabilities ? Boolean(capabilities.canSendMedia) : true;
  $("#attachment-input").closest(".attach-image").hidden = isComment && !canAttach;
}

const MODERATION_CONFIRM_TEXT = {
  delete: "Apagar este comentário na plataforma? Esta ação é irreversível e afeta o que o público vê.",
  hide: "Ocultar este comentário do público?", like: null, unlike: null,
};

$("#messages").addEventListener("click", async (event) => {
  const button = event.target.closest(".moderate-comment");
  if (!button) return;
  const { messageId, action } = button.dataset;
  const confirmText = MODERATION_CONFIRM_TEXT[action];
  if (confirmText && !confirm(confirmText)) return;
  button.disabled = true;
  try {
    await api(`/api/messages/${encodeURIComponent(messageId)}/moderate`, { method: "POST", body: JSON.stringify({ action }) });
    toast({ delete: "Comentário apagado.", hide: "Comentário ocultado.", unhide: "Comentário reexibido novamente.", like: "Comentário curtido.", unlike: "Curtida removida." }[action] || "Ação concluída.");
    if (action === "hide") { button.textContent = "Reexibir"; button.dataset.action = "unhide"; }
    else if (action === "unhide") { button.textContent = "Ocultar"; button.dataset.action = "hide"; }
    else if (action === "like") { button.textContent = "Descurtir"; button.dataset.action = "unlike"; }
    else if (action === "unlike") { button.textContent = "Curtir"; button.dataset.action = "like"; }
    else if (action === "delete") { button.closest(".message-row")?.remove(); }
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

function templatePreview(template) {
  let preview = template.previewTemplate || template.preview || "";
  for (const variable of template.variables || []) {
    if (!["BODY", "HEADER"].includes(variable.component)) continue;
    const input = [...document.querySelectorAll("[data-template-variable]")].find((item) => item.dataset.templateVariable === variable.key);
    preview = preview.replaceAll(`{{${variable.placeholder}}}`, input?.value.trim() || variable.example || `{{${variable.placeholder}}}`);
  }
  return preview;
}

function renderTemplateEditor() {
  const template = state.selectedTemplate;
  $("#template-empty").hidden = Boolean(template);
  $("#template-editor").hidden = !template;
  if (!template) return;
  $("#template-selected-name").textContent = template.name;
  $("#template-selected-details").textContent = `${template.language} • ${template.category}`;
  $("#template-variables").innerHTML = (template.variables || []).map((variable) => `<label><span>${escapeHtml(variable.label)}</span><input data-template-variable="${escapeHtml(variable.key)}" value="${escapeHtml(variable.example || "")}" placeholder="Digite o valor" required></label>`).join("");
  $("#template-preview").textContent = templatePreview(template);
  document.querySelectorAll("[data-template-variable]").forEach((input) => input.addEventListener("input", () => {
    $("#template-preview").textContent = templatePreview(template);
  }));
}

function renderTemplateList() {
  const search = $("#template-search").value.trim().toLocaleLowerCase("pt-BR");
  const templates = state.templates.filter((template) => `${template.name} ${template.language} ${template.category}`.toLocaleLowerCase("pt-BR").includes(search));
  $("#template-list").innerHTML = templates.length ? templates.map((template) => `<button class="template-card ${state.selectedTemplate?.id === template.id ? "selected" : ""}" type="button" data-template-id="${escapeHtml(template.id)}" ${template.supported ? "" : "disabled"} title="${escapeHtml(template.unsupportedReason || "Selecionar template")}"><strong>${escapeHtml(template.name)}</strong><span><b>${escapeHtml(template.language)}</b><b>${escapeHtml(template.category)}</b></span><small>${escapeHtml(template.unsupportedReason || template.preview || "Sem prévia")}</small><em class="template-rate">${escapeHtml(templateRateLabel(template))}</em></button>`).join("") : `<div class="template-empty">Nenhum template aprovado encontrado.</div>`;
  document.querySelectorAll("[data-template-id]").forEach((button) => button.addEventListener("click", () => {
    state.selectedTemplate = state.templates.find((template) => template.id === button.dataset.templateId) || null;
    renderTemplateList();
    renderTemplateEditor();
  }));
}

async function openTemplates() {
  if (!state.selectedId) return;
  if (!state.currentUser?.canManageCampaigns) return toast("Você não tem permissão para usar templates.", true);
  if (!state.customerServiceWindow?.configured) {
    toast("A integração de templates da Meta ainda não está ativada.", true);
    return;
  }
  state.selectedTemplate = null;
  $("#template-search").value = "";
  $("#template-list").innerHTML = `<div class="template-empty">Consultando templates aprovados na Meta...</div>`;
  renderTemplateEditor();
  $("#template-dialog").showModal();
  try {
    state.templates = await api(`/api/meta/templates?conversationId=${encodeURIComponent(state.selectedId)}`);
    renderTemplateList();
  } catch (error) {
    $("#template-list").innerHTML = `<div class="template-empty">${escapeHtml(error.message)}</div>`;
  }
}

function outboundTemplatePreview(template) {
  let preview = template?.previewTemplate || template?.preview || "";
  for (const variable of template?.variables || []) {
    if (!["BODY", "HEADER"].includes(variable.component)) continue;
    const input = [...document.querySelectorAll("[data-outbound-template-variable]")].find((item) => item.dataset.outboundTemplateVariable === variable.key);
    preview = preview.replaceAll(`{{${variable.placeholder}}}`, input?.value.trim() || variable.example || `{{${variable.placeholder}}}`);
  }
  return preview;
}

function renderOutboundTemplateEditor() {
  const template = state.selectedOutboundTemplate;
  $("#outbound-meta-template-empty").hidden = Boolean(template);
  $("#outbound-meta-template-editor").hidden = !template;
  if (!template) return;
  $("#outbound-meta-template-name").textContent = template.name;
  $("#outbound-meta-template-details").textContent = `${template.language} • ${template.category}`;
  $("#outbound-meta-template-variables").innerHTML = (template.variables || []).map((variable) => `<label><span>${escapeHtml(variable.label)}</span><input data-outbound-template-variable="${escapeHtml(variable.key)}" value="${escapeHtml(variable.example || "")}" required></label>`).join("");
  $("#outbound-meta-template-preview").textContent = outboundTemplatePreview(template);
  document.querySelectorAll("[data-outbound-template-variable]").forEach((input) => input.addEventListener("input", () => { $("#outbound-meta-template-preview").textContent = outboundTemplatePreview(template); }));
}

function renderOutboundTemplateList() {
  const search = $("#outbound-meta-template-search").value.trim().toLocaleLowerCase("pt-BR");
  const templates = state.outboundTemplates.filter((template) => `${template.name} ${template.language} ${template.category}`.toLocaleLowerCase("pt-BR").includes(search));
  $("#outbound-meta-template-list").innerHTML = templates.length ? templates.map((template) => `<button class="template-card ${state.selectedOutboundTemplate?.id === template.id ? "selected" : ""}" type="button" data-outbound-template-id="${escapeHtml(template.id)}" ${template.supported ? "" : "disabled"}><strong>${escapeHtml(template.name)}</strong><span><b>${escapeHtml(template.language)}</b><b>${escapeHtml(template.category)}</b></span><small>${escapeHtml(template.unsupportedReason || template.preview || "Sem prévia")}</small><em class="template-rate">${escapeHtml(templateRateLabel(template))}</em></button>`).join("") : `<div class="template-empty">Nenhum template aprovado encontrado.</div>`;
  document.querySelectorAll("[data-outbound-template-id]").forEach((button) => button.addEventListener("click", () => {
    state.selectedOutboundTemplate = state.outboundTemplates.find((template) => template.id === button.dataset.outboundTemplateId) || null;
    renderOutboundTemplateList(); renderOutboundTemplateEditor();
  }));
}

async function loadOutboundMetaTemplates() {
  state.selectedOutboundTemplate = null;
  state.outboundTemplates = [];
  renderOutboundTemplateEditor();
  $("#outbound-meta-template-list").innerHTML = `<div class="template-empty">Consultando templates aprovados...</div>`;
  try {
    const accountId = $("#outbound-meta-account").value;
    state.outboundTemplates = await api(`/api/meta/templates?accountId=${encodeURIComponent(accountId)}`);
    renderOutboundTemplateList();
  } catch (error) { $("#outbound-meta-template-list").innerHTML = `<div class="template-empty">${escapeHtml(error.message)}</div>`; }
}

async function openOutboundMeta() {
  $("#outbound-channel-dialog").close();
  // Painel novo (individual + envio em massa). O diálogo antigo continua
  // como reserva caso o script do painel não tenha carregado.
  if (window.WaSendWizard) return window.WaSendWizard.open(state.outboundChannels.find((item) => item.channel === "META"));
  $("#outbound-meta-form").reset();
  const metaChannel = state.outboundChannels.find((item) => item.channel === "META");
  $("#outbound-meta-account").innerHTML = (metaChannel?.accounts || []).map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}${account.address ? ` — ${escapeHtml(account.address)}` : ""}</option>`).join("");
  $("#outbound-meta-dialog").showModal();
  await loadOutboundMetaTemplates();
}
function renderOutboundChannels() {
  const container = $("#outbound-channel-list");
  container.innerHTML = state.outboundChannels.map((item) => `
    <button type="button" class="outbound-channel-card ${item.enabled ? "available" : "unavailable"}"
      data-outbound-channel="${escapeHtml(item.channel)}" ${item.enabled ? "" : "disabled"}>
      <span><b>${escapeHtml(item.label)}</b><small>${escapeHtml(item.enabled ? `${item.accounts.length} conta(s) disponível(is)` : item.reason)}</small></span>
      <em>${item.enabled ? "Selecionar" : "Indisponível"}</em>
    </button>`).join("");
  container.querySelectorAll("[data-outbound-channel]:not(:disabled)").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.outboundChannel === "META") return openOutboundMeta();
    if (button.dataset.outboundChannel !== "EMAIL") return;
    const emailChannel = state.outboundChannels.find((item) => item.channel === "EMAIL");
    $("#outbound-channel-dialog").close();
    $("#outbound-form").reset();
    $("#outbound-documents-summary").textContent = "Nenhum documento selecionado.";
    $("#outbound-account").innerHTML = emailChannel.accounts.map((account) =>
      `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}${account.address ? ` — ${escapeHtml(account.address)}` : ""}</option>`
    ).join("");
    $("#outbound-dialog").showModal();
  }));
}

async function loadOutboundChannels() {
  const button = $("#new-conversation");
  if (!state.currentUser?.canStartConversations && !state.currentUser?.canManageCampaigns) {
    state.outboundChannels = [];
    button.hidden = true;
    return;
  }
  button.hidden = false;
  state.outboundChannels = await api("/api/outbound/channels");
  const hasAvailableChannel = state.outboundChannels.some((item) => item.enabled);
  button.dataset.unavailable = String(!hasAvailableChannel);
  button.title = hasAvailableChannel ? "Iniciar nova conversa" : "Nenhuma integração disponível";
}

async function openOutboundConversation() {
  try {
    await loadOutboundChannels();
    renderOutboundChannels();
    $("#outbound-channel-dialog").showModal();
  } catch (error) { toast(error.message, true); }
}
function configureNotificationButton() {
  const button = $("#enable-notifications");
  if (!("Notification" in window)) return;
  button.hidden = false;
  const granted = Notification.permission === "granted";
  const label = granted ? "Alertas ativos" : "Ativar alertas";
  button.querySelector(".sidebar-item-label").textContent = label;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.dataset.enabled = String(granted);
  $("#manage-devices").hidden = !("PushManager" in window);
}

function deviceListMarkup(devices) {
  if (!devices.length) return `<div class="devices-empty">Nenhum dispositivo autorizado ainda. Use o botão acima para ativar neste navegador.</div>`;
  const relativeUse = (value) => {
    const days = Math.floor((Date.now() - new Date(value).getTime()) / 86400000);
    if (days <= 0) return "Último uso: hoje";
    if (days === 1) return "Último uso: ontem";
    return `Último uso: há ${days} dias`;
  };
  return devices.map((device) => `<article class="device-card"><span class="device-info"><b>${escapeHtml(device.deviceLabel || "Dispositivo")}</b><small>${escapeHtml(relativeUse(device.lastSeenAt))}</small></span><span class="device-status ${device.enabled ? "active" : ""}">${device.enabled ? "Ativo" : "Inativo"}</span><button type="button" class="danger-action" data-remove-device="${escapeHtml(device.id)}">Remover</button></article>`).join("");
}

async function loadDevices() {
  $("#devices-list").innerHTML = `<div class="devices-empty">Carregando dispositivos...</div>`;
  try {
    const devices = await api("/api/push/devices");
    $("#devices-list").innerHTML = deviceListMarkup(devices);
  } catch (error) {
    $("#devices-list").innerHTML = `<div class="devices-empty">${escapeHtml(error.message)}</div>`;
  }
}

async function checkAlerts() {
  if (!state.currentUser || !state.alertCursor || state.checkingAlerts) return;
  state.checkingAlerts = true;
  try {
    const result = await api(`/api/alerts?since=${encodeURIComponent(state.alertCursor)}`);
    state.alertCursor = result.checkedAt;
    try { localStorage.setItem(`mibro-alert-cursor:${state.currentUser.id}`, state.alertCursor); } catch {}
    if (!result.alerts?.length) return;
    const latest = result.alerts[result.alerts.length - 1];
    toast(
  result.alerts.length === 1
    ? latest.title
    : `${result.alerts.length} novas mensagens.`
);
    if (document.hidden && typeof window.mibroNotify === "function") {
      for (const alert of result.alerts.slice(-3)) {
        await window.mibroNotify(alert.title, {
  tag: alert.id,
  data: {
    url: `/?conversation=${encodeURIComponent(alert.conversationId)}`
  },
});
      }
    }
  } catch (error) {
    console.warn("Não foi possível consultar os alertas.", error);
  } finally { state.checkingAlerts = false; }
}

async function setCategoryHidden(categoryId, hidden) {
  state.categoryVisibility = await api("/api/category-visibility", { method:"PATCH", body:JSON.stringify({ categoryId, hidden }) });
  state.categorySignature = "";
  state.listSignature = "";
  await loadCategories();
  if (!state.category) await loadConversations();
  toast(hidden ? "Categoria ocultada para sua conta." : "Categoria exibida novamente.");
}

async function loadCategories() {
  const previousPrimaryCategory = $("#category-select").value;
  const previousSubcategory = $("#subcategory-select").value;
  const [categories, visibility] = await Promise.all([api("/api/categories"), api("/api/category-visibility")]);
  state.categories = categories;
  state.categoryVisibility = visibility;
  const signature = JSON.stringify([state.visibilityMode, visibility, categories.map((category) => [category.id, category.parentId, category.parent?.name, category.code, category.name, category.color, category.active, category.masterOnly, category.displayOrder, category.hidden])]);
  if (signature === state.categorySignature) return;
  state.categorySignature = signature;
  state.selectedHeaderSignature = "";
  const activeIds = new Set(categories.filter((category) => category.active).map((category) => category.id));
  const allActive = orderedCategories(categories.filter((category) => category.active && (!category.parentId || activeIds.has(category.parentId))));
  const shown = state.visibilityMode ? allActive : allActive.filter((category) => !category.hidden);
  if (state.category === "UNCATEGORIZED" && visibility.hideUncategorized && !state.visibilityMode) state.category = "";
  if (state.category && state.category !== "UNCATEGORIZED" && !shown.some((category) => category.code === state.category)) state.category = "";
  const roots = allActive.filter((category) => !category.parentId);
  const displayRoots = roots.filter((root) => state.visibilityMode
    || !root.hidden
    || shown.some((category) => category.parentId === root.id));
  const uncategorized = state.currentUser?.canViewUncategorized
    ? `<div class="category-filter-item ${visibility.hideUncategorized ? "category-hidden" : ""}" ${visibility.hideUncategorized && !state.visibilityMode ? "hidden" : ""}><button class="filter" data-category="UNCATEGORIZED"><span><i class="category-dot uncategorized-dot"></i>Sem categoria</span><strong data-uncategorized-count>0</strong></button><button class="category-eye" data-hide-category="UNCATEGORIZED" data-hidden="${visibility.hideUncategorized}" title="${visibility.hideUncategorized ? "Exibir" : "Ocultar"}">${visibility.hideUncategorized ? "◉" : "⊘"}</button></div>`
    : "";
  $("#category-filters").innerHTML = uncategorized + displayRoots.map((root) => {
    const children = shown.filter((category) => category.parentId === root.id);
    const rootShown = state.visibilityMode || !root.hidden;
    const expanded = !rootShown || state.expandedCategories.has(root.id);
    const row = (category, child = false) => `<div class="category-filter-item ${category.hidden ? "category-hidden" : ""}"><button class="filter ${child ? "subcategory-filter" : "category-parent-filter"}" data-category="${category.code}" ${!child ? `data-category-group="${category.id}" aria-expanded="${expanded}"` : ""}><span><i class="category-dot" style="background:${category.color || root.color || "#999"}"></i>${child ? "↳ " : ""}${escapeHtml(category.name)}${!child && children.length ? `<i class="category-chevron">${expanded ? "⌃" : "⌄"}</i>` : ""}</span><strong data-category-count="${category.id}">0</strong></button><button class="category-eye" data-hide-category="${category.id}" data-hidden="${category.hidden}" title="${category.hidden ? "Exibir" : "Ocultar"}">${category.hidden ? "◉" : "⊘"}</button></div>`;
    const rootRow = rootShown ? row(root) : `<div class="category-group-label"><i class="category-dot" style="background:${root.color || "#999"}"></i><span>${escapeHtml(root.name)}</span><small>principal oculta</small></div>`;
    return `<div class="category-filter-group">${rootRow}${children.length ? `<div class="subcategory-filters" data-category-children="${root.id}" ${expanded ? "" : "hidden"}>${children.map((child) => row(child, true)).join("")}</div>` : ""}</div>`;
  }).join("");
  $("#category-select").innerHTML = `${state.currentUser?.canViewUncategorized ? `<option value="">Sem categoria</option>` : `<option value="" disabled>Selecione a categoria</option>`}` + roots.map((category) => `<option value="${category.id}" data-selectable="${category.selectable !== false}">${escapeHtml(category.name)}</option>`).join("");
  $("#category-parent").innerHTML = `<option value="">Categoria principal</option>` + roots.map((category) => `<option value="${category.id}">${escapeHtml(category.name)}</option>`).join("");
  if ([...$("#category-select").options].some((option) => option.value === previousPrimaryCategory)) $("#category-select").value = previousPrimaryCategory;
  populateSubcategorySelect($("#category-select").value, previousSubcategory, state.categories);
  document.querySelectorAll("[data-hide-category]").forEach((button) => button.addEventListener("click", () => setCategoryHidden(button.dataset.hideCategory, button.dataset.hidden !== "true").catch((error) => toast(error.message, true))));
  document.querySelectorAll("[data-category]").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.categoryGroup) {
      const groupId = button.dataset.categoryGroup; const children = document.querySelector(`[data-category-children="${groupId}"]`);
      if (children) { children.hidden = !children.hidden; button.setAttribute("aria-expanded", String(!children.hidden)); button.querySelector(".category-chevron").textContent = children.hidden ? "⌄" : "⌃"; if (children.hidden) state.expandedCategories.delete(groupId); else state.expandedCategories.add(groupId); }
    }
    document.querySelectorAll(".filter").forEach((item) => item.classList.remove("active")); button.classList.add("active"); state.category = button.dataset.category; state.status = ""; loadConversations();
  }));
  document.querySelectorAll(".filter").forEach((item) => item.classList.remove("active"));
  const selectedFilter = state.category ? [...document.querySelectorAll("[data-category]")].find((item) => item.dataset.category === state.category) : [...document.querySelectorAll("[data-status]")].find((item) => item.dataset.status === state.status);
  selectedFilter?.classList.add("active");
  renderCategoryManager();
}

function renderCategoryManager() {
  const ordered = orderedCategories(state.categories);
  $("#category-manager-list").innerHTML = ordered.map((category) => {
    const parents = state.categories.filter((candidate) => candidate.active && !candidate.parentId && candidate.id !== category.id);
    return `<form class="category-manager-row ${category.parentId ? "subcategory-row" : ""}" data-category-id="${category.id}">
    <input class="managed-color" type="color" value="${category.color || "#6b7280"}" aria-label="Cor de ${escapeHtml(category.name)}">
    <input class="managed-name" maxlength="60" value="${escapeHtml(category.name)}" aria-label="Nome da categoria" required>
    <select class="managed-parent" aria-label="Categoria principal"><option value="">Principal</option>${parents.map((parent) => `<option value="${parent.id}" ${parent.id === category.parentId ? "selected" : ""}>${escapeHtml(parent.name)}</option>`).join("")}</select>
    <label class="active-switch"><input class="managed-active" type="checkbox" ${category.active ? "checked" : ""}><span>${category.active ? "Ativa" : "Inativa"}</span></label>
    ${state.currentUser?.isMaster ? `<label class="active-switch master-only-switch"><input class="managed-master-only" type="checkbox" ${category.masterOnly ? "checked" : ""}><span>Somente Master</span></label>` : ""}
    <button type="submit">Salvar</button>
  </form>`;
  }).join("");
}

async function loadConversations() {
  const params = new URLSearchParams();
  if (state.search) params.set("search", state.search);
  if (state.category) params.set("category", state.category);
  if (state.channel) params.set("channel", state.channel);
  if (state.assignedUser) params.set("assignedUser", state.assignedUser);
  if (state.assignedUserActiveOnly) params.set("activeOnly", "true");
  const statusValues = [...(state.status ? [state.status] : []), ...state.statusToggle];
  if (statusValues.length) params.set("status", statusValues.join(","));
  if (state.priorityToggle.size) params.set("priority", [...state.priorityToggle].join(","));
  if (state.slaBreached) params.set("slaBreached", "true");
  if (state.unassigned) params.set("unassigned", "true");
  const [conversations, summary, unfilteredConversations] = await Promise.all([
    api(`/api/conversations?${params}`),
    api("/api/conversations/summary"),
    MARKETPLACE_UI_ENABLED ? Promise.resolve(null) : api("/api/conversations"),
  ]);
  const availableConversations = MARKETPLACE_UI_ENABLED
    ? conversations
    : conversations.filter((conversation) => !isMarketplaceChannel(conversation.channel));
  const visibleConversations = state.channel === "EMAIL"
    ? availableConversations.filter((conversation) => (conversation.emailMailbox || "GENERAL") === state.emailMailbox)
    : availableConversations.filter((conversation) => conversation.channel !== "EMAIL" || (conversation.emailMailbox || "GENERAL") !== "SPAM");
  state.conversations = state.category ? visibleConversations : visibleConversations.filter((c) => c.id === state.selectedId || c.unreadCount > 0 || !isConversationCategoryHidden(c));
  const summaryConversations = (unfilteredConversations || []).filter((conversation) => !isMarketplaceChannel(conversation.channel)
    && (conversation.channel !== "EMAIL" || (conversation.emailMailbox || "GENERAL") !== "SPAM"));
  const displaySummary = MARKETPLACE_UI_ENABLED ? summary : summaryConversations.reduce((result, conversation) => {
    result.total += 1;
    result.statuses[conversation.status] = (result.statuses[conversation.status] || 0) + 1;
    if (conversation.priority === "URGENTE") result.urgent += 1;
    if (!conversation.assignedUserId && conversation.status !== "FINALIZADO") result.unassigned += 1;
    if (conversation.slaMinutesRemaining < 0) result.overdue += 1;
    const categoryId = conversation.categoryId || "null";
    result.categories[categoryId] = (result.categories[categoryId] || 0) + 1;
    if (conversation.status === "AGUARDANDO_EQUIPE" && Number(conversation.unreadCount) > 0) result.attentionWaiting += 1;
    return result;
  }, { total: 0, statuses: {}, categories: {}, overdue: 0, urgent: 0, unassigned: 0, attentionWaiting: 0 });
  if (!MARKETPLACE_UI_ENABLED) {
    displaySummary.statuses.EM_ATENDIMENTO = summaryConversations.filter((conversation) =>
      conversation.assignedUserId && !["NOVO", "FINALIZADO"].includes(conversation.status)).length;
  }
  const filteredUser = state.adminUsers.find((user) => user.id === state.assignedUser);
  $("#list-summary").textContent = `${state.conversations.length} atendimento${state.conversations.length === 1 ? "" : "s"}${filteredUser ? ` ativo${state.conversations.length === 1 ? "" : "s"} • ${filteredUser.name}` : ""}`;
  $("#clear-team-filter").hidden = !state.assignedUser;
  $("#count-all").textContent = displaySummary.total || 0;
  $("#count-new").textContent = displaySummary.statuses.NOVO || 0;
  $("#count-in-progress").textContent = displaySummary.statuses.EM_ATENDIMENTO || 0;
  $("#count-waiting").textContent = displaySummary.statuses.AGUARDANDO_EQUIPE || 0;
  document.querySelector('[data-status="AGUARDANDO_EQUIPE"]').classList.toggle("attention", Boolean(displaySummary.attentionWaiting));
  syncWaitingAttention(displaySummary.attentionWaiting);
  $("#count-bot").textContent = displaySummary.statuses.BOT || 0;
  $("#count-finalized").textContent = displaySummary.statuses.FINALIZADO || 0;
  $("#count-overdue").textContent = displaySummary.overdue || 0;
  $("#count-urgent").textContent = displaySummary.urgent || 0;
  $("#count-unassigned").textContent = displaySummary.unassigned || 0;
  document.querySelectorAll("[data-category-count]").forEach((counter) => {
    const categoryId = counter.dataset.categoryCount;
    const category = state.categories.find((item) => item.id === categoryId);
    const childIds = category?.parentId ? [] : state.categories.filter((item) => item.parentId === categoryId).map((item) => item.id);
    counter.textContent = [categoryId, ...childIds].reduce((total, id) => total + (displaySummary.categories[id] || 0), 0);
  });
  document.querySelector("[data-uncategorized-count]")?.replaceChildren(String(displaySummary.categories.null || 0));
  const signature = JSON.stringify({
    selectedId: state.selectedId,
    conversations: state.conversations.map(conversationSignature),
  });
  if (signature === state.listSignature) return;
  state.listSignature = signature;
  renderConversationCards(state.conversations);
}

function hideBotSuggestion() {
  state.botSuggestion = null;
  $("#bot-suggestion-card").hidden = true;
  $("#bot-tab-empty").hidden = false;
  $("[data-context-tab='bot']")?.classList.remove("has-update");
}

function renderBotSuggestion(suggestion) {
  state.botSuggestion = suggestion || null;
  const card = $("#bot-suggestion-card");
  const hasSuggestion = Boolean(suggestion?.suggestedResponseText);
  if (!hasSuggestion) {
    card.hidden = true;
    $("#bot-tab-empty").hidden = false;
    $("[data-context-tab='bot']")?.classList.remove("has-update");
    return;
  }
  $("#bot-suggestion-text").textContent = suggestion.suggestedResponseText;
  const confidence = typeof suggestion.confidence === "number" ? ` · ${Math.round(suggestion.confidence * 100)}%` : "";
  $("#bot-suggestion-meta").textContent = `${suggestion.intentName || "Resposta sugerida"}${confidence}`;
  card.hidden = false;
  $("#bot-tab-empty").hidden = true;
  if (activeContextTab() !== "bot") $("[data-context-tab='bot']")?.classList.add("has-update");
}

async function loadBotSuggestion(conversationId, loadSequence) {
  try {
    const suggestion = await api(`/api/conversations/${conversationId}/bot-suggestion`);
    if (loadSequence !== conversationLoadSequence || state.selectedId !== conversationId) return;
    renderBotSuggestion(suggestion);
  } catch (_error) {
    if (loadSequence === conversationLoadSequence && state.selectedId === conversationId) hideBotSuggestion();
  }
}

async function sendBotSuggestionFeedback(payload) {
  if (!state.botSuggestion?.id) return;
  await api("/api/bot-suggestion-feedback", {
    method: "POST", body: JSON.stringify({ observationId: state.botSuggestion.id, ...payload }),
  });
}

function placeBotSuggestionInComposer() {
  if (!state.botSuggestion?.suggestedResponseText) return;
  const input = $("#message-input");
  input.value = state.botSuggestion.suggestedResponseText;
  state.pendingBotSuggestion = {
    observationId: state.botSuggestion.id,
    originalText: state.botSuggestion.suggestedResponseText,
  };
  autoResizeComposer();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

$("#use-bot-suggestion").addEventListener("click", placeBotSuggestionInComposer);
$("#edit-bot-suggestion").addEventListener("click", placeBotSuggestionInComposer);
$("#ignore-bot-suggestion").addEventListener("click", async () => {
  try {
    await sendBotSuggestionFeedback({ action: "IGNORED" });
    state.pendingBotSuggestion = null;
    hideBotSuggestion();
  } catch (error) { toast(error.message, true); }
});
$("#like-bot-suggestion").addEventListener("click", async () => {
  try { await sendBotSuggestionFeedback({ helpful: true }); toast("Sugestão marcada como útil."); }
  catch (error) { toast(error.message, true); }
});
$("#dislike-bot-suggestion").addEventListener("click", async () => {
  try { await sendBotSuggestionFeedback({ helpful: false }); toast("Feedback registrado."); }
  catch (error) { toast(error.message, true); }
});

const mergedChannelLabels = { META:"WhatsApp", EMAIL:"E-mail", INSTAGRAM_DIRECT:"Instagram", FACEBOOK_MESSENGER:"Facebook", MERCADO_LIVRE:"Mercado Livre", TIKTOK_SHOP:"TikTok Shop", AMAZON_MARKETPLACE:"Amazon", SHOPEE:"Shopee", GOOGLE_REVIEWS:"Google Reviews" };
function renderMergedDestinations(destinations, selectedId) {
  state.mergedDestinations = destinations || [];
  const control = $("#merged-channel-control");
  const select = $("#merged-channel-select");
  control.hidden = state.mergedDestinations.length < 2;
  select.innerHTML = state.mergedDestinations.map((item) => {
    const channel = mergedChannelLabels[item.channel] || item.channel;
    const address = item.contact?.email || (item.contact?.phone ? `+${item.contact.phone}` : item.contactName);
    const account = item.channelAccount?.name ? ` · ${item.channelAccount.name}` : "";
    return `<option value="${escapeHtml(item.id)}">${escapeHtml(`${channel} — ${address}${account}`)}</option>`;
  }).join("");
  if (state.mergedDestinations.some((item) => item.id === selectedId)) select.value = selectedId;
}

const chatSkeletonMarkup = () => `<div class="skeleton-list">${[1, 2, 3].map((index) => `<div class="skeleton-row"><div class="skeleton skeleton-avatar"></div><div class="skeleton-lines"><div class="skeleton skeleton-line ${index % 2 ? "long" : "medium"}"></div><div class="skeleton skeleton-line short"></div></div></div>`).join("")}</div>`;

async function openConversation(id, { refreshList = true, markRead = true } = {}) {
  const loadSequence = ++conversationLoadSequence;
  const changedConversation = state.selectedId !== id;
  state.selectedId = id;
  if (changedConversation) {
    state.selectedHeaderSignature = "";
    state.selectedMessagesSignature = "";
    state.selectedNotesSignature = "";
    state.selectedActivitiesSignature = "";
    state.selectedMessageItems = [];
    state.selectedMessages = [];
    state.pendingBotSuggestion = null;
    hideBotSuggestion();
    loadQuickRepliesCache(id).catch(() => {});
    $("#empty-state").hidden = true;
    $("#chat-content").hidden = false;
    $("#chat-panel").classList.add("open");
    $("#messages").innerHTML = chatSkeletonMarkup();
  }
  if (markRead) await api(`/api/conversations/${id}/read`, { method:"POST" });
  const c = await api(`/api/conversations/${id}`);
  if (loadSequence !== conversationLoadSequence || state.selectedId !== id) return;
  const headerSignature = JSON.stringify({
    id: c.id,
    status: c.status,
    categoryId: c.categoryId,
    category: c.category && [c.category.id, c.category.name, c.category.color, c.category.active, c.category.parentId, c.category.parent?.name],
    assignedUserId: c.assignedUserId,
    assignedUser: c.assignedUser && [c.assignedUser.id, c.assignedUser.name],
    priority: c.priority,
    emailMailbox: c.emailMailbox,
    isPinned: c.isPinned,
    canViewHistory: c.canViewHistory,
    contact: [c.contact.id, c.contact.customName, c.contact.name, c.contact.email, c.contact.phone],
    messageHistoryLimited: c.messageHistoryLimited,
    accessMode: c.accessMode,
    customerServiceWindow: c.customerServiceWindow,
    mergedDestinations: (c.mergedDestinations || []).map((item) => [item.id, item.channel, item.contact?.email, item.contact?.phone, item.channelAccount?.name]),
    transferCategories: (c.transferCategories || []).map((category) => [category.id, category.parentId, category.name, category.active, category.selectable]),
  });
  const displayMessages = messagesWithReactions(c.messages);
  state.selectedMessages = displayMessages;
  state.selectedContactName = c.contact.customName || c.contact.name || c.contact.email || c.contact.phone;
  const hasReactionEvents = displayMessages.length !== c.messages.length;
  const messageItems = displayMessages.map((message) => JSON.stringify([message.id, message.externalId, message.direction, message.type, message.text, message.occurredAt, message.mediaStorageKey, message.mediaMimeType, message.mediaFileName, message.mediaSize, message.reactionEmoji, message.sentByUser?.id, message.sentByUser?.name]));
  const messagesSignature = JSON.stringify([c.messageHistoryLimited, c.accessMode, c.visibleWindows, c.currentHandoff, messageItems]);
  // Aberta só por supervisão: esconde resposta/assumir/transferir/finalizar
  // (o backend também bloqueia — isto é só para não oferecer a ação).
  $("#chat-content").classList.toggle("supervision-readonly", c.accessMode === "SUPERVISION");
  const notesSignature = JSON.stringify((c.contact.notes || []).map((note) => [note.id, note.content, note.pinned, note.createdAt, note.updatedAt, note.author?.name]));
  const activitiesSignature = JSON.stringify((c.activities || []).map((activity) => [activity.id, activity.action, activity.details, activity.createdAt, activity.actorUser?.name]));
  state.selectedContactId = c.contact.id;
  state.customerServiceWindow = c.customerServiceWindow;
  state.selectedChannel = c.channel;
  state.selectedChannelCapabilities = c.channelCapabilities || null;
  state.transferCategories = c.transferCategories || [];
  syncCustomerServiceWindow();
  syncSocialReplyMode(c.channel, c.channelCapabilities);
  renderContextDetails(c);
  renderSlaTab(c);
  $("#empty-state").hidden = true; $("#chat-content").hidden = false; $("#chat-panel").classList.add("open");
  if (headerSignature !== state.selectedHeaderSignature) {
    state.selectedHeaderSignature = headerSignature;
    const name = c.contact.customName || c.contact.name || c.contact.email || c.contact.phone;
    $("#contact-avatar").textContent = initials(name); $("#contact-name").textContent = name; $("#contact-phone").textContent = c.contact.email || (c.contact.phone ? `+${c.contact.phone}` : "");
    $("#merge-contact").hidden = !state.currentUser?.canMergeContacts;
    renderMergedDestinations(c.mergedDestinations, c.id);
    const primaryCategory = c.category?.parent || (c.category && !c.category.parentId ? c.category : null);
    const primaryId = primaryCategory?.id || "";
    const selectedSubcategory = c.category?.parentId ? c.categoryId : "";
    populateTransferCategorySelect(state.transferCategories, primaryId, selectedSubcategory);
    if (primaryId && ![...$("#category-select").options].some((option) => option.value === primaryId)) {
      $("#category-select").add(new Option(`${primaryCategory.name || "Categoria"} (inativa)`, primaryId, false, false));
    }
    $("#category-select").value = primaryId;
    if (selectedSubcategory && ![...$("#subcategory-select").options].some((option) => option.value === selectedSubcategory)) {
      $("#subcategory-select").add(new Option(`${c.category.name} (inativa)`, selectedSubcategory, false, true));
      $("#subcategory-select").hidden = false;
    }
    state.selectedCategoryId = c.categoryId || "";
    syncCategoryConfirmation();
    $("#status-badge").className = "status-badge"; $("#status-badge").textContent = statusLabel(c.status);
    if (c.assignedUserId && ![...$("#assignee-select").options].some((option) => option.value === c.assignedUserId)) {
      $("#assignee-select").add(new Option(c.assignedUser?.name || "Outro atendente", c.assignedUserId));
    }
    $("#assignee-select").value = c.assignedUserId || "";
    $("#priority-select").value = c.priority || "NORMAL";
    $("#claim-conversation").hidden = c.assignedUserId === state.currentUser?.id;
    $("#toggle-finalized").textContent = c.status === "FINALIZADO" ? "Reabrir" : "Finalizar"; $("#toggle-finalized").dataset.status = c.status;
    $("#toggle-email-spam").hidden = c.channel !== "EMAIL";
    $("#toggle-email-spam").textContent = c.emailMailbox === "SPAM" ? "Remover do spam" : "Marcar como spam";
    $("#toggle-email-spam").dataset.spam = String(c.emailMailbox === "SPAM");
    $("#delete-conversation").hidden = !state.currentUser?.isMaster;
    $("#pin-conversation").textContent = c.isPinned ? "★ Fixada" : "☆ Fixar";
    $("#pin-conversation").dataset.pinned = String(Boolean(c.isPinned));
    $("#history-toggle").hidden = !c.canViewHistory;
    $("#history-tab-button").hidden = !c.canViewHistory;
    if (!c.canViewHistory && activeContextTab() === "history") setContextTab("details", { open:false });
  }
  if (messagesSignature !== state.selectedMessagesSignature) {
    state.selectedMessagesSignature = messagesSignature;
    const canAppend = !hasReactionEvents && !changedConversation && state.selectedMessageItems.length <= messageItems.length
      && state.selectedMessageItems.every((item, index) => item === messageItems[index]);
    if (canAppend) {
      const previousMessage = state.selectedMessageItems.length ? displayMessages[state.selectedMessageItems.length - 1] : null;
      $("#messages").insertAdjacentHTML("beforeend", messageRowsMarkup(displayMessages.slice(state.selectedMessageItems.length), previousMessage));
    } else {
      $("#messages").innerHTML = `${handoffNoticeMarkup(c)}${messageRowsMarkup(displayMessages)}`;
    }
    state.selectedMessageItems = messageItems;
    $("#messages").scrollTop = $("#messages").scrollHeight;
  }
  syncMessageStatuses(displayMessages);
  renderFilesTabSummary();
  if ($("#contact-files-dialog").open) renderContactFiles(state.contactFilesTab);
  if (notesSignature !== state.selectedNotesSignature) {
    state.selectedNotesSignature = notesSignature;
    renderNotes(c.contact.notes || []);
  }
  if (activitiesSignature !== state.selectedActivitiesSignature) {
    state.selectedActivitiesSignature = activitiesSignature;
    renderActivities(c.activities || []);
  }
  await loadBotSuggestion(id, loadSequence);
  if (loadSequence !== conversationLoadSequence || state.selectedId !== id) return;
  if (refreshList) await loadConversations();
}

let realtimeRefreshTimer;
let realtimeRefreshRunning = false;
async function refreshInbox() {
  if (realtimeRefreshRunning) return;
  realtimeRefreshRunning = true;
  try {
    await loadCategories();
    if (state.selectedId) {
      try {
        await openConversation(state.selectedId, { refreshList:false, markRead:!document.hidden });
      } catch (error) {
        // Outro atendente assumiu (403) ou a conversa saiu do seu acesso
        // (404): fecha a tela sem derrubar a atualização da fila.
        if (![403, 404].includes(error.status)) throw error;
        closeConversationView();
        toast(error.message, true);
      }
    }
    await loadConversations();
    await checkAlerts();
  } finally {
    realtimeRefreshRunning = false;
  }
}

// Estado visual de conexão perdida (item 1/9): EventSource já reconecta sozinho,
// aqui só refletimos isso na UI sem travar o atendimento já carregado nem
// disparar toasts repetidos a cada tentativa.
let connectionLossTimer = null;
let connectionState = "online";
function setConnectionState(next) {
  if (connectionState === next) return;
  connectionState = next;
  const indicator = $("#connection-indicator");
  if (!indicator) return;
  indicator.dataset.state = next;
  $("#connection-label").textContent = next === "offline" ? "Conexão perdida"
    : next === "reconnecting" ? "Reconectando..."
    : "WhatsApp conectado";
}

function connectRealtime() {
  const events = new EventSource("/api/events");
  events.addEventListener("inbox.updated", () => {
    clearTimeout(realtimeRefreshTimer);
    realtimeRefreshTimer = setTimeout(() => refreshInbox().catch(() => {}), 120);
  });
  events.addEventListener("open", () => {
    clearTimeout(connectionLossTimer);
    connectionLossTimer = null;
    const wasDown = connectionState !== "online";
    setConnectionState("online");
    if (wasDown) refreshInbox().catch(() => {});
  });
  events.addEventListener("error", () => {
    if (connectionLossTimer || connectionState !== "online") return;
    connectionLossTimer = setTimeout(() => {
      connectionLossTimer = null;
      setConnectionState(events.readyState === EventSource.CLOSED ? "offline" : "reconnecting");
    }, 1500);
  });
  window.addEventListener("beforeunload", () => events.close(), { once:true });
}

// Aba "Detalhes" do painel de contexto: recapitulação somente leitura dos
// dados já carregados da conversa aberta — os controles interativos
// (categoria, responsável, prioridade) continuam no cabeçalho/meta da
// conversa, sem duplicar lógica de formulário/validação aqui.
function renderContextDetails(c) {
  const name = c.contact.customName || c.contact.name || c.contact.phone;
  const channel = channelBadge(c.channel) || "WhatsApp";
  $("#context-details-summary").innerHTML = `
    <div class="context-detail-block">
      <span class="context-detail-label">Contato</span>
      <strong>${escapeHtml(name)}</strong>
      <small>+${escapeHtml(c.contact.phone)}</small>
    </div>
    <div class="context-info-list">
      <div class="context-info-row"><span>Canal</span><strong>${escapeHtml(channel)}</strong></div>
      ${c.channel === "META" ? `<div class="context-info-row"><span>Número de atendimento</span><strong>${escapeHtml(c.channelAccount?.name || "WhatsApp principal")}</strong></div>` : ""}
      <div class="context-info-row"><span>Categoria</span><strong>${escapeHtml(categoryLabel(c.category))}</strong></div>
      <div class="context-info-row"><span>Status</span><strong>${escapeHtml(statusLabel(c.status))}</strong></div>
      <div class="context-info-row"><span>Responsável</span><strong>${escapeHtml(c.assignedUser?.name || "Sem responsável")}</strong></div>
      ${c.priority && c.priority !== "NORMAL" ? `<div class="context-info-row"><span>Prioridade</span><strong>${escapeHtml(priorityLabel(c.priority))}</strong></div>` : ""}
      <div class="context-info-row"><span>Fixada</span><strong>${c.isPinned ? "Sim" : "Não"}</strong></div>
    </div>
    ${postContextMarkup(c.postContext)}
    <div id="context-template-history"></div>`;
  if (c.channel === "META" && c.contact?.id) window.WaSendWizard?.renderContactHistory($("#context-template-history"), c.contact.id);
}

// Item 10 do plano Social — comentário nunca chega "pelado": quando existe
// mapeamento manual (Integrações > Publicações), mostra a publicação/
// produto relacionado no painel de contexto, nunca inferido aqui na UI.
function postContextMarkup(postContext) {
  if (!postContext) return "";
  return `
    <div class="context-detail-block post-context-block">
      <span class="context-detail-label">Publicação relacionada</span>
      <strong>${escapeHtml(postContext.title || postContext.externalPostId)}</strong>
      ${postContext.product ? `<small>Produto: ${escapeHtml(postContext.product)}</small>` : ""}
      ${postContext.permalink ? `<a href="${escapeHtml(postContext.permalink)}" target="_blank" rel="noopener">Ver publicação ↗</a>` : ""}
    </div>`;
}

// Aba "SLA": só formata campos que já vêm no objeto da conversa (nenhuma
// chamada de rede nova) — mesmos campos usados no badge do card da lista.
function renderSlaTab(c) {
  const rows = [];
  rows.push(`<div class="context-info-row"><span>Status</span><strong>${escapeHtml(statusLabel(c.status))}</strong></div>`);
  const minutes = c.slaMinutesRemaining;
  if (minutes !== null && minutes !== undefined) {
    rows.push(minutes < 0
      ? `<div class="context-info-row alert"><span>SLA de resposta</span><strong>Estourado</strong></div>`
      : `<div class="context-info-row"><span>SLA de resposta</span><strong>${minutes} min restantes</strong></div>`);
  }
  if (c.firstResponseSlaBreached) rows.push(`<div class="context-info-row alert"><span>Primeira resposta</span><strong>Fora do prazo</strong></div>`);
  if (c.responseSlaBreached) rows.push(`<div class="context-info-row alert"><span>Resposta durante atendimento</span><strong>Fora do prazo</strong></div>`);
  $("#context-tab-sla-body").innerHTML = rows.join("");
}

// Aba "Arquivos": só a contagem (reaproveita externalLinks já usada pelo
// diálogo de arquivos) — o grid completo continua no diálogo existente,
// aberto pelo botão "Ver tudo" para não duplicar a renderização.
function renderFilesTabSummary() {
  const messages = state.selectedMessages || [];
  $("#context-files-media-count").textContent = messages.filter((m) => ["image", "video"].includes(m.type) && m.mediaStorageKey).length;
  $("#context-files-doc-count").textContent = messages.filter((m) => m.type === "document" && m.mediaStorageKey).length;
  $("#context-files-link-count").textContent = externalLinks(messages).length;
}

function renderNotes(notes) {
  $("#notes-list").innerHTML = notes.length ? notes.map((note) => `<article class="note ${note.pinned ? "pinned" : ""}"><div class="note-heading">${note.pinned ? `<span class="pinned-label">📌 FIXADA</span>` : `<span></span>`}<span class="note-actions"><button class="pin-note" type="button" data-note-id="${escapeHtml(note.id)}" data-pinned="${note.pinned}" title="${note.pinned ? "Desafixar nota" : "Fixar esta nota no topo"}">${note.pinned ? "Desafixar" : "📌 Fixar"}</button>${state.currentUser?.isMaster ? `<button class="delete-note" type="button" data-note-id="${escapeHtml(note.id)}" title="Apagar nota">Apagar</button>` : ""}</span></div><p>${escapeHtml(note.content)}</p><footer>${escapeHtml(note.author?.name || "Equipe")} • ${new Intl.DateTimeFormat("pt-BR", { dateStyle:"short", timeStyle:"short" }).format(new Date(note.createdAt))}</footer></article>`).join("") : `<div class="notes-empty">Nenhuma nota adicionada.</div>`;
}

function activityText(activity) {
  const details = activity.details || {};
  const status = (value) => statusLabel(value || "");
  return ({
    CONVERSATION_CREATED: "iniciou esta conversa pelo painel",
    CONVERSATION_CLAIMED: "assumiu a conversa como responsável",
    CONVERSATION_TRANSFERRED: `transferiu a conversa de ${details.from || "Sem responsável"} para ${details.to || "Sem responsável"}${details.historyShared === true ? " (com histórico)" : details.historyShared === false ? " (sem histórico)" : ""}${details.reason ? ` — motivo: ${details.reason}` : ""}`,
    ASSIGNEE_REMOVED: `removeu ${details.from || "o atendente"} da responsabilidade pela conversa`,
    CATEGORY_CHANGED: `alterou a categoria de ${details.from || "Sem categoria"} para ${details.to || "Sem categoria"}`,
    STATUS_CHANGED: `alterou o status de ${status(details.from)} para ${status(details.to)}`,
    NOTE_ADDED: `adicionou uma nota${details.preview ? `: “${details.preview}”` : ""}`,
    NOTE_DELETED: `apagou uma nota${details.preview ? `: “${details.preview}”` : ""}`,
    NOTE_PINNED: `fixou uma nota${details.preview ? `: “${details.preview}”` : ""}`,
    NOTE_UNPINNED: `desafixou uma nota${details.preview ? `: “${details.preview}”` : ""}`,
    BOT_TRIAGE_COMPLETED: `Bot encaminhou a conversa para ${details.categoryName || "o setor selecionado"}`,
    AUTO_FINALIZED_INACTIVITY: `Sistema finalizou a conversa após ${details.inactivityMinutes || 1440} minutos sem resposta do cliente`,
  })[activity.action] || "realizou uma atualização na conversa";
}

function renderActivities(activities) {
  $("#history-list").innerHTML = activities.length ? activities.map((activity) => `<article class="history-item"><span class="history-dot" aria-hidden="true"></span><div><p><b>${escapeHtml(activity.actorUser?.name || "Sistema")}</b> ${escapeHtml(activityText(activity))}</p><time>${new Intl.DateTimeFormat("pt-BR", { dateStyle:"short", timeStyle:"short" }).format(new Date(activity.createdAt))}</time></div></article>`).join("") : `<div class="notes-empty">Nenhuma ação registrada ainda.</div>`;
}

const roleLabel = (role) => ({ ADMIN:"Master", SUPERVISOR:"Supervisor", ATENDENTE:"Atendente" })[role] || role;

function renderTeamCategoryAccess(selectedIds = [], canViewUncategorized = false) {
  const selected = new Set(selectedIds);
  const active = state.categories.filter((category) => category.active);
  const roots = active.filter((category) => !category.parentId);
  $("#team-category-access").innerHTML = `<div class="team-category-groups">
    <section class="team-category-group uncategorized">
      <label class="team-category-option root"><input id="permission-uncategorized" type="checkbox" ${canViewUncategorized ? "checked" : ""}><i class="category-dot uncategorized-dot"></i><span><b>Sem categoria</b><small>Conversas que ainda não foram classificadas.</small></span></label>
    </section>
    ${roots.map((root) => {
    const children = active.filter((category) => category.parentId === root.id);
    const rootSelected = selected.has(root.id);
    return `<section class="team-category-group" data-category-group="${escapeHtml(root.id)}">
      <label class="team-category-option root"><input class="team-category-root team-category-access-input" type="checkbox" value="${escapeHtml(root.id)}" ${rootSelected ? "checked" : ""}><i class="category-dot" style="background:${root.color || "#999"}"></i><span><b>${escapeHtml(root.name)}</b><small>${children.length ? `${children.length} subcategoria${children.length === 1 ? "" : "s"}` : "Categoria principal"}</small></span></label>
      ${children.length ? `<div class="team-subcategory-list">${children.map((child) => `<label class="team-category-option child"><input class="team-category-access-input" type="checkbox" value="${escapeHtml(child.id)}" ${selected.has(child.id) ? "checked" : ""}><i class="category-dot" style="background:${child.color || root.color || "#999"}"></i><span>${escapeHtml(child.name)}</span></label>`).join("")}</div>` : ""}
    </section>`;
  }).join("")}</div>`;
}

function syncMasterForm() {
  const master = $("#team-role").value === "ADMIN";
  document.querySelectorAll(".team-permissions input,.team-categories input").forEach((input) => { input.disabled = master; });
}

function resetTeamForm() {
  state.editingUserId = null;
  $("#team-form").reset();
  $("#team-role").value = "ATENDENTE";
  $("#team-active").checked = true;
  $("#team-active-field").hidden = true;
  $("#team-password").required = true;
  $("#team-password-label").textContent = "Senha inicial";
  $("#team-form-eyebrow").textContent = "NOVA CONTA";
  $("#team-form-title").textContent = "Adicionar membro";
  renderTeamCategoryAccess();
  syncMasterForm();
}

function editTeamUser(userId) {
  const user = state.adminUsers.find((item) => item.id === userId);
  if (!user) return;
  state.editingUserId = user.id;
  $("#team-name").value = user.name;
  $("#team-email").value = user.email;
  $("#team-role").value = user.role;
  $("#team-password").value = "";
  $("#team-password").required = false;
  $("#team-password-label").textContent = "Nova senha (opcional)";
  $("#team-active").checked = user.active;
  $("#team-active-field").hidden = false;
  $("#permission-categories").checked = user.canManageCategories;
  $("#permission-transfer").checked = user.canTransferConversations;
  $("#permission-history").checked = user.canViewConversationHistory;
  $("#permission-previous-messages").checked = user.canViewPreviousMessages;
  $("#permission-priority").checked = user.canSetConversationPriority;
  $("#permission-start-conversations").checked = user.canStartConversations;
  $("#permission-merge-contacts").checked = user.canMergeContacts;
  $("#permission-manage-campaigns").checked = user.canManageCampaigns;
  $("#team-form-eyebrow").textContent = "EDITAR CONTA";
  $("#team-form-title").textContent = user.name;
  renderTeamCategoryAccess(user.categoryAccess.map((access) => access.categoryId), user.canViewUncategorized);
  syncMasterForm();
}

function renderAdminUsers() {
  $("#team-count").textContent = `${state.adminUsers.length} conta${state.adminUsers.length === 1 ? "" : "s"}`;
  $("#team-user-list").innerHTML = state.adminUsers.map((user) => `<article class="team-user-card ${user.active ? "" : "inactive"}"><div class="team-user-main"><span class="team-user-avatar">${escapeHtml(initials(user.name))}</span><span class="team-user-info"><b>${escapeHtml(user.name)}</b><small>${escapeHtml(user.email || "Membro da equipe")}</small></span><span class="role-pill">${escapeHtml(roleLabel(user.role))}</span></div><div class="team-user-meta"><span>${user._count.assignedConversations} conversa(s) atribuída(s)</span>${state.currentUser?.isMaster ? `<span>•</span><span>${user._count.sentMessages} resposta(s)</span>` : ""}${user.active ? "" : "<span>• Inativa</span>"}</div><div class="team-user-actions">${state.currentUser?.isMaster ? `<button type="button" data-edit-user="${escapeHtml(user.id)}">Editar</button>` : ""}<button type="button" data-view-user="${escapeHtml(user.id)}">Ver atendimentos</button></div></article>`).join("");
}

const auditActionLabel = (action) => ({
  USER_CREATED:"Conta criada", USER_UPDATED:"Conta alterada", CONTACTS_MERGED:"Contatos fundidos",
  CONVERSATION_DELETED:"Conversa apagada", CONVERSATION_PINNED:"Conversa fixada",
  CONVERSATION_UNPINNED:"Conversa desafixada", CONVERSATION_CATEGORY_CHANGED:"Categoria da conversa",
  CONVERSATION_ASSIGNEE_CHANGED:"Responsável da conversa", CONVERSATION_STATUS_CHANGED:"Status da conversa",
  CATEGORY_CREATED:"Categoria criada", CATEGORY_UPDATED:"Categoria alterada", NOTE_DELETED:"Nota apagada",
  BOT_CREATED:"Bot criado", BOT_UPDATED:"Bot alterado", BOT_STATUS_CHANGED:"Status do Bot",
  BOT_ARCHIVED:"Bot arquivado", BOT_SCHEDULES_UPDATED:"Horários do Bot",
  BOT_INTENT_CREATED:"Intenção criada", BOT_INTENT_UPDATED:"Intenção alterada",
  BOT_INTENT_DELETED:"Intenção removida",
  EMAIL_SPAM_CHANGED:"Classificação de spam alterada",
})[action] || action;

function renderAuditLogs() {
  $("#audit-count").textContent = `${state.auditLogs.length} registro${state.auditLogs.length === 1 ? "" : "s"}`;
  $("#audit-list").innerHTML = state.auditLogs.length ? state.auditLogs.map((log) => {
    const critical = ["CONVERSATION_DELETED", "USER_CREATED", "USER_UPDATED"].includes(log.action);
    const actor = log.actorName || log.actorEmail || "Sistema";
    const when = new Intl.DateTimeFormat("pt-BR", { dateStyle:"short", timeStyle:"medium" }).format(new Date(log.createdAt));
    const details = log.details ? escapeHtml(JSON.stringify(log.details, null, 2)) : "";
    return `<article class="audit-item ${critical ? "critical" : ""}"><span class="audit-marker" aria-hidden="true"></span><div class="audit-main"><header><b>${escapeHtml(auditActionLabel(log.action))}</b><time>${escapeHtml(when)}</time></header><p>${escapeHtml(log.summary)}</p><footer>Por <strong>${escapeHtml(actor)}</strong>${log.actorEmail ? ` • ${escapeHtml(log.actorEmail)}` : ""}</footer>${details ? `<details><summary>Ver detalhes técnicos</summary><pre>${details}</pre></details>` : ""}</div></article>`;
  }).join("") : `<div class="notes-empty">Nenhum registro encontrado para este filtro.</div>`;
}

async function loadAuditLogs() {
  if (!state.currentUser?.isMaster) return;
  const params = new URLSearchParams({ limit:"200" });
  const entityType = $("#audit-entity").value;
  const search = $("#audit-search").value.trim();
  if (entityType) params.set("entityType", entityType);
  if (search) params.set("search", search);
  state.auditLogs = await api(`/api/admin/audit-logs?${params}`);
  renderAuditLogs();
}

async function loadAdminUsers() {
  if (!state.currentUser?.isMaster) return;
  state.adminUsers = await api("/api/admin/users");
  renderAdminUsers();
}

$("#conversation-list").addEventListener("click", (event) => {
  const card = event.target.closest(".conversation-card");
  if (card) openConversation(card.dataset.id).catch((error) => {
    if ($("#messages").querySelector(".skeleton-list")) $("#messages").innerHTML = `<div class="shared-empty">Não foi possível abrir esta conversa.</div>`;
    toast(error.message, true);
  });
});
document.querySelectorAll("[data-status]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".filter").forEach((item) => item.classList.remove("active")); button.classList.add("active"); state.status = button.dataset.status; state.category = ""; loadConversations();
}));
// Filtros combináveis adicionais (item 11): multi-select — somam-se ao
// status principal em vez de substituí-lo, já que o backend aceita CSV.
document.querySelectorAll("[data-toggle-filter]").forEach((button) => button.addEventListener("click", () => {
  const [kind, value] = button.dataset.toggleFilter.split(":");
  if (kind === "slaBreached") { state.slaBreached = !state.slaBreached; button.classList.toggle("active", state.slaBreached); }
  else if (kind === "unassigned") { state.unassigned = !state.unassigned; button.classList.toggle("active", state.unassigned); }
  else {
    const set = kind === "status" ? state.statusToggle : state.priorityToggle;
    if (set.has(value)) set.delete(value); else set.add(value);
    button.classList.toggle("active", set.has(value));
  }
  loadConversations();
}));
const quickFiltersTray = $("#quick-filters-tray");
try { quickFiltersTray.open = localStorage.getItem("mibro-quick-filters-open") !== "0"; } catch {}
quickFiltersTray.addEventListener("toggle", () => {
  try { localStorage.setItem("mibro-quick-filters-open", quickFiltersTray.open ? "1" : "0"); } catch {}
});
document.querySelectorAll("[data-email-mailbox]").forEach((button) => button.addEventListener("click", () => {
  state.emailMailbox = button.dataset.emailMailbox;
  document.querySelectorAll("[data-email-mailbox]").forEach((item) => item.classList.toggle("active", item === button));
  loadConversations();
}));
let searchTimer; $("#search").addEventListener("input", (event) => { clearTimeout(searchTimer); state.search = event.target.value.trim(); searchTimer = setTimeout(loadConversations, 250); });
const channelWorkspaceMeta = {
  "": { key:"all", title:"Conversas", eyebrow:"TODOS OS CANAIS" },
  META: { key:"whatsapp", title:"WhatsApp", eyebrow:"ATENDIMENTO EM TEMPO REAL" },
  EMAIL: { key:"email", title:"E-mail", eyebrow:"CAIXA DE ENTRADA" },
  "INSTAGRAM_DIRECT,INSTAGRAM_COMMENTS,FACEBOOK_MESSENGER,FACEBOOK_COMMENTS": { key:"social", title:"Instagram + Facebook", eyebrow:"SOCIAL E MENSAGENS" },
  "MERCADO_LIVRE,TIKTOK_SHOP,AMAZON_MARKETPLACE,SHOPEE,SHEIN_MARKETPLACE": { key:"stores", title:"Plataformas de venda", eyebrow:"MARKETPLACES" },
};
function setChannelWorkspace(value, { load = true, persist = true } = {}) {
  const requested = String(value || "");
  const next = !MARKETPLACE_UI_ENABLED && requested.split(",").some(isMarketplaceChannel) ? "" : requested;
  const meta = channelWorkspaceMeta[next] || { key:"custom", title:"Conversas", eyebrow:"CANAL SELECIONADO" };
  state.channel = next;
  $("#channel-filter").value = next;
  $(".workspace").dataset.channelView = meta.key;
  $("#workspace-channel-title").textContent = meta.title;
  $("#workspace-channel-eyebrow").textContent = meta.eyebrow;
  $("#email-mailboxes").hidden = next !== "EMAIL";
  document.querySelectorAll(".channel-workspace-item").forEach((item) => {
    const active = item.dataset.channelView === next;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current");
  });
  if (persist) try { localStorage.setItem("mibro-channel-workspace", next); } catch {}
  if (load) { closeConversationView(); loadConversations(); }
}
$("#channel-filter").addEventListener("change", (event) => setChannelWorkspace(event.target.value));
document.querySelectorAll(".channel-workspace-item").forEach((item) => item.addEventListener("click", () => {
  setChannelWorkspace(item.dataset.channelView);
  $("#app-sidebar").classList.remove("mobile-open");
}));
$("#refresh").addEventListener("click", loadConversations);
$("#new-conversation").addEventListener("click", openOutboundConversation);
$("#close-outbound-channels").addEventListener("click", () => $("#outbound-channel-dialog").close());
$("#outbound-channel-dialog").addEventListener("click", (event) => { if (event.target === $("#outbound-channel-dialog")) $("#outbound-channel-dialog").close(); });
$("#close-outbound-meta").addEventListener("click", () => $("#outbound-meta-dialog").close());
$("#outbound-meta-dialog").addEventListener("click", (event) => { if (event.target === $("#outbound-meta-dialog")) $("#outbound-meta-dialog").close(); });
$("#outbound-meta-template-search").addEventListener("input", renderOutboundTemplateList);
$("#outbound-meta-account").addEventListener("change", loadOutboundMetaTemplates);
$("#outbound-meta-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedOutboundTemplate) return toast("Selecione um template aprovado.", true);
  const button = $("#send-outbound-meta");
  const values = Object.fromEntries([...document.querySelectorAll("[data-outbound-template-variable]")].map((input) => [input.dataset.outboundTemplateVariable, input.value.trim()]));
  button.disabled = true;
  try {
    const result = await api("/api/conversations/outbound", { method:"POST", body:JSON.stringify({
      accountId: $("#outbound-meta-account").value, phone: $("#outbound-meta-phone").value.trim(), customName: $("#outbound-meta-name").value.trim(),
      template: { name:state.selectedOutboundTemplate.name, language:state.selectedOutboundTemplate.language, values },
    }) });
    $("#outbound-meta-dialog").close();
    toast("Conversa iniciada pelo WhatsApp.");
    await loadConversations();
    await openConversation(result.conversationId);
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});$("#close-outbound").addEventListener("click", () => $("#outbound-dialog").close());
$("#outbound-dialog").addEventListener("click", (event) => { if (event.target === $("#outbound-dialog")) $("#outbound-dialog").close(); });
$("#outbound-documents").addEventListener("change", (event) => {
  const files = Array.from(event.target.files || []);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length > 10 || totalBytes > 20 * 1024 * 1024) {
    event.target.value = "";
    $("#outbound-documents-summary").textContent = "Limite: 10 documentos e 20 MB no total.";
    return;
  }
  $("#outbound-documents-summary").textContent = files.length
    ? `${files.length} documento(s) · ${(totalBytes / 1024 / 1024).toFixed(1)} MB`
    : "Nenhum documento selecionado.";
});
$("#outbound-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#send-outbound");
  button.disabled = true;
  try {
    const body = new FormData();
    body.set("accountId", $("#outbound-account").value);
    body.set("to", $("#outbound-email").value.trim());
    body.set("customName", $("#outbound-name").value.trim());
    body.set("subject", $("#outbound-subject").value.trim());
    body.set("text", $("#outbound-message").value.trim());
    Array.from($("#outbound-documents").files || []).forEach((file) => body.append("documents", file, file.name));
    const result = await api("/api/conversations/outbound/email", { method:"POST", body });
    $("#outbound-dialog").close();
    await loadConversations();
    await openConversation(result.conversationId);
    toast(result.created ? "E-mail enviado e conversa criada." : "E-mail enviado na conversa existente.");
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});
$("#clear-team-filter").addEventListener("click", () => { state.assignedUser = ""; state.assignedUserActiveOnly = false; loadConversations(); });
$("#enable-notifications").addEventListener("click", async () => {
  if (!("Notification" in window)) return toast("Este dispositivo não oferece notificações do navegador.", true);
  if (Notification.permission === "granted") return toast("Os alertas do sistema já estão ativos.");
  const permission = await Notification.requestPermission();
  configureNotificationButton();
  if (permission === "granted" && typeof window.mibroSubscribePush === "function") await window.mibroSubscribePush();
  toast(permission === "granted" ? "Notificações ativadas." : "As notificações não foram autorizadas.", permission !== "granted");
});
$("#manage-devices").addEventListener("click", async () => { await loadDevices(); $("#devices-dialog").showModal(); });
$("#close-devices").addEventListener("click", () => $("#devices-dialog").close());
$("#devices-dialog").addEventListener("click", (event) => { if (event.target === $("#devices-dialog")) $("#devices-dialog").close(); });
$("#add-this-device").addEventListener("click", async () => {
  if (!("Notification" in window)) return toast("Este dispositivo não oferece notificações do navegador.", true);
  const button = $("#add-this-device");
  button.disabled = true;
  try {
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    configureNotificationButton();
    if (permission !== "granted") { toast("As notificações não foram autorizadas.", true); return; }
    const subscribed = typeof window.mibroSubscribePush === "function" && await window.mibroSubscribePush();
    toast(subscribed ? "Este dispositivo agora recebe notificações." : "Não foi possível ativar notificações neste dispositivo.", !subscribed);
    await loadDevices();
  } finally { button.disabled = false; }
});
$("#devices-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-device]");
  if (!button) return;
  if (!confirm("Remover este dispositivo? Ele deixará de receber notificações.")) return;
  button.disabled = true;
  try {
    await api(`/api/push/devices/${encodeURIComponent(button.dataset.removeDevice)}`, { method:"DELETE" });
    toast("Dispositivo removido.");
    await loadDevices();
  } catch (error) { button.disabled = false; toast(error.message, true); }
});
$("#theme-toggle").addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("mibro-theme", theme); } catch {}
  syncThemeToggle();
});

$("#toggle-filters-panel").addEventListener("click", () => {
  setFiltersPanelCollapsed(!$(".workspace").classList.contains("filters-collapsed"));
});
$("#toggle-conversation-list").addEventListener("click", () => {
  setConversationListCollapsed(!$(".workspace").classList.contains("conversation-list-collapsed"));
});

// Densidade da lista de conversas (item 4 do redesign): confortável (padrão)
// ou compacta — puramente visual, não afeta os dados carregados.
function setDensity(compact, persist = true) {
  $("#conversation-list").classList.toggle("density-compact", compact);
  const button = $("#density-toggle");
  button.classList.toggle("active", compact);
  button.setAttribute("aria-pressed", String(compact));
  if (persist) try { localStorage.setItem("mibro-density", compact ? "1" : "0"); } catch {}
}
$("#density-toggle").addEventListener("click", () => setDensity(!$("#conversation-list").classList.contains("density-compact")));

// Sidebar de navegação: modo compacto (padrão) / expandido, com persistência,
// e modo gaveta (drawer) no mobile via #sidebar-toggle.
function setSidebarExpanded(expanded, persist = true) {
  $(".workspace").classList.toggle("sidebar-expanded", expanded);
  $("#app-sidebar").classList.toggle("expanded", expanded);
  $("#sidebar-collapse-toggle").setAttribute("aria-expanded", String(expanded));
  if (persist) try { localStorage.setItem("mibro-sidebar-expanded", expanded ? "1" : "0"); } catch {}
}
$("#sidebar-collapse-toggle").addEventListener("click", () => setSidebarExpanded(!$("#app-sidebar").classList.contains("expanded")));
$("#sidebar-toggle").addEventListener("click", () => $("#app-sidebar").classList.toggle("mobile-open"));
document.addEventListener("click", (event) => {
  if (innerWidth > 700) return;
  if (!$("#app-sidebar").classList.contains("mobile-open")) return;
  if (event.target.closest("#app-sidebar") || event.target.closest("#sidebar-toggle")) return;
  $("#app-sidebar").classList.remove("mobile-open");
});

// Menu "mais ações" do cabeçalho da conversa (item 6 do redesign): agrupa
// ações menos frequentes (sinalizar envio, finalizar, apagar) sem alterar
// nenhum dos handlers já existentes desses botões.
$("#chat-overflow-toggle").addEventListener("click", (event) => {
  event.stopPropagation();
  $(".chat-overflow").classList.toggle("open");
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".chat-overflow")) $(".chat-overflow")?.classList.remove("open");
});
$("#bots-button").addEventListener("click", () => { location.href = "/bots"; });
$("#quick-replies-admin-button").addEventListener("click", () => { location.href = "/quick-replies"; });
$("#knowledge-base-button").addEventListener("click", () => { location.href = "/knowledge-base"; });
$("#campaigns-button").addEventListener("click", () => { location.href = "/campaigns"; });
$("#conversation-settings-button").addEventListener("click", () => { location.href = "/configuracoes"; });
$("#integrations-button").addEventListener("click", () => { location.href = "/integrations"; });
$("#user-button").addEventListener("click", async () => { await api("/api/auth/logout", { method:"POST" }); location.replace("/login.html"); });
$("#faq-button").addEventListener("click", () => { renderFaq(); $("#faq-dialog").showModal(); });
$("#close-faq").addEventListener("click", () => $("#faq-dialog").close());
$("#faq-dialog").addEventListener("click", (event) => { if (event.target === $("#faq-dialog")) $("#faq-dialog").close(); });

$("#team-button").addEventListener("click", async () => { try { await loadAdminUsers(); resetTeamForm(); $("#new-team-user").hidden = !state.currentUser.isMaster; $("#team-form").hidden = !state.currentUser.isMaster; $("#team-dialog").classList.toggle("activity-only", !state.currentUser.isMaster); $("#team-dialog").showModal(); } catch (e) { toast(e.message, true); } });
$("#close-team").addEventListener("click", () => $("#team-dialog").close());
$("#team-dialog").addEventListener("click", (event) => { if (event.target === $("#team-dialog")) $("#team-dialog").close(); });

$("#contact-details").addEventListener("click", openContactFiles);
$("#signal-transfer").addEventListener("click", async () => {
  if (!state.selectedId) return;

  const toCategoryId =
    $("#subcategory-select").value ||
    $("#category-select").value;

  if (!toCategoryId) {
    return toast("Selecione um setor para sinalizar.", true);
  }

  try {
    await api(
      `/api/conversations/${state.selectedId}/signal-transfer`,
      {
        method: "POST",
        body: JSON.stringify({ toCategoryId }),
      }
    );

    toast("Encaminhamento sinalizado no chat interno.");
  } catch (error) {
    toast(error.message, true);
  }
});
let mergeContactSearchTimer = null;
async function loadMergeCandidates() {
  const results = $("#merge-contact-results");
  results.innerHTML = '<p class="merge-contact-empty">Buscando...</p>';
  try {
    const query = encodeURIComponent($("#merge-contact-search").value.trim());
    const contacts = await api(`/api/contacts/${state.selectedContactId}/merge-candidates?search=${query}`);
    results.innerHTML = contacts.length ? contacts.map((contact) => {
      const channels = [...new Set((contact.conversations || []).map((item) => mergedChannelLabels[item.channel] || item.channel))].join(" + ");
      const address = contact.email || (contact.phone ? `+${contact.phone}` : "Sem endereço");
      return `<button class="merge-contact-result" type="button" data-merge-contact-id="${escapeHtml(contact.id)}" data-merge-contact-name="${escapeHtml(contact.displayName)}"><span><b>${escapeHtml(contact.displayName)}</b><small>${escapeHtml(address)}</small></span><em>${escapeHtml(channels)}</em></button>`;
    }).join("") : '<p class="merge-contact-empty">Nenhum outro contato acessível encontrado.</p>';
  } catch (error) { results.innerHTML = `<p class="merge-contact-empty error">${escapeHtml(error.message)}</p>`; }
}

$("#merge-contact").addEventListener("click", async () => {
  if (!state.selectedContactId || !state.currentUser?.canMergeContacts) return;
  $("#merge-contact-search").value = "";
  $("#merge-contact-dialog").showModal();
  await loadMergeCandidates();
  $("#merge-contact-search").focus();
});
$("#close-merge-contact").addEventListener("click", () => $("#merge-contact-dialog").close());
$("#merge-contact-dialog").addEventListener("click", (event) => { if (event.target === $("#merge-contact-dialog")) $("#merge-contact-dialog").close(); });
$("#merge-contact-search").addEventListener("input", () => {
  clearTimeout(mergeContactSearchTimer);
  mergeContactSearchTimer = setTimeout(loadMergeCandidates, 250);
});
$("#merge-contact-results").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-merge-contact-id]");
  if (!button || !confirm(`Fundir este contato com ${button.dataset.mergeContactName}?\n\nOs históricos serão preservados.`)) return;
  button.disabled = true;
  try {
    await api(`/api/contacts/${state.selectedContactId}/merge`, { method:"POST", body:JSON.stringify({ targetContactId:button.dataset.mergeContactId }) });
    $("#merge-contact-dialog").close();
    state.selectedHeaderSignature = "";
    await openConversation(state.selectedId, { markRead:false });
    toast("Contatos fundidos. Agora você pode escolher o canal de envio.");
  } catch (error) { button.disabled = false; toast(error.message, true); }
});
$("#merged-channel-select").addEventListener("change", async (event) => {
  const conversationId = event.target.value;
  if (conversationId && conversationId !== state.selectedId) await openConversation(conversationId);
});

$("#edit-contact-name").addEventListener("click", async () => {
  if (!state.selectedContactId || !state.selectedId) return;

  const conversation = state.conversations.find(
    (item) => item.id === state.selectedId
  );

  const currentCustomName = conversation?.contact?.customName || "";

  const value = prompt(
    "Nome personalizado do contato:\n\nDeixe vazio para voltar ao nome recebido pelo WhatsApp.",
    currentCustomName
  );

  if (value === null) return;

  try {
    await api(`/api/contacts/${state.selectedContactId}/name`, {
      method: "PATCH",
      body: JSON.stringify({
        customName: value.trim(),
      }),
    });

    toast(
      value.trim()
        ? "Nome do contato atualizado."
        : "Nome personalizado removido."
    );

    state.selectedHeaderSignature = "";
    state.listSignature = "";

    await Promise.all([
      loadConversations(),
      openConversation(state.selectedId, { markRead: false }),
    ]);
  } catch (error) {
    toast(error.message, true);
  }
});
$("#close-contact-files").addEventListener("click", () => $("#contact-files-dialog").close());
$("#copy-conversation-id").addEventListener("click", async () => {
  const conversationId = state.selectedId;
  if (!conversationId) return;
  try {
    await navigator.clipboard.writeText(conversationId);
    toast("ID copiado.");
  } catch {
    toast("Não foi possível copiar o ID.", true);
  }
});
$("#analyze-conversation-learning").addEventListener("click", async (event) => {
  const conversationId = state.selectedId;
  if (!conversationId) { toast("Nenhuma conversa selecionada.", true); return; }
  const button = event.currentTarget;
  if (button.disabled) return;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Analisando...";
  try {
    const result = await api(`/api/bot-learning/conversations/${encodeURIComponent(conversationId)}/analyze`, { method: "POST" });
    if (result.analyzed) {
      toast(`Análise concluída: ${result.suggestionsGenerated} sugestão(ões) geradas.`);
    } else if (result.reason === "CONVERSATION_NOT_FINALIZED") {
      toast("Esta conversa precisa estar finalizada antes de ser analisada para aprendizado.", true);
    } else if (result.reason === "ALREADY_ANALYZED") {
      toast("Esta conversa já foi analisada (sem mensagens novas desde então).");
    } else {
      toast("Não foi possível analisar esta conversa agora.", true);
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
});
$("#contact-files-dialog").addEventListener("click", (event) => { if (event.target === $("#contact-files-dialog")) $("#contact-files-dialog").close(); });
$(".contact-files-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-files-tab]")?.dataset.filesTab;
  if (tab) renderContactFiles(tab);
});
$("#new-team-user").addEventListener("click", resetTeamForm);
$("#cancel-team-edit").addEventListener("click", resetTeamForm);
$("#team-role").addEventListener("change", syncMasterForm);
$("#open-audit").addEventListener("click", async () => {
  if (!state.currentUser?.isMaster) return;
  $("#team-dialog").close();
  try { await loadAuditLogs(); $("#audit-dialog").showModal(); }
  catch (e) { toast(e.message, true); }
});
$("#close-audit").addEventListener("click", () => $("#audit-dialog").close());
$("#audit-dialog").addEventListener("click", (event) => { if (event.target === $("#audit-dialog")) $("#audit-dialog").close(); });
$("#audit-filter-form").addEventListener("submit", async (event) => { event.preventDefault(); try { await loadAuditLogs(); } catch (e) { toast(e.message, true); } });
$("#team-user-list").addEventListener("click", (event) => {
  const edit = event.target.closest("[data-edit-user]");
  if (edit) return editTeamUser(edit.dataset.editUser);
  const view = event.target.closest("[data-view-user]");
  if (view) { state.assignedUser = view.dataset.viewUser; state.assignedUserActiveOnly = true; state.status = ""; state.category = ""; $("#team-dialog").close(); loadConversations(); }
});
$("#team-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = $("#team-password").value;
  const body = {
    name: $("#team-name").value.trim(), email: $("#team-email").value.trim(), role: $("#team-role").value,
    canViewUncategorized: $("#permission-uncategorized").checked,
    canManageCategories: $("#permission-categories").checked,
    canTransferConversations: $("#permission-transfer").checked,
    canViewConversationHistory: $("#permission-history").checked,
    canViewPreviousMessages: $("#permission-previous-messages").checked,
    canSetConversationPriority: $("#permission-priority").checked,
    canStartConversations: $("#permission-start-conversations").checked,
    canMergeContacts: $("#permission-merge-contacts").checked,
    canManageCampaigns: $("#permission-manage-campaigns").checked,
    categoryIds: [...document.querySelectorAll("#team-category-access .team-category-access-input:checked")].map((input) => input.value),
  };
  if (password) body.password = password;
  if (state.editingUserId) body.active = $("#team-active").checked;
  const submit = event.submitter; submit.disabled = true;
  try {
    const editing = Boolean(state.editingUserId);
    await api(editing ? `/api/admin/users/${state.editingUserId}` : "/api/admin/users", { method:editing ? "PATCH" : "POST", body:JSON.stringify(body) });
    toast(editing ? "Conta atualizada." : "Conta criada.");
    await Promise.all([loadAdminUsers(), loadUsers()]);
    resetTeamForm();
  } catch (e) { toast(e.message, true); }
  finally { submit.disabled = false; }
});
$("#notes-toggle").addEventListener("click", () => toggleContextTab("notes"));
$("#notes-close").addEventListener("click", closeContextPanel);
$("#history-toggle").addEventListener("click", () => toggleContextTab("history"));
$("#history-close").addEventListener("click", closeContextPanel);
$("#note-form").addEventListener("submit", async (event) => { event.preventDefault(); const input = $("#note-input"); const content = input.value.trim(); if (!content) return; try { await api(`/api/contacts/${state.selectedContactId}/notes`, { method:"POST", body:JSON.stringify({ content, conversationId:state.selectedId }) }); input.value = ""; toast("Nota adicionada ao contato."); await openConversation(state.selectedId); setContextTab("notes"); } catch (e) { toast(e.message, true); } });
$("#notes-list").addEventListener("click", async (event) => {
  const deleteButton = event.target.closest(".delete-note");
  if (deleteButton) {
    if (!confirm("Apagar esta nota permanentemente? A ação ficará registrada no histórico.")) return;
    deleteButton.disabled = true;
    try {
      await api(`/api/contacts/${state.selectedContactId}/notes/${deleteButton.dataset.noteId}`, { method:"DELETE", body:JSON.stringify({ conversationId:state.selectedId }) });
      toast("Nota apagada."); await openConversation(state.selectedId); setContextTab("notes");
    } catch (e) { deleteButton.disabled = false; toast(e.message, true); }
    return;
  }
  const button = event.target.closest(".pin-note"); if (!button) return; button.disabled = true; const pinned = button.dataset.pinned !== "true";
  try { await api(`/api/contacts/${state.selectedContactId}/notes/${button.dataset.noteId}`, { method:"PATCH", body:JSON.stringify({ pinned, conversationId:state.selectedId }) }); toast(pinned ? "Nota fixada no topo." : "Nota desafixada."); await openConversation(state.selectedId); setContextTab("notes"); } catch (e) { button.disabled = false; toast(e.message, true); }
});
$("#pin-conversation").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const conversationId = state.selectedId;
  if (!conversationId || button.disabled) return;
  const pinned = button.dataset.pinned !== "true";
  button.disabled = true;
  button.textContent = pinned ? "★ Fixando..." : "☆ Desfixando...";
  try {
    const result = await api(`/api/conversations/${conversationId}/pin`, { method:"PATCH", body:JSON.stringify({ pinned }) });
    if (state.selectedId === conversationId) {
      button.dataset.pinned = String(result.pinned);
      button.textContent = result.pinned ? "★ Fixada" : "☆ Fixar";
      const listed = state.conversations.find((conversation) => conversation.id === conversationId);
      if (listed) listed.isPinned = result.pinned;
      state.selectedHeaderSignature = "";
      state.listSignature = "";
    }
    toast(result.pinned ? "Conversa fixada para sua conta." : "Conversa desafixada.");
    if (state.selectedId === conversationId) await openConversation(conversationId, { markRead:false });
    else await loadConversations();
  } catch (e) {
    if (state.selectedId === conversationId) button.textContent = pinned ? "☆ Fixar" : "★ Fixada";
    toast(e.message, true);
  } finally { button.disabled = false; }
});
function openConversationCategoryTransfer() {
  if ($("#confirm-category").disabled) return;
  const primary = $("#category-select").selectedOptions[0]?.textContent || "Sem categoria";
  const secondary = $("#subcategory-select").value ? $("#subcategory-select").selectedOptions[0]?.textContent : "";
  $("#transfer-destination").textContent = `Destino: ${secondary ? `${primary}: ${secondary}` : primary}`;
  $("#transfer-limit-history").checked = false;
  $("#transfer-reason").value = "";
  $("#transfer-dialog").showModal();
}
async function confirmConversationCategory(event) {
  event.preventDefault();
  const button = $("#confirm-category");
  const categoryId = pendingCategoryId();
  if (!state.selectedId || categoryId === state.selectedCategoryId) return;
  const submit = event.submitter;
  submit.disabled = true;
  button.disabled = true;
  try {
    await api(`/api/conversations/${state.selectedId}`, { method:"PATCH", body:JSON.stringify({
      categoryId:categoryId || null, limitHistory:$("#transfer-limit-history").checked,
      transferReason:$("#transfer-reason").value.trim() || null,
    }) });
    $("#transfer-dialog").close();
    toast("Conversa transferida para a categoria selecionada.");
    closeConversationView();
    await loadConversations();
  } catch (e) {
    $("#transfer-dialog").close();
    toast(e.message, true);
    await openConversation(state.selectedId, { markRead:false });
  } finally { submit.disabled = false; syncCategoryConfirmation(); }
}
$("#category-select").addEventListener("change", (event) => {
  const primaryId = event.target.value;
  populateSubcategorySelect(primaryId, "", state.transferCategories);
  syncCategoryConfirmation();
});
$("#subcategory-select").addEventListener("change", syncCategoryConfirmation);
$("#confirm-category").addEventListener("click", openConversationCategoryTransfer);
$("#transfer-form").addEventListener("submit", confirmConversationCategory);
$("#close-transfer").addEventListener("click", () => $("#transfer-dialog").close());
$("#cancel-transfer").addEventListener("click", () => $("#transfer-dialog").close());
$("#transfer-dialog").addEventListener("click", (event) => { if (event.target === $("#transfer-dialog")) $("#transfer-dialog").close(); });
// Transferência para outra pessoa: antes de trocar o responsável, pergunta
// se o histórico vai junto (o histórico nunca é apagado — sem compartilhar,
// ele só fica oculto para o novo atendente nesta etapa). Assumir para si ou
// deixar sem responsável continuam imediatos.
let pendingUserTransferId = null;
async function saveAssignee(assignedUserId, transfer = {}) {
  await api(`/api/conversations/${state.selectedId}`, { method:"PATCH", body:JSON.stringify({ assignedUserId, ...transfer }) });
  // Depois de transferir para outra pessoa, quem transferiu deixa de ter
  // acesso (conversa privada do novo responsável) — exceto o Master.
  if (assignedUserId && assignedUserId !== state.currentUser?.id && !state.currentUser?.isMaster) {
    toast("Conversa transferida.");
    closeConversationView();
    await loadConversations();
    return;
  }
  toast(assignedUserId ? "Responsável atualizado." : "Conversa sem responsável.");
  await openConversation(state.selectedId);
}
function revertAssigneeSelect() {
  const current = state.conversations.find(({ id }) => id === state.selectedId);
  $("#assignee-select").value = current?.assignedUserId || "";
}
$("#assignee-select").addEventListener("change", async (event) => {
  const assignedUserId = event.target.value || null;
  if (assignedUserId && assignedUserId !== state.currentUser?.id) {
    pendingUserTransferId = assignedUserId;
    $("#user-transfer-destination").textContent = `Novo atendente: ${event.target.selectedOptions[0]?.textContent || "Atendente"}`;
    $("#user-transfer-share-history").checked = true;
    $("#user-transfer-reason").value = "";
    $("#user-transfer-summary").value = "";
    $("#user-transfer-dialog").showModal();
    return;
  }
  try { await saveAssignee(assignedUserId); } catch (e) { revertAssigneeSelect(); toast(e.message, true); }
});
$("#user-transfer-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!pendingUserTransferId) return;
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    await saveAssignee(pendingUserTransferId, {
      shareHistory: $("#user-transfer-share-history").checked,
      transferReason: $("#user-transfer-reason").value.trim() || null,
      handoffSummary: $("#user-transfer-summary").value.trim() || null,
    });
    pendingUserTransferId = null;
    $("#user-transfer-dialog").close();
  } catch (e) {
    toast(e.message, true);
  } finally { if (submit) submit.disabled = false; }
});
$("#user-transfer-dialog").addEventListener("close", () => {
  if (pendingUserTransferId) { pendingUserTransferId = null; revertAssigneeSelect(); }
});
$("#close-user-transfer").addEventListener("click", () => $("#user-transfer-dialog").close());
$("#cancel-user-transfer").addEventListener("click", () => $("#user-transfer-dialog").close());
$("#priority-select").addEventListener("change", async (event) => {
  const previous = state.selectedId ? (state.conversations.find((c) => c.id === state.selectedId)?.priority || "NORMAL") : "NORMAL";
  try {
    await api(`/api/conversations/${state.selectedId}`, { method:"PATCH", body:JSON.stringify({ priority:event.target.value }) });
    toast("Prioridade atualizada.");
    await openConversation(state.selectedId);
  } catch (e) { event.target.value = previous; toast(e.message, true); }
});
$("#toggle-hidden-categories").addEventListener("click", async () => {
  state.visibilityMode = !state.visibilityMode;
  $("#toggle-hidden-categories").classList.toggle("active", state.visibilityMode);
  $("#toggle-hidden-categories").title = state.visibilityMode ? "Ocultar categorias escondidas" : "Mostrar categorias ocultas";
  state.categorySignature = ""; await loadCategories();
});
$("#claim-conversation").addEventListener("click", async () => { try { await api(`/api/conversations/${state.selectedId}/claim`, { method:"POST" }); toast("Conversa atribuída a você."); await openConversation(state.selectedId); } catch (e) { toast(e.message, true); } });
$("#manage-categories").addEventListener("click", () => { renderCategoryManager(); $("#category-dialog").showModal(); });
$("#close-categories").addEventListener("click", () => $("#category-dialog").close());
$("#category-dialog").addEventListener("click", (event) => { if (event.target === $("#category-dialog")) $("#category-dialog").close(); });
$("#category-form").addEventListener("submit", async (event) => { event.preventDefault(); const name = $("#category-name").value.trim(); const color = $("#category-color").value; const parentId = $("#category-parent").value || null; const masterOnly = Boolean(state.currentUser?.isMaster && $("#category-master-only").checked); try { await api("/api/categories", { method:"POST", body:JSON.stringify({ name, color, parentId, masterOnly }) }); $("#category-name").value = ""; $("#category-master-only").checked = false; await loadCategories(); await loadConversations(); toast(parentId ? "Subcategoria criada." : "Categoria criada."); } catch (e) { toast(e.message, true); } });
$("#category-manager-list").addEventListener("submit", async (event) => { event.preventDefault(); const row = event.target.closest("[data-category-id]"); const name = row.querySelector(".managed-name").value.trim(); const color = row.querySelector(".managed-color").value; const parentId = row.querySelector(".managed-parent").value || null; const active = row.querySelector(".managed-active").checked; const masterOnly = row.querySelector(".managed-master-only")?.checked; try { await api(`/api/categories/${row.dataset.categoryId}`, { method:"PATCH", body:JSON.stringify({ name, color, parentId, active, ...(masterOnly === undefined ? {} : { masterOnly }) }) }); await loadCategories(); await loadConversations(); toast("Categoria atualizada."); } catch (e) { toast(e.message, true); } });
$("#category-manager-list").addEventListener("change", (event) => { if (event.target.classList.contains("managed-active")) event.target.closest("label").querySelector("span").textContent = event.target.checked ? "Ativa" : "Inativa"; });
$("#toggle-finalized").addEventListener("click", async (event) => {
  const button = event.currentTarget; const reopening = button.dataset.status === "FINALIZADO";
  button.disabled = true;
  try {
    if (reopening) {
      await api(`/api/conversations/${state.selectedId}`, { method:"PATCH", body:JSON.stringify({ status:"NOVO" }) });
      toast("Atendimento reaberto.");
    } else {
      await api(`/api/conversations/${state.selectedId}/finalize`, { method:"POST" });
      toast("Mensagem de encerramento enviada e atendimento finalizado.");
    }
    await openConversation(state.selectedId);
  } catch (e) { toast(e.message, true); }
  finally { button.disabled = false; }
});
$("#toggle-email-spam").addEventListener("click", async (event) => {
  const conversationId = state.selectedId;
  if (!conversationId) return;
  const button = event.currentTarget;
  const spam = button.dataset.spam !== "true";
  button.disabled = true;
  try {
    await api(`/api/conversations/${conversationId}/spam`, { method:"PATCH", body:JSON.stringify({ spam }) });
    toast(spam ? "Conversa marcada como spam." : "Conversa removida do spam.");
    closeConversationView();
    await loadConversations();
  } catch (e) { toast(e.message, true); }
  finally { button.disabled = false; }
});
$("#delete-conversation").addEventListener("click", async (event) => {
  const conversationId = state.selectedId;
  if (!conversationId || !state.currentUser?.isMaster) return;
  if (!confirm("Apagar esta conversa permanentemente? Todas as mensagens e o histórico desta conversa serão excluídos.")) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await api(`/api/conversations/${conversationId}`, { method:"DELETE" });
    closeConversationView();
    await loadConversations();
    toast("Conversa apagada.");
  } catch (e) { toast(e.message, true); }
  finally { button.disabled = false; }
});
let selectedAttachment = null;
let attachmentUrl = null;
function clearSelectedAttachment() {
  selectedAttachment = null; $("#attachment-input").value = ""; $("#attachment-preview").hidden = true;
  $("#attachment-thumb").hidden = false; $("#attachment-type").hidden = true;
  $("#message-input").maxLength = 4096;
  if (attachmentUrl) URL.revokeObjectURL(attachmentUrl); attachmentUrl = null;
}

function selectAttachmentFile(file) {
  if (!file) return clearSelectedAttachment();

  const isImage = ["image/jpeg", "image/png"].includes(file.type);
  const isDocument = isDocumentMime(file.type);
  const isVideo = ["video/mp4", "video/3gpp", "video/3gp"].includes(file.type);

  if (!isImage && !isDocument && !isVideo) {
    clearSelectedAttachment();

    return toast(
      "Envie uma imagem JPG/PNG, vídeo MP4/3GP ou documento PDF/TXT/Word/Excel/PowerPoint.",
      true
    );
  }

  if (isImage && file.size > 5 * 1024 * 1024) {
    clearSelectedAttachment();
    return toast("A imagem deve ter no máximo 5 MB.", true);
  }

  if (isVideo && file.size > 16 * 1024 * 1024) {
    clearSelectedAttachment();
    return toast("O vídeo deve ter no máximo 16 MB.", true);
  }

  if (isDocument && file.size > 100 * 1024 * 1024) {
    clearSelectedAttachment();
    return toast("O documento deve ter no máximo 100 MB.", true);
  }

  if (attachmentUrl) {
    URL.revokeObjectURL(attachmentUrl);
  }

  attachmentUrl = null;
  selectedAttachment = file;

  $("#attachment-thumb").hidden = !isImage;
  $("#attachment-type").hidden = isImage;

  $("#attachment-type").textContent = isDocument
    ? documentTypeLabel(file.type, file.name)
    : "VÍDEO";

  if (isImage) {
    attachmentUrl = URL.createObjectURL(file);
    $("#attachment-thumb").src = attachmentUrl;
  }

  $("#message-input").maxLength = 1024;
  $("#attachment-name").textContent = file.name || "Imagem colada";
  $("#attachment-preview").hidden = false;
  $("#message-input").focus();
}

$("#attachment-input").addEventListener("change", (event) => {
  selectAttachmentFile(event.target.files[0]);
});

$("#message-input").addEventListener("paste", (event) => {
  const files = Array.from(event.clipboardData?.files || []);

  const image = files.find((file) =>
    ["image/jpeg", "image/png"].includes(file.type)
  );

  if (!image) return;

  event.preventDefault();

  const extension =
    image.type === "image/jpeg"
      ? "jpg"
      : "png";

  const pastedImage = new File(
    [image],
    `imagem-colada-${Date.now()}.${extension}`,
    {
      type: image.type,
    }
  );

  selectAttachmentFile(pastedImage);
});

$("#message-input").addEventListener("paste", (event) => {
  const items = Array.from(event.clipboardData?.items || []);

  const imageItem = items.find(
    (item) =>
      item.kind === "file" &&
      ["image/png", "image/jpeg"].includes(item.type)
  );

  if (!imageItem) return;

  const file = imageItem.getAsFile();
  if (!file) return;

  event.preventDefault();

  const extension =
    file.type === "image/jpeg"
      ? "jpg"
      : "png";

  const pastedImage = new File(
    [file],
    `imagem-colada-${Date.now()}.${extension}`,
    { type: file.type }
  );

  const transfer = new DataTransfer();
  transfer.items.add(pastedImage);

  const input = $("#attachment-input");
  input.files = transfer.files;

  input.dispatchEvent(
    new Event("change", { bubbles: true })
  );
});

$("#remove-attachment").addEventListener("click", clearSelectedAttachment);
// ===== Respostas rápidas (quick replies) =====
// Seleção NUNCA envia mensagem — só preenche o composer (item 8). Toda
// validação de acesso (ativa, canal, setor) é feita pelo backend em /use.
let quickReplySlashActive = null;

async function loadQuickRepliesCache(conversationId) {
  if (!conversationId) return;
  try { state.quickReplies = await api(`/api/quick-replies/composer?conversationId=${encodeURIComponent(conversationId)}`); }
  catch { state.quickReplies = []; }
}

function quickReplyCategories() {
  const map = new Map();
  state.quickReplies.forEach((item) => {
    const categories = item.categories?.length ? item.categories : (item.category ? [item.category] : []);
    categories.forEach((category) => map.set(category.id, category.name));
  });
  return [...map.entries()];
}

function renderQuickReplyCategories() {
  const chips = [{ id: "", name: "Todas" }, ...quickReplyCategories().map(([id, name]) => ({ id, name }))];
  $("#quick-reply-categories").innerHTML = chips.map((chip) => (
    `<button type="button" data-category="${chip.id}" class="${state.quickReplyCategoryFilter === chip.id ? "active" : ""}">${escapeHtml(chip.name)}</button>`
  )).join("");
  document.querySelectorAll("#quick-reply-categories button").forEach((button) => (
    button.addEventListener("click", () => { state.quickReplyCategoryFilter = button.dataset.category; renderQuickReplyCategories(); renderQuickReplyList(); })
  ));
}

function filteredQuickReplies() {
  const term = state.quickReplySearch.trim().toLowerCase();
  return state.quickReplies.filter((item) => {
    if (state.quickReplyCategoryFilter && !(item.categoryIds || [item.categoryId]).includes(state.quickReplyCategoryFilter)) return false;
    if (!term) return true;
    const categoryNames = (item.categories || []).map((category) => category.name);
    return [item.name, item.shortcut, item.text, item.category?.name, ...categoryNames].filter(Boolean).some((field) => field.toLowerCase().includes(term));
  });
}

function quickReplyCard(item) {
  return `<article class="quick-reply-card" data-quick-reply-id="${escapeHtml(item.id)}" role="button" tabindex="0">
    <div class="quick-reply-card-head">
      <b>${escapeHtml(item.name)}</b>
      <span class="quick-reply-card-shortcut">${escapeHtml(item.shortcut)}</span>
      <button type="button" class="quick-reply-favorite ${item.isFavorite ? "active" : ""}" data-favorite-id="${escapeHtml(item.id)}" title="Favoritar" aria-label="Favoritar">${item.isFavorite ? "★" : "☆"}</button>
    </div>
    <p>${escapeHtml(item.text)}</p>
  </article>`;
}

function renderQuickReplyList() {
  const items = filteredQuickReplies();
  if (!items.length) {
    $("#quick-reply-list").innerHTML = '<div class="quick-reply-empty">Nenhuma resposta rápida encontrada.</div>';
  } else {
    const favorites = items.filter((item) => item.isFavorite);
    const rest = items.filter((item) => !item.isFavorite);
    $("#quick-reply-list").innerHTML = `
      ${favorites.length ? `<div class="quick-reply-list-heading">FAVORITAS</div>${favorites.map(quickReplyCard).join("")}` : ""}
      <div class="quick-reply-list-heading">${favorites.length ? "TODAS" : "RESPOSTAS"}</div>${rest.map(quickReplyCard).join("")}
    `;
  }
  document.querySelectorAll("[data-quick-reply-id]").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("[data-favorite-id]")) return;
      selectQuickReply(card.dataset.quickReplyId);
    });
    card.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && !event.target.closest("[data-favorite-id]")) {
        event.preventDefault();
        selectQuickReply(card.dataset.quickReplyId);
      }
    });
  });
  document.querySelectorAll("[data-favorite-id]").forEach((button) => (
    button.addEventListener("click", (event) => { event.stopPropagation(); toggleQuickReplyFavorite(button.dataset.favoriteId); })
  ));
}

async function toggleQuickReplyFavorite(id) {
  const item = state.quickReplies.find((row) => row.id === id);
  if (!item) return;
  try {
    const result = await api(`/api/quick-replies/${id}/favorite`, { method:"POST", body: JSON.stringify({ conversationId: state.selectedId, favorite: !item.isFavorite }) });
    item.isFavorite = result.favorite;
    renderQuickReplyList();
  } catch (e) { toast(e.message, true); }
}

async function selectQuickReply(id) {
  try {
    const result = await api(`/api/quick-replies/${id}/use`, { method:"POST", body: JSON.stringify({ conversationId: state.selectedId, source: "AGENT" }) });
    $("#quick-reply-dialog").close();
    const input = $("#message-input");
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + result.text + input.value.slice(end);
    autoResizeComposer();
    const cursor = start + result.text.length;
    input.focus();
    input.setSelectionRange(cursor, cursor);
    if (result.unresolved?.length) toast(`Variável não encontrada: ${result.unresolved.join(", ")}`, true);
  } catch (e) { toast(e.message, true); }
}

async function openQuickReplyDialog() {
  if (!state.selectedId) return;
  state.quickReplyCategoryFilter = "";
  state.quickReplySearch = "";
  $("#quick-reply-search").value = "";
  try {
    await loadQuickRepliesCache(state.selectedId);
    renderQuickReplyCategories();
    renderQuickReplyList();
    $("#quick-reply-dialog").showModal();
  } catch (e) { toast(e.message, true); }
}

$("#open-quick-replies").addEventListener("click", openQuickReplyDialog);
$("#close-quick-replies").addEventListener("click", () => $("#quick-reply-dialog").close());
$("#quick-reply-dialog").addEventListener("click", (event) => { if (event.target === $("#quick-reply-dialog")) $("#quick-reply-dialog").close(); });
$("#quick-reply-search").addEventListener("input", (event) => { state.quickReplySearch = event.target.value; renderQuickReplyList(); });

// Atalhos com "/" (item 9) — nunca faz uma chamada de rede por tecla:
// filtra a lista já carregada da conversa aberta (loadQuickRepliesCache).
function hideSlashSuggestions() {
  quickReplySlashActive = null;
  $("#slash-suggestions").hidden = true;
  $("#slash-suggestions").innerHTML = "";
}

function currentSlashToken(input) {
  const cursor = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, cursor);
  const match = before.match(/(?:^|\s)(\/[a-z0-9_]*)$/i);
  if (!match) return null;
  const token = match[1];
  return { token, start: cursor - token.length, end: cursor };
}

function renderSlashSuggestions() {
  const box = $("#slash-suggestions");
  if (!quickReplySlashActive || !quickReplySlashActive.matches.length) return hideSlashSuggestions();
  box.innerHTML = quickReplySlashActive.matches.map((item, index) => (
    `<div class="slash-suggestion-item ${index === quickReplySlashActive.activeIndex ? "active" : ""}" data-slash-index="${index}">
      <b>${escapeHtml(item.shortcut)}</b><small>${escapeHtml(item.name)} — ${escapeHtml(item.text.slice(0, 60))}</small>
    </div>`
  )).join("");
  box.hidden = false;
  document.querySelectorAll("[data-slash-index]").forEach((row) => (
    row.addEventListener("click", () => applySlashSuggestion(Number(row.dataset.slashIndex)))
  ));
}

async function applySlashSuggestion(index) {
  const active = quickReplySlashActive;
  if (!active) return;
  const item = active.matches[index];
  if (!item) return;
  hideSlashSuggestions();
  try {
    const result = await api(`/api/quick-replies/${item.id}/use`, { method:"POST", body: JSON.stringify({ conversationId: state.selectedId, source: "AGENT" }) });
    const input = $("#message-input");
    input.value = input.value.slice(0, active.start) + result.text + input.value.slice(active.end);
    autoResizeComposer();
    const cursor = active.start + result.text.length;
    input.focus();
    input.setSelectionRange(cursor, cursor);
    if (result.unresolved?.length) toast(`Variável não encontrada: ${result.unresolved.join(", ")}`, true);
  } catch (e) { toast(e.message, true); }
}

// Auto-resize do composer: cresce até ~3x a altura inicial (44px -> 132px),
// depois disso rola internamente. Ao enviar/limpar, volta ao tamanho padrão.
const COMPOSER_MIN_HEIGHT = 44;
const COMPOSER_MAX_HEIGHT = COMPOSER_MIN_HEIGHT * 3;
function autoResizeComposer() {
  const input = $("#message-input");
  input.style.height = "auto";
  input.style.height = `${Math.min(Math.max(input.scrollHeight, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT)}px`;
  input.style.overflowY = input.scrollHeight > COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
}
function resetComposerHeight() {
  const input = $("#message-input");
  input.style.height = `${COMPOSER_MIN_HEIGHT}px`;
  input.style.overflowY = "hidden";
}
$("#message-input").addEventListener("input", autoResizeComposer);

function applyMessageFormat(marker) {
  const input = $("#message-input");
  if (input.disabled) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const selected = input.value.slice(start, end);
  const sample = selected || "texto";
  input.setRangeText(`${marker}${sample}${marker}`, start, end, "end");
  input.focus();
  if (!selected) input.setSelectionRange(start + marker.length, start + marker.length + sample.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

document.querySelectorAll("[data-message-format]").forEach((button) => {
  button.addEventListener("click", () => applyMessageFormat(button.dataset.messageFormat));
});

$("#message-input").addEventListener("input", () => {
  const slash = currentSlashToken($("#message-input"));
  if (!slash) return hideSlashSuggestions();
  const term = slash.token.slice(1).toLowerCase();
  const matches = state.quickReplies
    .filter((item) => item.shortcut.slice(1).toLowerCase().startsWith(term))
    .slice(0, 8);
  if (!matches.length) return hideSlashSuggestions();
  quickReplySlashActive = { ...slash, matches, activeIndex: 0 };
  renderSlashSuggestions();
});

$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#message-input");
  const text = input.value.trim();
  if (!text && !selectedAttachment) return;
  const pendingSuggestion = state.pendingBotSuggestion;
  $("#send-button").disabled = true;
  try {
    if (selectedAttachment) {
      const isDocument = isDocumentMime(selectedAttachment.type);
      const isVideo = selectedAttachment.type.startsWith("video/");
      const field = isDocument ? "document" : (isVideo ? "video" : "image");
      const endpoint = isDocument ? "documents" : (isVideo ? "videos" : "images");
      const form = new FormData();
      form.append(field, selectedAttachment);
      if (text) form.append("caption", text);
      await api(`/api/conversations/${state.selectedId}/${endpoint}`, { method:"POST", body:form });
      clearSelectedAttachment();
    } else {
      await api(`/api/conversations/${state.selectedId}/messages`, { method:"POST", body:JSON.stringify({ text }) });
    }
    if (pendingSuggestion?.observationId && text) {
      const action = text === pendingSuggestion.originalText.trim() ? "USED" : "EDITED";
      await api("/api/bot-suggestion-feedback", {
        method: "POST",
        body: JSON.stringify({ observationId: pendingSuggestion.observationId, action, finalResponseText: text }),
      }).catch(() => {});
    }
    state.pendingBotSuggestion = null;
    input.value = "";
    resetComposerHeight();
    hideSlashSuggestions();
    await openConversation(state.selectedId);
  } catch (e) {
    if (e.customerServiceWindow) state.customerServiceWindow = e.customerServiceWindow;
    toast(e.message, true);
  } finally {
    syncCustomerServiceWindow();
    input.focus();
  }
});
$("#open-templates").addEventListener("click", openTemplates);
$("#open-required-template").addEventListener("click", openTemplates);
$("#close-templates").addEventListener("click", () => $("#template-dialog").close());
$("#template-dialog").addEventListener("click", (event) => { if (event.target === $("#template-dialog")) $("#template-dialog").close(); });
$("#template-search").addEventListener("input", renderTemplateList);
$("#template-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedTemplate || !state.selectedId) return;
  const values = Object.fromEntries([...document.querySelectorAll("[data-template-variable]")].map((input) => [input.dataset.templateVariable, input.value.trim()]));
  $("#send-template").disabled = true;
  try {
    await api(`/api/conversations/${state.selectedId}/templates`, { method:"POST", body:JSON.stringify({ name:state.selectedTemplate.name, language:state.selectedTemplate.language, values }) });
    $("#template-dialog").close();
    toast("Template enviado para o cliente.");
    await openConversation(state.selectedId);
  } catch (error) { toast(error.message, true); }
  finally { $("#send-template").disabled = false; }
});
$("#message-input").addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    const marker = ({ b:"*", i:"_" })[event.key.toLowerCase()];
    if (marker) { event.preventDefault(); return applyMessageFormat(marker); }
  }
  if (quickReplySlashActive && quickReplySlashActive.matches.length) {
    if (event.key === "ArrowDown") { event.preventDefault(); quickReplySlashActive.activeIndex = (quickReplySlashActive.activeIndex + 1) % quickReplySlashActive.matches.length; return renderSlashSuggestions(); }
    if (event.key === "ArrowUp") { event.preventDefault(); quickReplySlashActive.activeIndex = (quickReplySlashActive.activeIndex - 1 + quickReplySlashActive.matches.length) % quickReplySlashActive.matches.length; return renderSlashSuggestions(); }
    if (event.key === "Escape") { event.preventDefault(); return hideSlashSuggestions(); }
    if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); return applySlashSuggestion(quickReplySlashActive.activeIndex); }
  }
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("#composer").requestSubmit(); }
});
$(".chat-header").addEventListener("click", (event) => { if (innerWidth <= 700 && event.offsetX < 45) $("#chat-panel").classList.remove("open"); });

syncThemeToggle();
try { setFiltersPanelCollapsed(localStorage.getItem("mibro-filters-collapsed") === "1", false); } catch { setFiltersPanelCollapsed(false, false); }
try { setChannelWorkspace(localStorage.getItem("mibro-channel-workspace") || "", { load:false, persist:false }); } catch { setChannelWorkspace("", { load:false, persist:false }); }
try { setDensity(localStorage.getItem("mibro-density") === "1", false); } catch { setDensity(false, false); }
try { setSidebarExpanded(localStorage.getItem("mibro-sidebar-expanded") === "1", false); } catch { setSidebarExpanded(false, false); }
try { setContextTab(localStorage.getItem("mibro-context-tab") || "details", { open:false }); } catch { setContextTab("details", { open:false }); }
try { setContextPanelOpen(localStorage.getItem("mibro-context-open") === "1", false); } catch { setContextPanelOpen(false, false); }
loadCurrentUser()
  .then(() => Promise.all([loadUsers(), loadCategories(), loadOutboundChannels()]))
  .then(loadAdminUsers)
  .then(loadConversations)
  .then(async () => {
    const requestedConversation = new URLSearchParams(location.search).get("conversation");
    if (requestedConversation) {
      history.replaceState({}, "", "/");
      try { await openConversation(requestedConversation); } catch {}
    }
    await checkAlerts();
  })
  .then(connectRealtime)
  .catch((error) => {
    toast(error.message, true);
    if ($("#conversation-list").querySelector(".skeleton-list")) {
      $("#conversation-list").innerHTML = `<div class="empty-list">Não foi possível carregar as conversas. Recarregue a página.</div>`;
    }
  });
setInterval(() => { (document.hidden ? checkAlerts() : refreshInbox()).catch(() => {}); }, 30000);


// Navegação por áreas: mantém apenas um menu aberto e fecha ao escolher
// uma opção ou clicar fora, sem alterar os handlers/permissões dos botões.
document.querySelectorAll(".topbar-menu").forEach((menu) => {
  menu.addEventListener("toggle", () => {
    if (!menu.open) return;
    document.querySelectorAll(".topbar-menu[open]").forEach((other) => {
      if (other !== menu) other.removeAttribute("open");
    });
  });
});
document.addEventListener("click", (event) => {
  document.querySelectorAll(".topbar-menu[open]").forEach((menu) => {
    if (!menu.contains(event.target) || event.target.closest(".topbar-menu-item")) {
      menu.removeAttribute("open");
    }
  });
});

$("#supervision-button").addEventListener("click", () => window.WaSupervision?.open());
$("#assignment-timeline").addEventListener("click", () => { if (state.selectedId) window.WaSupervision?.openTimeline(state.selectedId); });
