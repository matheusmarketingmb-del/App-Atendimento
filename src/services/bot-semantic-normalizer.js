// Camada de ENTENDIMENTO SEMÂNTICO anterior à Intent (Fase 1 do plano de
// Inteligência de Bots). Nunca altera a mensagem original armazenada — só
// gera uma representação normalizada interna, usada exclusivamente para
// classificação/roteamento.
//
// Abordagem híbrida deliberada (item 14 do pedido — "não fazer"): NÃO chama
// embeddings/LLM para toda mensagem. Duas camadas baratas e determinísticas:
//   1) normalização de escrita: abreviação/gíria/typo leve/palavra cortada;
//   2) reconhecimento de CLUSTERS DE CONCEITO: grupos de sinais que, juntos,
//      indicam o mesmo problema mesmo sem vocabulário compartilhado.
// Embeddings/IA externa ficam reservados para quando o Agent Planner
// precisar escalar por ambiguidade (bot-agent-planner-service.js, item 9 —
// fase futura), nunca no caminho quente de toda mensagem.
const { normalizeText } = require("./bot-simulator-service");

// Abreviação/gíria/erro de digitação comuns em português informal de
// WhatsApp. Mapeamento token->token, aplicado sobre o texto já normalizado
// por normalizeText (sem acento, minúsculo, espaços colapsados). Curto de
// propósito — cobre o vocabulário observado nos exemplos do pedido, não é
// uma tentativa de dicionário completo (isso é o que embeddings resolvem
// melhor, na fase futura).
const TOKEN_EXPANSIONS = Object.freeze({
  vc: "voce", vcs: "voces", vcê: "voce",
  pq: "porque", pra: "para", pro: "para",
  n: "nao", ñ: "nao", naum: "nao", num: "nao",
  ta: "esta", to: "estou",
  app: "aplicativo", aplicativo: "aplicativo",
  acha: "encontra", encontrou: "encontra",
  parear: "pareia", pareamento: "pareia", pareado: "pareia",
  conectar: "conecta", conectado: "conecta",
  bluetoh: "bluetooth", bluetoo: "bluetooth", bluetooh: "bluetooth",
  bluetuz: "bluetooth", bluetuth: "bluetooth", blutuz: "bluetooth", blutoh: "bluetooth",
});

// Truncamento ("conect" -> "conecta"): só completa quando o prefixo digitado
// tem pelo menos 5 letras e bate exatamente com o início de uma palavra-base
// conhecida — nunca "adivinha" livre além disso.
const STEM_COMPLETIONS = Object.freeze([
  ["conect", "conecta"],
  ["funcion", "funciona"],
  ["pareamen", "pareia"],
  ["parea", "pareia"],
  ["aparec", "aparece"],
  ["encontr", "encontra"],
]);

function expandToken(token) {
  if (TOKEN_EXPANSIONS[token]) return TOKEN_EXPANSIONS[token];
  for (const [prefix, full] of STEM_COMPLETIONS) {
    if (token.length >= 5 && token.length < full.length && token.startsWith(prefix) && full.startsWith(prefix)) {
      return full;
    }
  }
  return token;
}

// Representação normalizada interna — nunca persistida como substituto da
// mensagem original (quem chama continua gravando Message.text intocado).
function normalizeSemantic(message) {
  const base = normalizeText(message);
  if (!base) return { normalized: "", tokens: [] };
  const tokens = base.split(/\s+/).filter(Boolean).map(expandToken);
  return { normalized: tokens.join(" "), tokens };
}

// Clusters de conceito: cada um define um conjunto de "grupos" de palavras
// (após expandToken) — o cluster bate quando pelo menos um token de CADA
// grupo obrigatório está presente, OU quando um `signature(tokens)` dedicado
// reconhece um padrão que não se encaixa no formato grupo x grupo (ex.:
// "fica procurando e nada", que não tem negação nem verbo de conectividade
// explícito). Isto é só um SINAL AUXILIAR (bot-agent-planner-service.js) —
// nunca decide sozinho a ação nem substitui a Intent.
const CONCEPT_CLUSTERS = Object.freeze([
  {
    id: "CONNECTIVITY_ISSUE",
    label: "Problema de conectividade/pareamento",
    requiredGroups: [
      ["nao"],
      ["conecta", "pareia", "funciona", "aparece", "encontra"],
    ],
    signature: (tokenSet) => tokenSet.has("procurando") && tokenSet.has("nada"),
  },
  {
    id: "APP_ISSUE",
    label: "Problema no aplicativo",
    requiredGroups: [
      ["aplicativo"],
      ["trava", "fecha", "abre", "atualiza", "erro", "lento"],
    ],
    signature: () => false,
  },
  {
    id: "BATTERY_ISSUE",
    label: "Problema de bateria/carga",
    requiredGroups: [
      ["bateria", "carga", "carregador"],
      ["nao", "descarrega", "dura", "acaba"],
    ],
    signature: () => false,
  },
]);

function matchConceptClusters(tokens) {
  const tokenSet = new Set(tokens);
  const matches = [];
  for (const cluster of CONCEPT_CLUSTERS) {
    const groupsHit = cluster.requiredGroups.every((group) => group.some((word) => tokenSet.has(word)));
    if (groupsHit || cluster.signature(tokenSet)) {
      matches.push({ id: cluster.id, label: cluster.label });
    }
  }
  return matches;
}

// Similaridade de conjunto (Jaccard) entre os tokens semânticos de duas
// mensagens — usada como sinal ADICIONAL de ranking de candidatos (nunca no
// lugar do matching lexical existente, ver bot-intent-ranking-service.js).
// Mais tolerante que comparar strings inteiras: ordem das palavras não
// importa, e já opera sobre tokens JÁ expandidos (typo/abreviação).
function tokenSetSimilarity(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union ? intersection / union : 0;
}

// Ponto de entrada único desta camada — usado pelo interpretador (fase 1) e
// pelo simulador (diagnóstico, item 12).
function understandMessage(message) {
  const { normalized, tokens } = normalizeSemantic(message);
  return { original: message, normalized, tokens, concepts: matchConceptClusters(tokens) };
}

module.exports = {
  CONCEPT_CLUSTERS,
  expandToken,
  matchConceptClusters,
  normalizeSemantic,
  tokenSetSimilarity,
  understandMessage,
};
