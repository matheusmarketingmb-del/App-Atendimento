// Contexto real da conversa ("Case State" — item 4 do plano de Inteligência
// de Bots). Memória estruturada do CASO em nível de CONVERSA, independente
// de qual intenção/fluxo está ativo agora: sintoma, produto, aplicativo,
// sistema operacional, perguntas já feitas, soluções já tentadas/falhadas,
// ferramentas usadas, pendências. Nunca decide nada sozinho — é dado que o
// Agent Planner (bot-agent-planner-service.js) consulta antes de perguntar
// ou agir. Persistido em ConversationBotState.caseState (JSON), mesmo ciclo
// de vida/TTL de contextEntities (resetado junto quando a sessão expira).
const { normalizeText } = require("./bot-simulator-service");

// normalizeText (bot-simulator-service.js) não remove pontuação de propósito
// (usada também para comparar mensagens de cliente, onde "?"/"!" às vezes
// importa). Para comparar PERGUNTAS/TENTATIVAS já registradas — onde
// "religou o bluetooth?" e "religou o bluetooth???" são a mesma coisa — este
// módulo usa uma normalização própria, um pouco mais agressiva, só local.
function normalizeForComparison(value) {
  return normalizeText(value).replace(/[^\p{L}\p{N} ]+/gu, "").replace(/\s+/g, " ").trim();
}

function emptyCaseState() {
  return {
    symptom: null,
    product: null,
    app: null,
    os: null,
    questionsAsked: [],
    solutionsTried: [],
    solutionsFailed: [],
    toolsUsed: [],
    pending: [],
  };
}

// Nunca confia em JSON cru vindo do banco sem validar forma — um caseState
// corrompido/de uma versão antiga do shape nunca derruba o motor, só volta
// a ser tratado como vazio.
function normalizeCaseState(raw) {
  const empty = emptyCaseState();
  if (!raw || typeof raw !== "object") return empty;
  return {
    symptom: typeof raw.symptom === "string" ? raw.symptom : null,
    product: typeof raw.product === "string" ? raw.product : null,
    app: typeof raw.app === "string" ? raw.app : null,
    os: typeof raw.os === "string" ? raw.os : null,
    questionsAsked: Array.isArray(raw.questionsAsked) ? raw.questionsAsked.filter((item) => typeof item === "string") : [],
    solutionsTried: Array.isArray(raw.solutionsTried) ? raw.solutionsTried.filter((item) => item && typeof item.description === "string") : [],
    solutionsFailed: Array.isArray(raw.solutionsFailed) ? raw.solutionsFailed.filter((item) => item && typeof item.description === "string") : [],
    toolsUsed: Array.isArray(raw.toolsUsed) ? raw.toolsUsed.filter((item) => typeof item === "string") : [],
    pending: Array.isArray(raw.pending) ? raw.pending.filter((item) => typeof item === "string") : [],
  };
}

function dedupeAppend(list, value, keyFn = (item) => item) {
  const normalizedValue = normalizeForComparison(keyFn(value));
  if (!normalizedValue) return list;
  const exists = list.some((item) => normalizeForComparison(keyFn(item)) === normalizedValue);
  return exists ? list : [...list, value];
}

// Mescla um patch sobre o caso já conhecido — mesma regra de
// mergeContextEntities (bot-conversation-state-service.js): nunca sobrescreve
// um fato já conhecido com vazio/null, e um valor novo sempre pode ATUALIZAR
// um escalar antigo (o cliente trocou de produto/sintoma no meio da
// conversa). Listas (perguntas/tentativas/tools) sempre ACRESCENTAM, nunca
// substituem — são histórico, não um valor único.
function mergeCaseState(existing, patch = {}) {
  const base = normalizeCaseState(existing);
  const merged = { ...base };

  for (const key of ["symptom", "product", "app", "os"]) {
    if (typeof patch[key] === "string" && patch[key].trim()) merged[key] = patch[key].trim();
  }

  for (const question of patch.questionsAsked || []) {
    merged.questionsAsked = dedupeAppend(merged.questionsAsked, question);
  }
  for (const solution of patch.solutionsTried || []) {
    merged.solutionsTried = dedupeAppend(merged.solutionsTried, solution, (item) => item.description);
  }
  for (const solution of patch.solutionsFailed || []) {
    merged.solutionsFailed = dedupeAppend(merged.solutionsFailed, solution, (item) => item.description);
  }
  for (const tool of patch.toolsUsed || []) {
    merged.toolsUsed = dedupeAppend(merged.toolsUsed, tool);
  }
  if (patch.pending) {
    merged.pending = patch.pending.filter((item) => typeof item === "string");
  }

  return merged;
}

function recordQuestionAsked(caseState, questionText) {
  if (!questionText) return caseState;
  return { ...caseState, questionsAsked: dedupeAppend(caseState.questionsAsked, questionText) };
}

function recordSolutionAttempt(caseState, description, outcome, meta = {}) {
  if (!description) return caseState;
  const entry = { description, outcome, at: new Date().toISOString(), ...meta };
  const next = { ...caseState, solutionsTried: dedupeAppend(caseState.solutionsTried, entry, (item) => item.description) };
  if (outcome === "FAILURE") {
    next.solutionsFailed = dedupeAppend(next.solutionsFailed, entry, (item) => item.description);
  }
  return next;
}

// Já foi tentado algo parecido com `description`? Comparação por overlap de
// texto normalizado — tolerante o suficiente para "já desliguei o bluetooth"
// reconhecer uma tentativa registrada como "desligar e religar o bluetooth"
// sem exigir o texto idêntico, mas nunca "adivinha" (exige overlap real).
function wasAlreadyTried(caseState, description) {
  if (!description) return false;
  const normalizedTarget = normalizeForComparison(description);
  const targetTokens = new Set(normalizedTarget.split(/\s+/).filter(Boolean));
  if (!targetTokens.size) return false;
  return (caseState.solutionsTried || []).some((item) => {
    const tokens = normalizeForComparison(item.description).split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    const hits = tokens.filter((token) => targetTokens.has(token)).length;
    // Proporção sobre o que o CLIENTE acabou de descrever (não sobre o
    // registro salvo, que costuma ser mais longo/detalhado) — "já desliguei
    // o bluetooth" é curto de propósito; exigir metade do registro salvo
    // inteiro bateria não reconheceria quase nada.
    return hits / targetTokens.size >= 0.5;
  });
}

function wasAlreadyAsked(caseState, questionText) {
  if (!questionText) return false;
  const normalizedTarget = normalizeForComparison(questionText);
  return (caseState.questionsAsked || []).some((item) => normalizeForComparison(item) === normalizedTarget);
}

async function getCaseState(conversationId, client) {
  const state = await client.conversationBotState.findUnique({
    where: { conversationId }, select: { caseState: true },
  });
  return normalizeCaseState(state?.caseState);
}

module.exports = {
  emptyCaseState,
  normalizeCaseState,
  mergeCaseState,
  recordQuestionAsked,
  recordSolutionAttempt,
  wasAlreadyTried,
  wasAlreadyAsked,
  getCaseState,
};
