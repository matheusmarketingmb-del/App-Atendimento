const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePlannerOutput } = require("../src/services/ai/planner-output-guard");

function baseResult(overrides = {}) {
  return {
    answer: "texto qualquer", action: "RESPOND", confidence: "HIGH", needsHuman: false,
    reason: "confirmed_product_info", product: null, intent: null, sources: 5, latencyMs: 1000,
    ...overrides,
  };
}

test("RESPOND + needsHuman=false com reason coerente e fontes suficientes: passa sem alteração", () => {
  const out = normalizePlannerOutput({ message: "o GS Pro 2 tem GPS?", result: baseResult() });
  assert.equal(out.action, "RESPOND");
  assert.equal(out.needsHuman, false);
  assert.equal(out.reason, "confirmed_product_info");
  assert.equal(out.plannerNormalized, false);
  assert.deepEqual(out.plannerCorrections, []);
});

test("HANDOFF + needsHuman=true válido (pedido explícito de humano, com evidência): passa sem alteração", () => {
  const out = normalizePlannerOutput({
    message: "quero falar com uma pessoa",
    result: baseResult({ action: "HANDOFF", needsHuman: true, reason: "customer_requested_human" }),
  });
  assert.equal(out.action, "HANDOFF");
  assert.equal(out.needsHuman, true);
  assert.equal(out.reason, "customer_requested_human");
  assert.equal(out.plannerNormalized, false);
});

test("HANDOFF + needsHuman=false: corrige needsHuman para true (needsHuman é sempre derivado da action)", () => {
  const out = normalizePlannerOutput({
    message: "quero acionar a garantia, meu produto esta com defeito",
    result: baseResult({ action: "HANDOFF", needsHuman: false, reason: "warranty_review" }),
  });
  assert.equal(out.action, "HANDOFF");
  assert.equal(out.needsHuman, true);
  assert.equal(out.plannerNormalized, true);
});

test("RESOLVE + needsHuman=true: corrige needsHuman para false (needsHuman é sempre derivado da action)", () => {
  const out = normalizePlannerOutput({
    message: "funcionou, obrigado",
    result: baseResult({ action: "RESOLVE", needsHuman: true, reason: "issue_resolved" }),
  });
  assert.equal(out.action, "RESOLVE");
  assert.equal(out.needsHuman, false);
  assert.equal(out.plannerNormalized, true);
});

test("reason incompatível com a action: corrige para um reason válido daquela action", () => {
  const out = normalizePlannerOutput({
    message: "funcionou, obrigado",
    result: baseResult({ action: "RESOLVE", needsHuman: false, reason: "confirmed_product_info" }),
  });
  assert.ok(["issue_resolved", "customer_confirmed_solution"].includes(out.reason));
  assert.equal(out.plannerNormalized, true);
  assert.ok(out.plannerCorrections.includes("reason_not_in_allowlist_for_action"));
});

test("BUG RELATADO: pergunta comercial simples com HANDOFF indevido é reavaliada (não fica presa em HANDOFF)", () => {
  const out = normalizePlannerOutput({
    message: "quanto custa o Lite 3 Pro?",
    result: baseResult({ action: "HANDOFF", confidence: "MEDIUM", needsHuman: true, reason: "customer_requested_human", sources: 8 }),
  });
  assert.notEqual(out.action, "HANDOFF");
  assert.equal(out.needsHuman, false);
  assert.notEqual(out.reason, "customer_requested_human");
  assert.ok(out.plannerCorrections.includes("handoff_without_evidence_downgraded"));
});

test("HANDOFF com reason low_confidence/tool_failure é aceito mesmo sem sinal textual (evidência já veio do RAG Server)", () => {
  const out = normalizePlannerOutput({
    message: "isso existe?",
    result: baseResult({ action: "HANDOFF", confidence: "LOW", needsHuman: true, reason: "low_confidence", sources: 0 }),
  });
  assert.equal(out.action, "HANDOFF");
  assert.equal(out.reason, "low_confidence");
  assert.equal(out.plannerCorrections.includes("handoff_without_evidence_downgraded"), false);
});

test("LOW confidence + RESPOND (afirmação categórica): rebaixa para CLARIFY", () => {
  const out = normalizePlannerOutput({
    message: "o GS Explorer S faz pagamento por aproximacao?",
    result: baseResult({ action: "RESPOND", confidence: "LOW", needsHuman: false, sources: 3 }),
  });
  assert.equal(out.action, "CLARIFY");
  assert.equal(out.needsHuman, false);
  assert.ok(out.plannerCorrections.includes("low_confidence_respond_downgraded"));
});

test("HIGH confidence com poucas fontes é rebaixada para MEDIUM", () => {
  const out = normalizePlannerOutput({
    message: "o GS Pro 2 tem GPS?",
    result: baseResult({ action: "RESPOND", confidence: "HIGH", needsHuman: false, sources: 1 }),
  });
  assert.equal(out.confidence, "MEDIUM");
  assert.ok(out.plannerCorrections.includes("high_confidence_without_enough_sources"));
});

