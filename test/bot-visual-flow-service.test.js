require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const flows = require("../src/services/bot-visual-flow-service");
const { handleIncomingTriage } = require("../src/services/triage-bot-service");
const { seedTriageBot } = require("../prisma/seed");
const { createApp } = require("../src/app");
const jwt = require("jsonwebtoken");
const { COOKIE_NAME } = require("../src/services/auth-service");

const sessionCookie = (user) => `${COOKIE_NAME}=${jwt.sign({ sub: user.id, sv: user.sessionVersion }, process.env.SESSION_SECRET, { expiresIn: "1h" })}`;

const PREFIX = "Bot Flow Builder Teste";
const masterEmail = "master-visual-flow-test@teste.local";
const agentEmail = "agent-visual-flow-test@teste.local";
const contactPrefix = "visual-flow-test-contact";
let master;
let agent;
let support;
let commercial;
let contactCounter = 0;

const node = (key, type, config = {}, x = 0, y = 0) => ({ key, type, name: key, x, y, config });
const edge = (source, sourceHandle, target) => ({ id: `${source}:${sourceHandle}`, source, sourceHandle, target });

function menuGraph() {
  return {
    nodes: [
      node("start", "start", {}, 40, 200),
      node("hello", "message", { text: "Olá {{contact.firstName}}!" }, 260, 200),
      node("menu", "menu", { text: "Como podemos ajudar?", options: [{ id: "s", label: "Suporte" }, { id: "c", label: "Comercial" }, { id: "g", label: "Garantia" }] }, 480, 200),
      node("toSupport", "transfer_category", { categoryId: support.id, message: "Encaminhando para o Suporte." }, 720, 80),
      node("toCommercial", "transfer_category", { categoryId: commercial.id }, 720, 200),
      node("ask", "question", { text: "Qual o número da nota?", variable: "customer.invoice" }, 720, 320),
      node("end", "end", { message: "Obrigado!" }, 960, 320),
    ],
    edges: [
      edge("start", "next", "hello"), edge("hello", "next", "menu"),
      edge("menu", "opt:s", "toSupport"), edge("menu", "opt:c", "toCommercial"), edge("menu", "opt:g", "ask"),
      edge("ask", "next", "end"),
    ],
    viewport: { x: 10, y: -20, zoom: 0.8 },
  };
}

async function createBot(data = {}) {
  return prisma.bot.create({ data: {
    name: `${PREFIX} ${Math.random().toString(36).slice(2, 8)}`, channel: "META", status: "ACTIVE",
    initialMessage: "oi", outsideHoursMessage: "fora", fallbackMessage: "fallback", ...data,
  } });
}

async function newConversation() {
  contactCounter += 1;
  const contact = await prisma.contact.create({ data: { externalId: `${contactPrefix}-${contactCounter}-${Date.now()}`, phone: `55119${String(Date.now()).slice(-8)}`, name: "Joana Teste" } });
  return prisma.conversation.create({ data: { contactId: contact.id }, include: { contact: true } });
}

async function incoming(conversation, text) {
  return prisma.message.create({ data: {
    conversationId: conversation.id, externalId: `wamid.visualflow.${Date.now()}.${Math.random()}`,
    direction: "RECEBIDA", status: "RECEBIDA", type: "text", text, occurredAt: new Date(),
  } });
}

function fakeChannel() {
  const sent = [];
  return { sent, sendText: async (phone, text) => { sent.push(text); return { externalId: `wamid.out.${sent.length}.${Math.random()}`, data: { ok: true } }; } };
}

async function publishedFlowBot(graph = menuGraph()) {
  const bot = await createBot({ autoReplyEnabled: true });
  const flow = await flows.createFlow(bot.id, { name: "Fluxo principal" }, master);
  await flows.saveDraft(bot.id, flow.id, { graph }, master);
  await flows.publishFlow(bot.id, flow.id, {}, master);
  await flows.setExecutionMode(bot.id, "FLOW_BUILDER", master);
  return { bot, flowId: flow.id };
}

async function cleanup() {
  await prisma.bot.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: contactPrefix } } });
}

test.before(async () => {
  await cleanup();
  master = await prisma.user.upsert({ where: { email: masterEmail }, update: {}, create: { name: "Master Flow", email: masterEmail, role: "ADMIN" } });
  agent = await prisma.user.upsert({ where: { email: agentEmail }, update: {}, create: { name: "Atendente Flow", email: agentEmail, role: "ATENDENTE" } });
  support = await prisma.category.findUnique({ where: { code: "SUPORTE" } });
  commercial = await prisma.category.findUnique({ where: { code: "COMERCIAL" } });
  await prisma.botGlobalSettings.upsert({ where: { id: "singleton" }, update: { automationEnabled: true }, create: { id: "singleton" } });
});

