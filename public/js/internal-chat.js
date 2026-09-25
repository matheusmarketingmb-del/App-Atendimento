(() => {
  const state = {
    chats: [],
    currentChatId: null,
    currentUser: null,
    selectedFile: null,
    selectedFileUrl: null,
    openSequence: 0,
    users: [],
    group: null,
  };

  const $ = (selector) => document.querySelector(selector);

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


  async function api(url, options = {}) {
  const isFormData = options.body instanceof FormData;

  const headers = {
    ...(options.headers || {}),
  };

  if (!isFormData) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      body.error || "Erro no chat interno."
    );
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

  function renderChatList() {
    const container = $("#internal-chat-list");
    if (!container) return;

    if (!state.chats.length) {
      container.innerHTML =
        '<div class="internal-chat-empty-list">Nenhum chat disponível.</div>';
      return;
    }

    // Lateral separada em seções: canais da empresa (Geral/setores),
    // conversas diretas e grupos criados por usuários.
    const sections = [
      ["Canais", state.chats.filter((chat) => ["GENERAL", "SECTOR"].includes(chat.type))],
      ["Diretas", state.chats.filter((chat) => chat.type === "DIRECT")],
      ["Grupos", state.chats.filter((chat) => chat.type === "GROUP")],
    ];
    container.innerHTML = sections.map(([title, chats]) => `
      <div class="internal-chat-section-title">${escapeHtml(title)}</div>
      ${chats.length ? chats.map(chatItemMarkup).join("") : `<div class="internal-group-empty">${title === "Grupos" ? "Nenhum grupo ainda." : "Nenhuma conversa."}</div>`}
    `).join("");

    container.querySelectorAll("[data-chat-id]").forEach((button) => {
      button.addEventListener("click", () => {
        openChat(button.dataset.chatId);
      });
    });
  }

  function chatItemMarkup(chat) {
    const active = chat.id === state.currentChatId;
    const preview = chat.lastMessage?.text
      || (chat.lastMessage?.metadata?.media?.fileName
        ? `📎 ${chat.lastMessage.metadata.media.fileName}`
        : (chat.lastMessage?.type === "TRANSFER"
          ? "Nova transferência"
          : "Sem mensagens"));

    return `
      <button
        type="button"
        class="internal-chat-item ${active ? "active" : ""}"
        data-chat-id="${escapeHtml(chat.id)}"
      >
        <span class="internal-chat-item-icon">
          ${escapeHtml(chatIcon(chat))}
        </span>

        <span class="internal-chat-item-content">
          <strong>${escapeHtml(chatDisplayName(chat))}</strong>
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

  function syncGlobalUnread() {
    const count = state.chats.reduce(
      (total, chat) => total + Number(chat.unreadCount || 0),
      0
    );

    const badge = $("#internal-chat-unread");

    if (!badge) return;

    badge.textContent = count > 99 ? "99+" : String(count);
    badge.hidden = count === 0;
  }

  async function loadChats() {
    state.chats = await api("/api/internal-chats");

    renderChatList();
    syncGlobalUnread();
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

  function renderMessages(messages, { forceScroll = false } = {}) {
    const container = $("#internal-chat-messages");
    if (!container) return;

    const wasNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 80;

    if (!messages.length) {
      container.innerHTML =
        '<div class="internal-chat-empty">Nenhuma mensagem neste chat.</div>';
      return;
    }

    container.innerHTML = messages.map((message) => {
      if (message.type === "TRANSFER") {
        return renderTransferMessage(message);
      }

      if (message.type === "SYSTEM") {
        return `<div class="internal-system-line">${escapeHtml(message.text || "")} <small>${escapeHtml(formatTime(message.createdAt))}</small></div>`;
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
        <div class="internal-message-row ${own ? "own" : ""}">
          <div class="internal-message-bubble">
  <strong>${escapeHtml(message.senderUser?.name || "Sistema")}</strong>
  ${attachment}
  ${
    message.text
      ? `<p>${escapeHtml(message.text)}</p>`
      : ""
  }
  <small>${formatTime(message.createdAt)}</small>
</div>
        </div>
      `;
    }).join("");

    if (forceScroll || wasNearBottom) {
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    }
  }

  async function openChat(chatId) {
    const chat = state.chats.find((item) => item.id === chatId);
    if (!chat) return;

    state.currentChatId = chatId;
    const sequence = ++state.openSequence;

    $("#internal-chat-title").textContent = chatDisplayName(chat);

    $("#internal-chat-type").textContent = {
      GENERAL: "CHAT GERAL",
      SECTOR: "CHAT DO SETOR",
      DIRECT: "MENSAGEM DIRETA",
      GROUP: chat.archivedAt ? "GRUPO ENCERRADO" : "GRUPO",
    }[chat.type] || "CHAT INTERNO";

    const isGroup = chat.type === "GROUP";
    const subtitle = $("#internal-chat-subtitle");
    subtitle.hidden = !isGroup;
    subtitle.textContent = isGroup ? `${chat.memberCount} ${chat.memberCount === 1 ? "membro" : "membros"}` : "";
    $("#internal-chat-participants").hidden = !isGroup;

    const readOnly = Boolean(chat.archivedAt);
    $("#internal-chat-input").disabled = readOnly;
    $("#internal-chat-input").placeholder = readOnly ? "Grupo encerrado — somente leitura." : "Digite uma mensagem interna...";
    $("#internal-chat-file-input").disabled = readOnly;
    $("#internal-chat-send").disabled = readOnly;

    renderChatList();

    const messages = await api(
      `/api/internal-chats/${encodeURIComponent(chatId)}/messages`
    );

    if (sequence !== state.openSequence || state.currentChatId !== chatId) return;

    renderMessages(messages, { forceScroll: true });

    await api(
      `/api/internal-chats/${encodeURIComponent(chatId)}/read`,
      { method: "POST" }
    );

    if (sequence === state.openSequence) await loadChats();
  }

  async function loadUsers() {
    if (!state.currentUser) return;

    const select = $("#internal-chat-user-select");
    if (!select) return;

    let users = [];

    try {
      const response = await fetch("/api/internal-chat-users");
      if (response.ok) users = await response.json();
    } catch {}

    if (!Array.isArray(users)) return;

    state.users = users.filter((user) => user.active !== false && user.id !== state.currentUser.id);

    select.innerHTML =
      '<option value="">Selecionar usuário</option>' +
      users
        .filter(
          (user) =>
            user.active !== false &&
            user.id !== state.currentUser.id
        )
        .map(
          (user) =>
            `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name)}</option>`
        )
        .join("");
  }

  async function openDialog() {
    const dialog = $("#internal-chat-dialog");

    if (!dialog.open) dialog.showModal();

    await loadChats();

    const selected = state.chats.find(
      (chat) => chat.id === state.currentChatId
    );
    const initial = selected
      || state.chats.find((chat) => chat.type === "GENERAL")
      || state.chats[0];

    if (initial) await openChat(initial.id);
  }

  async function detectCurrentUser() {
    try {
      const response = await fetch("/api/auth/status");
      if (!response.ok) return;

      const data = await response.json();
      state.currentUser = data.user || null;

      await loadUsers();
    } catch {}
  }

  $("#internal-chat-button")?.addEventListener(
    "click",
    () => openDialog().catch(console.error)
  );

  $("#close-internal-chat")?.addEventListener(
    "click",
    () => $("#internal-chat-dialog")?.close()
  );

  $("#internal-chat-dialog")?.addEventListener(
    "click",
    (event) => {
      if (event.target === $("#internal-chat-dialog")) {
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

      const input = $("#internal-chat-input");
      const fileInput = $("#internal-chat-file-input");
      const sendButton = $("#internal-chat-send");
      const text = input.value.trim();
      if (!text && !state.selectedFile) return;

      sendButton.disabled = true;
      fileInput.disabled = true;

      try {
        if (state.selectedFile) {
          const form = new FormData();
          form.append("file", state.selectedFile);
          if (text) form.append("caption", text);

          await api(
            `/api/internal-chats/${encodeURIComponent(state.currentChatId)}/files`,
            { method: "POST", body: form }
          );
          clearInternalFile();
        } else {
          await api(
            `/api/internal-chats/${encodeURIComponent(state.currentChatId)}/messages`,
            {
              method: "POST",
              body: JSON.stringify({ text }),
            }
          );
        }

        input.value = "";
        await openChat(state.currentChatId);
      } catch (error) {
        alert(error.message);
      } finally {
        sendButton.disabled = false;
        fileInput.disabled = false;
        input.focus();
      }
    }
  );

  $("#open-direct-chat")?.addEventListener(
    "click",
    async () => {
      const userId = $("#internal-chat-user-select")?.value;
      if (!userId) return;

      const chat = await api(
        `/api/internal-chats/direct/${encodeURIComponent(userId)}`,
        {
          method: "POST",
        }
      );

      await loadChats();
      await openChat(chat.id);
    }
  );

  // ---------------------------------------------------------------- grupos
  function leaveCurrentChatView(message) {
    state.currentChatId = null;
    state.group = null;
    $("#internal-members-dialog")?.open && $("#internal-members-dialog").close();
    $("#internal-chat-title").textContent = "Selecione uma conversa";
    $("#internal-chat-type").textContent = "CHAT INTERNO";
    $("#internal-chat-subtitle").hidden = true;
    $("#internal-chat-participants").hidden = true;
    $("#internal-chat-messages").innerHTML = `<div class="internal-chat-empty">${escapeHtml(message)}</div>`;
    $("#internal-chat-input").disabled = true;
    $("#internal-chat-file-input").disabled = true;
    $("#internal-chat-send").disabled = true;
  }

  function userPickerMarkup(users, { name, emptyText }) {
    if (!users.length) return `<div class="internal-group-empty">${escapeHtml(emptyText)}</div>`;
    return users.map((user) => `
      <label class="internal-group-user">
        <input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(user.id)}">
        <span><b>${escapeHtml(user.name)}</b></span>
      </label>`).join("");
  }

  function filterUsers(users, term) {
    const query = String(term || "").trim().toLocaleLowerCase("pt-BR");
    return query ? users.filter((user) => user.name.toLocaleLowerCase("pt-BR").includes(query)) : users;
  }

  function checkedValues(container) {
    return [...container.querySelectorAll("input[type=checkbox]:checked")].map((input) => input.value);
  }

  // Busca só filtra a lista visível; seleções já marcadas são preservadas.
  function renderPicker(container, users, term, options) {
    const selected = new Set(checkedValues(container));
    container.innerHTML = userPickerMarkup(filterUsers(users, term), options);
    container.querySelectorAll("input[type=checkbox]").forEach((input) => { input.checked = selected.has(input.value); });
  }

  async function openNewGroupDialog() {
    if (!state.users.length) await loadUsers();
    $("#internal-group-name").value = "";
    $("#internal-group-user-search").value = "";
    $("#internal-group-user-list").innerHTML = "";
    renderPicker($("#internal-group-user-list"), state.users, "", { name: "member", emptyText: "Nenhum usuário disponível." });
    $("#internal-group-dialog").showModal();
    $("#internal-group-name").focus();
  }

  async function loadGroupDetails() {
    if (!state.currentChatId) return;
    const group = await api(`/api/internal-chats/${encodeURIComponent(state.currentChatId)}/group`);
    state.group = group;
    renderGroupDetails();
  }

  function renderGroupDetails() {
    const group = state.group;
    if (!group) return;
    const isAdmin = group.viewerRole === "ADMIN";
    const active = !group.archivedAt;
    const adminCount = group.members.filter((member) => member.chatRole === "ADMIN").length;
    $("#internal-members-title").textContent = group.name;
    $("#internal-members-count").textContent = `${group.memberCount} ${group.memberCount === 1 ? "membro" : "membros"}${group.archivedAt ? " • encerrado" : ""}`;
    $("#internal-rename-form").hidden = !(isAdmin && active);
    $("#internal-rename-input").value = group.name;
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
    renderPicker($("#internal-add-list"), candidates, $("#internal-add-search").value, { name: "add", emptyText: "Todos os usuários já participam." });
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
      alert(error.message);
    }
  }

  $("#internal-chat-new-group")?.addEventListener("click", () => openNewGroupDialog().catch((error) => alert(error.message)));
  $("#close-internal-group")?.addEventListener("click", () => $("#internal-group-dialog").close());
  $("#cancel-internal-group")?.addEventListener("click", () => $("#internal-group-dialog").close());
  $("#internal-group-user-search")?.addEventListener("input", (event) => {
    renderPicker($("#internal-group-user-list"), state.users, event.target.value, { name: "member", emptyText: "Nenhum usuário encontrado." });
  });
  $("#internal-group-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const memberIds = checkedValues($("#internal-group-user-list"));
    if (!memberIds.length) { alert("Selecione pelo menos um participante."); return; }
    try {
      const chat = await api("/api/internal-chats/groups", {
        method: "POST",
        body: JSON.stringify({ name: $("#internal-group-name").value, memberIds }),
      });
      $("#internal-group-dialog").close();
      await loadChats();
      await openChat(chat.id);
    } catch (error) {
      alert(error.message);
    }
  });

  $("#internal-chat-participants")?.addEventListener("click", async () => {
    try {
      if (!state.users.length) await loadUsers();
      $("#internal-add-search").value = "";
      $("#internal-add-list").innerHTML = "";
      await loadGroupDetails();
      $("#internal-members-dialog").showModal();
    } catch (error) {
      alert(error.message);
    }
  });
  $("#close-internal-members")?.addEventListener("click", () => $("#internal-members-dialog").close());
  $("#internal-add-search")?.addEventListener("input", renderGroupDetails);
  $("#internal-rename-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    runGroupAction(() => api(`/api/internal-chats/${encodeURIComponent(state.currentChatId)}/group`, {
      method: "PATCH", body: JSON.stringify({ name: $("#internal-rename-input").value }),
    }));
  });
  $("#internal-add-submit")?.addEventListener("click", () => {
    const userIds = checkedValues($("#internal-add-list"));
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
      alert(error.message);
    }
  });
  $("#internal-archive-group")?.addEventListener("click", () => {
    if (!confirm("Encerrar o grupo? Ninguém poderá enviar novas mensagens; o histórico continua disponível para leitura.")) return;
    runGroupAction(() => api(`/api/internal-chats/${encodeURIComponent(state.currentChatId)}/archive`, { method: "POST" }));
  });

  let internalNotificationReady = false;

  document.addEventListener("DOMContentLoaded", async () => {
    await detectCurrentUser();

    try {
      await loadChats();
      internalNotificationReady = true;
    } catch {}
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

    try {
      const previousLastMessages = new Map(
        state.chats.map((chat) => [chat.id, chat.lastMessage?.id || null])
      );

      await loadChats();

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
            await window.mibroNotify(
              `${message.senderUser?.name || "Alguém da equipe"} mandou uma mensagem`,
              {
                tag: `internal:${message.id}`,
                data: { url: "/" },
              }
            );
          }
        }
      }

      internalNotificationReady = true;

      const chatId = state.currentChatId;
      if (chatId && !state.chats.some((chat) => chat.id === chatId)) {
        leaveCurrentChatView("Você não participa mais deste chat.");
      } else if (chatId && $("#internal-chat-dialog")?.open) {
        const messages = await api(
          `/api/internal-chats/${encodeURIComponent(chatId)}/messages`
        );

        if (state.currentChatId === chatId) {
          renderMessages(messages);
          await api(
            `/api/internal-chats/${encodeURIComponent(chatId)}/read`,
            { method: "POST" }
          );
          await loadChats();
        }
      }
    } catch (error) {
      console.warn(
        "Não foi possível atualizar o chat interno em tempo real.",
        error
      );
    } finally {
      realtimeRefreshRunning = false;

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

  events.addEventListener("inbox.updated", scheduleRealtimeRefresh);
  // Evento direcionado do chat interno (só membros recebem). "removed" =
  // você saiu/foi removido: fecha o grupo aberto e some da lista.
  events.addEventListener("internal-chat.updated", (event) => {
    let data = {};
    try { data = JSON.parse(event.data || "{}"); } catch {}
    if (data.kind === "removed" && data.chatId === state.currentChatId) {
      leaveCurrentChatView("Você não participa mais deste grupo.");
    }
    if (data.chatId === state.currentChatId && $("#internal-members-dialog")?.open) {
      loadGroupDetails().catch(() => {});
    }
    scheduleRealtimeRefresh();
  });
  window.addEventListener("beforeunload", () => events.close(), { once: true });
})();
