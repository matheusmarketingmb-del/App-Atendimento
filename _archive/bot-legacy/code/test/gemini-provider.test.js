const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { GeminiProvider, mapGeminiError, DEFAULT_MODEL } = require("../src/services/ai/gemini-provider");
const { getPrimaryProvider, getProviderStatus, testConnection } = require("../src/services/ai/get-ai-provider");

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

function geminiSuccessResponse(json) {
  return {
    data: {
      candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40 },
    },
  };
}

// Item "sem chave": nunca lança um erro incompreensível — mensagem clara,
// sem nenhuma tentativa de rede.
test("GeminiProvider: sem GEMINI_API_KEY, construtor lança erro claro (nunca chama a API)", () => {
  assert.throws(() => new GeminiProvider({ apiKey: "" }), /GEMINI_API_KEY não configurada/);
});

test("GeminiProvider: modelo e timeout usam defaults sensatos quando não informados", () => {
  const provider = new GeminiProvider({ apiKey: "fake-key" });
  assert.equal(provider.model, DEFAULT_MODEL);
  assert.equal(provider.timeoutMs, 15000);
});

test("GeminiProvider: modelo/timeout configuráveis via construtor", () => {
  const provider = new GeminiProvider({ apiKey: "fake-key", model: "gemini-1.5-pro", timeoutMs: 3000 });
  assert.equal(provider.model, "gemini-1.5-pro");
  assert.equal(provider.timeoutMs, 3000);
});

// Item "chave válida": classifyIntent monta a URL/headers certos e nunca
// manda a chave na query string (só no header x-goog-api-key).
test("GeminiProvider: chave válida — classifica a intenção a partir de uma resposta simulada da API", async (t) => {
  const provider = new GeminiProvider({ apiKey: "fake-key" });
  let captured;
  t.mock.method(axios, "post", async (url, body, config) => {
    captured = { url, body, config };
    return geminiSuccessResponse({ intentId: "intent-pedido", confidence: 0.92, entities: {} });
  });
  const result = await provider.classifyIntent({ bot: botFixture(), message: "onde esta meu pedido", context: [] });
  assert.equal(result.intentId, "intent-pedido");
  assert.equal(result.confidence, 0.92);
  assert.equal(result.usage.inputTokens, 120);
  assert.equal(result.usage.outputTokens, 40);
  assert.ok(captured.url.includes(DEFAULT_MODEL));
  assert.equal(captured.config.headers["x-goog-api-key"], "fake-key");
  assert.doesNotMatch(captured.url, /fake-key/, "a chave nunca deveria aparecer na URL");
  assert.deepEqual(captured.body.generationConfig.responseJsonSchema.properties.intentId.anyOf[0].enum, ["intent-pedido"]);
  assert.equal(captured.body.generationConfig.thinkingConfig.thinkingLevel, "minimal");
});

test("GeminiProvider: concatena partes e resolve nome exato sem aceitar intenção inventada", async (t) => {
  const provider = new GeminiProvider({ apiKey: "fake-key" });
  t.mock.method(axios, "post", async () => ({ data: { candidates: [{ content: { parts: [
    { text: '{"intentId":"Acompanhar ' },
    { text: 'pedido","confidence":0.88,"entities":{}}' },
  ] } }] } }));
  const result = await provider.classifyIntent({ bot: botFixture(), message: "pedido", context: [] });
  assert.equal(result.intentId, "intent-pedido");
  assert.equal(result.confidence, 0.88);
});

// Item "JSON inválido": nunca lança, nunca inventa intenção — degrada para
// "sem intenção reconhecida".
test("GeminiProvider: resposta com JSON inválido nunca lança e nunca inventa intenção", async (t) => {
  const provider = new GeminiProvider({ apiKey: "fake-key" });
  t.mock.method(axios, "post", async () => ({
    data: { candidates: [{ content: { parts: [{ text: "isso não é JSON" }] } }] },
  }));
  const result = await provider.classifyIntent({ bot: botFixture(), message: "oi", context: [] });
  assert.equal(result.intentId, null);
  assert.equal(result.confidence, 0);
});

