// Testa a origem (`source`) do texto calculado por bot-response-service.js —
// é o que bot-orchestrator-service.js usa para decidir se a Personalidade
// pode reescrever o tom (ver isPersonalityEligible). Garante estruturalmente
// que Flow Engine/Tool/handoff/esclarecimento/social/fora-do-horário NUNCA
// são elegíveis, então a personalidade jamais pode alterar esses textos —
// nem que o código futuro esqueça de checar isso em algum outro ponto.
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeResponse, isPersonalityEligible } = require("../src/services/bot-response-service");

function botFixture(overrides = {}) {
  return {
    fallbackMessage: "Não entendi, pode repetir?",
    outsideHoursMessage: "Estamos fora do horário de atendimento.",
    intents: [{ id: "intent-pedido", name: "Acompanhar pedido", responseMessage: "Pode informar o número do pedido?" }],
    ...overrides,
  };
}

test("HANDOFF_HUMAN nunca é elegível para reescrita de personalidade", () => {
  const result = computeResponse({
    bot: botFixture(), decision: { action: "HANDOFF_HUMAN" }, interpretation: { intentId: null },
  });
  assert.equal(result.source, "HANDOFF");
  assert.equal(isPersonalityEligible(result.source), false);
});

test("Flow Engine (flowResponseText) nunca é elegível", () => {
  const result = computeResponse({
    bot: botFixture(),
    decision: { action: "RESPOND", flowResponseText: "Qual o número de série do produto?" },
    interpretation: { intentId: "intent-pedido" },
  });
  assert.equal(result.source, "FLOW");
  assert.equal(isPersonalityEligible(result.source), false);
});

test("Resultado de Tool (toolResponseText) nunca é elegível — é dado real, não pode ser reescrito com risco de alterar o fato", () => {
  const result = computeResponse({
    bot: botFixture(),
    decision: { action: "RESPOND", toolResponseText: "Seu pedido 123 está em transporte." },
    interpretation: { intentId: "intent-pedido" },
  });
  assert.equal(result.source, "TOOL");
  assert.equal(isPersonalityEligible(result.source), false);
});

test("Esclarecimento (ASK_CLARIFICATION) nunca é elegível", () => {
  const result = computeResponse({
    bot: botFixture(), decision: { action: "ASK_CLARIFICATION", failureCount: 1 }, interpretation: { intentId: null },
  });
  assert.equal(result.source, "CLARIFICATION");
  assert.equal(isPersonalityEligible(result.source), false);
});

test("Resposta social pura (THANKS) nunca é elegível", () => {
  const result = computeResponse({
    bot: botFixture(), decision: { action: "RESPOND", socialBehavior: "THANKS" }, interpretation: { intentId: null },
  });
  assert.equal(result.source, "SOCIAL");
  assert.equal(isPersonalityEligible(result.source), false);
});

test("Fora do horário nunca é elegível", () => {
  const result = computeResponse({
    bot: botFixture(), decision: { action: "RESPOND", outsideHours: true }, interpretation: { intentId: null },
  });
  assert.equal(result.source, "OUTSIDE_HOURS");
  assert.equal(isPersonalityEligible(result.source), false);
});

test("Resposta vinda da Base de Conhecimento É elegível para reescrita de tom", () => {
  const result = computeResponse({
    bot: botFixture(),
    decision: { action: "RESPOND", knowledgeResponseText: "A garantia é de 12 meses." },
    interpretation: { intentId: "intent-pedido" },
  });
  assert.equal(result.source, "KNOWLEDGE");
  assert.equal(isPersonalityEligible(result.source), true);
});

test("Resposta fixa de intenção/fallback É elegível para reescrita de tom", () => {
  const result = computeResponse({
    bot: botFixture(), decision: { action: "RESPOND" }, interpretation: { intentId: "intent-pedido" },
  });
  assert.equal(result.source, "INTENT_OR_FALLBACK");
  assert.equal(isPersonalityEligible(result.source), true);
});

test("respond() continua devolvendo só o texto (comportamento antigo intacto)", () => {
  const { respond } = require("../src/services/bot-response-service");
  const text = respond({
    bot: botFixture(), decision: { action: "HANDOFF_HUMAN" }, interpretation: { intentId: null },
  });
  assert.match(text, /atendente/i);
});
