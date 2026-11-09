// Custos Meta — só apresentação; cálculo e permissão (Master) no backend.
const $ = (selector) => document.querySelector(selector);
const esc = (value = "") => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const money = (value, currency = "BRL") => (value === null || value === undefined ? "—"
  : new Intl.NumberFormat("pt-BR", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value));
const state = { company: "ALL", accounts: [] };
const responseRate = value => value === null || value === undefined ? "—" : `${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
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
  state.report = report;
  $("#cost-total").innerHTML = [
    ["Mensagens de serviço", report.total.serviceMessages],
    ["Templates", report.total.templates],
    ["Templates respondidos", `${report.total.repliedTemplates || 0} / ${report.total.responseEligibleTemplates || 0}`],
    ["Taxa de resposta", responseRate(report.total.templateResponseRate)],
    ["Cobrança estimada · recibos", money(report.total.estimatedCost)],
    ["Valor de tabela · templates entregues", report.tariff?.unpricedCount ? "Parcial · " + money(Math.round(report.tariff.tableValue * 100) / 100) : money(report.tariff?.tableValue == null ? null : Math.round(report.tariff.tableValue * 100) / 100)],
  ].map(([label, value]) => `<article class="ops-card"><span>${esc(label)}</span><strong>${esc(value)}</strong></article>`).join("");
  let explanation = document.getElementById("cost-tariff-note");
  if (!explanation) {
    explanation = document.createElement("div"); explanation.id = "cost-tariff-note"; explanation.className = "ops-panel";
    $("#cost-total").after(explanation);
  }
  const tariff = report.tariff;
  explanation.innerHTML = `<p class="ops-note">Valor de tabela: tarifa cadastrada vigente no envio, antes de gratuidades, apenas para templates entregues. Não é uma fatura. A cobrança estimada mantém os valores dos recibos da Meta. ${Number(tariff?.freeCount) || 0} template(s) entregue(s) com gratuidade indicada.${tariff?.unpricedCount ? ` ${Number(tariff.unpricedCount)} sem tarifa: valor de tabela parcial.` : ""}</p>
    ${(report.templateTariffs || []).length ? `<details><summary>Detalhar valor de tabela por template · período selecionado acima</summary><div class="cost-table"><table><thead><tr><th>Template / número</th><th>Entregues</th><th>Valor de tabela</th></tr></thead><tbody>${report.templateTariffs.map(row => `<tr><td>${esc(row.templateName || "Não identificado")}<br><small>${esc(report.companies.find(c => c.companyId === row.companyId)?.accounts.find(a => a.channelAccountId === row.channelAccountId)?.name || "Sem número vinculado")}</small></td><td>${Number(row.delivered)}</td><td>${esc(money(row.tableValue == null ? null : Math.round(row.tableValue * 100) / 100))}${row.unpricedCount ? " · parcial/sem tarifa" : ""}</td></tr>`).join("")}</tbody></table></div></details>` : ""}`;
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
        <dt>Templates respondidos / avaliáveis</dt><dd>${company.repliedTemplates || 0} / ${company.responseEligibleTemplates || 0}</dd>
        <dt>Taxa de resposta</dt><dd>${responseRate(company.templateResponseRate)}</dd>
        <dt>Cobrança estimada · recibos</dt><dd>${money(company.estimatedCost)}</dd>
      </dl>
      ${budget ? `<div class="cost-budget ${tone}"><i style="--value:${Math.min(100, budget.percent || 0)}%"></i><small>Orçamento do mês: ${money(budget.usedThisMonth)} de ${money(budget.monthlyBudget)} (${budget.percent ?? 0}%)</small></div>` : ""}
      ${company.accounts.length > 1 ? `<div class="cost-table"><table><thead><tr><th>Número</th><th>Serviço</th><th>Templates</th><th>Custo</th></tr></thead><tbody>${company.accounts.map((account) => `<tr><td>${esc(account.name)}</td><td>${account.serviceMessages}</td><td>${account.templates}</td><td>${money(account.estimatedCost)}</td></tr>`).join("")}</tbody></table></div>` : ""}
    </article>`;
  }).join("") || `<div class="ops-empty">Sem envios no período.</div>`;
  renderAuthorCosts(report.byAuthorAndNumber || []);
}

