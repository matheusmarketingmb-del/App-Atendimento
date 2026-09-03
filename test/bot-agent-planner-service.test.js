// Agent Planner (item 3 do plano de Inteligência de Bots) — testado
// isoladamente, sem banco: recebe uma `interpretation` já pronta (o formato
// que bot-interpreter-service.js#interpret() produz) e um Case State, e
// devolve a estrutura pedida (action/reason/intent/confidence/
// requiredInformation/knownEntities/missingEntities/toolName/handoffReason).
const test = require("node:test");
const assert = require("node:assert/strict");
const { plan, PLANNER_ACTIONS } = require("../src/services/bot-agent-planner-service");
const { emptyCaseState } = require("../src/services/bot-case-state-service");

function botFixture(overrides = {}) {
  return {
    id: "bot-1",
    intents: [
      { id: "intent-conectividade", name: "Problema de conectividade", categoryId: null, toolName: null, responseMessage: null },
      { id: "intent-pedido", name: "Acompanhar pedido", categoryId: null, toolName: "OrderTool", responseMessage: null },
      { id: "intent-garantia", name: "Garantia", categoryId: null, toolName: null, responseMessage: "Sua garantia é de 12 meses." },
    ],
    ...overrides,
  };
}

function interpretationFixture(overrides = {}) {
  return {
    intentId: null, confidence: 0, entities: {}, socialBehavior: null,
    intentCandidates: [], intentStatus: "UNKNOWN",
    ...overrides,
  };
}

test("action ∈ vocabulário fechado pedido", () => {
  assert.deepEqual(
    [...PLANNER_ACTIONS].sort(),
    ["ASK", "CLARIFY", "HANDOFF", "RESOLVE", "RESPOND", "SEARCH_KNOWLEDGE", "USE_TOOL", "WAIT"].sort(),
  );
});

test("HUMAN_REQUEST sempre vira HANDOFF, mesmo sem nenhuma intent candidata", () => {
  const result = plan({
    bot: botFixture(),
    interpretation: interpretationFixture({ socialBehavior: "HUMAN_REQUEST" }),
    caseState: emptyCaseState(),
  });
  assert.equal(result.action, "HANDOFF");
  assert.equal(result.handoffReason, "CUSTOMER_REQUESTED_HUMAN");
});

test("status UNKNOWN vira CLARIFY (nunca finge que entendeu)", () => {
  const result = plan({ bot: botFixture(), interpretation: interpretationFixture(), caseState: emptyCaseState() });
  assert.equal(result.action, "CLARIFY");
  assert.equal(result.requiredInformation, "topic");
});

test("status AMBIGUOUS vira CLARIFY citando os dois candidatos (nunca escolhe no escuro)", () => {
  const interpretation = interpretationFixture({
    intentStatus: "AMBIGUOUS",
    intentCandidates: [
      { intentId: "intent-conectividade", intentName: "Problema de conectividade", confidence: 0.62 },
      { intentId: "intent-garantia", intentName: "Garantia", confidence: 0.58 },
    ],
  });
  const result = plan({ bot: botFixture(), interpretation, caseState: emptyCaseState() });
  assert.equal(result.action, "CLARIFY");
  assert.equal(result.candidates.length, 2);
  assert.match(result.reason, /Problema de conectividade.*Garantia|Garantia.*Problema de conectividade/);
});

test("intent com resposta fixa configurada -> RESPOND", () => {
  const interpretation = interpretationFixture({
    intentStatus: "OK",
    intentCandidates: [{ intentId: "intent-garantia", intentName: "Garantia", confidence: 0.9 }],
  });
  const result = plan({ bot: botFixture(), interpretation, caseState: emptyCaseState() });
  assert.equal(result.action, "RESPOND");
  assert.equal(result.intent.id, "intent-garantia");
});

test("intent sem resposta fixa nem Tool -> SEARCH_KNOWLEDGE (nunca inventa, aponta para buscar)", () => {
  const interpretation = interpretationFixture({
    intentStatus: "OK",
    intentCandidates: [{ intentId: "intent-conectividade", intentName: "Problema de conectividade", confidence: 0.9 }],
  });
  const result = plan({ bot: botFixture(), interpretation, caseState: emptyCaseState() });
  assert.equal(result.action, "SEARCH_KNOWLEDGE");
});

test("intent com Tool e entidade obrigatória faltando -> ASK (nunca chama a Tool sem dado)", () => {
  const interpretation = interpretationFixture({
    intentStatus: "OK", entities: {},
    intentCandidates: [{ intentId: "intent-pedido", intentName: "Acompanhar pedido", confidence: 0.9 }],
  });
  const result = plan({ bot: botFixture(), interpretation, caseState: emptyCaseState() });
  assert.equal(result.action, "ASK");
  assert.ok(result.missingEntities.length > 0);
  assert.equal(result.toolName, "OrderTool");
});

test("intent com Tool e entidade já presente na mensagem -> USE_TOOL direto", () => {
  const interpretation = interpretationFixture({
    intentStatus: "OK", entities: { orderNumber: "123456" },
    intentCandidates: [{ intentId: "intent-pedido", intentName: "Acompanhar pedido", confidence: 0.9 }],
  });
  const result = plan({ bot: botFixture(), interpretation, caseState: emptyCaseState() });
  assert.equal(result.action, "USE_TOOL");
  assert.equal(result.knownEntities.orderNumber, "123456");
});

test("produto já conhecido pelo Case State entra em knownEntities sem precisar vir na mensagem", () => {
  const interpretation = interpretationFixture({
    intentStatus: "OK", entities: {},
    intentCandidates: [{ intentId: "intent-conectividade", intentName: "Problema de conectividade", confidence: 0.9 }],
  });
  const caseState = { ...emptyCaseState(), product: "GS Pro 2" };
  const result = plan({ bot: botFixture(), interpretation, caseState });
  assert.equal(result.knownEntities.productName, "GS Pro 2");
});

test("candidato aponta para uma intent que não existe mais no Bot -> CLARIFY seguro (nunca lança)", () => {
  const interpretation = interpretationFixture({
    intentStatus: "OK",
    intentCandidates: [{ intentId: "intent-removida", intentName: "Removida", confidence: 0.9 }],
  });
  const result = plan({ bot: botFixture(), interpretation, caseState: emptyCaseState() });
  assert.equal(result.action, "CLARIFY");
});
