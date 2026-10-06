const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { buildPostTriageAssistantGraph, prepareAnswers } = require("../src/services/mibro-assistant-question-answer");
const { runTurn } = require("../src/services/bot-visual-flow-engine");
const { validateGraph } = require("../src/services/bot-visual-flow-graph");
const flows = require("../src/services/bot-visual-flow-service");
const responseKeys = new Set(["ASSIST_MIBRO_EMPRESA"]);
const graph = buildPostTriageAssistantGraph({ availableKeys: responseKeys });
const seed = { conversation: { categoryName: "Comercial" }, flow: { initialCategoryId: "comercial" }, bot: { assistantAfterTriage: true, initialMessage: "Sou o Assistente" } };
const texts = new Map([["ASSIST_MIBRO_EMPRESA", "Informação institucional cadastrada."]]);
function adapter(output) { return { send: async (text) => output.push(text), sendMenu: async (menu) => output.push(menu), handoff: async (data) => output.push(data), finish: async () => {} }; }

test("Assistente tem gatilho exclusivo após a Triagem e grafo válido", () => {
  assert.equal(graph.nodes[0].config.trigger, "AFTER_TRIAGE");
  const checked = validateGraph(graph, { responseKeys });
  assert.equal(checked.valid, true, JSON.stringify(checked.errors));
});
test("identifica dúvida institucional, responde resumidamente e pergunta se ajudou", async () => {
  const output = [], deps = { graph, seed, adapter: adapter(output), responses: texts };
  const first = await runTurn({ ...deps, input: { type: "START" } });
  assert.equal(first.state.currentNodeKey, "problem");
  assert.match(output.at(-1), /Comercial/);
  const answer = await runTurn({ ...deps, state: first.state, input: { type: "MESSAGE", text: "a empresa Mibro Brasil é oficial?" } });
  assert.ok(output.includes("Informação institucional cadastrada."));
  assert.equal(answer.state.currentNodeKey, "helped");
  const done = await runTurn({ ...deps, state: answer.state, input: { type: "MESSAGE", text: "sim" } });
  assert.equal(done.state.status, "COMPLETED");
});
test("reaproveita problema já coletado pela Triagem e não pergunta novamente", async () => {
  const output = [];
  const first = await runTurn({ graph, seed: { ...seed, flow: { ...seed.flow, initialNeed: "A empresa é oficial?" } }, adapter: adapter(output), responses: texts, input: { type: "START" } });
  assert.equal(first.state.currentNodeKey, "helped");
  assert.equal(first.state.context.flow.customerProblem, "A empresa é oficial?");
  assert.ok(!output.some((text) => typeof text === "string" && text.includes("Conte sua dúvida")));
});
test("pedido de humano é respeitado mesmo enquanto pergunta o modelo", async () => {
  const output = [], deps = { graph, seed, adapter: adapter(output), responses: texts };
  const first = await runTurn({ ...deps, input: { type: "START" } });
  const done = await runTurn({ ...deps, state: first.state, input: { type: "MESSAGE", text: "quero falar com um atendente" } });
  assert.equal(done.state.status, "HANDED_OFF");
  assert.equal(output.at(-1).categoryId, "comercial");
});
test("não mistura modelos parecidos nem inventa ficha desconhecida", async () => {
  const products = [{ product: "GS Pro", title: "GS Pro", key: "PRO1" }, { product: "GS Pro 2", title: "GS Pro 2", key: "PRO2" }];
  const productGraph = buildPostTriageAssistantGraph({ products, availableKeys: responseKeys });
  const output = [], deps = { graph: productGraph, seed, adapter: adapter(output), responses: new Map([...texts, ["PRO1", "Ficha Pro"], ["PRO2", "Ficha Pro 2"]]) };
  const first = await runTurn({ ...deps, input: { type: "START" } });
  const ask = await runTurn({ ...deps, state: first.state, input: { type: "MESSAGE", text: "quero conhecer os produtos" } });
  const answer = await runTurn({ ...deps, state: ask.state, input: { type: "MESSAGE", text: "GS Pro 2" } });
  assert.equal(answer.state.currentNodeKey, "helped");
  assert.ok(output.includes("Ficha Pro 2")); assert.ok(!output.includes("Ficha Pro"));
  const unknown = await runTurn({ ...deps, state: ask.state, input: { type: "MESSAGE", text: "modelo desconhecido" } });
  assert.equal(unknown.state.status, "HANDED_OFF");
});
test("pedido de humano coletado na Triagem não reinicia perguntas", async () => {
  const output = [];
  const result = await runTurn({ graph, seed: { ...seed, flow: { ...seed.flow, initialNeed: "quero falar com atendente" } }, adapter: adapter(output), input: { type: "START" } });
  assert.equal(result.state.status, "HANDED_OFF");
  assert.equal(output.at(-1).categoryId, "comercial");
});
test("fonte desativada/expirada não gera resposta resumida", () => {
  const prepared = prepareAnswers([{ id: "cmtljoz8v009is60k6zt9zf7x", type: "WARRANTY", content: "Informação antiga", active: true, validUntil: "2025-01-01" }, { id: "product", type: "PRODUCT", content: "Ficha", product: "C4", active: false }]);
  assert.equal(prepared.answers.length, 0);
});

