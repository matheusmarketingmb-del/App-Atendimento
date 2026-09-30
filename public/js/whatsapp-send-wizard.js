// Painel "Nova conversa" do WhatsApp — envio individual (simples, uma tela)
// e envio em massa por etapas (Origem → Contatos → Templates →
// Personalização → Revisão → Acompanhamento). Toda validação real acontece
// no backend (/api/outbound/*); aqui só organiza a experiência. Usa os
// helpers globais do app.js: api, toast, escapeHtml, loadConversations,
// openConversation.
(() => {
  const STEPS = [
    { id: "origin", label: "Origem" },
    { id: "contacts", label: "Contatos" },
    { id: "templates", label: "Templates" },
    { id: "variables", label: "Personalização" },
    { id: "review", label: "Revisão" },
  ];
  const SOURCES = {
    CONTACT_NAME: "Nome do contato", FIRST_NAME: "Primeiro nome do contato", AGENT_NAME: "Seu nome",
    AGENT_FIRST_NAME: "Seu primeiro nome", STATIC: "Texto fixo para todos", MANUAL: "Preencher por contato",
  };
  const NAME_SOURCES = ["CONTACT_NAME", "FIRST_NAME"];
  const STATUS_LABELS = {
    PENDING: "Pendente", QUEUED: "Na fila", SENDING: "Enviando", SENT: "Enviado", DELIVERED: "Entregue", READ: "Lido",
    REPLIED: "Respondeu", FAILED: "Falhou", SKIPPED: "Ignorado", OPTED_OUT: "Opt-out",
  };
  const QUALITY_LABELS = { GREEN: "Qualidade alta", YELLOW: "Qualidade média", RED: "Qualidade baixa", UNKNOWN: "Qualidade não informada" };
  const LARGE_SELECTION = 200;

  const esc = (value) => escapeHtml(String(value ?? ""));
  const el = (id) => document.getElementById(id);
  const money = (value, digits = 2) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: digits }).format(Number(value) || 0);
  const shortDate = (iso) => iso ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "2-digit" }).format(new Date(iso)) : "—";
  const tplKey = (template) => template ? `${template.name}|${template.language}` : "";
  const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, "");

  // ------------------------------------------------ Telefone (espelho leve)
  // Só para formatação/deduplicação imediata na tela; a regra oficial é a do
  // backend (bulk-send-rules.js), reaplicada na revisão.
  function normalizePhone(value) {
    const raw = String(value || "").trim();
    const international = /^\s*(\+|00)/.test(raw);
    let digits = raw.replace(/\D/g, "");
    if (international && digits.startsWith("00")) digits = digits.slice(2);
    if (!international) {
      if (/^0\d{10,11}$/.test(digits)) digits = digits.slice(1);
      if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
    }
    if (digits.length < 8 || digits.length > 15) return null;
    if (digits.startsWith("55") && ![12, 13].includes(digits.length)) return null;
    if (!digits.startsWith("55") && !international) return null;
    return digits;
  }
  function dedupeKey(phone) {
    const withNine = phone.match(/^55(\d{2})9([6-9]\d{7})$/);
    return withNine ? `55${withNine[1]}${withNine[2]}` : phone;
  }
  function formatPhone(phone) {
    const match = String(phone || "").match(/^55(\d{2})(\d{4,5})(\d{4})$/);
    return match ? `+55 (${match[1]}) ${match[2]}-${match[3]}` : phone ? `+${phone}` : "";
  }
  function maskTyping(value) {
    const digits = String(value || "").replace(/\D/g, "").slice(0, 13);
    const local = digits.startsWith("55") && digits.length > 11 ? digits.slice(2) : digits;
    if (local.length <= 2) return local ? `(${local}` : "";
    if (local.length <= 6) return `(${local.slice(0, 2)}) ${local.slice(2)}`;
    if (local.length <= 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
    return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7, 11)}`;
  }

  // ---------------------------------------------------------- Variáveis
  function suggestSource(variable) {
    const key = String(variable.placeholder || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
    if (/^(first_?name|primeiro_?nome)$/.test(key)) return "FIRST_NAME";
    if (/(customer|client|cliente|contact|contato)_?(name|nome)|^(name|nome|nome_cliente)$/.test(key)) return "CONTACT_NAME";
    if (/(agent|atendente|vendedor|seller|consultor|representante)(_?(name|nome))?$|^(nome_)?(atendente|vendedor|consultor)$/.test(key)) return "AGENT_NAME";
    if (variable.component === "BODY" && variable.placeholder === "1" && /^[A-ZÀ-Ý][a-zà-ÿ]{1,20}$/.test(String(variable.example || "").trim())) return "FIRST_NAME";
    return "MANUAL";
  }
  const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";
  function resolveValue(variable, rule, recipient) {
    const override = recipient.values?.[variable.key];
    if (override !== undefined && String(override).trim()) return String(override).trim();
    const agent = state.currentUser?.name || "";
    let value = "";
    if (rule.source === "CONTACT_NAME") value = String(recipient.name || "").trim();
    else if (rule.source === "FIRST_NAME") value = firstName(recipient.name);
    else if (rule.source === "AGENT_NAME") value = agent;
    else if (rule.source === "AGENT_FIRST_NAME") value = firstName(agent);
    else if (rule.source === "STATIC") value = String(rule.value || "").trim();
    if (!value && NAME_SOURCES.includes(rule.source) && recipient.useNameFallback) value = String(rule.fallback || "").trim();
    return value;
  }

  // -------------------------------------------------------------- Estado
  let S = null;
  function freshState(metaChannel) {
    const modes = metaChannel?.modes || { individual: Boolean(state.currentUser?.canStartConversations), bulk: Boolean(state.currentUser?.canManageCampaigns) };
    return {
      modes, mode: modes.individual ? "individual" : "bulk", step: 0, numbers: [], accountId: null, templates: [], templatesLoading: false,
      templateFilter: { q: "", category: "", language: "" }, individual: { name: "", phone: "", template: null, values: {}, existing: null },
      recipients: [], recipientFilter: "", recipientGroup: "", contactsTab: "manual", mappings: {}, defaultTemplateKey: "",
      central: { filters: { conversed: "yes", period: "" }, page: 1, rows: [], total: 0, selected: new Set(), options: null, loading: false },
      paste: null, csv: null, batchName: "", preview: null, previewing: false, idempotencyKey: newKey(), batch: null, pollTimer: null, previewKey: null,
    };
  }

  const templateByKey = (key) => S.templates.find((template) => tplKey(template) === key) || null;
  const currentNumber = () => S.numbers.find((number) => number.id === S.accountId) || null;
  const recipientTemplate = (recipient) => templateByKey(recipient.templateKey || S.defaultTemplateKey);
  function mappingFor(template) {
    const key = tplKey(template);
    if (!S.mappings[key]) S.mappings[key] = Object.fromEntries((template.variables || []).map((variable) => [variable.key, { source: suggestSource(variable), value: "", fallback: "" }]));
    return S.mappings[key];
  }

  // ------------------------------------------------------------ Estrutura
  function ensureDialog() {
    if (el("wa-send-dialog")) return;
    document.body.insertAdjacentHTML("beforeend", `
      <dialog id="wa-send-dialog" class="wa-send" aria-labelledby="wa-send-title">
        <header class="wa-head">
          <div class="wa-head-title">
            <span class="wa-eyebrow">WHATSAPP • NOVA CONVERSA</span>
            <h2 id="wa-send-title">Enviar template aprovado</h2>
          </div>
          <div class="wa-mode" role="tablist" aria-label="Tipo de envio">
            <button type="button" role="tab" data-wa-mode="individual">Individual</button>
            <button type="button" role="tab" data-wa-mode="bulk">Envio em massa</button>
          </div>
          <button type="button" class="wa-close" data-wa-close aria-label="Fechar">×</button>
        </header>
        <nav class="wa-stepper" aria-label="Etapas do envio"></nav>
        <div class="wa-body">
          <section class="wa-main" aria-live="polite"></section>
          <aside class="wa-side"></aside>
        </div>
        <footer class="wa-foot"></footer>
        <div class="wa-confirm" hidden></div>
      </dialog>`);
    const dialog = el("wa-send-dialog");
    dialog.addEventListener("click", onClick);
    dialog.addEventListener("input", onInput);
    dialog.addEventListener("change", onChange);
    dialog.addEventListener("close", () => { if (S?.pollTimer) clearInterval(S.pollTimer); });
  }

  function render() {
    const dialog = el("wa-send-dialog");
    dialog.dataset.mode = S.mode;
    dialog.querySelectorAll("[data-wa-mode]").forEach((button) => {
      const allowed = S.modes[button.dataset.waMode];
      button.hidden = !allowed || !(S.modes.individual && S.modes.bulk);
      button.classList.toggle("active", button.dataset.waMode === S.mode);
      button.setAttribute("aria-selected", String(button.dataset.waMode === S.mode));
    });
    el("wa-send-title").textContent = S.mode === "individual" ? "Enviar template aprovado" : S.batch ? "Acompanhamento do envio" : "Envio em massa";
    renderStepper();
    dialog.querySelector(".wa-main").innerHTML = S.mode === "individual" ? individualMarkup() : bulkStepMarkup();
    dialog.querySelector(".wa-side").innerHTML = sideMarkup();
    dialog.querySelector(".wa-foot").innerHTML = footerMarkup();
  }

  function renderStepper() {
    const nav = el("wa-send-dialog").querySelector(".wa-stepper");
    nav.hidden = S.mode !== "bulk";
    if (S.mode !== "bulk") return;
    const current = S.batch ? STEPS.length : S.step;
    nav.innerHTML = `<ol>${STEPS.map((step, index) => `
      <li class="${index < current ? "done" : index === current ? "active" : ""}">
        <button type="button" data-wa-goto="${index}" ${index > current || S.batch ? "disabled" : ""}><b>${index < current ? "✓" : index + 1}</b><span>${step.label}</span></button>
      </li>`).join("")}</ol>
      <div class="wa-progress"><i style="width:${Math.round((current / STEPS.length) * 100)}%"></i></div>`;
  }

  // --------------------------------------------------- Número remetente
  function numbersMarkup() {
    if (!S.numbers.length) return `<div class="wa-empty">Nenhum número WhatsApp disponível para você.</div>`;
    return `<div class="wa-numbers" role="radiogroup" aria-label="Número de atendimento">${S.numbers.map((number) => `
      <button type="button" role="radio" aria-checked="${number.id === S.accountId}" class="wa-number ${number.id === S.accountId ? "selected" : ""}" data-wa-number="${esc(number.id)}" ${number.available ? "" : "disabled"}>
        <span class="wa-number-dot ${number.available ? "on" : "off"}"></span>
        <span class="wa-number-info">
          <b>${esc(number.name)}</b>
          <small>${esc(number.phone || number.verifiedName || "Telefone não informado")}</small>
          <small class="wa-number-meta">${number.wabaId ? `WABA ${esc(number.wabaId)}` : "WABA não informada"}${number.quality ? ` • <em class="q-${esc(number.quality)}">${esc(QUALITY_LABELS[number.quality] || number.quality)}</em>` : ""}</small>
        </span>
        <span class="wa-number-status">${number.available ? "Disponível" : esc(number.reason || "Indisponível")}</span>
      </button>`).join("")}</div>`;
  }

  // ------------------------------------------------------ Templates
  function filteredTemplates() {
    const { q, category, language } = S.templateFilter;
    const search = q.trim().toLocaleLowerCase("pt-BR");
    return S.templates.filter((template) => (!category || template.category === category) && (!language || template.language === language)
      && (!search || `${template.name} ${template.preview || ""}`.toLocaleLowerCase("pt-BR").includes(search)));
  }
  function templateFiltersMarkup() {
    const categories = [...new Set(S.templates.map((template) => template.category).filter(Boolean))];
    const languages = [...new Set(S.templates.map((template) => template.language).filter(Boolean))];
    return `<div class="wa-template-filters">
      <input type="search" data-wa-tfilter="q" value="${esc(S.templateFilter.q)}" placeholder="Buscar template" aria-label="Buscar template">
      <select data-wa-tfilter="category" aria-label="Categoria"><option value="">Todas as categorias</option>${categories.map((value) => `<option ${value === S.templateFilter.category ? "selected" : ""}>${esc(value)}</option>`).join("")}</select>
      <select data-wa-tfilter="language" aria-label="Idioma"><option value="">Todos os idiomas</option>${languages.map((value) => `<option ${value === S.templateFilter.language ? "selected" : ""}>${esc(value)}</option>`).join("")}</select>
    </div>`;
  }
  function templateCardsMarkup(selectedKey, attr) {
    if (S.templatesLoading) return `<div class="wa-empty">Consultando templates aprovados na Meta…</div>`;
    const list = filteredTemplates();
    if (!list.length) return `<div class="wa-empty">Nenhum template aprovado encontrado.</div>`;
    return `<div class="wa-templates">${list.map((template) => `
      <button type="button" class="wa-template ${tplKey(template) === selectedKey ? "selected" : ""}" ${attr}="${esc(tplKey(template))}" ${template.supported === false ? "disabled" : ""} title="${esc(template.unsupportedReason || template.name)}">
        <span class="wa-template-top"><b>${esc(template.name)}</b><em class="cat-${esc(template.category)}">${esc(template.category || "—")}</em></span>
        <span class="wa-template-meta">${esc(template.language)} • Aprovado • ${template.pricing ? `${money(template.pricing.rate, 4)}/msg` : "tarifa indisponível"}</span>
        <small>${esc(template.unsupportedReason || template.preview || "Sem prévia")}</small>
      </button>`).join("")}</div>`;
  }

  // ------------------------------------------------ Prévia WhatsApp
  function previewValues(template, recipient) {
    if (!template) return {};
    const mapping = S.mode === "bulk" ? mappingFor(template) : null;
    return Object.fromEntries((template.variables || []).map((variable) => {
      if (S.mode === "individual") return [variable.key, S.individual.values[variable.key] ?? ""];
      return [variable.key, recipient ? resolveValue(variable, mapping[variable.key], recipient) : ""];
    }));
  }
  function fill(text, template, values) {
    let output = String(text || "");
    for (const variable of template.variables || []) {
      const value = values[variable.key];
      output = output.replaceAll(`{{${variable.placeholder}}}`, value ? `\u0000${value}\u0001` : `\u0002{{${variable.placeholder}}}\u0001`);
    }
    return esc(output).replace(/\u0000/g, "<mark>").replace(/\u0002/g, "<mark class=\"missing\">").replace(/\u0001/g, "</mark>");
  }
  function whatsappPreviewMarkup(template, recipient) {
    if (!template) return `<div class="wa-phone"><div class="wa-phone-empty">Selecione um template para ver a prévia.</div></div>`;
    const values = previewValues(template, recipient);
    const components = template.components || [];
    const header = components.find((item) => item.type === "HEADER");
    const body = components.find((item) => item.type === "BODY");
    const footer = components.find((item) => item.type === "FOOTER");
    const buttons = components.find((item) => item.type === "BUTTONS")?.buttons || [];
    const media = header && header.format && header.format !== "TEXT" ? `<div class="wa-media">${esc(String(header.format).toLowerCase())}</div>` : "";
    return `<div class="wa-phone">
      <div class="wa-phone-bar"><span class="wa-phone-avatar">${esc((recipient?.name || S.individual.name || "?").slice(0, 1).toUpperCase())}</span><b>${esc(recipient?.name || S.individual.name || "Contato")}</b></div>
      <div class="wa-chat">
        <div class="wa-bubble">
          ${media}
          ${header?.text ? `<p class="wa-bubble-header">${fill(header.text, template, values)}</p>` : ""}
          ${body?.text ? `<p>${fill(body.text, template, values)}</p>` : ""}
          ${footer?.text ? `<p class="wa-bubble-footer">${esc(footer.text)}</p>` : ""}
          <span class="wa-bubble-time">agora ✓✓</span>
        </div>
        ${buttons.length ? `<div class="wa-buttons">${buttons.map((button) => `<span>${esc(button.text || button.type)}</span>`).join("")}</div>` : ""}
      </div>
    </div>`;
  }

  // ---------------------------------------------- Modo individual
  function individualMarkup() {
    const template = S.individual.template;
    const phone = normalizePhone(S.individual.phone);
    const phoneState = !S.individual.phone ? "" : phone ? "ok" : "error";
    return `
      <div class="wa-section">
        <h3>Número de atendimento</h3>
        ${numbersMarkup()}
      </div>
      <div class="wa-section wa-grid-2">
        <label class="wa-field"><span>Nome do contato</span><input data-wa-ind="name" maxlength="160" value="${esc(S.individual.name)}" placeholder="Ex.: Ana Souza" autocomplete="off"></label>
        <label class="wa-field ${phoneState}"><span>Telefone com DDD</span><input data-wa-ind="phone" inputmode="tel" value="${esc(S.individual.phone)}" placeholder="(11) 90000-0000" autocomplete="off">
          <small>${phoneState === "error" ? "Telefone inválido — informe DDD + número." : phone ? `Será enviado para ${esc(formatPhone(phone))}` : "O código do Brasil (+55) é incluído automaticamente."}</small>
        </label>
      </div>
      <div id="wa-ind-existing">${existingContactMarkup()}</div>
      <div class="wa-section">
        <h3>Template aprovado</h3>
        ${templateFiltersMarkup()}
        ${templateCardsMarkup(tplKey(template), "data-wa-ind-template")}
      </div>
      ${template?.variables?.length ? `<div class="wa-section"><h3>Variáveis</h3><div class="wa-grid-2">${template.variables.map((variable) => `
        <label class="wa-field"><span>${esc(variable.label)}</span><input data-wa-ind-var="${esc(variable.key)}" value="${esc(S.individual.values[variable.key] ?? "")}" placeholder="${esc(variable.example || "Digite o valor")}"></label>`).join("")}</div></div>` : ""}`;
  }
  function existingContactMarkup() {
    const found = S.individual.existing;
    if (!found) return "";
    return `<div class="wa-existing"><span>✓ Contato já cadastrado</span><b>${esc(found.name || "Sem nome")}</b><small>${esc(found.phoneLabel)} • ${esc(found.category?.name || "Sem categoria")} • última conversa ${esc(shortDate(found.lastConversationAt))}</small>
      <button type="button" data-wa-use-existing>Usar este contato</button></div>`;
  }
  let lookupTimer = null;
  function lookupExisting() {
    clearTimeout(lookupTimer);
    const phone = normalizePhone(S.individual.phone);
    S.individual.existing = null;
    el("wa-ind-existing").innerHTML = "";
    if (!phone) return;
    lookupTimer = setTimeout(async () => {
      try {
        const result = await api(`/api/outbound/contacts?${new URLSearchParams({ q: phone.slice(-8), limit: "5" })}`);
        const match = result.contacts.find((contact) => dedupeKey(contact.phone) === dedupeKey(phone));
        S.individual.existing = match || null;
        el("wa-ind-existing").innerHTML = existingContactMarkup();
      } catch (_error) { /* busca é auxiliar — nunca bloqueia o envio */ }
    }, 350);
  }

  // ---------------------------------------------- Modo em massa
  function bulkStepMarkup() {
    if (S.batch) return batchMarkup();
    return [originStep, contactsStep, templatesStep, variablesStep, reviewStep][S.step]();
  }

  function originStep() {
    return `
      <div class="wa-section">
        <h3>1. Origem do envio</h3>
        <p class="wa-help">Escolha o número WhatsApp que aparecerá como remetente. Números desconectados ou sem permissão não podem ser usados.</p>
        ${numbersMarkup()}
      </div>
      <div class="wa-section">
        <label class="wa-field"><span>Nome do envio (histórico)</span><input data-wa-batch-name maxlength="160" value="${esc(S.batchName)}" placeholder="Ex.: Contato Comercial — ${esc(new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(new Date()))}"></label>
      </div>`;
  }

  function contactsStep() {
    const tabs = [["manual", "Vários contatos"], ["paste", "Colar números"], ["csv", "Importar arquivo"], ["central", "Contatos da Central"]];
    const content = { manual: manualTab, paste: pasteTab, csv: csvTab, central: centralTab }[S.contactsTab]();
    return `
      <div class="wa-section">
        <h3>2. Destinatários</h3>
        <div class="wa-tabs" role="tablist">${tabs.map(([id, label]) => `<button type="button" role="tab" aria-selected="${S.contactsTab === id}" class="${S.contactsTab === id ? "active" : ""}" data-wa-tab="${id}">${label}</button>`).join("")}</div>
        <div class="wa-tab-body">${content}</div>
      </div>
      <div class="wa-section">${recipientsTableMarkup({ withTemplate: false })}</div>`;
  }

  function manualTab() {
    return `<form class="wa-inline-form" data-wa-manual-form>
      <label class="wa-field"><span>Nome</span><input name="name" maxlength="160" placeholder="Ana"></label>
      <label class="wa-field"><span>Telefone</span><input name="phone" inputmode="tel" placeholder="(11) 99999-9999" required></label>
      <button type="submit" class="wa-btn">+ Adicionar contato</button>
    </form>`;
  }

  function pasteTab() {
    const result = S.paste;
    return `<label class="wa-field"><span>Um contato por linha — “telefone” ou “nome;telefone”</span>
      <textarea data-wa-paste rows="6" placeholder="11999999999&#10;Ana;11988888888&#10;Carlos;(21) 97777-7777"></textarea></label>
      <div class="wa-row"><button type="button" class="wa-btn ghost" data-wa-paste-parse>Analisar números</button>
      ${result ? `<span class="wa-pill ok">${result.summary.valid} válidos</span><span class="wa-pill warn">${result.summary.duplicates} duplicados</span><span class="wa-pill err">${result.summary.invalid} inválidos</span>
        <button type="button" class="wa-btn" data-wa-paste-add ${result.summary.valid ? "" : "disabled"}>Adicionar ${result.summary.valid} válidos</button>` : ""}</div>
      ${result?.invalid?.length ? `<details class="wa-details"><summary>Ver inválidos</summary><ul>${result.invalid.slice(0, 50).map((row) => `<li>Linha ${row.line}: ${esc(row.raw)} — ${esc(row.reason)}</li>`).join("")}</ul></details>` : ""}`;
  }

  function csvTab() {
    const csv = S.csv;
    const fields = [["name", "Nome"], ["phone", "Telefone *"], ["email", "E-mail (opcional)"], ["template", "Template (opcional)"]];
    return `<label class="wa-field"><span>Arquivo CSV (separado por vírgula ou ponto e vírgula, até 5 MB)</span><input type="file" accept=".csv,text/csv" data-wa-csv-file></label>
      <p class="wa-help">XLSX: salve a planilha como CSV no Excel/Google Planilhas. Nada é enviado ao importar — tudo passa pela revisão.</p>
      ${csv ? `<div class="wa-mapping">${fields.map(([field, label]) => `<label class="wa-field"><span>${label}</span><select data-wa-csv-map="${field}"><option value="">—</option>${csv.headers.map((header, index) => `<option value="${index}" ${csv.mapping[field] === String(index) ? "selected" : ""}>Coluna ${String.fromCharCode(65 + (index % 26))} — ${esc(header || "(sem título)")}</option>`).join("")}</select></label>`).join("")}</div>
        <p class="wa-help">${esc(csv.fileName)} • ${csv.rows.length} linha(s). Prévia: ${csv.rows.slice(0, 3).map((row) => esc(row.join(" | "))).join(" • ")}</p>
        <button type="button" class="wa-btn" data-wa-csv-add ${csv.mapping.phone ? "" : "disabled"}>Adicionar contatos do arquivo</button>` : ""}`;
  }

  function centralTab() {
    const c = S.central;
    const f = c.filters;
    const options = c.options || { categories: [], users: [] };
    const allOnPage = c.rows.length && c.rows.every((row) => c.selected.has(row.contactId) || row.optedOut);
    return `<div class="wa-filters">
        <input type="search" data-wa-cfilter="q" value="${esc(f.q || "")}" placeholder="Nome ou telefone" aria-label="Buscar contato">
        <select data-wa-cfilter="conversed" aria-label="Conversa"><option value="">Qualquer contato</option><option value="yes" ${f.conversed === "yes" ? "selected" : ""}>Já conversaram conosco</option><option value="no" ${f.conversed === "no" ? "selected" : ""}>Nunca responderam</option></select>
        <select data-wa-cfilter="period" aria-label="Período"><option value="">Qualquer período</option><option value="7" ${f.period === "7" ? "selected" : ""}>Últimos 7 dias</option><option value="30" ${f.period === "30" ? "selected" : ""}>Últimos 30 dias</option><option value="90" ${f.period === "90" ? "selected" : ""}>Últimos 90 dias</option><option value="custom" ${f.period === "custom" ? "selected" : ""}>Personalizado</option></select>
        ${f.period === "custom" ? `<input type="date" data-wa-cfilter="from" value="${esc(f.from || "")}" aria-label="De"><input type="date" data-wa-cfilter="to" value="${esc(f.to || "")}" aria-label="Até">` : ""}
        <select data-wa-cfilter="categoryId" aria-label="Categoria"><option value="">Todas as categorias</option><option value="none" ${f.categoryId === "none" ? "selected" : ""}>Sem categoria</option>${options.categories.map((item) => `<option value="${esc(item.id)}" ${f.categoryId === item.id ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select>
        <select data-wa-cfilter="assignedUserId" aria-label="Responsável"><option value="">Qualquer responsável</option><option value="none" ${f.assignedUserId === "none" ? "selected" : ""}>Sem responsável</option>${options.users.map((item) => `<option value="${esc(item.id)}" ${f.assignedUserId === item.id ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select>
        <select data-wa-cfilter="channelAccountId" aria-label="Canal"><option value="">Todos os números</option>${S.numbers.map((item) => `<option value="${esc(item.id)}" ${f.channelAccountId === item.id ? "selected" : ""}>${esc(item.name)}</option>`).join("")}</select>
        <select data-wa-cfilter="origin" aria-label="Origem"><option value="">Qualquer origem</option><option value="ORGANIC" ${f.origin === "ORGANIC" ? "selected" : ""}>Cliente iniciou</option><option value="CAMPAIGN" ${f.origin === "CAMPAIGN" ? "selected" : ""}>Veio de campanha</option></select>
      </div>
      <div class="wa-row">
        <span class="wa-help">${c.loading ? "Carregando…" : `${c.total} contato(s) encontrados • ${c.selected.size} marcados`}</span>
        <button type="button" class="wa-btn ghost" data-wa-central-page ${allOnPage ? "disabled" : ""}>Selecionar página</button>
        <button type="button" class="wa-btn ghost" data-wa-central-all ${c.total ? "" : "disabled"}>Selecionar todos os resultados (${c.total})</button>
        <button type="button" class="wa-btn" data-wa-central-add ${c.selected.size ? "" : "disabled"}>Adicionar ${c.selected.size} ao envio</button>
      </div>
      <div class="wa-table-wrap"><table class="wa-table"><thead><tr><th></th><th>Nome</th><th>Telefone</th><th>Última conversa</th><th>Canal</th><th>Responsável</th><th>Categoria</th></tr></thead><tbody>
        ${c.rows.map((row) => `<tr class="${row.optedOut ? "blocked" : ""}">
          <td><input type="checkbox" data-wa-central-row="${esc(row.contactId)}" ${c.selected.has(row.contactId) ? "checked" : ""} ${row.optedOut ? "disabled title=\"Contato pediu para não receber mensagens\"" : ""} aria-label="Selecionar ${esc(row.name)}"></td>
          <td>${esc(row.name || "Nome ausente")}${row.optedOut ? ` <span class="wa-pill err">opt-out</span>` : ""}</td><td>${esc(row.phoneLabel)}</td><td>${esc(shortDate(row.lastConversationAt))}</td>
          <td>${esc(row.channel)}</td><td>${esc(row.assignedUser?.name || "—")}</td><td>${row.category ? `<span class="wa-cat" style="--cat:${esc(row.category.color || "#888")}">${esc(row.category.name)}</span>` : "—"}</td></tr>`).join("") || `<tr><td colspan="7" class="wa-empty">Nenhum contato encontrado com esses filtros.</td></tr>`}
      </tbody></table></div>
      ${c.total > c.rows.length ? `<div class="wa-row wa-pager"><button type="button" class="wa-btn ghost" data-wa-central-prev ${c.page <= 1 ? "disabled" : ""}>←</button><span>Página ${c.page} de ${Math.ceil(c.total / 50)}</span><button type="button" class="wa-btn ghost" data-wa-central-next ${c.page * 50 >= c.total ? "disabled" : ""}>→</button></div>` : ""}`;
  }

  function groupsOf() {
    return [...new Set(S.recipients.map((recipient) => recipient.group))];
  }
  function visibleRecipients() {
    const q = S.recipientFilter.trim().toLocaleLowerCase("pt-BR");
    return S.recipients.filter((recipient) => (!S.recipientGroup || recipient.group === S.recipientGroup)
      && (!q || `${recipient.name} ${recipient.phone}`.toLocaleLowerCase("pt-BR").includes(q)));
  }
  function recipientsTableMarkup({ withTemplate }) {
    if (!S.recipients.length) return `<div class="wa-empty">Nenhum destinatário adicionado ainda.</div>`;
    const rows = visibleRecipients();
    const selectedCount = S.recipients.filter((recipient) => recipient.selected).length;
    const shown = rows.slice(0, 300);
    const templateOptions = (selectedKey) => `<option value="">${S.defaultTemplateKey ? "Padrão" : "Escolha…"}</option>${S.templates.filter((template) => template.supported !== false).map((template) => `<option value="${esc(tplKey(template))}" ${tplKey(template) === selectedKey ? "selected" : ""}>${esc(template.name)}</option>`).join("")}`;
    return `<div class="wa-selected-head">
        <h3>Selecionados <span class="wa-count">${S.recipients.length}</span></h3>
        <input type="search" data-wa-rfilter value="${esc(S.recipientFilter)}" placeholder="Filtrar lista" aria-label="Filtrar destinatários">
        <select data-wa-rgroup aria-label="Grupo"><option value="">Todos os grupos</option>${groupsOf().map((group) => `<option ${group === S.recipientGroup ? "selected" : ""}>${esc(group)}</option>`).join("")}</select>
      </div>
      <div class="wa-row wa-bulk-actions">
        <label class="wa-check"><input type="checkbox" data-wa-select-visible ${rows.length && rows.every((recipient) => recipient.selected) ? "checked" : ""}> Selecionar ${rows.length} visíveis</label>
        <span class="wa-help">${selectedCount} marcado(s)</span>
        ${withTemplate ? `<select data-wa-bulk-template aria-label="Definir template"><option value="">Definir template para marcados…</option>${S.templates.filter((template) => template.supported !== false).map((template) => `<option value="${esc(tplKey(template))}">${esc(template.name)} (${esc(template.category)})</option>`).join("")}</select>` : ""}
        <button type="button" class="wa-btn ghost danger" data-wa-remove-selected ${selectedCount ? "" : "disabled"}>Remover marcados</button>
      </div>
      <div class="wa-table-wrap"><table class="wa-table"><thead><tr><th></th><th>Nome</th><th>Telefone</th><th>Grupo</th>${withTemplate ? "<th>Template</th>" : ""}<th></th></tr></thead><tbody>
      ${shown.map((recipient) => `<tr class="${recipient.selected ? "selected" : ""}">
        <td><input type="checkbox" data-wa-rsel="${esc(recipient.key)}" ${recipient.selected ? "checked" : ""} aria-label="Marcar ${esc(recipient.name || recipient.phone)}"></td>
        <td><input class="wa-cell" data-wa-rname="${esc(recipient.key)}" value="${esc(recipient.name)}" placeholder="Nome ausente" aria-label="Nome"></td>
        <td>${esc(formatPhone(recipient.phone))}${recipient.contactId ? ` <span class="wa-pill ok" title="Contato já cadastrado na Central">Central</span>` : ""}</td>
        <td><small>${esc(recipient.group)}</small></td>
        ${withTemplate ? `<td><select data-wa-rtemplate="${esc(recipient.key)}" aria-label="Template">${templateOptions(recipient.templateKey)}</select></td>` : ""}
        <td><button type="button" class="wa-icon" data-wa-remove="${esc(recipient.key)}" aria-label="Remover">×</button></td>
      </tr>`).join("")}
      </tbody></table></div>${rows.length > shown.length ? `<p class="wa-help">Mostrando 300 de ${rows.length}. Use o filtro/grupo para encontrar os demais.</p>` : ""}`;
  }

  function templatesStep() {
    const without = S.recipients.filter((recipient) => !recipient.templateKey).length;
    return `
      <div class="wa-section">
        <h3>3. Templates</h3>
        <p class="wa-help">Escolha um template padrão e, se quiser, defina templates diferentes para grupos ou contatos específicos (marque na lista e use “Definir template”).</p>
        ${templateFiltersMarkup()}
        ${templateCardsMarkup(S.defaultTemplateKey, "data-wa-default-template")}
        ${S.defaultTemplateKey ? `<div class="wa-row"><span class="wa-help">Padrão: <b>${esc(templateByKey(S.defaultTemplateKey)?.name)}</b> — vale para ${without} contato(s) sem template próprio.</span>
          <button type="button" class="wa-btn ghost" data-wa-apply-all>Aplicar a todos (${S.recipients.length})</button></div>` : ""}
      </div>
      <div class="wa-section">${recipientsTableMarkup({ withTemplate: true })}</div>`;
  }

  function usedTemplates() {
    const keys = new Set(S.recipients.map((recipient) => recipient.templateKey || S.defaultTemplateKey).filter(Boolean));
    return [...keys].map(templateByKey).filter(Boolean);
  }

  function variablesStep() {
    const templates = usedTemplates();
    if (!templates.length) return `<div class="wa-section"><h3>4. Personalização</h3><div class="wa-empty">Defina ao menos um template na etapa anterior.</div></div>`;
    return `<div class="wa-section"><h3>4. Personalização</h3><p class="wa-help">As variáveis são lidas do template. Nome do contato é preenchido individualmente; seu nome é igual para todos.</p></div>
      ${templates.map((template) => {
        const mapping = mappingFor(template);
        const users = S.recipients.filter((recipient) => (recipient.templateKey || S.defaultTemplateKey) === tplKey(template));
        const variables = template.variables || [];
        return `<div class="wa-section wa-var-card">
          <div class="wa-var-head"><b>${esc(template.name)}</b><span>${users.length} contato(s)</span></div>
          ${variables.length ? variables.map((variable) => {
            const rule = mapping[variable.key];
            return `<div class="wa-var-row">
              <div><b>{{${esc(variable.placeholder)}}}</b><small>${esc(variable.label)}${variable.example ? ` • exemplo: ${esc(variable.example)}` : ""}</small></div>
              <select data-wa-map="${esc(tplKey(template))}" data-wa-map-var="${esc(variable.key)}" aria-label="Fonte">${Object.entries(SOURCES).map(([source, label]) => `<option value="${source}" ${rule.source === source ? "selected" : ""}>${label}</option>`).join("")}</select>
              ${rule.source === "STATIC" ? `<input data-wa-map-value="${esc(tplKey(template))}" data-wa-map-var="${esc(variable.key)}" value="${esc(rule.value)}" placeholder="Valor para todos">` : ""}
              ${NAME_SOURCES.includes(rule.source) ? `<input data-wa-map-fallback="${esc(tplKey(template))}" data-wa-map-var="${esc(variable.key)}" value="${esc(rule.fallback)}" placeholder="Se nome ausente, usar… (ex.: cliente)">` : ""}
            </div>`;
          }).join("") : `<p class="wa-help">Este template não tem variáveis.</p>`}
          ${variables.length ? sampleTableMarkup(template, users) : ""}
        </div>`;
      }).join("")}`;
  }

  function sampleTableMarkup(template, users) {
    const mapping = mappingFor(template);
    const variables = template.variables || [];
    const manual = variables.filter((variable) => mapping[variable.key].source === "MANUAL");
    const rows = (manual.length ? users : users.slice(0, 5));
    return `<div class="wa-table-wrap"><table class="wa-table"><thead><tr><th>Contato</th>${variables.map((variable) => `<th>{{${esc(variable.placeholder)}}}</th>`).join("")}</tr></thead><tbody>
      ${rows.slice(0, 200).map((recipient) => `<tr><td>${esc(recipient.name || formatPhone(recipient.phone))}</td>${variables.map((variable) => {
        const rule = mapping[variable.key];
        const value = resolveValue(variable, rule, recipient);
        if (rule.source === "MANUAL") return `<td><input class="wa-cell ${value ? "" : "missing"}" data-wa-manual-value="${esc(recipient.key)}" data-wa-map-var="${esc(variable.key)}" value="${esc(recipient.values?.[variable.key] || "")}" placeholder="Obrigatório"></td>`;
        return `<td class="${value ? "" : "missing"}">${value ? esc(value) : NAME_SOURCES.includes(rule.source) ? "Nome ausente" : "Vazio"}</td>`;
      }).join("")}</tr>`).join("")}
    </tbody></table></div>${!manual.length && users.length > 5 ? `<p class="wa-help">Exemplo com 5 de ${users.length}. Nomes ausentes aparecem na revisão.</p>` : ""}`;
  }

  // ----------------------------------------------------------- Revisão
  function payload(extra = {}) {
    return {
      accountId: S.accountId,
      name: S.batchName,
      defaultTemplate: S.defaultTemplateKey ? { name: templateByKey(S.defaultTemplateKey)?.name, language: templateByKey(S.defaultTemplateKey)?.language } : null,
      mappings: Object.fromEntries(Object.entries(S.mappings).map(([key, rules]) => [key, Object.fromEntries(Object.entries(rules).map(([variable, rule]) => [variable, { source: rule.source, value: rule.value, fallback: rule.fallback }]))])),
      recipients: S.recipients.map((recipient) => {
        const template = recipientTemplate(recipient);
        return {
          key: recipient.key, contactId: recipient.contactId || null, name: recipient.name, phone: recipient.phone,
          templateName: recipient.templateKey ? template?.name : null, templateLanguage: recipient.templateKey ? template?.language : null,
          values: recipient.values, useNameFallback: recipient.useNameFallback,
        };
      }),
      ...extra,
    };
  }

  async function refreshPreview() {
    S.previewing = true;
    render();
    try {
      S.preview = await api("/api/outbound/bulk/preview", { method: "POST", body: JSON.stringify(payload()) });
      S.previewKey = JSON.stringify(payload());
    } catch (error) {
      S.preview = null;
      toast(error.message, true);
    } finally {
      S.previewing = false;
      render();
    }
  }

  function reviewStep() {
    const preview = S.preview;
    if (S.previewing && !preview) return `<div class="wa-section"><div class="wa-empty">Validando destinatários, templates e variáveis no servidor…</div></div>`;
    if (!preview) return `<div class="wa-section"><h3>5. Revisão</h3><button type="button" class="wa-btn" data-wa-refresh-preview>Validar envio</button></div>`;
    const s = preview.summary;
    const labels = preview.issueLabels || {};
    const blocked = preview.recipients.filter((recipient) => !recipient.ok);
    const card = (label, value, tone = "") => `<div class="wa-kpi ${tone}"><small>${label}</small><b>${value}</b></div>`;
    return `
      <div class="wa-section">
        <div class="wa-row"><h3>5. Revisão do envio</h3>${S.previewing ? `<span class="wa-help">Atualizando…</span>` : `<button type="button" class="wa-btn ghost" data-wa-refresh-preview>Revalidar</button>`}</div>
        ${preview.senderError ? `<div class="wa-alert err">${esc(preview.senderError)}</div>` : ""}
        ${!preview.massMessagingEnabled ? `<div class="wa-alert warn">O envio em massa está desativado nas configurações de Campanhas. O lote será criado e ficará na fila até um Master ativar o envio.</div>` : ""}
        <div class="wa-kpis">
          ${card("Número", esc(preview.sender?.name || "Indisponível"))}
          ${card("Destinatários prontos", s.ready, "accent")}
          ${card("Templates", s.templates)}
          ${Object.entries(s.cost.byCategory).map(([category, entry]) => card(esc(category.charAt(0) + category.slice(1).toLowerCase()), `${entry.count} <small>${money(entry.cost)}</small>`)).join("")}
          ${card("Estimativa de custo", money(s.cost.total), "accent")}
          ${card("Inválidos", s.invalid, s.invalid ? "err" : "")}
          ${card("Duplicados", s.duplicates, s.duplicates ? "warn" : "")}
          ${card("Opt-out", s.optedOut, s.optedOut ? "warn" : "")}
          ${card("Sem variável obrigatória", s.missingVariables, s.missingVariables ? "err" : "")}
          ${card("Nome ausente", s.nameMissing, s.nameMissing ? "warn" : "")}
        </div>
        <p class="wa-help">${esc(s.cost.disclaimer)}</p>
      </div>
      ${blocked.length ? `<div class="wa-section"><h3>Não serão enviados (${blocked.length})</h3>
        <p class="wa-help">Os demais destinatários válidos continuam. Corrija ou remova os itens abaixo.</p>
        <div class="wa-table-wrap"><table class="wa-table"><thead><tr><th>Contato</th><th>Telefone</th><th>Template</th><th>Motivo</th><th>Ações</th></tr></thead><tbody>
        ${blocked.slice(0, 300).map((row) => `<tr><td>${esc(row.name || "Nome ausente")}</td><td>${esc(row.phone ? formatPhone(row.phone) : row.rawPhone)}</td><td>${esc(row.template?.name || "—")}</td>
          <td>${row.issues.map((issue) => `<span class="wa-pill ${["DUPLICATE", "OPTED_OUT", "NAME_MISSING"].includes(issue) ? "warn" : "err"}">${esc(labels[issue] || issue)}</span>`).join(" ")}</td>
          <td class="wa-actions">${row.issues.includes("NAME_MISSING") ? `<input class="wa-cell" data-wa-fix-name="${esc(row.key)}" placeholder="Digite o nome"><button type="button" class="wa-btn ghost" data-wa-no-name="${esc(row.key)}">Usar sem nome</button>` : ""}
          <button type="button" class="wa-icon" data-wa-remove="${esc(row.key)}" aria-label="Remover">×</button></td></tr>`).join("")}
        </tbody></table></div></div>` : ""}`;
  }

  // ------------------------------------------------------ Acompanhamento
  function batchMarkup() {
    const batch = S.batch;
    const total = batch.total || 0;
    const done = (batch.sent || 0) + (batch.failed || 0) + (batch.counts?.OPTED_OUT || 0) + (batch.counts?.SKIPPED || 0);
    const pct = total ? Math.round((done / total) * 100) : 0;
    const count = (status) => batch.counts?.[status] || 0;
    return `<div class="wa-section">
        <h3>${esc(batch.name)}</h3>
        <p class="wa-help">Número ${esc(batch.sender)} • criado por ${esc(batch.createdBy?.name || "")} • ${esc(shortDate(batch.createdAt))}</p>
        ${!batch.massMessagingEnabled ? `<div class="wa-alert warn">Envio em massa desativado nas configurações: o lote está salvo na fila e começa assim que um Master ativar.</div>` : ""}
        <div class="wa-bar"><i style="width:${pct}%"></i></div>
        <div class="wa-kpis">
          ${[["QUEUED", "Na fila"], ["SENDING", "Enviando"], ["SENT", "Enviado"], ["DELIVERED", "Entregue"], ["READ", "Lido"], ["REPLIED", "Respondeu"], ["FAILED", "Falhou"], ["OPTED_OUT", "Opt-out"]]
            .map(([status, label]) => `<div class="wa-kpi ${status === "FAILED" && count(status) ? "err" : ""}"><small>${label}</small><b>${count(status)}</b></div>`).join("")}
        </div>
      </div>
      <div class="wa-section"><div class="wa-table-wrap"><table class="wa-table"><thead><tr><th>Contato</th><th>Telefone</th><th>Template</th><th>Status</th><th>Detalhe</th></tr></thead><tbody>
        ${(batch.recipients || []).map((row) => `<tr><td>${esc(row.fullName || "—")}</td><td>${esc(row.phoneLabel)}</td><td>${esc(row.templateName || "—")}</td>
          <td><span class="wa-status s-${esc(row.status)}">${esc(STATUS_LABELS[row.status] || row.status)}</span></td><td><small>${esc(row.failureReason || "")}</small></td></tr>`).join("")}
      </tbody></table></div></div>`;
  }

  async function pollBatch() {
    try {
      S.batch = await api(`/api/outbound/bulk/${encodeURIComponent(S.batch.id)}`);
      if (el("wa-send-dialog").open) render();
      const pending = (S.batch.counts?.QUEUED || 0) + (S.batch.counts?.SENDING || 0) + (S.batch.counts?.PENDING || 0);
      if (!pending && S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
    } catch (_error) { /* tenta de novo no próximo intervalo */ }
  }

  // ------------------------------------------------------------ Lateral
  function localCost() {
    const byCategory = {};
    let total = 0;
    for (const recipient of S.recipients) {
      const template = recipientTemplate(recipient);
      if (!template) continue;
      const category = template.category || "OUTRA";
      byCategory[category] ??= { count: 0, cost: 0 };
      byCategory[category].count += 1;
      const rate = Number(template.pricing?.rate);
      if (Number.isFinite(rate)) { byCategory[category].cost += rate; total += rate; }
    }
    return { byCategory, total };
  }
  function sideMarkup() {
    if (S.mode === "individual") {
      const template = S.individual.template;
      return `<div class="wa-side-title">Prévia</div>${whatsappPreviewMarkup(template, null)}
        ${template?.pricing ? `<div class="wa-cost"><small>Custo estimado</small><b>${money(template.pricing.rate, 4)}</b><p>Valor estimado. O valor real é definido pela Meta.</p></div>` : ""}`;
    }
    const focus = S.recipients.find((recipient) => recipient.selected) || S.recipients[0] || null;
    const template = focus ? recipientTemplate(focus) : templateByKey(S.defaultTemplateKey);
    const cost = localCost();
    return `<div class="wa-side-title">Prévia ${focus ? `— ${esc(focus.name || formatPhone(focus.phone))}` : ""}</div>${whatsappPreviewMarkup(template, focus)}
      <div class="wa-cost">
        <div class="wa-cost-line"><span>Contatos selecionados</span><b>${S.recipients.length}</b></div>
        ${Object.entries(cost.byCategory).map(([category, entry]) => `<div class="wa-cost-line"><span>${esc(category.charAt(0) + category.slice(1).toLowerCase())}</span><b>${entry.count}</b></div>`).join("")}
        <div class="wa-cost-line total"><span>Custo estimado</span><b>${money(cost.total)}</b></div>
        <p>Valor estimado. O valor real é definido pela Meta.</p>
      </div>`;
  }

  // ------------------------------------------------------------- Rodapé
  function footerMarkup() {
    if (S.mode === "individual") {
      const ready = S.accountId && normalizePhone(S.individual.phone) && S.individual.name.trim() && S.individual.template
        && (S.individual.template.variables || []).every((variable) => String(S.individual.values[variable.key] || "").trim());
      return `<span class="wa-help">O contato recebe o template imediatamente pelo número escolhido.</span>
        <button type="button" class="wa-btn primary" data-wa-send-individual ${ready ? "" : "disabled"}>Enviar pelo WhatsApp</button>`;
    }
    if (S.batch) return `<button type="button" class="wa-btn ghost" data-wa-open-campaigns>Ver em Campanhas</button><button type="button" class="wa-btn primary" data-wa-close>Concluir</button>`;
    const canNext = [
      () => Boolean(S.accountId && currentNumber()?.available),
      () => S.recipients.length > 0,
      () => S.recipients.length > 0 && S.recipients.every((recipient) => recipient.templateKey || S.defaultTemplateKey),
      () => true,
      () => Boolean(S.preview?.summary?.ready) && !S.previewing,
    ][S.step]();
    const nextLabel = S.step === 3 ? "Revisar" : S.step === 4 ? `Revisar e enviar (${S.preview?.summary?.ready || 0})` : "Continuar";
    return `<button type="button" class="wa-btn ghost" data-wa-back ${S.step === 0 ? "disabled" : ""}>Voltar</button>
      <span class="wa-help">${S.step === 2 && !canNext ? "Todos os contatos precisam de um template." : ""}</span>
      <button type="button" class="wa-btn primary" data-wa-next ${canNext ? "" : "disabled"}>${nextLabel}</button>`;
  }

  function confirmMarkup() {
    const s = S.preview.summary;
    return `<div class="wa-confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="wa-confirm-title">
      <h3 id="wa-confirm-title">Confirmar envio</h3>
      <p>Você está prestes a enviar <b>${s.ready} mensagem(ns)</b>.</p>
      <dl><dt>Número</dt><dd>${esc(S.preview.sender?.name)}</dd><dt>Templates</dt><dd>${s.templates}</dd><dt>Estimativa</dt><dd>${money(s.cost.total)}</dd>${s.blocked ? `<dt>Não enviados</dt><dd>${s.blocked}</dd>` : ""}</dl>
      <p class="wa-help">${esc(s.cost.disclaimer)} O envio é feito em lotes pela fila, respeitando os limites da Meta.</p>
      <div class="wa-row end"><button type="button" class="wa-btn ghost" data-wa-confirm-cancel>Cancelar</button><button type="button" class="wa-btn primary" data-wa-confirm-send>Confirmar envio</button></div>
    </div>`;
  }

  // ----------------------------------------------------------- Ações
  function addRecipients(list, group) {
    const seen = new Set(S.recipients.map((recipient) => dedupeKey(recipient.phone)));
    let added = 0;
    let duplicates = 0;
    let invalid = 0;
    for (const item of list) {
      const phone = normalizePhone(item.phone);
      if (!phone) { invalid += 1; continue; }
      const key = dedupeKey(phone);
      if (seen.has(key)) { duplicates += 1; continue; }
      seen.add(key);
      S.recipients.push({ key: newKey(), name: String(item.name || "").trim(), phone, contactId: item.contactId || null, templateKey: item.templateKey || "", values: {}, useNameFallback: false, group, selected: false });
      added += 1;
    }
    S.preview = null;
    toast(`${added} adicionado(s)${duplicates ? ` • ${duplicates} já estavam na lista` : ""}${invalid ? ` • ${invalid} inválido(s)` : ""}.`, !added);
  }

  async function loadNumbers() {
    S.numbers = await api("/api/outbound/meta/numbers");
    const firstAvailable = S.numbers.find((number) => number.available);
    if (!S.accountId || !S.numbers.some((number) => number.id === S.accountId && number.available)) S.accountId = firstAvailable?.id || null;
  }
  async function loadTemplates() {
    if (!S.accountId) { S.templates = []; return; }
    S.templatesLoading = true;
    render();
    try { S.templates = await api(`/api/outbound/meta/templates?accountId=${encodeURIComponent(S.accountId)}`); }
    catch (error) { S.templates = []; toast(error.message, true); }
    finally { S.templatesLoading = false; render(); }
  }
  let centralTimer = null;
  function loadCentral(delay = 0) {
    clearTimeout(centralTimer);
    centralTimer = setTimeout(async () => {
      S.central.loading = true;
      render();
      try {
        if (!S.central.options) S.central.options = await api("/api/outbound/contacts/filters");
        const params = new URLSearchParams(Object.fromEntries(Object.entries({ ...S.central.filters, page: S.central.page, limit: 50 }).filter(([, value]) => value !== "" && value !== undefined)));
        const result = await api(`/api/outbound/contacts?${params}`);
        S.central.rows = result.contacts;
        S.central.total = result.total;
      } catch (error) { toast(error.message, true); }
      finally { S.central.loading = false; render(); }
    }, delay);
  }
  function centralGroupLabel() {
    const f = S.central.filters;
    const parts = [];
    if (f.conversed === "yes") parts.push("já conversaram");
    if (f.period) parts.push(f.period === "custom" ? "período" : `${f.period} dias`);
    const category = S.central.options?.categories.find((item) => item.id === f.categoryId);
    if (category) parts.push(category.name);
    return `Central${parts.length ? `: ${parts.join(", ")}` : ""}`;
  }

  async function sendIndividual(button) {
    button.disabled = true;
    try {
      const template = S.individual.template;
      const result = await api("/api/conversations/outbound", { method: "POST", body: JSON.stringify({
        accountId: S.accountId, phone: S.individual.phone, customName: S.individual.name.trim(),
        template: { name: template.name, language: template.language, values: S.individual.values },
      }) });
      el("wa-send-dialog").close();
      toast("Conversa iniciada pelo WhatsApp.");
      await loadConversations();
      await openConversation(result.conversationId);
    } catch (error) { toast(error.message, true); button.disabled = false; }
  }

  async function confirmSend(button) {
    button.disabled = true;
    try {
      const result = await api("/api/outbound/bulk", { method: "POST", body: JSON.stringify(payload({ idempotencyKey: S.idempotencyKey, confirmedCount: S.preview.summary.ready })) });
      el("wa-send-dialog").querySelector(".wa-confirm").hidden = true;
      toast(result.duplicateRequest ? "Este envio já havia sido criado." : `${result.queued} mensagem(ns) na fila de envio.`);
      S.batch = { id: result.campaignId };
      await pollBatch();
      S.pollTimer = setInterval(pollBatch, 3000);
      render();
    } catch (error) {
      button.disabled = false;
      toast(error.message, true);
      if (error.code === "PREVIEW_CHANGED") { el("wa-send-dialog").querySelector(".wa-confirm").hidden = true; await refreshPreview(); }
    }
  }

  async function onClick(event) {
    const target = event.target.closest("button, [data-wa-close]");
    if (!target || target.disabled) return;
    const d = target.dataset;
    const dialog = el("wa-send-dialog");
    if (d.waClose !== undefined) { dialog.close(); return; }
    if (d.waMode) { S.mode = d.waMode; render(); return; }
    if (d.waNumber) { S.accountId = d.waNumber; S.preview = null; render(); await loadTemplates(); return; }
    if (d.waIndTemplate) {
      const template = templateByKey(d.waIndTemplate);
      S.individual.template = template;
      S.individual.values = Object.fromEntries((template.variables || []).map((variable) => {
        const source = suggestSource(variable);
        const value = source === "CONTACT_NAME" ? S.individual.name.trim() : source === "FIRST_NAME" ? firstName(S.individual.name) : source === "AGENT_NAME" ? state.currentUser?.name || "" : "";
        return [variable.key, value];
      }));
      render();
      return;
    }
    if (d.waUseExisting !== undefined) {
      const found = S.individual.existing;
      S.individual.name = found.name || S.individual.name;
      S.individual.phone = maskTyping(found.phone);
      render();
      return;
    }
    if (d.waSendIndividual !== undefined) return sendIndividual(target);
    if (d.waGoto !== undefined) { S.step = Number(d.waGoto); render(); return; }
    if (d.waBack !== undefined) { S.step = Math.max(0, S.step - 1); render(); return; }
    if (d.waNext !== undefined) {
      if (S.step === 4) {
        if (S.previewKey !== JSON.stringify(payload())) { await refreshPreview(); return; }
        const confirm = dialog.querySelector(".wa-confirm");
        confirm.innerHTML = confirmMarkup();
        confirm.hidden = false;
        return;
      }
      S.step += 1;
      if (S.step === 1 && S.contactsTab === "central" && !S.central.rows.length) loadCentral();
      render();
      if (S.step === 4) await refreshPreview();
      return;
    }
    if (d.waConfirmCancel !== undefined) { dialog.querySelector(".wa-confirm").hidden = true; return; }
    if (d.waConfirmSend !== undefined) return confirmSend(target);
    if (d.waRefreshPreview !== undefined) return refreshPreview();
    if (d.waOpenCampaigns !== undefined) { location.href = "/campaigns"; return; }
    if (d.waTab) { S.contactsTab = d.waTab; if (d.waTab === "central" && !S.central.rows.length) loadCentral(); render(); return; }
    if (d.waPasteParse !== undefined) {
      try { S.paste = await api("/api/outbound/phones/parse", { method: "POST", body: JSON.stringify({ text: dialog.querySelector("[data-wa-paste]").value }) }); render(); }
      catch (error) { toast(error.message, true); }
      return;
    }
    if (d.waPasteAdd !== undefined) { addRecipients(S.paste.valid, "Números colados"); S.paste = null; render(); return; }
    if (d.waCsvAdd !== undefined) {
      const { rows, mapping, fileName } = S.csv;
      const col = (row, field) => mapping[field] === "" || mapping[field] === undefined ? "" : String(row[Number(mapping[field])] ?? "").trim();
      addRecipients(rows.map((row) => {
        const templateName = col(row, "template");
        const template = templateName ? S.templates.find((item) => item.name === templateName) : null;
        return { name: col(row, "name"), phone: col(row, "phone"), templateKey: template ? tplKey(template) : "" };
      }), `Arquivo: ${fileName}`);
      S.csv = null;
      render();
      return;
    }
    if (d.waCentralPage !== undefined) { S.central.rows.forEach((row) => { if (!row.optedOut) S.central.selected.add(row.contactId); }); render(); return; }
    if (d.waCentralAll !== undefined) {
      if (S.central.total > LARGE_SELECTION && !window.confirm(`Selecionar todos os ${S.central.total} contatos deste filtro?`)) return;
      try {
        const result = await api("/api/outbound/contacts/select-all", { method: "POST", body: JSON.stringify(S.central.filters) });
        addRecipients(result.contacts, centralGroupLabel());
        if (result.truncated) toast(`Limite por envio: ${result.limit} contatos adicionados de ${result.total}.`, true);
        S.central.selected.clear();
        render();
      } catch (error) { toast(error.message, true); }
      return;
    }
    if (d.waCentralAdd !== undefined) {
      const byId = new Map(S.central.rows.map((row) => [row.contactId, row]));
      const chosen = [...S.central.selected].map((id) => byId.get(id)).filter(Boolean);
      addRecipients(chosen.map((row) => ({ name: row.name, phone: row.phone, contactId: row.contactId })), centralGroupLabel());
      S.central.selected.clear();
      render();
      return;
    }
    if (d.waCentralPrev !== undefined) { S.central.page -= 1; loadCentral(); return; }
    if (d.waCentralNext !== undefined) { S.central.page += 1; loadCentral(); return; }
    if (d.waRemove) { S.recipients = S.recipients.filter((recipient) => recipient.key !== d.waRemove); S.preview = null; if (S.step === 4) await refreshPreview(); else render(); return; }
    if (d.waRemoveSelected !== undefined) { S.recipients = S.recipients.filter((recipient) => !recipient.selected); S.preview = null; render(); return; }
    if (d.waDefaultTemplate) { S.defaultTemplateKey = d.waDefaultTemplate; S.preview = null; render(); return; }
    if (d.waApplyAll !== undefined) { S.recipients.forEach((recipient) => { recipient.templateKey = ""; }); S.preview = null; render(); return; }
    if (d.waNoName) {
      const recipient = S.recipients.find((item) => item.key === d.waNoName);
      if (recipient) recipient.useNameFallback = true;
      const needsFallback = usedTemplates().some((template) => Object.values(mappingFor(template)).some((rule) => NAME_SOURCES.includes(rule.source) && !String(rule.fallback || "").trim()));
      if (needsFallback) { toast("Defina na Personalização o texto usado quando o nome estiver ausente (ex.: “cliente”).", true); S.step = 3; render(); return; }
      await refreshPreview();
    }
  }

  function onInput(event) {
    const t = event.target;
    const d = t.dataset;
    if (d.waInd === "name") { S.individual.name = t.value; refreshSide(); return; }
    if (d.waInd === "phone") {
      const caret = t.value.length;
      S.individual.phone = /^\s*\+/.test(t.value) ? t.value : maskTyping(t.value);
      if (t.value.length === caret) t.value = S.individual.phone;
      const field = t.closest(".wa-field");
      const phone = normalizePhone(S.individual.phone);
      field.classList.toggle("ok", Boolean(phone));
      field.classList.toggle("error", Boolean(S.individual.phone) && !phone);
      field.querySelector("small").textContent = !S.individual.phone ? "O código do Brasil (+55) é incluído automaticamente." : phone ? `Será enviado para ${formatPhone(phone)}` : "Telefone inválido — informe DDD + número.";
      lookupExisting();
      refreshFooter();
      return;
    }
    if (d.waIndVar) { S.individual.values[d.waIndVar] = t.value; refreshSide(); refreshFooter(); return; }
    if (d.waTfilter === "q") { S.templateFilter.q = t.value; rerenderKeepingFocus(t); return; }
    if (d.waBatchName !== undefined) { S.batchName = t.value; return; }
    if (d.waCfilter === "q") { S.central.filters.q = t.value; S.central.page = 1; loadCentral(400); return; }
    if (d.waRfilter !== undefined) { S.recipientFilter = t.value; rerenderKeepingFocus(t); return; }
    if (d.waRname) { const recipient = S.recipients.find((item) => item.key === d.waRname); if (recipient) recipient.name = t.value; S.preview = null; refreshSide(); return; }
    if (d.waMapValue) { mappingFor(templateByKey(d.waMapValue))[d.waMapVar].value = t.value; S.preview = null; refreshSide(); return; }
    if (d.waMapFallback) { mappingFor(templateByKey(d.waMapFallback))[d.waMapVar].fallback = t.value; S.preview = null; return; }
    if (d.waManualValue) {
      const recipient = S.recipients.find((item) => item.key === d.waManualValue);
      if (recipient) { recipient.values = { ...recipient.values, [d.waMapVar]: t.value }; t.classList.toggle("missing", !t.value.trim()); }
      S.preview = null;
      refreshSide();
      return;
    }
    if (d.waFixName) { const recipient = S.recipients.find((item) => item.key === d.waFixName); if (recipient) recipient.name = t.value; }
  }

  async function onChange(event) {
    const t = event.target;
    const d = t.dataset;
    if (d.waTfilter && d.waTfilter !== "q") { S.templateFilter[d.waTfilter] = t.value; render(); return; }
    if (d.waCfilter && d.waCfilter !== "q") { S.central.filters[d.waCfilter] = t.value; S.central.page = 1; loadCentral(); return; }
    if (d.waCentralRow) { if (t.checked) S.central.selected.add(d.waCentralRow); else S.central.selected.delete(d.waCentralRow); render(); return; }
    if (d.waRgroup !== undefined) { S.recipientGroup = t.value; render(); return; }
    if (d.waSelectVisible !== undefined) { visibleRecipients().forEach((recipient) => { recipient.selected = t.checked; }); render(); return; }
    if (d.waRsel) { const recipient = S.recipients.find((item) => item.key === d.waRsel); if (recipient) recipient.selected = t.checked; render(); return; }
    if (d.waRtemplate) { const recipient = S.recipients.find((item) => item.key === d.waRtemplate); if (recipient) recipient.templateKey = t.value; S.preview = null; render(); return; }
    if (d.waBulkTemplate !== undefined && t.value) {
      const marked = S.recipients.filter((recipient) => recipient.selected);
      if (!marked.length) { toast("Marque os contatos que devem receber este template.", true); t.value = ""; return; }
      marked.forEach((recipient) => { recipient.templateKey = t.value; recipient.selected = false; });
      toast(`Template “${templateByKey(t.value)?.name}” definido para ${marked.length} contato(s).`);
      S.preview = null;
      render();
      return;
    }
    if (d.waMap) { mappingFor(templateByKey(d.waMap))[d.waMapVar].source = t.value; S.preview = null; render(); return; }
    if (d.waFixName) { S.preview = null; await refreshPreview(); return; }
    if (d.waCsvMap) { S.csv.mapping[d.waCsvMap] = t.value; render(); return; }
    if (d.waCsvFile !== undefined && t.files?.[0]) {
      const form = new FormData();
      form.append("file", t.files[0]);
      try {
        const result = await api("/api/outbound/import/csv", { method: "POST", body: form });
        const guess = (pattern) => { const index = result.headers.findIndex((header) => pattern.test(header)); return index >= 0 ? String(index) : ""; };
        S.csv = { ...result, mapping: { name: guess(/nome|name/i), phone: guess(/tel|fone|phone|celular|whats/i), email: guess(/mail/i), template: guess(/template|modelo/i) } };
        render();
      } catch (error) { toast(error.message, true); }
    }
  }

  function refreshSide() { el("wa-send-dialog").querySelector(".wa-side").innerHTML = sideMarkup(); }
  function refreshFooter() { el("wa-send-dialog").querySelector(".wa-foot").innerHTML = footerMarkup(); }
  function rerenderKeepingFocus(input) {
    const selector = Object.keys(input.dataset).map((key) => `[data-${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}${input.dataset[key] ? `="${input.dataset[key]}"` : ""}]`).join("");
    const position = input.selectionStart;
    render();
    const again = el("wa-send-dialog").querySelector(selector);
    if (again) { again.focus(); try { again.setSelectionRange(position, position); } catch (_error) { /* inputs sem seleção */ } }
  }

  async function open(metaChannel) {
    ensureDialog();
    if (S?.pollTimer) clearInterval(S.pollTimer);
    S = freshState(metaChannel);
    const dialog = el("wa-send-dialog");
    dialog.querySelector(".wa-confirm").hidden = true;
    render();
    dialog.showModal();
    try { await loadNumbers(); } catch (error) { toast(error.message, true); }
    render();
    await loadTemplates();
  }

  // Histórico de templates recebidos (aba Detalhes do contato).
  async function renderContactHistory(container, contactId) {
    if (!container || !contactId) return;
    container.innerHTML = "";
    try {
      const rows = await api(`/api/contacts/${encodeURIComponent(contactId)}/template-history`);
      if (!rows.length) return;
      container.innerHTML = `<div class="context-detail-block wa-history"><span class="context-detail-label">Templates recebidos</span>
        ${rows.slice(0, 8).map((row) => `<div class="context-info-row"><span>${esc(row.template)}<small>${esc(shortDate(row.sentAt || row.createdAt))} • ${esc(row.campaign.name)}</small></span><strong class="wa-status s-${esc(row.status)}">${esc(STATUS_LABELS[row.status] || row.status)}</strong></div>`).join("")}
      </div>`;
    } catch (_error) { container.innerHTML = ""; }
  }

  window.WaSendWizard = { open, renderContactHistory, _internals: { normalizePhone, dedupeKey, suggestSource, resolveValue } };
})();
