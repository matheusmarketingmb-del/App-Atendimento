const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveAutoReplyEligibility } = require("../src/services/bot-ai-gate-service");

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
  assert.equal(result.reason, "AUTOMATION_DISABLED_GLOBALLY");
});

test("bot.autoReplyEnabled=false bloqueia independente de useAi/status", () => {
  const result = resolveAutoReplyEligibility(base({ bot: { autoReplyEnabled: false } }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "BOT_AUTOREPLY_DISABLED");
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
  assert.equal(result.reason, "AI_OFFLINE_NO_AUTO_REPLY");
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
  assert.equal(result.reason, "AI_OFFLINE_NO_AUTO_REPLY");
});