test("HIGH confidence com fontes suficientes permanece HIGH", () => {
  const out = normalizePlannerOutput({
    message: "o GS Pro 2 tem GPS?",
    result: baseResult({ action: "RESPOND", confidence: "HIGH", needsHuman: false, sources: 4 }),
  });
  assert.equal(out.confidence, "HIGH");
});

test("customer_requested_human nunca sobrevive numa pergunta comercial comum", () => {
  const out = normalizePlannerOutput({
    message: "quanto custa o Lite 3 Pro?",
    result: baseResult({ action: "HANDOFF", needsHuman: true, reason: "customer_requested_human", confidence: "MEDIUM", sources: 6 }),
  });
  assert.notEqual(out.reason, "customer_requested_human");
});

test("safety_issue nunca sobrevive sem contexto de risco no texto", () => {
  const out = normalizePlannerOutput({
    message: "meu relogio nao carrega",
    result: baseResult({ action: "HANDOFF", needsHuman: true, reason: "safety_issue", confidence: "MEDIUM", sources: 6 }),
  });
  assert.notEqual(out.reason, "safety_issue");
});

test("safety_issue permanece (e HANDOFF é mantido) quando o texto realmente indica risco", () => {
  const out = normalizePlannerOutput({
    message: "meu relogio esta quente e a tela levantou",
    result: baseResult({ action: "HANDOFF", needsHuman: true, reason: "safety_issue", confidence: "HIGH", sources: 5 }),
  });
  assert.equal(out.action, "HANDOFF");
  assert.equal(out.reason, "safety_issue");
  assert.equal(out.needsHuman, true);
});

test("RESPOND com texto de troubleshooting para sintoma técnico é relabelado WAIT", () => {
  const out = normalizePlannerOutput({
    message: "meu relogio nao carrega",
    result: baseResult({
      action: "RESPOND", confidence: "MEDIUM", needsHuman: false, reason: "confirmed_product_info", sources: 4,
      answer: "Confira se os contatos do relógio e do carregador estão limpos e secos, depois encaixe novamente.",
    }),
  });
  assert.equal(out.action, "WAIT");
  assert.ok(out.plannerCorrections.includes("respond_troubleshooting_relabeled_wait"));
});

test("RESPOND comercial com a palavra 'confira' não é confundido com troubleshooting (sem sintoma técnico)", () => {
  const out = normalizePlannerOutput({
    message: "quanto custa o Lite 3 Pro?",
    result: baseResult({
      action: "RESPOND", confidence: "MEDIUM", needsHuman: false, reason: "general_info", sources: 4,
      answer: "Confira as condições comerciais atuais com nossa equipe para um valor exato.",
    }),
  });
  assert.equal(out.action, "RESPOND");
});

test("WAIT para troubleshooting normal: passa sem alteração", () => {
  const out = normalizePlannerOutput({
    message: "meu GS Pro 2 nao carrega",
    result: baseResult({ action: "WAIT", needsHuman: false, reason: "safe_troubleshooting", sources: 6 }),
  });
  assert.equal(out.action, "WAIT");
  assert.equal(out.needsHuman, false);
  assert.equal(out.plannerNormalized, false);
});

test("RESOLVE depois de \"funcionou\": passa sem alteração quando já coerente", () => {
  const out = normalizePlannerOutput({
    message: "funcionou",
    result: baseResult({ action: "RESOLVE", needsHuman: false, reason: "customer_confirmed_solution", sources: 0 }),
  });
  assert.equal(out.action, "RESOLVE");
  assert.equal(out.needsHuman, false);
  assert.equal(out.plannerNormalized, false);
});

test("aliases de reason vindos do RAG Server são harmonizados para o vocabulário canônico", () => {
  const safety = normalizePlannerOutput({
    message: "meu relogio esta quente e a tela levantou",
    result: baseResult({ action: "HANDOFF", needsHuman: true, reason: "safety_hazard", sources: 5 }),
  });
  assert.equal(safety.reason, "safety_issue");

  const weak = normalizePlannerOutput({
    message: "isso existe?",
    result: baseResult({ action: "HANDOFF", needsHuman: true, reason: "weak_context", sources: 0 }),
  });
  assert.equal(weak.reason, "low_confidence");
});

test("action/confidence inválidos do provider nunca vazam — caem em fallback seguro", () => {
  const out = normalizePlannerOutput({
    message: "qualquer coisa",
    result: baseResult({ action: "DO_SOMETHING_WEIRD", confidence: "SUPER_HIGH", needsHuman: false, reason: "x", sources: 0 }),
  });
  assert.equal(out.action, "HANDOFF");
  assert.equal(out.confidence, "LOW");
  assert.equal(out.needsHuman, true);
  assert.ok(out.plannerCorrections.includes("invalid_action"));
  assert.ok(out.plannerCorrections.includes("invalid_confidence"));
});

test("WAIT com needsHuman=true vindo do provider é corrigido para false (needsHuman deriva só de HANDOFF)", () => {
  const out = normalizePlannerOutput({
    message: "meu GS Pro 2 nao carrega",
    result: baseResult({ action: "WAIT", needsHuman: true, reason: "safe_troubleshooting", sources: 6 }),
  });
  assert.equal(out.needsHuman, false);
  assert.equal(out.plannerNormalized, true);
});
