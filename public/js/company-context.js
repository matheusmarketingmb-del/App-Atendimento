// Multiempresa nas telas administrativas (Bots, Campanhas, Respostas
// Rápidas, Integrações): empresas acessíveis ao usuário, badge, seletor e
// filtro "Todas | Mibro | Sincrofit". Só apresentação — toda regra de acesso
// é validada no backend. A cor vem sempre de company.primaryColor.
(function companyContext() {
  const esc = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  const color = (company) => (/^#[0-9a-f]{6}$/i.test(company?.primaryColor || "") ? company.primaryColor : "");
  const styleAttr = (company) => (color(company) ? ` style="--company-color:${color(company)}"` : "");
  let loading = null;
  const ctx = {
    companies: [],
    preference: "ALL",
    async load() {
      loading ||= fetch("/api/companies", { credentials: "same-origin" })
        .then((response) => (response.ok ? response.json() : { companies: [], preference: "ALL" }))
        .then((data) => {
          ctx.companies = data.companies || [];
          ctx.preference = ctx.companies.some((company) => company.slug === data.preference) ? data.preference : "ALL";
          return ctx;
        });
      return loading;
    },
    multi() { return ctx.companies.length > 1; },
    byId(id) { return ctx.companies.find((company) => company.id === id) || null; },
    styleAttr,
    badge(company) {
      if (!company) return "";
      return `<span class="company-badge"${styleAttr(company)} title="${esc(company.name)}">${esc(company.displayName || company.name)}</span>`;
    },
    // <select> de empresa para formulários de criação ("selecionar empresa
    // primeiro"). Com uma empresa só, fica escondido e já preenchido.
    selectHtml(id, { value = "", allowGlobal = false, label = "Empresa" } = {}) {
      const options = [
        ...(allowGlobal ? [`<option value="">Todas as empresas (global)</option>`] : (ctx.multi() ? [`<option value="" disabled ${value ? "" : "selected"}>Selecione a empresa</option>`] : [])),
        ...ctx.companies.map((company) => `<option value="${esc(company.id)}" ${company.id === value ? "selected" : ""}>${esc(company.name)}</option>`),
      ];
      const hidden = !ctx.multi() && !allowGlobal;
      return `<label class="company-select-field"${hidden ? " hidden" : ""}><span>${esc(label)}</span><select id="${esc(id)}" ${allowGlobal ? "" : "required"}>${options.join("")}</select></label>`;
    },
    // Filtro segmentado; chama onChange(slug) — "ALL" para todas.
    mountFilter(container, onChange, initial = ctx.preference, { allLabel = "Todas" } = {}) {
      if (!container) return;
      let current = initial;
      const render = () => {
        container.hidden = !ctx.multi();
        container.classList.add("company-filter");
        container.innerHTML = [{ slug: "ALL", displayName: "Todas", name: "Todas as empresas" }, ...ctx.companies]
          .map((company) => `<button type="button" class="${company.slug === current ? "active" : ""}" data-company-filter="${esc(company.slug)}"${styleAttr(company)} title="${esc(company.name)}">${company.slug === "ALL" ? "" : `<i class="company-dot"></i>`}${esc(company.slug === "ALL" ? allLabel : company.displayName)}</button>`).join("");
      };
      container.addEventListener("click", (event) => {
        const button = event.target.closest("[data-company-filter]");
        if (!button || button.dataset.companyFilter === current) return;
        current = button.dataset.companyFilter;
        render();
        onChange(current);
      });
      render();
    },
  };
  window.CompanyContext = ctx;
})();
