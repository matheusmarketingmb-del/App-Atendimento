const test = require("node:test");
const assert = require("node:assert/strict");
const { decide } = require("../src/services/bot-decision-service");

function botFixture(overrides = {}) {
  return {
    id: "bot-1",
    status: "ACTIVE",
    timezone: "America/Sao_Paulo",
    highConfidenceThreshold: 0.8,
    lowConfidenceThreshold: 0.55,
    defaultCategoryId: "cat-default",
    schedules: [],
    intents: [{
      id: "intent-pedido", name: "Acompanhar pedido", categoryId: "cat-pedidos",
      fallbackAction: "USE_BOT_FALLBACK",
    }],
    ...overrides,
  };
}

function interpretationFixture(overrides = {}) {
  return { intentId: "intent-pedido", confidence: 0.9, entities: {}, ...overrides };
}

test("confiança alta aceita a intenção e responde", () => {
  const decision = decide({ bot: botFixture(), interpretation: interpretationFixture({ confidence: 0.9 }), message: "onde esta meu pedido" });
  assert.equal(decision.action, "RESPOND");
});

test("confiança média pede esclarecimento", () => {
  const decision = decide({ bot: botFixture(), interpretation: interpretationFixture({ confidence: 0.6 }), message: "talvez seja sobre meu pedido" });
  assert.equal(decision.action, "ASK_CLARIFICATION");
  assert.equal(decision.needsClarification, true);
});

test("confiança baixa não assume a intenção (1ª falha pede esclarecimento)", () => {
  const decision = decide({ bot: botFixture(), interpretation: interpretationFixture({ confidence: 0.2 }), message: "hmm" });
  assert.equal(decision.action, "ASK_CLARIFICATION");
});

test("terceira falha consecutiva encaminha para humano", () => {
  const state = { failedInterpretations: 2 };
  const decision = decide({
    bot: botFixture(), interpretation: { intentId: null, confidence: 0 }, message: "nao entendi nada", state,
  });
  assert.equal(decision.action, "HANDOFF_HUMAN");
  assert.equal(decision.shouldHandoff, true);
  assert.equal(decision.failureCount, 3);
});

test("bot pausado nunca age, mesmo com intenção clara", () => {
  const decision = decide({
    bot: botFixture({ status: "PAUSED" }), interpretation: interpretationFixture({ confidence: 0.99 }), message: "onde esta meu pedido",
  });
  assert.equal(decision.action, "NO_ACTION");
});

test("pedido explícito de atendente humano tem prioridade sobre a intenção", () => {
  const decision = decide({
    bot: botFixture(), interpretation: interpretationFixture({ confidence: 0.95 }), message: "quero falar com um atendente, por favor",
  });
  assert.equal(decision.action, "HANDOFF_HUMAN");
  assert.equal(decision.shouldHandoff, true);
  assert.equal(decision.withinHours, true);
});

test("intenção configurada para transferir para categoria sugere troca de Bot", () => {
  const bot = botFixture({
    intents: [{
      id: "intent-pedido", name: "Acompanhar pedido", categoryId: "cat-pedidos",
      fallbackAction: "TRANSFER_TO_CATEGORY",
    }],
  });
  const decision = decide({ bot, interpretation: interpretationFixture({ confidence: 0.9 }), message: "onde esta meu pedido" });
  assert.equal(decision.action, "SWITCH_BOT");
  assert.equal(decision.categoryId, "cat-pedidos");
});

test("fora do horário configurado, a ação usa a mensagem de fora do horário", () => {
  const bot = botFixture({
    schedules: [{ dayOfWeek: 0, enabled: true, startTime: "08:00", endTime: "09:00" }],
  });
  const decision = decide({
    bot, interpretation: interpretationFixture({ confidence: 0.9 }), message: "onde esta meu pedido",
    now: new Date("2026-08-23T23:00:00.000Z"),
  });
  assert.equal(decision.outsideHours, true);
});

test("mensagem puramente social (saudação) responde sem contar como falha de interpretação", () => {
  const decision = decide({
    bot: botFixture(), interpretation: { intentId: null, confidence: 0 }, message: "bom dia",
  });
  assert.equal(decision.action, "RESPOND");
  assert.equal(decision.socialBehavior, "GREETING");
  assert.equal(decision.greetingReply, "Bom dia!");
});

test("agradecimento puro responde sem alterar categoria", () => {
  const decision = decide({
    bot: botFixture(), interpretation: { intentId: null, confidence: 0 }, message: "muito obrigado",
  });
  assert.equal(decision.action, "RESPOND");
  assert.equal(decision.categoryId, null);
  assert.equal(decision.socialBehavior, "THANKS");
});

test("despedida não finaliza a conversa (decisão não sinaliza handoff nem categoria)", () => {
  const decision = decide({
    bot: botFixture(), interpretation: { intentId: null, confidence: 0 }, message: "tchau, até mais",
  });
  assert.equal(decision.action, "RESPOND");
  assert.equal(decision.shouldHandoff, false);
  assert.equal(decision.categoryId, null);
  assert.equal(decision.socialBehavior, "GOODBYE");
});

test("saudação combinada com intenção de negócio segue o fluxo normal de confiança", () => {
  const decision = decide({
    bot: botFixture(), interpretation: interpretationFixture({ confidence: 0.9 }), message: "boa tarde, onde esta meu pedido",
  });
  assert.equal(decision.action, "RESPOND");
  assert.equal(decision.greetingReply, "Boa tarde!");
});

test("negação em contexto de esclarecimento pede para o cliente descrever de novo", () => {
  const state = { failedInterpretations: 0 };
  const decision = decide({
    bot: botFixture(), interpretation: { intentId: null, confidence: 0 }, message: "não é isso", state,
  });
  assert.equal(decision.action, "ASK_CLARIFICATION");
  assert.equal(decision.socialBehavior, "NEGATION");
});

test("fora do horário, pedido de humano não promete transferência imediata", () => {
  const bot = botFixture({
    schedules: [{ dayOfWeek: 0, enabled: true, startTime: "08:00", endTime: "09:00" }],
  });
  const decision = decide({
    bot, interpretation: interpretationFixture({ confidence: 0.95 }),
    message: "quero falar com um atendente",
    now: new Date("2026-08-23T23:00:00.000Z"),
  });
  assert.equal(decision.action, "RESPOND");
  assert.equal(decision.outsideHours, true);
  assert.equal(decision.shouldHandoff, false);
});
