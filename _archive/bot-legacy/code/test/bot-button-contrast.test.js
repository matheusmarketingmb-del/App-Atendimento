const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(process.cwd(), "public", "css", "bots.css"), "utf8");
const html = fs.readFileSync(path.join(process.cwd(), "public", "bots.html"), "utf8");

test("ações do simulador recebem o estilo compartilhado de botões", () => {
  assert.match(
    css,
    /\.card-heading button,\.card>button,\.form-actions button,\.simulator-actions button\{[^}]*color:var\(--button-primary-ink\);background:var\(--button-primary\);/
  );
  assert.match(html, /<button type="submit">Executar simulação<\/button>/);
  assert.match(html, /<button id="simulator-clear" type="button">Limpar conversa<\/button>/);
});

test("botões secundários mantêm contraste nos temas claro e escuro", () => {
  assert.match(css, /--button-secondary:#edf0f2;--button-secondary-ink:#20252b/);
  assert.match(
    css,
    /html\[data-theme=dark\]\{[^}]*--button-secondary:#30363d;--button-secondary-ink:#edf0f3/
  );
  assert.match(
    css,
    /\.form-actions button:first-child\{color:var\(--button-secondary-ink\);background:var\(--button-secondary\)\}/
  );
  assert.match(
    css,
    /\.simulator-actions button:last-child\{color:var\(--button-secondary-ink\);background:var\(--button-secondary\)\}/
  );
  assert.match(
    css,
    /\.learning-card \.learning-actions button\.secondary\{color:var\(--button-secondary-ink\);background:var\(--button-secondary\)\}/
  );
  assert.doesNotMatch(css, /color:var\(--ink\);background:#edf0f2/);
});

test("kill switch global usa o estado autoritativo e o checkbox é somente indicador", () => {
  const javascript = fs.readFileSync(path.join(process.cwd(), "public", "js", "bots.js"), "utf8");
  assert.match(html, /<input id="global-automation" type="checkbox" disabled/);
  assert.match(javascript, /killSwitch\.dataset\.automationEnabled = String\(settings\.automationEnabled\)/);
  assert.match(javascript, /REATIVAR AUTOMAÇÃO DOS BOTS/);
  assert.match(javascript, /const willActivate = \$\("#kill-switch"\)\.dataset\.automationEnabled === "true"/);
  assert.doesNotMatch(javascript, /const willActivate = \$\("#global-automation"\)\.checked/);
});
