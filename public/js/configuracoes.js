const $ = (selector) => document.querySelector(selector);

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
  element.classList.toggle("error", error);
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 3200);
}

function fillForm(settings) {
  $("#cs-reopen-enabled").checked = settings.reopenConversationOnCustomerMessage;
  $("#cs-reopen-window").value = settings.reopenWindowMinutes ?? "";
  $("#cs-bot-ttl").value = settings.botContextTtlMinutes;
  $("#cs-auto-finalize-enabled").checked = settings.autoFinalizationEnabled;
  $("#cs-auto-finalize-minutes").value = settings.autoFinalizationMinutes;
  $("#cs-first-response-enabled").checked = settings.firstResponseSlaEnabled;
  $("#cs-first-response-minutes").value = settings.firstResponseSlaMinutes;
  $("#cs-response-enabled").checked = settings.responseSlaEnabled;
  $("#cs-response-minutes").value = settings.responseSlaMinutes;
  $("#cs-business-hours-only").checked = settings.slaBusinessHoursOnly;
  $("#cs-sla-near-breach-enabled").checked = settings.slaNearBreachAlertEnabled;
  $("#cs-sla-near-breach-percent").value = settings.slaNearBreachPercent;
  $("#cs-unanswered-enabled").checked = settings.unansweredConversationAlertEnabled;
  $("#cs-unanswered-minutes").value = settings.unansweredConversationAlertMinutes;
  $("#cs-stalled-enabled").checked = settings.stalledConversationAlertEnabled;
  $("#cs-stalled-minutes").value = settings.stalledConversationAlertMinutes;
  $("#cs-unassigned-enabled").checked = settings.unassignedConversationAlertEnabled;
  $("#cs-unassigned-minutes").value = settings.unassignedConversationAlertMinutes;
  $("#cs-bot-resume-enabled").checked = settings.botResumeAfterHumanEnabled;
  $("#cs-bot-resume-minutes").value = settings.botResumeAfterHumanMinutes;
}

function collectPayload() {
  const reopenWindowRaw = $("#cs-reopen-window").value.trim();
  return {
    reopenConversationOnCustomerMessage: $("#cs-reopen-enabled").checked,
    reopenWindowMinutes: reopenWindowRaw === "" ? null : Number(reopenWindowRaw),
    botContextTtlMinutes: Number($("#cs-bot-ttl").value),
    autoFinalizationEnabled: $("#cs-auto-finalize-enabled").checked,
    autoFinalizationMinutes: Number($("#cs-auto-finalize-minutes").value),
    firstResponseSlaEnabled: $("#cs-first-response-enabled").checked,
    firstResponseSlaMinutes: Number($("#cs-first-response-minutes").value),
    responseSlaEnabled: $("#cs-response-enabled").checked,
    responseSlaMinutes: Number($("#cs-response-minutes").value),
    slaBusinessHoursOnly: $("#cs-business-hours-only").checked,
    slaNearBreachAlertEnabled: $("#cs-sla-near-breach-enabled").checked,
    slaNearBreachPercent: Number($("#cs-sla-near-breach-percent").value),
    unansweredConversationAlertEnabled: $("#cs-unanswered-enabled").checked,
    unansweredConversationAlertMinutes: Number($("#cs-unanswered-minutes").value),
    stalledConversationAlertEnabled: $("#cs-stalled-enabled").checked,
    stalledConversationAlertMinutes: Number($("#cs-stalled-minutes").value),
    unassignedConversationAlertEnabled: $("#cs-unassigned-enabled").checked,
    unassignedConversationAlertMinutes: Number($("#cs-unassigned-minutes").value),
  };
}

function setReadOnly(readOnly) {
  $("#settings-readonly-note").hidden = !readOnly;
  $("#save-settings").hidden = readOnly;
  $("#settings-form").querySelectorAll("input").forEach((input) => {
    if (input.dataset.alwaysDisabled) return;
    input.disabled = readOnly;
  });
}

$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const settings = await api("/api/conversation-settings", { method: "PATCH", body: JSON.stringify(collectPayload()) });
    fillForm(settings);
    toast("Configurações salvas.");
  } catch (error) { toast(error.message, true); }
});

$("#theme-toggle").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try { localStorage.setItem("mibro-theme", dark ? "dark" : "light"); } catch { /* ignore */ }
  $("#theme-toggle").textContent = dark ? "☾" : "☀";
});
$("#logout").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.href = "/login.html";
});

// Relatório semanal (Configurações → Conversas, nova seção — só Master).
// Calculado na hora pelo backend a cada chamada (nenhum estado local
// persiste entre recarregamentos além do offset de semana escolhido).
let reportWeekOffset = 0;

