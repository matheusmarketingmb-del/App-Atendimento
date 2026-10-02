const test = require("node:test");
const assert = require("node:assert/strict");
const governance = require("../src/services/bot-governance-service");

test("resolveFeatureFlags aplica defaults quando o Bot não tem overrides", () => {
  const flags = governance.resolveFeatureFlags({ featureFlags: {} });
  assert.equal(flags.interpretationEnabled, true);
  assert.equal(flags.autoSwitchEnabled, true);
  assert.equal(flags.knowledgeBaseEnabled, false);
  assert.equal(flags.agentSuggestionsEnabled, true);
  assert.equal(flags.contextExpirationMinutes, 120);
});

test("resolveFeatureFlags mescla overrides salvos sobre os defaults", () => {
  const flags = governance.resolveFeatureFlags({ featureFlags: { contextEnabled: false, contextMaxMessages: 5 } });
  assert.equal(flags.contextEnabled, false);
  assert.equal(flags.contextMaxMessages, 5);
  assert.equal(flags.observationEnabled, true);
});

test("validateFeatureFlagsInput rejeita chaves desconhecidas silenciosamente e valores fora do tipo com erro", () => {
  const result = governance.validateFeatureFlagsInput({ contextEnabled: true, chaveInventada: "x" });
  assert.deepEqual(result, { contextEnabled: true });
  assert.throws(() => governance.validateFeatureFlagsInput({ contextEnabled: "sim" }), /verdadeiro ou falso/);
});

test("validateFeatureFlagsInput aceita controle por Bot das sugestões ao atendente", () => {
  assert.deepEqual(governance.validateFeatureFlagsInput({ agentSuggestionsEnabled: false }), { agentSuggestionsEnabled: false });
});

test("validateFeatureFlagsInput valida faixa de valores numéricos", () => {
  assert.throws(() => governance.validateFeatureFlagsInput({ contextExpirationMinutes: 0 }));
  assert.throws(() => governance.validateFeatureFlagsInput({ maxSwitchesPerWindow: 999 }));
  const ok = governance.validateFeatureFlagsInput({ contextExpirationMinutes: 60 });
  assert.deepEqual(ok, { contextExpirationMinutes: 60 });
});

test("renderPresentationMessage só substitui {{botName}}, ignora outras variáveis", () => {
  const text = governance.renderPresentationMessage("Oi! Sou {{botName}}, {{secret}} e {{botName}} de novo.", { botName: "Mia" });
  assert.equal(text, "Oi! Sou Mia,  e Mia de novo.");
});

test("renderPresentationMessage usa mensagem default quando o Bot não configurou uma", () => {
  const text = governance.renderPresentationMessage(null, { botName: "Mia" });
  assert.match(text, /Mia/);
});

test("governança exige conta Master", () => {
  const nonMaster = { id: "u1", role: "ATENDENTE" };
  assert.throws(() => governance.assertBotManager(nonMaster), (error) => error.statusCode === 403);
});

test("leitura administrativa das configurações globais exige Master", async () => {
  const nonMaster = { id: "u1", role: "ATENDENTE" };
  await assert.rejects(
    () => governance.getGlobalSettingsForManager(nonMaster),
    (error) => error.statusCode === 403,
  );
});
