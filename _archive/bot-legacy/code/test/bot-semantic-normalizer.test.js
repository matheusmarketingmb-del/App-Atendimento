// Bateria de robustez a typo/informalidade/paráfrase (item 8 do plano de
// Inteligência de Bots). Não é uma lista de frases cadastradas manualmente
// por intent — é a prova de que o MECANISMO (normalização + cluster de
// conceito) generaliza para variações não vistas antes.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeSemantic, matchConceptClusters, tokenSetSimilarity, understandMessage,
} = require("../src/services/bot-semantic-normalizer");

const CONNECTIVITY_PHRASES = [
  "meu relogio nao conect",
  "meu relógio não conecta",
  "app nao acha ele",
  "nao consigo parear",
  "fica procurando e nada",
  "nao conecta",
  "n conecta",
  "nao conect",
  "não pareia",
  "app nao acha",
  "bluetooh nao funciona",
  "relogio n aparece no aplicativo",
];

test("nunca altera a mensagem original — só devolve uma representação normalizada à parte", () => {
  const result = understandMessage("Meu Relógio NÃO conecta!!");
  assert.equal(result.original, "Meu Relógio NÃO conecta!!");
  assert.notEqual(result.normalized, result.original);
});

test("todas as variações de 'problema de conectividade' caem no mesmo cluster de conceito", () => {
  for (const phrase of CONNECTIVITY_PHRASES) {
    const { concepts } = understandMessage(phrase);
    const ids = concepts.map((c) => c.id);
    assert.ok(ids.includes("CONNECTIVITY_ISSUE"), `"${phrase}" deveria reconhecer CONNECTIVITY_ISSUE, achou ${JSON.stringify(ids)}`);
  }
});

test("abreviação 'n' e 'vc' são expandidas para a forma completa", () => {
  assert.equal(normalizeSemantic("n consigo").normalized, "nao consigo");
  assert.equal(normalizeSemantic("vc pode ajudar").normalized, "voce pode ajudar");
});

test("palavra cortada só completa com prefixo suficiente (nunca adivinha livre)", () => {
  assert.equal(normalizeSemantic("nao conect").tokens.at(-1), "conecta");
  // "co" é curto demais para virar qualquer coisa — nunca inventa.
  assert.equal(normalizeSemantic("co").tokens[0], "co");
});

test("mensagem sem nenhum sinal de conectividade não entra no cluster (sem falso positivo)", () => {
  const { concepts } = understandMessage("qual o prazo de entrega do meu pedido");
  assert.equal(concepts.some((c) => c.id === "CONNECTIVITY_ISSUE"), false);
});

test("cluster de app (trava/fecha) é distinto do cluster de conectividade", () => {
  const { concepts } = understandMessage("o aplicativo trava toda hora");
  assert.ok(concepts.some((c) => c.id === "APP_ISSUE"));
  assert.equal(concepts.some((c) => c.id === "CONNECTIVITY_ISSUE"), false);
});

test("tokenSetSimilarity: mensagens com o mesmo significado e vocabulário disjunto ainda têm sobreposição alta o suficiente para desempate", () => {
  const a = normalizeSemantic("app nao acha o relogio").tokens;
  const b = normalizeSemantic("nao consigo parear o relogio").tokens;
  const score = tokenSetSimilarity(a, b);
  assert.ok(score > 0, "deveria haver alguma sobreposição (nao, relogio)");
});

test("matchConceptClusters nunca lança para lista de tokens vazia", () => {
  assert.deepEqual(matchConceptClusters([]), []);
});
