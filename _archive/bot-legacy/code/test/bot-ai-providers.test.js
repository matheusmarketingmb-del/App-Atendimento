const test = require("node:test");
const assert = require("node:assert/strict");
const { LocalFallbackProvider } = require("../src/services/ai/local-fallback-provider");
const { parseJsonResponse, validateClassification } = require("../src/services/ai/anthropic-provider");

function botFixture(overrides = {}) {
  return {
    id: "bot-1",
    intents: [
      {
        id: "intent-pedido",
        name: "Acompanhar pedido",
        active: true,
        priority: 0,
        responseMessage: "Pode informar o número do pedido?",
        examples: [
          { id: "ex-1", text: "onde esta meu pedido" },
          { id: "ex-2", text: "quero rastrear minha compra" },
          { id: "ex-3", text: "me passa o rastreio" },
        ],
      },
    ],
    ...overrides,
  };
}

test("LocalFallbackProvider reconhece a intenção óbvia por correspondência literal", async () => {
  const provider = new LocalFallbackProvider();
  const result = await provider.classifyIntent({ bot: botFixture(), message: "onde está meu pedido?" });
  assert.equal(result.intentId, "intent-pedido");
  assert.ok(result.confidence >= 0.8);
});

test("LocalFallbackProvider tolera erro de digitação próximo a um exemplo cadastrado", async () => {
  const provider = new LocalFallbackProvider();
  const result = await provider.classifyIntent({ bot: botFixture(), message: "quero rastreiar minha kompra" });
  assert.equal(result.intentId, "intent-pedido");
  assert.ok(result.confidence > 0.4, `confiança muito baixa: ${result.confidence}`);
});

test("LocalFallbackProvider retorna null para mensagem totalmente não relacionada", async () => {
  const provider = new LocalFallbackProvider();
  const result = await provider.classifyIntent({ bot: botFixture(), message: "qual o clima hoje em marte" });
  assert.equal(result, null);
});

test("anthropic-provider: parseJsonResponse ignora texto ao redor do JSON", () => {
  const parsed = parseJsonResponse('Claro, aqui está:\n{"intentId":"intent-pedido","confidence":0.9,"entities":{}}\nObrigado.');
  assert.equal(parsed.intentId, "intent-pedido");
});

test("anthropic-provider: parseJsonResponse retorna null para JSON inválido", () => {
  assert.equal(parseJsonResponse("isso não é json"), null);
  assert.equal(parseJsonResponse(undefined), null);
});

test("anthropic-provider: validateClassification rejeita intentId que não pertence ao Bot", () => {
  const result = validateClassification({ intentId: "intent-inventado", confidence: 0.99 }, botFixture());
  assert.equal(result.intentId, null);
  assert.equal(result.confidence, 0);
});

test("anthropic-provider: validateClassification limita confidence a [0,1] e sanitiza entidades", () => {
  const result = validateClassification(
    { intentId: "intent-pedido", confidence: 5, entities: { orderNumber: "123", evil: "DROP TABLE" } },
    botFixture(),
  );
  assert.equal(result.intentId, "intent-pedido");
  assert.equal(result.confidence, 1);
  assert.deepEqual(result.entities, { orderNumber: "123" });
});
