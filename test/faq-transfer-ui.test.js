const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const js = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");

test("FAQ está disponível no cabeçalho e adapta conteúdo ao perfil", () => {
  assert.match(html, /id="faq-button"/);
  assert.match(html, /id="faq-dialog"/);
  assert.match(js, /function renderFaq\(\)/);
  assert.match(js, /ATENDENTE:/);
  assert.match(js, /SUPERVISOR:/);
  assert.match(js, /ADMIN:/);
});

test("permissão de equipe distingue responsável de categoria", () => {
  assert.match(html, /<b>Alterar responsável<\/b>/);
  assert.match(js, /transferCategories:/);
  assert.match(js, /populateTransferCategorySelect/);
  assert.match(js, /Categorias não liberadas não aparecem na barra lateral/);
});

test("FAQ explica saída da conversa depois da transferência", () => {
  assert.match(js, /a conversa sai da sua tela/);
});