// Item "chave inválida" (autenticação).
test("GeminiProvider: erro 401/403 vira AUTH_ERROR, nunca vaza a chave na mensagem", async (t) => {
  const provider = new GeminiProvider({ apiKey: "chave-secreta-de-teste" });
  t.mock.method(axios, "post", async () => {
    throw Object.assign(new Error("Request failed"), { response: { status: 403, data: { error: { message: "PERMISSION_DENIED" } } } });
  });
  await assert.rejects(
    () => provider.classifyIntent({ bot: botFixture(), message: "oi", context: [] }),
    (error) => {
      assert.equal(error.code, "AUTH_ERROR");
      assert.doesNotMatch(error.message, /chave-secreta-de-teste/);
      return true;
    },
  );
});

// Item "quota excedida".
test("GeminiProvider: 429 com RESOURCE_EXHAUSTED vira QUOTA_EXCEEDED", async (t) => {
  const provider = new GeminiProvider({ apiKey: "fake-key" });
  t.mock.method(axios, "post", async () => {
    throw Object.assign(new Error("Request failed"), { response: { status: 429, data: { error: { status: "RESOURCE_EXHAUSTED" } } } });
  });
  await assert.rejects(
    () => provider.classifyIntent({ bot: botFixture(), message: "oi", context: [] }),
    (error) => { assert.equal(error.code, "QUOTA_EXCEEDED"); return true; },
  );
});

// Item "rate limit" (429 sem ser cota).
test("GeminiProvider: 429 sem RESOURCE_EXHAUSTED vira RATE_LIMIT", async (t) => {
  const provider = new GeminiProvider({ apiKey: "fake-key" });
  t.mock.method(axios, "post", async () => {
    throw Object.assign(new Error("Request failed"), { response: { status: 429, data: { error: { status: "TOO_MANY_REQUESTS" } } } });
  });
  await assert.rejects(
    () => provider.classifyIntent({ bot: botFixture(), message: "oi", context: [] }),
    (error) => { assert.equal(error.code, "RATE_LIMIT"); return true; },
  );
});

// Item "timeout".
test("GeminiProvider: timeout do axios (ECONNABORTED) vira TIMEOUT", async (t) => {
  const provider = new GeminiProvider({ apiKey: "fake-key" });
  t.mock.method(axios, "post", async () => {
    throw Object.assign(new Error("timeout of 8000ms exceeded"), { code: "ECONNABORTED" });
  });
  await assert.rejects(
    () => provider.classifyIntent({ bot: botFixture(), message: "oi", context: [] }),
    (error) => { assert.equal(error.code, "TIMEOUT"); return true; },
  );
});

test("mapGeminiError: erro genérico de servidor vira PROVIDER_REQUEST_FAILED", () => {
  const error = mapGeminiError(Object.assign(new Error("boom"), { response: { status: 500 } }));
  assert.equal(error.code, "PROVIDER_REQUEST_FAILED");
});

// ===== get-ai-provider.js: seleção por Bot, status, testConnection =====

test("getProviderStatus: LOCAL está sempre 'configurado'; provider desconhecido nunca quebra", async () => {
  assert.deepEqual(await getProviderStatus("LOCAL"), { provider: "LOCAL", configured: true, error: null });
  const unknown = await getProviderStatus("MISTRAL");
  assert.equal(unknown.configured, false);
  assert.match(unknown.error, /não implementado/);
});

test("getProviderStatus/getPrimaryProvider: GEMINI sem credencial (painel ou env) nunca derruba a app, cai para local", async () => {
  const previous = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const status = await getProviderStatus("GEMINI");
    assert.equal(status.provider, "GEMINI");
    assert.equal(status.configured, false);
    const { name } = await getPrimaryProvider("GEMINI");
    assert.equal(name, "LOCAL_FALLBACK");
  } finally {
    if (previous !== undefined) process.env.GEMINI_API_KEY = previous;
  }
});

test("testConnection: provider não configurado retorna { ok: false } sem lançar e sem vazar segredo", async () => {
  const previous = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const result = await testConnection("GEMINI");
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error || "", /GEMINI_API_KEY=/);
  } finally {
    if (previous !== undefined) process.env.GEMINI_API_KEY = previous;
  }
});

test("testConnection: LOCAL nunca faz chamada de rede — sempre ok imediato", async () => {
  const result = await testConnection("LOCAL");
  assert.equal(result.ok, true);
});
