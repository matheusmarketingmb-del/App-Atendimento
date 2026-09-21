// Endurece a saída estruturada do RAG Server (Python, rag/answer_with_ai.py)
// DEPOIS que ela chega no app — nunca dentro do RAG (não alterado por
// pedido explícito). O LLM decide action/confidence/needsHuman/reason
// livremente ali; aqui é onde garantimos que esses campos não se
// contradizem entre si, e principalmente que um HANDOFF só sobrevive
// quando há EVIDÊNCIA real na mensagem — não só porque o LLM "achou".
//
// Os fast paths determinísticos (pedido de humano, risco, confirmação de
// solução, status de pedido sem ferramenta) agora vivem em
// planner-hint-service.js e rodam ANTES de qualquer chamada ao RAG/Qwen —
// este módulo reaproveita os MESMOS sinais (detectedSignals) para validar
// o que o LLM decidiu, sem duplicar a lógica de detecção.
const {
  computePlannerHint, handoffHasEvidence, reasonFromSignals, looksLikeTroubleshootingAnswer,
} = require("./planner-hint-service");

const VALID_ACTIONS = new Set(["RESPOND", "ASK", "CLARIFY", "HANDOFF", "WAIT", "RESOLVE"]);
const VALID_CONFIDENCE = new Set(["HIGH", "MEDIUM", "LOW"]);

// Vocabulário canônico de `reason` por `action`. Só uso interno/auditoria —
// nunca mostrado ao cliente (mesma regra já aplicada no RAG Server).
const REASON_ALLOWLIST = {
  RESPOND: ["confirmed_product_info", "policy_explanation", "commercial_guidance", "order_process_info", "general_info"],
  ASK: ["missing_product", "missing_order_number", "missing_required_detail"],
  CLARIFY: ["ambiguous_request", "ambiguous_product", "ambiguous_intent"],
  WAIT: ["safe_troubleshooting", "waiting_customer_test", "waiting_external_update"],
  HANDOFF: [
    "customer_requested_human", "safety_issue", "warranty_review", "payment_issue", "logistics_issue",
    "commercial_negotiation", "low_confidence", "tool_failure",
  ],
  RESOLVE: ["issue_resolved", "customer_confirmed_solution"],
};

// Default "genérico" por action — só usado quando nenhum sinal detectado
// sustenta um reason mais específico (ver reasonFromSignals).
const DEFAULT_REASON_BY_ACTION = {
  RESPOND: "general_info",
  ASK: "missing_required_detail",
  CLARIFY: "ambiguous_request",
  WAIT: "waiting_customer_test",
  HANDOFF: "low_confidence",
  RESOLVE: "issue_resolved",
};

// Nomes que o RAG Server já usa hoje (fast paths internos/casos sem
// resultado) mapeados para o vocabulário canônico acima — harmoniza sem
// precisar tocar no RAG.
const REASON_ALIASES = {
  safety_hazard: "safety_issue",
  weak_context: "low_confidence",
  no_knowledge_found: "low_confidence",
  parse_error: "tool_failure",
};

// Abaixo deste número de fontes recuperadas, HIGH nunca é uma confiança
// honesta — o retrieval não trouxe base suficiente para "certeza". Não é um
// score matemático, só um piso de bom senso (item "sinais determinísticos:
// número de chunks relevantes").
const MIN_SOURCES_FOR_HIGH_CONFIDENCE = 2;

function canonicalReason(reason) {
  if (typeof reason !== "string" || !reason) return null;
  return Object.prototype.hasOwnProperty.call(REASON_ALIASES, reason) ? REASON_ALIASES[reason] : reason;
}

function resolveReasonForAction(reason, action, signals) {
  if (REASON_ALLOWLIST[action].includes(reason)) return reason;
  return reasonFromSignals(signals, REASON_ALLOWLIST[action]) || DEFAULT_REASON_BY_ACTION[action];
}