test("produto traz ficha legível e link confirmado, sem inventar URL de modelo desconhecido", () => {
  const prepared = prepareAnswers([
    { id: "lite", type: "PRODUCT", active: true, product: "Lite 3 Pro", title: "Mibro Lite 3 Pro", content: "Tela AMOLED; autonomia de até 15 dias" },
    { id: "other", type: "PRODUCT", active: true, product: "Outro modelo", title: "Outro modelo", content: "Ficha cadastrada" },
  ]);
  assert.match(prepared.products[0].text, /• Tela AMOLED\n• autonomia de até 15 dias/);
  assert.match(prepared.products[0].text, /https:\/\/mibrobrasil.com.br\/products\/mibro-lite-3-pro/);
  assert.match(prepared.products[1].text, /https:\/\/mibrobrasil.com.br\//);
  assert.ok(!prepared.products[1].text.includes("/products/"));
});

test("Voltar por texto, número e clique retorna à pergunta anterior sem consumir tentativas", async () => {
  const output = [], deps = { graph, seed, adapter: adapter(output), responses: texts };
  const first = await runTurn({ ...deps, input: { type: "START" } });
  const answer = await runTurn({ ...deps, state: first.state, input: { type: "MESSAGE", text: "A empresa é oficial?" } });
  assert.ok(output.at(-1).options.some((option) => option.label === "Voltar"));
  for (const input of [{ type: "MESSAGE", text: "Voltar" }, { type: "MESSAGE", text: "4" }, { type: "MESSAGE", text: "", replyId: "flow:assistant_back" }]) {
    // Use the engine's reply prefix, not a UI-only label.
    if (input.replyId) input.replyId = require("../src/services/bot-visual-flow-engine").MENU_REPLY_PREFIX + "assistant_back";
    const back = await runTurn({ ...deps, state: answer.state, input });
    assert.equal(back.state.currentNodeKey, "problem");
    assert.equal(back.state.context.flow.customerProblem, undefined);
    assert.deepEqual(back.state.context._engine.attempts, {});
    assert.match(output.at(-1), /digite Voltar/);
    const root = await runTurn({ ...deps, state: back.state, input: { type: "MESSAGE", text: "Voltar" } });
    assert.equal(root.state.currentNodeKey, "problem");
  }
});

test("cliente escolhe vendedor, informa que não resolveu, outro assunto ou finaliza de verdade", async () => {
  const output = [], finished = [], deps = { graph, seed, adapter: { ...adapter(output), finish: async (data) => finished.push(data) }, responses: texts };
  const first = await runTurn({ ...deps, input: { type: "START" } });
  const answer = await runTurn({ ...deps, state: first.state, input: { type: "MESSAGE", text: "A empresa é oficial?" } });
  for (const text of ["quero falar com um vendedor", "não deu certo", "continua com problema", "1"]) {
    const result = await runTurn({ ...deps, state: answer.state, input: { type: "MESSAGE", text } });
    assert.equal(result.state.status, "HANDED_OFF", text);
    assert.equal(output.at(-1).categoryId, "comercial");
  }
  const another = await runTurn({ ...deps, state: answer.state, input: { type: "MESSAGE", text: "3" } });
  assert.equal(another.state.currentNodeKey, "topics");
  const back = await runTurn({ ...deps, state: another.state, input: { type: "MESSAGE", text: "Voltar" } });
  assert.equal(back.state.currentNodeKey, "helped");
  const done = await runTurn({ ...deps, state: answer.state, input: { type: "MESSAGE", text: "Finalizar atendimento" } });
  assert.equal(done.state.status, "COMPLETED");
  assert.equal(finished.at(-1).finalizeConversation, true);
});

// Integração destrutiva: só roda no banco QA isolado (docs/BOTS_PERGUNTAS_RESPOSTAS_LOCAL.md);
// fora dele aparece como "pulado", nunca como falha.
test("integração: Triagem é primeira; Assistente entra no mesmo chat/setor, sem duplicar", { skip: process.env.DATABASE_URL !== "postgresql://bot_qa:isolated-local-qa@127.0.0.1:25432/bot_qa" && "requer o banco QA isolado (127.0.0.1:25432/bot_qa)" }, async () => {
  assert.equal(process.env.DATABASE_URL, "postgresql://bot_qa:isolated-local-qa@127.0.0.1:25432/bot_qa", "Somente banco local isolado.");
  const before = await prisma.bot.findMany({ select: { id: true, autoReplyEnabled: true } });
  const category = await prisma.category.findUniqueOrThrow({ where: { companyId_code: { companyId: "cmp_mibro", code: "COMERCIAL" } } });
  const second = await prisma.category.findUniqueOrThrow({ where: { companyId_code: { companyId: "cmp_mibro", code: "SUPORTE" } } });
  let contact;
  const createdBots = [];
  try {
    await prisma.bot.updateMany({ data: { autoReplyEnabled: false } });
    await prisma.botGlobalSettings.upsert({ where: { id: "singleton" }, update: { automationEnabled: true }, create: { id: "singleton" } });
    await prisma.botResponse.upsert({ where: { companyId_key: { companyId: "cmp_mibro", key: "ASSIST_MIBRO_EMPRESA" } }, update: {}, create: { companyId: "cmp_mibro", key: "ASSIST_MIBRO_EMPRESA", title: "Mibro", category: "GERAL", text: "Informação institucional cadastrada." } });
    const triageGraph = { nodes: [{ key: "start", type: "start", config: {} }, { key: "menu", type: "menu", config: { text: "Qual setor?", variable: "flow.selectedOption", options: [{ id: "com", label: "Comercial" }, { id: "sup", label: "Suporte" }] } }, { key: "com", type: "transfer_category", config: { categoryId: category.id, message: "Encaminhado ao Comercial" } }, { key: "sup", type: "transfer_category", config: { categoryId: second.id, message: "Encaminhado ao Suporte" } }], edges: [{ id: "s", source: "start", sourceHandle: "next", target: "menu" }, { id: "c", source: "menu", sourceHandle: "opt:com", target: "com" }, { id: "u", source: "menu", sourceHandle: "opt:sup", target: "sup" }] };
    for (const [name, type, botGraph, flags] of [["posttriageqa triagem", "SYSTEM_TRIAGE", triageGraph, {}], ["posttriageqa assistente", "STANDARD", graph, { assistantAfterTriage: true }]]) {
      const bot = await prisma.bot.create({ data: { companyId: "cmp_mibro", name, type, channel: "META", status: "ACTIVE", autoReplyEnabled: true, featureFlags: flags, initialMessage: "Olá", outsideHoursMessage: "Fechado", fallbackMessage: "Equipe" } });
      createdBots.push(bot.id);
      const flow = await prisma.botFlow.create({ data: { botId: bot.id, name, draftGraph: botGraph, isDefault: true } });
      const version = await prisma.botFlowVersion.create({ data: { flowId: flow.id, version: 1, graph: botGraph } });
      await prisma.botFlow.update({ where: { id: flow.id }, data: { status: "ACTIVE", activeVersionId: version.id } });
    }
    contact = await prisma.contact.create({ data: { companyId: "cmp_mibro", externalId: `posttriageqa-${Date.now()}`, phone: "5500000000000", name: "Cliente fictício pós-triagem" } });
    const conversation = await prisma.conversation.create({ data: { companyId: "cmp_mibro", contactId: contact.id, channel: "META", status: "NOVO" } });
    const output = []; let sequence = 0;
    const channel = { sendText: async (_phone, text) => { output.push(text); return { externalId: `posttriageqa-${Date.now()}-${sequence++}` }; } };
    const incoming = async (text) => { const message = await prisma.message.create({ data: { conversationId: conversation.id, channel: "META", direction: "RECEBIDA", status: "RECEBIDA", type: "text", text, occurredAt: new Date() } }); return { message, event: { type: "text", text } }; };
    const first = await incoming("Olá"); await flows.handleIncomingVisualFlow(first.event, first.message, channel);
    assert.equal((await prisma.botFlowExecution.findFirst({ where: { conversationId: conversation.id } })).botId, createdBots[0]);
    const choice = await incoming("1"); await flows.handleIncomingVisualFlow(choice.event, choice.message, channel);
    const active = await prisma.botFlowExecution.findFirst({ where: { conversationId: conversation.id, status: "WAITING_CUSTOMER" } });
    assert.equal(active.botId, createdBots[1]); assert.equal(active.currentNodeKey, "problem");
    const updated = await prisma.conversation.findUnique({ where: { id: conversation.id } });
    assert.equal(updated.categoryId, category.id); assert.equal(updated.status, "BOT");
    assert.ok(output.some((text) => text.includes("Você está em Comercial")));
    await flows.handleIncomingVisualFlow(choice.event, choice.message, channel);
    assert.equal(await prisma.botFlowExecution.count({ where: { conversationId: conversation.id } }), 2);
    const problem = await incoming("A empresa é oficial?"); await flows.handleIncomingVisualFlow(problem.event, problem.message, channel);
    assert.equal((await prisma.botFlowExecution.findUnique({ where: { id: active.id } })).currentNodeKey, "helped");
    const yes = await incoming("sim"); await flows.handleIncomingVisualFlow(yes.event, yes.message, channel);
    assert.equal((await prisma.botFlowExecution.findUnique({ where: { id: active.id } })).status, "COMPLETED");
    assert.equal((await prisma.conversation.findUnique({ where: { id: conversation.id } })).categoryId, category.id);
    const triageFlow = await prisma.botFlow.findFirst({ where: { botId: createdBots[0], isDefault: true } });
    const countBefore = await prisma.message.count();
    const simulated = await flows.simulateFlow(createdBots[0], triageFlow.id, { source: "ACTIVE", chainAfterTriage: true }, { role: "ADMIN" }, { now: new Date("2026-10-05T14:00:00Z") });
    const next = await flows.simulateFlow(createdBots[0], triageFlow.id, { source: "ACTIVE", chainAfterTriage: true, state: simulated.state, message: "1" }, { role: "ADMIN" }, { now: new Date("2026-10-05T14:01:00Z") });
    assert.equal(next.botId, createdBots[1]); assert.equal(next.state.currentNodeKey, "problem");
    assert.ok(next.outputs.some((output) => output.text.includes("Assistente iniciado em Comercial")));
    const simulatedAnswer = await flows.simulateFlow(next.botId, next.flowId, { state: next.state, message: "empresa oficial", source: "ACTIVE" }, { role: "ADMIN" }, { now: new Date("2026-10-05T14:02:00Z") });
    assert.equal(simulatedAnswer.state.context.conversation.categoryName, "Comercial");
    assert.equal(await prisma.message.count(), countBefore, "O simulador em cadeia nunca grava/envia mensagens reais");
  } finally {
    // Cleanup is restricted to fixtures in the exact isolated database guarded above.
    if (contact) { await prisma.conversation.deleteMany({ where: { contactId: contact.id } }); await prisma.contact.delete({ where: { id: contact.id } }); }
    await prisma.bot.deleteMany({ where: { id: { in: createdBots } } });
    for (const bot of before) await prisma.bot.update({ where: { id: bot.id }, data: { autoReplyEnabled: bot.autoReplyEnabled } });
  }
});
test.after(async () => prisma.$disconnect());