function costBars(groups) {
  const rows = [...groups.values()].filter(row => row.cost > 0).sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
  const max = Math.max(1, ...rows.map((row) => row.cost));
  return rows.length ? rows.slice(0, 10).map((row) => `<div class="cost-bar"><div class="cost-bar-label"><span>${esc(row.name)}</span><strong>${esc(money(row.cost))}</strong></div><progress max="${max}" value="${row.cost}" aria-label="${esc(row.name)}: ${esc(money(row.cost))}"></progress><small>${row.messages} envio(s)</small></div>`).join("") + (rows.length > 10 ? `<small>10 maiores gastos; detalhamento completo abaixo.</small>` : "") : `<p class="ops-note">Sem envios no período.</p>`;
}

const costMoney = value => Number(value) > 0 && Number(value) < 0.005 ? '< R$ 0,01' : new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL', minimumFractionDigits:2, maximumFractionDigits:2 }).format(Number(value) || 0);
function accountIdentity(id, fallback) {
  const account = state.accounts.find(item => item.id === id);
  const profile = state.numberProfiles?.get(id);
  return { name: account?.name || profile?.name || fallback || 'Conta não identificada', phone: account?.displayNumber || profile?.phone || null };
}
function accountLabel(id, fallback) {
  const account = accountIdentity(id, fallback);
  return account.phone ? `${account.phone} · ${account.name}` : account.name;
}
function templateEngagement(row) {
  return `<small>${Number(row.repliedTemplates) || 0} de ${Number(row.responseEligibleTemplates) || 0} templates avaliáveis receberam resposta · ${esc(responseRate(row.templateResponseRate))}</small>`;
}
function authorCostCard(author) {
  const numberRows = author.rows.filter(row => row.channelAccountId);
  const unlinked = author.rows.filter(row => !row.channelAccountId);
  const numberMarkup = row => {
    const account = accountIdentity(row.channelAccountId, row.accountName);
    return `<li class="author-number-row"><div class="author-number-info"><b>${esc(row.channelAccountId ? account.phone || 'Telefone não disponível' : 'Número não registrado no envio')}</b><span>${esc(row.channelAccountId ? account.name : 'Não é possível atribuir estes envios a um número com segurança.')}</span><small>${Number(row.templates) || 0} template(s) · ${Number(row.serviceMessages) || 0} mensagem(ns) de serviço${row.unpricedCount ? ` · ${Number(row.unpricedCount)} sem preço` : ''}</small>${templateEngagement(row)}</div><strong class="author-number-cost" title="Valor estimado sem arredondamento visual: ${esc(money(row.estimatedCost))}">${esc(costMoney(row.estimatedCost))}</strong></li>`;
  };
  return `<article class="author-cost-card"><header><div><h3>${esc(author.name)}</h3><span>${numberRows.length} número(s) identificado(s)</span></div><div class="author-cost-total"><small>Total estimado</small><strong title="${esc(money(author.cost))}">${esc(costMoney(author.cost))}</strong></div></header><ul class="author-number-list">${numberRows.sort((a,b) => Number(b.estimatedCost) - Number(a.estimatedCost) || String(a.accountName || '').localeCompare(String(b.accountName || ''))).map(numberMarkup).join('')}</ul>${unlinked.length ? `<details class="cost-secondary"><summary>${unlinked.reduce((sum,row) => sum + Number(row.messages || 0),0)} envio(s) sem número registrado · ${esc(costMoney(unlinked.reduce((sum,row) => sum + Number(row.estimatedCost || 0),0)))}</summary><ul class="author-number-list">${unlinked.map(numberMarkup).join('')}</ul></details>` : ''}</article>`;
}
function renderAuthorCosts(rows) {
  const authors = new Map();
  const numbers = new Map();
  for (const row of rows) {
    for (const [map, key, name] of [[authors, row.userId ? `user:${row.userId}` : `source:${row.source}`, row.authorName], [numbers, row.channelAccountId || 'none', accountLabel(row.channelAccountId, row.accountName)]]) {
      if (!map.has(key)) map.set(key, { name, cost: 0, messages: 0, userId:row.userId, rows:[] });
      const group = map.get(key);
      group.cost += Number(row.estimatedCost) || 0;
      group.messages += Number(row.messages) || 0;
      group.rows.push(row);
    }
  }
  $("#cost-author-chart").innerHTML = costBars(authors);
  $("#cost-number-chart").innerHTML = costBars(numbers);
  const groups = [...authors.values()].sort((a,b) => b.cost - a.cost || a.name.localeCompare(b.name));
  const people = groups.filter(group => group.userId && group.cost > 0);
  const zeroCost = groups.filter(group => group.userId && !(group.cost > 0));
  const other = groups.filter(group => !group.userId);
  $("#cost-author-detail").innerHTML = rows.length ? `<div class="author-cost-grid">${people.map(authorCostCard).join('')}</div>${!people.length ? '<p class="ops-note">Nenhum gasto estimado atribuído a atendentes neste período.</p>' : ''}${zeroCost.length ? `<details class="cost-secondary"><summary>Atendentes sem custo estimado (${zeroCost.length})</summary><div class="author-cost-grid">${zeroCost.map(authorCostCard).join('')}</div></details>` : ''}${other.length ? `<details class="cost-secondary"><summary>Bot, campanhas automáticas e outras origens · ${esc(costMoney(other.reduce((sum,group) => sum + group.cost,0)))}</summary><div class="author-cost-grid">${other.map(authorCostCard).join('')}</div></details>` : ''}` : `<p class="ops-note">Nenhum envio para detalhar.</p>`;
}

