const MARKETPLACE_UI_ENABLED = window.MIBRO_FEATURES?.marketplaces !== false;
const composerSendGuard = window.ComposerSendGuard.create();
const isMarketplaceChannel = (channel) => window.isMarketplaceFeatureChannel?.(channel) === true;
if (MARKETPLACE_UI_ENABLED) document.querySelectorAll("[data-marketplace-feature]").forEach((element) => { element.hidden = false; });

const state = {
  conversations: [], categories: [], transferCategories: [], users: [], currentUser: null,
  selectedId: null, selectedContactId: null, selectedCategoryId: "", status: "", category: "", search: "", channel: "", emailMailbox: "GENERAL",
  // Filtros combináveis adicionais (item 11): multi-select, somam-se ao filtro
  // de status principal (single-select, inalterado) em vez de substituí-lo —
  // o backend já aceita status/priority como CSV, então cada Set aqui só
  // precisa virar uma lista separada por vírgula na hora de montar a query.
  statusToggle: new Set(), priorityToggle: new Set(), slaBreached: false, unassigned: false, preferredAssignee: "",
  categorySignature: "", listSignature: "", selectedHeaderSignature: "",
  selectedMessagesSignature: "", selectedNotesSignature: "", selectedActivitiesSignature: "", selectedMessageItems: [],
  selectedMessages: [], selectedContactName: "", contactFilesTab: "media",
  expandedCategories: new Set(), adminUsers: [], auditLogs: [], editingUserId: null, assignedUser: "",
  assignedUserActiveOnly: false, alertCursor: null, checkingAlerts: false,
  customerServiceWindow: null, templates: [], selectedTemplate: null,
  outboundChannels: [], outboundTemplates: [], selectedOutboundTemplate: null, categoryVisibility: { hideUncategorized:false, hiddenCategoryIds:[] }, visibilityMode:false,
  quickReplies: [], quickReplyCategoryFilter: "", quickReplyTypeFilter: "", quickReplySearch: "",
  botSuggestion: null, pendingBotSuggestion: null,
  mergedDestinations: [],
  // Workspaces: empresas acessíveis (com o cargo em cada uma), workspace
  // ativo (slug de UMA empresa — não existe "Todas") e empresa da conversa aberta.
  companies: [], companyFilter: "", selectedCompanyId: null,
};
const $ = (selector) => document.querySelector(selector);
const defaultDocumentTitle = document.title;
let waitingTitleTimer = null;
let waitingAlertCount = 0;
let conversationLoadSequence = 0;
let conversationListSequence = 0;
// Áudio no composer: gravação em andamento + áudio pronto para revisar e
// enviar. Fica no topo porque openConversation/closeConversationView já o
// consultam (o restante está no bloco "Áudio no composer").
const audioRecorder = { recorder:null, stream:null, chunks:[], startedAt:0, pausedAt:0, pausedTotal:0, timer:null, discard:false, mimeType:"" };
let pendingAudio = null;
let pendingAudioUrl = null;
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[char]);
const initials = (name = "?") => (String(name ?? '').trim() || '?').split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
// Multiempresa: identidade discreta por empresa. A cor vem sempre de
// company.primaryColor (validada como #RRGGBB) — nunca fixa no código.
const companyColor = (company) => (/^#[0-9a-f]{6}$/i.test(company?.primaryColor || "") ? company.primaryColor : "");
const companyStyleAttr = (company) => (companyColor(company) ? ` style="--company-color:${companyColor(company)}"` : "");
const companyBadge = (company, extraClass = "") => (company && state.companies.some((entry) => entry.id === company.id)
  ? `<span class="company-badge ${extraClass}"${companyStyleAttr(company)} title="${escapeHtml(company.name || company.displayName)}">${escapeHtml(company.displayName || company.name)}</span>`
  : "");
// Com uma empresa só, o badge seria redundante (a borda continua).
const multiCompany = () => state.companies.length > 1;
const companyQuery = () => (state.companyFilter && state.companyFilter !== "ALL" ? state.companyFilter : "");
const activeCompany = () => state.companies.find((company) => company.slug === state.companyFilter) || null;
const canViewSidebarUncategorized = () => state.currentUser?.isMaster
  || (activeCompany()?.permissions?.canViewUncategorized ?? state.currentUser?.canViewUncategorized);

// A visão "Todas" reúne setores de mesmo código. Nesse caso a borda
// mostra as cores de todas as empresas, sem atribuir o filtro a só uma.
function categoryCompanyBorder(category, categories) {
  const owners = new Map();
  for (const item of categories) {
    if (state.companyFilter !== "ALL" && item.company?.slug !== state.companyFilter) continue;
    if (item.code !== category.code || Boolean(item.parentId) !== Boolean(category.parentId)) continue;
    if (category.parentId && item.parent?.code !== category.parent?.code) continue;
    const company = item.company || state.companies.find((entry) => entry.id === item.companyId);
    if (company && companyColor(company)) owners.set(company.id, company);
  }
  const companies = [...owners.values()];
  if (!companies.length) return "";
  const stops = companies.flatMap((company, index) => [
    `${companyColor(company)} ${index * 100 / companies.length}%`,
    `${companyColor(company)} ${(index + 1) * 100 / companies.length}%`,
  ]);
  return ` data-company-border style="--category-company-border:linear-gradient(to bottom,${stops.join(",")})" title="${escapeHtml(companies.map((company) => company.name || company.displayName).join(" · "))}"`;
}
const conversationTimeZone = "America/Sao_Paulo";
const cardTimeFormatter = new Intl.DateTimeFormat("pt-BR", { hour:"2-digit", minute:"2-digit", timeZone:conversationTimeZone });
const time = (value) => value ? cardTimeFormatter.format(new Date(value)) : "";
const statusLabel = (value) => ({ NOVO:"Novo", EM_ATENDIMENTO:"Em atendimento", AGUARDANDO_EQUIPE:"Aguardando equipe", AGUARDANDO_CLIENTE:"Aguardando cliente", HANDOFF_BOT:"Bot transferiu", BOT:"Bot", FINALIZADO:"Finalizado" })[value] || value;
// Alerta visual (não bloqueante) para conversa em atendimento ainda sem categoria.
// Finalizadas e as que ainda estão com o bot (triagem em andamento) não alertam.
const needsCategoryAlert = (c) => Boolean(c) && !c.categoryId && !["FINALIZADO", "BOT"].includes(c.status);
function syncCategoryAlert(c) {
  const missing = needsCategoryAlert(c);
  $("#category-select").classList.toggle("category-missing", missing);
  $("#category-missing-hint").hidden = !missing;
}
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
  ['image/tiff','TIFF → PDF'],['image/x-tiff','TIFF → PDF'],['image/heic','HEIC → PDF'],['image/heif','HEIF → PDF'],['image/heic-sequence','HEIC → PDF'],['image/heif-sequence','HEIF → PDF'],
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
  if(c.archivedAt)return '<div class="limited-history-notice"><b>Conversa arquivada.</b> Histórico preservado. Para voltar a atender, use Recuperar conversa nos detalhes do contato.</div>';
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
    return `<div class="supervision-notice"><b>Acompanhamento — somente leitura.</b><br>Você vê apenas os trechos dos atendentes permitidos${windows ? `: ${escapeHtml(windows)}` : "."} Para responder, o responsável precisa transferir a conversa para você.</div>`;
  }
  if (c.messageHistoryLimited) parts.push("As mensagens anteriores ao encaminhamento estão ocultas para esta conta.");
  return parts.length ? `<div class="limited-history-notice">${parts.join("<br>")}</div>` : "";
}

