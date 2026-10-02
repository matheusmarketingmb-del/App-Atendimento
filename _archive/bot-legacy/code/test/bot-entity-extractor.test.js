const test = require("node:test");
const assert = require("node:assert/strict");
const { extractEntities, mergeEntities, sanitizeEntities } = require("../src/services/bot-entity-extractor");

test("extrai número de pedido de frases variadas", () => {
  assert.equal(extractEntities("meu pedido 12345 não chegou").orderNumber, "12345");
  assert.equal(extractEntities("compra #98765 sumiu").orderNumber, "98765");
  assert.equal(extractEntities("nenhum número aqui").orderNumber, undefined);
});

test("extrai e-mail, CPF e CNPJ quando presentes", () => {
  const entities = extractEntities("meu email é cliente@exemplo.com e cpf 123.456.789-01");
  assert.equal(entities.email, "cliente@exemplo.com");
  assert.equal(entities.cpf, "123.456.789-01");
});

test("sanitizeEntities descarta chaves desconhecidas e valores inválidos", () => {
  const sanitized = sanitizeEntities({ orderNumber: "123", hackedField: "rm -rf /", confidence: 999 });
  assert.deepEqual(sanitized, { orderNumber: "123" });
});

test("mergeEntities prioriza a primeira fonte com valor presente", () => {
  const merged = mergeEntities({ orderNumber: "111" }, { orderNumber: "222", email: "a@b.com" });
  assert.deepEqual(merged, { orderNumber: "111", email: "a@b.com" });
});
