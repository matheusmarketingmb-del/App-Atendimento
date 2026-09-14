const $ = (selector) => document.querySelector(selector);

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

    // Relatório de Conversas: link visível só para Master (o dashboard
    // completo vive em /relatorio-conversas.html, próprio requireMasterPage).
    if (status.user.isMaster) $("#weekly-report-link").hidden = false;
  } catch (error) { toast(error.message, true); }
})();