function renderAssistantIntake(intake, wasOpen) {
  const messages = $("#messages");
  let card = $("#assistant-intake");
  const signature = intake?.fields?.length ? JSON.stringify(intake) : "";
  if (!signature) {
    card?.remove();
    return;
  }
  if (card?.dataset.signature !== signature) {
    card?.remove();
    card = document.createElement("details");
    card.id = "assistant-intake";
    card.dataset.signature = signature;
    card.open = wasOpen;
    const date = intake.finishedAt ? new Date(intake.finishedAt).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short",
    }) : "";
    card.innerHTML = `<summary>Ficha do bot <small>Interna${date ? ` · ${escapeHtml(date)}` : ""}</small></summary>
      <dl>${intake.fields.map(({ label, text }) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(text)}</dd></div>`).join("")}</dl>`;
  }
  if (messages.lastElementChild !== card) messages.append(card);
}

function closeConversationView() {
  window.CentralSessionState?.keep(state.composerConversationId,$('#message-input').value);
  state.composerConversationId=null;
  $('#message-input').value='';
  conversationLoadSequence += 1;
  state.selectedCompanyId = null;
  if ($("#composer-sender")) { $("#composer-sender").hidden = true; $("#composer-sender").innerHTML = ""; }
  if ($("#contact-company")) $("#contact-company").hidden = true;
  discardComposerAudio();
  state.selectedId = null;
  window.CrmContext?.select(null);
  window.ContactWarning?.select(null);
  state.selectedContactId = null;
  state.selectedCategoryId = "";
  state.selectedHeaderSignature = "";
  state.selectedMessagesSignature = "";
  state.selectedNotesSignature = "";
  state.selectedActivitiesSignature = "";
  state.selectedMessageItems = [];
  state.selectedMessages = [];
  resetTimelineState();
  if($('#contact-files-dialog')?.open)$('#contact-files-dialog').close();
  state.selectedContactName = "";
  state.selectedContactPhone = "";
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
  $("#chat-content").classList.remove("mobile-tools-open");
  $("#mobile-chat-tools").setAttribute("aria-expanded", "false");
  $("#empty-state").hidden = false;
  $("#chat-panel").classList.remove("open");
  $("#confirm-category").disabled = true;
  syncCategoryAlert(null);
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
const CONTEXT_TABS = ["details", "crm", "notes", "agenda", "history", "bot", "sla", "files"];
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
  if (open && tab === "crm") window.CrmContext?.show();
  if(open&&tab==='files')loadSharedContent().catch(()=>{});
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
  if (message.type === "unsupported") return "⚠ Mensagem não suportada — solicitar reenvio";
  if (message.type === "image") return message.text && message.text !== "[image]" ? `📷 ${message.text}` : "📷 Imagem";
  if (message.type === "contacts") { const cards = sharedContactCards(message); return cards.length === 1 ? `👤 ${cards[0].name}` : cards.length ? `👤 ${cards.length} contatos compartilhados` : "👤 Contato compartilhado"; }
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
    conversation.companyId, conversation.company?.primaryColor, multiCompany(),
    conversation.categoryId, conversation.category?.name, conversation.category?.color, conversation.category?.parent?.name,
    conversation.assignedUserId, conversation.assignedUser?.name, conversation.channelAccountId, conversation.channelAccount?.name,
    conversation.priority, conversation.firstResponseSlaBreached, conversation.responseSlaBreached, conversation.slaMinutesRemaining,
    conversation.isPinned,
    conversation.contact.customName, conversation.contact.name, conversation.contact.email, conversation.contact.phone, conversation.contact._count?.notes,
    note?.id, note?.content,
    lastMessage?.id, lastMessage?.text, lastMessage?.type,
    conversation.contact.preferredAssigneeEnabled, conversation.contact.preferredAssignee?.id, conversation.contact.preferredAssignee?.name,
  ]);
}

function conversationCardMarkup(c) {
  const last = c.messages[0]; const name = c.contact.customName || c.contact.name || c.contact.email || c.contact.phone; const note = c.contact.notes?.[0];
  return `<button class="conversation-card ${c.id === state.selectedId ? "active" : ""} ${c.company ? "has-company" : ""}" data-id="${escapeHtml(c.id)}"${c.company ? ` data-company="${escapeHtml(c.company.slug)}"` : ""}${companyStyleAttr(c.company)}${c.id === state.selectedId ? ` aria-current="true"` : ""}>
    <span class="card-grip" aria-hidden="true"></span><span class="avatar">${escapeHtml(initials(name))}</span><span class="card-main">
    <span class="card-title"><strong>${c.isPinned ? `<i class="conversation-pin" title="Conversa fixada">★</i>` : ""}${escapeHtml(name)}</strong>${multiCompany() ? companyBadge(c.company, "card-company-badge") : ""}<small>${escapeHtml(c.contact.email || c.contact.phone || "")}</small></span>
    <span class="preview">${escapeHtml(messagePreview(last))}</span>
    <span class="card-labels">${channelBadge(c.channel) ? `<span class="channel-label">${escapeHtml(channelBadge(c.channel))}</span>` : ""}${c.channel === "META" && c.channelAccount?.name ? `<span class="channel-label">${escapeHtml(c.channelAccount.name)}</span>` : ""}${needsCategoryAlert(c) ? `<span class="category-label category-missing-label" title="Esta conversa ainda não possui categoria definida.">⚠ Sem categoria</span>` : `<span class="category-label" style="color:${c.category?.color || "#666"};border-color:${c.category?.color || "#aaa"}">${escapeHtml(categoryLabel(c.category))}</span>`}<span class="status-label">${escapeHtml(statusLabel(c.status))}</span>${c.assignedUser ? `<span class="assignee-label">${escapeHtml(c.assignedUser.name)}</span>` : ""}${c.contact.preferredAssigneeEnabled && c.contact.preferredAssignee && c.contact.preferredAssignee.id !== c.assignedUserId ? `<span class="preferred-assignee-label" title="Atendente fixo do cliente">★ ${escapeHtml(c.contact.preferredAssignee.name)}</span>` : ""}${priorityBadge(c.priority)}${slaBadge(c.slaMinutesRemaining)}</span></span>
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
  const links = [];
  const escaped = window.ChatFeatures?.protectLinks(escapeHtml(String(value ?? "")), links) ?? escapeHtml(String(value ?? ""));
  const html = escaped.split(/(```[\s\S]*?```)/g).map((part) => {
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
  return links.length ? window.ChatFeatures.restoreLinks(html, links) : html;
}

// Read only the shared cards, never the sender profile in the webhook envelope.
function sharedContactCards(message) {
  const cards = message?.type === "contacts" && Array.isArray(message.rawPayload?.contacts) ? message.rawPayload.contacts : [];
  const text = (value, limit = 180) => typeof value === "string" ? value.trim().slice(0, limit) : "";
  return cards.filter((card) => card && typeof card === "object" && !Array.isArray(card)).map((card) => {
    const name = text(card.name?.formatted_name) || [card.name?.first_name, card.name?.middle_name, card.name?.last_name].map((part) => text(part)).filter(Boolean).join(" ") || "Contato compartilhado";
    const phones = (Array.isArray(card.phones) ? card.phones : []).filter((phone) => phone && typeof phone === "object").map((phone) => {
      const number = text(phone.phone, 80) || text(phone.wa_id, 80);
      const digits = number.replace(/\D/g, "");
      const dial = /^\+?[\d\s().-]+$/.test(number) && digits.length >= 5 && digits.length <= 20 ? `${number.startsWith("+") ? "+" : ""}${digits}` : null;
      const label = ({ CELL: "Celular", WORK: "Comercial", HOME: "Residencial", MAIN: "Principal" })[text(phone.type).toUpperCase()] || "Telefone";
      return { number, dial, label };
    }).filter((phone) => phone.number);
    const emails = (Array.isArray(card.emails) ? card.emails : []).map((email) => text(email?.email, 254)).filter(Boolean);
    return { name, phones, emails, company: text(card.org?.company) };
  });
}

function sharedContactsContent(message) {
  const cards = sharedContactCards(message);
  if (!cards.length) return '<p class="shared-contact-unavailable">Contato compartilhado — os dados não estão disponíveis nesta mensagem.</p>';
  return `<div class="shared-contact-list">${cards.map((card) => `<article class="shared-contact-card" aria-label="Contato compartilhado"><header><span class="shared-contact-avatar" aria-hidden="true">👤</span><div><small>Contato compartilhado</small><strong>${escapeHtml(card.name)}</strong>${card.company ? `<span class="shared-contact-company">${escapeHtml(card.company)}</span>` : ""}</div></header><div class="shared-contact-details">${card.phones.length ? card.phones.map((phone) => `<div class="shared-contact-phone"><small>${escapeHtml(phone.label)}</small>${phone.dial ? `<a href="tel:${phone.dial}" aria-label="Ligar para ${escapeHtml(phone.number)}">${escapeHtml(phone.number)}</a>` : `<span>${escapeHtml(phone.number)}</span>`}</div>`).join("") : '<span class="shared-contact-empty">Sem telefone informado</span>'}${card.emails.map((email) => `<span class="shared-contact-email">${escapeHtml(email)}</span>`).join("")}</div></article>`).join("")}</div>`;
}

function messageContent(message) {
  if (message.type === "unsupported") return '<p><strong>Mensagem não suportada</strong><br>O canal não disponibilizou o conteúdo desta mensagem para a Central. Peça ao cliente que reenvie como foto comum, PDF ou texto.</p>';
  if (message.type === "contacts") return sharedContactsContent(message);
  const mediaUrl = `/api/messages/${encodeURIComponent(message.id)}/media`;
  if (message.type === "image" && message.mediaStorageKey) {
    return `<a class="message-image-link" href="${mediaUrl}" target="_blank" rel="noopener"><img class="message-image" src="${mediaUrl}" alt="${escapeHtml(message.text || "Imagem da conversa")}" loading="lazy"></a>${message.text && message.text !== "[image]" ? `<p>${renderWhatsAppText(message.text)}</p>` : ""}`;
  }
  if (message.type === "audio" && message.mediaStorageKey) {
    // Player próprio (play/pause, progresso, duração) — controlado por
    // delegação em #messages (ver bloco "Player de áudio nas mensagens").
    const durationMs = Number(message.mediaDurationMs) || 0;
    return `<div class="audio-player" data-audio-player data-duration-ms="${durationMs}"><button type="button" class="audio-play" data-audio-play aria-label="Reproduzir áudio">▶</button><input type="range" class="audio-progress" data-audio-progress min="0" max="1000" step="1" value="0" aria-label="Progresso do áudio"><span class="audio-time" data-audio-time>${durationMs ? formatAudioDuration(durationMs) : "--:--"}</span>${window.ChatFeatures?.audioSpeedButton() || ""}<audio preload="metadata" data-audio-element><source src="${mediaUrl}" type="${escapeHtml(message.mediaMimeType || "audio/ogg")}"></audio></div><a class="audio-download" href="${mediaUrl}" download>Baixar áudio</a>`;
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

// Segmento privado (ex.: Financeiro) que o usuário não pode ler: o backend
// já entrega só este marcador — sem texto, autor, mídia ou contagem.
function restrictedSegmentMarkup(message) {
  return `<div class="restricted-segment" role="note" data-message-id="${escapeHtml(message.id)}"><strong>🔒 Atendimento ${escapeHtml(message.categoryName || "restrito")}</strong><span>Histórico restrito a este setor.</span></div>`;
}

function messageRowMarkup(message) {
  if (message.restricted) return restrictedSegmentMarkup(message);
  const [symbol, label, statusClass] = deliveryStatus(message.status);
  const extra = window.ChatFeatures?.rowParts(message) || { top: "", footer: "", reactions: "", actions: "" };
  // Reação antiga (só em rawPayload) segue visível enquanto não houver registro novo do cliente.
  const legacyReaction = message.reactionEmoji && !message.reactions?.some((reaction) => reaction.side === "CUSTOMER") ? message.reactionEmoji : "";
  return `<div class="message-row ${message.direction === "ENVIADA" ? "sent" : "received"}" data-message-id="${escapeHtml(message.id)}"><div class="bubble ${["image", "audio", "video", "sticker", "document"].includes(message.type) ? `${message.type}-bubble` : ""} ${legacyReaction ? "has-reaction" : ""}">${extra.top}${messageContent(message)}<footer>${message.sentByUser ? `<span class="author">${escapeHtml(message.sentByUser.name)}</span>` : message.rawPayload?.system === "after_hours_reminder" ? `<span class="author automation-author" title="Mensagem automática — não foi enviada por um atendente">Automação — Fora do expediente</span>` : ""}${extra.footer}<span>${time(message.occurredAt)}</span>${message.direction === "ENVIADA" ? `<span class="delivery-status ${statusClass}" title="${label}" aria-label="${label}">${symbol}</span>` : ""}</footer>${legacyReaction ? `<span class="message-reaction" title="Reação do cliente">${escapeHtml(legacyReaction)}</span>` : ""}${extra.reactions}${moderationActionsMarkup(message)}</div>${extra.actions}</div>`;
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
  const messages = state.sharedContentMessages || state.selectedMessages || [];
  const media = messages.filter((message) => ["image", "video"].includes(message.type) && message.mediaStorageKey);
  const documents = messages.filter((message) => message.type === "document" && message.mediaStorageKey);
  const links = externalLinks(messages);
  $("#media-files-count").textContent = media.length;
  $("#document-files-count").textContent = documents.length;
  $("#link-files-count").textContent = links.length;
  document.querySelectorAll("[data-files-tab]").forEach((button) => button.classList.toggle("active", button.dataset.filesTab === tab));

  // Keep the CRM form alive on message/status updates. Never reload a draft
  // because the customer sent a message while the operator fills the form.
  if(tab==='crm'){
    window.CrmContext?.importInto($('#contact-files-content'),state.selectedId);
    return;
  }
  delete $('#contact-files-content').dataset.crmImport;
  $('#contact-files-content').style.overflow='';$('#contact-files-content').style.padding='';

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

let sharedContentRead=null;
function loadSharedContent(){
  const id=state.selectedId,scope=timelinePage.scope,epoch=workspace.epoch;
  if(!id)return Promise.resolve();
  const key=JSON.stringify([id,scope,epoch]);if(sharedContentRead?.key===key)return sharedContentRead.promise;
  const promise=api(`/api/conversations/${id}?sharedContent=true`).then(full=>{if(state.selectedId!==id||timelinePage.scope!==scope||workspace.epoch!==epoch)return;state.sharedContentMessages=full.messages;renderFilesTabSummary();if($('#contact-files-dialog').open)renderContactFiles(state.contactFilesTab);}).finally(()=>{if(sharedContentRead?.key===key)sharedContentRead=null;});
  sharedContentRead={key,promise};return promise;
}
async function openContactFiles() {
  if (!state.selectedId) return;
  $("#contact-files-title").textContent = state.selectedContactName || "Arquivos da conversa";
  $("#contact-files-conversation-id").textContent = state.selectedId;
  const profilePhone = state.selectedContactPhone || '';
  $('#contact-files-dialog').dataset.copyName = state.selectedContactName || '';
  $('#contact-files-dialog').dataset.copyPhone = profilePhone;
  $('#contact-files-phone').textContent = profilePhone ? `+${profilePhone.replace(/^\+/, '')}` : '';
  $('#contact-files-phone').hidden = !profilePhone;
  $('#copy-contact-phone').hidden = !profilePhone;
  $('#copy-contact-name').hidden = !state.selectedContactName;
  $("#analyze-conversation-learning").hidden = !state.currentUser?.isMaster;
  $('#contact-files-dialog').showModal();
  $('#contact-files-content').textContent='Carregando conteúdo compartilhado…';
  const id=state.selectedId;
  try{state.contactFilesTab='media';await loadSharedContent();}
  catch(error){if(state.selectedId===id)$('#contact-files-content').textContent=error.message;}
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
    ["Como vejo somente as minhas conversas?", "Selecione Minhas na lateral. Esse filtro mostra as conversas em que você é o responsável atual, respeitando a empresa, os canais e os demais filtros selecionados. Atendente fixo é um vínculo diferente do responsável da conversa."],
    ["Como alterno entre Mibro e Sincrofit?", "Selecione a empresa no topo antes de procurar uma conversa ou iniciar um envio. Os contatos, números e categorias exibidos respeitam os acessos da sua conta. Ter acesso a uma empresa não libera automaticamente a outra."],
    ["Como inicio uma conversa com template?", "Clique em + Nova, confira a empresa e o número de atendimento e escolha um template aprovado. Você pode selecionar o contato e o template em qualquer ordem; procure o contato pelo nome ou telefone, confira nome e número e preencha as variáveis obrigatórias. Revise a prévia e clique em Enviar pelo WhatsApp. Se o botão estiver desabilitado, confira a indicação do que falta."],
    ["O que conferir antes de enviar um template?", "Confira o remetente, o destinatário e os campos do template. Campos automáticos acompanham o contato; textos que você editar manualmente são preservados. Ao trocar o número de atendimento, selecione novamente um template disponível para esse número. Envio individual e campanhas dependem das permissões da sua conta."],
    ["Como sei se uma mensagem foi entregue?", "Consulte o indicador de status na mensagem. Enviada, entregue, lida e falha são situações diferentes; aceitar o envio não comprova entrega. A atualização depende dos retornos do canal. Se houver erro, confira o aviso antes de tentar novamente para evitar duplicação."],
    ["Como funciona o atendente fixo?", "Nos detalhes do cliente, confira Atendente fixo e Responsável. O primeiro orienta novos atendimentos daquele cliente na empresa; o segundo indica quem cuida da conversa atual. No Comercial — Atacado, clientes com vínculo fixo mantêm sua categoria no retorno. Mudanças de vínculo e transferências devem ser feitas pelas opções autorizadas da conversa."],
    ["Como arquivo uma conversa sem perder o histórico?", "Nos detalhes do cliente, em Organizar conversa, clique em Arquivar conversa e confirme. Ela sai das listas de atendimento, inclusive Todos. Mensagens, anexos e cadastro continuam preservados. Novas mensagens não recuperam a conversa automaticamente."],
    ["Onde encontro e recupero uma conversa arquivada?", "Abra Configurações e a aba Arquivados, ou use Ver arquivados nos detalhes. Localize o cliente, abra a conversa e use Recuperar conversa nos detalhes para devolvê-la às listas. A consulta e a recuperação continuam respeitando seus acessos."],
    ["Como consulto ou cadastro o cliente no CRM?", "Abra a aba CRM no contexto da conversa ou Dados e CRM no perfil do cliente. Se houver um vínculo acessível, consulte a ficha comercial; caso contrário, revise os dados preenchidos e use a opção de cadastro no CRM. É necessário acesso aos dois sistemas. Cadastrar ou abrir a ficha não envia mensagem nem troca o responsável do atendimento."],
    ["Como envio uma proposta pelo WhatsApp?", "Na proposta do CRM, use Enviar pelo Atendimento e revise o resumo na conversa indicada antes de enviar. Esse resumo não é o PDF. Para compartilhar o arquivo, baixe o PDF no CRM e anexe-o à conversa. Confira sempre empresa, número, cliente, permissões e janela do WhatsApp; preparar o envio não dispara mensagem automaticamente."],
    ["Como copio o nome e o número do cliente?", "Abra o perfil do cliente pelo cabeçalho da conversa e use Copiar nome ou Copiar número. O botão do número aparece quando existe um telefone informado."],
    ["Onde vejo os retornos e compromissos dos dois sistemas?", "Abra Atividades no topo e selecione a empresa. A tela reúne os itens acessíveis do CRM e os retornos do Atendimento. Concluir ou reagendar atualiza o registro de origem; abrir a tela não envia mensagens."],
    ["Como funcionam os horários e o SLA?", "Os avisos automáticos dependem dos bots e horários configurados para a empresa. Fora do expediente, o SLA de resposta considera apenas o tempo útil do calendário configurado. O aviso de fechamento não significa que um atendente está disponível naquele momento."],
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
      ["Como vejo conversas dos Atendentes?", "Abra Minha equipe e selecione um atendente vinculado pelo Master. Atuais mostra as conversas atribuídas; Histórico inclui transferidas e finalizadas. Você lê somente os trechos atendidos pela sua equipe, sem responder ou alterar por esse acesso."],
      ["Posso alterar prioridades?", "Sim, nas conversas em que você pode atuar. Conversas abertas somente por supervisão permanecem em leitura."],
      ["Posso alterar configurações?", "Configurações de Conversas ficam disponíveis apenas para consulta. Alterações administrativas são feitas pelo Master."],
    ],
    ADMIN: [
      ["Como libero um novo usuário?", "Em Equipe, defina o perfil, as permissões, cada categoria/subcategoria e depois libere também os números ou contas de canal necessários."],
      ["Como vejo todo o histórico de um atendente?", "Em Equipes, escolha Todos os atendentes, selecione a pessoa e abra Histórico. O botão Ver atendimentos no cadastro também abre essa consulta, incluindo conversas transferidas e finalizadas."],
      ["Quando usar Somente Master?", "Use apenas para categorias realmente restritas. Elas não aparecem nem aceitam transferências feitas por Atendentes ou Supervisores."],
      ["Onde verifico alterações importantes?", "Use a Auditoria geral para consultar mudanças em usuários, conversas, categorias, Bots e configurações."],
    ],
  };
  const permissions = [
    ["Alterar responsável", user.canTransferConversations],
    ["Acompanhar equipe", user.canViewTeamActivity],
    ["Visualizar histórico", user.canViewConversationHistory],
    ["Ver mensagens anteriores", user.canViewPreviousMessages],
    ["Iniciar por e-mail", user.canStartEmailConversations],
    ["Iniciar por WhatsApp", user.canStartWhatsAppConversations],
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
  window.ChatFeatures?.init();
  state.centralResume = window.CentralSessionState?.init(status.user.id);
  state.companies = status.companyAccess?.companies || [];
  for (const key of ["canManageCampaigns", "canStartEmailConversations", "canStartWhatsAppConversations"]) {
    status.user[key] = status.user.isMaster || state.companies.some(company => company.permissions?.[key]);
  }
  status.user.canStartConversations = status.user.canStartEmailConversations || status.user.canStartWhatsAppConversations;
  // Workspace salvo no servidor (sempre uma empresa acessível); sem ele, a
  // primeira empresa autorizada. Nunca "Todas".
  const preferred = status.companyAccess?.preference;
  state.companyFilter = state.companies.some((company) => company.slug === preferred) ? preferred : state.companies[0]?.slug || "";
  if(state.centralResume&&state.companies.some(company=>company.slug===state.centralResume.company)){
    state.companyFilter=state.centralResume.company;
    workspace.saved=state.centralResume.filters||{};
  }
  restoreWorkspaceFilters(state.companyFilter);
  renderCompanyFilter();
  $("#current-user").textContent = status.user.name;
  $("#bots-button").hidden = !status.user.isMaster;
  $("#quick-replies-admin-button").hidden = !status.user.isMaster;
  $("#templates-library-button").hidden = !status.user.canManageCampaigns;
  $("#integrations-button").hidden = !status.user.isMaster;
  $("#campaigns-button").hidden = !status.user.canManageCampaigns;
  // Central de Operação: Master ou Supervisor em alguma empresa (backend revalida).

  $("#new-conversation").hidden = !(status.user.canStartConversations || status.user.canManageCampaigns);
  // Produtividade: Master, Supervisor ou Atendente liberado (backend revalida).
  // Agenda: todo usuário tem a própria (escopo aplicado nas APIs).
  window.FollowUpsUI?.init(status.user);
  $("#metrics-button").hidden = !status.user.isMaster && !status.user.canOpenProductivity && !state.companies.some(company => company.role === "SUPERVISOR");
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
  const cursorKey = `mibro-alert-cursor:${status.user.id}:all-workspaces`;
  let storedCursor = null;
  try { storedCursor = localStorage.getItem(cursorKey); } catch {}
  state.alertCursor = storedCursor && !Number.isNaN(new Date(storedCursor).getTime()) ? storedCursor : new Date().toISOString();
  try { localStorage.setItem(cursorKey, state.alertCursor); } catch {}
}

// ---------------------------------------------------------------------------
// Workspaces (áreas de trabalho por empresa): MIBRO | SINCROFIT.
// - Sempre UMA empresa ativa; não existe "Todas" (o backend também recusa a
//   visão misturada — ver company-service#resolveWorkspace).
// - Trocar de empresa não recarrega a página: guarda filtros/posição/conversa
//   do workspace atual, restaura os do novo e descarta respostas atrasadas do
//   anterior (workspace.epoch).
// - Aba da outra empresa: contador de mensagens recebidas não lidas (estado
//   real de leitura, vindo do banco) e pulsação só quando chega novidade
//   depois da última visita (nunca por histórico). Nunca troca sozinha.
// Cores: company.primaryColor (Mibro #FF6633, Sincrofit #24A8B4).
// ---------------------------------------------------------------------------
const workspace = {
  epoch: 0,
  saved: {},         // slug -> filtros/posição da lista/conversa aberta
  unread: new Map(), // companyId -> { unreadMessages, unreadConversations, latestUnreadId }
  seen: {},          // companyId -> latestUnreadId já visto (não pulsa)
  sound: {},         // companyId -> som ao chegar mensagem com a aba fechada
  accounts: [],      // números de WhatsApp (conexão por empresa)
  // Chat interno (indicador separado do WhatsApp): companyId -> { unreadMessages, latestUnreadId }
  internal: new Map(),
  internalSeen: null, // companyId -> latestUnreadId interno já visto
  unreadRunning: false, unreadQueued: false, unreadTimer: null,
};
const WORKSPACE_FILTER_KEYS = ["search", "category", "channel", "status", "slaBreached", "unassigned", "preferredAssignee", "assignedUser", "assignedUserActiveOnly", "emailMailbox"];
const WORKSPACE_FILTER_DEFAULTS = Object.freeze({ search: "", category: "", channel: "", status: "", slaBreached: false, unassigned: false, preferredAssignee: "", assignedUser: "", assignedUserActiveOnly: false, emailMailbox: "GENERAL" });
const workspaceStorageKey = (suffix) => `mibro-workspace-${suffix}:${state.currentUser?.id || "anon"}`;
function readWorkspaceStore(suffix, fallback) {
  try { const raw = localStorage.getItem(workspaceStorageKey(suffix)); return raw ? JSON.parse(raw) || fallback : fallback; } catch { return fallback; }
}
function writeWorkspaceStore(suffix, value) {
  try { localStorage.setItem(workspaceStorageKey(suffix), JSON.stringify(value)); } catch {}
}

function saveWorkspaceFilters(slug = state.companyFilter) {
  if (!slug) return;
  workspace.saved[slug] = {
    ...Object.fromEntries(WORKSPACE_FILTER_KEYS.map((key) => [key, state[key]])),
    statusToggle: [...state.statusToggle], priorityToggle: [...state.priorityToggle],
    selectedId: state.selectedId || null, scrollTop: $("#conversation-list")?.scrollTop || 0,
  };
  // Só filtros vão para o navegador; conversa aberta/posição ficam na sessão.
  const persisted = Object.fromEntries(Object.entries(workspace.saved).map(([key, value]) => [key, { ...value, selectedId: null, scrollTop: 0 }]));
  writeWorkspaceStore("filters", persisted);
}

function restoreWorkspaceFilters(slug) {
  if (!Object.keys(workspace.saved).length) workspace.saved = readWorkspaceStore("filters", {});
  if (!Object.keys(workspace.seen).length) workspace.seen = readWorkspaceStore("seen", {});
  if (!Object.keys(workspace.sound).length) workspace.sound = readWorkspaceStore("sound", {});
  const saved = workspace.saved[slug] || {};
  for (const key of WORKSPACE_FILTER_KEYS) state[key] = saved[key] ?? WORKSPACE_FILTER_DEFAULTS[key];
  // Categoria salva de outra empresa (ou removida) nunca é reaplicada.
  if (state.category && !["null", "UNCATEGORIZED"].includes(state.category) && state.categories.length
    && !state.categories.some((category) => (category.code === state.category || category.id === state.category) && category.company?.slug === slug)) state.category = "";
  state.statusToggle = new Set(saved.statusToggle || []);
  state.priorityToggle = new Set(saved.priorityToggle || []);
  return saved;
}

// Controles visuais dos filtros acompanham o estado restaurado.
function syncWorkspaceFilterControls() {
  if ($("#search")) $("#search").value = state.search || "";
  if ($("#preferred-assignee-filter")) $("#preferred-assignee-filter").value = state.preferredAssignee || "";
  document.querySelectorAll("[data-toggle-filter]").forEach((button) => {
    const [kind, value] = button.dataset.toggleFilter.split(":");
    const active = kind === "slaBreached" ? state.slaBreached : kind === "unassigned" ? state.unassigned
      : (kind === "status" ? state.statusToggle : state.priorityToggle).has(value);
    button.classList.toggle("active", Boolean(active));
  });
  document.querySelectorAll("[data-email-mailbox]").forEach((item) => item.classList.toggle("active", item.dataset.emailMailbox === state.emailMailbox));
  $("#clear-team-filter").hidden = !state.assignedUser;
}

function workspaceHasNews(companyId) {
  const item = workspace.unread.get(companyId);
  return Boolean(item?.unreadMessages > 0 && item.latestUnreadId && item.latestUnreadId !== workspace.seen[companyId]);
}

function internalSeenStore() {
  if (!workspace.internalSeen) workspace.internalSeen = readWorkspaceStore("internal-seen", {});
  return workspace.internalSeen;
}
function workspaceHasInternalNews(companyId) {
  const item = workspace.internal.get(companyId);
  return Boolean(item?.unreadMessages > 0 && item.latestUnreadId && item.latestUnreadId !== internalSeenStore()[companyId]);
}
// Visitar a empresa só para de pulsar — nunca marca mensagem como lida.
function markInternalSeen(companyId) {
  const item = workspace.internal.get(companyId);
  const seen = internalSeenStore();
  if (!companyId || !item || seen[companyId] === (item.latestUnreadId || null)) return;
  seen[companyId] = item.latestUnreadId || null;
  writeWorkspaceStore("internal-seen", seen);
}

function markWorkspaceSeen(companyId) {
  markInternalSeen(companyId);
  const item = workspace.unread.get(companyId);
  if (!companyId || !item || workspace.seen[companyId] === (item.latestUnreadId || null)) return;
  workspace.seen[companyId] = item.latestUnreadId || null;
  writeWorkspaceStore("seen", workspace.seen);
}

function workspaceConnection(companyId) {
  const accounts = workspace.accounts.filter((account) => account.companyId === companyId);
  if (!accounts.length) return { state: "none", label: "Nenhum número de WhatsApp cadastrado" };
  const down = accounts.filter((account) => account.enabled === false || (account.status && account.status !== "CONNECTED"));
  if (down.length === accounts.length) return { state: "down", label: "WhatsApp desconectado" };
  if (down.length) return { state: "partial", label: `${down.length} de ${accounts.length} números desconectados` };
  return { state: "ok", label: accounts.length > 1 ? `${accounts.length} números conectados` : "WhatsApp conectado" };
}

// Abas no cabeçalho (desktop) e no topo da lista (celular). Com uma empresa
// só, fica apenas a identificação (sem abas).
function renderCompanyFilter() {
  const containers = [$("#workspace-switcher"), $("#company-filter-mobile")].filter(Boolean);
  const current = activeCompany();
  document.documentElement.style.setProperty("--workspace-color", companyColor(current) || "");
  document.body.dataset.workspace = current?.slug || "";
  renderWorkspaceHeading();
  if (!containers.length) return;
  const tabs = (multiCompany() ? state.companies : []).map((company) => {
    const active = company.slug === state.companyFilter;
    const unread = workspace.unread.get(company.id);
    const count = unread?.unreadMessages || 0;
    const internalCount = workspace.internal.get(company.id)?.unreadMessages || 0;
    const news = !active && (workspaceHasNews(company.id) || workspaceHasInternalNews(company.id));
    const connection = workspaceConnection(company.id);
    const label = `${company.name}${count ? ` — ${count} mensage${count === 1 ? "m" : "ns"} não lida${count === 1 ? "" : "s"} em ${unread.unreadConversations} conversa${unread.unreadConversations === 1 ? "" : "s"}` : ""}${internalCount ? ` — chat interno: ${internalCount} não lida${internalCount === 1 ? "" : "s"}` : ""} · ${connection.label}`;
    return `<button type="button" role="tab" class="workspace-tab${active ? " active" : ""}${news ? " has-news" : ""}${count ? " has-unread" : ""}" data-company-filter="${escapeHtml(company.slug)}" aria-selected="${active}" tabindex="${active ? 0 : -1}"${companyStyleAttr(company)} title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
      <i class="company-dot" aria-hidden="true"></i><span class="workspace-tab-name">${escapeHtml(company.displayName)}</span>${count ? `<span class="workspace-tab-count" aria-hidden="true">${count > 99 ? "99+" : count}</span>` : ""}${internalCount ? `<span class="workspace-tab-internal" aria-hidden="true">💬${internalCount > 99 ? "99+" : internalCount}</span>` : ""}<i class="workspace-tab-status" data-state="${connection.state}" aria-hidden="true"></i>
    </button>`;
  }).join("");
  const sound = state.companies.length ? `<details class="workspace-sound"><summary title="Som de novos atendimentos e mensagens" aria-label="Som de notificação por empresa">🔔</summary><div class="workspace-sound-menu" role="group" aria-label="Som por empresa">${state.companies.map((company) => `<label${companyStyleAttr(company)}><input type="checkbox" data-workspace-sound="${escapeHtml(company.id)}" ${workspace.sound[company.id] ? "checked" : ""}><i class="company-dot" aria-hidden="true"></i>Som — ${escapeHtml(company.displayName)}</label>`).join("")}<small>Toca quando chega uma mensagem ou um atendimento na sua caixa.</small></div></details>` : "";
  containers.forEach((container) => {
    const keepSoundOpen = container.querySelector(".workspace-sound")?.open;
    const content = tabs + (container.id === "workspace-switcher" ? sound : "");
    container.hidden = !content;
    if (tabs) {
      container.setAttribute("role", "tablist");
      container.setAttribute("aria-label", "Área de trabalho (empresa)");
    } else {
      container.removeAttribute("role");
      container.removeAttribute("aria-label");
    }
    container.innerHTML = content;
    if (keepSoundOpen) container.querySelector(".workspace-sound")?.setAttribute("open", "");
  });
}

// "Conversas — MIBRO" no topo da lista + título da aba do navegador.
function renderWorkspaceHeading() {
  const current = activeCompany();
  const label = $("#workspace-company-label");
  if (label) {
    label.hidden = !current;
    label.textContent = current ? current.displayName : "";
    label.style.setProperty("--company-color", companyColor(current) || "");
  }
  if (current && multiCompany()) document.title = `${current.displayName} · ${defaultDocumentTitle}`;
}

let workspaceAudioContext = null;
let inboxAlertBuffer = null;
let inboxAlertPlaying = false;
const inboxAlertGain = 1.2;

function loadInboxAlertSound() {
  inboxAlertBuffer ||= fetch("/assets/inbox-notification.mp3")
    .then((response) => {
      if (!response.ok) throw new Error("Toque de alerta indisponível.");
      return response.arrayBuffer();
    })
    .then((bytes) => workspaceAudioContext.decodeAudioData(bytes))
    .catch(() => { inboxAlertBuffer = null; return null; });
  return inboxAlertBuffer;
}

async function unlockWorkspaceAudio() {
  try {
    workspaceAudioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (workspaceAudioContext.state !== "running") await workspaceAudioContext.resume();
    void loadInboxAlertSound();
  } catch {}
}

document.addEventListener("click", () => {
  if (Object.values(workspace.sound).some(Boolean)) void unlockWorkspaceAudio();
}, { once: true });

async function playInboxAlertSound(companyId) {
  if (!workspace.sound[companyId] || workspaceAudioContext?.state !== "running" || inboxAlertPlaying) return;
  try {
    const buffer = await loadInboxAlertSound();
    if (!buffer || !workspace.sound[companyId] || workspaceAudioContext.state !== "running" || inboxAlertPlaying) return;
    const source = workspaceAudioContext.createBufferSource();
    const gain = workspaceAudioContext.createGain();
    source.buffer = buffer;
    gain.gain.value = inboxAlertGain;
    source.connect(gain).connect(workspaceAudioContext.destination);
    source.onended = () => { inboxAlertPlaying = false; gain.disconnect(); };
    source.start();
    inboxAlertPlaying = true;
  } catch {}
}

function playWorkspaceSound(companyId) {
  if (!workspace.sound[companyId] || workspaceAudioContext?.state !== "running") return;
  try {
    const now = workspaceAudioContext.currentTime;
    for (const [offset, frequency] of [[0, 880], [0.16, 1175]]) {
      const oscillator = workspaceAudioContext.createOscillator();
      const gain = workspaceAudioContext.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.06, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.14);
      oscillator.connect(gain).connect(workspaceAudioContext.destination);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.15);
    }
  } catch {}
}

// Contadores das abas. Fonte única: /api/workspaces/unread (estado real de
// leitura no banco). Chamado no carregamento, a cada aviso do SSE, ao
// reconectar e periodicamente — nunca soma eventos no navegador, então a
// mesma mensagem não conta duas vezes nem uma enviada vira "recebida".
async function refreshWorkspaceUnread() {
  if (!multiCompany()) return;
  if (workspace.unreadRunning) { workspace.unreadQueued = true; return; }
  workspace.unreadRunning = true;
  try {
    const data = await api("/api/workspaces/unread");
    let seenChanged = false;
    for (const item of data.workspaces || []) {
      workspace.unread.set(item.companyId, item);
      // Primeira leitura sem marcador salvo: o que já existia é histórico.
      if (!(item.companyId in workspace.seen)) { workspace.seen[item.companyId] = item.latestUnreadId || null; seenChanged = true; }
      const active = activeCompany()?.id === item.companyId;
      if (active && !document.hidden && workspace.seen[item.companyId] !== (item.latestUnreadId || null)) {
        workspace.seen[item.companyId] = item.latestUnreadId || null;
        seenChanged = true;
      }
    }
    if (seenChanged) writeWorkspaceStore("seen", workspace.seen);
    renderCompanyFilter();
  } catch {} finally {
    workspace.unreadRunning = false;
    if (workspace.unreadQueued) { workspace.unreadQueued = false; refreshWorkspaceUnread(); }
  }
}
function scheduleWorkspaceUnread(delay = 250) {
  clearTimeout(workspace.unreadTimer);
  workspace.unreadTimer = setTimeout(refreshWorkspaceUnread, delay);
}

async function loadWorkspaceAccounts() {
  if (!multiCompany()) return;
  try { workspace.accounts = await api("/api/whatsapp-accounts"); } catch { workspace.accounts = []; }
  renderCompanyFilter();
}

async function setCompanyFilter(slug, { openConversationId = null } = {}) {
  const target = state.companies.find((company) => company.slug === slug);
  if (!target || slug === state.companyFilter) {
    if (target && openConversationId) await openConversation(openConversationId);
    return;
  }
  saveWorkspaceFilters();
  const epoch = ++workspace.epoch;
  closeConversationView();
  state.companyFilter = slug;
  // Chat interno e demais módulos da tela acompanham o MESMO workspace.
  document.dispatchEvent(new CustomEvent("central:workspace-changed", { detail: { company: target } }));
  const saved = restoreWorkspaceFilters(slug);
  syncWorkspaceFilterControls();
  markWorkspaceSeen(target.id);
  state.categorySignature = "";
  state.listSignature = "";
  state.conversations = [];
  renderCompanyFilter();
  const list = $("#conversation-list");
  if (list) list.innerHTML = `<div class="empty-list workspace-loading" role="status">Carregando conversas — ${escapeHtml(target.displayName)}…</div>`;
  document.body.classList.remove("workspace-switched");
  void document.body.offsetWidth;
  document.body.classList.add("workspace-switched");
  $("#workspace-announcer").textContent = `Área de trabalho: ${target.name}`;
  api("/api/companies/preference", { method: "PUT", body: JSON.stringify({ company: slug }) }).catch(() => {});
  try {
    await loadCategories();
    if (epoch !== workspace.epoch) return;
    await loadConversations();
    if (epoch !== workspace.epoch) return;
  } catch (error) {
    if (epoch !== workspace.epoch) return;
    if (list) list.innerHTML = `<div class="empty-list">Não foi possível carregar as conversas de ${escapeHtml(target.displayName)}. ${escapeHtml(error.message || "")}</div>`;
    throw error;
  }
  if (list) list.scrollTop = saved.scrollTop || 0;
  const reopen = openConversationId || saved.selectedId;
  if (reopen) await openConversation(reopen, { refreshList: false }).catch(() => {});
  scheduleWorkspaceUnread(0);
  checkAlerts().catch(() => {});
}

// Contexto de empresa compartilhado com o chat interno (internal-chat.js):
// sem segundo seletor — o chat lê o workspace ativo e pede a troca por aqui.
window.CentralWorkspace = {
  current: () => activeCompany() || null,
  companies: () => state.companies.slice(),
  switchTo: (slug) => setCompanyFilter(slug),
  // Não lidas do chat interno por empresa (fonte: /api/internal-chats/unread).
  // Devolve as empresas inativas que receberam mensagem nova agora.
  setInternalUnread(items = []) {
    const seen = internalSeenStore();
    const arrived = [];
    let seenChanged = false;
    for (const item of items) {
      const before = workspace.internal.get(item.companyId);
      workspace.internal.set(item.companyId, item);
      if (!(item.companyId in seen)) { seen[item.companyId] = item.latestUnreadId || null; seenChanged = true; }
      const active = activeCompany()?.id === item.companyId;
      if (active && !document.hidden && seen[item.companyId] !== (item.latestUnreadId || null)) { seen[item.companyId] = item.latestUnreadId || null; seenChanged = true; }
      if (before && !active && item.unreadMessages > 0 && item.latestUnreadId && item.latestUnreadId !== before.latestUnreadId) {
        arrived.push(item.companyId);
        playWorkspaceSound(item.companyId);
      }
    }
    if (seenChanged) writeWorkspaceStore("internal-seen", seen);
    renderCompanyFilter();
    return arrived;
  },
};

$("#category-company")?.addEventListener("change", renderCategoryParentOptions);
for (const container of [$("#workspace-switcher"), $("#company-filter-mobile")]) {
  container?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-company-filter]");
    if (button) setCompanyFilter(button.dataset.companyFilter).catch((error) => toast(error.message, true));
  });
  container?.addEventListener("change", (event) => {
    const input = event.target.closest("[data-workspace-sound]");
    if (!input) return;
    workspace.sound[input.dataset.workspaceSound] = input.checked;
    writeWorkspaceStore("sound", workspace.sound);
    if (input.checked) {
      void unlockWorkspaceAudio().then(() => playInboxAlertSound(input.dataset.workspaceSound));
    }
  });
  // Setas ←/→ entre as abas (padrão de tablist).
  container?.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key) || !event.target.closest(".workspace-tab")) return;
    const tabs = [...container.querySelectorAll(".workspace-tab")];
    const index = tabs.indexOf(event.target.closest(".workspace-tab"));
    const next = tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    next?.focus();
    event.preventDefault();
  });
}
document.addEventListener("click", (event) => {
  document.querySelectorAll(".workspace-sound[open]").forEach((menu) => { if (!menu.contains(event.target)) menu.removeAttribute("open"); });
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  markWorkspaceSeen(activeCompany()?.id);
  scheduleWorkspaceUnread(0);
});

