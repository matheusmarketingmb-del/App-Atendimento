const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveAutoReplyEligibility, resolveSendDecision } = require("../src/services/bot-ai-gate-service");

function base(overrides = {}) {
  return {
    bot: { autoReplyEnabled: true },
    flags: { useAi: true, aiMode: "PRIMARY", requiresAi: false, aiOfflineBehavior: "NO_AUTO_REPLY" },
    globalAutomationEnabled: true,
    localAiStatus: "ONLINE",
    ...overrides,
  };
}

test("kill switch global bloqueia mesmo com IA online e Bot habilitado", () => {
  const result = resolveAutoReplyEligibility(base({ globalAutomationEnabled: false }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "GLOBAL_AUTOMATION_DISABLED");
});

test("bot.autoReplyEnabled=false bloqueia independente de useAi/status", () => {
  const result = resolveAutoReplyEligibility(base({ bot: { autoReplyEnabled: false } }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "AUTO_REPLY_DISABLED");
});

test("useAi=false ou aiMode=OFF: elegibilidade depende só do motor local, sempre permitido nesta camada", () => {
  assert.equal(resolveAutoReplyEligibility(base({ flags: { useAi: false } })).allowed, true);
  assert.equal(resolveAutoReplyEligibility(base({ flags: { useAi: true, aiMode: "OFF" } })).allowed, true);
});

test("useAi=true e provider ONLINE: permitido", () => {
  assert.equal(resolveAutoReplyEligibility(base()).allowed, true);
});

test("useAi=true e provider OFFLINE com requiresAi=true: nunca responde, mesmo com LOCAL_FLOW configurado", () => {
  const result = resolveAutoReplyEligibility(base({
    localAiStatus: "OFFLINE",
    flags: { useAi: true, aiMode: "PRIMARY", requiresAi: true, aiOfflineBehavior: "LOCAL_FLOW" },
  }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "PROVIDER_OFFLINE");
});

test("useAi=true, provider OFFLINE, requiresAi=false e aiOfflineBehavior=LOCAL_FLOW: permitido sem IA", () => {
  const result = resolveAutoReplyEligibility(base({
    localAiStatus: "OFFLINE",
    flags: { useAi: true, aiMode: "PRIMARY", requiresAi: false, aiOfflineBehavior: "LOCAL_FLOW" },
  }));
  assert.equal(result.allowed, true);
  assert.equal(result.reason, null);
});

test("useAi=true, provider DEGRADED e aiOfflineBehavior=HUMAN_HANDOFF: bloqueia com motivo de handoff", () => {
  const result = resolveAutoReplyEligibility(base({
    localAiStatus: "DEGRADED",
    flags: { useAi: true, aiMode: "PRIMARY", requiresAi: false, aiOfflineBehavior: "HUMAN_HANDOFF" },
  }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "AI_OFFLINE_FORCES_HANDOFF");
});

test("useAi=true, provider OFFLINE e aiOfflineBehavior=NO_AUTO_REPLY (default): bloqueia sem tentar outro provider", () => {
  const result = resolveAutoReplyEligibility(base({ localAiStatus: "OFFLINE" }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "PROVIDER_OFFLINE");
});

// --- resolveSendDecision (gate de segurança para envio) --------------------

function eligible() { return { allowed: true, reason: null }; }
function notEligible(reason = "AUTO_REPLY_DISABLED") { return { allowed: false, reason }; }
function planner(overrides = {}) {
  return { action: "RESPOND", confidence: "HIGH", needsHuman: false, answer: "Resposta de teste.", ...overrides };
}

test("EMPTY_RESPONSE: resposta vazia nunca envia, mesmo com tudo mais favorável", () => {
  const decision = resolveSendDecision({ eligibility: eligible(), plannerResult: planner({ answer: "   " }) });
  assert.equal(decision.shouldSend, false);
  assert.equal(decision.reason, "EMPTY_RESPONSE");
});

test("CASO 1: 'meu GS Pro não carrega' → WAIT/needsHuman=false/confidence não-LOW → envia", () => {
  const decision = resolveSendDecision({
    eligibility: eligible(),
    plannerResult: planner({ action: "WAIT", confidence: "MEDIUM", needsHuman: false }),
  });
  assert.equal(decision.shouldSend, true);
});

test("CASO 2: HANDOFF (ex.: pedido de humano) nunca envia, mesmo elegível", () => {
  const decision = resolveSendDecision({
    eligibility: eligible(),
    plannerResult: planner({ action: "HANDOFF", confidence: "HIGH", needsHuman: true }),
  });
  assert.equal(decision.shouldSend, false);
  assert.equal(decision.reason, "NEEDS_HUMAN");
});

test("CASO 3: HANDOFF de segurança (safety_issue) nunca envia — mesma regra do caso 2", () => {
  const decision = resolveSendDecision({
    eligibility: eligible(),
    plannerResult: planner({ action: "HANDOFF", confidence: "HIGH", needsHuman: true, reason: "safety_issue" }),
  });
  assert.equal(decision.shouldSend, false);
});

test("CASO 4: RESPOND comercial (preço) elegível e com confiança adequada → envia", () => {
  const decision = resolveSendDecision({
    eligibility: eligible(),
    plannerResult: planner({ action: "RESPOND", confidence: "MEDIUM", needsHuman: false }),
  });
  assert.equal(decision.shouldSend, true);
});

test("CASO 5: provider/RAG offline (eligibility.allowed=false) nunca envia, mesmo com planner favorável", () => {
  const decision = resolveSendDecision({
    eligibility: notEligible("PROVIDER_OFFLINE"),
    plannerResult: planner({ action: "RESPOND", confidence: "HIGH", needsHuman: false }),
  });
  assert.equal(decision.shouldSend, false);
  assert.equal(decision.reason, "PROVIDER_OFFLINE");
});

test("LOW confidence nunca envia, mesmo com action/needsHuman favoráveis", () => {
  const decision = resolveSendDecision({ eligibility: eligible(), plannerResult: planner({ confidence: "LOW" }) });
  assert.equal(decision.shouldSend, false);
  assert.equal(decision.reason, "LOW_CONFIDENCE");
});

test("CLARIFY nunca envia (fora da allowlist de actions enviáveis), mesmo com confiança alta", () => {
  const decision = resolveSendDecision({
    eligibility: eligible(),
    plannerResult: planner({ action: "CLARIFY", confidence: "HIGH", needsHuman: false }),
  });
  assert.equal(decision.shouldSend, false);
  assert.equal(decision.reason, "ACTION_NOT_ALLOWED");
});

test("RESOLVE nunca envia (fora da allowlist — encerramento não é mensagem operacional automática)", () => {
  const decision = resolveSendDecision({
    eligibility: eligible(),
    plannerResult: planner({ action: "RESOLVE", confidence: "HIGH", needsHuman: false }),
  });
  assert.equal(decision.shouldSend, false);
});

test("ASK e WAIT (além de RESPOND) são enviáveis quando o resto está ok", () => {
  assert.equal(resolveSendDecision({ eligibility: eligible(), plannerResult: planner({ action: "ASK" }) }).shouldSend, true);
  assert.equal(resolveSendDecision({ eligibility: eligible(), plannerResult: planner({ action: "WAIT" }) }).shouldSend, true);
});

test("sem plannerResult, nunca envia", () => {
  const decision = resolveSendDecision({ eligibility: eligible(), plannerResult: null });
  assert.equal(decision.shouldSend, false);
  assert.equal(decision.reason, "NO_PLANNER_RESULT");
});
