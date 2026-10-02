const test = require("node:test");
const assert = require("node:assert/strict");
const { rankIntentCandidates } = require("../src/services/bot-intent-ranking-service");

function botFixture() {
  return {
    intents: [
      {
        id: "intent-conectividade", name: "Problema de conectividade", active: true,
        examples: [
          { id: "ex1", text: "relógio não conecta" },
          { id: "ex2", text: "não consigo parear o relógio" },
          { id: "ex3", text: "bluetooth não funciona" },
        ],
      },
      {
        id: "intent-pedido", name: "Acompanhar pedido", active: true,
        examples: [
          { id: "ex4", text: "onde está meu pedido" },
          { id: "ex5", text: "quero rastrear a entrega" },
        ],
      },
    ],
  };
}

test("mensagem com typo forte ainda reconhece a intent certa como candidata top-1", () => {
  const { candidates, status } = rankIntentCandidates(botFixture(), "meu relogio nao conect");
  assert.ok(candidates.length >= 1);
  assert.equal(candidates[0].intentId, "intent-conectividade");
  assert.equal(status, "OK");
});

test("paráfrase sem vocabulário compartilhado ainda aparece entre os candidatos (boost semântico)", () => {
  const { candidates } = rankIntentCandidates(botFixture(), "app nao acha o relogio de jeito nenhum");
  const found = candidates.find((c) => c.intentId === "intent-conectividade");
  assert.ok(found, `esperava intent-conectividade entre os candidatos, achou ${JSON.stringify(candidates)}`);
});

test("mensagem sem relação nenhuma com nenhuma intent -> status UNKNOWN, sem candidatos", () => {
  const { candidates, status } = rankIntentCandidates(botFixture(), "qual o horario de funcionamento da loja fisica");
  assert.equal(candidates.length, 0);
  assert.equal(status, "UNKNOWN");
});

test("cada candidato traz evidência (exemplo casado)", () => {
  const { candidates } = rankIntentCandidates(botFixture(), "onde esta meu pedido");
  assert.ok(candidates[0].evidence.matchedExample);
});

test("intent inativa nunca vira candidata", () => {
  const bot = botFixture();
  bot.intents[0].active = false;
  const { candidates } = rankIntentCandidates(bot, "meu relogio nao conecta");
  assert.equal(candidates.some((c) => c.intentId === "intent-conectividade"), false);
});
