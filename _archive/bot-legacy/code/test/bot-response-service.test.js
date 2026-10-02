const test = require("node:test");
const assert = require("node:assert/strict");
const { respond } = require("../src/services/bot-response-service");

function botFixture(overrides = {}) {
  return {
    fallbackMessage: "Não entendi, pode repetir?",
    outsideHoursMessage: "Estamos fora do horário de atendimento.",
    intents: [{ id: "intent-pedido", name: "Acompanhar pedido", responseMessage: "Pode informar o número do pedido?" }],
    ...overrides,
  };
}

test("saudação pura responde com o cumprimento e uma pergunta genérica", () => {
  const text = respond({
    bot: botFixture(),
    decision: { action: "RESPOND", socialBehavior: "GREETING", greetingReply: "Bom dia!" },
    interpretation: { intentId: null },
  });
  assert.equal(text, "Bom dia! Como posso te ajudar?");
});

test("agradecimento puro responde com mensagem curta e não usa fallback do Bot", () => {
  const text = respond({
    bot: botFixture(),
    decision: { action: "RESPOND", socialBehavior: "THANKS" },
    interpretation: { intentId: null },
  });
  assert.match(text, /por nada/i);
});

test("saudação combinada com intenção prefixa a resposta configurada da intenção", () => {
  const text = respond({
    bot: botFixture(),
    decision: { action: "RESPOND", socialBehavior: "GREETING", greetingReply: "Boa tarde!", categoryId: null },
    interpretation: { intentId: "intent-pedido" },
  });
  assert.equal(text, "Boa tarde! Pode informar o número do pedido?");
});

test("negação em esclarecimento usa pergunta própria, não a genérica de baixa confiança", () => {
  const text = respond({
    bot: botFixture(),
    decision: { action: "ASK_CLARIFICATION", socialBehavior: "NEGATION", failureCount: 1 },
    interpretation: { intentId: null },
  });
  assert.match(text, /pode me contar/i);
});

test("HANDOFF_HUMAN nunca usa o fallback do Bot", () => {
  const text = respond({
    bot: botFixture(),
    decision: { action: "HANDOFF_HUMAN" },
    interpretation: { intentId: null },
  });
  assert.match(text, /atendente/i);
});
