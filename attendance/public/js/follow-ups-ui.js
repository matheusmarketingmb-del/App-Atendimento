// Agenda dentro da Central: botão "Agendar retorno" na conversa, aba
// "Agenda" no painel do contato, item de menu com contagem de atrasados e
// avisos em tempo real. Só apresentação — regras no backend
// (follow-up-service). Nunca envia mensagem ao cliente.
(function followUpsUi() {
  const $ = (selector) => document.querySelector(selector);
  const esc = (value = "") => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  const TIME_ZONE = "America/Sao_Paulo";
  const STATE_LABELS = { PENDENTE: "Pendente", ATRASADO: "Atrasado", CONCLUIDO: "Concluído", CANCELADO: "Cancelado" };
  const when = (date) => new Intl.DateTimeFormat("pt-BR", { timeZone: TIME_ZONE, dateStyle: "short", timeStyle: "short" }).format(new Date(date));
  const localKey = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

  const ui = { user: null, conversation: null, contactId: null, loadSeq: 0 };

  async function api(url, options = {}) {
    const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}) };
    const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body?.error || "Não foi possível concluir a operação."), { status: response.status });
    return body;
  }

  function toast(message, error = false) {
    const element = $("#toast");
    if (!element) return;
    element.textContent = message;
    element.className = `toast show${error ? " error" : ""}`;
    setTimeout(() => { element.className = "toast"; }, 3200);
  }

  async function refreshBadge() {
    const badge = $("#agenda-badge");
    const button = $("#agenda-button");
    if (!badge || !button || !ui.user) return;
    try {
      const summary = await api("/api/follow-ups/summary");
      const overdue = summary.mine?.overdue || 0;
      const today = summary.mine?.today || 0;
      badge.hidden = !(overdue || today);
      badge.textContent = overdue ? String(overdue) : String(today);
      badge.classList.toggle("critical", Boolean(overdue));
      badge.classList.toggle("due-today", Boolean(today));
      const details = [today && `${today} retorno(s) para hoje`, overdue && `${overdue} retorno(s) atrasado(s)`].filter(Boolean);
      button.title = details.length ? `Agenda · ${details.join(" · ")}` : "Agenda e follow-ups";
      button.setAttribute("aria-label", button.title);
    } catch {
      badge.hidden = true;
      button.title = "Agenda e follow-ups";
      button.setAttribute("aria-label", button.title);
    }
  }

  function itemMarkup(item) {
    return `
      <article class="fu-item ${esc(item.state)}">
        <div class="fu-item-head"><b>${esc(when(item.dueAt))}</b><span class="fu-state ${esc(item.state)}">${esc(STATE_LABELS[item.state] || item.state)}</span></div>
        <div class="fu-item-body"><strong>${esc(item.reasonLabel)}</strong>${item.assignee ? `<small>Responsável: ${esc(item.assignee.name)}${item.isPreferredAssignee ? " ★" : ""}</small>` : ""}${item.channelAccount ? `<small>${esc(item.channelAccount.name)}</small>` : ""}</div>
        ${item.restricted ? `<p class="fu-note restricted">🔒 Observação de setor protegido.</p>` : item.note ? `<p class="fu-note">${esc(item.note)}</p>` : ""}
        <a class="fu-link" href="/agenda?followUp=${encodeURIComponent(item.id)}">Ver na agenda</a>
      </article>`;
  }

  async function loadContactFollowUps() {
    const target = $("#context-followups");
    if (!target || !ui.contactId) return;
    const seq = ++ui.loadSeq;
    try {
      const data = await api(`/api/contacts/${encodeURIComponent(ui.contactId)}/follow-ups`);
      if (seq !== ui.loadSeq) return;
      const pending = data.items.filter((item) => item.status === "PENDENTE");
      const closed = data.items.filter((item) => item.status !== "PENDENTE").slice(0, 10);
      target.innerHTML = `
        <div class="fu-pane-head"><div><span>CLIENTE</span><h3>Retornos agendados</h3></div><button type="button" class="fu-new" data-follow-up-new>+ Agendar retorno</button></div>
        <p class="fu-help">Lembretes internos para a equipe — nada é enviado ao cliente automaticamente.</p>
        ${pending.length ? pending.map(itemMarkup).join("") : `<div class="fu-empty">Nenhum retorno pendente.</div>`}
        ${closed.length ? `<details class="fu-history"><summary>Concluídos e cancelados (${closed.length})</summary>${closed.map(itemMarkup).join("")}</details>` : ""}`;
      const chip = $("#follow-up-chip");
      if (chip) {
        const next = pending[0];
        chip.hidden = !next;
        if (next) {
          chip.textContent = data.overdue ? `⏰ Retorno atrasado` : `📅 Retorno ${when(next.dueAt)}`;
          chip.classList.toggle("critical", Boolean(data.overdue));
        }
      }
      const tab = document.querySelector("[data-context-tab='agenda']");
      if (tab) tab.textContent = pending.length ? `Agenda (${pending.length})` : "Agenda";
    } catch (error) {
      if (seq !== ui.loadSeq) return;
      target.innerHTML = `<div class="fu-empty">${esc(error.status === 403 || error.status === 404 ? "Sem acesso à agenda deste contato." : error.message)}</div>`;
      const chip = $("#follow-up-chip");
      if (chip) chip.hidden = true;
    }
  }

  async function openScheduleDialog() {
    if (!ui.conversation) return;
    const dialog = $("#follow-up-dialog");
    const form = $("#follow-up-form");
    form.reset();
    $("#follow-up-feedback").textContent = "";
    try {
      const options = await api(`/api/follow-ups/options?conversationId=${encodeURIComponent(ui.conversation.id)}`);
      $("#follow-up-contact").textContent = `${options.contact.name}${options.company ? ` · ${options.company.name}` : ""}${ui.conversation.channelAccount ? ` · ${ui.conversation.channelAccount.name}` : ""}`;
      $("#follow-up-reason").innerHTML = options.reasons.map((reason) => `<option value="${esc(reason.value)}">${esc(reason.label)}</option>`).join("");
      $("#follow-up-assignee").innerHTML = options.assignees.map((user) => `<option value="${esc(user.id)}" ${user.id === options.suggestedAssigneeId ? "selected" : ""}>${esc(user.name)}${user.id === options.preferredAssigneeId ? " ★ atendente fixo" : ""}</option>`).join("");
      $("#follow-up-preferred-hint").hidden = !options.preferredAssigneeId;
      const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
      $("#follow-up-date").value = localKey(tomorrow);
      $("#follow-up-date").min = localKey(new Date());
      $("#follow-up-time").value = "09:00";
      dialog.showModal();
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function submitSchedule(event) {
    event.preventDefault();
    const button = event.submitter || $("#follow-up-form button[type=submit]");
    button.disabled = true;
    try {
      await api("/api/follow-ups", { method: "POST", body: JSON.stringify({
        conversationId: ui.conversation.id,
        date: $("#follow-up-date").value, time: $("#follow-up-time").value,
        reason: $("#follow-up-reason").value, priority: $("#follow-up-priority").value,
        assigneeId: $("#follow-up-assignee").value, note: $("#follow-up-note").value,
      }) });
      $("#follow-up-dialog").close();
      toast("Retorno agendado.");
      loadContactFollowUps();
      refreshBadge();
    } catch (error) {
      $("#follow-up-feedback").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  function init(user) {
    ui.user = user;
    const button = $("#agenda-button");
    if (button) {
      button.hidden = false;
      button.addEventListener("click", () => { location.href = "/agenda"; });
    }
    $("#schedule-follow-up")?.addEventListener("click", openScheduleDialog);
    $("#follow-up-chip")?.addEventListener("click", () => window.setContextTabFromFollowUps?.());
    document.addEventListener("click", (event) => { if (event.target.closest("[data-follow-up-new]")) openScheduleDialog(); });
    $("#follow-up-form")?.addEventListener("submit", submitSchedule);
    $("#close-follow-up")?.addEventListener("click", () => $("#follow-up-dialog").close());
    $("#cancel-follow-up")?.addEventListener("click", () => $("#follow-up-dialog").close());
    refreshBadge();
    setInterval(() => { if (!document.hidden) refreshBadge(); }, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshBadge(); });
  }

  function onConversation(conversation) {
    const changed = !ui.conversation || ui.conversation.id !== conversation.id;
    ui.conversation = conversation;
    ui.contactId = conversation.contact?.id || null;
    // Ação só para quem pode agir na conversa (o backend revalida).
    const button = $("#schedule-follow-up");
    if (button) button.hidden = conversation.accessMode === "SUPERVISION";
    if (changed) loadContactFollowUps();
  }

  function onEvent(event, data) {
    refreshBadge();
    loadContactFollowUps();
    if (event === "followup.reminder") {
      toast(data?.kind === "OVERDUE" ? "Você tem um retorno atrasado — veja a Agenda."
        : data?.kind === "CUSTOMER_RETURNED" ? "Cliente com retorno pendente enviou mensagem."
        : data?.kind === "ASSIGNED" ? "Um novo retorno foi agendado para você."
        : data?.kind === "RESCHEDULED" ? "Um retorno seu foi reagendado."
        : "Você tem um retorno próximo — veja a Agenda.");
    }
  }

  window.FollowUpsUI = { init, onConversation, onEvent, reload: loadContactFollowUps, currentContactId: () => ui.contactId };
})();