function costPeriodParams() {
  const period = $("#cost-period").value;
  const daily = period === "date";
  $("#cost-date-filter").hidden = !daily;
  document.querySelectorAll("[data-cost-range]").forEach(label => { label.hidden = label.dataset.costRange !== period; });
  const monthly = period === "month-range";
  if (!daily && !monthly && period !== "date-range") return new URLSearchParams({ period });
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const endLimit = monthly ? today.slice(0, 7) : today;
  const startInput = $(daily ? "#cost-date" : monthly ? "#cost-from-month" : "#cost-from-date");
  const endInput = daily ? startInput : $(monthly ? "#cost-to-month" : "#cost-to-date");
  startInput.max = endLimit;
  endInput.max = endLimit;
  startInput.value ||= endLimit;
  endInput.value ||= endLimit;
  const { value: first } = startInput;
  const { value: last } = endInput;
  const format = monthly ? /^\d{4}-(0[1-9]|1[0-2])$/ : /^\d{4}-\d{2}-\d{2}$/;
  if (!format.test(first) || !format.test(last) || first > last || last > endLimit) {
    throw new Error("Escolha um intervalo válido, com início até o fim e sem datas futuras.");
  }
  const from = monthly ? `${first}-01` : first;
  const to = monthly ? new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5)), 0)).toISOString().slice(0, 10) : last;
  return new URLSearchParams({ from: `${from}T00:00:00.000-03:00`, to: `${to}T23:59:59.999-03:00` });
}

async function loadReport() {
  const sequence = ++reportSequence;
  let params;
  try { params = costPeriodParams(); } catch (error) { toast(error.message, true); return; }
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

async function loadAccountPhones() {
  if (!state.accounts.some(account => !account.displayNumber)) return;
  try {
    const numbers = await api('/api/outbound/meta/numbers');
    const phones = new Map(numbers.map(number => [number.channelAccountId || (number.id === 'legacy' ? null : number.id), number.phone]));
    state.numberProfiles = new Map(numbers.filter(number => number.channelAccountId || number.id !== 'legacy').map(number => [number.channelAccountId || number.id, number]));
    state.accounts = state.accounts.map(account => ({ ...account, displayNumber: account.displayNumber || phones.get(account.id) || null }));
    renderAccounts({ preserve:true });
    if (state.report) renderAuthorCosts(state.report.byAuthorAndNumber || []);
  } catch { /* Perfil informativo: falhas não bloqueiam o relatório nem inventam telefones. */ }
}
function renderAccounts({ preserve = false } = {}) {
  const selected = preserve ? $('#cost-account').value : '';
  const companyId = window.CompanyContext.companies.find((company) => company.slug === state.company)?.id;
  $("#cost-account").innerHTML = `<option value="">Todos os números</option>${state.accounts.filter((account) => !companyId || account.companyId === companyId).map((account) => `<option value="${esc(account.id)}">${esc(accountLabel(account.id, account.name))}</option>`).join("")}`;
  if (selected && [...$('#cost-account').options].some(option => option.value === selected)) $('#cost-account').value = selected;
}

// Ranking de templates: mesma empresa e número; período próprio (7/30/90 dias).
const loadRanking = () => window.TemplateRanking?.load({ company: state.company, channelAccountId: $("#cost-account").value || null });
$("#cost-filters").addEventListener("change", (event) => { loadReport(); if (event.target.id === "cost-account") loadRanking(); });
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
    state.company = window.CompanyContext.mountFilter($("#cost-company-filter"), (slug) => { state.company = slug; renderAccounts(); loadReport(); loadRanking(); }, "ALL");
    renderAccounts();
    await Promise.all([loadReport(), loadRanking(), loadPricing(), loadAccountPhones()]);
  } catch (error) { toast(error.message, true); }
})();
