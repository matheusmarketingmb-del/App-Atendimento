const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTriageGraph, buildAssistantGraph, ensureQuestionAnswerBots } = require("../src/services/flow-builder-migration-service");
const { validateGraph } = require("../src/services/bot-visual-flow-graph");
const { runTurn, renderTemplate } = require("../src/services/bot-visual-flow-engine");
const { summarizeLogs, withQuality } = require("../src/services/bot-question-answer-observation");
const prisma = require("../src/database/prisma");
const categories = [
  { id: "qa-atendimento", code: "ATENDIMENTO", name: "Atendimento", active: true },
  { id: "qa-comercial", code: "COMERCIAL", name: "Comercial", active: true },
  { id: "qa-atacado", code: "ATACADO", name: "Atacado", active: true, parentId: "qa-comercial" },
  { id: "qa-varejo", code: "VAREJO", name: "Varejo", active: true, parentId: "qa-comercial" },
  { id: "qa-restrito", code: "RESTRITO", name: "Restrito", active: true, masterOnly: true },
];
const triage = { initialMessage: "Olá {{saudacao}}", handoffMessage: "Para {{categoria}}", triageOptions: categories.map((category) => ({ enabled: true, label: category.name, category })) };
const graph = buildTriageGraph(triage, new Map(categories.map((category) => [category.code, category])));
const seed = { contact: { greeting: "Ana" }, bot: { initialMessage: "Olá {{contact.greeting}}", handoffMessage: "Para {{bot.categoryName}}", availabilityManaged: true, withinBusinessHours: true, closedMessage: "Estamos fechados" } };
function adapter(outputs = []) { return {
  send: async (text) => outputs.push(text), sendMenu: async (menu) => outputs.push(menu),
  categoryName: async (id) => categories.find((category) => category.id === id)?.name,
  transferToCategory: async (data) => outputs.push(data), handoff: async (data) => outputs.push(data), finish: async () => {},
}; }
test.after(async () => prisma.$disconnect());

test("triagem mantém hierarquia e exclui setores Master", () => {
  const checked = validateGraph(graph, { categoryIds: new Set(categories.map((category) => category.id)) });
  assert.equal(checked.valid, true, JSON.stringify(checked.errors));
  assert.deepEqual(graph.nodes.find((node) => node.key === "menu").config.options.map((option) => option.label), ["Atendimento", "Comercial"]);
  assert.ok(graph.nodes.some((node) => node.key === "submenu_2"));
});
test("mensagens centralizadas expandem saudação e setor", () => assert.equal(renderTemplate("{{bot.initialMessage}}", seed), "Olá Ana"));
test("seleção Comercial > Atacado transfere para o setor correto", async () => {
  const outputs = [], deps = { graph, adapter: adapter(outputs), seed };
  const start = await runTurn({ ...deps, input: { type: "START" } });
  const commercial = await runTurn({ ...deps, state: start.state, input: { type: "MESSAGE", text: "2" } });
  assert.equal(commercial.state.currentNodeKey, "submenu_2");
  const wholesale = await runTurn({ ...deps, state: commercial.state, input: { type: "MESSAGE", text: "1" } });
  assert.equal(wholesale.state.status, "HANDED_OFF");
  assert.equal(outputs.at(-1).categoryId, "qa-atacado");
  assert.equal(outputs.at(-1).message, "Para Atacado");
});
test("fora do horário aguarda sem mostrar menu; retoma no próximo expediente", async () => {
  const outputs = [];
  const closed = await runTurn({ graph, adapter: adapter(outputs), seed: { ...seed, bot: { ...seed.bot, withinBusinessHours: false } }, input: { type: "START" } });
  assert.deepEqual(outputs, ["Estamos fechados"]);
  closed.state.context.bot.withinBusinessHours = true;
  const open = await runTurn({ graph, adapter: adapter(outputs), seed, state: closed.state, input: { type: "MESSAGE", text: "Olá" } });
  assert.equal(open.state.currentNodeKey, "menu");
  assert.equal(outputs.at(-1).text, "Olá Ana");
});
test("número restrito a Atacado não oferece Atendimento/Varejo", async () => {
  const outputs = [], scopedSeed = { ...seed, conversation: { allowedCategoryIds: ["qa-atacado"] } };
  const first = await runTurn({ graph, adapter: adapter(outputs), seed: scopedSeed, input: { type: "START" } });
  assert.deepEqual(outputs.at(-1).options.map((item) => item.label), ["Comercial"]);
  await runTurn({ graph, adapter: adapter(outputs), seed: scopedSeed, state: first.state, input: { type: "MESSAGE", text: "1" } });
  assert.deepEqual(outputs.at(-1).options.map((item) => item.label), ["Atacado", "Voltar"]);
});
test("tempo do cliente e tentativas sem opção são observáveis", async () => {
  const first = await runTurn({ graph, adapter: adapter(), seed, input: { type: "START" }, now: new Date("2026-10-05T13:00:00Z") });
  const second = await runTurn({ graph, adapter: adapter(), seed, state: first.state, input: { type: "MESSAGE", text: "não selecionei" }, now: new Date("2026-10-05T13:00:12Z") });
  const log = second.trace[0];
  assert.equal(log.output.customerReplyMs, 12000);
  assert.equal(log.output.attempts, 1);
  const summary = summarizeLogs([{ ...log, executionId: "one" }]);
  assert.equal(summary.unmatchedMessages, 1);
  assert.equal(summary.customerReply.averageMs, 12000);
  assert.equal(summary.botResponse.averageMs, null);
});
test("Assistente converte perguntas/respostas; Knowledge não vira resposta inventada", () => {
  const assistant = { intents: [{ id: "i", name: "Dúvida", active: true, flowSteps: [{ id: "s1", name: "Pergunta", action: "ASK_QUESTION", question: "Qual o modelo?", order: 1, active: true }, { id: "s2", name: "Consulta antiga", action: "USE_KNOWLEDGE", order: 2, active: true }] }] };
  const converted = buildAssistantGraph(assistant);
  assert.equal(converted.nodes.find((node) => node.key === "i0_s1").type, "question");
  assert.equal(converted.nodes.find((node) => node.key === "i0_s2").type, "human_handoff");
});
test("qualidade coleta nota e comentário antes de concluir", async () => {
  const qa = { nodes: [{ key: "start", type: "start", config: {} }, { key: "end", type: "end", config: { finalizeConversation: false } }], edges: [{ id: "e", source: "start", sourceHandle: "next", target: "end" }] };
  const decorated = withQuality(qa, { ratingEnabled: true, requestRatingComment: true });
  const first = await runTurn({ graph: decorated, adapter: adapter(), seed, input: { type: "START" } });
  const score = await runTurn({ graph: decorated, adapter: adapter(), state: first.state, input: { type: "MESSAGE", text: "5" } });
  const done = await runTurn({ graph: decorated, adapter: adapter(), state: score.state, input: { type: "MESSAGE", text: "Ótimo" } });
  assert.equal(done.state.status, "COMPLETED");
  assert.equal(done.state.context.flow.ratingScore, "5");
  assert.equal(done.state.context.flow.ratingComment, "Ótimo");
});

