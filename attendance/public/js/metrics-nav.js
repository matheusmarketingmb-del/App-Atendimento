(() => {
  const definitions = [
    { path: "/operacao", title: "Operação", allowed: (u, c) => u.isMaster || c.some(row => row.role === "SUPERVISOR") },
    { path: "/produtividade", aliases: ["/relatorio-conversas", "/relatorio-conversas.html"], title: "Produtividade e qualidade", allowed: u => u.canOpenProductivity },
    { path: "/custos-meta", title: "Custos da Meta", allowed: u => u.isMaster },
    { path: "/anuncios-meta", title: "Campanhas Meta", allowed: u => u.isMaster },
  ];
  async function load() {
    const response = await fetch("/api/auth/status", { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) { location.replace("/login.html"); return; }
    if (!response.ok) throw new Error("Não foi possível conferir o acesso às métricas.");
    const { user, companyAccess } = await response.json();
    const companies = companyAccess?.companies || [];
    const permitted = definitions.filter(item => item.allowed(user, Array.isArray(companies) ? companies : []));
    const path = location.pathname.replace(/\.html$/, "");
    if (path === "/metricas" && permitted.length) { location.replace(permitted[0].path); return; }
    const nav = document.createElement("nav"); nav.className = "metrics-tabs"; nav.setAttribute("aria-label", "Métricas");
    for (const item of permitted) {
      const link = document.createElement("a"); link.href = item.path; link.textContent = item.title;
      if (item.path === path || item.aliases?.includes(location.pathname)) link.setAttribute("aria-current", "page");
      nav.append(link);
    }
    document.querySelector("header.topbar, header.rp-topbar")?.after(nav);
    if (path === "/metricas") document.querySelector("#metrics-status").textContent = "Sua conta ainda não tem acesso a painéis de métricas.";
  }
  load().catch(error => {
    const status = document.querySelector("#metrics-status");
    if (status) status.textContent = error.message;
  });
})();