// Núcleo puro (sem I/O) — testável isoladamente. `message`/`history` são o
// texto atual do cliente e o histórico já recortado (mesmo formato de
// askRag) — usados só para computar `detectedSignals` (ou reaproveita os
// já calculados, se quem chamar já tiver rodado computePlannerHint antes).
function normalizePlannerOutput({ message = "", history = [], signals: providedSignals, result }) {
  const corrections = [];
  const signals = providedSignals || computePlannerHint({ message, history }).detectedSignals;

  const actionWasInvalid = !VALID_ACTIONS.has(result?.action);
  let action = actionWasInvalid ? "HANDOFF" : result.action;
  let confidence = VALID_CONFIDENCE.has(result?.confidence) ? result.confidence : "LOW";
  let reason = canonicalReason(result?.reason) || DEFAULT_REASON_BY_ACTION[action];

  if (actionWasInvalid) corrections.push("invalid_action");
  if (!VALID_CONFIDENCE.has(result?.confidence)) corrections.push("invalid_confidence");

  // 1) HANDOFF exige evidência real — nunca sobrevive só porque o LLM
  // "achou" que precisava. Sem nenhum sinal (nem um reason já confiável
  // vindo do RAG Server), reavalia para CLARIFY (se a base estava fraca) ou
  // RESPOND (se havia contexto suficiente — provável que o texto já
  // estivesse correto e só a classificação estrutural tivesse errado, o bug
  // relatado: "quanto custa o Lite 3 Pro?" → HANDOFF indevido). Exceção: um
  // `action` que nem chegou válido do provider é falha de sistema, não
  // decisão do LLM — o HANDOFF de segurança aqui nunca é reavaliado.
  if (action === "HANDOFF" && !actionWasInvalid && !handoffHasEvidence(signals, reason)) {
    action = confidence === "LOW" ? "CLARIFY" : "RESPOND";
    corrections.push("handoff_without_evidence_downgraded");
  }

  // 1b) RESPOND cujo TEXTO já é uma orientação de troubleshooting para um
  // sintoma técnico simples deveria ter sido WAIT (o Bot dá o passo e
  // espera o cliente testar) — o Qwen às vezes acerta o conteúdo mas erra
  // esse rótulo específico. Só corrige quando os dois sinais batem (sintoma
  // técnico na mensagem do cliente + linguagem imperativa na resposta),
  // para não confundir uma resposta comercial que incidentalmente usa
  // palavras como "confira".
  if (action === "RESPOND" && signals?.supportSymptom && looksLikeTroubleshootingAnswer(result?.answer)) {
    action = "WAIT";
    corrections.push("respond_troubleshooting_relabeled_wait");
  }

  // 2) Confiança calibrada pelo retrieval — só faz sentido para uma
  // afirmação factual (RESPOND); HANDOFF/ASK/CLARIFY/WAIT/RESOLVE não
  // "afirmam" nada sobre a Knowledge, então poucas fontes ali é irrelevante.
  // HIGH com poucas fontes numa resposta direta não é honesto.
  const sources = Number.isFinite(result?.sources) ? result.sources : 0;
  if (action === "RESPOND" && confidence === "HIGH" && sources < MIN_SOURCES_FOR_HIGH_CONFIDENCE) {
    confidence = "MEDIUM";
    corrections.push("high_confidence_without_enough_sources");
  }

  // 3) LOW confidence nunca sustenta uma afirmação categórica direta
  // (RESPOND) — regra de abstenção. Vira CLARIFY (pedir mais contexto é
  // sempre mais seguro que inventar ou escalar sem necessidade).
  if (confidence === "LOW" && action === "RESPOND") {
    action = "CLARIFY";
    corrections.push("low_confidence_respond_downgraded");
  }

  // 4) reason sempre precisa pertencer à allowlist da action FINAL (depois
  // de qualquer downgrade acima) — nunca "RESPOND com reason de handoff" e
  // afins (item "action e reason precisam ser semanticamente compatíveis").
  const resolvedReason = resolveReasonForAction(reason, action, signals);
  if (resolvedReason !== reason) {
    reason = resolvedReason;
    corrections.push("reason_not_in_allowlist_for_action");
  }

  // 5) needsHuman nunca é campo solto — é sempre derivado da action final.
  // HANDOFF (e só HANDOFF) precisa de humano; os outros cinco, não.
  const needsHuman = action === "HANDOFF";
  if (typeof result?.needsHuman !== "boolean") corrections.push("invalid_needs_human");
  else if (result.needsHuman !== needsHuman) corrections.push(needsHuman ? "needs_human_derived_true" : "needs_human_derived_false");

  return {
    ...result,
    action,
    confidence,
    needsHuman,
    reason,
    plannerNormalized: corrections.length > 0,
    plannerCorrections: corrections,
  };
}

module.exports = {
  normalizePlannerOutput,
  REASON_ALLOWLIST,
  DEFAULT_REASON_BY_ACTION,
  VALID_ACTIONS,
  VALID_CONFIDENCE,
  MIN_SOURCES_FOR_HIGH_CONFIDENCE,
};
