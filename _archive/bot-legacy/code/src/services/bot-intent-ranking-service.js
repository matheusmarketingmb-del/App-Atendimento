// Intent como SINAL, não como resposta (Fase 1, item 2 do plano). Gera até N
// candidatos com evidência, em vez do único vencedor que
// LocalFallbackProvider#classifyIntent devolve hoje (mantido intocado, ainda
// usado por interpretWithProviders() para o caminho já existente — este
// módulo é ADITIVO, nunca substitui aquele contrato).
//
// Reaproveita INTEGRALMENTE a heurística léxica já validada (similarity() —
// Levenshtein + overlap de tokens) e SOMA um sinal semântico barato
// (tokenSetSimilarity sobre texto já normalizado por
// bot-semantic-normalizer.js) — nunca troca a heurística lexical por
// embeddings/IA (isso é a fase 9, e mesmo lá é só escalonamento).
const { similarity } = require("./ai/local-fallback-provider");
const { normalizeText } = require("./bot-simulator-service");
const { normalizeSemantic, tokenSetSimilarity, matchConceptClusters } = require("./bot-semantic-normalizer");

const MAX_CANDIDATES = 3;
// Abaixo disto, mesmo o melhor candidato não é considerado "reconhecido" —
// mesmo limite de baixa confiança já usado no motor local
// (LocalFallbackProvider só aceita >= 0.4).
const MIN_CANDIDATE_SCORE = 0.4;
// Faixa em que dois candidatos são "parecidos demais" para escolher um
// sozinho — cliente de AMBIGUOUS (item 2: "permitir UNKNOWN/AMBIGUOUS").
const AMBIGUITY_GAP = 0.12;

// Combina o score lexical existente com um pequeno boost semântico: mesmo
// cluster de conceito entre a mensagem e o exemplo, ou alta sobreposição de
// tokens já expandidos (typo/abreviação resolvidos). O boost nunca domina o
// score lexical — é só o desempate que a mensagem "meu relogio nao conect"
// precisa para vencer um exemplo cadastrado como "relógio não conecta".
function scoreExample(messageSemantic, example) {
  const normalizedMessage = normalizeText(messageSemantic.original);
  const normalizedExample = normalizeText(example.text);
  const lexicalScore = similarity(normalizedMessage, normalizedExample);

  const exampleSemantic = normalizeSemantic(example.text);
  const semanticOverlap = tokenSetSimilarity(messageSemantic.tokens, exampleSemantic.tokens);
  const exampleConcepts = new Set(matchConceptClusters(exampleSemantic.tokens).map((c) => c.id));
  const sharedConcept = messageSemantic.concepts.some((c) => exampleConcepts.has(c.id));

  const semanticBoost = (sharedConcept ? 0.15 : 0) + semanticOverlap * 0.1;
  return Math.min(1, lexicalScore + semanticBoost);
}

// Retorna { candidates, status } — `candidates` ordenados por score desc,
// no máximo MAX_CANDIDATES, cada um com `evidence` (exemplo que mais
// contribuiu + se veio de um cluster de conceito compartilhado).
// `status`: "OK" (um candidato claramente à frente), "AMBIGUOUS" (dois ou
// mais muito próximos) ou "UNKNOWN" (nada bateu o mínimo).
function rankIntentCandidates(bot, message) {
  const messageSemantic = { original: message, ...normalizeSemantic(message) };
  messageSemantic.concepts = matchConceptClusters(messageSemantic.tokens);

  const scored = [];
  for (const intent of bot.intents || []) {
    if (!intent.active) continue;
    let best = null;
    for (const example of intent.examples || []) {
      const score = scoreExample(messageSemantic, example);
      if (!best || score > best.score) best = { example, score };
    }
    if (best) scored.push({ intentId: intent.id, intentName: intent.name, score: best.score, matchedExample: best.example.text });
  }

  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.filter((item) => item.score >= MIN_CANDIDATE_SCORE).slice(0, MAX_CANDIDATES).map((item) => ({
    intentId: item.intentId,
    intentName: item.intentName,
    confidence: Math.min(1, item.score),
    evidence: { matchedExample: item.matchedExample, sharedConcepts: messageSemantic.concepts.map((c) => c.id) },
  }));

  let status = "UNKNOWN";
  if (candidates.length === 1) status = "OK";
  if (candidates.length >= 2) {
    status = (candidates[0].confidence - candidates[1].confidence) < AMBIGUITY_GAP ? "AMBIGUOUS" : "OK";
  }

  return { candidates, status, semantic: messageSemantic };
}

module.exports = { rankIntentCandidates, MAX_CANDIDATES, MIN_CANDIDATE_SCORE, AMBIGUITY_GAP };
