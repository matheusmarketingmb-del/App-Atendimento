const test = require("node:test");
const assert = require("node:assert/strict");
const { validate, applyKnowledgeGuard } = require("../src/services/bot-ai-schema-service");

test("rejeita objeto sem action válida", () => {
  assert.equal(validate({ confidence: 0.9 }).valid, false);
  assert.equal(validate({ action: "INVENTAR", confidence: 0.9 }).valid, false);
});

test("rejeita confidence fora de 0..1", () => {
  assert.equal(validate({ action: "ASK", confidence: 1.5, entities: {}, missingInformation: [] }).valid, false);
  assert.equal(validate({ action: "ASK", confidence: -0.1, entities: {}, missingInformation: [] }).valid, false);
});

test("action=RESPOND sem texto de resposta é inválido", () => {
  const result = validate({ action: "RESPOND", confidence: 0.9, entities: {}, missingInformation: [], response: "" });
  assert.equal(result.valid, false);
});

test("action=HANDOFF sem motivo é inválido", () => {
  const result = validate({ action: "HANDOFF", confidence: 0.9, entities: {}, missingInformation: [] });
  assert.equal(result.valid, false);
});

test("aceita RESPOND válido e normaliza campos ausentes", () => {
  const result = validate({ action: "RESPOND", confidence: 0.8, entities: { productName: "GS Pro 2" }, missingInformation: [], response: "Olá!" });
  assert.equal(result.valid, true);
  assert.deepEqual(result.value.entities, { productName: "GS Pro 2" });
  assert.equal(result.value.intent, null);
  assert.equal(result.value.handoffReason, null);
});

test("applyKnowledgeGuard nunca deixa RESPOND passar sem nenhum trecho de Knowledge", () => {
  const value = { action: "RESPOND", response: "Texto qualquer", missingInformation: [], handoffReason: null };
  const guarded = applyKnowledgeGuard(value, []);
  assert.equal(guarded.action, "HANDOFF");
  assert.ok(guarded.handoffReason);
});

test("applyKnowledgeGuard rebaixa para ASK quando há informação faltante sinalizada", () => {
  const value = { action: "RESPOND", response: "Texto", missingInformation: ["modelo do produto"], handoffReason: null };
  const guarded = applyKnowledgeGuard(value, []);
  assert.equal(guarded.action, "ASK");
});

test("applyKnowledgeGuard não mexe em RESPOND quando há Knowledge recuperada", () => {
  const value = { action: "RESPOND", response: "Texto", missingInformation: [], handoffReason: null };
  const guarded = applyKnowledgeGuard(value, [{ id: "k1", title: "Garantia", content: "..." }]);
  assert.equal(guarded.action, "RESPOND");
});

test("applyKnowledgeGuard nunca altera ações que não são RESPOND", () => {
  const value = { action: "HANDOFF", handoffReason: "motivo", missingInformation: [] };
  const guarded = applyKnowledgeGuard(value, []);
  assert.equal(guarded.action, "HANDOFF");
});
