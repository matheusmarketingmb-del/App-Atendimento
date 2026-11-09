(() => {
  // Chat interno por empresa: usa o MESMO workspace da Central
  // (window.CentralWorkspace, app.js) — sem seletor próprio. Toda requisição
  // informa o workspace ativo (X-Workspace) e o servidor confere empresa e
  // participação; respostas de uma empresa anterior são descartadas (epoch).
  const state = {
    chats: [],
    currentChatId: null,
    currentUser: null,
    selectedFile: null,
    selectedFileUrl: null,
    openSequence: 0,
    users: [],
    group: null,
    epoch: 0,
    companyId: null,
    unread: null,
    searchSequence: 0,
    listSequence: 0,
    messages: [],
    hasOlder: false,
    hasNewer: false,
    historyLoading: false,
    historyError: false,
  };

  const $ = (selector) => document.querySelector(selector);
  const DRAFTS_KEY = "central-internal-drafts";

  const formatFileSize = (bytes = 0) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;

  async function isSafeImageFile(file) {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const ascii = String.fromCharCode(...bytes);
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
    if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return true;
    if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return true;
    return ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP";
  }

  const escapeHtml = (value = "") =>
    String(value).replace(/[&<>'"]/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    })[char]);

  // Empresa ativa da Central (null enquanto a Central ainda carrega).
  const activeCompany = () => window.CentralWorkspace?.current?.() || null;
  const companyColor = (company) => company?.primaryColor || company?.color || "";

  async function api(url, options = {}) {
    const isFormData = options.body instanceof FormData;
    const headers = { ...(options.headers || {}) };
    if (!isFormData) headers["Content-Type"] = "application/json";
    const company = options.company === undefined ? activeCompany() : options.company;
    if (company?.slug) headers["X-Workspace"] = company.slug;

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw Object.assign(new Error(body.error || "Erro no chat interno."), { statusCode: response.status });
    }

    return response.json();
  }

  function formatTime(value) {
    if (!value) return "";

    return new Intl.DateTimeFormat("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
    }).format(new Date(value));
  }

  function chatDisplayName(chat) {
    if (chat.type !== "DIRECT") {
      return chat.name || "Chat interno";
    }

    const other = chat.members?.find(
      (user) => user.id !== state.currentUser?.id
    );

    return other?.name || "Conversa direta";
  }

  function chatIcon(chat) {
    if (chat.type === "GENERAL") return "#";
    if (chat.type === "SECTOR") return "#";
    if (chat.type === "GROUP") return "👥";
    return "●";
  }

  // ------------------------------------------------------------ rascunhos
  // Canal da empresa: rascunho por empresa + canal; conversas da equipe
  // (diretas e grupos) valem em qualquer empresa. Só nesta aba (sessionStorage).
  function readDrafts() {
    try { return JSON.parse(sessionStorage.getItem(DRAFTS_KEY) || "{}") || {}; } catch { return {}; }
  }
  function draftKey(chatId = state.currentChatId) {
    if (!chatId) return null;
    const chat = state.chats.find((item) => item.id === chatId);
    return `${chat?.scope === "COMPANY" ? chat.companyId : "team"}:${chatId}`;
  }
  function saveDraft() {
    const key = draftKey();
    const input = $("#internal-chat-input");
    if (!key || !input || input.disabled) return;
    const drafts = readDrafts();
    if (input.value.trim()) drafts[key] = input.value; else delete drafts[key];
    try { sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch {}
  }
  function restoreDraft(chatId) {
    const input = $("#internal-chat-input");
    if (input) input.value = readDrafts()[draftKey(chatId)] || "";
  }
  function clearDraft() {
    const key = draftKey();
    if (!key) return;
    const drafts = readDrafts();
    delete drafts[key];
    try { sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch {}
  }

  // --------------------------------------------------------- lista lateral
  function searchTerm() {
    return String($("#internal-chat-search")?.value || "").trim().toLocaleLowerCase("pt-BR");
  }

  function matchesSearch(chat, term) {
    if (!term) return true;
    const names = [chatDisplayName(chat), chat.description || "", ...(chat.members || []).map((member) => member.name || "")];
    return names.some((name) => name.toLocaleLowerCase("pt-BR").includes(term));
  }

  let lastChatListMarkup = null;
  let lastChatListFirstChild = null;

  function updateChatSelection() {
    document.querySelectorAll('#internal-chat-list [data-chat-id]').forEach((button) => {
      const selected = button.dataset.chatId === state.currentChatId;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }

  function renderChatList() {
    const container = $("#internal-chat-list");
    if (!container) return;

    if (!state.chats.length) {
      container.innerHTML =
        '<div class="internal-chat-empty-list">Nenhum chat disponível.</div>';
      return;
    }

    const term = searchTerm();
    const visible = state.chats.filter((chat) => matchesSearch(chat, term));
    const legacy = visible.filter((chat) => chat.scope === "LEGACY");
    const company = activeCompany();

    // Canais = categorias da empresa ativa. Diretas e grupos = da equipe
    // (podem reunir pessoas das duas empresas), iguais em qualquer empresa.
    const sections = [
      [company ? `Canais — ${company.displayName || company.name}` : "Canais", visible.filter((chat) => chat.scope === "COMPANY"), "Nenhum canal desta empresa para você."],
      ["Conversas diretas", visible.filter((chat) => chat.type === "DIRECT"), "Nenhuma conversa direta."],
      ["Grupos", visible.filter((chat) => chat.type === "GROUP"), "Nenhum grupo ainda."],
    ];
    const markup = sections.map(([title, chats, empty], index) => `
      <div class="internal-chat-section-title${index === 0 ? " company" : ""}">${escapeHtml(title)}</div>
      ${chats.length ? chats.map(chatItemMarkup).join("") : `<div class="internal-group-empty">${term ? "Nada encontrado." : escapeHtml(empty)}</div>`}
    `).join("") + (legacy.length ? `
      <details class="internal-chat-legacy"${legacy.some((chat) => chat.id === state.currentChatId) ? " open" : ""}>
        <summary>Histórico anterior (${legacy.length})</summary>
        <p>O chat Geral antigo, de antes da separação por empresa. Fica disponível só para leitura.</p>
        ${legacy.map(chatItemMarkup).join("")}
      </details>` : "");

    // Preserve hovered/focused buttons when only selection or counters refresh.
    if (markup === lastChatListMarkup && container.firstChild === lastChatListFirstChild) {
      updateChatSelection();
      return;
    }
    container.innerHTML = markup;
    lastChatListMarkup = markup;
    lastChatListFirstChild = container.firstChild;
    updateChatSelection();
    container.querySelectorAll("[data-chat-id]").forEach((button) => {
      button.addEventListener("click", () => {
        openChat(button.dataset.chatId).catch(showError);
      });
    });
  }

  function chatItemMarkup(chat) {
    const preview = chat.lastMessage?.text
      || (chat.lastMessage?.metadata?.media?.fileName
        ? `📎 ${chat.lastMessage.metadata.media.fileName}`
        : (chat.lastMessage?.type === "TRANSFER"
          ? "Nova transferência"
          : "Sem mensagens"));
    // Conversa direta: de qual empresa a outra pessoa é (só identificação).
    const other = chat.type === "DIRECT" ? state.users.find((user) => chat.members?.some((member) => member.id === user.id)) : null;
    const tags = other ? companyTags(other.companyIds) : "";

    return `
      <button
        type="button"
        class="internal-chat-item${chat.legacy ? " legacy" : ""}"
        data-chat-id="${escapeHtml(chat.id)}"
      >
        <span class="internal-chat-item-icon">
          ${escapeHtml(chatIcon(chat))}
        </span>

        <span class="internal-chat-item-content">
          <strong>${escapeHtml(chatDisplayName(chat))}${tags}</strong>
          <small>${escapeHtml(preview)}</small>
        </span>

        ${
          chat.unreadCount
            ? `<b>${chat.unreadCount}</b>`
            : ""
        }
      </button>
    `;
  }

  // Etiquetas de empresa (MIBRO / SINCROFIT) de uma pessoa.
  function companyTags(companyIds = []) {
    const companies = window.CentralWorkspace?.companies?.() || [];
    if (companies.length < 2) return "";
    return companies.filter((company) => companyIds.includes(company.id)).map((company) => {
      const color = companyColor(company);
      return `<i class="internal-company-tag"${color ? ` style="--company-color:${escapeHtml(color)}"` : ""}>${escapeHtml(company.displayName || company.name)}</i>`;
    }).join("");
  }

  function renderHeading() {
    const company = activeCompany();
    const label = $("#internal-chat-company");
    if (label) {
      label.hidden = !company;
      label.textContent = company ? `— ${company.displayName || company.name}` : "";
    }
    const dialog = $("#internal-chat-dialog");
    if (dialog) {
      const color = companyColor(company);
      if (color) dialog.style.setProperty("--company-color", color); else dialog.style.removeProperty("--company-color");
      dialog.dataset.workspace = company?.slug || "";
    }
    renderWorkspaceTabs();
  }

  // Botão do menu = canais da empresa ativa + conversas da equipe. Abas =
  // canais de cada empresa (app.js). Fonte única: /api/internal-chats/unread.
  function syncGlobalUnread() {
    const companyId = activeCompany()?.id;
    const item = state.unread?.workspaces?.find((entry) => entry.companyId === companyId);
    const count = state.unread
      ? (item?.unreadMessages || 0) + (state.unread.shared?.unreadMessages || 0)
      : state.chats.filter((chat) => !chat.legacy).reduce((total, chat) => total + Number(chat.unreadCount || 0), 0);

    const badge = $("#internal-chat-unread");
    if (!badge) return;

    badge.textContent = count > 99 ? "99+" : String(count);
    badge.hidden = count === 0;
    renderWorkspaceTabs();
  }

  // Seletor de empresa dentro do chat = o MESMO da página inicial (troca o
  // workspace da Central). Contador = canais daquela empresa ainda não lidos.
  // Nunca troca sozinho.
  function renderWorkspaceTabs() {
    const container = $("#internal-chat-other");
    if (!container) return;
    const companies = window.CentralWorkspace?.companies?.() || [];
    const active = activeCompany()?.id;
    container.hidden = companies.length < 2;
    if (companies.length < 2) { container.innerHTML = ""; return; }
    container.setAttribute("role", "tablist");
    container.setAttribute("aria-label", "Empresa dos canais");
    container.innerHTML = companies.map((company) => {
      const item = state.unread?.workspaces?.find((entry) => entry.companyId === company.id);
      const count = item?.unreadMessages || 0;
      const isActive = company.id === active;
      const color = companyColor(company);
      const label = `${company.name}${count ? ` — ${count} não lida${count === 1 ? "" : "s"} nos canais` : ""}`;
      return `<button type="button" role="tab" aria-selected="${isActive}" class="${isActive ? "active" : ""}${count && !isActive ? " has-news" : ""}" data-open-workspace="${escapeHtml(company.slug)}" data-open-chat="${escapeHtml(isActive ? "" : item?.latestChatId || "")}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"${color ? ` style="--company-color:${escapeHtml(color)}"` : ""}>
        <i class="company-dot" aria-hidden="true"></i><span>${escapeHtml(company.displayName || company.name)}</span>${count ? `<b aria-hidden="true">${count > 99 ? "99+" : count}</b>` : ""}
      </button>`;
    }).join("");
  }

  const notifiedUnread = new Set();
  async function refreshUnread({ notify = true } = {}) {
    try {
      const data = await api("/api/internal-chats/unread", { company: null });
      state.unread = data;
      const arrived = window.CentralWorkspace?.setInternalUnread?.(data.workspaces || []) || [];
      syncGlobalUnread();
      if (notify) notifyOtherWorkspaces(arrived);
    } catch { /* contador é informativo; a lista continua funcionando */ }
  }

  // Notificação do sistema (aba em segundo plano) para canal de outra
  // empresa: sem conteúdo da mensagem, deduplicada pelo id da última não lida.
  function notifyOtherWorkspaces(companyIds) {
    if (!document.hidden || typeof window.mibroNotify !== "function") return;
    const companies = window.CentralWorkspace?.companies?.() || [];
    for (const companyId of companyIds) {
      const item = state.unread?.workspaces?.find((entry) => entry.companyId === companyId);
      if (!item?.latestUnreadId || notifiedUnread.has(item.latestUnreadId)) continue;
      notifiedUnread.add(item.latestUnreadId);
      const company = companies.find((entry) => entry.id === companyId);
      Promise.resolve(window.mibroNotify(`Chat interno — ${company?.displayName || "outra empresa"}: nova mensagem`, {
        tag: `internal:${item.latestUnreadId}`,
        data: { url: `/?internalChat=${encodeURIComponent(item.latestChatId || "")}&company=${encodeURIComponent(company?.slug || "")}` },
      })).catch(() => {});
    }
  }

  async function loadChats() {
    const sequence = ++state.listSequence;
    const epoch = state.epoch;
    const company = activeCompany();
    const chats = await api("/api/internal-chats", { company });
    // Resposta atrasada de outro workspace nunca entra na lista atual.
    if (sequence !== state.listSequence || epoch !== state.epoch || (company && company.id !== activeCompany()?.id)) return false;
    // Canais só da empresa ativa (o servidor já filtra; conferência dupla).
    state.chats = chats.filter((chat) => chat.scope !== "COMPANY" || !company || chat.companyId === company.id);
    state.companyId = company?.id || null;

    renderChatList();
    syncGlobalUnread();
    return true;
  }

  function renderTransferMessage(message) {
    const meta = message.metadata || {};

    const actor =
      meta.actorName ||
      message.senderUser?.name ||
      "Alguém";

    const destination =
      meta.toCategory ||
      "outro setor";

    return `
    <div class="internal-transfer-line">
      <span>↪</span>
      <p>
        <strong>${escapeHtml(actor)}</strong>
        sinalizou envio para
        <strong>${escapeHtml(destination)}</strong>
      </p>
      <small>${escapeHtml(formatTime(message.createdAt))}</small>
    </div>
  `;
  }

  // Reações locais do chat interno: nunca passam pela Meta.
  function internalReactionsMarkup(message) {
    if (!window.ChatFeatures?.flags().internalReactions || message.type !== "USER") return "";
    const groups = new Map();
    for (const reaction of message.reactions || []) {
      if (!groups.has(reaction.emoji)) groups.set(reaction.emoji, []);
      groups.get(reaction.emoji).push(reaction);
    }
    const me = state.currentUser?.id;
    const chips = [...groups].map(([emoji, rows]) => {
      const mine = rows.some((row) => row.userId === me);
      return `<button type="button" class="${mine ? "mine" : ""}" data-internal-react="${escapeHtml(mine ? "" : emoji)}" title="${escapeHtml(rows.map((row) => row.user?.name).filter(Boolean).join(", "))}">${escapeHtml(emoji)} ${rows.length}</button>`;
    }).join("");
    return `<div class="internal-reactions" data-internal-reactions="${escapeHtml(JSON.stringify(message.reactions || []))}">${chips}<button type="button" data-internal-react-more aria-label="Reagir">＋</button></div>`;
  }

  function syncInternalReactions(row, message) {
    const current = row.querySelector(".internal-reactions");
    const next = internalReactionsMarkup(message);
    if (!next) return;
    const template = document.createElement("template");
    template.innerHTML = next;
    const fresh = template.content.firstElementChild;
    if (current?.dataset.internalReactions === fresh.dataset.internalReactions) return;
    if (current) current.replaceWith(fresh); else row.querySelector(".internal-message-bubble")?.append(fresh);
  }

  function renderMessages(messages, { forceScroll = false, highlightId = null, preservePosition = false } = {}) {
    const container = $("#internal-chat-messages");
    if (!container) return;

    const wasNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    const preserveAnchor=!forceScroll&&!highlightId&&(!wasNearBottom||preservePosition);
    const anchor=preserveAnchor?[...container.querySelectorAll('[data-message-id]')].find(node=>node.getBoundingClientRect().bottom>container.getBoundingClientRect().top):null;
    const anchorOffset=anchor?anchor.getBoundingClientRect().top-container.getBoundingClientRect().top:0;
    const oldTop=container.scrollTop;
    const renderSequence=state.openSequence,renderChatId=state.currentChatId;
    const stillCurrent=()=>renderSequence===state.openSequence&&renderChatId===state.currentChatId;

    if (!messages.length) {
      container.innerHTML =
        '<div class="internal-chat-empty">Nenhuma mensagem neste chat.</div>';
      return;
    }

    const existing=new Map([...container.children].map(node=>[node.dataset.messageId,node]));
    const markup = messages.map((message) => {
      if(existing.has(message.id))return null;
      if (message.type === "TRANSFER") {
        return `<div data-message-id="${escapeHtml(message.id)}">${renderTransferMessage(message)}</div>`;
      }

      if (message.type === "SYSTEM") {
        return `<div class="internal-system-line" data-message-id="${escapeHtml(message.id)}">${escapeHtml(message.text || "")} <small>${escapeHtml(formatTime(message.createdAt))}</small></div>`;
      }

      const own = message.senderUserId === state.currentUser?.id;

      const media = message.metadata?.media;

      const mediaUrl = `/api/internal-messages/${encodeURIComponent(message.id)}/media`;
      const isImage = media?.safeImage === true || (
        media?.safeImage !== false && /[.](jpg|png)$/.test(media?.storageKey || "")
      );
      const attachment = media?.storageKey ? (isImage
        ? `<a href="${mediaUrl}" target="_blank" rel="noopener" class="internal-message-image-link"><img class="internal-message-image" src="${mediaUrl}" alt="${escapeHtml(media.fileName || "Imagem")}" loading="lazy"></a>`
        : `<a href="${mediaUrl}" class="internal-message-file"><span>📎</span><span><b>${escapeHtml(media.fileName || "Arquivo")}</b><small>${formatFileSize(media.size)}</small></span><strong>Baixar</strong></a>`)
        : "";

      return `
        <div class="internal-message-row ${own ? "own" : ""}${message.id === highlightId ? " highlight" : ""}" data-message-id="${escapeHtml(message.id)}">
          <div class="internal-message-bubble">
            <strong>${escapeHtml(message.senderUser?.name || "Sistema")}</strong>
            ${attachment}
            ${message.text ? `<p>${escapeHtml(message.text)}</p>` : ""}
            <small>${formatTime(message.createdAt)}</small>
            ${internalReactionsMarkup(message)}
          </div>
        </div>
      `;
    });
    // Keep existing nodes (especially images/media) instead of rebuilding the
    // entire transcript on every real-time event or history page.
    const nodes=messages.map((message,index)=>{
      const old=existing.get(message.id);
      if(old){old.classList.toggle('highlight',message.id===highlightId);syncInternalReactions(old,message);return old;}
      const template=document.createElement('template');template.innerHTML=markup[index];return template.content.firstElementChild;
    });
    if(state.hasOlder){
      let button=container.querySelector('[data-internal-history]');
      if(!button){button=document.createElement('button');button.type='button';button.dataset.internalHistory='true';button.className='secondary-button';button.style.cssText='display:block;margin:8px auto;';}
      button.disabled=state.historyLoading;button.textContent=state.historyLoading?'Carregando mensagens anteriores…':state.historyError?'Tentar carregar mensagens anteriores':'Carregar mensagens anteriores';nodes.unshift(button);
    }
    if(state.hasNewer){
      let button=container.querySelector('[data-internal-latest]');
      if(!button){button=document.createElement('button');button.type='button';button.dataset.internalLatest='true';button.className='secondary-button';button.textContent='Ir para mensagens mais recentes';button.style.cssText='display:block;margin:8px auto;';}
      nodes.push(button);
    }
    const keep=new Set(nodes);for(const node of [...container.children])if(!keep.has(node))node.remove();
    let cursor=container.firstElementChild;for(const node of nodes){if(node!==cursor)container.insertBefore(node,cursor);cursor=node.nextElementSibling;}
    if(!forceScroll&&!highlightId&&(!wasNearBottom||preservePosition)){container.scrollTop=anchor?.isConnected?container.scrollTop+anchor.getBoundingClientRect().top-container.getBoundingClientRect().top-anchorOffset:oldTop;}

    if (highlightId) {
      requestAnimationFrame(() => {if(stillCurrent())container.querySelector(`[data-message-id="${CSS.escape(highlightId)}"]`)?.scrollIntoView({ block: "center" });});
    } else if (forceScroll || (wasNearBottom&&!preservePosition)) {
      requestAnimationFrame(() => {
        if(stillCurrent())container.scrollTop = container.scrollHeight;
      });
    }
  }

  async function refreshReactions(){
    const chatId=state.currentChatId;
    if(!chatId||!window.ChatFeatures?.flags().internalReactions)return;
    const page=await messagePage(chatId,{limit:'100'});
    if(chatId!==state.currentChatId)return;
    mergeMessages(page.messages);renderMessages(state.messages,{preservePosition:true});
  }
  document.addEventListener("click",async(event)=>{
    const more=event.target.closest?.("[data-internal-react-more]");
    if(more){more.outerHTML=window.ChatFeatures.quickReactions.map((emoji)=>`<button type="button" data-internal-react="${emoji}" aria-label="Reagir com ${emoji}">${emoji}</button>`).join("");return;}
    const button=event.target.closest?.("[data-internal-react]");
    if(!button)return;
    const id=button.closest("[data-message-id]")?.dataset.messageId;
    if(!id)return;
    try{await api(`/api/internal-chats/messages/${encodeURIComponent(id)}/reactions`,{method:"POST",body:JSON.stringify({emoji:button.dataset.internalReact})});await refreshReactions();}
    catch(error){showError(error);}
  });

  function mergeMessages(messages){
    const merged=new Map(state.messages.map(message=>[message.id,message]));
    for(const message of messages)merged.set(message.id,message);
    state.messages=[...merged.values()].sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)||(a.id<b.id?-1:a.id>b.id?1:0));
  }
  function messagePage(chatId,params={}){
    return api(`/api/internal-chats/${encodeURIComponent(chatId)}/messages?${new URLSearchParams({page:'1',...params})}`);
  }
  async function loadOlderMessages(){
    if(state.historyLoading||!state.hasOlder||!state.messages.length)return;
    const chatId=state.currentChatId,sequence=state.openSequence,epoch=state.epoch;
    state.historyLoading=true;state.historyError=false;renderMessages(state.messages,{preservePosition:true});
    try{
      const page=await messagePage(chatId,{before:state.messages[0].id});
      if(sequence!==state.openSequence||epoch!==state.epoch||chatId!==state.currentChatId)return;
      mergeMessages(page.messages);state.hasOlder=page.hasOlder;
    }catch(error){if(sequence===state.openSequence&&epoch===state.epoch)state.historyError=true;}
    finally{if(sequence===state.openSequence&&epoch===state.epoch){state.historyLoading=false;renderMessages(state.messages,{preservePosition:true});}}
  }
  async function refreshMessageTail({forceScroll=false}={}){
    const chatId=state.currentChatId,sequence=state.openSequence,epoch=state.epoch;
    if(!chatId||state.hasNewer)return; // Search context: keep its bounded window.
    let more=true;
    while(more){
      const after=state.messages.at(-1)?.id;
      const page=await messagePage(chatId,after?{after}:{});
      if(sequence!==state.openSequence||epoch!==state.epoch||chatId!==state.currentChatId)return;
      if(!after)state.hasOlder=page.hasOlder;
      mergeMessages(page.messages);renderMessages(state.messages,{forceScroll});
      more=Boolean(after&&page.hasNewer&&page.messages.length);
    }
  }
  $('#internal-chat-messages')?.addEventListener('scroll',()=>{
    const panel=$('#internal-chat-messages');
    if(panel.scrollTop<90&&panel.scrollHeight-panel.clientHeight>120&&!state.historyError)loadOlderMessages();
  },{passive:true});
  $('#internal-chat-messages')?.addEventListener('click',event=>{
    if(event.target.closest('[data-internal-history]'))loadOlderMessages();
    if(event.target.closest('[data-internal-latest]'))openChat(state.currentChatId).catch(showError);
  });

  function setComposerState(chat) {
    const readOnly = Boolean(chat?.archivedAt || chat?.legacy);
    $("#internal-chat-input").disabled = !chat || readOnly;
    $("#internal-chat-input").placeholder = chat?.legacy
      ? "Histórico anterior à separação por empresa — somente leitura."
      : chat?.archivedAt ? "Grupo encerrado — somente leitura." : "Digite uma mensagem interna...";
    $("#internal-chat-file-input").disabled = !chat || readOnly;
    $("#internal-chat-send").disabled = !chat || readOnly;
  }

  async function openChat(chatId, { highlightId = null } = {}) {
    const chat = state.chats.find((item) => item.id === chatId);
    if (!chat) return;

    const switching = state.currentChatId !== chatId;
    if (state.currentChatId && switching) saveDraft();
    state.currentChatId = chatId;
    const sequence = ++state.openSequence;
    const epoch = state.epoch;
    state.messages=[];state.hasOlder=false;state.hasNewer=false;state.historyLoading=false;state.historyError=false;

    $("#internal-chat-title").textContent = chatDisplayName(chat);

    const company = activeCompany();
    $("#internal-chat-type").textContent = chat.legacy ? "HISTÓRICO ANTERIOR" : ({
      SECTOR: `CANAL — ${company?.displayName || company?.name || "EMPRESA"}`,
      DIRECT: "MENSAGEM DIRETA",
      GROUP: chat.archivedAt ? "GRUPO ENCERRADO" : "GRUPO",
    }[chat.type] || "CHAT INTERNO");

    const isGroup = chat.type === "GROUP";
    const subtitle = $("#internal-chat-subtitle");
    subtitle.hidden = !isGroup && !chat.legacy;
    subtitle.textContent = chat.legacy ? "Somente leitura" : isGroup ? `${chat.memberCount} ${chat.memberCount === 1 ? "membro" : "membros"}${chat.description ? ` · ${chat.description}` : ""}` : "";
    $("#internal-chat-participants").hidden = !isGroup;

    setComposerState(chat);
    restoreDraft(chatId);

    updateChatSelection();
    const messagePanel = $("#internal-chat-messages");
    messagePanel.setAttribute('aria-busy', 'true');
    if (switching) messagePanel.innerHTML = '<div class="internal-chat-empty" role="status">Carregando mensagens…</div>';

    let messages;
    try {
      const page=await messagePage(chatId,highlightId?{around:highlightId}:{});
      messages=page.messages;
      if(sequence===state.openSequence&&epoch===state.epoch){state.messages=messages;state.hasOlder=page.hasOlder;state.hasNewer=page.hasNewer;}
    } catch (error) {
      if (sequence !== state.openSequence || epoch !== state.epoch) return;
      messagePanel.innerHTML = '<div class="internal-chat-empty" role="status">Não foi possível carregar as mensagens. Selecione o chat para tentar novamente.</div>';
      throw error;
    } finally {
      if (sequence === state.openSequence && epoch === state.epoch) messagePanel.removeAttribute('aria-busy');
    }

    if (sequence !== state.openSequence || state.currentChatId !== chatId || epoch !== state.epoch) return;

    renderMessages(messages, { forceScroll: true, highlightId });
    clearChatUnread(chatId);

    await api(
      `/api/internal-chats/${encodeURIComponent(chatId)}/read`,
      { method: "POST" }
    );

    if (sequence === state.openSequence && epoch === state.epoch) {
      refreshUnread({ notify: false });
    }
  }

  async function loadUsers() {
    if (!state.currentUser) return;

    const select = $("#internal-chat-user-select");
    if (!select) return;
    const epoch = state.epoch;

    let users = [];

    try {
      users = await api("/api/internal-chat-users");
    } catch {}

    if (!Array.isArray(users) || epoch !== state.epoch) return;

    // Toda a equipe ativa; cada pessoa traz as empresas em que está.
    state.users = users.filter((user) => user.active !== false && user.id !== state.currentUser.id);

    // Separadores por empresa só para identificação. Quem está nas duas
    // aparece uma vez, no grupo "Mibro e Sincrofit".
    select.innerHTML = '<option value="">Selecionar pessoa</option>' + userGroups(state.users).map(({ label, users: members }) => {
      const options = members.map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)}</option>`).join("");
      return label ? `<optgroup label="${escapeHtml(label)}">${options}</optgroup>` : options;
    }).join("");
    renderChatList();
  }

  async function openDialog({ chatId = null } = {}) {
    const dialog = $("#internal-chat-dialog");

    renderHeading();
    if (!dialog.open) dialog.showModal();

    const sequence = state.openSequence;
    if (!(await loadChats()) || sequence !== state.openSequence) return;

    const selected = state.chats.find(
      (chat) => chat.id === (chatId || state.currentChatId)
    );
    const initial = selected
      || state.chats.find((chat) => chat.scope === "COMPANY")
      || state.chats.find((chat) => !chat.legacy)
      || state.chats[0];

    if (initial) await openChat(initial.id);
  }

  async function detectCurrentUser() {
    try {
      const response = await fetch("/api/auth/status");
      if (!response.ok) return;

      const data = await response.json();
      state.currentUser = data.user || null;
    } catch {}
  }

  function showError(error) {
    if (error?.statusCode === 409) {
      // Conversa de outra empresa ficou aberta: fecha em vez de enviar.
      leaveCurrentChatView(error.message);
      loadChats().catch(() => {});
      return;
    }
    alert(error?.message || "Erro no chat interno.");
  }

  // Troca de workspace na Central: fecha o canal da empresa anterior (uma
  // conversa direta ou grupo continua aberto — é da equipe), guarda o
  // rascunho e recarrega canais e contadores.
  function onWorkspaceChanged(event) {
    const company = event.detail?.company || activeCompany();
    if (!event.detail?.initial && company?.id === state.companyId) return;
    saveDraft();
    const current = state.chats.find((chat) => chat.id === state.currentChatId);
    state.epoch++;
    state.chats = current && current.scope !== "COMPANY" ? [current] : [];
    if (state.currentChatId && (!current || current.scope === "COMPANY")) leaveCurrentChatView("Selecione um canal desta empresa ou uma conversa.");
    $("#internal-chat-search").value = "";
    hideSearchResults();
    $("#internal-group-dialog")?.open && $("#internal-group-dialog").close();
    renderHeading();
    renderChatList();
    syncGlobalUnread();
    const dialog = $("#internal-chat-dialog");
    if (dialog?.open) {
      $("#internal-chat-list").innerHTML = `<div class="internal-chat-empty-list">Carregando chats — ${escapeHtml(company?.displayName || "")}…</div>`;
      openDialog().catch(showError);
    } else {
      loadChats().catch(() => {});
    }
    userReady.then(loadUsers).catch(() => {});
    refreshUnread({ notify: false });
    openRequestedChat().catch(showError);
  }
  document.addEventListener("central:workspace-changed", onWorkspaceChanged);

  // Link de notificação: /?internalChat=<id>&company=<slug>. A troca de
  // empresa acontece porque a pessoa clicou na notificação.
  let requestedChat = (() => {
    const params = new URLSearchParams(location.search);
    const chatId = params.get("internalChat");
    if (!chatId) return null;
    history.replaceState({}, "", "/");
    return { chatId, company: params.get("company") || "" };
  })();
  async function openRequestedChat() {
    if (!requestedChat || !activeCompany()) return;
    const { chatId, company } = requestedChat;
    if (company && company !== activeCompany().slug) {
      if (!(window.CentralWorkspace?.companies?.() || []).some((item) => item.slug === company)) { requestedChat = null; return; }
      await window.CentralWorkspace.switchTo(company);
      return; // o evento de troca chama esta função de novo, já na empresa certa
    }
    requestedChat = null;
    await openDialog({ chatId }).catch(showError);
  }

  async function openFromOtherWorkspace(slug, chatId) {
    if (!slug) return;
    requestedChat = { chatId, company: slug };
    if (slug === activeCompany()?.slug) await openRequestedChat();
    else await window.CentralWorkspace?.switchTo?.(slug);
  }

  $("#internal-chat-other")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-open-workspace]");
    if (button?.dataset.openWorkspace === activeCompany()?.slug) return;
    if (button) openFromOtherWorkspace(button.dataset.openWorkspace, button.dataset.openChat).catch(showError);
  });

  $("#internal-chat-button")?.addEventListener(
    "click",
    () => openDialog().catch(showError)
  );

  $("#close-internal-chat")?.addEventListener(
    "click",
    () => { saveDraft(); $("#internal-chat-dialog")?.close(); }
  );

  $("#internal-chat-dialog")?.addEventListener(
    "click",
    (event) => {
      if (event.target === $("#internal-chat-dialog")) {
        saveDraft();
        $("#internal-chat-dialog").close();
      }
    }
  );

  $("#internal-chat-input")?.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing
    ) {
      event.preventDefault();

      $("#internal-chat-form")?.requestSubmit();
    }
  });
  $("#internal-chat-input")?.addEventListener("input", () => {
    clearTimeout(state.draftTimer);
    state.draftTimer = setTimeout(saveDraft, 400);
  });

  // ---------------------------------------------------------------- busca
  function hideSearchResults() {
    const results = $("#internal-chat-search-results");
    if (results) { results.hidden = true; results.innerHTML = ""; }
  }

  let searchTimer;
  $("#internal-chat-search")?.addEventListener("input", () => {
    renderChatList();
    clearTimeout(searchTimer);
    const term = String($("#internal-chat-search").value || "").trim();
    if (term.length < 2) { hideSearchResults(); return; }
    searchTimer = setTimeout(() => searchMessages(term), 300);
  });

  async function searchMessages(term) {
    const sequence = ++state.searchSequence;
    const epoch = state.epoch;
    const results = $("#internal-chat-search-results");
    try {
      const found = await api(`/api/internal-chats/search?q=${encodeURIComponent(term)}`);
      if (sequence !== state.searchSequence || epoch !== state.epoch) return;
      results.hidden = false;
      results.innerHTML = `<div class="internal-chat-section-title">Mensagens</div>` + (found.length ? found.map((message) => `
        <button type="button" class="internal-chat-search-item" data-search-chat="${escapeHtml(message.chatId)}" data-search-message="${escapeHtml(message.id)}">
          <strong>${escapeHtml(message.chat?.name || "Conversa")}</strong>
          <small>${escapeHtml(message.senderUser?.name || "Sistema")} · ${escapeHtml(formatTime(message.createdAt))}</small>
          <span>${escapeHtml(String(message.text || "").slice(0, 140))}</span>
        </button>`).join("") : `<div class="internal-group-empty">Nenhuma mensagem encontrada nesta empresa.</div>`);
    } catch (error) {
      if (sequence === state.searchSequence) { results.hidden = false; results.innerHTML = `<div class="internal-group-empty">${escapeHtml(error.message)}</div>`; }
    }
  }

  $("#internal-chat-search-results")?.addEventListener("click", (event) => {
    const item = event.target.closest("[data-search-chat]");
    if (item) openChat(item.dataset.searchChat, { highlightId: item.dataset.searchMessage }).catch(showError);
  });

  function clearInternalFile() {
    state.selectedFile = null;

    if (state.selectedFileUrl) {
      URL.revokeObjectURL(state.selectedFileUrl);
      state.selectedFileUrl = null;
    }

    const preview = $("#internal-chat-image-preview");
    const thumb = $("#internal-chat-image-thumb");

    if (preview) preview.hidden = true;

    if (thumb) {
      thumb.removeAttribute("src");
    }
  }

  async function selectInternalFile(file) {
    if (!file) return;
    if (!file.size) { alert("O arquivo está vazio."); return; }
    if (file.size > 100 * 1024 * 1024) { alert("O arquivo deve ter no máximo 100 MB."); return; }
    clearInternalFile();
    state.selectedFile = file;
    const image = await isSafeImageFile(file);
    const thumb = $("#internal-chat-image-thumb");
    thumb.hidden = !image;
    if (image) { state.selectedFileUrl = URL.createObjectURL(file); thumb.src = state.selectedFileUrl; }
    $("#internal-chat-file-name").textContent = file.name || "Arquivo";
    $("#internal-chat-file-size").textContent = formatFileSize(file.size);
    $("#internal-chat-image-preview").hidden = false;
  }

  $("#internal-chat-input")?.addEventListener(
    "paste",
    (event) => {
      const items = Array.from(
        event.clipboardData?.items || []
      );

      const imageItem = items.find(
        (item) =>
          item.kind === "file" &&
          ["image/png", "image/jpeg"].includes(
            item.type
          )
      );

      if (!imageItem) return;

      const file = imageItem.getAsFile();
      if (!file) return;

      event.preventDefault();

      const extension =
        file.type === "image/jpeg"
          ? "jpg"
          : "png";

      selectInternalFile(
        new File(
          [file],
          `imagem-colada-${Date.now()}.${extension}`,
          {
            type: file.type,
          }
        )
      ).catch((error) => alert(error.message));
    }
  );
  $("#internal-chat-file-input")?.addEventListener("change", (event) => {
    selectInternalFile(event.target.files?.[0]).catch((error) => alert(error.message));
    event.target.value = "";
  });
  $("#internal-chat-remove-image")?.addEventListener(
    "click",
    clearInternalFile
  );
  $("#internal-chat-form")?.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();
      if (!state.currentChatId) return;
      const chat = state.chats.find((item) => item.id === state.currentChatId);
      // A conversa precisa ser da empresa ativa (o servidor confere de novo).
      if (!chat || chat.legacy || (chat.companyId && chat.companyId !== activeCompany()?.id)) return;

      const input = $("#internal-chat-input");
      const fileInput = $("#internal-chat-file-input");
      const sendButton = $("#internal-chat-send");
      const text = input.value.trim();
      if (!text && !state.selectedFile) return;
      const sendingChatId=state.currentChatId,sendingSequence=state.openSequence,sendingEpoch=state.epoch;

      sendButton.disabled = true;
      fileInput.disabled = true;

      try {
        if (state.selectedFile) {
          const form = new FormData();
          form.append("file", state.selectedFile);
          if (text) form.append("caption", text);

          await api(
            `/api/internal-chats/${encodeURIComponent(sendingChatId)}/files`,
            { method: "POST", body: form }
          );
          if(sendingSequence===state.openSequence&&sendingEpoch===state.epoch)clearInternalFile();
        } else {
          await api(
            `/api/internal-chats/${encodeURIComponent(sendingChatId)}/messages`,
            {
              method: "POST",
              body: JSON.stringify({ text }),
            }
          );
        }

        if(sendingSequence===state.openSequence&&sendingEpoch===state.epoch){input.value="";clearDraft();if(state.hasNewer)await openChat(sendingChatId);else await refreshMessageTail({forceScroll:true});}
      } catch (error) {
        showError(error);
      } finally {
        const current = state.chats.find((item) => item.id === state.currentChatId);
        setComposerState(current);
        if (!input.disabled) input.focus();
      }
    }
  );

  $("#open-direct-chat")?.addEventListener(
    "click",
    async () => {
      const userId = $("#internal-chat-user-select")?.value;
      if (!userId) return;

      try {
        const chat = await api(
          `/api/internal-chats/direct/${encodeURIComponent(userId)}`,
          {
            method: "POST",
          }
        );

        await loadChats();
        await openChat(chat.id);
      } catch (error) {
        showError(error);
      }
    }
  );

  // ---------------------------------------------------------------- grupos
  function leaveCurrentChatView(message) {
    state.currentChatId = null;
    state.openSequence++;state.messages=[];state.hasOlder=false;state.hasNewer=false;state.historyLoading=false;
    state.group = null;
    $("#internal-members-dialog")?.open && $("#internal-members-dialog").close();
    $("#internal-chat-title").textContent = "Selecione uma conversa";
    $("#internal-chat-type").textContent = "CHAT INTERNO";
    $("#internal-chat-subtitle").hidden = true;
    $("#internal-chat-participants").hidden = true;
    $("#internal-chat-messages").innerHTML = `<div class="internal-chat-empty">${escapeHtml(message)}</div>`;
    $("#internal-chat-input").value = "";
    setComposerState(null);
    clearInternalFile();
  }

  // Pessoas agrupadas por empresa (só identificação): uma seção por empresa
  // para quem está em uma só e "Mibro e Sincrofit" para quem está nas duas —
  // ninguém aparece repetido.
  function userGroups(users) {
    const companies = window.CentralWorkspace?.companies?.() || [];
    if (companies.length < 2) return [{ label: null, users }];
    const ids = companies.map((company) => company.id);
    const inCompanies = (user) => ids.filter((id) => (user.companyIds || []).includes(id));
    const groups = companies.map((company) => ({
      label: company.displayName || company.name,
      users: users.filter((user) => { const list = inCompanies(user); return list.length === 1 && list[0] === company.id; }),
    }));
    groups.push({ label: companies.map((company) => company.displayName || company.name).join(" e "), users: users.filter((user) => inCompanies(user).length > 1) });
    groups.push({ label: "Sem empresa", users: users.filter((user) => !inCompanies(user).length) });
    return groups.filter((group) => group.users.length);
  }

  // Seleção dos seletores de participantes guardada à parte: filtrar por
  // empresa ou buscar nunca desmarca quem já foi escolhido.
  const picked = { member: new Set(), add: new Set() };
  const pickerCompany = { member: "ALL", add: "ALL" };

  function userPickerMarkup(users, { name, emptyText }) {
    if (!users.length) return `<div class="internal-group-empty">${escapeHtml(emptyText)}</div>`;
    return users.map((user) => `
      <label class="internal-group-user">
        <input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(user.id)}"${picked[name].has(user.id) ? " checked" : ""}>
        <span><b>${escapeHtml(user.name)}</b>${companyTags(user.companyIds)}</span>
      </label>`).join("");
  }

  function filterUsers(users, term, companyId = "ALL") {
    const query = String(term || "").trim().toLocaleLowerCase("pt-BR");
    return users.filter((user) => (companyId === "ALL" || (user.companyIds || []).includes(companyId))
      && (!query || user.name.toLocaleLowerCase("pt-BR").includes(query)));
  }

  function checkedValues(name) {
    return [...picked[name]];
  }

  // Filtro de empresa do seletor (Todas | MIBRO | SINCROFIT).
  function renderCompanyFilter(container, name, onChange) {
    const companies = window.CentralWorkspace?.companies?.() || [];
    if (!container) return;
    container.hidden = companies.length < 2;
    if (companies.length < 2) return;
    const count = picked[name].size;
    container.innerHTML = [{ id: "ALL", label: "Todas" }, ...companies.map((company) => ({ id: company.id, label: company.displayName || company.name, color: companyColor(company) }))]
      .map((item) => `<button type="button" data-picker-company="${escapeHtml(item.id)}" class="${pickerCompany[name] === item.id ? "active" : ""}" aria-pressed="${pickerCompany[name] === item.id}"${item.color ? ` style="--company-color:${escapeHtml(item.color)}"` : ""}>${item.id === "ALL" ? "" : `<i class="company-dot" aria-hidden="true"></i>`}${escapeHtml(item.label)}</button>`).join("")
      + `<small>${count} selecionado${count === 1 ? "" : "s"}</small>`;
    container.onclick = (event) => {
      const button = event.target.closest("[data-picker-company]");
      if (!button) return;
      pickerCompany[name] = button.dataset.pickerCompany;
      onChange();
    };
  }

  function renderPicker(container, users, term, options) {
    container.innerHTML = userPickerMarkup(filterUsers(users, term, pickerCompany[options.name]), options);
    container.onchange = (event) => {
      const input = event.target.closest("input[type=checkbox]");
      if (!input) return;
      if (input.checked) picked[options.name].add(input.value); else picked[options.name].delete(input.value);
      const filter = options.name === "member" ? $("#internal-group-company-filter") : $("#internal-add-company-filter");
      const counter = filter?.querySelector("small");
      if (counter) counter.textContent = `${picked[options.name].size} selecionado${picked[options.name].size === 1 ? "" : "s"}`;
    };
  }

  function renderNewGroupPicker() {
    const list = $("#internal-group-user-list");
    renderCompanyFilter($("#internal-group-company-filter"), "member", renderNewGroupPicker);
    renderPicker(list, state.users, $("#internal-group-user-search").value, { name: "member", emptyText: "Nenhuma pessoa encontrada." });
  }

  async function openNewGroupDialog() {
    if (!state.users.length) await loadUsers();
    picked.member.clear();
    pickerCompany.member = "ALL";
    $("#internal-group-company").textContent = "Grupos podem reunir pessoas das duas empresas. Use o filtro para escolher por empresa; as seleções são mantidas.";
    $("#internal-group-name").value = "";
    $("#internal-group-description").value = "";
    $("#internal-group-user-search").value = "";
    renderNewGroupPicker();
    $("#internal-group-dialog").showModal();
    $("#internal-group-name").focus();
  }

  async function loadGroupDetails() {
    if (!state.currentChatId) return;
    const epoch = state.epoch;
    const group = await api(`/api/internal-chats/${encodeURIComponent(state.currentChatId)}/group`);
    if (epoch !== state.epoch) return;
    state.group = group;
    renderGroupDetails();
  }

  function renderGroupDetails() {
    const group = state.group;
    if (!group) return;
    const isAdmin = group.viewerRole === "ADMIN";
    const active = !group.archivedAt && Boolean(group.companyId);
    const adminCount = group.members.filter((member) => member.chatRole === "ADMIN").length;
    $("#internal-members-title").textContent = group.name;
    $("#internal-members-count").textContent = `${group.memberCount} ${group.memberCount === 1 ? "membro" : "membros"}${group.archivedAt ? " • encerrado" : ""}${group.companyId ? "" : " • histórico anterior"}`;
    const description = $("#internal-members-description");
    description.hidden = !group.description;
    description.textContent = group.description || "";
    $("#internal-rename-form").hidden = !(isAdmin && active);
    $("#internal-rename-input").value = group.name;
    $("#internal-description-input").value = group.description || "";
    $("#internal-members-list").innerHTML = group.members.map((member) => {
      const self = member.id === state.currentUser?.id;
      const controls = isAdmin && active && !self ? `
        <button type="button" data-role-user="${escapeHtml(member.id)}" data-role="${member.chatRole === "ADMIN" ? "MEMBER" : "ADMIN"}" ${member.chatRole === "ADMIN" && adminCount <= 1 ? "disabled" : ""}>${member.chatRole === "ADMIN" ? "Tirar admin" : "Tornar admin"}</button>
        <button type="button" class="danger" data-remove-user="${escapeHtml(member.id)}">Remover</button>` : "";
      return `
        <div class="internal-group-user">
          <span><b>${escapeHtml(member.name)}${self ? " (você)" : ""}</b><small>${member.chatRole === "ADMIN" ? "Administrador" : "Membro"}</small></span>
          ${controls}
        </div>`;
    }).join("");
    const memberIds = new Set(group.members.map((member) => member.id));
    const candidates = state.users.filter((user) => !memberIds.has(user.id));
    $("#internal-add-members").hidden = !(isAdmin && active);
    renderCompanyFilter($("#internal-add-company-filter"), "add", renderGroupDetails);
    renderPicker($("#internal-add-list"), candidates, $("#internal-add-search").value, { name: "add", emptyText: "Ninguém mais para adicionar neste filtro." });
    $("#internal-archive-group").hidden = !(isAdmin && active);
  }

  async function runGroupAction(action) {
    try {
      await action();
      await loadChats();
      const chat = state.chats.find((item) => item.id === state.currentChatId);
      if (chat) {
        $("#internal-chat-title").textContent = chatDisplayName(chat);
        await openChat(chat.id);
      }
      if (state.currentChatId && $("#internal-members-dialog").open) await loadGroupDetails();
    } catch (error) {
      showError(error);
    }
  }

  $("#internal-chat-new-group")?.addEventListener("click", () => openNewGroupDialog().catch(showError));
  $("#close-internal-group")?.addEventListener("click", () => $("#internal-group-dialog").close());
  $("#cancel-internal-group")?.addEventListener("click", () => $("#internal-group-dialog").close());
  $("#internal-group-user-search")?.addEventListener("input", (event) => {
    renderNewGroupPicker();
  });
  $("#internal-group-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const memberIds = checkedValues("member");
    if (!memberIds.length) { alert("Selecione pelo menos um participante."); return; }
    try {
      const chat = await api("/api/internal-chats/groups", {
        method: "POST",
        body: JSON.stringify({ name: $("#internal-group-name").value, description: $("#internal-group-description").value, memberIds }),
      });
      $("#internal-group-dialog").close();
      await loadChats();
      await openChat(chat.id);
    } catch (error) {
      showError(error);
    }
  });

  $("#internal-chat-participants")?.addEventListener("click", async () => {
    try {
      if (!state.users.length) await loadUsers();
      $("#internal-add-search").value = "";
      $("#internal-add-list").innerHTML = "";
      picked.add.clear();
      pickerCompany.add = "ALL";
      await loadGroupDetails();
      $("#internal-members-dialog").showModal();
    } catch (error) {
      showError(error);
    }
  });
  $("#close-internal-members")?.addEventListener("click", () => $("#internal-members-dialog").close());
  $("#internal-add-search")?.addEventListener("input", renderGroupDetails);
  $("#internal-rename-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    runGroupAction(() => api(`/api/internal-chats/${encodeURIComponent(state.currentChatId)}/group`, {
      method: "PATCH", body: JSON.stringify({ name: $("#internal-rename-input").value, description: $("#internal-description-input").value }),
    }));
  });
  $("#internal-add-submit")?.addEventListener("click", () => {
    const userIds = checkedValues("add");
    if (!userIds.length) { alert("Selecione quem deseja adicionar."); return; }
    runGroupAction(() => api(`/api/internal-chats/${encodeURIComponent(state.currentChatId)}/members`, {
      method: "POST", body: JSON.stringify({ userIds }),
    }));
  });
  $("#internal-members-list")?.addEventListener("click", (event) => {
    const removeButton = event.target.closest("[data-remove-user]");
    const roleButton = event.target.closest("[data-role-user]");
    if (removeButton) {
      if (!confirm("Remover este participante do grupo?")) return;
      runGroupAction(() => api(`/api/internal-chats/${encodeURIComponent(state.currentChatId)}/members/${encodeURIComponent(removeButton.dataset.removeUser)}`, { method: "DELETE" }));
    } else if (roleButton) {
      runGroupAction(() => api(`/api/internal-chats/${encodeURIComponent(state.currentChatId)}/members/${encodeURIComponent(roleButton.dataset.roleUser)}`, {
        method: "PATCH", body: JSON.stringify({ role: roleButton.dataset.role }),
      }));
    }
  });
  $("#internal-leave-group")?.addEventListener("click", async () => {
    if (!state.currentChatId || !confirm("Sair deste grupo? Você deixará de ver as mensagens dele.")) return;
    try {
      await api(`/api/internal-chats/${encodeURIComponent(state.currentChatId)}/leave`, { method: "POST" });
      leaveCurrentChatView("Você saiu do grupo.");
      await loadChats();
    } catch (error) {
      showError(error);
    }
  });
  $("#internal-archive-group")?.addEventListener("click", () => {
    if (!confirm("Encerrar o grupo? Ninguém poderá enviar novas mensagens; o histórico continua disponível para leitura.")) return;
    runGroupAction(() => api(`/api/internal-chats/${encodeURIComponent(state.currentChatId)}/archive`, { method: "POST" }));
  });

  let internalNotificationReady = false;

  const userReady = detectCurrentUser();
  document.addEventListener("DOMContentLoaded", async () => {
    await userReady;
    // A lista espera o workspace da Central (evento central:workspace-changed);
    // sem a Central (tela sem abas), usa o workspace salvo no servidor.
    if (!window.CentralWorkspace) {
      try {
        await loadChats();
        await loadUsers();
      } catch {}
    }
    internalNotificationReady = true;
  });

  const events = new EventSource("/api/events");
  const notifiedInternalMessages = new Set();
  let realtimeRefreshTimer;
  let realtimeRefreshRunning = false;
  let realtimeRefreshPending = false;

  function rememberNotification(messageId) {
    notifiedInternalMessages.add(messageId);

    if (notifiedInternalMessages.size > 200) {
      const oldest = notifiedInternalMessages.values().next().value;
      notifiedInternalMessages.delete(oldest);
    }
  }

  async function refreshInternalChat() {
    if (realtimeRefreshRunning) {
      realtimeRefreshPending = true;
      return;
    }

    realtimeRefreshRunning = true;
    const epoch = state.epoch;

    try {
      const previousLastMessages = new Map(
        state.chats.map((chat) => [chat.id, chat.lastMessage?.id || null])
      );

      if (!(await loadChats())) return;

      if (internalNotificationReady) {
        for (const chat of state.chats) {
          const message = chat.lastMessage;

          if (!message?.id) continue;
          if (previousLastMessages.get(chat.id) === message.id) continue;
          if (notifiedInternalMessages.has(message.id)) continue;
          if (message.senderUserId === state.currentUser?.id) continue;
          if (message.type !== "USER") continue;

          rememberNotification(message.id);

          if (document.hidden && typeof window.mibroNotify === "function") {
            const company = activeCompany();
            await window.mibroNotify(
              `${message.senderUser?.name || "Alguém da equipe"} mandou uma mensagem${company ? ` (${company.displayName || company.name})` : ""}`,
              {
                tag: `internal:${message.id}`,
                data: { url: `/?internalChat=${encodeURIComponent(chat.id)}&company=${encodeURIComponent(company?.slug || "")}` },
              }
            );
          }
        }
      }

      const chatId = state.currentChatId;
      if (chatId && !state.chats.some((chat) => chat.id === chatId)) {
        leaveCurrentChatView("Você não participa mais deste chat.");
      } else if (chatId && $("#internal-chat-dialog")?.open) {
        const sequence = state.openSequence;
        await refreshMessageTail();

        if (sequence === state.openSequence && state.currentChatId === chatId && epoch === state.epoch) {
          clearChatUnread(chatId);
          await api(
            `/api/internal-chats/${encodeURIComponent(chatId)}/read`,
            { method: "POST" }
          );
        }
      }
    } catch (error) {
      console.warn(
        "Não foi possível atualizar o chat interno em tempo real.",
        error
      );
    } finally {
      realtimeRefreshRunning = false;
      refreshUnread();

      if (realtimeRefreshPending) {
        realtimeRefreshPending = false;
        scheduleRealtimeRefresh();
      }
    }
  }

  function scheduleRealtimeRefresh() {
    clearTimeout(realtimeRefreshTimer);
    realtimeRefreshTimer = setTimeout(refreshInternalChat, 120);
  }

  let unreadTimer;
  function clearChatUnread(chatId) {
    const chat = state.chats.find((item) => item.id === chatId);
    if (!chat?.unreadCount) return;
    chat.unreadCount = 0;
    renderChatList();
  }

  function scheduleUnread(delay = 200) {
    clearTimeout(unreadTimer);
    unreadTimer = setTimeout(() => refreshUnread(), delay);
  }

  // Atendimento (WhatsApp) mudou: só os contadores internos são conferidos
  // — a lista do chat não é recarregada por evento externo.
  events.addEventListener("inbox.updated", () => scheduleUnread(400));
  events.addEventListener("open", () => scheduleUnread(0));
  // Evento direcionado do chat interno (só membros com acesso à empresa).
  // Outra empresa: só contador/aba; a lista e a conversa abertas não mudam.
  events.addEventListener("internal-chat.updated", (event) => {
    let data = {};
    try { data = JSON.parse(event.data || "{}"); } catch {}
    // A read acknowledgement is not a new message. Fetching/reading the
    // conversation again here would publish another read event indefinitely.
    if (data.kind === "read") {
      clearChatUnread(data.chatId);
      scheduleUnread(0);
      return;
    }
    const active = activeCompany()?.id;
    if (data.companyId && active && data.companyId !== active) {
      scheduleUnread(0);
      return;
    }
    if (data.kind === "reaction") {
      if (data.chatId === state.currentChatId) refreshReactions().catch(() => {});
      return;
    }
    if (data.kind === "removed" && data.chatId === state.currentChatId) {
      leaveCurrentChatView("Você não participa mais deste grupo.");
    }
    if (data.chatId === state.currentChatId && $("#internal-members-dialog")?.open) {
      loadGroupDetails().catch(() => {});
    }
    scheduleRealtimeRefresh();
  });
  // Contadores sincronizados entre abas/sessões mesmo sem eventos.
  setInterval(() => { if (!document.hidden) scheduleUnread(0); }, 60000);
  window.addEventListener("beforeunload", () => { saveDraft(); events.close(); }, { once: true });
})();
