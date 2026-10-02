const test = require("node:test");
const assert = require("node:assert/strict");
const { interpretWithProviders } = require("../src/services/bot-interpreter-service");
const { LocalFallbackProvider } = require("../src/services/ai/local-fallback-provider");

const local = { provider: new LocalFallbackProvider(), name: "LOCAL_FALLBACK" };

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
        examples: [{ id: "ex-1", text: "onde esta meu pedido" }],
      },
    ],
    ...overrides,
  };
}

function fakeProvider(handler) {
  return { provider: { classifyIntent: handler }, name: "FAKE_AI" };
}

test("interpreta uma intenção óbvia com o provider local", async () => {
  const result = await interpretWithProviders({
    bot: botFixture(), message: "onde esta meu pedido", primary: local, fallback: local,
  });
  assert.equal(result.intentId, "intent-pedido");
  assert.equal(result.status, "OK");
});

test("linguagem informal/paráfrase: um provider de IA pode reconhecer o que o fallback local não reconheceria", async () => {
  const ai = fakeProvider(async () => ({ intentId: "intent-pedido", confidence: 0.94, entities: {} }));
  const result = await interpretWithProviders({
    bot: botFixture(), message: "cade meu relogio", primary: ai, fallback: local,
  });
  assert.equal(result.intentId, "intent-pedido");
  assert.equal(result.confidence, 0.94);
  assert.equal(result.provider, "FAKE_AI");
});

test("mensagem ambígua sem exemplo correspondente não gera intenção", async () => {
  const result = await interpretWithProviders({
    bot: botFixture(), message: "isso é meio estranho mas ok", primary: local, fallback: local,
  });
  assert.equal(result.intentId, null);
});

test("falha do provider principal cai para o fallback local sem lançar erro", async () => {
  const brokenAi = fakeProvider(async () => { throw new Error("timeout"); });
  const result = await interpretWithProviders({
    bot: botFixture(), message: "onde esta meu pedido", primary: brokenAi, fallback: local,
  });
  assert.equal(result.status, "PROVIDER_ERROR");
  assert.equal(result.intentId, "intent-pedido");
  assert.equal(result.provider, "LOCAL_FALLBACK");
});

test("nunca confia em um intentId inventado pelo provider", async () => {
  const ai = fakeProvider(async () => ({ intentId: "intent-que-nao-existe", confidence: 0.99, entities: {} }));
  const result = await interpretWithProviders({
    bot: botFixture(), message: "qualquer coisa", primary: ai, fallback: local,
  });
  assert.equal(result.intentId, null);
  assert.equal(result.confidence, 0);
});

test("mensagem vazia não consulta provider algum", async () => {
  let called = false;
  const ai = fakeProvider(async () => { called = true; return null; });
  const result = await interpretWithProviders({ bot: botFixture(), message: "   ", primary: ai, fallback: local });
  assert.equal(result.status, "EMPTY_MESSAGE");
  assert.equal(called, false);
});

test("contexto de esclarecimento: 'sim' reafirma a última intenção sem chamar provider", async () => {
  let called = false;
  const ai = fakeProvider(async () => { called = true; return null; });
  const state = { pendingClarification: true, lastIntentId: "intent-pedido", lastConfidence: 0.6 };
  const result = await interpretWithProviders({
    bot: botFixture(), message: "sim", state, primary: ai, fallback: local,
  });
  assert.equal(result.intentId, "intent-pedido");
  assert.equal(result.provider, "CONTEXT_CARRYOVER");
  assert.equal(result.confidence, 0.8);
  assert.equal(called, false);
});

test("extrai número de pedido mesmo quando a intenção não é reconhecida", async () => {
  const result = await interpretWithProviders({
    bot: botFixture(), message: "assunto qualquer, pedido 55501", primary: local, fallback: local,
  });
  assert.equal(result.entities.orderNumber, "55501");
});