// Responsável: só quem tem acesso à empresa da conversa (o backend também
// valida). Mantém o responsável atual mesmo que ele tenha perdido acesso.
function renderAssigneeOptions(companyId, currentAssigneeId) {
  const eligible = state.users.filter((user) => !companyId || !user.companyIds || user.companyIds.includes(companyId) || user.id === currentAssigneeId);
  $("#assignee-select").innerHTML = `<option value="">Sem responsável</option>` + eligible.map((user) => `<option value="${user.id}">${escapeHtml(user.name)}</option>`).join("");
}

async function loadUsers() {
  state.users = await api("/api/users");
  renderPreferredAssigneeFilter();
  $("#assignee-select").innerHTML = `<option value="">Sem responsável</option>` + state.users.map((user) => `<option value="${user.id}">${escapeHtml(user.name)}</option>`).join("");
}

async function api(path, options) {
  const headers = new Headers(options?.headers || {});
  if (options?.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(error => { if (error.name === "AbortError") throw error; return {}; });
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
  const unavailable = state.customerServiceWindow?.state === "SENDER_UNAVAILABLE";
  const notStarted = state.customerServiceWindow?.state === "NOT_STARTED";
  const awaitingReply = state.customerServiceWindow?.state === "AWAITING_REPLY";
  const numberChanged = Boolean(state.customerServiceWindow?.numberChanged);
  const senderName = state.customerServiceWindow?.senderName || "número selecionado";
  $("#service-window-notice").hidden = !closed;
  $("#service-window-title").textContent = unavailable ? "Número de envio indisponível" : awaitingReply ? `Aguardando resposta — ${senderName}` : numberChanged ? `Número de envio alterado — ${senderName}` : notStarted ? `Iniciar conversa — ${senderName}` : `Janela de 24 horas encerrada — ${senderName}`;
  $("#service-window-description").textContent = unavailable
    ? (state.currentUser?.role === "ADMIN" ? "Confira a conexão do número e os Acessos deste setor nas Integrações. O Master tem acesso completo, mas precisa de um número conectado para enviar." : "Peça ao Master para conferir os Acessos e a configuração deste setor.")
    : awaitingReply ? "Um template já foi enviado neste número. Aguarde a resposta do cliente para liberar o envio normal por 24 horas."
    : `${numberChanged ? "Este setor usa outro número de WhatsApp. A mensagem do cliente no número anterior não libera o envio por este número. " : ""}${notStarted ? "Ainda não há mensagem recebida do cliente neste número. A transferência não abre a janela." : "A última mensagem do cliente neste número passou de 24 horas."} ${canUseTemplates ? "Envie um template aprovado; a resposta do cliente libera o envio normal por 24 horas." : "Peça a alguém com permissão de templates para iniciar o contato."}`;
  $("#open-required-template").hidden = !canUseTemplates || unavailable;
  $("#open-templates").hidden ||= unavailable;
  renderPinnedTransferTemplates();
  $("#composer").classList.toggle("window-closed", closed);
  $("#message-input").disabled = closed;
  $("#attachment-input").disabled = closed;
  $("#open-attachments").disabled = closed;
  if (closed) closeAttachmentMenu();
  $("#send-button").disabled = closed || composerSendGuard.isSending();
  $("#message-input").placeholder = closed ? (canUseTemplates ? (numberChanged ? "Inicie o contato pelo novo número com um template aprovado" : notStarted ? "Use um template aprovado para iniciar o contato" : awaitingReply ? "Aguarde a resposta do cliente neste número" : "Use um template aprovado para retomar o contato") : "Envio indisponível") : "Digite uma mensagem...";
}

// Favoritos pessoais por usuário e número, sem misturar WABAs ou armazenar mensagens.
function templatePinsKey() {
  return `mibro-template-pins:${state.currentUser?.id || "anonymous"}:${state.customerServiceWindow?.senderAccountId || "legacy"}`;
}
function templatePins() {
  try {
    const pins = JSON.parse(localStorage.getItem(templatePinsKey()) || "[]");
    return Array.isArray(pins) ? pins.filter(p => typeof p?.name === "string" && typeof p?.language === "string").slice(0, 20) : [];
  } catch { return []; }
}
function templatePinMatches(pin, template) { return pin.name === template.name && pin.language === template.language; }
function renderPinnedTransferTemplates() {
  const target = $("#pinned-transfer-templates");
  const pins = state.currentUser?.canManageCampaigns && state.customerServiceWindow?.state !== "SENDER_UNAVAILABLE" ? templatePins() : [];
  // Roda a cada SSE/polling: só troca os botões quando algo mudou, para não
  // engolir um clique em andamento.
  const markup = pins.map((pin, index) => `<button type="button" class="pinned-template" data-pinned-template="${index}" title="Selecionar template fixado; o envio exige confirmação">📌 ${escapeHtml(pin.name)} (${escapeHtml(pin.language)})</button>`).join("");
  target.pins = pins;
  if (target.pinsMarkup !== markup) { target.pinsMarkup = markup; target.innerHTML = markup; }
}

function templateRateLabel(template) {
  const pricing = template?.pricing;
  if (!pricing || !Number.isFinite(Number(pricing.rate))) return "Tarifa indisponível";
  const amount = new Intl.NumberFormat("pt-BR", { style:"currency", currency:pricing.currency || "BRL", minimumFractionDigits:4 }).format(Number(pricing.rate));
  return `Tarifa base Brasil: ${amount} por mensagem entregue`;
}
$("#pinned-transfer-templates").addEventListener("click", (event) => {
  const button = event.target.closest("[data-pinned-template]");
  if (button) openTemplates(event.currentTarget.pins[Number(button.dataset.pinnedTemplate)]);
});

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
  $("#attachment-input").closest(".composer-attach").hidden = isComment && !canAttach;
  if (isComment && !canAttach) closeAttachmentMenu();
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
  $("#template-list").innerHTML = templates.length ? templates.map((template) => `<div class="template-card-row"><button class="template-card ${state.selectedTemplate?.id === template.id ? "selected" : ""}" type="button" data-template-id="${escapeHtml(template.id)}" ${template.supported ? "" : "disabled"} title="${escapeHtml(template.unsupportedReason || "Selecionar template")}"><strong>${escapeHtml(template.name)}</strong><span><b>${escapeHtml(template.language)}</b><b>${escapeHtml(template.category)}</b></span><small>${escapeHtml(template.unsupportedReason || template.preview || "Sem prévia")}</small><em class="template-rate">${escapeHtml(templateRateLabel(template))}</em></button><button type="button" class="template-pin" data-pin-template="${escapeHtml(template.id)}" aria-pressed="${templatePins().some(pin => templatePinMatches(pin, template))}" ${template.supported ? "" : "disabled"} title="Fixar por usuário e número neste navegador">${templatePins().some(pin => templatePinMatches(pin, template)) ? "Desafixar" : "📌 Fixar"}</button></div>`).join("") : `<div class="template-empty">Nenhum template aprovado encontrado.</div>`;
  document.querySelectorAll("[data-pin-template]").forEach(button => button.addEventListener("click", () => {
    const template = state.templates.find(item => item.id === button.dataset.pinTemplate);
    if (!template?.supported) return;
    const pins = templatePins();
    const present = pins.some(pin => templatePinMatches(pin, template));
    if (!present && pins.length >= 20) return toast("Limite de 20 templates fixados por número.", true);
    try {
      localStorage.setItem(templatePinsKey(), JSON.stringify(present ? pins.filter(pin => !templatePinMatches(pin, template)) : [...pins, { name: template.name, language: template.language }]));
      renderTemplateList();
      renderPinnedTransferTemplates();
    } catch { toast("Não foi possível salvar o favorito neste navegador.", true); }
  }));
  document.querySelectorAll("[data-template-id]").forEach((button) => button.addEventListener("click", () => {
    state.selectedTemplate = state.templates.find((template) => template.id === button.dataset.templateId) || null;
    renderTemplateList();
    renderTemplateEditor();
  }));
}

