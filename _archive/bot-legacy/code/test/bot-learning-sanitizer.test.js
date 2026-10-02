const test = require("node:test");
const assert = require("node:assert/strict");
const { redactPersonalData, sanitizeForLearning } = require("../src/services/bot-learning-sanitizer");

test("remove CPF do texto", () => {
  const result = redactPersonalData("meu CPF é 111.222.333-44, pode conferir?");
  assert.doesNotMatch(result, /111\.222\.333-44/);
});

test("remove número de pedido e CNPJ mantendo o restante da frase", () => {
  const result = redactPersonalData("pedido 123456 da empresa CNPJ 12.345.678/0001-90 sumiu");
  assert.doesNotMatch(result, /123456/);
  assert.doesNotMatch(result, /12\.345\.678\/0001-90/);
  assert.match(result, /sumiu/);
});

test("remove e-mail e telefone", () => {
  const result = redactPersonalData("meu email é cliente@teste.com, telefone 11988887777");
  assert.doesNotMatch(result, /cliente@teste\.com/);
  assert.doesNotMatch(result, /11988887777/);
});

test("remove sequências longas de dígitos (possível token/senha)", () => {
  const result = redactPersonalData("meu token é 9988776655443322");
  assert.doesNotMatch(result, /9988776655443322/);
});

test("sanitizeForLearning retorna null quando não sobra conteúdo útil", () => {
  assert.equal(sanitizeForLearning("111.222.333-44"), null);
  assert.equal(sanitizeForLearning(""), null);
});

test("sanitizeForLearning mantém mensagens de negócio normais intactas", () => {
  assert.equal(sanitizeForLearning("meu relógio não conecta no bluetooth"), "meu relógio não conecta no bluetooth");
});

test("sanitizeForLearning trunca textos muito longos", () => {
  const longText = "preciso de ajuda ".repeat(100);
  const result = sanitizeForLearning(longText, { maxLength: 50 });
  assert.ok(result.length <= 50);
});