// Cada cenário de execução real começa sem nenhum outro Bot deste arquivo
// em FLOW_BUILDER (senão o Bot mais recente do teste anterior "ganharia" a
// conversa nova).
test.beforeEach(async () => {
  await prisma.bot.updateMany({ where: { name: { startsWith: PREFIX } }, data: { executionMode: "LEGACY" } });
});

test.after(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { email: { in: [masterEmail, agentEmail] } } });
  await prisma.$disconnect();
});

test("criar fluxo já vem com START; salvar/reabrir mantém nós, posições, conexões e viewport", async () => {
  const bot = await createBot();
  const created = await flows.createFlow(bot.id, { name: "Atendimento" }, master);
  assert.equal(created.status, "DRAFT");
  assert.equal(created.isDefault, true);
  assert.equal(created.graph.nodes.filter((item) => item.type === "start").length, 1);
  assert.equal(created.createdByName, "Master Flow");

  await flows.saveDraft(bot.id, created.id, { graph: menuGraph() }, master);
  const reopened = await flows.getFlow(bot.id, created.id, master);
  const menu = reopened.graph.nodes.find((item) => item.key === "menu");
  assert.deepEqual([menu.x, menu.y], [480, 200]);
  assert.equal(menu.config.options.length, 3);
  assert.equal(reopened.graph.edges.length, 6);
  assert.deepEqual(reopened.graph.viewport, { x: 10, y: -20, zoom: 0.8 });

  // Listagem só metadata (sem grafo).
  const list = await flows.listFlows(bot.id, master);
  assert.equal(list.length, 1);
  assert.equal(list[0].graph, undefined);
});

test("fluxo inválido não publica; publicar cria versão; draft não afeta a versão ativa; rollback", async () => {
  const bot = await createBot();
  const flow = await flows.createFlow(bot.id, { name: "Versões" }, master);
  const broken = menuGraph();
  broken.edges = broken.edges.filter((item) => item.sourceHandle !== "opt:c");
  await flows.saveDraft(bot.id, flow.id, { graph: broken }, master);
  await assert.rejects(() => flows.publishFlow(bot.id, flow.id, {}, master), (error) => {
    assert.equal(error.statusCode, 422);
    assert.ok(error.details.errors.some((item) => item.nodeKey === "menu" && item.code === "MENU_OUTPUT_MISSING"));
    return true;
  });
  assert.equal((await flows.getFlow(bot.id, flow.id, master)).activeVersion, null);

  await flows.saveDraft(bot.id, flow.id, { graph: menuGraph() }, master);
  const v1 = await flows.publishFlow(bot.id, flow.id, { label: "primeira" }, master);
  assert.equal(v1.activeVersion, 1);
  assert.equal(v1.status, "ACTIVE");

  // Editar o draft de um fluxo ACTIVE não muda a versão publicada.
  const edited = menuGraph();
  edited.nodes.find((item) => item.key === "hello").config.text = "Texto NOVO do draft";
  await flows.saveDraft(bot.id, flow.id, { graph: edited }, master);
  const published = await flows.getFlowVersion(bot.id, flow.id, 1, master);
  assert.equal(published.graph.nodes.find((item) => item.key === "hello").config.text, "Olá {{contact.firstName}}!");

  const v2 = await flows.publishFlow(bot.id, flow.id, {}, master);
  assert.equal(v2.activeVersion, 2);
  const rolledBack = await flows.rollbackFlow(bot.id, flow.id, 1, master);
  assert.equal(rolledBack.activeVersion, 1);
  assert.equal(rolledBack.versions.length, 2, "versões anteriores nunca são apagadas");
  const audits = await prisma.auditLog.findMany({ where: { entityId: bot.id, action: { startsWith: "BOT_FLOW" } } });
  assert.ok(audits.some((row) => row.action === "BOT_FLOW_PUBLISHED"));
  assert.ok(audits.some((row) => row.action === "BOT_FLOW_ROLLBACK"));
});

test("somente Master gerencia fluxos (backend)", async () => {
  const bot = await createBot();
  await assert.rejects(() => flows.createFlow(bot.id, { name: "x" }, agent), (error) => error.statusCode === 403);
  await assert.rejects(() => flows.listFlows(bot.id, agent), (error) => error.statusCode === 403);
});