test("conversão persistente é seletiva, idempotente e não apaga histórico", async () => {
  assert.equal(process.env.DATABASE_URL, "postgresql://bot_qa:isolated-local-qa@127.0.0.1:25432/bot_qa", "Use SOMENTE o banco local isolado indicado neste teste.");
  for (const category of categories) await prisma.category.upsert({ where: { id: category.id }, update: {}, create: { ...category, code: `QA_${category.code}` } });
  const bot = await prisma.bot.upsert({ where: { id: "system-triage-bot" }, update: {}, create: { id: "system-triage-bot", name: "Triagem Inicial", type: "SYSTEM_TRIAGE", isSystem: true, status: "ACTIVE", autoReplyEnabled: true, executionMode: "LEGACY", channel: "META", initialMessage: "Olá", outsideHoursMessage: "Fechado", fallbackMessage: "Equipe" } });
  for (const category of categories) await prisma.botTriageOption.upsert({ where: { botId_categoryId: { botId: bot.id, categoryId: category.id } }, update: { label: `QA ${category.name}` }, create: { botId: bot.id, categoryId: category.id, label: `QA ${category.name}` } });
  await prisma.bot.upsert({ where: { id: "qa-archive" }, update: {}, create: { id: "qa-archive", name: "Bot extra QA", channel: "META", executionMode: "LEGACY", initialMessage: "Original", outsideHoursMessage: "Original", fallbackMessage: "Original" } });
  const before = { conversations: await prisma.conversation.count(), messages: await prisma.message.count(), intents: await prisma.botIntent.count() };
  const assistantEnabledBefore = (await prisma.bot.findUnique({ where: { id: "mibro-assistant-observer" } })).autoReplyEnabled;
  await ensureQuestionAnswerBots({ log: { info() {} } });
  assert.equal((await prisma.bot.findUnique({ where: { id: "system-triage-bot" } })).autoReplyEnabled, true);
  assert.equal((await prisma.bot.findUnique({ where: { id: "mibro-assistant-observer" } })).autoReplyEnabled, assistantEnabledBefore);
  assert.equal((await prisma.bot.findUnique({ where: { id: "qa-archive" } })).status, "ARCHIVED_LEGACY");
  const count = await prisma.botFlow.count();
  await ensureQuestionAnswerBots({ log: { info() {} } });
  assert.equal(await prisma.botFlow.count(), count);
  assert.deepEqual({ conversations: await prisma.conversation.count(), messages: await prisma.message.count(), intents: await prisma.botIntent.count() }, before);
});
