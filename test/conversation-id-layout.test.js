const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(process.cwd(), "public", "css", "app.css"), "utf8");

test("botões do ID não herdam o estilo circular do botão de fechar", () => {
  assert.doesNotMatch(css, /\.dialog-header button\s*\{/);
  assert.match(css, /\.dialog-header > button,\.dialog-header-actions button\s*\{/);
  assert.match(css, /\.conversation-id-copy\s*\{/);
  // "Analisar para aprendizado" saiu junto com o sistema de Bots legado.
  assert.doesNotMatch(css, /conversation-id-analyze/);
});

test("modal de conteúdo compartilhado acomoda cabeçalho com altura dinâmica", () => {
  assert.match(css, /\.contact-files-dialog\[open\]\s*\{[^}]*display:flex;[^}]*flex-direction:column;/);
  assert.match(css, /\.contact-files-content\s*\{[^}]*min-height:0;[^}]*flex:1;/);
});