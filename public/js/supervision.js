// Supervisão de equipes — "Minha equipe" (Supervisor) e "Equipes" (Master).
// Master: vincula atendentes a Supervisores e consulta qualquer atendente.
// Supervisor: só a própria equipe, somente leitura, e apenas os trechos em
// que a equipe atendeu. Todo acesso é validado no backend (/api/supervision).
// Usa helpers globais do app.js: api, toast, escapeHtml, openConversation, state.
(() => {
  const STATUS = { NOVO: "Novo", EM_ATENDIMENTO: "Em atendimento", AGUARDANDO_EQUIPE: "Aguardando equipe", AGUARDANDO_CLIENTE: "Aguardando cliente", HANDOFF_BOT: "Transferida pelo Bot", BOT: "Bot", FINALIZADO: "Finalizada" };
  const PRIORITY = { NORMAL: "Normal", ALTA: "Alta", URGENTE: "Urgente" };
  const esc = (value) => escapeHtml(String(value ?? ""));
  const el = (id) => document.getElementById(id);
  const when = (iso) => iso ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "—";

  let S = null;
  const isMaster = () => Boolean(state.currentUser?.isMaster);

  function ensureDialog() {
    if (el("supervision-dialog")) return;
    document.body.insertAdjacentHTML("beforeend", `
      <dialog id="supervision-dialog" class="sv-dialog" aria-labelledby="sv-title">
        <header class="sv-head"><div><span class="sv-eyebrow" id="sv-eyebrow"></span><h2 id="sv-title"></h2><p id="sv-subtitle"></p></div><button type="button" class="sv-close" data-sv-close aria-label="Fechar">×</button></header>
        <div class="sv-body"><aside class="sv-left"></aside><section class="sv-main"></section></div>
      </dialog>
      <dialog id="sv-timeline-dialog" class="sv-dialog sv-timeline-dialog" aria-labelledby="sv-timeline-title">
        <header class="sv-head"><div><span class="sv-eyebrow">SUPERVISÃO</span><h2 id="sv-timeline-title">Histórico de atendimento</h2><p id="sv-timeline-subtitle"></p></div><button type="button" class="sv-close" data-sv-close aria-label="Fechar">×</button></header>
        <div class="sv-timeline-body"></div>
      </dialog>`);
    for (const dialog of [el("supervision-dialog"), el("sv-timeline-dialog")]) {
      dialog.addEventListener("click", onClick);
      dialog.addEventListener("change", onChange);
      dialog.addEventListener("input", onInput);
    }
  }

  // ---------------------------------------------------------------- render
  function render() {
    el("sv-eyebrow").textContent = isMaster() ? "ACESSO MASTER" : "SUPERVISÃO";
    el("sv-title").textContent = isMaster() ? "Equipes" : "Minha equipe";
    el("sv-subtitle").textContent = isMaster()
      ? "Vincule atendentes aos Supervisores e consulte todos os atendimentos que passaram por cada pessoa."
      : "Acompanhe sua equipe. Você vê somente os trechos das conversas em que seus atendentes atenderam (somente leitura).";
    const dialog = el("supervision-dialog");
    dialog.querySelector(".sv-left").innerHTML = leftMarkup();
    dialog.querySelector(".sv-main").innerHTML = mainMarkup();
  }

  function leftMarkup() {
    const master = isMaster();
    const teams = master ? `
      <div class="sv-block"><h3>Supervisores</h3>
        <button type="button" class="sv-item ${!S.supervisorId ? "active" : ""}" data-sv-supervisor="">Todos os atendentes</button>
        ${(S.teams || []).map((team) => `<button type="button" class="sv-item ${S.supervisorId === team.id ? "active" : ""}" data-sv-supervisor="${esc(team.id)}"><span>${esc(team.name)}${team.active ? "" : " (inativo)"}</span><small>${team.members.length} atendente(s)</small></button>`).join("") || `<p class="sv-empty">Nenhum Supervisor cadastrado.</p>`}
      </div>` : "";
    const manage = master && S.supervisorId ? manageMarkup() : "";
    return `${teams}${manage}
      <div class="sv-block"><h3>${master && !S.supervisorId ? "Atendentes" : "Equipe"}</h3>
        <input type="search" class="sv-input" data-sv-member-filter value="${esc(S.memberFilter)}" placeholder="Pesquisar pessoa" aria-label="Pesquisar pessoa">
        ${membersMarkup()}
      </div>`;
  }

  function manageMarkup() {
    const team = S.teams.find((item) => item.id === S.supervisorId);
    return `<div class="sv-block sv-manage"><h3>Equipe de ${esc(team?.name || "")}</h3>
      <div class="sv-chips">${(team?.members || []).map((member) => `<span class="sv-chip">${esc(member.name)}<button type="button" data-sv-remove="${esc(member.id)}" aria-label="Remover ${esc(member.name)} da equipe">×</button></span>`).join("") || `<p class="sv-empty">Sem atendentes vinculados.</p>`}</div>
      <input type="search" class="sv-input" data-sv-user-search value="${esc(S.userSearch)}" placeholder="Adicionar atendente: pesquisar nome ou e-mail" aria-label="Pesquisar usuário para adicionar">
      <div class="sv-search-results">${(S.userResults || []).filter((user) => user.id !== S.supervisorId && !(team?.members || []).some((member) => member.id === user.id)).map((user) => `
        <button type="button" class="sv-result" data-sv-add="${esc(user.id)}"><span>${esc(user.name)} <small>${user.role === "SUPERVISOR" ? "Supervisor" : "Atendente"}${user.active ? "" : " • inativo"}</small></span><small>${user.supervisors.length ? `Já em: ${esc(user.supervisors.map((item) => item.name).join(", "))}` : "Sem supervisor"}</small><b>+ Adicionar</b></button>`).join("")}</div>
    </div>`;
  }

  function membersMarkup() {
    const q = S.memberFilter.trim().toLocaleLowerCase("pt-BR");
    const members = (S.overview?.members || []).filter((member) => !q || `${member.name} ${member.email}`.toLocaleLowerCase("pt-BR").includes(q));
    if (S.loadingOverview) return `<p class="sv-empty">Carregando…</p>`;
    if (!members.length) return `<p class="sv-empty">${isMaster() && S.supervisorId ? "Adicione atendentes a esta equipe." : "Nenhum atendente na equipe. Peça ao Master para vincular atendentes a você."}</p>`;
    return `<div class="sv-members">${members.map((member) => `
      <button type="button" class="sv-member ${S.memberId === member.id ? "active" : ""}" data-sv-member="${esc(member.id)}">
        <span class="sv-member-name">${esc(member.name)}${member.isSelf ? " <small>(você)</small>" : ""}${member.active === false ? " <small>inativo</small>" : ""}</span>
        <span class="sv-stats"><span title="Em atendimento"><b>${member.inProgress}</b> em atendimento</span><span title="Aguardando"><b>${member.waiting}</b> aguardando</span><span title="Atendimentos hoje"><b>${member.handledToday}</b> hoje</span></span>
      </button>`).join("")}</div>`;
  }

  function mainMarkup() {
    if (!S.memberId) return `<div class="sv-placeholder">Selecione uma pessoa para ver os atendimentos atuais e o histórico.</div>`;
    const member = S.overview?.members.find((item) => item.id === S.memberId);
    const f = S.filters;
    const result = S.conversations;
    return `
      <div class="sv-main-head"><h3>${esc(member?.name || "")}</h3>
        <div class="sv-tabs" role="tablist"><button type="button" role="tab" class="${S.tab === "current" ? "active" : ""}" data-sv-tab="current">Atuais</button><button type="button" role="tab" class="${S.tab === "history" ? "active" : ""}" data-sv-tab="history">Histórico</button></div>
      </div>
      <div class="sv-filters">
        <input type="search" class="sv-input" data-sv-filter="q" value="${esc(f.q || "")}" placeholder="Cliente, telefone ou e-mail" aria-label="Buscar cliente">
        <select class="sv-input" data-sv-filter="state" aria-label="Situação"><option value="">Qualquer situação</option><option value="active" ${f.state === "active" ? "selected" : ""}>Em andamento</option><option value="finished" ${f.state === "finished" ? "selected" : ""}>Finalizada</option>${S.tab === "history" ? `<option value="transferred" ${f.state === "transferred" ? "selected" : ""}>Transferida depois</option>` : ""}</select>
        <select class="sv-input" data-sv-filter="status" aria-label="Status"><option value="">Qualquer status</option>${Object.entries(STATUS).map(([value, label]) => `<option value="${value}" ${f.status === value ? "selected" : ""}>${label}</option>`).join("")}</select>
        <select class="sv-input" data-sv-filter="priority" aria-label="Prioridade"><option value="">Qualquer prioridade</option>${Object.entries(PRIORITY).map(([value, label]) => `<option value="${value}" ${f.priority === value ? "selected" : ""}>${label}</option>`).join("")}</select>
        <select class="sv-input" data-sv-filter="categoryId" aria-label="Setor"><option value="">Qualquer setor</option>${(state.categories || []).filter((category) => !category.parentId).map((category) => `<option value="${esc(category.id)}" ${f.categoryId === category.id ? "selected" : ""}>${esc(category.name)}</option>`).join("")}</select>
        <select class="sv-input" data-sv-filter="assignedUserId" aria-label="Responsável atual"><option value="">Qualquer responsável atual</option><option value="none" ${f.assignedUserId === "none" ? "selected" : ""}>Sem responsável</option>${(S.overview?.members || []).map((item) => `<option value="${esc(item.id)}" ${f.assignedUserId === item.id ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select>
        <label class="sv-date">De <input type="date" class="sv-input" data-sv-filter="from" value="${esc(f.from || "")}"></label>
        <label class="sv-date">Até <input type="date" class="sv-input" data-sv-filter="to" value="${esc(f.to || "")}"></label>
      </div>
      ${!result ? `<p class="sv-empty">Carregando…</p>` : `
      <p class="sv-count">${result.total} atendimento(s)${S.tab === "history" ? " em que esta pessoa participou" : " atribuídos agora"}</p>
      <div class="sv-table-wrap"><table class="sv-table"><thead><tr><th>Cliente</th><th>Canal</th><th>Setor</th><th>Status</th><th>1ª participação</th><th>Última participação</th><th>Responsável atual</th><th>Msgs enviadas</th><th></th></tr></thead><tbody>
        ${result.rows.map((row) => `<tr>
          <td><b>${esc(row.contact)}</b><small>${esc(row.phone || "")}</small></td>
          <td>${esc(row.channelAccount || row.channel)}</td>
          <td>${row.category ? `<span class="sv-cat" style="--cat:${esc(row.category.color || "#888")}">${esc(row.category.label)}</span>` : "—"}</td>
          <td>${esc(STATUS[row.status] || row.status)}${row.priority !== "NORMAL" ? ` <span class="sv-pill">${esc(PRIORITY[row.priority])}</span>` : ""}${row.transferred ? ` <span class="sv-pill muted">transferida</span>` : ""}</td>
          <td>${esc(when(row.firstParticipationAt))}</td>
          <td>${row.inProgressWithMember ? "<b>em atendimento</b>" : esc(when(row.lastParticipationAt))}</td>
          <td>${esc(row.currentAssignee?.name || "Sem responsável")}</td>
          <td class="sv-num">${row.messagesSentByMember}</td>
          <td class="sv-actions"><button type="button" class="sv-link" data-sv-open="${esc(row.id)}">Abrir</button><button type="button" class="sv-link" data-sv-timeline="${esc(row.id)}">Histórico</button></td>
        </tr>`).join("") || `<tr><td colspan="9" class="sv-empty">Nenhum atendimento encontrado.</td></tr>`}
      </tbody></table></div>
      ${result.total > result.pageSize ? `<div class="sv-pager"><button type="button" class="sv-link" data-sv-page="${result.page - 1}" ${result.page <= 1 ? "disabled" : ""}>← Anterior</button><span>Página ${result.page} de ${Math.ceil(result.total / result.pageSize)}</span><button type="button" class="sv-link" data-sv-page="${result.page + 1}" ${result.page * result.pageSize >= result.total ? "disabled" : ""}>Próxima →</button></div>` : ""}`}`;
  }

  // ------------------------------------------------------------------ dados
  async function loadTeams() {
    if (!isMaster()) return;
    S.teams = await api("/api/supervision/teams");
  }
  async function loadOverview() {
    S.loadingOverview = true;
    render();
    try { S.overview = await api(`/api/supervision/overview${isMaster() && S.supervisorId ? `?supervisorId=${encodeURIComponent(S.supervisorId)}` : ""}`); }
    catch (error) { toast(error.message, true); S.overview = { members: [] }; }
    finally { S.loadingOverview = false; render(); }
  }
  let conversationsTimer = null;
  function loadConversations(delay = 0) {
    clearTimeout(conversationsTimer);
    conversationsTimer = setTimeout(async () => {
      if (!S.memberId) return;
      S.conversations = null;
      render();
      const params = new URLSearchParams(Object.entries({ ...S.filters, tab: S.tab, page: S.page }).filter(([, value]) => value));
      try { S.conversations = await api(`/api/supervision/members/${encodeURIComponent(S.memberId)}/conversations?${params}`); }
      catch (error) { toast(error.message, true); S.conversations = { total: 0, rows: [], page: 1, pageSize: 30 }; }
      render();
    }, delay);
  }
  let userSearchTimer = null;
  function searchUsers() {
    clearTimeout(userSearchTimer);
    userSearchTimer = setTimeout(async () => {
      try { S.userResults = await api(`/api/supervision/users?q=${encodeURIComponent(S.userSearch)}`); render(); keepFocus("[data-sv-user-search]"); }
      catch (error) { toast(error.message, true); }
    }, 250);
  }
  function keepFocus(selector) {
    const input = el("supervision-dialog").querySelector(selector);
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }

  // ---------------------------------------------------------------- eventos
  async function onClick(event) {
    const target = event.target.closest("button");
    if (!target || target.disabled) return;
    const d = target.dataset;
    if (d.svClose !== undefined) { target.closest("dialog").close(); return; }
    if (d.svSupervisor !== undefined) { S.supervisorId = d.svSupervisor || null; S.memberId = null; S.conversations = null; S.userSearch = ""; S.userResults = []; await loadOverview(); if (S.supervisorId) searchUsers(); return; }
    if (d.svMember) { S.memberId = d.svMember; S.page = 1; S.tab = "current"; loadConversations(); return; }
    if (d.svTab) { S.tab = d.svTab; S.page = 1; if (d.svTab === "current" && S.filters.state === "transferred") S.filters.state = ""; loadConversations(); return; }
    if (d.svPage) { S.page = Number(d.svPage); loadConversations(); return; }
    if (d.svOpen) {
      el("supervision-dialog").close();
      try { await openConversation(d.svOpen); } catch (error) { toast(error.message, true); }
      return;
    }
    if (d.svTimeline) { await openTimeline(d.svTimeline); return; }
    if (d.svAdd || d.svRemove) {
      try {
        await api(`/api/supervision/teams/${encodeURIComponent(S.supervisorId)}/members/${encodeURIComponent(d.svAdd || d.svRemove)}`, { method: d.svAdd ? "PUT" : "DELETE" });
        toast(d.svAdd ? "Atendente adicionado à equipe." : "Atendente removido da equipe.");
        await loadTeams();
        await loadOverview();
        searchUsers();
      } catch (error) { toast(error.message, true); }
    }
  }
  function onChange(event) {
    const d = event.target.dataset;
    if (d.svFilter && d.svFilter !== "q") { S.filters[d.svFilter] = event.target.value; S.page = 1; loadConversations(); }
  }
  function onInput(event) {
    const d = event.target.dataset;
    if (d.svFilter === "q") { S.filters.q = event.target.value; S.page = 1; loadConversations(400); }
    if (d.svMemberFilter !== undefined) { S.memberFilter = event.target.value; el("supervision-dialog").querySelector(".sv-left").innerHTML = leftMarkup(); keepFocus("[data-sv-member-filter]"); }
    if (d.svUserSearch !== undefined) { S.userSearch = event.target.value; searchUsers(); }
  }

  // ---------------------------------------------------------------- timeline
  async function openTimeline(conversationId) {
    ensureDialog();
    const dialog = el("sv-timeline-dialog");
    const body = dialog.querySelector(".sv-timeline-body");
    body.innerHTML = `<p class="sv-empty">Carregando…</p>`;
    if (!dialog.open) dialog.showModal();
    try {
      const t = await api(`/api/conversations/${encodeURIComponent(conversationId)}/assignment-timeline`);
      el("sv-timeline-subtitle").textContent = t.scope === "FULL"
        ? "Histórico completo de responsáveis e eventos."
        : "Somente os trechos em que sua equipe foi responsável.";
      body.innerHTML = `
        ${t.windows ? `<div class="sv-windows"><b>Trechos visíveis</b>${t.windows.map((window) => `<span>${esc(when(window.from))} → ${window.to ? esc(when(window.to)) : "agora"}</span>`).join("")}</div>` : ""}
        <div class="sv-participants"><h3>Quem atendeu</h3>${t.participants.map((p) => `<div class="sv-participant"><b>${esc(p.user.name)}</b><span>${esc(when(p.startedAt))} → ${p.endedAt ? esc(when(p.endedAt)) : "responsável atual"}</span>${p.source === "BACKFILL" ? `<small>reconstruído do histórico</small>` : ""}</div>`).join("") || `<p class="sv-empty">Sem períodos registrados.</p>`}</div>
        ${t.messagesByUser.length ? `<div class="sv-participants"><h3>Mensagens enviadas</h3>${t.messagesByUser.map((row) => `<div class="sv-participant"><b>${esc(row.name)}</b><span>${row.count} mensagem(ns)</span></div>`).join("")}</div>` : ""}
        <ol class="sv-timeline">${t.events.map((item) => `<li><time>${esc(when(item.at))}</time><span>${esc(item.text)}</span></li>`).join("") || `<li class="sv-empty">Nenhum evento no período visível.</li>`}</ol>`;
    } catch (error) {
      body.innerHTML = `<p class="sv-empty">${esc(error.message)}</p>`;
    }
  }

  async function open() {
    ensureDialog();
    S = { teams: [], supervisorId: null, overview: null, memberId: null, memberFilter: "", userSearch: "", userResults: [], tab: "current", page: 1, filters: {}, conversations: null, loadingOverview: false };
    render();
    el("supervision-dialog").showModal();
    try { await loadTeams(); } catch (error) { toast(error.message, true); }
    await loadOverview();
  }

  window.WaSupervision = { open, openTimeline };
})();
