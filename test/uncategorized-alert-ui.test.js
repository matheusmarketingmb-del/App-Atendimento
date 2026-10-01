const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(process.cwd(), "public", "index.html"), "utf8");
const js = fs.readFileSync(path.join(process.cwd(), "public", "js", "app.js"), "utf8");
const css = fs.readFileSync(path.join(process.cwd(), "public", "css", "app.css"), "utf8");

function loadNeedsCategoryAlert() {
  const source = js.match(/const needsCategoryAlert = [^\n]+/)[0];
  return new Function(`${source}; return needsCategoryAlert;`)();
}

test("regra: alerta só para conversa em atendimento sem categoria", () => {
  const needsCategoryAlert = loadNeedsCategoryAlert();
  assert.equal(needsCategoryAlert({ categoryId: null, status: "EM_ATENDIMENTO" }), true);
  assert.equal(needsCategoryAlert({ categoryId: "", status: "NOVO" }), true);
  assert.equal(needsCategoryAlert({ categoryId: null, status: "AGUARDANDO_CLIENTE" }), true);
  assert.equal(needsCategoryAlert({ categoryId: "cat-1", status: "EM_ATENDIMENTO" }), false);
  assert.equal(needsCategoryAlert({ categoryId: null, status: "FINALIZADO" }), false);
  assert.equal(needsCategoryAlert({ categoryId: null, status: "BOT" }), false);
  assert.equal(needsCategoryAlert(null), false);
});

test("aviso fica junto do seletor de categoria, com tooltip, e começa oculto", () => {
  assert.match(html, /<span id="category-missing-hint"[^>]*title="Esta conversa ainda não possui categoria definida\."[^>]*hidden>⚠ Sem categoria<\/span>\s*<select id="category-select"/);
});

test("alerta é sincronizado a cada render do cabeçalho (inclui realtime) e limpo ao fechar a conversa", () => {
  assert.match(js, /syncCategoryConfirmation\(\);\n\s+syncCategoryAlert\(c\);/);
  const closeBody = js.match(/function closeConversationView\(\)[\s\S]*?\n\}/)[0];
  assert.match(closeBody, /syncCategoryAlert\(null\);/);
  // categoryId e status fazem parte da assinatura do cabeçalho: mudança via SSE re-renderiza.
  const headerSignature = js.match(/const headerSignature = JSON\.stringify\(\{[\s\S]*?\}\);/)[0];
  assert.match(headerSignature, /categoryId: c\.categoryId/);
  assert.match(headerSignature, /status: c\.status/);
});

test("lista mostra badge discreto, sem animação", () => {
  assert.match(js, /needsCategoryAlert\(c\) \? `<span class="category-label category-missing-label" title="[^"]+">⚠ Sem categoria<\/span>`/);
  const badgeRule = css.match(/\.category-label\.category-missing-label \{[^}]+\}/)[0];
  assert.doesNotMatch(badgeRule, /animation/);
});

test("seletor pulsa em laranja #FF6633 a cada ~1,6s e respeita prefers-reduced-motion", () => {
  const rule = css.match(/\.chat-actions #category-select\.category-missing \{[^}]+\}/)[0];
  assert.match(rule, /border-color:#ff6633/);
  assert.match(rule, /animation:category-missing-pulse 1\.6s ease-in-out infinite/);
  assert.match(css, /@keyframes category-missing-pulse/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\) \{ \.chat-actions #category-select\.category-missing \{ animation:none;/);
});

test("alerta não bloqueia nenhuma ação", () => {
  const syncBody = js.match(/function syncCategoryAlert\(c\) \{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(syncBody, /disabled|showModal|toast/);
});
