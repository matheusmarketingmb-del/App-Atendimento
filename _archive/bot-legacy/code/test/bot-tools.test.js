require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const { BotTool, NotConfiguredTool } = require("../src/services/bot-tools/bot-tool");
const registry = require("../src/services/bot-tools/tool-registry");
const { resolveToolDecision } = require("../src/services/bot-tool-orchestrator-service");

function permittedBot(overrides = {}) {
  return {
    id: "bot-tools-test", toolsEnabled: true,
    toolPermissions: { OrderTool: true, TrackingTool: true },
    ...overrides,
  };
}

// --- Contrato BotTool -------------------------------------------------

test("BotTool: riskLevel inválido é rejeitado na construção", () => {
  assert.throws(() => new BotTool({ name: "X", riskLevel: "QUALQUER_COISA" }));
});

test("BotTool: canExecute nunca permite SENSITIVE_ACTION, mesmo com todas as entidades presentes", () => {
  const tool = new BotTool({ name: "CancelOrderTool", riskLevel: "SENSITIVE_ACTION", requiredEntities: ["orderNumber"] });
  const check = tool.canExecute({ channel: "META", entities: { orderNumber: "123" } });
  assert.equal(check.ok, false);
  assert.equal(check.reason, "SENSITIVE_ACTION_BLOCKED");
});

test("BotTool: Tool desabilitada nunca pode ser executada", () => {
  const tool = new BotTool({ name: "DisabledTool", riskLevel: "READ_ONLY", enabled: false });
  Object.assign(tool, { _run: async () => ({ success: true }) });
  const check = tool.canExecute({ channel: "META", entities: {} });
  assert.equal(check.ok, false);
  assert.equal(check.reason, "TOOL_DISABLED");
});

test("BotTool: entidade obrigatória ausente é sinalizada (para virar esclarecimento, nunca execução)", () => {
  const tool = new BotTool({ name: "NeedsEntityTool", riskLevel: "READ_ONLY", requiredEntities: ["orderNumber"] });
  const check = tool.canExecute({ channel: "META", entities: {} });
  assert.equal(check.ok, false);
  assert.equal(check.reason, "MISSING_ENTITIES");
  assert.deepEqual(check.missing, ["orderNumber"]);
});

test("NotConfiguredTool: degrada com segurança (NOT_CONFIGURED) em vez de derrubar a aplicação", async () => {
  const tool = new NotConfiguredTool({ name: "SemIntegracao", riskLevel: "READ_ONLY" });
  const result = await tool.execute({});
  assert.equal(result.success, false);
  assert.equal(result.reason, "NOT_CONFIGURED");
});

test("execute() nunca deixa uma exceção escapar (envelope de erro padronizado)", async () => {
  class ExplodingTool extends BotTool {
    async _run() { throw new Error("boom"); }
  }
  const tool = new ExplodingTool({ name: "Explode", riskLevel: "READ_ONLY" });
  const result = await tool.execute({});
  assert.equal(result.success, false);
  assert.equal(result.reason, "TOOL_ERROR");
});

// --- Registro central ---------------------------------------------------

test("tool-registry: todas as Tools da fase 1 são READ_ONLY (nenhuma SENSITIVE_ACTION implementada)", () => {
  const tools = registry.listTools();
  assert.ok(tools.length >= 7);
  assert.ok(tools.every((tool) => tool.riskLevel === "READ_ONLY"));
});

test("tool-registry: Tools sem integração externa configurada respondem NOT_CONFIGURED sem lançar exceção", async () => {
  const order = registry.getTool("OrderTool");
  const result = await order.execute({ orderNumber: "12345" });
  assert.equal(result.success, false);
  assert.equal(result.reason, "NOT_CONFIGURED");
});

// --- Orquestração (validação antes de executar; a IA nunca chama a Tool direto) ---

test("bot-tool-orchestrator: falta de entidade obrigatória vira ASK_CLARIFICATION, nunca chega a executar", async () => {
  const decision = { action: "QUERY_TOOL", toolName: "OrderTool", entities: {}, summary: "teste" };
  const result = await resolveToolDecision({ bot: permittedBot(), decision, channel: "META", mode: "LIVE" });
  assert.equal(result.action, "ASK_CLARIFICATION");
  assert.equal(result.needsClarification, true);
  assert.match(result.clarificationQuestion, /pedido/i);
});

test("bot-tool-orchestrator: Bot com toolsEnabled=false nunca executa a Tool (cai numa resposta segura)", async () => {
  const decision = { action: "QUERY_TOOL", toolName: "OrderTool", entities: { orderNumber: "12345" }, summary: "teste" };
  const result = await resolveToolDecision({ bot: permittedBot({ toolsEnabled: false }), decision, channel: "META", mode: "LIVE" });
  assert.equal(result.action, "RESPOND");
  assert.equal(result.toolResponseText, null);
  assert.equal(result.toolUnavailableReason, "BOT_TOOLS_DISABLED");
});

