const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const publicDir = path.join(__dirname, "..", "public");
const read = (file) => fs.readFileSync(path.join(publicDir, file), "utf8");
const html = read("index.html");
const appCss = read("css/app.css");
const settingsCss = read("css/configuracoes.css");
const appJs = read("js/app.js");
const featureFlagsJs = read("js/feature-flags.js");

test("Configurações permite rolagem vertical e crescimento natural das seções", () => {
  assert.match(settingsCss, /body\{[^}]*height:auto[^}]*overflow-y:auto/);
  assert.match(settingsCss, /grid-auto-rows:max-content/);
  assert.match(settingsCss, /details\.card\{min-height:0;overflow:visible\}/);
});

test("textos de ajuda ficam abaixo dos campos sem margem negativa", () => {
  const rule = settingsCss.match(/\.settings-grid \.card-help\{([^}]*)\}/)?.[1] || "";
  assert.match(rule, /margin:12px 0 0/);
  assert.doesNotMatch(rule, /margin:-/);
  assert.match(rule, /line-height:1\.55/);
});

test("atalhos ficam agrupados na sidebar e preservam IDs únicos", () => {
  for (const label of ["Atendimento", "Automação", "Canais", "Campanhas", "Gestão"]) {
    assert.match(html, new RegExp("sidebar-group-label[^>]*>" + label + "<"));
  }
  for (const channel of ["WhatsApp", "E-mail", "Instagram + Facebook", "Plataformas de venda"]) {
    assert.ok(html.includes(`sidebar-item-label">${channel}<`));
  }
  for (const id of [
    "enable-notifications", "manage-devices", "bots-button", "integrations-button",
    "quick-replies-admin-button", "campaigns-button",
    "conversation-settings-button", "team-button",
  ]) assert.equal((html.match(new RegExp('id="' + id + '"', "g")) || []).length, 1);
});

test("sidebar recolhe, abre como drawer no mobile e troca o workspace por canal", () => {
  assert.match(appJs, /setSidebarExpanded/);
  assert.match(appJs, /mobile-open/);
  assert.match(appJs, /setChannelWorkspace/);
  assert.match(html, /id="quick-filters-tray"/);
  assert.match(html, /id="email-mailboxes"/);
  assert.match(appJs, /emailMailbox/);
  assert.match(appCss, /channel-workspace-item\.active/);
  assert.match(appCss, /max-width:700px/);
});

test("alertas preservam o rótulo recolhível e piscam apenas com conversa não lida", () => {
  assert.match(appJs, /button\.querySelector\("\.sidebar-item-label"\)\.textContent = label/);
  assert.doesNotMatch(appJs, /button\.textContent = granted/);
  assert.match(appJs, /conversation\.status === "AGUARDANDO_EQUIPE" && Number\(conversation\.unreadCount\) > 0/);
});

test("contadores da navegação usam a lista global sem acompanhar filtros ativos", () => {
  assert.match(appJs, /MARKETPLACE_UI_ENABLED \? Promise\.resolve\(null\) : api\("\/api\/conversations"\)/);
  assert.match(appJs, /summaryConversations\.reduce/);
});

test("marketplaces ficam ocultos por uma única flag reversível sem remover a implementação", () => {
  assert.match(featureFlagsJs, /marketplaces:\s*false/);
  for (const channel of ["MERCADO_LIVRE", "TIKTOK_SHOP", "AMAZON_MARKETPLACE", "SHOPEE", "SHEIN_MARKETPLACE"]) {
    assert.ok(featureFlagsJs.includes(channel));
  }
  assert.match(html, /data-marketplace-feature hidden/);
  assert.match(appJs, /availableConversations/);
  assert.match(appJs, /isMarketplaceChannel/);
});
