// Recursos de conversa estilo WhatsApp. Carregado antes do app.js, usa os
// utilitários dele (api, toast, escapeHtml, state, openConversation) só em tempo
// de execução. Com todas as flags desligadas, não altera a marcação nem a tela.
(() => {
  const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
  const CONTEXT_MAX_MS = 30 * 24 * 60 * 60 * 1000;
  const FORWARDABLE = new Set(["text", "image", "video", "document", "audio", "sticker"]);
  const LONG_PRESS_MS = 480;
  const SWIPE_REPLY_PX = 64;
  let flags = {};
  let reply = null;
  let conversation = null;
  let newMessages = 0;
  let lastCount = 0;

  const el = (selector) => document.querySelector(selector);
  const esc = (value) => escapeHtml(value ?? "");
  const on = (name) => Boolean(flags[name]);
  const findMessage = (id) => (state.selectedMessages || []).find((message) => message.id === id);
  const metaChat = () => state.selectedChannel === "META";
  const readOnly = () => conversation?.accessMode === "SUPERVISION" || Boolean(conversation?.archivedAt);
  const windowClosed = () => Boolean(state.customerServiceWindow?.requiresTemplate);
  const tooOld = (message) => Date.now() - new Date(message.occurredAt).getTime() > CONTEXT_MAX_MS;
  const hasExternalId = (message) => /(^|:)wamid\./.test(message.externalId || "");

  function typeLabel(preview) {
    return ({ image: "📷 Imagem", video: "🎬 Vídeo", audio: "▶ Áudio", sticker: "💟 Figurinha", document: `📄 ${preview.fileName || "Documento"}`, contacts: "👤 Contato" })[preview.type] || "";
  }

  function previewText(preview) {
    const clean = preview.text && !/^\[[a-z_]+\]$/.test(preview.text) ? preview.text : "";
    return clean || typeLabel(preview) || "Mensagem";
  }

  function toPreview(message) {
    return {
      id: message.id, type: message.type, text: message.text, fileName: message.mediaFileName,
      hasMedia: Boolean(message.mediaStorageKey), direction: message.direction,
      author: message.direction === "ENVIADA" ? (message.sentByUser?.name || "Equipe") : (state.selectedContactName || "Cliente"),
    };
  }

  function thumbnail(preview) {
    if (!preview.hasMedia || !["image", "sticker"].includes(preview.type)) return "";
    return `<img class="chat-quote-thumb" src="/api/messages/${encodeURIComponent(preview.id)}/media" alt="" loading="lazy">`;
  }

  function quoteMarkup(preview) {
    if (preview.unavailable) return '<div class="chat-quote unavailable"><span>Mensagem original indisponível</span></div>';
    const author = preview.direction === "ENVIADA" ? preview.author : (state.selectedContactName || preview.author);
    return `<button type="button" class="chat-quote" data-chat-jump="${esc(preview.id)}"><span class="chat-quote-text"><b>${esc(author)}</b><span>${esc(previewText(preview))}</span></span>${thumbnail(preview)}</button>`;
  }

  function reactionsMarkup(message) {
    const rows = message.reactions || [];
    if (!rows.length) return "";
    return `<div class="chat-reactions">${rows.map((row) => {
      const failed = ["FAILED", "REMOVAL_FAILED"].includes(row.status);
      const pending = row.status === "PENDING";
      const who = row.side === "CUSTOMER" ? "Cliente" : (row.user?.name || "Equipe");
      const state = failed ? (row.status === "REMOVAL_FAILED" ? "remoção não confirmada pelo WhatsApp" : "não entregue no WhatsApp") : pending ? "enviando" : row.status === "ACCEPTED" ? "aguardando confirmação" : "";
      const mine = row.side === "BUSINESS";
      return `<button type="button" class="chat-reaction ${failed ? "failed" : ""} ${pending || row.status === "ACCEPTED" ? "pending" : ""}" ${mine && !readOnly() ? `data-chat-unreact="${esc(message.id)}"` : "disabled"} title="${esc(`${who}${state ? ` — ${state}` : ""}`)}">${esc(row.emoji)}${failed ? '<i aria-hidden="true">!</i>' : ""}</button>`;
    }).join("")}</div>`;
  }

  // Partes extras da linha. Tudo vazio com as flags desligadas.
  function rowParts(message) {
    const parts = { top: "", footer: "", reactions: "", actions: "" };
    if (!Object.values(flags).some((value) => value === true)) return parts;
    const forwarded = message.forwardedFromMessageId || message.rawPayload?.context?.forwarded || message.rawPayload?.context?.frequently_forwarded;
    if (forwarded) parts.top += `<span class="chat-forwarded">↪ ${message.direction === "ENVIADA" ? "Encaminhada pela equipe" : "Encaminhada"}</span>`;
    if (on("reply") && message.replyPreview) parts.top += quoteMarkup(message.replyPreview);
    if (message.pinned) parts.footer += '<span class="chat-mark" title="Mensagem fixada">📌</span>';
    if (message.starred) parts.footer += '<span class="chat-mark" title="Favorita">★</span>';
    if (on("reactions")) parts.reactions = reactionsMarkup(message);
    parts.actions = `<button type="button" class="chat-row-menu" data-chat-menu="${esc(message.id)}" aria-label="Ações da mensagem" aria-haspopup="menu">⌄</button>`;
    return parts;
  }

  // ===== Menu de ações =====

  function actionsFor(message) {
    const actions = [];
    const usable = !readOnly() && metaChat();
    const citeReason = actionUnavailable(message);
    const add = (id, label, reason = "") => actions.push({ id, label, reason });
    if (on("reply") && metaChat()) add("reply", "↩ Responder", citeReason);
    if (on("reactions") && metaChat()) add("reaction", "😊 Reagir", reactionUnavailable(message));
    if (message.text && !/^\[[a-z_]+\]$/.test(message.text)) add("copy", "⧉ Copiar mensagem");
    if (on("stars")) add("star", message.starred ? "☆ Remover dos favoritos" : "★ Favoritar");
    if (on("pins") && !readOnly()) add("pin", message.pinned ? "📌 Desafixar" : "📌 Fixar");
    if (on("forward") && usable && FORWARDABLE.has(message.type) && (message.type === "text" || message.mediaStorageKey)) add("forward", "↪ Encaminhar");
    if (message.mediaStorageKey) add("download", "⭳ Baixar mídia");
    if (on("stickers") && message.type === "sticker" && message.mediaStorageKey) add("save-sticker", "💟 Salvar figurinha");
    add("info", "ⓘ Informações");
    return actions;
  }

  function actionUnavailable(message) {
    if (readOnly()) return "Esta conversa está em modo de leitura.";
    if (!hasExternalId(message)) return "Esta mensagem não tem um identificador válido do WhatsApp.";
    if (tooOld(message)) return "Esta mensagem tem mais de 30 dias.";
    if (message.status === "FALHOU") return "Esta mensagem não foi enviada ao WhatsApp.";
    if (windowClosed()) return "A janela de atendimento deste número está fechada. Aguarde uma resposta do cliente para responder ou reagir.";
    return "";
  }
  function reactionUnavailable(message) {
    return actionUnavailable(message) || (message.direction !== "RECEBIDA" ? "Você pode reagir às mensagens recebidas do cliente." : "");
  }
  function canReact(message) {
    return on("reactions") && metaChat() && !reactionUnavailable(message);
  }

  function closeMenu() {
    const menu = el("#chat-action-menu");
    if (menu) menu.hidden = true;
    document.body.classList.remove("chat-sheet-open");
  }

  function placeMenu(menu, x, y) {
    if (innerWidth <= 700) { menu.style.left = ""; menu.style.top = ""; return; }
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - height - 8))}px`;
  }

  function openMenu(messageId, x, y) {
    const message = findMessage(messageId);
    if (!message || message.restricted) return;
    const menu = el("#chat-action-menu");
    const quick = canReact(message)
      ? `<div class="chat-quick-reactions">${QUICK_REACTIONS.map((emoji) => `<button type="button" data-chat-react="${emoji}" aria-label="Reagir com ${emoji}">${emoji}</button>`).join("")}<button type="button" data-chat-react-more aria-label="Outros emojis">＋</button></div>` : "";
    menu.innerHTML = `${quick}${actionsFor(message).map((action) => `<button type="button" role="menuitem" data-chat-action="${action.id}" ${action.reason ? `disabled title="${esc(action.reason)}"` : ""}>${esc(action.label)}</button>`).join("")}`;
    const reason = actionsFor(message).find(action => action.reason)?.reason;
    if (reason) menu.insertAdjacentHTML("beforeend", `<p class="chat-action-reason">${esc(reason)}</p>`);
    menu.dataset.messageId = messageId;
    menu.hidden = false;
    document.body.classList.toggle("chat-sheet-open", innerWidth <= 700);
    placeMenu(menu, x, y);
    menu.querySelector("button")?.focus();
  }

  async function refresh() {
    if (state.selectedId) await openConversation(state.selectedId, { refreshList: false, markRead: false });
  }

  async function react(messageId, emoji) {
    closeMenu();
    try {
      await api(`/api/messages/${encodeURIComponent(messageId)}/reactions`, { method: "POST", body: JSON.stringify({ emoji }) });
    } catch (error) { toast(error.message, true); }
    await refresh().catch(() => {});
  }

  async function runAction(action, message) {
    closeMenu();
    const url = `/api/messages/${encodeURIComponent(message.id)}`;
    if (action === "reply") { const reason = actionUnavailable(message); return reason ? toast(reason, true) : setReply(message); }
    if (action === "reaction") { const reason = reactionUnavailable(message); return reason ? toast(reason, true) : openEmoji(emoji => react(message.id, emoji)); }
    if (action === "copy") { await navigator.clipboard.writeText(message.text); return toast("Mensagem copiada."); }
    if (action === "star") { await api(`${url}/star`, { method: "PUT", body: JSON.stringify({ starred: !message.starred }) }); return refresh(); }
    if (action === "pin") { await api(`${url}/pin`, { method: "PUT", body: JSON.stringify({ pinned: !message.pinned }) }); return refresh(); }
    if (action === "forward") return openForward(message);
    if (action === "download") {
      const link = document.createElement("a");
      link.href = `${url}/media`; link.download = message.mediaFileName || "midia"; link.click();
      return undefined;
    }
    if (action === "save-sticker") return openSaveSticker(message);
    return openInfo(message);
  }

  function openInfo(message) {
    const labels = { PENDENTE: "Pendente", ENVIADA: "Aceita pela Meta", ENTREGUE: "Entregue", LIDA: "Lida", FALHOU: "Falhou", RECEBIDA: "Recebida" };
    const rows = [
      ["Situação", labels[message.status] || message.status], ["Data", new Date(message.occurredAt).toLocaleString("pt-BR")],
      ["Autor", toPreview(message).author], ["Tipo", message.type],
      ...(message.mediaFileName ? [["Arquivo", message.mediaFileName]] : []),
    ];
    showDialog("Informações da mensagem", `<dl class="chat-info">${rows.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join("")}</dl>`);
  }

  function showDialog(title, body, { wide = false } = {}) {
    const dialog = el("#chat-dialog");
    dialog.classList.toggle("wide", wide);
    dialog.innerHTML = `<div class="chat-dialog-head"><h3>${esc(title)}</h3><button type="button" data-chat-dialog-close aria-label="Fechar">×</button></div><div class="chat-dialog-body">${body}</div>`;
    if (!dialog.open) dialog.showModal();
    return dialog;
  }
  const closeDialog = () => { const dialog = el("#chat-dialog"); if (dialog?.open) dialog.close(); };

  // ===== Citação no compositor =====

  function renderReply() {
    const box = el("#chat-reply-preview");
    if (!box) return;
    box.hidden = !reply;
    if (!reply) { box.innerHTML = ""; syncScrollButton(); return; }
    box.innerHTML = `<div class="chat-quote static"><span class="chat-quote-text"><b>Respondendo a ${esc(reply.preview.author)}</b><span>${esc(previewText(reply.preview))}</span></span>${thumbnail(reply.preview)}</div><button type="button" data-chat-reply-cancel aria-label="Cancelar resposta">×</button>`;
    syncScrollButton();
  }

  function setReply(message) {
    reply = { conversationId: state.selectedId, messageId: message.id, preview: toPreview(message) };
    renderReply();
    el("#message-input")?.focus();
  }

  function clearReply() { reply = null; renderReply(); }

  function replyId(conversationId) {
    return reply?.conversationId === conversationId ? reply.messageId : null;
  }

  function replyPayload(conversationId) {
    const id = replyId(conversationId);
    return id ? { replyToMessageId: id } : {};
  }

  function appendReply(form, conversationId) {
    const id = replyId(conversationId);
    if (id) form.append("replyToMessageId", id);
  }

  function onSent(conversationId) {
    if (reply?.conversationId === conversationId) clearReply();
  }

  // ===== Navegar até a mensagem =====

  function highlight(id) {
    const row = el(`#messages [data-message-id="${CSS.escape(id)}"]`);
    if (!row) return false;
    // Só a lista rola: scrollIntoView moveria também a página (body com overflow oculto).
    const box = el("#messages");
    const offset = row.getBoundingClientRect().top - box.getBoundingClientRect().top;
    setTimelineScroll(box.scrollTop + offset - (box.clientHeight - row.offsetHeight) / 2);
    row.classList.remove("chat-highlight");
    void row.offsetWidth;
    row.classList.add("chat-highlight");
    return true;
  }

  async function jump(id) {
    if (highlight(id)) return;
    try {
      const conversationId = state.selectedId;
      const place = await api(`/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(id)}/locate`);
      if (place.tooFar) return openContext(conversationId, id);
      timelinePage.id = conversationId; timelinePage.expanded = true; timelinePage.cursor = place.cursor;
      await openConversation(conversationId, { refreshList: false, markRead: false });
      if (!highlight(id)) toast("Mensagem indisponível nesta visualização.", true);
    } catch (error) { toast(error.message, true); }
    return undefined;
  }

  async function openContext(conversationId, id) {
    const { messages } = await api(`/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(id)}/context`);
    showDialog("Trecho da conversa", `<div class="chat-context">${messages.map((row) => `<article class="${row.id === id ? "target" : ""} ${row.direction === "ENVIADA" ? "sent" : ""}"><b>${esc(row.author)}</b><p>${esc(previewText(row))}</p><small>${esc(new Date(row.occurredAt).toLocaleString("pt-BR"))}</small></article>`).join("")}</div>`, { wide: true });
    el("#chat-dialog .target")?.scrollIntoView({ block: "center" });
  }

  // ===== Fixadas =====

  function renderPins(pins = []) {
    const bar = el("#chat-pins-bar");
    if (!bar) return;
    bar.hidden = !pins.length;
    el("#chat-content")?.classList.toggle("has-chat-pins", Boolean(pins.length));
    bar.innerHTML = pins.map((pin) => `<div class="chat-pin"><button type="button" data-chat-jump="${esc(pin.message.id)}" title="${esc(pin.pinnedBy?.name ? `Fixada por ${pin.pinnedBy.name}` : "Mensagem fixada")}"><span aria-hidden="true">📌</span><span>${esc(previewText(pin.message))}</span></button>${readOnly() ? "" : `<button type="button" data-chat-unpin="${esc(pin.message.id)}" aria-label="Desafixar">×</button>`}</div>`).join("");
  }

  // ===== Pesquisa e favoritos =====

  let search = { cursor: null, tab: "search" };

  function resultMarkup(row) {
    return `<button type="button" class="chat-result" data-chat-jump="${esc(row.id)}"><b>${esc(row.author)}</b><span>${esc(previewText(row))}</span><small>${esc(new Date(row.occurredAt).toLocaleString("pt-BR"))}</small></button>`;
  }

  function openSearchPanel(tab = "search") {
    const panel = el("#chat-search-panel");
    panel.hidden = false;
    search = { cursor: null, tab };
    panel.innerHTML = `<div class="chat-panel-head"><div class="chat-tabs">${on("search") ? `<button type="button" data-chat-search-tab="search" class="${tab === "search" ? "active" : ""}">Pesquisar</button>` : ""}${on("stars") ? `<button type="button" data-chat-search-tab="stars" class="${tab === "stars" ? "active" : ""}">Favoritas</button>` : ""}</div><button type="button" data-chat-search-close aria-label="Fechar">×</button></div>
      ${tab === "search" ? `<form id="chat-search-form" class="chat-search-form"><input id="chat-search-term" type="search" maxlength="100" placeholder="Palavra, frase ou arquivo" aria-label="Pesquisar nesta conversa"><div class="chat-search-filters"><select id="chat-search-type" aria-label="Tipo"><option value="">Todos os tipos</option><option value="text">Texto</option><option value="image">Imagens</option><option value="video">Vídeos</option><option value="audio">Áudios</option><option value="document">Documentos</option><option value="sticker">Figurinhas</option></select><select id="chat-search-sender" aria-label="Remetente"><option value="">Qualquer remetente</option><option value="customer">Cliente</option><option value="team">Equipe</option></select><input id="chat-search-from" type="date" aria-label="De"><input id="chat-search-to" type="date" aria-label="Até"></div><button type="submit">Pesquisar</button></form>` : ""}
      <div id="chat-search-results" class="chat-results" aria-live="polite"></div>`;
    if (tab === "stars") loadStars(); else el("#chat-search-term").focus();
  }

  async function loadStars() {
    const box = el("#chat-search-results");
    try {
      const rows = await api(`/api/conversations/${encodeURIComponent(state.selectedId)}/stars`);
      box.innerHTML = rows.length ? rows.map(resultMarkup).join("") : '<p class="chat-empty">Nenhuma mensagem favorita nesta conversa.</p>';
    } catch (error) { box.innerHTML = `<p class="chat-empty">${esc(error.message)}</p>`; }
  }

  async function runSearch({ more = false } = {}) {
    const box = el("#chat-search-results");
    const params = new URLSearchParams();
    const put = (key, value) => { if (value) params.set(key, value); };
    put("q", el("#chat-search-term").value.trim());
    put("type", el("#chat-search-type").value);
    put("sender", el("#chat-search-sender").value);
    put("from", el("#chat-search-from").value);
    const end = el("#chat-search-to").value;
    put("to", end ? `${end}T23:59:59` : "");
    if (more) put("cursor", search.cursor);
    try {
      const page = await api(`/api/conversations/${encodeURIComponent(state.selectedId)}/message-search?${params}`);
      search.cursor = page.nextCursor;
      el("#chat-search-more")?.remove();
      const rows = page.results.map(resultMarkup).join("");
      if (more) box.insertAdjacentHTML("beforeend", rows);
      else box.innerHTML = rows || '<p class="chat-empty">Nada encontrado.</p>';
      if (page.nextCursor) box.insertAdjacentHTML("beforeend", '<button id="chat-search-more" type="button" class="secondary">Carregar mais</button>');
    } catch (error) { box.innerHTML = `<p class="chat-empty">${esc(error.message)}</p>`; }
  }

  // ===== Encaminhar =====

  function openForward(message) {
    const preview = toPreview(message);
    const dialog = showDialog("Encaminhar mensagem", `<div class="chat-quote static"><span class="chat-quote-text"><b>${esc(preview.author)}</b><span>${esc(previewText(preview))}</span></span></div><input id="chat-forward-term" type="search" placeholder="Buscar conversa por nome ou telefone" aria-label="Buscar conversa de destino"><div id="chat-forward-results" class="chat-results"></div>`);
    dialog.dataset.messageId = message.id;
    el("#chat-forward-term").focus();
  }

  let forwardTimer;
  function searchForward() {
    clearTimeout(forwardTimer);
    forwardTimer = setTimeout(async () => {
      const term = el("#chat-forward-term")?.value.trim();
      const box = el("#chat-forward-results");
      if (!box) return;
      if (!term || term.length < 2) { box.innerHTML = ""; return; }
      try {
        const rows = await api(`/api/conversations/search?${new URLSearchParams({ q: term, company: state.companyFilter || "" })}`);
        const items = rows.filter((row) => row.channel === "META" && row.id !== state.selectedId);
        box.innerHTML = items.length ? items.map((row) => `<button type="button" class="chat-result" data-chat-forward-to="${esc(row.id)}" data-name="${esc(row.name)}"><b>${esc(row.name)}</b><small>${esc(row.phone ? `+${row.phone}` : "")}</small></button>`).join("") : '<p class="chat-empty">Nenhuma conversa de WhatsApp encontrada.</p>';
      } catch (error) { box.innerHTML = `<p class="chat-empty">${esc(error.message)}</p>`; }
    }, 250);
  }

  function confirmForward(button) {
    const dialog = el("#chat-dialog");
    const message = findMessage(dialog.dataset.messageId);
    const preview = toPreview(message);
    const body = showDialog("Confirmar encaminhamento", `<p>Enviar para <b>${esc(button.dataset.name)}</b>?</p><div class="chat-quote static"><span class="chat-quote-text"><span>${esc(previewText(preview))}</span></span></div><p class="chat-note">Será enviada como uma mensagem nova. O destinatário não verá o selo "Encaminhada".</p><div class="chat-dialog-actions"><button type="button" class="secondary" data-chat-dialog-close>Cancelar</button><button type="button" data-chat-forward-confirm="${esc(button.dataset.chatForwardTo)}">Enviar</button></div>`);
    body.dataset.requestId = crypto.randomUUID();
  }

  async function sendForward(button) {
    const dialog = el("#chat-dialog");
    button.disabled = true;
    try {
      await api(`/api/messages/${encodeURIComponent(dialog.dataset.messageId)}/forward`, { method: "POST", body: JSON.stringify({ targetConversationId: button.dataset.chatForwardConfirm, confirmed: true, clientRequestId: dialog.dataset.requestId }) });
      closeDialog();
      toast("Mensagem encaminhada.");
    } catch (error) { toast(error.message, true); button.disabled = false; }
  }

  // ===== Emojis =====

  const RECENT_KEY = "mibro-chat-recent-emojis";
  function recentEmojis() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").slice(0, 24); } catch { return []; }
  }
  function rememberEmoji(emoji) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify([emoji, ...recentEmojis().filter((item) => item !== emoji)].slice(0, 24))); } catch { /* preferência opcional */ }
  }

  let emojiTarget = null;

  let emojiLimit = 120, emojiCategory = null, emojiTerm = "";
  function emojiGrid(items) {
    return items.length ? `<div class="chat-emoji-grid">${items.slice(0, emojiLimit).map((emoji) => `<button type="button" data-chat-emoji="${esc(emoji)}">${esc(emoji)}</button>`).join("")}</div>${items.length > emojiLimit ? '<button type="button" class="chat-emoji-more" data-chat-emoji-more>Mostrar mais</button>' : ""}` : '<p class="chat-empty">Nenhum emoji encontrado.</p>';
  }

  function renderEmoji(categoryId, term = "") {
    if (categoryId !== emojiCategory || term !== emojiTerm) emojiLimit = 120;
    emojiCategory = categoryId; emojiTerm = term;
    const data = window.CHAT_EMOJI_DATA || [];
    const box = el("#chat-emoji-list");
    const normalized = term.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
    if (normalized) {
      box.innerHTML = emojiGrid(data.flatMap((category) => category.items).filter((item) => item.words.includes(normalized) || item.emoji.includes(normalized)).map((item) => item.emoji));
      return;
    }
    const category = data.find((item) => item.id === categoryId);
    box.innerHTML = category ? emojiGrid(category.items.map((item) => item.emoji)) : emojiGrid(recentEmojis());
    el("#chat-emoji-picker").querySelectorAll("[data-chat-emoji-tab]").forEach((button) => button.classList.toggle("active", button.dataset.chatEmojiTab === (categoryId || "recent")));
  }

  function openEmoji(target) {
    closePopovers();
    emojiTarget = target;
    const picker = el("#chat-emoji-picker");
    const data = window.CHAT_EMOJI_DATA || [];
    picker.innerHTML = `<input id="chat-emoji-search" type="search" placeholder="Pesquisar emoji" aria-label="Pesquisar emoji"><div class="chat-emoji-tabs"><button type="button" data-chat-emoji-tab="recent" title="Recentes">🕘</button>${data.map((category) => `<button type="button" data-chat-emoji-tab="${category.id}" title="${esc(category.label)}">${category.icon}</button>`).join("")}</div><div id="chat-emoji-list" class="chat-emoji-list"></div>`;
    picker.insertAdjacentHTML("beforeend", '<div class="chat-emoji-extras"><a href="https://emojikeyboard.top/pt/" target="_blank" rel="noopener noreferrer">Mais emojis ↗</a><button type="button" data-chat-export-emojis>Exportar lista</button></div>');
    picker.hidden = false;
    renderEmoji(recentEmojis().length ? "recent" : data[0]?.id);
    if (innerWidth > 700) el("#chat-emoji-search").focus();
  }

  function chooseEmoji(emoji) {
    rememberEmoji(emoji);
    const target = emojiTarget;
    closePopovers();
    if (typeof target === "function") return target(emoji);
    const input = el("#message-input");
    if (input.disabled) return undefined;
    input.setRangeText(emoji, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, "end");
    input.focus();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return undefined;
  }

  // ===== Biblioteca de figurinhas e GIFs =====

  let library = { kind: "STICKER", view: "", q: "", category: "", data: null };

  function closePopovers() {
    ["#chat-emoji-picker", "#chat-media-picker"].forEach((selector) => { const node = el(selector); if (node) node.hidden = true; });
  }

  function assetMarkup(asset) {
    const media = asset.kind === "GIF"
      ? `<video src="${esc(asset.url)}" muted loop playsinline preload="metadata" data-chat-autoplay></video>`
      : `<img src="${esc(asset.url)}" alt="${esc(asset.name)}" loading="lazy">`;
    return `<div class="chat-asset"><button type="button" class="chat-asset-send" data-chat-asset="${esc(asset.id)}" title="${esc(asset.name)}">${media}</button><button type="button" class="chat-asset-star ${asset.favorite ? "active" : ""}" data-chat-asset-star="${esc(asset.id)}" aria-label="Favoritar">★</button><a class="chat-asset-download" href="${esc(asset.url)}" download="${esc(asset.name || (asset.kind === "GIF" ? "animacao" : "figurinha"))}.${asset.kind === "GIF" ? "mp4" : "webp"}" title="Baixar ${asset.kind === "GIF" ? "vídeo MP4" : "figurinha"}" aria-label="Baixar">↓</a>${asset.canDelete ? `<button type="button" class="chat-asset-remove" data-chat-asset-remove="${esc(asset.id)}" aria-label="Remover">×</button>` : ""}</div>`;
  }

  async function loadLibrary() {
    const grid = el("#chat-media-grid");
    if (!grid) return;
    const params = new URLSearchParams({ kind: library.kind, conversationId: state.selectedId });
    if (library.view) params.set("view", library.view);
    if (library.q) params.set("q", library.q);
    if (library.category) params.set("category", library.category);
    grid.textContent = "Carregando…";
    try {
      library.data = await api(`/api/media-library?${params}`);
      grid.innerHTML = library.data.items.length ? library.data.items.map(assetMarkup).join("") : '<p class="chat-empty">Nada por aqui ainda. Use Adicionar ou salve uma figurinha recebida.</p>';
      const select = el("#chat-media-category");
      if (select) select.innerHTML = `<option value="">Todas as categorias</option>${library.data.categories.map((category) => `<option ${category === library.category ? "selected" : ""}>${esc(category)}</option>`).join("")}`;
      playVisible();
    } catch (error) { grid.innerHTML = `<p class="chat-empty">${esc(error.message)}</p>`; }
  }

  // Só anima o que está visível, para não pesar em telas com muitos GIFs.
  let observer = null;
  function playVisible() {
    observer?.disconnect();
    observer = new IntersectionObserver((entries) => entries.forEach(({ target, isIntersecting }) => {
      if (isIntersecting) target.play().catch(() => {}); else target.pause();
    }), { root: el("#chat-media-grid") });
    document.querySelectorAll("#chat-media-grid [data-chat-autoplay]").forEach((video) => observer.observe(video));
  }

  function openLibrary(kind) {
    closePopovers();
    if (!on(kind === "GIF" ? "gifs" : "stickers")) kind = kind === "GIF" ? "STICKER" : "GIF";
    library = { kind, view: "", q: "", category: "", data: null };
    const picker = el("#chat-media-picker");
    const views = [["", "Todas"], ["favorites", "Favoritas"], ["recent", "Recentes"], ["PERSONAL", "Minhas"], ["TEAM", "Equipe"], ["COMPANY", "Empresa"]];
    picker.innerHTML = `<div class="chat-tabs">${on("stickers") ? `<button type="button" data-chat-library="STICKER" class="${kind === "STICKER" ? "active" : ""}">Figurinhas</button>` : ""}${on("gifs") ? `<button type="button" data-chat-library="GIF" class="${kind === "GIF" ? "active" : ""}">GIFs</button>` : ""}<button type="button" class="chat-media-add" data-chat-library-add>＋ Importar arquivo</button></div><p class="chat-library-help">Importe um arquivo do computador ou celular. <a href="https://giphy.com/explore/baixar-whatsapp" target="_blank" rel="noopener noreferrer">Encontrar GIFs e figurinhas ↗</a></p><div class="chat-media-tools"><input id="chat-media-search" type="search" placeholder="Pesquisar" aria-label="Pesquisar na biblioteca"><select id="chat-media-category" aria-label="Categoria"></select></div><div class="chat-chips">${views.map(([id, label]) => `<button type="button" data-chat-library-view="${id}" class="${id === "" ? "active" : ""}">${label}</button>`).join("")}</div><div id="chat-media-grid" class="chat-media-grid ${kind === "GIF" ? "gif" : ""}"></div>`;
    picker.hidden = false;
    loadLibrary();
  }

  const assetRequests = new Map();
  let sendingAsset = false;
  async function sendAsset(assetId, extra = {}) {
    if (sendingAsset) return;
    const conversationId = state.selectedId;
    const quoted = replyPayload(conversationId);
    const key = JSON.stringify([conversationId, assetId, quoted]);
    if (!assetRequests.has(key)) assetRequests.set(key, crypto.randomUUID());
    sendingAsset = true;
    closePopovers();
    try {
      await api(`/api/conversations/${encodeURIComponent(conversationId)}/library-send`, { method: "POST", body: JSON.stringify({ assetId, ...quoted, ...extra, clientRequestId: assetRequests.get(key) }) });
      assetRequests.delete(key);
      onSent(conversationId);
      await openConversation(conversationId);
    } catch (error) { toast(error.message, true); }
    finally { sendingAsset = false; }
  }

  function chooseAsset(assetId) {
    const asset = library.data?.items.find((item) => item.id === assetId);
    if (!asset) return undefined;
    if (asset.kind !== "GIF") return sendAsset(assetId);
    showDialog("Enviar GIF", `<video class="chat-gif-preview" src="${esc(asset.url)}" autoplay muted loop playsinline></video><p class="chat-note">Será enviado como vídeo MP4: a API oficial não envia GIF, e o cliente pode precisar tocar para reproduzir.</p><div class="chat-dialog-actions"><button type="button" class="secondary" data-chat-dialog-close>Cancelar</button><button type="button" data-chat-gif-send="${esc(assetId)}">Enviar como vídeo</button></div>`);
    return undefined;
  }

  function scopeFields() {
    const data = library.data || {};
    const teams = data.teams || [];
    return `<label>Guardar em<select id="chat-asset-scope"><option value="PERSONAL">Minha biblioteca</option>${teams.length ? '<option value="TEAM">Equipe do setor</option>' : ""}${data.canManageShared ? '<option value="COMPANY">Toda a empresa</option>' : ""}</select></label><label id="chat-asset-team-field" hidden>Setor<select id="chat-asset-team">${teams.map((team) => `<option value="${esc(team.id)}">${esc(team.name)}</option>`).join("")}</select></label><label>Nome<input id="chat-asset-name" maxlength="80"></label><label>Categoria<input id="chat-asset-category" maxlength="60"></label><label>Palavras-chave<input id="chat-asset-tags" maxlength="200" placeholder="separadas por vírgula"></label>`;
  }

  function assetFields() {
    const scope = el("#chat-asset-scope").value;
    return { scope, ...(scope === "TEAM" ? { teamId: el("#chat-asset-team").value } : {}), name: el("#chat-asset-name").value.trim(), category: el("#chat-asset-category").value.trim(), tags: el("#chat-asset-tags").value };
  }

  function openUpload() {
    const sticker = library.kind === "STICKER";
    showDialog(sticker ? "Adicionar figurinha" : "Adicionar GIF", `<form id="chat-asset-form" class="chat-form"><label>Arquivo<input id="chat-asset-file" type="file" required accept="${sticker ? ".webp,image/webp" : ".gif,.mp4,image/gif,video/mp4"}"></label>${scopeFields()}<p class="chat-note">${sticker ? "WebP de 512×512 px. Estática até 100 KB; animada até 500 KB." : "GIF ou MP4 (H.264), até 30 segundos. GIF é convertido para MP4."}</p><div class="chat-dialog-actions"><button type="button" class="secondary" data-chat-dialog-close>Cancelar</button><button type="submit">Adicionar</button></div></form>`);
  }

  async function submitUpload(event) {
    event.preventDefault();
    const button = event.target.querySelector('button[type="submit"]');
    const form = new FormData();
    form.append("file", el("#chat-asset-file").files[0]);
    form.append("kind", library.kind);
    form.append("conversationId", state.selectedId);
    Object.entries(assetFields()).forEach(([key, value]) => { if (value) form.append(key, value); });
    button.disabled = true;
    try {
      const result = await api("/api/media-library", { method: "POST", body: form });
      closeDialog();
      toast(result.converted ? "GIF convertido para MP4 e adicionado." : "Adicionado à biblioteca.");
      await loadLibrary();
    } catch (error) { toast(error.message, true); button.disabled = false; }
  }

  async function openSaveSticker(message) {
    try {
      const params = new URLSearchParams({ kind: "STICKER", conversationId: state.selectedId });
      library = { ...library, kind: "STICKER", data: await api(`/api/media-library?${params}`) };
      const dialog = showDialog("Salvar figurinha", `<form id="chat-sticker-form" class="chat-form"><img class="chat-sticker-large" src="/api/messages/${encodeURIComponent(message.id)}/media" alt="">${scopeFields()}<div class="chat-dialog-actions"><button type="button" class="secondary" data-chat-dialog-close>Cancelar</button><button type="submit">Salvar</button></div></form>`);
      dialog.dataset.messageId = message.id;
    } catch (error) { toast(error.message, true); }
  }

  async function submitSticker(event) {
    event.preventDefault();
    try {
      await api(`/api/messages/${encodeURIComponent(el("#chat-dialog").dataset.messageId)}/save-sticker`, { method: "POST", body: JSON.stringify(assetFields()) });
      closeDialog();
      toast("Figurinha salva.");
    } catch (error) { toast(error.message, true); }
  }

  // ===== Visualizador de imagem =====

  let zoom = 1;
  function setZoom(value) {
    zoom = Math.min(5, Math.max(1, value));
    const image = el("#chat-lightbox-image");
    if (image) { image.style.transform = `scale(${zoom})`; image.classList.toggle("zoomed", zoom > 1); }
  }

  function openLightbox(src, alt, download) {
    zoom = 1;
    const dialog = showDialog("Visualizar", `<div class="chat-lightbox"><img id="chat-lightbox-image" src="${esc(src)}" alt="${esc(alt)}"></div><div class="chat-dialog-actions"><button type="button" class="secondary" data-chat-zoom="-0.5" aria-label="Diminuir zoom">−</button><button type="button" class="secondary" data-chat-zoom="0.5" aria-label="Aumentar zoom">＋</button><a class="chat-link-button" href="${esc(src)}" download="${esc(download)}">Baixar</a></div>`, { wide: true });
    dialog.querySelector(".chat-lightbox").addEventListener("wheel", (event) => { event.preventDefault(); setZoom(zoom + (event.deltaY < 0 ? 0.25 : -0.25)); }, { passive: false });
  }

  // ===== Links =====

  // Tira URLs do texto antes da formatação *negrito*/_itálico_, que quebraria
  // endereços com esses caracteres. O texto já vem escapado.
  function protectLinks(escapedText, links) {
    if (!on("media")) return escapedText;
    return escapedText.replace(/\b(?:https?:\/\/|www\.)[^\s<]+/gi, (match) => {
      const trailing = match.match(/(?:[),.!?;:\]}]|&#39;|&quot;)+$/)?.[0] || "";
      const url = trailing ? match.slice(0, -trailing.length) : match;
      links.push(url);
      return `${links.length - 1}${trailing}`;
    });
  }

  function restoreLinks(html, links) {
    return html.replace(/(\d+)/g, (_match, index) => {
      const url = links[Number(index)];
      const href = /^www\./i.test(url) ? `https://${url}` : url;
      let host = "";
      try { host = new URL(href.replaceAll("&amp;", "&")).hostname; } catch { return url; }
      const suspicious = host.split(".").some((part) => part.startsWith("xn--"));
      return `<a class="chat-link" href="${href}" target="_blank" rel="noopener noreferrer nofollow" title="${esc(host)}${suspicious ? " — endereço com caracteres parecidos, confira antes de abrir" : ""}">${suspicious ? "⚠ " : ""}${url}</a>`;
    });
  }

  const audioSpeedButton = () => (on("media") ? '<button type="button" class="chat-audio-speed" data-chat-audio-speed aria-label="Velocidade do áudio">1×</button>' : "");

  function cycleSpeed(button) {
    const audio = button.closest("[data-audio-player]")?.querySelector("audio");
    if (!audio) return;
    const speeds = [1, 1.5, 2];
    const next = speeds[(speeds.indexOf(audio.playbackRate) + 1) % speeds.length] || 1;
    audio.playbackRate = next;
    button.textContent = `${next}×`;
  }

  // ===== Voltar ao fim =====

  const nearBottom = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < 120;

  function syncScrollButton() {
    const button = el("#chat-scroll-bottom");
    const box = el("#messages");
    if (!button || !box) return;
    if (nearBottom(box)) newMessages = 0;
    button.hidden = !on("media") || nearBottom(box);
    const area = el("#chat-content").getBoundingClientRect();
    button.style.bottom = `${Math.round(area.bottom - box.getBoundingClientRect().bottom + 12)}px`;
    button.querySelector("span").textContent = newMessages ? String(newMessages) : "";
    button.querySelector("span").hidden = !newMessages;
  }

  // ===== Ciclo de vida =====

  function onConversationChange() {
    clearReply();
    closeMenu();
    closePopovers();
    const panel = el("#chat-search-panel");
    if (panel) panel.hidden = true;
    conversation = null;
    newMessages = 0;
    lastCount = 0;
  }

  function onConversation(c, messageCount) {
    conversation = c;
    if (reply && reply.conversationId !== c.id) clearReply();
    if (on("pins")) renderPins(c.pinnedMessages || []);
    const whatsapp = c.channel === "META" && !readOnly();
    const show = (selector, visible) => { const node = el(selector); if (node) node.hidden = !visible; };
    show("#chat-open-emoji", on("emoji"));
    show("#chat-menu-emoji", on("emoji"));
    show("#chat-open-media", whatsapp && (on("stickers") || on("gifs")));
    show("#chat-menu-media", whatsapp && (on("stickers") || on("gifs")));
    show("#chat-open-search", on("search") || on("stars"));
    if (lastCount && messageCount > lastCount && !nearBottom(el("#messages"))) newMessages += messageCount - lastCount;
    lastCount = messageCount;
    syncScrollButton();
  }

  function clickHandler(event) {
    const target = event.target;
    const hit = (selector) => target.closest?.(selector);
    let node;
    if ((node = hit("[data-chat-menu]"))) { const box = node.getBoundingClientRect(); return openMenu(node.dataset.chatMenu, box.left, box.bottom + 4); }
    if ((node = hit("[data-chat-action]"))) {
      const message = findMessage(el("#chat-action-menu").dataset.messageId);
      if (message) runAction(node.dataset.chatAction, message).catch((error) => toast(error.message, true));
      return undefined;
    }
    if ((node = hit("[data-chat-react]"))) return react(el("#chat-action-menu").dataset.messageId, node.dataset.chatReact);
    if (hit("[data-chat-react-more]")) { const id = el("#chat-action-menu").dataset.messageId; closeMenu(); return openEmoji((emoji) => react(id, emoji)); }
    if ((node = hit("[data-chat-unreact]"))) return react(node.dataset.chatUnreact, "");
    if ((node = hit("[data-chat-unpin]"))) {
      api(`/api/messages/${encodeURIComponent(node.dataset.chatUnpin)}/pin`, { method: "PUT", body: JSON.stringify({ pinned: false }) }).then(refresh).catch((error) => toast(error.message, true));
      return undefined;
    }
    if ((node = hit("[data-chat-jump]"))) {
      event.preventDefault();
      closeDialog();
      return jump(node.dataset.chatJump);
    }
    if (hit("[data-chat-reply-cancel]")) return clearReply();
    if (hit("#chat-menu-emoji,#chat-menu-media")) closeAttachmentMenu();
    if (hit("#chat-open-emoji,#chat-menu-emoji")) { const picker = el("#chat-emoji-picker"); if (picker.hidden) openEmoji(null); else closePopovers(); return undefined; }
    if (hit("#chat-open-media,#chat-menu-media")) { const picker = el("#chat-media-picker"); if (picker.hidden) openLibrary("STICKER"); else closePopovers(); return undefined; }
    if (hit("#chat-open-search")) return openSearchPanel(on("search") ? "search" : "stars");
    if (hit("[data-chat-search-close]")) { el("#chat-search-panel").hidden = true; return undefined; }
    if ((node = hit("[data-chat-search-tab]"))) return openSearchPanel(node.dataset.chatSearchTab);
    if (hit("#chat-search-more")) return runSearch({ more: true });
    if (hit("[data-chat-emoji-more]")) { emojiLimit += 120; return renderEmoji(emojiCategory, emojiTerm); }
    if ((node = hit("[data-chat-emoji-tab]"))) return renderEmoji(node.dataset.chatEmojiTab);
    if (hit("[data-chat-export-emojis]")) {
      const text = (window.CHAT_EMOJI_DATA || []).flatMap(category => [category.label, ...category.items.map(item => item.emoji + " " + item.words), ""]).join("\n");
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = "emojis.txt"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); return;
    }
    if ((node = hit("[data-chat-emoji]"))) return chooseEmoji(node.dataset.chatEmoji);
    if ((node = hit("[data-chat-library]"))) return openLibrary(node.dataset.chatLibrary);
    if (hit("[data-chat-library-add]")) return openUpload();
    if ((node = hit("[data-chat-library-view]"))) {
      library.view = node.dataset.chatLibraryView;
      document.querySelectorAll("[data-chat-library-view]").forEach((button) => button.classList.toggle("active", button === node));
      return loadLibrary();
    }
    if ((node = hit("[data-chat-asset]"))) return chooseAsset(node.dataset.chatAsset);
    if ((node = hit("[data-chat-asset-star]"))) {
      const asset = library.data.items.find((item) => item.id === node.dataset.chatAssetStar);
      api(`/api/media-library/${encodeURIComponent(asset.id)}/favorite`, { method: "PUT", body: JSON.stringify({ favorite: !asset.favorite }) }).then(loadLibrary).catch((error) => toast(error.message, true));
      return undefined;
    }
    if ((node = hit("[data-chat-asset-remove]"))) {
      api(`/api/media-library/${encodeURIComponent(node.dataset.chatAssetRemove)}`, { method: "DELETE" }).then(loadLibrary).catch((error) => toast(error.message, true));
      return undefined;
    }
    if ((node = hit("[data-chat-gif-send]"))) { closeDialog(); return sendAsset(node.dataset.chatGifSend, { confirmedVideo: true }); }
    if (hit("[data-chat-dialog-close]")) return closeDialog();
    if ((node = hit("[data-chat-forward-to]"))) return confirmForward(node);
    if ((node = hit("[data-chat-forward-confirm]"))) return sendForward(node);
    if ((node = hit("[data-chat-zoom]"))) return setZoom(zoom + Number(node.dataset.chatZoom));
    if ((node = hit("[data-chat-audio-speed]"))) return cycleSpeed(node);
    if (hit("#chat-scroll-bottom")) { setTimelineScroll(el("#messages").scrollHeight); return syncScrollButton(); }
    if (on("media") && (node = hit("#messages .message-image-link"))) {
      event.preventDefault();
      return openLightbox(node.href, node.querySelector("img")?.alt || "Imagem", "imagem");
    }
    if (on("media") && (node = hit("#messages .message-sticker"))) return openLightbox(node.src, "Figurinha", "figurinha.webp");
    if (!hit("#chat-action-menu")) closeMenu();
    if (!hit("#chat-emoji-picker,#chat-media-picker,dialog")) closePopovers();
    return undefined;
  }

  function touchHandlers(box) {
    let timer = null;
    let start = null;
    const cancel = () => { clearTimeout(timer); timer = null; };
    box.addEventListener("touchstart", (event) => {
      const row = event.target.closest?.(".message-row[data-message-id]");
      if (!row || event.touches.length !== 1) return;
      const touch = event.touches[0];
      start = { row, x: touch.clientX, y: touch.clientY, dx: 0 };
      timer = setTimeout(() => { navigator.vibrate?.(15); openMenu(row.dataset.messageId, touch.clientX, touch.clientY); start = null; }, LONG_PRESS_MS);
    }, { passive: true });
    box.addEventListener("touchmove", (event) => {
      if (!start) return;
      const touch = event.touches[0];
      const dx = touch.clientX - start.x;
      const dy = Math.abs(touch.clientY - start.y);
      if (Math.abs(dx) > 8 || dy > 8) cancel();
      if (dy > 24) { start.row.style.transform = ""; start = null; return; }
      if (dx > 0 && on("reply")) { start.dx = dx; start.row.style.transform = `translateX(${Math.min(dx, SWIPE_REPLY_PX + 16)}px)`; }
    }, { passive: true });
    box.addEventListener("touchend", () => {
      cancel();
      if (!start) return;
      start.row.style.transform = "";
      const message = findMessage(start.row.dataset.messageId);
      if (start.dx >= SWIPE_REPLY_PX && message && actionsFor(message).some((action) => action.id === "reply")) setReply(message);
      start = null;
    }, { passive: true });
    box.addEventListener("touchcancel", () => { cancel(); if (start) start.row.style.transform = ""; start = null; }, { passive: true });
  }

  function bindOnce() {
    document.addEventListener("click", clickHandler);
    document.addEventListener("input", (event) => {
      if (event.target.id === "chat-emoji-search") renderEmoji(null, event.target.value);
      if (event.target.id === "chat-forward-term") searchForward();
      if (event.target.id === "chat-media-search") { library.q = event.target.value.trim(); clearTimeout(forwardTimer); forwardTimer = setTimeout(loadLibrary, 250); }
    });
    document.addEventListener("change", (event) => {
      if (event.target.id === "chat-media-category") { library.category = event.target.value; loadLibrary(); }
      if (event.target.id === "chat-asset-scope") el("#chat-asset-team-field").hidden = event.target.value !== "TEAM";
    });
    document.addEventListener("submit", (event) => {
      if (event.target.id === "chat-search-form") { event.preventDefault(); runSearch(); }
      if (event.target.id === "chat-asset-form") submitUpload(event);
      if (event.target.id === "chat-sticker-form") submitSticker(event);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!el("#chat-action-menu")?.hidden) return closeMenu();
      if (!el("#chat-emoji-picker")?.hidden || !el("#chat-media-picker")?.hidden) return closePopovers();
      if (reply && document.activeElement === el("#message-input")) return clearReply();
      return undefined;
    });
    const box = el("#messages");
    box.addEventListener("contextmenu", (event) => {
      const row = event.target.closest(".message-row[data-message-id]");
      if (!row || event.target.closest("a,video,audio") || innerWidth <= 700) return;
      event.preventDefault();
      openMenu(row.dataset.messageId, event.clientX, event.clientY);
    });
    box.addEventListener("scroll", syncScrollButton, { passive: true });
    touchHandlers(box);
  }

  async function init() {
    try { flags = await api("/api/chat/features"); } catch { flags = {}; }
    if (!Object.values(flags).some((value) => value === true)) return;
    document.body.classList.add("chat-features-on");
    bindOnce();
    if (state.selectedId) {
      state.selectedMessagesSignature = "";
      await refresh().catch(() => {});
    }
  }

  window.ChatFeatures = { appendReply, audioSpeedButton, clearReply, flags: () => flags, init, jump, onConversation, onConversationChange, onSent, openEmoji, protectLinks, quickReactions: QUICK_REACTIONS, replyPayload, restoreLinks, rowParts };
})();