async function openTemplates(pinnedTemplate) {
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
  const conversationId = state.selectedId;
  const senderId = state.customerServiceWindow?.senderAccountId;
  try {
    const templates = await api(`/api/meta/templates?conversationId=${encodeURIComponent(conversationId)}`);
    if (state.selectedId !== conversationId || state.customerServiceWindow?.senderAccountId !== senderId) { $("#template-dialog").close(); return; }
    state.templates = templates;
    if (pinnedTemplate?.name) {
      state.selectedTemplate = templates.find(template => template.supported && templatePinMatches(pinnedTemplate, template)) || null;
      if (!state.selectedTemplate) toast("O template fixado não está mais disponível neste número.", true);
    }
    renderTemplateList();
    renderTemplateEditor();
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
  const company = companyQuery();
  const channels = await api(`/api/outbound/channels?company=${encodeURIComponent(company)}`);
  if (company !== companyQuery()) return;
  state.outboundChannels = channels;
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

let alertRefreshTimer;
let alertRefreshQueued = false;
function scheduleInboxAlerts() {
  if (alertRefreshTimer) return;
  alertRefreshTimer = setTimeout(() => {
    alertRefreshTimer = null;
    checkAlerts().catch(() => {});
  }, 160);
}

async function checkAlerts({ signal } = {}) {
  const userId = state.currentUser?.id;
  if (!userId || !state.alertCursor) return;
  if (state.checkingAlerts) { alertRefreshQueued = true; return; }
  state.checkingAlerts = true;
  try {
    const result = await api(`/api/alerts?allCompanies=true&since=${encodeURIComponent(state.alertCursor)}`, { signal });
    if (state.currentUser?.id !== userId) return;
    state.alertCursor = result.checkedAt;
    try { localStorage.setItem(`mibro-alert-cursor:${userId}:all-workspaces`, state.alertCursor); } catch {}
    if (!result.alerts?.length) return;
    const latest = result.alerts[result.alerts.length - 1];
    toast(result.alerts.length === 1 ? latest.title : `${latest.title} · +${result.alerts.length - 1} aviso(s)`);
    const audibleAlert = result.alerts.findLast((alert) => workspace.sound[alert.companyId]);
    if (audibleAlert) void playInboxAlertSound(audibleAlert.companyId);
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
  } finally {
    state.checkingAlerts = false;
    if (alertRefreshQueued) { alertRefreshQueued = false; scheduleInboxAlerts(); }
  }
}

async function setCategoryHidden(categoryId, hidden) {
  state.categoryVisibility = await api("/api/category-visibility", { method:"PATCH", body:JSON.stringify({ categoryId, hidden }) });
  state.categorySignature = "";
  state.listSignature = "";
  await loadCategories();
  if (!state.category) await loadConversations();
  toast(hidden ? "Categoria ocultada para sua conta." : "Categoria exibida novamente.");
}

async function loadCategories({ signal } = {}) {
  const epoch = workspace.epoch;
  const [allCategories, visibility] = await Promise.all([api("/api/categories", { signal }), api("/api/category-visibility", { signal })]);
  if (epoch !== workspace.epoch) return;
  // Preserve the current contact/operator choice, not a snapshot taken before
  // the request (another conversation may have opened in the meantime).
  const previousPrimaryCategory = $("#category-select").value;
  const previousSubcategory = $("#subcategory-select").value;
  // state.categories = todas as empresas acessíveis (o select da conversa usa
  // só as da empresa dela); a barra lateral usa a visão filtrada abaixo.
  state.categories = allCategories;
  state.categoryVisibility = visibility;
  const categories = sidebarCategories(allCategories);
  const signature = JSON.stringify([state.visibilityMode, state.companyFilter, canViewSidebarUncategorized(), visibility, state.companies.map((company) => [company.id, company.name, company.primaryColor]), allCategories.map((category) => [category.id, category.companyId, category.parentId, category.parent?.name, category.code, category.name, category.color, category.active, category.masterOnly, category.displayOrder, category.hidden, category.selectable])]);
  if (signature === state.categorySignature) return;
  state.categorySignature = signature;
  state.selectedHeaderSignature = "";
  const activeIds = new Set(categories.filter((category) => category.active).map((category) => category.id));
  const allActive = orderedCategories(categories.filter((category) => category.active && (!category.parentId || activeIds.has(category.parentId))));
  const shown = state.visibilityMode ? allActive : allActive.filter((category) => !category.hidden);
  if (state.category === "UNCATEGORIZED" && (!canViewSidebarUncategorized() || (visibility.hideUncategorized && !state.visibilityMode))) state.category = "";
  if (state.category && state.category !== "UNCATEGORIZED" && !shown.some((category) => category.code === state.category)) state.category = "";
  const roots = allActive.filter((category) => !category.parentId);
  const displayRoots = roots.filter((root) => state.visibilityMode
    || !root.hidden
    || shown.some((category) => category.parentId === root.id));
  const uncategorized = canViewSidebarUncategorized()
    ? `<div class="category-filter-item ${visibility.hideUncategorized ? "category-hidden" : ""}" ${visibility.hideUncategorized && !state.visibilityMode ? "hidden" : ""}><button class="filter" data-category="UNCATEGORIZED"><span><i class="category-dot uncategorized-dot"></i>Sem categoria</span><strong data-uncategorized-count>0</strong></button><button class="category-eye" data-hide-category="UNCATEGORIZED" data-hidden="${visibility.hideUncategorized}" title="${visibility.hideUncategorized ? "Exibir" : "Ocultar"}">${visibility.hideUncategorized ? "◉" : "⊘"}</button></div>`
    : "";
  $("#category-filters").innerHTML = uncategorized + displayRoots.map((root) => {
    const children = shown.filter((category) => category.parentId === root.id);
    const rootShown = state.visibilityMode || !root.hidden;
    const expanded = !rootShown || state.expandedCategories.has(root.id);
    const row = (category, child = false) => `<div class="category-filter-item ${category.hidden ? "category-hidden" : ""}"><button class="filter ${child ? "subcategory-filter" : "category-parent-filter"}" data-category="${category.code}" ${!child ? `data-category-group="${category.id}" aria-expanded="${expanded}"` : ""}><span><i class="category-dot" style="background:${category.color || root.color || "#999"}"></i>${child ? "↳ " : ""}${escapeHtml(category.name)}${!child && children.length ? `<i class="category-chevron">${expanded ? "⌃" : "⌄"}</i>` : ""}</span><strong data-category-count="${category.id}">0</strong></button><button class="category-eye" data-hide-category="${category.id}" data-hidden="${category.hidden}" title="${category.hidden ? "Exibir" : "Ocultar"}">${category.hidden ? "◉" : "⊘"}</button></div>`;
    const rootRow = rootShown ? row(root) : `<div class="category-group-label"><i class="category-dot" style="background:${root.color || "#999"}"></i><span>${escapeHtml(root.name)}</span><small>principal oculta</small></div>`;
    return `<div class="category-filter-group"${categoryCompanyBorder(root, allCategories)}>${rootRow}${children.length ? `<div class="subcategory-filters" data-category-children="${root.id}" ${expanded ? "" : "hidden"}>${children.map((child) => row(child, true)).join("")}</div>` : ""}</div>`;
  }).join("");
  renderCategorySelect();
  renderCategoryCompanyOptions();
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

// Barra lateral: empresa escolhida, ou — em "Todas" — um setor por código
// (subsetores remapeados para a principal mantida).
function sidebarCategories(categories) {
  const allowed = categories.filter((category) => category.selectable !== false);
  const allowedIds = new Set(allowed.map((category) => category.id));
  categories = allowed.map((category) => category.parentId && !allowedIds.has(category.parentId) && category.parent?.active !== false
    ? { ...category, parentId: null } : category);
  if (state.companyFilter && state.companyFilter !== "ALL") {
    return categories.filter((category) => category.company?.slug === state.companyFilter);
  }
  if (!multiCompany()) return categories;
  const keptRoots = new Map();
  for (const category of categories) if (!category.parentId && !keptRoots.has(category.code)) keptRoots.set(category.code, category);
  const seenChildren = new Set();
  return categories.flatMap((category) => {
    if (!category.parentId) return keptRoots.get(category.code) === category ? [category] : [];
    const parent = keptRoots.get(category.parent?.code);
    const key = `${category.parent?.code}/${category.code}`;
    if (!parent || seenChildren.has(key)) return [];
    seenChildren.add(key);
    return [{ ...category, parentId: parent.id }];
  });
}

// Select de categoria da conversa aberta: SÓ setores da empresa dela —
// nunca "Renova Mibro" numa conversa Sincrofit (o backend também barra).
function renderCategorySelect() {
  const activeIds = new Set(state.categories.filter((category) => category.active).map((category) => category.id));
  const roots = orderedCategories(state.categories.filter((category) => category.active && !category.parentId
    && (!state.selectedCompanyId || category.companyId === state.selectedCompanyId)
    && (!category.parentId || activeIds.has(category.parentId))));
  $("#category-select").innerHTML = `${state.currentUser?.canViewUncategorized ? `<option value="">Sem categoria</option>` : `<option value="" disabled>Selecione a categoria</option>`}` + roots.map((category) => `<option value="${category.id}" data-selectable="${category.selectable !== false}">${escapeHtml(category.name)}</option>`).join("");
}

// Formulário "Criar categoria": empresa primeiro; "Dentro de" só lista
// principais da empresa escolhida.
// Workspaces: categoria nova nasce SEMPRE na empresa ativa (o seletor fica
// travado nela e só aparece como identificação).
function renderCategoryCompanyOptions() {
  const select = $("#category-company");
  const current = activeCompany();
  const options = current ? [current] : state.companies;
  select.innerHTML = options.map((company) => `<option value="${escapeHtml(company.id)}">${escapeHtml(company.name)}</option>`).join("");
  if (current) select.value = current.id;
  select.disabled = Boolean(current);
  $("#category-company-field").hidden = !multiCompany();
  const title = $("#category-dialog .dialog-header h2");
  if (title) title.textContent = current && multiCompany() ? `Categorias — ${current.displayName}` : "Categorias";
  renderCategoryParentOptions();
}

function renderCategoryParentOptions() {
  const companyId = $("#category-company").value;
  const roots = orderedCategories(state.categories.filter((category) => category.active && !category.parentId && (!companyId || category.companyId === companyId)));
  $("#category-parent").innerHTML = `<option value="">Categoria principal</option>` + roots.map((category) => `<option value="${category.id}">${escapeHtml(category.name)}</option>`).join("");
}

function renderCategoryManager() {
  // Só as categorias do workspace ativo (as da outra empresa nem aparecem).
  const current = activeCompany();
  const ordered = orderedCategories(current ? state.categories.filter((category) => category.companyId === current.id) : state.categories);
  $("#category-manager-list").innerHTML = ordered.map((category) => {
    const parents = state.categories.filter((candidate) => candidate.active && !candidate.parentId && candidate.id !== category.id && candidate.companyId === category.companyId);
    return `<form class="category-manager-row ${category.parentId ? "subcategory-row" : ""}" data-category-id="${category.id}">
    <div class="category-item-heading">
    ${multiCompany() ? companyBadge(category.company, "manager-company-badge") : ""}
    <span class="category-item-level">${category.parentId ? "Subcategoria" : "Categoria principal"}</span>
    </div>
    <div class="category-item-fields">
    <input class="managed-color" type="color" value="${category.color || "#6b7280"}" aria-label="Cor de ${escapeHtml(category.name)}">
    <label class="category-item-name"><span>Nome</span><input class="managed-name" maxlength="60" value="${escapeHtml(category.name)}" aria-label="Nome da categoria" required></label>
    <label class="category-item-parent"><span>Dentro de</span><select class="managed-parent" aria-label="Categoria principal"><option value="">Principal</option>${parents.map((parent) => `<option value="${parent.id}" ${parent.id === category.parentId ? "selected" : ""}>${escapeHtml(parent.name)}</option>`).join("")}</select></label>
    <button type="submit">Salvar</button>
    </div>
    <div class="category-item-options">
    <label class="active-switch"><input class="managed-active" type="checkbox" ${category.active ? "checked" : ""}><span>${category.active ? "Ativa" : "Inativa"}</span></label>
    ${state.currentUser?.isMaster ? `<label class="active-switch master-only-switch"><input class="managed-master-only" type="checkbox" ${category.masterOnly ? "checked" : ""}><span>Somente Master</span></label>` : ""}
    ${state.currentUser?.isMaster && !category.parentId ? `<label class="category-private-toggle" title="Mensagens enquanto a conversa estiver neste setor ficam visíveis só para os membros do setor (Equipe) e para o Master."><input class="managed-private" type="checkbox" ${category.visibilityMode === "SECTOR_PRIVATE" ? "checked" : ""}><span>🔒 Histórico protegido</span></label>` : category.visibilityMode === "SECTOR_PRIVATE" || category.parent?.visibilityMode === "SECTOR_PRIVATE" ? `<span class="category-private-toggle" title="Histórico restrito ao setor">🔒</span>` : ""}
    </div>
  </form>`;
  }).join("");
}

// In-flight sidebar reads are shared only while pending, never cached after
// completion. Primary lists/messages always make a fresh authorized request.
const pendingInboxSidebarReads = new Map();
function sharePendingSidebarRead(key, load) {
  const previous = pendingInboxSidebarReads.get(key);
  if (previous && Date.now() - previous.startedAt < 2000) return previous.promise;
  const entry = { startedAt: Date.now(), promise: null };
  entry.promise = Promise.resolve().then(load).finally(() => {
    if (pendingInboxSidebarReads.get(key) === entry) pendingInboxSidebarReads.delete(key);
  });
  pendingInboxSidebarReads.set(key, entry);
  return entry.promise;
}
const conversationPageState={key:null,cursor:null,total:0,loadingMore:false};
async function loadConversations({append=false,signal}={}) {
  const mineOnly = state.status === "MINE";
  if (mineOnly && !state.currentUser?.id) return;
  const params = new URLSearchParams();
  if (state.search) params.set("search", state.search);
  if (state.category) params.set("category", state.category);
  if (state.channel) params.set("channel", state.channel);
  if (mineOnly) params.set("assignedUser", state.currentUser.id);
  else if (state.assignedUser) params.set("assignedUser", state.assignedUser);
  if (state.assignedUserActiveOnly && !mineOnly) params.set("activeOnly", "true");
  const statusValues = [...(state.status && !mineOnly ? [state.status] : []), ...state.statusToggle];
  if (statusValues.length) params.set("status", statusValues.join(","));
  if (state.priorityToggle.size) params.set("priority", [...state.priorityToggle].join(","));
  if (state.slaBreached) params.set("slaBreached", "true");
  if (state.unassigned) params.set("unassigned", "true");
  if (state.preferredAssignee) params.set("preferredAssignee", state.preferredAssignee);
  const company = companyQuery();
  if (company) params.set("company", company);
  const companyOnly = company ? `?company=${encodeURIComponent(company)}` : "";
  // Resposta atrasada (outro workspace ou filtro anterior) nunca é desenhada.
  const listSequence = ++conversationListSequence;
  const epoch = workspace.epoch;
  if(!state.category)params.set('respectHidden','true');
  const filterKey=params.toString();
  if(state.selectedId)params.set('selectedId',state.selectedId);
  const appendPage=append&&conversationPageState.key===filterKey&&conversationPageState.cursor;
  params.set('limit',String(appendPage?80:conversationPageState.key===filterKey?Math.max(80,state.conversations.length):80));
  if(appendPage)params.set('cursor',conversationPageState.cursor);
  if(!MARKETPLACE_UI_ENABLED)params.set('excludeMarketplaces','true');
  if(state.channel==='EMAIL')params.set('mailbox',state.emailMailbox);
  const listRequest=api(`/api/conversations?${params}`, { signal });
  const sidebarRequest=sharePendingSidebarRead(`${state.currentUser?.id}|${company}|${epoch}|summary`,()=>api(`/api/conversations/summary?sidebar=true&excludeMarketplaces=${!MARKETPLACE_UI_ENABLED}${company?'&company='+encodeURIComponent(company):''}`)).then(summary=>({summary}),error=>({error}));
  const page=await listRequest;
  const fresh=Array.isArray(page)?page:page.items;
  const conversations=appendPage?[...new Map([...state.conversations,...fresh].map(row=>[row.id,row])).values()]:fresh;
  if (listSequence !== conversationListSequence || epoch !== workspace.epoch || company !== companyQuery()) return;
  conversationPageState.key=filterKey;conversationPageState.cursor=page.nextCursor||null;conversationPageState.total=page.total??conversations.length;
  const availableConversations = MARKETPLACE_UI_ENABLED
    ? conversations
    : conversations.filter((conversation) => !isMarketplaceChannel(conversation.channel));
  const visibleConversations = state.channel === "EMAIL"
    ? availableConversations.filter((conversation) => (conversation.emailMailbox || "GENERAL") === state.emailMailbox)
    : availableConversations.filter((conversation) => conversation.channel !== "EMAIL" || (conversation.emailMailbox || "GENERAL") !== "SPAM");
  state.conversations = state.category ? visibleConversations : visibleConversations.filter((c) => c.id === state.selectedId || c.unreadCount > 0 || !isConversationCategoryHidden(c));
  const filteredUser = state.adminUsers.find((user) => user.id === state.assignedUser);
  const visibleTotal=conversationPageState.total;
  $("#list-summary").textContent = `${visibleTotal} atendimento${visibleTotal === 1 ? "" : "s"}${filteredUser ? ` ativo${visibleTotal === 1 ? "" : "s"} • ${filteredUser.name}` : ""}`;
  renderConversationListIfChanged();
  renderMoreConversations();
  // Ancillary counters cannot delay the first paint or erase fresh messages.
  // Do not keep real-time refresh locked while these background reads finish.
  void (async () => {
  const sidebar = await sidebarRequest;
  if (listSequence !== conversationListSequence || epoch !== workspace.epoch || company !== companyQuery()) return;
  if (sidebar.error) { console.warn("Não foi possível atualizar os contadores da fila."); return; }
  const {summary}=sidebar;
  const displaySummary=summary;
  // Quebra por empresa (item 41): "Mibro 25 · Sincrofit 17" — só em "Todas".
  const breakdown = multiCompany() && !company ? state.companies.map((item) => ({ item, open: summary?.openByCompany?.[item.id] || 0 })) : [];
  $("#list-summary").insertAdjacentHTML("beforeend", breakdown.length ? `<span class="company-breakdown">${breakdown.map(({ item, open }) => `<span class="company-breakdown-item"${companyStyleAttr(item)} title="Conversas abertas — ${escapeHtml(item.name)}"><i class="company-dot" aria-hidden="true"></i>${escapeHtml(item.displayName)} ${open}</span>`).join("")}</span>` : "");
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
  // Multiempresa: em "Todas", setores de mesmo código (ex.: Suporte da Mibro
  // e da Sincrofit) aparecem numa linha só — o contador soma por código.
  const visibleSidebarCategories = sidebarCategories(state.categories);
  const codeById = new Map(visibleSidebarCategories.map((item) => [item.id, item.code]));
  const countByCode = {};
  for (const [id, total] of Object.entries(displaySummary.categories || {})) {
    const code = codeById.get(id);
    if (code) countByCode[code] = (countByCode[code] || 0) + total;
  }
  document.querySelectorAll("[data-category-count]").forEach((counter) => {
    const category = visibleSidebarCategories.find((item) => item.id === counter.dataset.categoryCount);
    if (!category) { counter.textContent = 0; return; }
    const childCodes = category.parentId ? [] : [...new Set(visibleSidebarCategories.filter((item) => item.parentId === category.id).map((item) => item.code))];
    counter.textContent = [category.code, ...childCodes].reduce((total, code) => total + (countByCode[code] || 0), 0);
  });
  document.querySelector("[data-uncategorized-count]")?.replaceChildren(String(displaySummary.categories.null || 0));
  renderConversationListIfChanged();
  })().catch(() => console.warn("Não foi possível atualizar os contadores da fila."));
}

// Trocar um card entre o pointerdown e o pointerup faz o navegador perder o
// clique. Com toque/clique em andamento na lista, o redesenho espera soltar.
const conversationListPress = { active:false, deferred:false };
function renderMoreConversations(){
  $('#load-more-conversations')?.remove();
  if(conversationPageState.cursor)$('#conversation-list').insertAdjacentHTML('beforeend','<button id="load-more-conversations" type="button" class="secondary">Carregar mais conversas</button>');
}
$('#conversation-list').addEventListener('click',event=>{if(event.target.closest('#load-more-conversations')&&!conversationPageState.loadingMore){conversationPageState.loadingMore=true;loadConversations({append:true}).catch(error=>toast(error.message,true)).finally(()=>{conversationPageState.loadingMore=false;});}});
$('#conversation-list').addEventListener('scroll',event=>{const list=event.currentTarget;if(list.scrollHeight-list.scrollTop-list.clientHeight<160&&conversationPageState.cursor&&!conversationPageState.loadingMore){conversationPageState.loadingMore=true;loadConversations({append:true}).catch(()=>{}).finally(()=>{conversationPageState.loadingMore=false;});}},{passive:true});

function renderConversationListIfChanged() {
  const signature = JSON.stringify({
    selectedId: state.selectedId,
    conversations: state.conversations.map(conversationSignature),
  });
  if (signature === state.listSignature) return;
  if (conversationListPress.active) { conversationListPress.deferred = true; return; }
  state.listSignature = signature;
  renderConversationCards(state.conversations);
}
$("#conversation-list").addEventListener("pointerdown", () => { conversationListPress.active = true; });
for (const type of ["pointerup", "pointercancel"]) window.addEventListener(type, () => {
  if (!conversationListPress.active) return;
  conversationListPress.active = false;
  // Depois do `click` desta mesma interação.
  if (conversationListPress.deferred) setTimeout(() => { conversationListPress.deferred = false; renderConversationListIfChanged(); });
});

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

function setConversationControlsLoading(loading) {
  $("#chat-content").classList.toggle("conversation-loading", loading);
  for (const element of [$("#mobile-chat-controls"), document.querySelector(".conversation-meta")]) element.inert = loading;
}

// Abrir por link/notificação (?conversation=…): o usuário pediu ESTA conversa,
// então troca para o workspace dela (se tiver acesso) antes de abrir — sem
// marcar como lida uma conversa que ainda não está na tela.
async function openConversationInWorkspace(id) {
  const detail = await api(`/api/conversations/${encodeURIComponent(id)}`);
  const owner = state.companies.find((company) => company.id === detail.companyId);
  if (owner && owner.slug !== state.companyFilter) return setCompanyFilter(owner.slug, { openConversationId: detail.id });
  return openConversation(detail.id);
}

let timelinePage={id:null,expanded:false,cursor:null,hasMore:false,scope:null,raw:[]};
let timelineResizeAnchor=null;
function resetTimelineState(){timelinePage={id:null,expanded:false,cursor:null,hasMore:false,scope:null,raw:[]};timelineResizeAnchor=null;state.sharedContentMessages=null;window.AdOrigin?.clear();}
// Browser anchoring must not compete with the explicit message-ID anchor.
$('#messages').style.overflowAnchor='none';
if(window.ResizeObserver)new ResizeObserver(()=>restoreTimelineAnchor(timelineResizeAnchor)).observe($('#messages'));
let historyLoading=false,historyNeedsRefresh=false;
async function loadOlderMessages(){if(historyLoading||!timelinePage.hasMore||!timelinePage.cursor)return;historyLoading=true;const button=$('#load-older-messages');if(button)button.disabled=true;try{await openConversation(state.selectedId,{refreshList:false,markRead:false,historyBefore:timelinePage.cursor});}catch(error){toast(error.message,true);}finally{historyLoading=false;renderHistoryButton();if(historyNeedsRefresh){historyNeedsRefresh=false;refreshInbox().catch(()=>{});}}}
function setTimelineScroll(top){const box=$('#messages'),previous=box.style.scrollBehavior;box.style.scrollBehavior='auto';box.scrollTop=top;box.style.scrollBehavior=previous;}
function captureTimelineAnchor(){const box=$('#messages'),top=box.getBoundingClientRect().top,row=[...box.querySelectorAll('[data-message-id]')].find(row=>row.getBoundingClientRect().bottom>top);return {id:row?.dataset.messageId,offset:row?row.getBoundingClientRect().top-top:0,top:box.scrollTop,bottom:box.scrollHeight-box.scrollTop-box.clientHeight<80};}
function restoreTimelineAnchor(anchor){if(!anchor)return;const box=$('#messages');if(anchor.bottom){setTimelineScroll(box.scrollHeight);return;}const row=anchor.id?box.querySelector('[data-message-id="'+CSS.escape(anchor.id)+'"]'):null;if(row)setTimelineScroll(box.scrollTop+row.getBoundingClientRect().top-box.getBoundingClientRect().top-anchor.offset);else setTimelineScroll(anchor.top);}
function renderHistoryButton(){ $('#load-older-messages')?.remove();if(timelinePage.hasMore&&timelinePage.cursor)$('#messages').insertAdjacentHTML('afterbegin','<button id="load-older-messages" type="button" class="secondary">Carregar mensagens anteriores</button>');}
$('#messages').addEventListener('scroll',()=>{timelineResizeAnchor=captureTimelineAnchor();const box=$('#messages');if(box.scrollTop<80&&box.scrollHeight>box.clientHeight+100&&!historyLoading)loadOlderMessages();},{passive:true});
$('#messages').addEventListener('load',()=>restoreTimelineAnchor(timelineResizeAnchor),true);
$('#messages').addEventListener('click',event=>{if(event.target.closest('#load-older-messages'))loadOlderMessages();});
async function openConversation(id, { refreshList = true, markRead = true,historyBefore=null,signal } = {}) {
  const loadSequence = ++conversationLoadSequence;
  const changedConversation = state.selectedId !== id;
  if(changedConversation){timelinePage={id:null,expanded:false,cursor:null,hasMore:false,scope:null,raw:[]};timelineResizeAnchor=null;window.CentralSessionState?.keep(state.composerConversationId,$('#message-input').value);state.composerConversationId=null;$('#message-input').value='';}
  state.selectedId = id;
  if (changedConversation) {
    window.AdOrigin?.clear();
    window.ChatFeatures?.onConversationChange();
    window.CrmProposalDraft?.clear();
    window.CrmContext?.select(null);
    window.ContactWarning?.select(null);
    state.selectedHeaderSignature = "";
    state.selectedMessagesSignature = "";
    state.selectedNotesSignature = "";
    state.selectedActivitiesSignature = "";
    state.selectedMessageItems = [];
    state.selectedMessages = [];
    state.sharedContentMessages=null;
    if($("#contact-files-dialog")?.open)$("#contact-files-dialog").close();
    state.pendingBotSuggestion = null;
    hideBotSuggestion();
    discardComposerAudio();
    loadQuickRepliesCache(id).catch(() => {});
    $("#empty-state").hidden = true;
    $("#chat-content").hidden = false;
    $("#chat-panel").classList.add("open");
    $("#messages").innerHTML = chatSkeletonMarkup();
    // Até chegar a conversa nova, os controles ainda mostram a anterior:
    // bloqueados para não transferir/alterar com dados errados.
    setConversationControlsLoading(true);
  }
  if (markRead) await api(`/api/conversations/${id}/read`, { method:"POST", signal });
  const historyParams=new URLSearchParams({historyPage:'true'});
  if (window.AdOrigin?.needsLookup(id)) historyParams.set("adOrigin", "true");
  if(historyBefore)historyParams.set('historyBefore',historyBefore);
  else if(timelinePage.id===id&&timelinePage.expanded&&timelinePage.cursor)historyParams.set('historyFrom',timelinePage.cursor);
  const c = await api(`/api/conversations/${id}?${historyParams}`, { signal });
  if (loadSequence !== conversationLoadSequence || state.selectedId !== id) return;
  if (c.id !== id) { state.selectedId = c.id; id = c.id; }
  // Workspaces: conversa de outra empresa nunca abre dentro do workspace
  // atual (a troca só acontece por ação explícita — ver openConversationInWorkspace).
  if (c.companyId && activeCompany() && c.companyId !== activeCompany().id) {
    closeConversationView();
    return;
  }
  if(historyBefore&&timelinePage.scope!==c.messagePage?.scope){timelinePage={id:null,expanded:false,cursor:null,hasMore:false,scope:null,raw:[]};return openConversation(id,{refreshList:false,markRead:false});}
  const previousTimeline=captureTimelineAnchor();
  window.AdOrigin?.update(c);
  if(historyBefore)c.messages=[...new Map([...c.messages,...timelinePage.raw].map(row=>[row.id,row])).values()].sort((a,b)=>new Date(a.occurredAt)-new Date(b.occurredAt)||a.id.localeCompare(b.id));
  const oldPage=timelinePage;
  timelinePage={id:c.id,expanded:Boolean(historyBefore)||(oldPage.id===c.id&&oldPage.expanded),scope:c.messagePage?.scope,hasMore:c.messagePage?.hasMore===null?oldPage.hasMore:Boolean(c.messagePage?.hasMore),cursor:c.messagePage?.nextCursor||(historyBefore?oldPage.cursor:null),raw:c.messages};
  if(!historyBefore&&oldPage.scope!==timelinePage.scope){state.sharedContentMessages=null;if($('#contact-files-dialog')?.open){$('#contact-files-dialog').close();}}
  state.selectedCompanyId = c.companyId || null;
  renderComposerSender(c);
  const headerSignature = JSON.stringify({
    id: c.id,
    archivedAt: c.archivedAt,
    companyId: c.companyId,
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
    senderAccount: [c.channelAccountId, c.channelAccount?.name, c.channelAccount?.providerMetadata?.username, c.whatsappSender],
    // Sem `remainingSeconds`: ele muda a cada requisição e fazia o cabeçalho
    // (selects de categoria/responsável) ser recriado a cada SSE/polling,
    // descartando a escolha em andamento do atendente.
    customerServiceWindow: c.customerServiceWindow && { ...c.customerServiceWindow, remainingSeconds: undefined },
    mergedDestinations: (c.mergedDestinations || []).map((item) => [item.id, item.channel, item.contact?.email, item.contact?.phone, item.channelAccount?.name]),
    transferCategories: (c.transferCategories || []).map((category) => [category.id, category.parentId, category.name, category.active, category.selectable]),
  });
  const displayMessages = messagesWithReactions(c.messages);
  state.selectedMessages = displayMessages;
  state.selectedContactName = c.contact.customName || c.contact.name || c.contact.email || c.contact.phone;
  state.selectedContactPhone = c.contact.phone || '';
  const hasReactionEvents = displayMessages.length !== c.messages.length;
  const messageItems = displayMessages.map((message) => JSON.stringify([message.id, message.externalId, message.direction, message.type, message.text, message.occurredAt, message.mediaStorageKey, message.mediaMimeType, message.mediaFileName, message.mediaSize, message.reactionEmoji, message.sentByUser?.id, message.sentByUser?.name, message.reactions, message.starred, message.pinned, message.replyPreview]));
  const messagesSignature = JSON.stringify([c.messageHistoryLimited, c.accessMode, c.visibleWindows, c.currentHandoff, c.customerServiceWindow?.requiresTemplate, messageItems]);
  // Aberta só por supervisão: esconde resposta/assumir/transferir/finalizar
  // (o backend também bloqueia — isto é só para não oferecer a ação).
  $("#chat-content").classList.toggle("supervision-readonly", c.accessMode === "SUPERVISION" || Boolean(c.archivedAt));
  const notesSignature = JSON.stringify((c.contact.notes || []).map((note) => [note.id, note.content, note.pinned, note.createdAt, note.updatedAt, note.author?.name]));
  const activitiesSignature = JSON.stringify((c.activities || []).map((activity) => [activity.id, activity.action, activity.details, activity.createdAt, activity.actorUser?.name]));
  state.selectedContactId = c.contact.id;
  state.customerServiceWindow = c.customerServiceWindow;
  state.selectedChannel = c.channel;
  state.selectedChannelCapabilities = c.channelCapabilities || null;
  state.transferCategories = c.transferCategories || [];
  syncCustomerServiceWindow();
  syncAudioAvailability();
  syncSocialReplyMode(c.channel, c.channelCapabilities);
  renderContextDetails(c);
  if(state.composerConversationId!==c.id){$('#message-input').value=window.CentralSessionState?.draft(c.id)||'';state.composerConversationId=c.id;autoResizeComposer();}
  window.FollowUpsUI?.onConversation(c);
  renderSlaTab(c);
  $("#empty-state").hidden = true; $("#chat-content").hidden = false; $("#chat-panel").classList.add("open");
  if (headerSignature !== state.selectedHeaderSignature) {
    state.selectedHeaderSignature = headerSignature;
    const name = c.contact.customName || c.contact.name || c.contact.email || c.contact.phone;
    $("#contact-avatar").textContent = initials(name); $("#contact-name").textContent = name; $("#contact-phone").textContent = c.contact.email || (c.contact.phone ? `+${c.contact.phone}` : "");
    $("#conversation-sender").hidden = c.channel !== "META" || !state.currentUser?.isMaster;
    $("#conversation-sender").textContent = c.channel === "META"
      ? (c.whatsappSender ? (c.whatsappSender.reason || `Número: ${c.whatsappSender.options.find(o => o.id === c.whatsappSender.selectedId)?.name || "Não configurado"}`) : `Número: ${c.channelAccount?.name || "WhatsApp principal"}`) : "";
    // Empresa sempre explícita na conversa aberta (cor + rótulo, item 26/53).
    $("#contact-company").hidden = !c.company;
    if (c.company) {
      $("#contact-company").textContent = c.company.displayName;
      $("#contact-company").title = c.company.name;
      $("#contact-company").style.setProperty("--company-color", companyColor(c.company) || "");
    }
    $("#chat-content").dataset.company = c.company?.slug || "";
    $("#chat-content").style.setProperty("--company-color", companyColor(c.company) || "");
    // Escolha de destino ainda não confirmada: sobrevive ao redesenho do
    // cabeçalho enquanto a categoria real da conversa não mudou.
    const pendingChoice = !changedConversation && (c.categoryId || "") === state.selectedCategoryId && pendingCategoryId() !== state.selectedCategoryId
      ? { primary: $("#category-select").value, sub: $("#subcategory-select").value } : null;
    renderCategorySelect();
    renderAssigneeOptions(c.companyId, c.assignedUserId);
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
    if (pendingChoice && [...$("#category-select").options].some((option) => option.value === pendingChoice.primary)) {
      $("#category-select").value = pendingChoice.primary;
      populateSubcategorySelect(pendingChoice.primary, pendingChoice.sub, state.transferCategories);
    }
    syncCategoryConfirmation();
    syncCategoryAlert(c);
    $("#status-badge").className = "status-badge"; $("#status-badge").textContent = statusLabel(c.status);
    if (c.assignedUserId && ![...$("#assignee-select").options].some((option) => option.value === c.assignedUserId)) {
      $("#assignee-select").add(new Option(c.assignedUser?.name || "Outro atendente", c.assignedUserId));
    }
    $("#assignee-select").value = pendingUserTransferId || c.assignedUserId || "";
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
  setConversationControlsLoading(false);
  const intakeWasOpen = !changedConversation && Boolean($("#assistant-intake")?.open);
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
  }
  renderAssistantIntake(c.assistantIntake, intakeWasOpen);
  renderHistoryButton();
  window.ChatFeatures?.onConversation(c, displayMessages.length);
  if(changedConversation||(!historyBefore&&previousTimeline.bottom))setTimelineScroll($('#messages').scrollHeight);
  else restoreTimelineAnchor({...previousTimeline,bottom:false});
  timelineResizeAnchor=captureTimelineAnchor();
  syncMessageStatuses(displayMessages);
  renderFilesTabSummary();
  if ($('#contact-files-dialog').open||(activeContextTab()==='files'&&$('.workspace').classList.contains('context-open')))loadSharedContent().catch(()=>{});
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
let realtimeRefreshPending = false;
const realtimeBackgroundReads = new Map();
function startRealtimeBackgroundRead(name, context, task) {
  const previous = realtimeBackgroundReads.get(name);
  if (previous?.context === context) return;
  previous?.controller.abort();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 15000);
  const job = { controller, context };
  realtimeBackgroundReads.set(name, job);
  Promise.resolve().then(() => task(controller.signal)).catch(() => {}).finally(() => {
    clearTimeout(deadline);
    if (realtimeBackgroundReads.get(name) === job) realtimeBackgroundReads.delete(name);
  });
}
async function refreshInbox() {
  if (realtimeRefreshRunning) { realtimeRefreshPending=true; return; }
  realtimeRefreshRunning = true;
  realtimeRefreshPending = false;
  // A lista não aguarda a conversa selecionada, categorias ou alertas.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 15000);
  const signal = controller.signal;
  try {
    if(historyLoading)historyNeedsRefresh=true;
    const selectedId = state.selectedId;
    const epoch = workspace.epoch;
    if (selectedId && !historyLoading) {
      startRealtimeBackgroundRead("conversation", `${epoch}:${selectedId}`, async readSignal => {
        try { await openConversation(selectedId, { refreshList:false, markRead:!document.hidden, signal:readSignal }); }
        catch (error) {
          if ([403, 404].includes(error.status) && state.selectedId === selectedId && workspace.epoch === epoch) {
            closeConversationView(); toast(error.message, true);
          }
        }
      });
    }
    startRealtimeBackgroundRead("alerts", state.currentUser?.id, readSignal => checkAlerts({ signal:readSignal }));
    startRealtimeBackgroundRead("categories", epoch, readSignal => loadCategories({ signal:readSignal }));
    await loadConversations({ signal });
    scheduleWorkspaceUnread();
  } finally {
    clearTimeout(deadline);
    realtimeRefreshRunning = false;
    if(realtimeRefreshPending){realtimeRefreshPending=false;setTimeout(()=>refreshInbox().catch(()=>{}),0);}
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
  events.addEventListener("inbox.updated", (event) => {
    // Workspaces: o aviso traz só os ids das empresas que mudaram. A lista só
    // recarrega se for o workspace aberto; as abas sempre atualizam o contador.
    let companyIds = [];
    try { companyIds = JSON.parse(event.data || "{}").companyIds || []; } catch {}
    scheduleWorkspaceUnread();
    if (companyIds.length && activeCompany() && !companyIds.includes(activeCompany().id)) {
      scheduleInboxAlerts();
      return;
    }
    clearTimeout(realtimeRefreshTimer);
    realtimeRefreshTimer = setTimeout(() => refreshInbox().catch(() => {}), 120);
  });
  // Agenda: avisos direcionados (sem conteúdo) — a lista recarrega pela API.
  for (const name of ["followup.updated", "followup.reminder"]) {
    events.addEventListener(name, (event) => {
      let data = null;
      try { data = JSON.parse(event.data); } catch {}
      window.FollowUpsUI?.onEvent(name, data);
    });
  }
  events.addEventListener("open", () => {
    clearTimeout(connectionLossTimer);
    connectionLossTimer = null;
    const wasDown = connectionState !== "online";
    setConnectionState("online");
    // Reconexão: o que chegou com o SSE fora do ar vem do banco, não de eventos.
    scheduleWorkspaceUnread(0);
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
// Composer (item 27/28): "Enviando por Mibro Brasil · número" — proteção
// contra erro humano; só uma linha/rótulo na cor da empresa, nunca o
// composer inteiro pintado.
function renderComposerSender(c) {
  const sender = $("#composer-sender");
  if (!sender) return;
  if (!c.company) { sender.hidden = true; sender.innerHTML = ""; return; }
  const account = c.channelAccount;
  sender.hidden = false;
  sender.style.setProperty("--company-color", companyColor(c.company) || "");
  sender.innerHTML = `<i class="company-dot" aria-hidden="true"></i><span>Enviando por <b>${escapeHtml(c.company.name)}</b>${account?.name && account.name !== c.company.name ? ` · ${escapeHtml(account.name)}` : ""}${account?.displayNumber ? ` · ${escapeHtml(account.displayNumber)}` : ""}</span>${companyBadge(c.company, "composer-company-badge")}`;
}

function renderContextDetails(c) {
  window.ContactWarning?.select(c.channel === "META" ? c.id : null);
  $("#crm-context-frame").dataset.conversationId = c.channel === "META" ? c.id : "";
  window.CrmContext?.select(c.channel === "META" ? c.id : null);
  const name = c.contact.customName || c.contact.name || c.contact.phone;
  const channel = channelBadge(c.channel) || "WhatsApp";
  const markup = `
    <div class="context-detail-block">
      <span class="context-detail-label">Contato</span>
      <strong>${escapeHtml(name)}</strong>
      <small>+${escapeHtml(c.contact.phone)}</small>
    </div>
    <div class="context-info-list">
      ${c.company ? `<div class="context-info-row context-company-row"><span>Empresa</span><strong>${companyBadge(c.company)} ${escapeHtml(c.company.name)}</strong></div>` : ""}
      <div class="context-info-row"><span>Canal</span><strong>${escapeHtml(channel)}</strong></div>
      ${c.channelAccount ? `<div class="context-info-row"><span>Número/conta</span><strong>${escapeHtml(c.channelAccount.name)}${c.channelAccount.displayNumber ? ` · ${escapeHtml(c.channelAccount.displayNumber)}` : ""}</strong></div>` : ""}
      <div class="context-info-row"><span>Categoria</span><strong>${escapeHtml(categoryLabel(c.category))}</strong></div>
      <div class="context-info-row"><span>Status</span><strong>${escapeHtml(statusLabel(c.status))}</strong></div>
      <div class="context-info-row"><span>Responsável</span><strong>${escapeHtml(c.assignedUser?.name || "Sem responsável")}</strong></div>
      ${c.priority && c.priority !== "NORMAL" ? `<div class="context-info-row"><span>Prioridade</span><strong>${escapeHtml(priorityLabel(c.priority))}</strong></div>` : ""}
      <div class="context-info-row"><span>Fixada</span><strong>${c.isPinned ? "Sim" : "Não"}</strong></div>
    </div>
    ${preferredAssigneeMarkup(c)}
    ${window.ConversationArchive?.markup(c)||''}
    ${postContextMarkup(c.postContext)}
    <div id="context-template-history"></div>`;
  const target = $("#context-details-summary");
  if (target.detailsMarkup !== markup) {
    target.detailsMarkup = markup;
    target.innerHTML = markup;
    if (c.channel === "META" && c.contact?.id) window.WaSendWizard?.renderContactHistory($("#context-template-history"), c.contact.id);
  }
}

// Atendente fixo do cliente (≠ responsável atual): para quem o cliente vai
// sempre que iniciar um novo atendimento. Alterar/remover só Supervisor da
// empresa ou Master (o backend decide `canEdit` e revalida tudo).
function awaitingPreferredAssignee(c) {
  const info = c.preferredAssignee;
  return Boolean(info?.enabled && info.assignee && c.assignedUserId === info.assignee.id && c.status === "AGUARDANDO_EQUIPE");
}

function preferredAssigneeMarkup(c) {
  const info = c.preferredAssignee;
  if (!info) return "";
  if (!info.assignee && !info.canEdit) return "";
  const when = info.setAt ? new Intl.DateTimeFormat("pt-BR", { dateStyle:"short", timeStyle:"short" }).format(new Date(info.setAt)) : "";
  return `
    <div class="context-detail-block preferred-assignee-block">
      <span class="context-detail-label">Atendente fixo</span>
      <strong>${info.assignee ? `★ ${escapeHtml(info.assignee.name)}${info.assignee.active ? "" : " (inativo)"}` : "Nenhum"}</strong>
      ${info.assignee ? `<small>Direcionar novos atendimentos: ${info.autoRouteEnabled ? "ligado" : "desligado"}</small>` : ""}
      ${awaitingPreferredAssignee(c) ? `<small class="preferred-assignee-waiting">Aguardando atendente responsável</small>` : ""}
      ${info.setBy && info.assignee ? `<small>Definido por ${escapeHtml(info.setBy.name)}${when ? ` em ${escapeHtml(when)}` : ""}</small>` : ""}
      ${info.canEdit ? `<div class="preferred-assignee-actions"><button type="button" data-preferred-assignee-action="edit">${info.assignee ? "Alterar" : "Definir"}</button>${info.assignee ? `<button type="button" data-preferred-assignee-action="remove">Remover</button>` : ""}</div>` : ""}
    </div>`;
}

document.addEventListener('central:archive-changed',async event=>{
  const {id,archived}=event.detail;
  if(archived&&state.selectedId===id)closeConversationView();
  await loadConversations();
  if(!archived)await openConversation(id);
});

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
  const messages = state.sharedContentMessages || state.selectedMessages || [];
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
    CATEGORY_CHANGED: details.source === "OUTBOUND_TEMPLATE_ROUTING" || details.source === "OUTBOUND_TEMPLATE_INITIAL_CATEGORY"
      ? `classificou automaticamente o atendimento como ${details.to || "categoria configurada"}${details.template?.name ? ` pelo template ${details.template.name}` : ""}${details.source === "OUTBOUND_TEMPLATE_INITIAL_CATEGORY" ? " (regra do número)" : ""}`
      : `alterou a categoria de ${details.from || "Sem categoria"} para ${details.to || "Sem categoria"}`,
    STATUS_CHANGED: `alterou o status de ${status(details.from)} para ${status(details.to)}`,
    NOTE_ADDED: `adicionou uma nota${details.preview ? `: “${details.preview}”` : ""}`,
    NOTE_DELETED: `apagou uma nota${details.preview ? `: “${details.preview}”` : ""}`,
    NOTE_PINNED: `fixou uma nota${details.preview ? `: “${details.preview}”` : ""}`,
    NOTE_UNPINNED: `desafixou uma nota${details.preview ? `: “${details.preview}”` : ""}`,
    BOT_TRIAGE_COMPLETED: `Bot encaminhou a conversa para ${details.categoryName || "o setor selecionado"}`,
    PRIVATE_SEGMENT_STARTED: `🔒 conversa entrou em ${details.category || "setor protegido"} (histórico restrito ao setor)`,
    PRIVATE_SEGMENT_ENDED: details.finalized ? "🔒 atendimento do setor protegido foi finalizado" : `🔒 conversa saiu de ${details.category || "setor protegido"} para ${details.to || "outro setor"}`,
    ROUTED_TO_PREFERRED_ASSIGNEE: `Novo atendimento direcionado ao atendente fixo ${details.to || ""}`.trim(),
    MESSAGE_PINNED: "fixou uma mensagem",
    MESSAGE_UNPINNED: "desafixou uma mensagem",
    MESSAGE_FORWARDED: "encaminhou uma mensagem para esta conversa",
    AUTO_FINALIZED_INACTIVITY: `Sistema finalizou a conversa após ${details.inactivityMinutes || 1440} minutos sem resposta do cliente`,
    AFTER_HOURS_REMINDER_SENT: "enviou o lembrete automático fora do expediente (Automação — Fora do expediente)",
    AFTER_HOURS_REMINDER_FAILED: "não conseguiu enviar o lembrete automático fora do expediente — a Meta recusou o envio",
    AFTER_HOURS_REMINDER_UNKNOWN: "tentou enviar o lembrete automático fora do expediente, mas a Meta não confirmou o resultado (não será reenviado)",
  })[activity.action] || "realizou uma atualização na conversa";
}

function renderActivities(activities) {
  $("#history-list").innerHTML = activities.length ? activities.map((activity) => `<article class="history-item"><span class="history-dot" aria-hidden="true"></span><div><p><b>${escapeHtml(activity.actorUser?.name || "Sistema")}</b> ${escapeHtml(activityText(activity))}</p><time>${new Intl.DateTimeFormat("pt-BR", { dateStyle:"short", timeStyle:"short" }).format(new Date(activity.createdAt))}</time></div></article>`).join("") : `<div class="notes-empty">Nenhuma ação registrada ainda.</div>`;
}

const roleLabel = (role) => ({ ADMIN:"Master", SUPERVISOR:"Supervisor", ATENDENTE:"Atendente" })[role] || role;

// Multiempresa (item 9/10): acesso N:N com cargo por empresa.
function renderTeamCompanyAccess(access = []) {
  const byCompany = new Map(access.map((entry) => [entry.companyId, entry]));
  $("#team-company-access").innerHTML = state.companies.map((company) => {
    const entry = byCompany.get(company.id);
    const checked = entry ? entry.active !== false : false;
    const defaults = state.adminUsers?.find(user => user.id === state.editingUserId) || {};
    return `<div class="team-company-row" data-company-row="${escapeHtml(company.id)}" data-original-permissions="${escapeHtml(JSON.stringify(entry?.permissions || null))}"${companyStyleAttr(company)}>
      <label class="team-company-check"><input class="team-company-input" type="checkbox" value="${escapeHtml(company.id)}" ${checked ? "checked" : ""}>${companyBadge(company)}<span>${escapeHtml(company.name)}</span></label>
      <select class="team-company-role" aria-label="Cargo em ${escapeHtml(company.name)}">
        <option value="" ${!entry?.role ? "selected" : ""}>Cargo padrão</option>
        <option value="SUPERVISOR" ${entry?.role === "SUPERVISOR" ? "selected" : ""}>Supervisor</option>
        <option value="ATENDENTE" ${entry?.role === "ATENDENTE" ? "selected" : ""}>Atendente</option>
      </select>
      <details class="team-company-permissions" ${entry?.permissions ? "open" : ""}>
        <summary><label><input class="team-company-custom" type="checkbox" ${entry?.permissions ? "checked" : ""}> Personalizar permissões nesta empresa</label></summary>
        <div class="team-company-permission-list">${COMPANY_PERMISSION_LABELS.map(([key, label]) => `<label><input type="checkbox" data-company-permission="${key}" ${(entry?.permissions?.[key] ?? defaults[key]) ? "checked" : ""} data-initial-checked="${Boolean(entry?.permissions?.[key] ?? defaults[key])}"> ${escapeHtml(label)}</label>`).join("")}</div>
      </details>
    </div>`;
  }).join("");
}

// Permissões que podem variar por empresa (sem personalizar = as do cadastro).
const COMPANY_PERMISSION_LABELS = [
  ["canViewUncategorized", "Ver “Sem categoria”"], ["canTransferConversations", "Transferir conversas"],
  ["canSetConversationPriority", "Alterar prioridade"], ["canManageCampaigns", "Gerenciar campanhas"],
  ["canStartWhatsAppConversations", "Iniciar conversas por WhatsApp"], ["canStartEmailConversations", "Iniciar conversas por e-mail"], ["canMergeContacts", "Fundir contatos"],
  ["canManageCategories", "Gerenciar categorias"], ["canViewConversationHistory", "Ver histórico da conversa"],
  ["canViewPreviousMessages", "Ver mensagens anteriores"], ["canViewOwnProductivity", "Ver minha produtividade"],
  ["canManageAfterHours", "Editar regras fora do expediente (Supervisor)"],
];

function teamCompanyAccessBody() {
  return [...document.querySelectorAll("#team-company-access [data-company-row]")].map(row => {
    let permissions = row.querySelector(".team-company-custom").checked ? { ...JSON.parse(row.dataset.originalPermissions || "null") } : null;
    if (permissions) for (const input of row.querySelectorAll("[data-company-permission]")) {
      const key = input.dataset.companyPermission;
      if (Object.hasOwn(permissions, key) || String(input.checked) !== input.dataset.initialChecked) permissions[key] = input.checked;
    }
    const uncategorized = [...document.querySelectorAll("[data-uncategorized-company]")].find(input => input.dataset.uncategorizedCompany === row.dataset.companyRow);
    if (uncategorized?.dataset.dirty === "true") permissions = { ...permissions, canViewUncategorized: uncategorized.checked };
    return { companyId: row.dataset.companyRow, role: row.querySelector(".team-company-role").value || null,
      active: row.querySelector(".team-company-input").checked, permissions: permissions && Object.keys(permissions).length ? permissions : null };
  }).filter(entry => entry.active);
}

function renderTeamCategoryAccess(selectedIds = [], canViewUncategorized = false) {
  const selected = new Set(selectedIds);
  const active = state.categories.filter((category) => category.active);
  // Setores agrupados por empresa (cada setor pertence a uma empresa).
  const roots = active.filter((category) => !category.parentId)
    .sort((left, right) => String(left.company?.name || "").localeCompare(String(right.company?.name || ""), "pt-BR"));
  $("#team-category-access").innerHTML = `<div class="team-category-groups">
    <input id="permission-uncategorized" type="checkbox" hidden ${canViewUncategorized ? "checked" : ""}>
    ${state.companies.map(company => {
      const user = state.adminUsers?.find(row => row.id === state.editingUserId);
      const permissions = user?.companyAccess?.find(entry => entry.companyId === company.id)?.permissions;
      const allowed = $("#team-role").value === "ADMIN" || (permissions?.canViewUncategorized ?? canViewUncategorized);
      return `<section class="team-category-group uncategorized" data-category-company="${escapeHtml(company.id)}"><label class="team-category-option root"><input type="checkbox" data-uncategorized-company="${escapeHtml(company.id)}" ${allowed ? "checked" : ""}><i class="category-dot uncategorized-dot"></i><span><b>Sem categoria ${companyBadge(company)}</b><small>Conversas ainda não classificadas nesta empresa.</small></span></label></section>`;
    }).join("")}
    ${roots.map((root) => {
    const children = active.filter((category) => category.parentId === root.id);
    const rootSelected = selected.has(root.id);
    return `<section class="team-category-group" data-category-group="${escapeHtml(root.id)}" data-category-company="${escapeHtml(root.companyId || "")}">
      <label class="team-category-option root"><input class="team-category-root team-category-access-input" type="checkbox" value="${escapeHtml(root.id)}" ${rootSelected ? "checked" : ""}><i class="category-dot" style="background:${root.color || "#999"}"></i><span><b>${escapeHtml(root.name)} ${multiCompany() ? companyBadge(root.company) : ""}</b><small>${children.length ? `${children.length} subcategoria${children.length === 1 ? "" : "s"}` : "Categoria principal"}</small></span></label>
      ${children.length ? `<div class="team-subcategory-list">${children.map((child) => `<label class="team-category-option child"><input class="team-category-access-input" type="checkbox" value="${escapeHtml(child.id)}" ${selected.has(child.id) ? "checked" : ""}><i class="category-dot" style="background:${child.color || root.color || "#999"}"></i><span>${escapeHtml(child.name)}</span></label>`).join("")}</div>` : ""}
    </section>`;
  }).join("")}</div>`;
}

function setTeamPane(name) {
  $("#team-form").scrollTop = 0;
  document.querySelectorAll("[data-team-pane]").forEach(pane => { pane.hidden = pane.dataset.teamPane !== name; });
  document.querySelectorAll("[data-team-tab]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.teamTab === name)));
}

function syncTeamNumbers() {
  const master = $("#team-role").value === "ADMIN";
  const allowed = new Set(teamCompanyAccessBody().map(row => row.companyId));
  document.querySelectorAll("#team-number-access input").forEach(input => {
    input.disabled = master || !allowed.has(input.dataset.companyId);
    input.closest("label").classList.toggle("number-unavailable", input.disabled);
  });
  document.querySelectorAll("#team-category-access [data-category-company]").forEach(group => {
    group.querySelectorAll("input").forEach(input => { input.disabled = master || !allowed.has(group.dataset.categoryCompany); });
  });
  $("#team-number-access").dataset.master = String(master);
}

function renderTeamNumberAccess() {
  const options = state.teamNumberOptions;
  const host = $("#team-number-access");
  if (!Array.isArray(options)) { host.textContent = "Não foi possível carregar os números. Os acessos atuais serão preservados ao salvar."; return; }
  const user = state.adminUsers?.find(row => row.id === state.editingUserId);
  const selected = new Set(user ? (user.channelAccountAccess || []).map(row => row.channelAccountId) : options.filter(row => row.defaultUserAccess).map(row => row.id));
  host.dataset.userKey = state.editingUserId || "new";
  host.innerHTML = '<p class="master-number-note">Master tem acesso a todos os números.</p>' + state.companies.map(company => {
    const rows = options.filter(row => row.companyId === company.id);
    if (!rows.length) return "";
    return `<section class="team-number-company"><h4>${escapeHtml(company.name)}</h4>${rows.map(row => `<label class="team-number-option"><input type="checkbox" value="${escapeHtml(row.id)}" data-company-id="${escapeHtml(row.companyId)}" ${selected.has(row.id) ? "checked" : ""}><span><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.displayNumber || "WhatsApp")}${!row.enabled || row.status !== "CONNECTED" ? " · Indisponível no momento" : ""}</small></span></label>`).join("")}</section>`;
  }).join("") || "<p>Nenhum número de WhatsApp cadastrado.</p>";
  syncTeamNumbers();
}

function syncMasterForm() {
  const master = $("#team-role").value === "ADMIN";
  document.querySelectorAll(".team-permissions input,.team-categories input,.team-companies input,.team-companies select").forEach((input) => { input.disabled = master; });
  if ($("#team-number-access").dataset.userKey !== (state.editingUserId || "new")) renderTeamNumberAccess();
  else syncTeamNumbers();
}

function resetTeamForm() {
  state.editingUserId = null;
  setTeamPane("account");
  window.CrmAccessAdmin?.load(null);
  $("#configure-conversation-observers").disabled = true;
  $("#team-form").reset();
  $("#team-role").value = "ATENDENTE";
  $("#team-active").checked = true;
  $("#team-active-field").hidden = true;
  $("#team-password").required = true;
  $("#team-password-label").textContent = "Senha inicial";
  $("#team-form-eyebrow").textContent = "NOVA CONTA";
  $("#team-form-title").textContent = "Adicionar membro";
  renderTeamCategoryAccess();
  renderTeamCompanyAccess();
  syncMasterForm();
}

function editTeamUser(userId) {
  const user = state.adminUsers.find((item) => item.id === userId);
  if (!user) return;
  state.editingUserId = user.id;
  setTeamPane("account");
  window.CrmAccessAdmin?.load(user.id);
  $("#configure-conversation-observers").disabled = user.role === "ADMIN";
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
  $("#permission-start-email-conversations").checked = user.canStartEmailConversations;
  $("#permission-start-whatsapp-conversations").checked = user.canStartWhatsAppConversations;
  $("#permission-merge-contacts").checked = user.canMergeContacts;
  $("#permission-manage-campaigns").checked = user.canManageCampaigns;
  $("#permission-own-productivity").checked = user.canViewOwnProductivity;
  $("#permission-after-hours").checked = Boolean(user.canManageAfterHours);
  $("#team-form-eyebrow").textContent = "EDITAR CONTA";
  $("#team-form-title").textContent = user.name;
  renderTeamCategoryAccess(user.categoryAccess.map((access) => access.categoryId), user.canViewUncategorized);
  renderTeamCompanyAccess(user.companyAccess || []);
  syncMasterForm();
}

function renderAdminUsers() {
  $("#team-count").textContent = `${state.adminUsers.length} conta${state.adminUsers.length === 1 ? "" : "s"}`;
  $("#team-user-list").innerHTML = state.adminUsers.map((user) => `<article class="team-user-card ${user.active ? "" : "inactive"}"><div class="team-user-main"><span class="team-user-avatar">${escapeHtml(initials(user.name))}</span><span class="team-user-info"><b>${escapeHtml(user.name)}</b><small>${escapeHtml(user.email || "Membro da equipe")}</small></span><span class="role-pill">${escapeHtml(roleLabel(user.role))}</span></div>${user.role === "ADMIN" ? `<div class="team-user-companies"><span class="team-user-company-all">Todas as empresas</span></div>` : `<div class="team-user-companies">${(user.companyAccess || []).filter((entry) => entry.active).map((entry) => `${companyBadge(entry.company)}${entry.role ? `<small>${escapeHtml(roleLabel(entry.role))}</small>` : ""}`).join(" ") || `<small class="team-user-no-company">Sem empresa</small>`}</div>`}<div class="team-user-meta"><span>${user._count.assignedConversations} conversa(s) atribuída(s)</span>${state.currentUser?.isMaster ? `<span>•</span><span>${user._count.sentMessages} resposta(s)</span>` : ""}${user.active ? "" : "<span>• Inativa</span>"}</div><div class="team-user-actions">${state.currentUser?.isMaster ? `<button type="button" data-edit-user="${escapeHtml(user.id)}">Editar</button>` : ""}<button type="button" data-view-user="${escapeHtml(user.id)}">Ver atendimentos</button></div></article>`).join("");
}

const auditActionLabel = (action) => ({
  USER_CREATED:"Conta criada", USER_UPDATED:"Conta alterada", CRM_ACCESS_ENABLED:"Acesso ao CRM ativado", CRM_ACCESS_DISABLED:"Acesso ao CRM desativado", CONTACTS_MERGED:"Contatos fundidos",
  CONVERSATION_DELETED:"Conversa apagada", CONVERSATION_PINNED:"Conversa fixada",
  CONVERSATION_UNPINNED:"Conversa desafixada", CONVERSATION_CATEGORY_CHANGED:"Categoria da conversa",
  CONVERSATION_ASSIGNEE_CHANGED:"Responsável da conversa", CONVERSATION_STATUS_CHANGED:"Status da conversa",
  CATEGORY_CREATED:"Categoria criada", CATEGORY_UPDATED:"Categoria alterada", NOTE_DELETED:"Nota apagada",
  BOT_CREATED:"Bot criado", BOT_UPDATED:"Bot alterado", BOT_STATUS_CHANGED:"Status do Bot",
  BOT_ARCHIVED:"Bot arquivado", BOT_SCHEDULES_UPDATED:"Horários do Bot",
  BOT_INTENT_CREATED:"Intenção criada", BOT_INTENT_UPDATED:"Intenção alterada",
  BOT_INTENT_DELETED:"Intenção removida",
  EMAIL_SPAM_CHANGED:"Classificação de spam alterada",
  TEMPLATE_ROUTING_CREATED:"Destino de template criado", TEMPLATE_ROUTING_UPDATED:"Destino de template alterado",
  TEMPLATE_ROUTING_ENABLED:"Destino de template ativado", TEMPLATE_ROUTING_DISABLED:"Destino de template desativado",
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
  if (companyQuery()) params.set("company", companyQuery());
  state.auditLogs = await api(`/api/admin/audit-logs?${params}`);
  renderAuditLogs();
}

async function loadAdminUsers() {
  if (!state.currentUser?.isMaster) return;
  const [users, numbers] = await Promise.all([api("/api/admin/users"), api("/api/admin/users/number-options").catch(() => null)]);
  state.adminUsers = users;
  state.teamNumberOptions = numbers;
  renderTeamNumberAccess();
  renderAdminUsers();
}

$("#conversation-list").addEventListener("click", (event) => {
  const card = event.target.closest(".conversation-card");
  // Trocar de conversa com áudio gravando/não enviado pede confirmação.
  if (card && card.dataset.id !== state.selectedId && !confirmDiscardComposerAudio()) return;
  if (card) openConversation(card.dataset.id).catch((error) => {
    if ($("#messages").querySelector(".skeleton-list")) $("#messages").innerHTML = `<div class="shared-empty">Não foi possível abrir esta conversa.</div>`;
    toast(error.message, true);
  });
});
document.querySelectorAll("[data-status]").forEach((button) => button.addEventListener("click", () => {
  if (button.dataset.status === "MINE") {
    state.assignedUser = ""; state.assignedUserActiveOnly = false;
    state.unassigned = false; state.preferredAssignee = ""; state.statusToggle.clear();
    document.querySelectorAll('[data-toggle-filter="unassigned"], [data-toggle-filter^="status:"]').forEach(item => item.classList.remove("active"));
    if ($("#preferred-assignee-filter")) $("#preferred-assignee-filter").value = "";
  }
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
// Filtro "Atendente fixo": Com/Sem/Meus clientes fixos para todos;
// "Atendente fixo = X" só Master/Supervisor (o backend revalida).
function canSupervisePreferredAssignees() {
  return Boolean(state.currentUser?.isMaster || state.companies.some((company) => company.role === "SUPERVISOR"));
}

function renderPreferredAssigneeFilter() {
  const select = $("#preferred-assignee-filter");
  if (!select) return;
  const people = canSupervisePreferredAssignees() ? (state.users || []).filter((user) => user.id !== state.currentUser?.id) : [];
  select.innerHTML = `<option value="">Atendente fixo: todos</option><option value="ANY">Com atendente fixo</option><option value="NONE">Sem atendente fixo</option><option value="ME">Meus clientes fixos</option>${people.map((user) => `<option value="${escapeHtml(user.id)}">Atendente fixo = ${escapeHtml(user.name)}</option>`).join("")}`;
  select.value = state.preferredAssignee || "";
}
$("#preferred-assignee-filter")?.addEventListener("change", (event) => {
  state.preferredAssignee = event.target.value;
  loadConversations();
});

// Atendente fixo — diálogo Definir/Alterar e Remover (painel do contato).
let preferredAssigneeContext = null;
let preferredAssigneeBusy = false;
let preferredAssigneeRequest = 0;
function preferredAssigneeLoading(loading, text = "") {
  $("#preferred-assignee-feedback").textContent = text;
  $("#preferred-assignee-dialog").setAttribute("aria-busy", String(loading));
  for (const selector of ["#preferred-assignee-user", "#preferred-assignee-enabled", "#preferred-assignee-reason", "#preferred-assignee-form button[type='submit']"]) $(selector).disabled = loading;
}
$("#context-details-summary").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-preferred-assignee-action]");
  if (!button || !state.selectedContactId || preferredAssigneeBusy) return;
  const contactId = state.selectedContactId;
  const conversationId = state.selectedId;
  const request = ++preferredAssigneeRequest;
  preferredAssigneeBusy = true;
  try {
    if (button.dataset.preferredAssigneeAction === "remove") {
      if (!confirm("Remover o atendente fixo deste cliente?\n\nOs próximos atendimentos voltam a passar pelo Bot/triagem. A conversa atual não muda.")) return;
      button.disabled = true;
      button.textContent = "Removendo…";
      await api(`/api/contacts/${encodeURIComponent(contactId)}/preferred-assignee`, { method:"DELETE", body: JSON.stringify({}) });
      toast("Atendente fixo removido.");
      if (state.selectedId === conversationId) await openConversation(conversationId, { refreshList: true, markRead: false });
      return;
    }
    preferredAssigneeContext = null;
    $("#preferred-assignee-contact").textContent = `Cliente: ${state.selectedContactName}. Novos atendimentos vão direto para o atendente escolhido.`;
    $("#preferred-assignee-user").innerHTML = '<option value="">Carregando…</option>';
    $("#preferred-assignee-reason").value = "";
    preferredAssigneeLoading(true, "Carregando atendentes…");
    $("#preferred-assignee-dialog").showModal();
    const [current, candidates] = await Promise.all([
      api(`/api/contacts/${encodeURIComponent(contactId)}/preferred-assignee`),
      api(`/api/contacts/${encodeURIComponent(contactId)}/preferred-assignee/candidates`),
    ]);
    if (request !== preferredAssigneeRequest || !$("#preferred-assignee-dialog").open) return;
    preferredAssigneeContext = { contactId, conversationId };
    $("#preferred-assignee-contact").textContent = `Cliente: ${state.selectedContactName}. Novos atendimentos vão direto para o atendente escolhido.`;
    $("#preferred-assignee-user").innerHTML = `<option value="">Selecione</option>${candidates.map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)} · ${escapeHtml(roleLabel(user.role))}</option>`).join("")}`;
    $("#preferred-assignee-user").value = current.assignee?.id || "";
    $("#preferred-assignee-enabled").checked = current.assignee ? current.autoRouteEnabled : true;
    $("#preferred-assignee-reason").value = "";
    preferredAssigneeLoading(false);
  } catch (error) {
    if (request === preferredAssigneeRequest) {
      if ($("#preferred-assignee-dialog").open) preferredAssigneeLoading(true, error.message);
      toast(error.message, true);
    }
  } finally {
    if (request === preferredAssigneeRequest) preferredAssigneeBusy = false;
    if (button.isConnected) { button.disabled = false; if (button.dataset.preferredAssigneeAction === "remove") button.textContent = "Remover"; }
  }
});
$("#preferred-assignee-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!preferredAssigneeContext || preferredAssigneeBusy) return;
  const context = preferredAssigneeContext;
  preferredAssigneeBusy = true;
  try {
    const body = JSON.stringify({ userId: $("#preferred-assignee-user").value, enabled: $("#preferred-assignee-enabled").checked, reason: $("#preferred-assignee-reason").value.trim() || null });
    preferredAssigneeLoading(true, "Salvando…");
    await api(`/api/contacts/${encodeURIComponent(context.contactId)}/preferred-assignee`, {
      method:"PUT",
      body,
    });
    $("#preferred-assignee-dialog").close();
    toast("Atendente fixo salvo.");
    if (state.selectedId === context.conversationId) await openConversation(context.conversationId, { refreshList: true, markRead: false });
  } catch (error) { preferredAssigneeLoading(false, error.message); toast(error.message, true); }
  finally { preferredAssigneeBusy = false; }
});
$("#cancel-preferred-assignee").addEventListener("click", () => $("#preferred-assignee-dialog").close());
$("#close-preferred-assignee").addEventListener("click", () => $("#preferred-assignee-dialog").close());
$("#preferred-assignee-dialog").addEventListener("close", () => { preferredAssigneeContext = null; ++preferredAssigneeRequest; preferredAssigneeBusy = false; });

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
  "": { key:"all", title:"Conversas", eyebrow:"TODOS OS CANAIS DA EMPRESA" },
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
$("#refresh").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const company = companyQuery();
  if (!company || button.disabled) return;
  const epoch = workspace.epoch;
  button.disabled = true;
  clearTimeout(searchTimer);
  for (const key of WORKSPACE_FILTER_KEYS) state[key] = WORKSPACE_FILTER_DEFAULTS[key];
  state.statusToggle.clear();
  state.priorityToggle.clear();
  setChannelWorkspace("", { load: false });
  syncWorkspaceFilterControls();
  saveWorkspaceFilters();
  document.querySelectorAll(".filter").forEach((item) => item.classList.remove("active"));
  document.querySelector('[data-status=""]')?.classList.add("active");
  try {
    const visibility = await api("/api/category-visibility", { method: "PATCH", body: JSON.stringify({ reset: true, company }) });
    if (epoch !== workspace.epoch) return;
    state.categoryVisibility = visibility;
    await loadCategories();
  } catch (error) {
    if (epoch === workspace.epoch) toast(`Não foi possível restaurar a exibição das categorias. ${error.message}`, true);
  } finally {
    button.disabled = false;
    if (epoch === workspace.epoch) loadConversations().catch((error) => toast(error.message, true));
  }
});
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
    if(window.ContactWarning&&!(await window.ContactWarning.confirm({company:state.companyFilter,accountId:$("#outbound-meta-account").value,phone:$("#outbound-meta-phone").value.trim()})))return;
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
  if (innerWidth <= 700) { openMobileDrawer("filters"); return; }
  setFiltersPanelCollapsed(!$(".workspace").classList.contains("filters-collapsed"));
});
$("#toggle-conversation-list").addEventListener("click", () => {
  if (innerWidth <= 1000) {
    if (innerWidth <= 700) { mobileBack(); return; }
    setConversationListCollapsed(false);
    $("#chat-panel").classList.remove("open");
    closeContextPanel();
    return;
  }
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
$("#sidebar-toggle").addEventListener("click", () => {
  if (innerWidth <= 700) { openMobileDrawer("menu"); return; }
  $("#app-sidebar").classList.toggle("mobile-open");
});
document.addEventListener("click", (event) => {
  if (innerWidth <= 700 || innerWidth > 1000) return;
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
$("#templates-library-button").addEventListener("click", () => { location.href = "/templates"; });
$("#campaigns-button").addEventListener("click", () => { location.href = "/campaigns"; });
window.setContextTabFromFollowUps = () => setContextTab("agenda");
$("#metrics-button").addEventListener("click", () => { location.href = "/metricas"; });
$("#conversation-settings-button").addEventListener("click", () => { location.href = "/configuracoes"; });
$("#integrations-button").addEventListener("click", () => { location.href = "/integrations"; });
$("#user-button").addEventListener("click", async () => { await api("/api/auth/logout", { method:"POST" }); window.CentralSessionState?.clear();state.currentUser=null; location.replace("/login.html"); });
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
for (const [selector,field,label] of [['#copy-contact-name','copyName','Nome'],['#copy-contact-phone','copyPhone','Número']]) {
  $(selector).addEventListener('click',async()=>{
    const dialog=$('#contact-files-dialog');
    if(!dialog.open||$('#contact-files-conversation-id').textContent!==state.selectedId)return;
    const value=dialog.dataset[field];if(!value)return;
    try{await navigator.clipboard.writeText(value);toast(`${label} copiado.`);}catch{toast(`Não foi possível copiar ${label.toLowerCase()}.`,true);}
  });
}
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
  if (view) {
    $("#team-dialog").close();
    window.WaSupervision.open({ memberId: view.dataset.viewUser, tab: "history" }).catch((error) => toast(error.message, true));
  }
});
$("#team-category-access").addEventListener("change", event => {
  const input = event.target.closest("[data-uncategorized-company]");
  if (!input) return;
  input.dataset.dirty = "true";
  const row = [...document.querySelectorAll("[data-company-row]")].find(row => row.dataset.companyRow === input.dataset.uncategorizedCompany);
  const mirror = row?.querySelector('[data-company-permission="canViewUncategorized"]');
  if (mirror) mirror.checked = input.checked;
});
$("#team-company-access").addEventListener("change", event => {
  const row = event.target.closest("[data-company-row]");
  if (!row) return;
  const tile = [...document.querySelectorAll("[data-uncategorized-company]")].find(input => input.dataset.uncategorizedCompany === row.dataset.companyRow);
  if (!tile) return;
  if (event.target.matches('[data-company-permission="canViewUncategorized"]')) { tile.checked = event.target.checked; tile.dataset.dirty = "true"; }
  if (event.target.matches('.team-company-custom') && !event.target.checked) { tile.checked = $("#permission-uncategorized").checked; delete tile.dataset.dirty; }
});
$("#configure-conversation-observers").addEventListener("click", () => {
  if (!state.currentUser?.isMaster || !state.editingUserId) return;
  const observerId = state.editingUserId;
  $("#team-dialog").close();
  window.WaSupervision.open({ observerId }).catch((error) => toast(error.message, true));
});
document.querySelector(".team-editor-tabs").addEventListener("click", event => {
  const button = event.target.closest("[data-team-tab]");
  if (button) setTeamPane(button.dataset.teamTab);
});
$("#team-form").addEventListener("invalid", event => {
  const pane = event.target.closest("[data-team-pane]");
  if (pane) setTeamPane(pane.dataset.teamPane);
}, true);
$("#team-company-access").addEventListener("change", syncTeamNumbers);
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
    canStartEmailConversations: $("#permission-start-email-conversations").checked,
    canStartWhatsAppConversations: $("#permission-start-whatsapp-conversations").checked,
    canMergeContacts: $("#permission-merge-contacts").checked,
    canManageCampaigns: $("#permission-manage-campaigns").checked,
    canViewOwnProductivity: $("#permission-own-productivity").checked,
    canManageAfterHours: $("#permission-after-hours").checked,
    categoryIds: [...document.querySelectorAll("#team-category-access .team-category-access-input:checked")].map((input) => input.value),
    companyAccess: teamCompanyAccessBody(),
  };
  if (body.role !== "ADMIN") body.categoryIds = [...document.querySelectorAll("#team-category-access .team-category-access-input:checked:not(:disabled)")].map(input => input.value);
  if (Array.isArray(state.teamNumberOptions) && body.role !== "ADMIN") body.channelAccountIds = [...document.querySelectorAll("#team-number-access input:checked:not(:disabled)")].map(input => input.value);
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
  setDialogError("#transfer-error");
  $("#transfer-dialog").showModal();
}
// Erro dentro do diálogo: o toast fica atrás da camada do <dialog> modal e o
// atendente via só o diálogo parado, como se o botão não tivesse funcionado.
function setDialogError(selector, message = "") {
  $(selector).textContent = message;
  $(selector).hidden = !message;
}
async function confirmConversationCategory(event) {
  event.preventDefault();
  const button = $("#confirm-category");
  const categoryId = pendingCategoryId();
  if (!state.selectedId || categoryId === state.selectedCategoryId) return;
  const submit = event.submitter || $('#transfer-form [type="submit"]');
  if (submit.disabled) return;
  const label = submit.textContent;
  submit.disabled = true;
  submit.textContent = "Transferindo...";
  button.disabled = true;
  setDialogError("#transfer-error");
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
    setDialogError("#transfer-error", `Não foi possível transferir: ${e.message}`);
    openConversation(state.selectedId, { markRead:false }).catch(() => {});
  } finally { submit.disabled = false; submit.textContent = label; syncCategoryConfirmation(); }
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
    setDialogError("#user-transfer-error");
    $("#user-transfer-dialog").showModal();
    return;
  }
  try { await saveAssignee(assignedUserId); } catch (e) { revertAssigneeSelect(); toast(e.message, true); }
});
$("#user-transfer-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!pendingUserTransferId) return;
  const submit = event.submitter || $('#user-transfer-form [type="submit"]');
  if (submit.disabled) return;
  const label = submit.textContent;
  submit.disabled = true;
  submit.textContent = "Transferindo...";
  setDialogError("#user-transfer-error");
  try {
    await saveAssignee(pendingUserTransferId, {
      shareHistory: $("#user-transfer-share-history").checked,
      transferReason: $("#user-transfer-reason").value.trim() || null,
      handoffSummary: $("#user-transfer-summary").value.trim() || null,
    });
    pendingUserTransferId = null;
    $("#user-transfer-dialog").close();
  } catch (e) {
    setDialogError("#user-transfer-error", `Não foi possível transferir: ${e.message}`);
  } finally { submit.disabled = false; submit.textContent = label; }
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
$("#category-form").addEventListener("submit", async (event) => { event.preventDefault(); const name = $("#category-name").value.trim(); const color = $("#category-color").value; const parentId = $("#category-parent").value || null; const companyId = $("#category-company").value || undefined; const masterOnly = Boolean(state.currentUser?.isMaster && $("#category-master-only").checked); try { await api("/api/categories", { method:"POST", body:JSON.stringify({ name, color, parentId, masterOnly, companyId }) }); $("#category-name").value = ""; $("#category-master-only").checked = false; await loadCategories(); await loadConversations(); toast(parentId ? "Subcategoria criada." : "Categoria criada."); } catch (e) { toast(e.message, true); } });
$("#category-manager-list").addEventListener("submit", async (event) => { event.preventDefault(); const row = event.target.closest("[data-category-id]"); const name = row.querySelector(".managed-name").value.trim(); const color = row.querySelector(".managed-color").value; const parentId = row.querySelector(".managed-parent").value || null; const active = row.querySelector(".managed-active").checked; const privateToggle = row.querySelector(".managed-private"); const visibility = privateToggle ? { visibilityMode: privateToggle.checked ? "SECTOR_PRIVATE" : "NORMAL" } : {}; const masterOnly = row.querySelector(".managed-master-only")?.checked; try { await api(`/api/categories/${row.dataset.categoryId}`, { method:"PATCH", body:JSON.stringify({ name, color, parentId, active, ...visibility, ...(masterOnly === undefined ? {} : { masterOnly }) }) }); await loadCategories(); await loadConversations(); toast("Categoria atualizada."); } catch (e) { toast(e.message, true); } });
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

  // Extensão ajuda o seletor; o servidor decide a conversão pelos bytes.
  const conversionTypes = { heic:'image/heic',heif:'image/heif',heics:'image/heic-sequence',tif:'image/tiff',tiff:'image/tiff',bmp:'image/bmp', webp:'image/webp', gif:'image/gif', mov:'video/quicktime', avi:'video/x-msvideo' };
  const conversionType = conversionTypes[(file.name || '').split('.').pop().toLowerCase()];
  const needsConversion = Boolean(conversionType || [...Object.values(conversionTypes), 'image/x-ms-bmp', 'video/avi','image/x-tiff','image/heif-sequence'].includes(file.type));
  if (needsConversion && state.selectedChannel !== 'META') return toast('A conversão destes formatos está disponível apenas no WhatsApp.', true);
  if (conversionType && file.type !== conversionType) file = new File([file], file.name, { type: conversionType });

  // Áudio vai para o painel de áudio (preview + Enviar), não para o anexo comum.
  if (isAudioFile(file)) {
    clearSelectedAttachment();
    selectAudioFile(file).catch((error) => toast(error.message, true));
    return;
  }

  const isImage = ["image/jpeg", "image/png", "image/bmp", "image/x-ms-bmp", "image/webp"].includes(file.type);
  const isDocument = isDocumentMime(file.type);
  const isVideo = ["video/mp4", "video/3gpp", "video/3gp", "video/quicktime", "video/x-msvideo", "video/avi", "image/gif"].includes(file.type);

  if (!isImage && !isDocument && !isVideo) {
    clearSelectedAttachment();

    return toast(
      "Envie uma imagem JPG/PNG, vídeo MP4/3GP, áudio OGG/MP3/M4A/AAC/AMR ou documento PDF/TXT/Word/Excel/PowerPoint.",
      true
    );
  }

  if(needsConversion&&isDocument&&file.size>16*1024*1024){clearSelectedAttachment();return toast('O arquivo para conversão deve ter no máximo 16 MB.',true);}
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
  $("#attachment-name").textContent = (file.name || "Imagem colada") + (needsConversion ? (isDocument?' — será convertido em PDF ao enviar':' — será convertido ao enviar') : '');
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
// ===== Áudio no composer =====
// Gravação pelo microfone (MediaRecorder) ou arquivo escolhido. Nada é
// enviado sozinho: concluir a gravação, escolher arquivo ou selecionar uma
// resposta rápida de áudio só carrega o player — o envio é o clique em
// "Enviar". O servidor normaliza o formato (WebM do Chrome vira OGG/Opus).
const AUDIO_CHANNELS = new Set(["META"]);
const AUDIO_MAX_RECORDING_MS = 5 * 60 * 1000;
const AUDIO_MAX_FILE_SIZE = 16 * 1024 * 1024;
const AUDIO_FILE_EXTENSIONS = /\.(ogg|oga|opus|mp3|m4a|mp4|aac|amr|webm|wav|flac)$/i;

function isAudioRecording() { return Boolean(audioRecorder.recorder && audioRecorder.recorder.state !== "inactive"); }
function hasUnsentComposerAudio() { return isAudioRecording() || Boolean(pendingAudio); }
function canSendAudioHere() { return Boolean(state.selectedId) && AUDIO_CHANNELS.has(state.selectedChannel); }
function supportsAudioRecording() { return Boolean(window.MediaRecorder && navigator.mediaDevices?.getUserMedia); }
function isAudioFile(file) { return Boolean(file) && (String(file.type).startsWith("audio/") || (!file.type && AUDIO_FILE_EXTENSIONS.test(file.name || ""))); }
function formatAudioDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
function shortAudioDuration(ms) {
  const total = Math.round((Number(ms) || 0) / 1000);
  if (!total) return "—";
  return total >= 60 ? `${Math.floor(total / 60)}min ${String(total % 60).padStart(2, "0")}s` : `${total}s`;
}
// Ordem de preferência: OGG/Opus (Firefox) e WebM/Opus (Chrome/Edge, o
// servidor converte para OGG sem recodificar) antes de MP4/AAC (Safari/iOS).
function pickRecorderMimeType() {
  const candidates = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm"];
  return candidates.find((type) => { try { return MediaRecorder.isTypeSupported(type); } catch { return false; } }) || "";
}
function audioExtensionFor(type) {
  return ({ "audio/ogg":"ogg", "audio/webm":"webm", "audio/mp4":"m4a", "audio/mpeg":"mp3", "audio/aac":"aac" })[String(type).split(";", 1)[0]] || "webm";
}
function recordingElapsedMs() {
  if (!audioRecorder.startedAt) return 0;
  return (audioRecorder.pausedAt || Date.now()) - audioRecorder.startedAt - audioRecorder.pausedTotal;
}
// Duração de um arquivo pelo próprio navegador (WebM gravado no Chrome não
// traz duração — nesse caso vale o cronômetro da gravação).
function measureAudioDuration(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const probe = new Audio();
    const done = (value) => { clearTimeout(timer); URL.revokeObjectURL(url); probe.removeAttribute("src"); resolve(value); };
    const timer = setTimeout(() => done(null), 4000);
    probe.preload = "metadata";
    probe.addEventListener("loadedmetadata", () => done(Number.isFinite(probe.duration) && probe.duration > 0 ? Math.round(probe.duration * 1000) : null));
    probe.addEventListener("error", () => done(null));
    probe.src = url;
  });
}

function syncAudioAvailability() {
  const button = $("#record-audio");
  if (!button) return;
  const windowClosed = $("#composer").classList.contains("window-closed");
  const allowed = canSendAudioHere() && !windowClosed;
  button.disabled = !allowed || isAudioRecording();
  $("#choose-audio").disabled = button.disabled;
  $("#choose-audio").title = !allowed ? "Envio de áudio indisponível neste canal ou janela" : "Escolher arquivo de áudio";
  button.title = !canSendAudioHere() ? "Este canal ainda não suporta envio de áudio"
    : (windowClosed ? "Janela de 24 horas encerrada — use um template" : (supportsAudioRecording() ? "Gravar áudio" : "Gravar áudio (abre o gravador do aparelho)"));
  button.setAttribute("aria-label", button.title);
}

function syncAudioComposer() {
  const recording = isAudioRecording();
  const paused = audioRecorder.recorder?.state === "paused";
  const panel = $("#audio-composer");
  panel.hidden = !recording && !pendingAudio;
  panel.classList.toggle("paused", paused);
  $("#composer").classList.toggle("audio-mode", !panel.hidden);
  panel.querySelector("[data-audio-recording]").hidden = !recording;
  panel.querySelector("[data-audio-preview]").hidden = recording || !pendingAudio;
  $("#audio-pause").hidden = !recording || typeof audioRecorder.recorder?.pause !== "function";
  $("#audio-pause").textContent = paused ? "Continuar" : "Pausar";
  $("#audio-rec-label").textContent = paused ? "Pausado" : "Gravando…";
  $("#audio-timer").textContent = formatAudioDuration(recordingElapsedMs());
  if (pendingAudio) {
    $("#audio-preview-duration").textContent = pendingAudio.durationMs ? formatAudioDuration(pendingAudio.durationMs) : "--:--";
    $("#audio-source-label").textContent = pendingAudio.quickReplyName ? `🎤 ${pendingAudio.quickReplyName}` : "🎤";
    $("#audio-source-label").title = pendingAudio.quickReplyName ? "Resposta rápida de áudio" : "";
    $("#audio-save-quick-reply").hidden = Boolean(pendingAudio.quickReplyId);
    $("#audio-rerecord").hidden = !supportsAudioRecording();
  }
  syncAudioAvailability();
}

function setPendingAudio(audio) {
  if (pendingAudioUrl) URL.revokeObjectURL(pendingAudioUrl);
  pendingAudioUrl = null;
  pendingAudio = audio;
  const player = $("#audio-preview-player");
  player.pause();
  if (audio) {
    pendingAudioUrl = URL.createObjectURL(audio.blob);
    player.src = pendingAudioUrl;
  } else {
    player.removeAttribute("src");
    player.load();
  }
  syncAudioComposer();
}

function releaseMicrophone() {
  audioRecorder.stream?.getTracks().forEach((track) => track.stop());
  audioRecorder.stream = null;
}
function resetRecorderState() {
  clearInterval(audioRecorder.timer);
  releaseMicrophone();
  Object.assign(audioRecorder, { recorder:null, chunks:[], startedAt:0, pausedAt:0, pausedTotal:0, timer:null, discard:false, mimeType:"" });
}

async function startAudioRecording() {
  if (!state.selectedId || isAudioRecording()) return;
  if (!canSendAudioHere()) return toast("Este canal ainda não suporta envio de áudio.", true);
  if (pendingAudio && !confirm("Descartar o áudio atual e gravar outro?")) return;
  // Sem MediaRecorder (navegadores antigos/WebViews): gravador nativo do aparelho.
  if (!supportsAudioRecording()) return $("#audio-capture-input").click();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:true, noiseSuppression:true } });
  } catch (error) {
    const denied = ["NotAllowedError", "SecurityError", "PermissionDeniedError"].includes(error?.name);
    return toast(denied
      ? "Permissão de microfone necessária para gravar áudio. Você ainda pode enviar um arquivo de áudio pelo +."
      : "Não foi possível acessar o microfone. Você ainda pode enviar um arquivo de áudio pelo +.", true);
  }
  setPendingAudio(null);
  const mimeType = pickRecorderMimeType();
  let recorder;
  try { recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined); }
  catch {
    stream.getTracks().forEach((track) => track.stop());
    return toast("Este navegador não conseguiu iniciar a gravação. Envie um arquivo de áudio pelo +.", true);
  }
  Object.assign(audioRecorder, { recorder, stream, chunks:[], startedAt:Date.now(), pausedAt:0, pausedTotal:0, discard:false, mimeType: recorder.mimeType || mimeType });
  recorder.addEventListener("dataavailable", (event) => { if (event.data?.size) audioRecorder.chunks.push(event.data); });
  recorder.addEventListener("stop", () => {
    const durationMs = recordingElapsedMs();
    const { discard, chunks } = audioRecorder;
    const type = audioRecorder.mimeType || chunks[0]?.type || "audio/webm";
    resetRecorderState();
    const blob = new Blob(chunks, { type });
    if (discard || !blob.size) return syncAudioComposer();
    if (blob.size > AUDIO_MAX_FILE_SIZE) { toast("A gravação passou de 16 MB e foi descartada.", true); return syncAudioComposer(); }
    setPendingAudio({ blob, durationMs, fileName:`gravacao.${audioExtensionFor(type)}`, source:"recording" });
  });
  recorder.start(1000);
  audioRecorder.timer = setInterval(() => {
    $("#audio-timer").textContent = formatAudioDuration(recordingElapsedMs());
    if (isAudioRecording() && recordingElapsedMs() >= AUDIO_MAX_RECORDING_MS) {
      stopAudioRecording();
      toast("Limite de 5 minutos atingido. Revise o áudio antes de enviar.");
    }
  }, 250);
  syncAudioComposer();
}

function stopAudioRecording() {
  if (!isAudioRecording()) return;
  if (audioRecorder.pausedAt) {
    audioRecorder.pausedTotal += Date.now() - audioRecorder.pausedAt;
    audioRecorder.pausedAt = 0;
  }
  audioRecorder.recorder.stop();
}

function toggleAudioPause() {
  const recorder = audioRecorder.recorder;
  if (!recorder) return;
  if (recorder.state === "recording" && typeof recorder.pause === "function") {
    recorder.pause();
    audioRecorder.pausedAt = Date.now();
  } else if (recorder.state === "paused") {
    recorder.resume();
    audioRecorder.pausedTotal += Date.now() - audioRecorder.pausedAt;
    audioRecorder.pausedAt = 0;
  }
  syncAudioComposer();
}

// Cancelar/descartar: blob temporário descartado, nada persistido nem
// enviado, microfone liberado.
function discardComposerAudio() {
  if (isAudioRecording()) {
    audioRecorder.discard = true;
    audioRecorder.recorder.stop();
  } else {
    resetRecorderState();
  }
  setPendingAudio(null);
}

function confirmDiscardComposerAudio() {
  if (!hasUnsentComposerAudio()) return true;
  const message = isAudioRecording()
    ? "Há uma gravação de áudio em andamento. Descartar a gravação?"
    : "Há um áudio no composer que ainda não foi enviado. Descartar o áudio?";
  if (!confirm(message)) return false;
  discardComposerAudio();
  return true;
}

async function selectAudioFile(file) {
  if (!file) return;
  if (!canSendAudioHere()) throw new Error("Este canal ainda não suporta envio de áudio.");
  if (!isAudioFile(file)) throw new Error("Formato de áudio não suportado. Use OGG (Opus), MP3, M4A, AAC ou AMR.");
  if (file.size > AUDIO_MAX_FILE_SIZE) throw new Error("O áudio deve ter no máximo 16 MB.");
  if (isAudioRecording()) throw new Error("Conclua ou cancele a gravação antes de escolher um arquivo.");
  if (pendingAudio && !confirm("Substituir o áudio atual do composer?")) return;
  const durationMs = await measureAudioDuration(file);
  if (durationMs && durationMs > 10 * 60 * 1000) throw new Error("O áudio deve ter no máximo 10 minutos.");
  setPendingAudio({ blob:file, durationMs, fileName:file.name || "audio", source:"file" });
}

async function loadQuickReplyAudioIntoComposer(result) {
  if (isAudioRecording()) return toast("Conclua ou cancele a gravação antes de escolher outro áudio.", true);
  if (pendingAudio && !confirm("Substituir o áudio atual do composer?")) return;
  const response = await fetch(result.audio.url, { credentials:"same-origin" });
  if (!response.ok) return toast("Não foi possível carregar o áudio da resposta rápida.", true);
  const blob = await response.blob();
  setPendingAudio({
    blob, durationMs: result.audio.durationMs, fileName: result.audio.fileName || "resposta-rapida.ogg",
    source:"quick-reply", quickReplyId: result.quickReply.id, quickReplyName: result.quickReply.name,
  });
  toast("Áudio carregado. Ouça e clique em Enviar para mandar.");
}

async function sendPendingAudio() {
  if (!pendingAudio || !state.selectedId) return;
  if (!composerSendGuard.acquire()) return;
  const audio = pendingAudio;
  const conversationId = state.selectedId;
  const form = new FormData();
  form.append("audio", audio.blob, audio.fileName);
  if (audio.durationMs) form.append("durationMs", String(Math.round(audio.durationMs)));
  window.ChatFeatures?.appendReply(form, conversationId);
  $("#send-button").disabled = true;
  try {
    if(window.ContactWarning&&!(await window.ContactWarning.confirm({conversationId})))return;
    if(state.selectedId!==conversationId)return;
    await api(`/api/conversations/${conversationId}/audios`, { method:"POST", body:form });
    window.ChatFeatures?.onSent(conversationId);
    if (pendingAudio === audio) setPendingAudio(null);
    if (state.selectedId === conversationId) await openConversation(conversationId);
  } catch (e) {
    // Em erro o áudio continua no composer para tentar de novo.
    if (e.customerServiceWindow) state.customerServiceWindow = e.customerServiceWindow;
    toast(e.message, true);
  } finally {
    composerSendGuard.release();
    syncCustomerServiceWindow();
    syncAudioAvailability();
  }
}

function closeAttachmentMenu() {
  $("#attachment-menu").hidden = true;
  $("#open-attachments").setAttribute("aria-expanded", "false");
}
$("#open-attachments").addEventListener("click", () => {
  const menu = $("#attachment-menu");
  const opening = menu.hidden;
  menu.hidden = !opening;
  $("#open-attachments").setAttribute("aria-expanded", String(opening));
  if (opening) menu.querySelector("button:not(:disabled)")?.focus();
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".composer-attach")) closeAttachmentMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#attachment-menu").hidden) {
    closeAttachmentMenu();
    $("#open-attachments").focus();
  }
});
$("#choose-attachment").addEventListener("click", () => {
  closeAttachmentMenu();
  $("#attachment-input").click();
});
$("#choose-audio").addEventListener("click", () => {
  closeAttachmentMenu();
  $("#audio-file-input").click();
});
$("#audio-file-input").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  selectAudioFile(file).catch((error) => toast(error.message, true));
});
$("#record-audio").addEventListener("click", () => {
  closeAttachmentMenu();
  startAudioRecording().catch((error) => toast(error.message, true));
});
$("#audio-stop").addEventListener("click", stopAudioRecording);
$("#audio-pause").addEventListener("click", toggleAudioPause);
$("#audio-cancel").addEventListener("click", discardComposerAudio);
$("#audio-discard").addEventListener("click", discardComposerAudio);
$("#audio-rerecord").addEventListener("click", () => { setPendingAudio(null); startAudioRecording().catch((error) => toast(error.message, true)); });
$("#audio-save-quick-reply").addEventListener("click", () => { if (pendingAudio) openAudioQuickReplyDialog({ audio: pendingAudio }); });
$("#audio-capture-input").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  selectAudioFile(file).catch((error) => toast(error.message, true));
});
// Fechar/recarregar a página com áudio não enviado pede confirmação do navegador.
window.addEventListener("beforeunload", (event) => {
  if (!hasUnsentComposerAudio()) return;
  event.preventDefault();
  event.returnValue = "";
});

// ===== Resposta rápida pessoal de áudio (criar/editar/excluir) =====
const audioQuickReplyEditor = { item:null, audio:null, url:null };

function setAudioQuickReplyPlayer(src, durationMs) {
  if (audioQuickReplyEditor.url) URL.revokeObjectURL(audioQuickReplyEditor.url);
  audioQuickReplyEditor.url = null;
  const player = $("#aqr-player");
  player.pause();
  if (src instanceof Blob) {
    audioQuickReplyEditor.url = URL.createObjectURL(src);
    player.src = audioQuickReplyEditor.url;
  } else if (src) player.src = src;
  else { player.removeAttribute("src"); player.load(); }
  player.hidden = !src;
  $("#aqr-duration").textContent = src ? (durationMs ? formatAudioDuration(durationMs) : "") : "Nenhum áudio selecionado";
}

// Áudio pessoal: opcionalmente restrito a uma empresa (só aparece nas
// conversas dela). Setores listados são os da empresa escolhida.
function audioQuickReplyCategoryOptions(selectedId, companyId = $("#aqr-company")?.value || "") {
  const active = orderedCategories(state.categories.filter((category) => category.active && (!companyId || category.companyId === companyId)));
  return `<option value="">Sem categoria</option>` + active.map((category) => (
    `<option value="${escapeHtml(category.id)}" ${category.id === selectedId ? "selected" : ""}>${escapeHtml(category.parentId ? `↳ ${category.name}` : category.name)}${!companyId && multiCompany() && category.company ? ` — ${escapeHtml(category.company.displayName)}` : ""}</option>`
  )).join("");
}

function renderAudioQuickReplyCompany(companyId = "") {
  $("#aqr-company").innerHTML = `<option value="">Todas as minhas empresas</option>` + state.companies.map((company) => (
    `<option value="${escapeHtml(company.id)}" ${company.id === companyId ? "selected" : ""}>${escapeHtml(company.name)}</option>`
  )).join("");
  $("#aqr-company-field").hidden = !multiCompany();
}
$("#aqr-company")?.addEventListener("change", () => { $("#aqr-category").innerHTML = audioQuickReplyCategoryOptions(""); });

function suggestAudioShortcut(name) {
  const base = normalizeSearchTerm(name).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);
  return base ? `/${base}_audio` : "/";
}

function openAudioQuickReplyDialog({ item = null, audio = null } = {}) {
  audioQuickReplyEditor.item = item;
  audioQuickReplyEditor.audio = audio ? { blob: audio.blob, durationMs: audio.durationMs, fileName: audio.fileName } : null;
  $("#aqr-title").textContent = item ? "Editar áudio" : "Salvar áudio";
  $("#aqr-name").value = item?.name || "";
  $("#aqr-shortcut").value = item?.shortcut || "";
  $("#aqr-shortcut").dataset.touched = item ? "true" : "";
  // Novo áudio gravado numa conversa: já sugere a empresa dela.
  renderAudioQuickReplyCompany(item ? (item.companyId || "") : (state.selectedCompanyId || ""));
  $("#aqr-category").innerHTML = audioQuickReplyCategoryOptions(item?.categoryId || "");
  $("#aqr-file").value = "";
  $("#aqr-file-label").textContent = item || audio ? "Substituir por um arquivo" : "Escolher arquivo de áudio";
  $("#aqr-use-composer").hidden = !(item && pendingAudio);
  $("#aqr-delete").hidden = !item;
  if (audio) setAudioQuickReplyPlayer(audio.blob, audio.durationMs);
  else setAudioQuickReplyPlayer(item?.audio?.url || null, item?.audio?.durationMs);
  if ($("#quick-reply-dialog").open) $("#quick-reply-dialog").close();
  $("#audio-quick-reply-dialog").showModal();
  $("#aqr-name").focus();
}

function closeAudioQuickReplyDialog() {
  $("#audio-quick-reply-dialog").close();
  setAudioQuickReplyPlayer(null);
  audioQuickReplyEditor.item = null;
  audioQuickReplyEditor.audio = null;
}

async function refreshQuickRepliesAfterAudioChange() {
  await loadQuickRepliesCache(state.selectedId);
  if ($("#quick-reply-dialog").open) { renderQuickReplyCategories(); renderQuickReplyList(); }
}

async function deletePersonalAudioQuickReply(id) {
  const item = state.quickReplies.find((row) => row.id === id) || audioQuickReplyEditor.item;
  if (!item || !confirm(`Excluir a resposta rápida de áudio "${item.name}" (${item.shortcut})? Esta ação não pode ser desfeita.`)) return false;
  try {
    await api(`/api/quick-replies/personal-audio/${encodeURIComponent(id)}`, { method:"DELETE" });
    toast("Resposta rápida de áudio excluída.");
    await refreshQuickRepliesAfterAudioChange();
    return true;
  } catch (e) { toast(e.message, true); return false; }
}

$("#aqr-name").addEventListener("input", () => {
  if (!$("#aqr-shortcut").dataset.touched) $("#aqr-shortcut").value = suggestAudioShortcut($("#aqr-name").value);
});
$("#aqr-shortcut").addEventListener("input", (event) => {
  event.target.dataset.touched = "true";
  const value = event.target.value.toLowerCase().replace(/\s+/g, "_");
  event.target.value = value.startsWith("/") || !value ? value : `/${value}`;
});
$("#aqr-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!isAudioFile(file)) { event.target.value = ""; return toast("Formato de áudio não suportado. Use OGG (Opus), MP3, M4A, AAC ou AMR.", true); }
  if (file.size > AUDIO_MAX_FILE_SIZE) { event.target.value = ""; return toast("O áudio deve ter no máximo 16 MB.", true); }
  const durationMs = await measureAudioDuration(file);
  if (durationMs && durationMs > 10 * 60 * 1000) { event.target.value = ""; return toast("O áudio deve ter no máximo 10 minutos.", true); }
  audioQuickReplyEditor.audio = { blob:file, durationMs, fileName:file.name || "audio" };
  setAudioQuickReplyPlayer(file, durationMs);
});
$("#aqr-use-composer").addEventListener("click", () => {
  if (!pendingAudio) return;
  audioQuickReplyEditor.audio = { blob: pendingAudio.blob, durationMs: pendingAudio.durationMs, fileName: pendingAudio.fileName };
  setAudioQuickReplyPlayer(pendingAudio.blob, pendingAudio.durationMs);
});
$("#aqr-delete").addEventListener("click", async () => {
  const item = audioQuickReplyEditor.item;
  if (item && await deletePersonalAudioQuickReply(item.id)) closeAudioQuickReplyDialog();
});
$("#aqr-cancel").addEventListener("click", closeAudioQuickReplyDialog);
$("#close-audio-quick-reply").addEventListener("click", closeAudioQuickReplyDialog);
$("#audio-quick-reply-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const { item, audio } = audioQuickReplyEditor;
  if (!item && !audio) return toast("Grave ou escolha um áudio para salvar.", true);
  const form = new FormData();
  form.append("name", $("#aqr-name").value.trim());
  form.append("shortcut", $("#aqr-shortcut").value.trim());
  form.append("categoryId", $("#aqr-category").value);
  form.append("companyId", $("#aqr-company").value);
  if (audio) {
    form.append("audio", audio.blob, audio.fileName || "audio");
    if (audio.durationMs) form.append("durationMs", String(Math.round(audio.durationMs)));
  }
  $("#aqr-submit").disabled = true;
  try {
    await api(item ? `/api/quick-replies/personal-audio/${encodeURIComponent(item.id)}` : "/api/quick-replies/personal-audio", {
      method: item ? "PATCH" : "POST", body: form,
    });
    toast(item ? "Resposta rápida de áudio atualizada." : `Resposta rápida salva. Digite ${$("#aqr-shortcut").value.trim()} para usar.`);
    closeAudioQuickReplyDialog();
    await refreshQuickRepliesAfterAudioChange();
  } catch (e) { toast(e.message, true); }
  finally { $("#aqr-submit").disabled = false; }
});

// ===== Player de áudio nas mensagens =====
function syncMessageAudioPlayer(player) {
  const audio = player.querySelector("[data-audio-element]");
  const fallbackSeconds = (Number(player.dataset.durationMs) || 0) / 1000;
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : fallbackSeconds;
  const playing = !audio.paused && !audio.ended;
  const button = player.querySelector("[data-audio-play]");
  button.textContent = playing ? "❚❚" : "▶";
  button.setAttribute("aria-label", playing ? "Pausar áudio" : "Reproduzir áudio");
  player.classList.toggle("playing", playing);
  const progress = player.querySelector("[data-audio-progress]");
  if (!progress.matches(":active")) progress.value = duration ? String(Math.round((audio.currentTime / duration) * 1000)) : "0";
  const shown = playing || audio.currentTime > 0 ? audio.currentTime * 1000 : duration * 1000;
  player.querySelector("[data-audio-time]").textContent = duration || audio.currentTime ? formatAudioDuration(shown) : "--:--";
}
$("#messages").addEventListener("click", (event) => {
  const button = event.target.closest("[data-audio-play]");
  if (!button) return;
  const player = button.closest("[data-audio-player]");
  const audio = player.querySelector("[data-audio-element]");
  document.querySelectorAll("#messages [data-audio-element]").forEach((other) => { if (other !== audio && !other.paused) other.pause(); });
  if (audio.paused || audio.ended) audio.play().catch(() => toast("Não foi possível reproduzir este áudio.", true));
  else audio.pause();
});
$("#messages").addEventListener("input", (event) => {
  const progress = event.target.closest("[data-audio-progress]");
  if (!progress) return;
  const player = progress.closest("[data-audio-player]");
  const audio = player.querySelector("[data-audio-element]");
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (Number(player.dataset.durationMs) || 0) / 1000;
  if (duration) audio.currentTime = (Number(progress.value) / 1000) * duration;
});
// Eventos de mídia não borbulham: captura no contêiner.
["play", "pause", "ended", "timeupdate", "loadedmetadata"].forEach((type) => $("#messages").addEventListener(type, (event) => {
  const player = event.target.closest?.("[data-audio-player]");
  if (player) syncMessageAudioPlayer(player);
}, true));

// ===== Respostas rápidas (quick replies) =====
// Seleção NUNCA envia mensagem — só preenche o composer (item 8). Toda
// validação de acesso (ativa, canal, setor) é feita pelo backend em /use.
let quickReplySlashActive = null;

async function loadQuickRepliesCache(conversationId) {
  if (!conversationId) return;
  if (state.selectedId === conversationId) state.quickRepliesStatus = "loading";
  try {
    const replies = await api(`/api/quick-replies/composer?conversationId=${encodeURIComponent(conversationId)}`);
    if (state.selectedId === conversationId) { state.quickReplies = Array.isArray(replies) ? replies : []; state.quickRepliesStatus = "ready"; }
  } catch (error) {
    if (state.selectedId === conversationId) {
      state.quickReplies = [];
      state.quickRepliesStatus = error.status === 403 ? "forbidden" : "error";
      state.quickRepliesError = error.message;
    }
    throw error;
  }
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

const normalizeSearchTerm = (value) => String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const isAudioQuickReply = (item) => item?.contentType === "AUDIO";

function filteredQuickReplies() {
  const term = normalizeSearchTerm(state.quickReplySearch.trim());
  return state.quickReplies.filter((item) => {
    if (state.quickReplyTypeFilter && (item.contentType || "TEXT") !== state.quickReplyTypeFilter) return false;
    if (state.quickReplyCategoryFilter && !(item.categoryIds || [item.categoryId]).includes(state.quickReplyCategoryFilter)) return false;
    if (!term) return true;
    const categoryNames = (item.categories || []).map((category) => category.name);
    const typeLabel = isAudioQuickReply(item) ? "audio" : "texto";
    return [item.name, item.shortcut, item.text, item.category?.name, ...categoryNames, typeLabel].filter(Boolean).some((field) => normalizeSearchTerm(field).includes(term));
  });
}

function quickReplyCard(item) {
  if (isAudioQuickReply(item)) {
    const unavailable = item.availableInConversation === false;
    const personal = item.scope === "PERSONAL";
    return `<article class="quick-reply-card audio-quick-reply-card ${unavailable ? "unavailable" : ""}" data-quick-reply-id="${escapeHtml(item.id)}" role="button" tabindex="0" ${unavailable ? 'aria-disabled="true" title="Este canal ainda não suporta envio de áudio"' : ""}>
    <div class="quick-reply-card-head">
      <b><span aria-hidden="true">🎤</span> ${escapeHtml(item.name)}</b>
      <span class="quick-reply-card-shortcut">${escapeHtml(item.shortcut)}</span>
      <button type="button" class="quick-reply-favorite ${item.isFavorite ? "active" : ""}" data-favorite-id="${escapeHtml(item.id)}" title="Favoritar" aria-label="Favoritar">${item.isFavorite ? "★" : "☆"}</button>
    </div>
    <p>Áudio • ${escapeHtml(shortAudioDuration(item.audio?.durationMs))}${item.category ? ` • ${escapeHtml(item.category.name)}` : ""}${personal ? " • Pessoal" : ""}${unavailable ? " • indisponível neste canal" : ""}</p>
    ${personal ? `<div class="quick-reply-card-actions"><button type="button" data-edit-audio="${escapeHtml(item.id)}">Editar</button><button type="button" class="danger" data-delete-audio="${escapeHtml(item.id)}">Excluir</button></div>` : ""}
  </article>`;
  }
  return `<article class="quick-reply-card" data-quick-reply-id="${escapeHtml(item.id)}" role="button" tabindex="0">
    <div class="quick-reply-card-head">
      <b>${escapeHtml(item.name)}</b>
      <span class="quick-reply-card-shortcut">${escapeHtml(item.shortcut)}</span>
      <button type="button" class="quick-reply-favorite ${item.isFavorite ? "active" : ""}" data-favorite-id="${escapeHtml(item.id)}" title="Favoritar" aria-label="Favoritar">${item.isFavorite ? "★" : "☆"}</button>
    </div>
    <p>${escapeHtml(item.text)}</p>
  </article>`;
}

// Estados distintos da biblioteca: carregando, erro (com nova tentativa),
// sem permissão, vazia de verdade e vazia só pelo filtro/busca.
function quickReplyListStateMarkup() {
  const status = state.quickRepliesStatus;
  if (status === "loading") return '<div class="quick-reply-empty" role="status"><span class="inline-spinner" aria-hidden="true"></span> Carregando respostas rápidas…</div>';
  if (status === "forbidden") return '<div class="quick-reply-empty quick-reply-error" role="alert"><b>Acesso restrito</b><span>Seu usuário não tem permissão para usar respostas rápidas nesta conversa.</span></div>';
  if (status === "error") return `<div class="quick-reply-empty quick-reply-error" role="alert"><b>Não foi possível carregar as respostas rápidas.</b><span>${escapeHtml(state.quickRepliesError || "")}</span><button type="button" data-quick-reply-retry>Tentar novamente</button></div>`;
  if (!state.quickReplies.length) return '<div class="quick-reply-empty">Nenhuma resposta rápida disponível para esta conversa.</div>';
  return '<div class="quick-reply-empty">Nenhuma resposta encontrada para esta busca ou filtro.</div>';
}

function renderQuickReplyList() {
  const items = state.quickRepliesStatus === "ready" ? filteredQuickReplies() : [];
  if (!items.length) {
    $("#quick-reply-list").innerHTML = quickReplyListStateMarkup();
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
      if (event.target.closest("[data-favorite-id],[data-edit-audio],[data-delete-audio]")) return;
      selectQuickReply(card.dataset.quickReplyId);
    });
    card.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && !event.target.closest("[data-favorite-id],[data-edit-audio],[data-delete-audio]")) {
        event.preventDefault();
        selectQuickReply(card.dataset.quickReplyId);
      }
    });
  });
  document.querySelectorAll("[data-favorite-id]").forEach((button) => (
    button.addEventListener("click", (event) => { event.stopPropagation(); toggleQuickReplyFavorite(button.dataset.favoriteId); })
  ));
  document.querySelectorAll("[data-edit-audio]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const item = state.quickReplies.find((row) => row.id === button.dataset.editAudio);
    if (item) openAudioQuickReplyDialog({ item });
  }));
  document.querySelectorAll("[data-delete-audio]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    deletePersonalAudioQuickReply(button.dataset.deleteAudio);
  }));
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

let quickReplyUseInFlight = false;
async function selectQuickReply(id) {
  const conversationId = state.selectedId;
  const item = state.quickReplies.find((row) => row.id === id);
  if (item?.availableInConversation === false) return toast("O canal desta conversa ainda não suporta envio de áudio.", true);
  // Duplo clique inseria o texto duas vezes no composer.
  if (quickReplyUseInFlight) return;
  quickReplyUseInFlight = true;
  document.querySelector(`[data-quick-reply-id="${CSS.escape(id)}"]`)?.setAttribute("aria-busy", "true");
  try {
    const result = await api(`/api/quick-replies/${id}/use`, { method:"POST", body: JSON.stringify({ conversationId, source: "AGENT" }) });
    if (state.selectedId !== conversationId) return;
    $("#quick-reply-dialog").close();
    // Áudio: só carrega no composer — o envio é sempre um clique em "Enviar".
    if (result.audio) return await loadQuickReplyAudioIntoComposer(result);
    const input = $("#message-input");
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + result.text + input.value.slice(end);
    autoResizeComposer();
    const cursor = start + result.text.length;
    input.focus();
    input.setSelectionRange(cursor, cursor);
    if (result.unresolved?.length) toast(`Variável sem valor nesta conversa: ${result.unresolved.join(", ")} — revise antes de enviar.`, true);
  } catch (e) { toast(e.message, true); }
  finally {
    quickReplyUseInFlight = false;
    document.querySelector(`[data-quick-reply-id="${CSS.escape(id)}"]`)?.removeAttribute("aria-busy");
  }
}

async function openQuickReplyDialog() {
  if (!state.selectedId) return;
  state.quickReplyCategoryFilter = "";
  state.quickReplyTypeFilter = "";
  state.quickReplySearch = "";
  $("#quick-reply-search").value = "";
  syncQuickReplyTypeChips();
  // Abre na hora (feedback do clique) e carrega dentro do diálogo.
  if (!$("#quick-reply-dialog").open) $("#quick-reply-dialog").showModal();
  await reloadQuickReplyDialog();
}
async function reloadQuickReplyDialog() {
  const conversationId = state.selectedId;
  state.quickRepliesStatus = "loading";
  renderQuickReplyCategories();
  renderQuickReplyList();
  try { await loadQuickRepliesCache(conversationId); } catch { /* estado de erro já exibido na lista */ }
  if (state.selectedId !== conversationId) return;
  renderQuickReplyCategories();
  renderQuickReplyList();
}
$("#quick-reply-list").addEventListener("click", (event) => {
  if (event.target.closest("[data-quick-reply-retry]")) reloadQuickReplyDialog();
});

$("#open-quick-replies").addEventListener("click", openQuickReplyDialog);
$("#close-quick-replies").addEventListener("click", () => $("#quick-reply-dialog").close());
$("#quick-reply-dialog").addEventListener("click", (event) => { if (event.target === $("#quick-reply-dialog")) $("#quick-reply-dialog").close(); });
$("#quick-reply-search").addEventListener("input", (event) => { state.quickReplySearch = event.target.value; renderQuickReplyList(); });
function syncQuickReplyTypeChips() {
  document.querySelectorAll("[data-quick-reply-type]").forEach((chip) => {
    const active = chip.dataset.quickReplyType === (state.quickReplyTypeFilter || "");
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-selected", String(active));
  });
}
document.querySelectorAll("[data-quick-reply-type]").forEach((chip) => chip.addEventListener("click", () => {
  state.quickReplyTypeFilter = chip.dataset.quickReplyType;
  syncQuickReplyTypeChips();
  renderQuickReplyList();
}));
$("#new-audio-quick-reply").addEventListener("click", () => openAudioQuickReplyDialog({ audio: pendingAudio }));

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
  box.innerHTML = quickReplySlashActive.matches.map((item, index) => (isAudioQuickReply(item)
    ? `<div class="slash-suggestion-item audio-suggestion ${index === quickReplySlashActive.activeIndex ? "active" : ""} ${item.availableInConversation === false ? "unavailable" : ""}" data-slash-index="${index}">
      <b><span aria-hidden="true">🎤</span> ${escapeHtml(item.name)} <i>${escapeHtml(item.shortcut)}</i></b><small>Áudio • ${escapeHtml(shortAudioDuration(item.audio?.durationMs))}${item.availableInConversation === false ? " • indisponível neste canal" : ""}</small>
    </div>`
    : `<div class="slash-suggestion-item ${index === quickReplySlashActive.activeIndex ? "active" : ""}" data-slash-index="${index}">
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
  if (item.availableInConversation === false) return toast("O canal desta conversa ainda não suporta envio de áudio.", true);
  try {
    const result = await api(`/api/quick-replies/${item.id}/use`, { method:"POST", body: JSON.stringify({ conversationId: state.selectedId, source: "AGENT" }) });
    const input = $("#message-input");
    if (result.audio) {
      // Remove o "/comando" digitado e carrega o áudio no composer (sem enviar).
      input.value = input.value.slice(0, active.start) + input.value.slice(active.end);
      autoResizeComposer();
      return await loadQuickReplyAudioIntoComposer(result);
    }
    input.value = input.value.slice(0, active.start) + result.text + input.value.slice(active.end);
    autoResizeComposer();
    const cursor = active.start + result.text.length;
    input.focus();
    input.setSelectionRange(cursor, cursor);
    if (result.unresolved?.length) toast(`Variável sem valor nesta conversa: ${result.unresolved.join(", ")} — revise antes de enviar.`, true);
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
  if (composerSendGuard.isSending()) return;
  const input = $("#message-input");
  const text = input.value.trim();
  // Enviar durante a gravação só conclui a gravação — nunca envia sem revisão.
  if (isAudioRecording()) {
    stopAudioRecording();
    return toast("Gravação concluída. Ouça o áudio e clique em Enviar para mandar.");
  }
  if (pendingAudio) return sendPendingAudio();
  if (!text && !selectedAttachment) return;
  if (!state.selectedId || !composerSendGuard.acquire()) return;
  const sendingConversationId = state.selectedId;
  const sendingAttachment = selectedAttachment;
  const sendingInputValue = input.value;
  const pendingSuggestion = state.pendingBotSuggestion;
  $("#send-button").disabled = true;
  try {
    const proposalPayload = { ...(window.CrmProposalDraft?.payload(sendingConversationId) || {}), ...(window.ChatFeatures?.replyPayload(sendingConversationId) || {}) };
    const clientRequestId = !sendingAttachment ? composerSendGuard.request(sendingConversationId, text, proposalPayload) : null;
    const warningConversation=sendingConversationId;
    if(window.ContactWarning&&!(await window.ContactWarning.confirm({conversationId:warningConversation})))return;
    if(state.selectedId!==warningConversation)return;
    if (sendingAttachment) {
      const isDocument = isDocumentMime(sendingAttachment.type);
      const isVideo = sendingAttachment.type.startsWith("video/") || sendingAttachment.type === 'image/gif';
      const field = isDocument ? "document" : (isVideo ? "video" : "image");
      const endpoint = isDocument ? "documents" : (isVideo ? "videos" : "images");
      const form = new FormData();
      form.append(field, sendingAttachment);
      if (text) form.append("caption", text);
      window.ChatFeatures?.appendReply(form, sendingConversationId);
      await api(`/api/conversations/${sendingConversationId}/${endpoint}`, { method:"POST", body:form });
      if (state.selectedId !== sendingConversationId) return;
      if (selectedAttachment === sendingAttachment) clearSelectedAttachment();
    } else {
      await api(`/api/conversations/${sendingConversationId}/messages`, { method:"POST", body:JSON.stringify({ text, clientRequestId, ...proposalPayload }) });
      composerSendGuard.complete(sendingConversationId, clientRequestId);
      window.CrmProposalDraft?.sent(sendingConversationId);
    }
    window.ChatFeatures?.onSent(sendingConversationId);
    if (pendingSuggestion?.observationId && text) {
      const action = text === pendingSuggestion.originalText.trim() ? "USED" : "EDITED";
      await api("/api/bot-suggestion-feedback", {
        method: "POST",
        body: JSON.stringify({ observationId: pendingSuggestion.observationId, action, finalResponseText: text }),
      }).catch(() => {});
    }
    if (state.selectedId !== sendingConversationId) return;
    if (state.pendingBotSuggestion === pendingSuggestion) state.pendingBotSuggestion = null;
    if (input.value === sendingInputValue) {
      input.value = "";
      window.CentralSessionState?.forget(sendingConversationId);
    }
    resetComposerHeight();
    hideSlashSuggestions();
    await openConversation(sendingConversationId);
  } catch (e) {
    if (e.customerServiceWindow) state.customerServiceWindow = e.customerServiceWindow;
    toast(e.message, true);
  } finally {
    composerSendGuard.release();
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
    const warningConversation=state.selectedId;
    if(window.ContactWarning&&!(await window.ContactWarning.confirm({conversationId:warningConversation})))return;
    if(state.selectedId!==warningConversation)return;
    await api(`/api/conversations/${state.selectedId}/templates`, { method:"POST", body:JSON.stringify({ name:state.selectedTemplate.name, language:state.selectedTemplate.language, values }) });
    $("#template-dialog").close();
    toast("Template enviado para o cliente.");
    await openConversation(state.selectedId);
  } catch (error) { toast(error.message, true); }
  finally { $("#send-template").disabled = false; }
});
$("#message-input").addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) return;
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
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!event.isComposing && !event.repeat && !composerSendGuard.isSending()) $("#composer").requestSubmit(); }
});
// Navegação móvel: controles reais, voltar do navegador e gesto de retorno.
const mobileBackdrop = document.createElement("button");
mobileBackdrop.id = "mobile-navigation-backdrop";
mobileBackdrop.type = "button";
mobileBackdrop.hidden = true;
mobileBackdrop.setAttribute("aria-label", "Fechar painel e voltar");
document.body.append(mobileBackdrop);
function mobileHistory(view) {
  if (innerWidth > 700 || history.state?.mibroMobile === view) return;
  history.pushState({ ...history.state, mibroMobile: view }, "");
}
function closeMobileDrawers() {
  $("#app-sidebar").classList.remove("mobile-open");
  $("#filters-panel").classList.remove("mobile-open");
  mobileBackdrop.hidden = true;
  $("#sidebar-toggle").setAttribute("aria-expanded", "false");
  $("#toggle-filters-panel").setAttribute("aria-expanded", "false");
}
function openMobileDrawer(view) {
  closeMobileDrawers();
  $(view === "filters" ? "#filters-panel" : "#app-sidebar").classList.add("mobile-open");
  mobileBackdrop.hidden = false;
  $(view === "filters" ? "#toggle-filters-panel" : "#sidebar-toggle").setAttribute("aria-expanded", "true");
  mobileHistory(view);
  $(view === "filters" ? "#close-mobile-filters" : "#close-mobile-menu").focus();
}
function mobileBack() {
  const drawer = $("#app-sidebar").classList.contains("mobile-open") || $("#filters-panel").classList.contains("mobile-open");
  if (drawer) closeMobileDrawers();
  else if ($(".workspace").classList.contains("context-open")) { closeContextPanel(); return; }
  else closeConversationView();
  if (history.state?.mibroMobile) history.back();
}
$("#close-mobile-menu").addEventListener("click", mobileBack);
$("#mobile-chat-tools").addEventListener("click", () => {
  const open = $("#chat-content").classList.toggle("mobile-tools-open");
  $("#mobile-chat-tools").setAttribute("aria-expanded", String(open));
  $("#mobile-chat-tools").textContent = open ? "Fechar opções" : "Opções";
});
$("#close-mobile-filters").addEventListener("click", mobileBack);
mobileBackdrop.addEventListener("click", mobileBack);
$("#app-sidebar").addEventListener("click", (event) => {
  if (innerWidth <= 700 && event.target.closest(".sidebar-item") && history.state?.mibroMobile === "menu") {
    closeMobileDrawers();
    history.back();
  }
});
window.addEventListener("popstate", (event) => {
  if (innerWidth > 700) return;
  closeMobileDrawers();
  closeContextPanel();
  if (event.state?.mibroMobile !== "conversation") closeConversationView();
});
const chatObserver = new MutationObserver(() => {
  if (innerWidth <= 700 && $("#chat-panel").classList.contains("open") && !$("#filters-panel").classList.contains("mobile-open") && !$("#app-sidebar").classList.contains("mobile-open")) mobileHistory("conversation");
});
chatObserver.observe($("#chat-panel"), { attributes: true, attributeFilter: ["class"] });
let mobileTouch;
document.addEventListener("touchstart", event => {
  if (innerWidth > 700 || event.touches.length !== 1 || event.target.closest("dialog,input,textarea,select,button,a,audio,video")) { mobileTouch = null; return; }
  mobileTouch = { x: event.touches[0].clientX, y: event.touches[0].clientY };
}, { passive: true });
document.addEventListener("touchend", event => {
  if (!mobileTouch) return;
  const start = mobileTouch; mobileTouch = null;
  const end = event.changedTouches[0];
  if (end && end.clientX - start.x > 90 && Math.abs(end.clientY - start.y) < 55 && ($("#chat-panel").classList.contains("open") || !mobileBackdrop.hidden)) mobileBack();
}, { passive: true });
document.addEventListener("touchcancel", () => { mobileTouch = null; }, { passive: true });
window.addEventListener("resize", () => { if (innerWidth > 700) closeMobileDrawers(); });
function syncMobileViewport() {
  document.documentElement.style.setProperty("--mobile-viewport-height", `${window.visualViewport?.height || innerHeight}px`);
}
window.visualViewport?.addEventListener("resize", syncMobileViewport);
window.addEventListener("resize", syncMobileViewport);
syncMobileViewport();

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
  .then(() => { syncWorkspaceFilterControls(); renderCompanyFilter(); return loadConversations(); })
  .then(async () => {
    loadWorkspaceAccounts();
    refreshWorkspaceUnread();
    document.dispatchEvent(new CustomEvent("central:workspace-changed", { detail: { company: activeCompany(), initial: true } }));
    const requestedConversation = new URLSearchParams(location.search).get("conversation") || state.centralResume?.selectedId;
    if (requestedConversation) {
      history.replaceState({}, "", "/");
      try { await openConversationInWorkspace(requestedConversation); } catch {}
    }
    if(state.centralResume&&!new URLSearchParams(location.search).get('conversation')){
      const list=$('#conversation-list');list.scrollTop=state.centralResume.scrollTop||0;
    }
    state.centralResume=null;
    await checkAlerts();
  })
  .then(connectRealtime)
  .catch((error) => {
    toast(error.message, true);
    if ($("#conversation-list").querySelector(".skeleton-list")) {
      $("#conversation-list").innerHTML = `<div class="empty-list">Não foi possível carregar as conversas. Recarregue a página.</div>`;
    }
  });
setInterval(() => { (document.hidden ? checkAlerts() : refreshInbox()).catch(() => {}); scheduleWorkspaceUnread(0); }, 30000);
// Conexão de cada número (aba da empresa): o status muda raramente.
setInterval(() => { if (!document.hidden) loadWorkspaceAccounts(); }, 5 * 60 * 1000);
window.addEventListener('pagehide',()=>{
  if(!state.currentUser)return;
  window.CentralSessionState?.keep(state.composerConversationId,$('#message-input').value);
  saveWorkspaceFilters();
  window.CentralSessionState?.persist({company:state.companyFilter,filters:workspace.saved,selectedId:state.selectedId,scrollTop:$('#conversation-list').scrollTop});
});


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

$("#supervision-button").addEventListener("click", () => window.WaSupervision?.open().catch((error) => toast(error.message, true)));
$("#assignment-timeline").addEventListener("click", () => { if (state.selectedId) window.WaSupervision?.openTimeline(state.selectedId).catch((error) => toast(error.message, true)); });
