const test = require("node:test");
const assert = require("node:assert/strict");
const {
  emptyCaseState, mergeCaseState, recordQuestionAsked, recordSolutionAttempt,
  wasAlreadyTried, wasAlreadyAsked, normalizeCaseState,
} = require("../src/services/bot-case-state-service");

test("caseState vazio nunca lança e tem o shape completo", () => {
  const empty = emptyCaseState();
  assert.deepEqual(empty, {
    symptom: null, product: null, app: null, os: null,
    questionsAsked: [], solutionsTried: [], solutionsFailed: [], toolsUsed: [], pending: [],
  });
});

test("normalizeCaseState nunca quebra com JSON inválido/corrompido — volta a caso vazio", () => {
  assert.deepEqual(normalizeCaseState(null), emptyCaseState());
  assert.deepEqual(normalizeCaseState("string solta"), emptyCaseState());
  assert.deepEqual(normalizeCaseState({ product: 123, questionsAsked: "não é array" }), emptyCaseState());
});

test("mergeCaseState nunca sobrescreve um fato já conhecido com vazio/null", () => {
  const known = mergeCaseState(emptyCaseState(), { product: "GS Pro 2" });
  const afterEmptyPatch = mergeCaseState(known, { product: "" });
  assert.equal(afterEmptyPatch.product, "GS Pro 2");
});

test("mergeCaseState permite ATUALIZAR um escalar (cliente trocou de produto)", () => {
  const known = mergeCaseState(emptyCaseState(), { product: "GS Pro 2" });
  const updated = mergeCaseState(known, { product: "Mibro Fit" });
  assert.equal(updated.product, "Mibro Fit");
});

test("listas (perguntas/tentativas) sempre ACRESCENTAM, nunca substituem", () => {
  let state = emptyCaseState();
  state = recordQuestionAsked(state, "Qual é o modelo do seu relógio?");
  state = recordQuestionAsked(state, "Qual aplicativo você está usando?");
  assert.equal(state.questionsAsked.length, 2);
});

test("recordQuestionAsked nunca duplica a mesma pergunta (comparação normalizada)", () => {
  let state = emptyCaseState();
  state = recordQuestionAsked(state, "Qual é o modelo do seu relógio?");
  state = recordQuestionAsked(state, "qual é o modelo do seu relógio???");
  assert.equal(state.questionsAsked.length, 1);
});

test("wasAlreadyAsked reconhece a mesma pergunta já registrada", () => {
  let state = emptyCaseState();
  state = recordQuestionAsked(state, "Você já desligou o bluetooth e ligou de novo?");
  assert.equal(wasAlreadyAsked(state, "voce ja desligou o bluetooth e ligou de novo"), true);
  assert.equal(wasAlreadyAsked(state, "qual o numero do pedido"), false);
});

test("recordSolutionAttempt registra em solutionsTried, e em solutionsFailed só quando falhou", () => {
  let state = emptyCaseState();
  state = recordSolutionAttempt(state, "desligar e religar o bluetooth", "FAILURE");
  assert.equal(state.solutionsTried.length, 1);
  assert.equal(state.solutionsFailed.length, 1);

  state = recordSolutionAttempt(state, "reinstalar o aplicativo", "SUCCESS");
  assert.equal(state.solutionsTried.length, 2);
  assert.equal(state.solutionsFailed.length, 1, "sucesso não deveria entrar em solutionsFailed");
});

test("item 13 — 'já desliguei o bluetooth' reconhece uma tentativa já registrada (não manda repetir)", () => {
  let state = emptyCaseState();
  state = recordSolutionAttempt(state, "desligar o bluetooth e ligar de novo", "FAILURE");
  assert.equal(wasAlreadyTried(state, "já desliguei o bluetooth"), true);
  assert.equal(wasAlreadyTried(state, "já reiniciei o celular"), false);
});