const STATUS_LABELS = {
  NOVO: "Novo", EM_ATENDIMENTO: "Em atendimento", AGUARDANDO_EQUIPE: "Aguardando equipe",
  AGUARDANDO_CLIENTE: "Aguardando cliente", HANDOFF_BOT: "Encaminhado (Bot)", BOT: "Com o Bot", FINALIZADO: "Finalizado",
};

function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function renderBars(container, rows, valueKey) {
  const withValue = rows.filter((row) => row[valueKey] > 0);
  if (!withValue.length) {
    container.innerHTML = '<p class="report-empty">Sem atividade nesta semana.</p>';
    return;
  }
  const max = Math.max(...withValue.map((row) => row[valueKey]));
  container.innerHTML = withValue.map((row) => `
    <div class="report-bar-row" title="${escapeHtml(row.name)}: ${row[valueKey]}">
      <span class="report-bar-name">${escapeHtml(row.name)}</span>
      <span class="report-bar-track"><span class="report-bar-fill" style="width:${Math.max(4, Math.round((row[valueKey] / max) * 100))}%"></span></span>
      <span class="report-bar-count">${row[valueKey]}</span>
    </div>
  `).join("");
}

function situationBadge(row) {
  if (row.resolvedWithoutAgentResponse) return '<span class="report-badge warn">Finalizada sem vendedor</span>';
  if (row.resolved) return '<span class="report-badge ok">Resolvida</span>';
  if (!row.answered) return '<span class="report-badge bad">Nunca respondida</span>';
  return "—";
}

function renderReportTable(rows) {
  const body = $("#report-table-body");
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="report-empty">Nenhuma conversa nesta semana.</td></tr>';
    return;
  }
  body.innerHTML = rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.contactName)}${row.contactPhone ? `<br><small>${escapeHtml(row.contactPhone)}</small>` : ""}</td>
      <td class="report-preview">${escapeHtml(row.lastMessagePreview || "—")}</td>
      <td>${formatDateTime(row.lastMessageAt)}</td>
      <td>${escapeHtml(STATUS_LABELS[row.status] || row.status)}</td>
      <td>${escapeHtml(row.assignedUserName || "—")}</td>
      <td>${situationBadge(row)}</td>
    </tr>
  `).join("");
}

function renderReport(report) {
  $("#report-week-label").textContent = report.weekLabel;
  $("#report-tile-new").textContent = report.totals.newConversations;
  $("#report-tile-resolved").textContent = report.totals.resolved;
  $("#report-tile-finalized").textContent = report.totals.finalizedTotal;
  $("#report-tile-unanswered").textContent = report.totals.unanswered;
  $("#report-tile-no-agent").textContent = report.totals.resolvedWithoutAgentResponse;
  renderBars($("#report-agent-bars"), report.perAgent, "messagesSent");
  renderBars($("#report-agent-finalized"), report.perAgent, "conversationsFinalized");
  const countLabel = report.truncated
    ? `mostrando as ${report.conversations.length} mais recentes`
    : `${report.conversations.length} conversa${report.conversations.length === 1 ? "" : "s"}`;
  $("#report-table-count").textContent = countLabel;
  renderReportTable(report.conversations);
}

async function loadReport() {
  try {
    const report = await api(`/api/conversation-settings/weekly-report?weekOffset=${reportWeekOffset}`);
    renderReport(report);
  } catch (error) { toast(error.message, true); }
}

$("#report-prev-week").addEventListener("click", () => { reportWeekOffset -= 1; loadReport(); });
$("#report-next-week").addEventListener("click", () => { reportWeekOffset += 1; loadReport(); });
$("#report-current-week").addEventListener("click", () => { reportWeekOffset = 0; loadReport(); });

(async function boot() {
  try {
    // Botões sempre marcados como "sempre desabilitados" (item 6 — retomada
    // do Bot ainda não tem job real, só a estrutura) não são reabilitados
    // nem para Master.
    $("#cs-bot-resume-enabled").dataset.alwaysDisabled = "true";
    $("#cs-bot-resume-minutes").dataset.alwaysDisabled = "true";

    const status = await api("/api/auth/status");
    $("#current-user").textContent = status.user.name;
    const settings = await api("/api/conversation-settings");
    fillForm(settings);
    setReadOnly(!status.user.isMaster);

    // Relatório semanal: seção nova, visível e carregada só para Master —
    // nem a chamada à API acontece para Admin/Supervisor sem isMaster
    // (o backend também recusa, isto só evita uma chamada/erro 403 à toa).
    if (status.user.isMaster) {
      $("#weekly-report-section").hidden = false;
      loadReport();
    }
  } catch (error) { toast(error.message, true); }
})();
