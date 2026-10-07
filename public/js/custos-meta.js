// Custos Meta — só apresentação; cálculo e permissão (Master) no backend.
const $ = (selector) => document.querySelector(selector);
const esc = (value = "") => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const money = (value, currency = "BRL") => (value === null || value === undefined ? "—"
  : new Intl.NumberFormat("pt-BR", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value));
const state = { company: "ALL", accounts: [] };
let reportSequence = 0;

async function api(url, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  if (response.status === 401) { location.replace("/login.html"); throw new Error("Sessão encerrada."); }
  const body = await response.json().catch(() => ({}));
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

function renderReport(report) {
  $("#cost-total").innerHTML = [
    ["Mensagens de serviço", report.total.serviceMessages],
    ["Templates", report.total.templates],
    ["Custo estimado", money(report.total.estimatedCost)],
  ].map(([label, value]) => `<article class="ops-card"><span>${esc(label)}</span><strong>${esc(value)}</strong></article>`).join("");
  $("#cost-unpriced").hidden = !report.unpricedCount;
  $("#cost-unpriced").textContent = `${report.unpricedCount} envio(s) sem preço cadastrado para a categoria/país — cadastre na tabela de preços para entrar no total.`;
  $("#cost-companies").innerHTML = report.companies.map((company) => {
    const budget = company.budget;
    const tone = budget?.percent >= 100 ? "critical" : budget?.percent >= 80 ? "warning" : "";
    return `<article class="ops-panel cost-company"${window.CompanyContext.styleAttr(company.company)}>
      <div class="ops-panel-heading"><h2>${esc(company.company?.name || "Empresa")}</h2>${window.CompanyContext.badge(company.company)}</div>
      <dl>
        <dt>Mensagens de serviço</dt><dd>${company.serviceMessages}</dd>
        <dt>Templates marketing</dt><dd>${company.byCategory.MARKETING}</dd>
        <dt>Templates utilidade</dt><dd>${company.byCategory.UTILITY}</dd>
        <dt>Templates autenticação</dt><dd>${company.byCategory.AUTHENTICATION}</dd>
        <dt>Custo estimado</dt><dd>${money(company.estimatedCost)}</dd>
      </dl>
      ${budget ? `<div class="cost-budget ${tone}"><i style="--value:${Math.min(100, budget.percent || 0)}%"></i><small>Orçamento do mês: ${money(budget.usedThisMonth)} de ${money(budget.monthlyBudget)} (${budget.percent ?? 0}%)</small></div>` : ""}
      ${company.accounts.length > 1 ? `<div class="cost-table"><table><thead><tr><th>Número</th><th>Serviço</th><th>Templates</th><th>Custo</th></tr></thead><tbody>${company.accounts.map((account) => `<tr><td>${esc(account.name)}</td><td>${account.serviceMessages}</td><td>${account.templates}</td><td>${money(account.estimatedCost)}</td></tr>`).join("")}</tbody></table></div>` : ""}
    </article>`;
  }).join("") || `<div class="ops-empty">Sem envios no período.</div>`;
}

async function loadReport() {
  const sequence = ++reportSequence;
  const params = new URLSearchParams({ period: $("#cost-period").value });
  if (state.company !== "ALL") params.set("company", state.company);
  if ($("#cost-account").value) params.set("channelAccountId", $("#cost-account").value);
  try {
    const report = await api(`/api/meta-costs/report?${params}`);
    if (sequence === reportSequence) renderReport(report);
  } catch (error) { if (sequence === reportSequence) toast(error.message, true); }
}

async function loadPricing() {
  const rows = await api("/api/meta-costs/pricing");
  const date = (value) => (value ? new Intl.DateTimeFormat("pt-BR").format(new Date(value)) : "vigente");
  $("#pricing-list").innerHTML = rows.length ? `<table><thead><tr><th>País</th><th>Categoria</th><th>Preço</th><th>Desde</th><th>Até</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(row.country)}</td><td>${esc(row.category)}</td><td>${money(Number(row.price), row.currency)}</td><td>${date(row.effectiveFrom)}</td><td>${date(row.effectiveTo)}</td></tr>`).join("")}</tbody></table>`
    : `<div class="ops-empty">Nenhum preço cadastrado. Consulte a tabela oficial da Meta e cadastre aqui.</div>`;
}

function renderAccounts() {
  const companyId = window.CompanyContext.companies.find((company) => company.slug === state.company)?.id;
  $("#cost-account").innerHTML = `<option value="">Todos os números</option>${state.accounts.filter((account) => !companyId || account.companyId === companyId).map((account) => `<option value="${esc(account.id)}">${esc(account.name)}</option>`).join("")}`;
}

$("#cost-filters").addEventListener("change", loadReport);
$("#pricing-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/meta-costs/pricing", { method: "POST", body: JSON.stringify({
      country: $("#pricing-country").value, category: $("#pricing-category").value, price: Number($("#pricing-price").value),
      currency: $("#pricing-currency").value, effectiveFrom: $("#pricing-from").value ? `${$("#pricing-from").value}T00:00:00-03:00` : undefined,
    }) });
    toast("Preço salvo.");
    $("#pricing-price").value = "";
    await loadPricing();
    await loadReport();
  } catch (error) { toast(error.message, true); }
});
$("#budget-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const raw = $("#budget-value").value.trim();
    await api("/api/meta-costs/budget", { method: "PUT", body: JSON.stringify({ company: $("#budget-company").value, monthlyBudget: raw === "" ? null : Number(raw) }) });
    toast("Orçamento salvo.");
    await loadReport();
  } catch (error) { toast(error.message, true); }
});
$("#theme-toggle").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try { localStorage.setItem("mibro-theme", dark ? "dark" : "light"); } catch { /* ignore */ }
});
$("#logout").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.replace("/login.html");
});

(async () => {
  try {
    const status = await api("/api/auth/status");
    $("#current-user").textContent = status.user.name;
    await window.CompanyContext.load();
    state.accounts = await api("/api/whatsapp-accounts").catch(() => []);
    $("#budget-company").innerHTML = window.CompanyContext.companies.map((company) => `<option value="${esc(company.slug)}">${esc(company.name)}</option>`).join("");
    window.CompanyContext.mountFilter($("#cost-company-filter"), (slug) => { state.company = slug; renderAccounts(); loadReport(); }, "ALL");
    renderAccounts();
    await Promise.all([loadReport(), loadPricing()]);
  } catch (error) { toast(error.message, true); }
})();
