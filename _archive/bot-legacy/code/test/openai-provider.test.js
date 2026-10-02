const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { OpenAiProvider, mapOpenAiError, DEFAULT_MODEL } = require("../src/services/ai/openai-provider");

function botFixture(overrides = {}) {
  return {
    id: "bot-1",
    intents: [{
      id: "intent-pedido", name: "Acompanhar pedido", active: true, priority: 0,
      examples: [{ id: "ex-1", text: "onde esta meu pedido" }],
    }],
    ...overrides,
  };
}

function openAiSuccessResponse(json) {
  return {
    data: {
      choices: [{ message: { content: JSON.stringify(json) } }],
      usage: { prompt_tokens: 80, completion_tokens: 20 },
    },
  };
}

test("OpenAiProvider: sem OPENAI_API_KEY, construtor lança erro claro (nunca chama a API)", () => {
  assert.throws(() => new OpenAiProvider({ apiKey: "" }), /OPENAI_API_KEY não configurada/);
});

test("OpenAiProvider: modelo e timeout usam defaults sensatos quando não informados", () => {
  const provider = new OpenAiProvider({ apiKey: "fake-key" });
  assert.equal(provider.model, DEFAULT_MODEL);
  assert.equal(provider.timeoutMs, 8000);
});

test("OpenAiProvider: chave válida — classifica a intenção e nunca manda a chave na query string", async (t) => {
  const provider = new OpenAiProvider({ apiKey: "fake-key" });
  let captured;
  t.mock.method(axios, "post", async (url, body, config) => {
    captured = { url, config };
    return openAiSuccessResponse({ intentId: "intent-pedido", confidence: 0.88, entities: {} });
  });
  const result = await provider.classifyIntent({ bot: botFixture(), message: "onde esta meu pedido", context: [] });
  assert.equal(result.intentId, "intent-pedido");
  assert.equal(result.confidence, 0.88);
  assert.equal(result.usage.inputTokens, 80);
  assert.equal(result.usage.outputTokens, 20);
  assert.equal(captured.config.headers.Authorization, "Bearer fake-key");
  assert.doesNotMatch(captured.url, /fake-key/);
});

test("OpenAiProvider: resposta com JSON inválido nunca lança e nunca inventa intenção", async (t) => {
  const provider = new OpenAiProvider({ apiKey: "fake-key" });
  t.mock.method(axios, "post", async () => ({ data: { choices: [{ message: { content: "não é JSON" } }] } }));
  const result = await provider.classifyIntent({ bot: botFixture(), message: "oi", context: [] });
  assert.equal(result.intentId, null);
  assert.equal(result.confidence, 0);
});

test("OpenAiProvider: 401 vira AUTH_ERROR, nunca vaza a chave", async (t) => {
  const provider = new OpenAiProvider({ apiKey: "chave-secreta-openai" });
  t.mock.method(axios, "post", async () => {
    throw Object.assign(new Error("Request failed"), { response: { status: 401, data: { error: { message: "Invalid API key" } } } });
  });
  await assert.rejects(
    () => provider.classifyIntent({ bot: botFixture(), message: "oi", context: [] }),
    (error) => { assert.equal(error.code, "AUTH_ERROR"); assert.doesNotMatch(error.message, /chave-secreta-openai/); return true; },
  );
});

test("OpenAiProvider: 429 com insufficient_quota vira QUOTA_EXCEEDED", async (t) => {
  const provider = new OpenAiProvider({ apiKey: "fake-key" });
  t.mock.method(axios, "post", async () => {
    throw Object.assign(new Error("Request failed"), { response: { status: 429, data: { error: { type: "insufficient_quota" } } } });
  });
  await assert.rejects(
    () => provider.classifyIntent({ bot: botFixture(), message: "oi", context: [] }),
    (error) => { assert.equal(error.code, "QUOTA_EXCEEDED"); return true; },
  );
});

test("OpenAiProvider: 429 sem insufficient_quota vira RATE_LIMIT", async (t) => {
  const provider = new OpenAiProvider({ apiKey: "fake-key" });
  t.mock.method(axios, "post", async () => {
    throw Object.assign(new Error("Request failed"), { response: { status: 429, data: { error: { type: "requests" } } } });
  });
  await assert.rejects(
    () => provider.classifyIntent({ bot: botFixture(), message: "oi", context: [] }),
    (error) => { assert.equal(error.code, "RATE_LIMIT"); return true; },
  );
});

test("OpenAiProvider: timeout do axios vira TIMEOUT", async (t) => {
  const provider = new OpenAiProvider({ apiKey: "fake-key" });
  t.mock.method(axios, "post", async () => {
    throw Object.assign(new Error("timeout of 8000ms exceeded"), { code: "ECONNABORTED" });
  });
  await assert.rejects(
    () => provider.classifyIntent({ bot: botFixture(), message: "oi", context: [] }),
    (error) => { assert.equal(error.code, "TIMEOUT"); return true; },
  );
});

test("mapOpenAiError: erro genérico de servidor vira PROVIDER_REQUEST_FAILED", () => {
  const error = mapOpenAiError(Object.assign(new Error("boom"), { response: { status: 500 } }));
  assert.equal(error.code, "PROVIDER_REQUEST_FAILED");
});
