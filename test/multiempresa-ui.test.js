const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Multiempresa — frontend (item 66/67): mesmo estilo dos demais testes de UI
// (contrato do código-fonte) + execução real do company-context.js. O teste
// visual lado a lado fica em docs/multiempresa-cards-preview.html.
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const appJs = read("public/js/app.js");
const appCss = read("public/css/app.css");
const botsCss = read("public/css/bots.css");
const html = read("public/index.html");

test("caixa de entrada: filtro Todas/Mibro/Sincrofit só com empresas acessíveis e preferência salva no servidor", () => {
  assert.match(html, /id="company-filter" class="company-filter" role="radiogroup"/);
  assert.match(appJs, /container\.hidden = !multiCompany\(\)/, "com uma empresa só, o filtro nem aparece");
  assert.match(appJs, /\[\{ slug: "ALL", displayName: "Todas"/);
  assert.match(appJs, /api\("\/api\/companies\/preference", \{ method: "PUT"/);
  assert.match(appJs, /if \(company\) params\.set\("company", company\);/);
});

test("card: empresa por borda + badge discreto, cor sempre de company.primaryColor (validada)", () => {
  assert.match(appJs, /data-company="\$\{escapeHtml\(c\.company\.slug\)\}"/);
  assert.match(appJs, /companyStyleAttr\(c\.company\)/);
  assert.match(appJs, /multiCompany\(\) \? companyBadge\(c\.company, "card-company-badge"\)/);
  assert.match(appJs, /\/\^#\[0-9a-f\]\{6\}\$\/i\.test\(company\?\.primaryColor/);
  assert.match(appJs, /aria-current="true"/, "selecionado não depende só de cor");
  // Sem categoria continua independente da empresa.
  assert.match(appJs, /⚠ Sem categoria/);
});

test("conversa aberta: badge da empresa no cabeçalho, 'Enviando por' no composer, categorias e responsáveis da empresa", () => {
  assert.match(html, /id="contact-company" class="company-badge company-badge-header"/);
  assert.match(html, /id="composer-sender" class="composer-sender"[^>]*hidden><\/div>\s*<form id="composer"/);
  assert.match(appJs, /Enviando por <b>\$\{escapeHtml\(c\.company\.name\)\}<\/b>/);
  assert.match(appJs, /category\.companyId === state\.selectedCompanyId/);
  assert.match(appJs, /user\.companyIds\.includes\(companyId\)/);
  assert.match(appJs, /\/api\/meta\/templates\?conversationId=/);
  assert.match(appJs, /<span>Empresa<\/span><strong>\$\{companyBadge\(c\.company\)\}/);
});

test("design: tokens de empresa reutilizáveis, barra de 3px, hover/selecionado discretos e app neutro", () => {
  for (const token of ["--company-border", "--company-soft", "--company-soft-strong"]) assert.ok(appCss.includes(token), token);
  assert.match(appCss, /\.workspace \.conversation-card\.has-company \{[^}]*inset 3px 0 0 var\(--company-border\)/);
  assert.match(appCss, /\.workspace \.conversation-card\.has-company\.active \{[^}]*inset 5px 0 0 var\(--company-color\)/);
  // Laranja Mibro não é mais identidade global: só sobra na definição antiga do token, sobrescrita no fim.
  assert.equal((appCss.match(/#ef5b2a/gi) || []).length, 1);
  assert.match(appCss, /:root \{ --orange:#30343b;[^}]*--on-accent:#ffffff;/);
  assert.match(appCss, /html\[data-theme="dark"\] \{ --orange:#d7dbe2;[^}]*--on-accent:#121418;/);
  assert.match(botsCss, /--button-primary:#30343b/);
  assert.match(appCss, /@media \(max-width:700px\) \{\s*\.card-company-badge/);
});

test("telas administrativas carregam o contexto de empresa e enviam companyId", () => {
  for (const page of ["bots", "campaigns", "quick-replies", "integrations"]) {
    const pageHtml = read(`public/${page}.html`);
    assert.ok(pageHtml.indexOf("/js/company-context.js") < pageHtml.indexOf(`/js/${page}.js`), page);
  }
  assert.match(read("public/js/bots.js"), /companyId: \$\("#new-bot-company-select"\)\?\.value/);
  assert.match(read("public/js/campaigns.js"), /\/api\/campaign-templates\?channelAccountId=/);
  assert.match(read("public/js/quick-replies.js"), /scope: \$\("#qr-company"\)\.value === "GLOBAL" \? "GLOBAL" : "COMPANY"/);
  assert.match(read("public/js/integrations.js"), /config\.phoneNumberId/);
  assert.match(read("public/js/relatorio-conversas.js"), /company-breakdown/);
  assert.match(appJs, /companyAccess: teamCompanyAccessBody\(\)/);
});

test("company-context.js: badge escapa nome, ignora cor inválida e só mostra 'Todas' com mais de uma empresa", async () => {
  const context = { window: {}, fetch: async () => ({ ok: true, json: async () => ({
    companies: [
      { id: "a", slug: "mibro", name: "Mibro <b>Brasil</b>", displayName: "MIBRO", primaryColor: "#FF6633" },
      { id: "b", slug: "x", name: "X", displayName: "X", primaryColor: "red;background:url(evil)" },
    ],
    preference: "naoexiste",
  }) }) };
  vm.runInNewContext(read("public/js/company-context.js"), context);
  const ctx = context.window.CompanyContext;
  await ctx.load();
  assert.equal(ctx.preference, "ALL", "preferência inválida volta para Todas");
  assert.equal(ctx.multi(), true);
  assert.match(ctx.badge(ctx.companies[0]), /--company-color:#FF6633/);
  assert.ok(!ctx.badge(ctx.companies[0]).includes("<b>"), "nome escapado");
  assert.ok(!ctx.badge(ctx.companies[1]).includes("evil"), "cor fora de #RRGGBB é descartada");
});