test("bot-tool-orchestrator: Tool sem permissão explícita no Bot (toolPermissions) nunca executa", async () => {
  const decision = { action: "QUERY_TOOL", toolName: "OrderTool", entities: { orderNumber: "12345" }, summary: "teste" };
  const result = await resolveToolDecision({ bot: permittedBot({ toolPermissions: {} }), decision, channel: "META", mode: "LIVE" });
  assert.equal(result.action, "RESPOND");
  assert.equal(result.toolUnavailableReason, "TOOL_NOT_PERMITTED");
});

test("bot-tool-orchestrator: Tool NOT_CONFIGURED (sem integração real) degrada com segurança, sem fabricar dado", async () => {
  const decision = { action: "QUERY_TOOL", toolName: "OrderTool", entities: { orderNumber: "12345" }, summary: "teste" };
  const result = await resolveToolDecision({ bot: permittedBot(), decision, channel: "META", mode: "LIVE" });
  assert.equal(result.action, "RESPOND");
  assert.equal(result.toolResponseText, null, "sem dado real disponível, nunca deveria inventar um texto de resposta");
  assert.equal(result.toolResult.reason, "NOT_CONFIGURED");
});

test("bot-tool-orchestrator: modo OBSERVAÇÃO nunca chama a Tool de verdade", async () => {
  const original = registry.tools.OrderTool;
  let called = false;
  registry.tools.OrderTool = {
    name: "OrderTool", enabled: true, riskLevel: "READ_ONLY", requiredEntities: [], supportedChannels: [],
    canExecute: () => ({ ok: true }),
    execute: async () => { called = true; return { success: true, data: { status: "ENVIADO" }, message: "Fabricado" }; },
  };
  try {
    const decision = { action: "QUERY_TOOL", toolName: "OrderTool", entities: { orderNumber: "12345" }, summary: "teste" };
    const result = await resolveToolDecision({ bot: permittedBot(), decision, channel: "META", mode: "OBSERVATION" });
    assert.equal(called, false, "em modo observação, a Tool de verdade nunca deveria ser chamada");
    assert.equal(result.toolObservedOnly, true);
    assert.equal(result.toolResponseText, null, "nada deveria ser preparado para envio em modo observação");
  } finally {
    registry.tools.OrderTool = original;
  }
});

test("bot-tool-orchestrator: com dado real da Tool, a resposta final usa exatamente esse dado (sem fabricação)", async () => {
  const original = registry.tools.OrderTool;
  registry.tools.OrderTool = {
    name: "OrderTool", enabled: true, riskLevel: "READ_ONLY", requiredEntities: ["orderNumber"], supportedChannels: [],
    canExecute: (ctx) => (ctx.entities?.orderNumber ? { ok: true } : { ok: false, reason: "MISSING_ENTITIES", missing: ["orderNumber"] }),
    execute: async (input) => ({ success: true, data: { orderNumber: input.orderNumber, status: "A caminho" }, message: `Seu pedido ${input.orderNumber} está a caminho.` }),
  };
  try {
    const decision = { action: "QUERY_TOOL", toolName: "OrderTool", entities: { orderNumber: "98765" }, summary: "teste" };
    const result = await resolveToolDecision({ bot: permittedBot(), decision, channel: "META", mode: "LIVE" });
    assert.equal(result.action, "RESPOND");
    assert.equal(result.toolResponseText, "Seu pedido 98765 está a caminho.");
    assert.equal(result.toolResult.data.orderNumber, "98765");
  } finally {
    registry.tools.OrderTool = original;
  }
});

test("bot-tool-orchestrator: Tool com riskLevel SENSITIVE_ACTION nunca é executada mesmo se sugerida", async () => {
  const original = registry.tools.CancelOrderTool;
  registry.tools.CancelOrderTool = {
    name: "CancelOrderTool", enabled: true, riskLevel: "SENSITIVE_ACTION", requiredEntities: [], supportedChannels: [],
    canExecute: () => ({ ok: false, reason: "SENSITIVE_ACTION_BLOCKED" }),
    execute: async () => ({ success: true, data: {}, message: "Nunca deveria rodar." }),
  };
  try {
    const decision = { action: "QUERY_TOOL", toolName: "CancelOrderTool", entities: {}, summary: "teste" };
    const result = await resolveToolDecision({
      bot: permittedBot({ toolPermissions: { CancelOrderTool: true } }), decision, channel: "META", mode: "LIVE",
    });
    assert.equal(result.action, "RESPOND");
    assert.equal(result.toolResponseText, null);
    assert.equal(result.toolUnavailableReason, "SENSITIVE_ACTION_BLOCKED");
  } finally {
    if (original) registry.tools.CancelOrderTool = original; else delete registry.tools.CancelOrderTool;
  }
});
