// Command palette (Ctrl+K): script isolado, carregado depois de app.js.
// Não define seu próprio "state" — lê os dados já carregados pelo app.js
// (state.conversations, state.currentUser) e chama funções globais dele
// (openConversation, toast, openOutboundConversation, escapeHtml, initials,
// messagePreview, categoryLabel) que, por não estarem dentro de uma IIFE em
// app.js, ficam disponíveis no escopo global do documento. Nenhum novo
// endpoint é chamado por este arquivo.
(() => {
  const dialogMarkup = `
    <dialog id="command-palette-dialog" class="command-palette-dialog" aria-label="Busca e ações rápidas">
      <div class="cmdk-search">
        <span aria-hidden="true">⌕</span>
        <input id="cmdk-input" type="text" placeholder="Buscar conversas ou executar uma ação..." autocomplete="off" spellcheck="false">
        <kbd>Esc</kbd>
      </div>
      <div id="cmdk-results" class="cmdk-results" role="listbox"></div>
    </dialog>`;
  document.body.insertAdjacentHTML("beforeend", dialogMarkup);

  const dialog = document.getElementById("command-palette-dialog");
  const input = document.getElementById("cmdk-input");
  const results = document.getElementById("cmdk-results");
  let activeIndex = 0;
  let currentItems = [];

  const safeText = (value) => (typeof escapeHtml === "function" ? escapeHtml(value) : String(value ?? ""));

  function navigationCommands() {
    const user = typeof state !== "undefined" ? state.currentUser : null;
    if (!user) return [];
    const all = [
      { id: "nav-bots", label: "Abrir Bots", icon: "🤖", enabled: user.isMaster, run: () => { location.href = "/bots"; } },
      { id: "nav-quick-replies", label: "Abrir Respostas rápidas", icon: "⚡", enabled: user.isMaster, run: () => { location.href = "/quick-replies"; } },
      { id: "nav-knowledge", label: "Abrir Base de conhecimento", icon: "📚", enabled: user.isMaster, run: () => { location.href = "/knowledge-base"; } },
      { id: "nav-integrations", label: "Abrir Integrações", icon: "🔌", enabled: user.isMaster, run: () => { location.href = "/integrations"; } },
      { id: "nav-campaigns", label: "Abrir Campanhas", icon: "📣", enabled: user.canManageCampaigns, run: () => { location.href = "/campaigns"; } },
      { id: "nav-settings", label: "Abrir Configurações", icon: "⚙", enabled: user.isMaster || user.role === "SUPERVISOR", run: () => { location.href = "/configuracoes"; } },
      { id: "nav-team", label: "Abrir Equipe", icon: "👥", enabled: user.isMaster, run: () => document.getElementById("team-button")?.click() },
    ];
    return all.filter((item) => item.enabled);
  }

  function actionCommands() {
    const actions = [
      { id: "action-new-conversation", label: "Nova conversa", icon: "＋", run: () => document.getElementById("new-conversation")?.click() },
      { id: "action-theme", label: "Alternar tema claro/escuro", icon: "☾", run: () => document.getElementById("theme-toggle")?.click() },
      { id: "action-search", label: "Focar busca de conversas", icon: "⌕", run: () => document.getElementById("search")?.focus() },
      { id: "action-refresh", label: "Atualizar lista de conversas", icon: "↻", run: () => document.getElementById("refresh")?.click() },
    ];
    if (typeof state !== "undefined" && state.selectedId) {
      actions.push({ id: "action-quick-replies", label: "Abrir respostas rápidas desta conversa", icon: "⚡", run: () => document.getElementById("open-quick-replies")?.click() });
      actions.push({ id: "action-details", label: "Abrir aba Detalhes", icon: "ℹ", run: () => document.querySelector("[data-context-tab='details']")?.click() });
      actions.push({ id: "action-notes", label: "Abrir aba Notas", icon: "🗒", run: () => document.querySelector("[data-context-tab='notes']")?.click() });
    }
    return actions;
  }

  function conversationCommands(term) {
    if (!term || typeof state === "undefined" || !Array.isArray(state.conversations)) return [];
    const query = term.toLocaleLowerCase("pt-BR");
    return state.conversations
      .filter((conversation) => {
        const name = conversation.contact.customName || conversation.contact.name || "";
        const haystack = `${name} ${conversation.contact.phone || ""}`.toLocaleLowerCase("pt-BR");
        return haystack.includes(query);
      })
      .slice(0, 8)
      .map((conversation) => {
        const name = conversation.contact.customName || conversation.contact.name || conversation.contact.phone;
        return {
          id: `conversation-${conversation.id}`,
          label: name,
          meta: conversation.contact.phone,
          icon: "💬",
          run: () => { if (typeof openConversation === "function") openConversation(conversation.id).catch(() => {}); },
        };
      });
  }

  function buildItems(term) {
    const trimmed = term.trim();
    const convos = conversationCommands(trimmed);
    if (!trimmed) return [...actionCommands(), ...navigationCommands()];
    const query = trimmed.toLocaleLowerCase("pt-BR");
    const matches = (label) => label.toLocaleLowerCase("pt-BR").includes(query);
    return [
      ...convos,
      ...actionCommands().filter((item) => matches(item.label)),
      ...navigationCommands().filter((item) => matches(item.label)),
    ];
  }

  function render(term) {
    currentItems = buildItems(term);
    activeIndex = 0;
    if (!currentItems.length) {
      results.innerHTML = `<div class="cmdk-empty">Nenhum resultado para "${safeText(term)}".</div>`;
      return;
    }
    results.innerHTML = currentItems.map((item, index) => `
      <button type="button" class="cmdk-item ${index === activeIndex ? "active" : ""}" data-cmdk-index="${index}" role="option">
        <span aria-hidden="true">${item.icon || "›"}</span>
        <span>${safeText(item.label)}</span>
        ${item.meta ? `<small>${safeText(item.meta)}</small>` : ""}
      </button>`).join("");
  }

  function highlight(delta) {
    if (!currentItems.length) return;
    activeIndex = (activeIndex + delta + currentItems.length) % currentItems.length;
    [...results.querySelectorAll(".cmdk-item")].forEach((el, index) => el.classList.toggle("active", index === activeIndex));
    results.querySelector(".cmdk-item.active")?.scrollIntoView({ block: "nearest" });
  }

  function runActive() {
    const item = currentItems[activeIndex];
    if (!item) return;
    close();
    item.run();
  }

  function open() {
    if (typeof dialog.showModal === "function") dialog.showModal();
    input.value = "";
    render("");
    setTimeout(() => input.focus(), 0);
  }
  function close() { if (dialog.open) dialog.close(); }

  document.getElementById("command-palette-trigger")?.addEventListener("click", open);
  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "k") { event.preventDefault(); open(); }
  });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
  input.addEventListener("input", () => render(input.value));
  results.addEventListener("click", (event) => {
    const button = event.target.closest("[data-cmdk-index]");
    if (!button) return;
    activeIndex = Number(button.dataset.cmdkIndex);
    runActive();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); highlight(1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); highlight(-1); }
    else if (event.key === "Enter") { event.preventDefault(); runActive(); }
    else if (event.key === "Escape") { event.preventDefault(); close(); }
  });
})();