test("dry-run: simulação percorre o fluxo sem enviar mensagem real nem alterar a conversa", async () => {
  const bot = await createBot();
  const flow = await flows.createFlow(bot.id, { name: "Sim" }, master);
  await flows.saveDraft(bot.id, flow.id, { graph: menuGraph() }, master);
  const before = await prisma.message.count();
  const first = await flows.simulateFlow(bot.id, flow.id, { message: "oi" }, master);
  assert.equal(first.dryRun, true);
  assert.equal(first.status, "WAITING_CUSTOMER");
  assert.equal(first.currentNodeKey, "menu");
  assert.deepEqual(first.visited, ["start", "hello", "menu"]);
  assert.equal(first.outputs[0].text, "Olá Cliente!");

  const second = await flows.simulateFlow(bot.id, flow.id, { message: "2", state: first.state }, master);
  assert.equal(second.status, "HANDED_OFF");
  assert.equal(second.trace[0].branch, "opt:c");
  assert.match(second.outputs.at(-1).text, /Comercial/);
  assert.equal(await prisma.message.count(), before, "nenhuma Message criada");
});

test("execução real: START → Menu pausa, nova mensagem retoma, transfere para o setor e registra histórico/log", async () => {
  const { bot } = await publishedFlowBot();
  const conversation = await newConversation();
  const channel = fakeChannel();

  assert.equal(await flows.handleIncomingVisualFlow({ type: "text", text: "oi" }, await incoming(conversation, "oi"), channel), true);
  assert.deepEqual(channel.sent[0], "Olá Joana!");
  assert.match(channel.sent[1], /1 - Suporte/);
  let execution = await prisma.botFlowExecution.findFirst({ where: { conversationId: conversation.id } });
  assert.equal(execution.status, "WAITING_CUSTOMER");
  assert.equal(execution.currentNodeKey, "menu");
  assert.equal(execution.botId, bot.id);
  assert.equal((await prisma.conversation.findUnique({ where: { id: conversation.id } })).status, "BOT");

  // A triagem legada não roda enquanto o fluxo é dono da conversa.
  const reply = await incoming(conversation, "quero suporte");
  assert.equal(await flows.handleIncomingVisualFlow({ type: "text", text: "quero suporte" }, reply, channel), true);
  // Reentrega do mesmo evento não avança duas vezes (idempotência).
  assert.equal(await flows.handleIncomingVisualFlow({ type: "text", text: "quero suporte" }, reply, channel), true);

  const updated = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(updated.categoryId, support.id);
  assert.equal(updated.status, "NOVO");
  assert.equal(updated.assignedUserId, null);
  execution = await prisma.botFlowExecution.findUnique({ where: { id: execution.id } });
  assert.equal(execution.status, "HANDED_OFF");
  assert.equal(channel.sent.filter((text) => text === "Encaminhando para o Suporte.").length, 1);

  const sentMessages = await prisma.message.findMany({ where: { conversationId: conversation.id, direction: "ENVIADA" } });
  assert.equal(sentMessages.length, 3);
  assert.ok(sentMessages.every((row) => row.rawPayload.system === "visual_flow"));
  const activities = await prisma.conversationActivity.findMany({ where: { conversationId: conversation.id } });
  assert.ok(activities.some((row) => row.action === "BOT_FLOW_TRANSFERRED"));
  const logs = await prisma.botFlowExecutionLog.findMany({ where: { executionId: execution.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(logs.map((row) => row.nodeKey), ["start", "hello", "menu", "menu", "toSupport"]);
  assert.equal(logs[3].branch, "opt:s");
});

test("duas mensagens simultâneas avançam o fluxo uma única vez", async () => {
  await publishedFlowBot();
  const conversation = await newConversation();
  const channel = fakeChannel();
  await flows.handleIncomingVisualFlow({ type: "text", text: "oi" }, await incoming(conversation, "oi"), channel);
  const [a, b] = [await incoming(conversation, "3"), await incoming(conversation, "3")];
  await Promise.all([
    flows.handleIncomingVisualFlow({ type: "text", text: "3" }, a, channel),
    flows.handleIncomingVisualFlow({ type: "text", text: "3" }, b, channel),
  ]);
  assert.equal(channel.sent.filter((text) => text === "Qual o número da nota?").length, 1);
});

test("humano assume no meio do fluxo: execução é encerrada e o Bot não responde mais", async () => {
  await publishedFlowBot();
  const conversation = await newConversation();
  const channel = fakeChannel();
  await flows.handleIncomingVisualFlow({ type: "text", text: "oi" }, await incoming(conversation, "oi"), channel);
  await prisma.conversation.update({ where: { id: conversation.id }, data: { assignedUserId: agent.id, status: "EM_ATENDIMENTO" } });
  const sentBefore = channel.sent.length;
  assert.equal(await flows.handleIncomingVisualFlow({ type: "text", text: "2" }, await incoming(conversation, "2"), channel), false);
  assert.equal(channel.sent.length, sentBefore);
  const execution = await prisma.botFlowExecution.findFirst({ where: { conversationId: conversation.id } });
  assert.equal(execution.status, "HANDED_OFF");
  assert.equal(execution.error, "HUMAN_TOOK_OVER_OR_FINALIZED");
});

test("Intervalo real: worker retoma o fluxo quando o timer vence", async () => {
  const graph = {
    nodes: [node("start", "start"), node("wait", "delay", { amount: 5, unit: "SECONDS" }), node("msg", "message", { text: "Depois do intervalo" }), node("end", "end")],
    edges: [edge("start", "next", "wait"), edge("wait", "next", "msg"), edge("msg", "next", "end")],
  };
  await publishedFlowBot(graph);
  const conversation = await newConversation();
  const channel = fakeChannel();
  await flows.handleIncomingVisualFlow({ type: "text", text: "oi" }, await incoming(conversation, "oi"), channel);
  const waiting = await prisma.botFlowExecution.findFirst({ where: { conversationId: conversation.id } });
  assert.equal(waiting.status, "WAITING_TIMER");
  assert.ok(waiting.resumeAt);
  assert.equal(await flows.processDueTimers({ channel, now: new Date(Date.now() - 60000) }), 0);
  assert.equal(await flows.processDueTimers({ channel, now: new Date(Date.now() + 10000) }), 1);
  assert.deepEqual(channel.sent, ["Depois do intervalo"]);
  const done = await prisma.botFlowExecution.findUnique({ where: { id: waiting.id } });
  assert.equal(done.status, "COMPLETED");
  assert.equal((await prisma.conversation.findUnique({ where: { id: conversation.id } })).status, "FINALIZADO");
});

test("Bot LEGACY (padrão) não é afetado: Flow Builder devolve false e a triagem atual segue funcionando", async () => {
  await seedTriageBot(prisma);
  const legacy = await createBot({ autoReplyEnabled: true });
  assert.equal(legacy.executionMode, "LEGACY");
  const conversation = await newConversation();
  const message = await incoming(conversation, "Olá");
  const channel = { ...fakeChannel(), sendList: async () => ({ externalId: `wamid.list.${Math.random()}`, data: {} }) };
  assert.equal(await flows.handleIncomingVisualFlow({ type: "text", text: "Olá" }, message, channel), false);
  assert.equal(await prisma.botFlowExecution.count({ where: { conversationId: conversation.id } }), 0);
  const handled = await handleIncomingTriage({ type: "text", text: "Olá" }, message, channel, { now: new Date("2026-08-12T14:00:00.000Z") });
  assert.equal(handled, true);
});

test("Bot em FLOW_BUILDER com auto-resposta desligada nunca responde", async () => {
  const { bot } = await publishedFlowBot();
  await prisma.bot.update({ where: { id: bot.id }, data: { autoReplyEnabled: false } });
  const conversation = await newConversation();
  const channel = fakeChannel();
  assert.equal(await flows.handleIncomingVisualFlow({ type: "text", text: "oi" }, await incoming(conversation, "oi"), channel), false);
  assert.equal(channel.sent.length, 0);
});

test("modo FLOW_BUILDER exige fluxo padrão publicado e ativo", async () => {
  const bot = await createBot();
  await flows.createFlow(bot.id, { name: "sem publicar" }, master);
  await assert.rejects(() => flows.setExecutionMode(bot.id, "FLOW_BUILDER", master), /Publique e ative/);
});

test("HTTP: rotas exigem Master e simulação funciona pela API", async () => {
  const bot = await createBot();
  const channel = fakeChannel();
  const server = createApp({ channel }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const masterCookie = sessionCookie(master);
    const agentCookie = sessionCookie(agent);
    const forbidden = await fetch(`${base}/api/bots/${bot.id}/visual-flows`, { headers: { Cookie: agentCookie } });
    assert.equal(forbidden.status, 403);
    const created = await fetch(`${base}/api/bots/${bot.id}/visual-flows`, {
      method: "POST", headers: { Cookie: masterCookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "API" }),
    });
    assert.equal(created.status, 201);
    const flow = await created.json();
    const invalid = await fetch(`${base}/api/bots/${bot.id}/visual-flows/${flow.id}/publish`, {
      method: "POST", headers: { Cookie: masterCookie, "Content-Type": "application/json" }, body: "{}",
    });
    // Grafo padrão (Início → Finalizar) é válido.
    assert.equal(invalid.status, 200);
    const simulated = await fetch(`${base}/api/bots/${bot.id}/visual-flows/${flow.id}/simulate`, {
      method: "POST", headers: { Cookie: masterCookie, "Content-Type": "application/json" }, body: JSON.stringify({ message: "oi" }),
    });
    const body = await simulated.json();
    assert.equal(body.status, "COMPLETED");
    assert.equal(channel.sent.length, 0);
    const page = await fetch(`${base}/flow-builder?botId=${bot.id}`, { headers: { Cookie: agentCookie }, redirect: "manual" });
    assert.notEqual(page.status, 200);
  } finally {
    server.close();
  }
});
