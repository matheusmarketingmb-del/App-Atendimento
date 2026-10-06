// Flow Builder como único modelo de Bot — serviços com banco (schema de
// teste). Canal sempre falso: nada é enviado de verdade.
require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const bots = require("../src/services/bot-service");
const flows = require("../src/services/bot-visual-flow-service");
const governance = require("../src/services/bot-governance-service");
const pause = require("../src/services/bot-pause-service");
const library = require("../src/services/bot-response-library-service");
const webhooks = require("../src/services/bot-webhook-endpoint-service");
const { ensureTriageFlow } = require("../src/services/flow-builder-migration-service");
const { saveIncoming } = require("../src/services/message-service");

const PREFIX = "fbtest";
const masterEmail = `${PREFIX}-master@teste.local`;
const agentEmail = `${PREFIX}-agent@teste.local`;
let master;
let agent;
let support;
let commercial;

function fakeChannel() {
  const sent = [];
  let counter = 0;
  const reply = (kind) => async (to, payload) => { sent.push({ kind, to, payload }); counter += 1; return { externalId: `wamid.${PREFIX}.out.${Date.now()}.${counter}`, data: {} }; };
  return { sent, sendText: reply("text"), sendList: reply("list"), sendImage: reply("image"), sendAudio: reply("audio"), sendVideo: reply("video"), sendDocument: reply("document") };
}

async function cleanupData() {
  const testBots = await prisma.bot.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const botIds = testBots.map((bot) => bot.id);
  await prisma.botFlowExecution.deleteMany({ where: { botId: { in: botIds } } });
  await prisma.bot.deleteMany({ where: { id: { in: botIds } } });
  await prisma.conversation.deleteMany({ where: { contact: { is: { externalId: { startsWith: PREFIX } } } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: PREFIX } } });
  await prisma.botResponse.deleteMany({ where: { key: { startsWith: "FBTEST_" } } });
  await prisma.botWebhookEndpoint.deleteMany({ where: { key: { startsWith: "fbtest_" } } });
}

test.before(async () => {
  await cleanupData();
  await prisma.user.deleteMany({ where: { email: { in: [masterEmail, agentEmail] } } });
  master = await prisma.user.create({ data: { name: "Master FB", email: masterEmail, role: "ADMIN" } });
  agent = await prisma.user.create({ data: { name: "Ana Suporte", email: agentEmail, role: "ATENDENTE" } });
  support = await prisma.category.findUnique({ where: { code: "SUPORTE" } });
  commercial = await prisma.category.findUnique({ where: { code: "COMERCIAL" } });
  await prisma.userCategoryAccess.create({ data: { userId: agent.id, categoryId: support.id } });
  await governance.reactivateAutomation(master);
});

test.after(async () => {
  await cleanupData();
  await prisma.user.deleteMany({ where: { email: { in: [masterEmail, agentEmail] } } });
  await prisma.$disconnect();
});

function node(key, type, config = {}, x = 0) {
  return { key, type, name: key, x, y: 0, config };
}
function edge(source, sourceHandle, target) {
  return { id: `${source}:${sourceHandle}->${target}`, source, sourceHandle, target };
}

function supportGraph(extraNodes = [], extraEdges = []) {
  return {
    nodes: [
      node("start", "start", { trigger: "NEW_CONVERSATION" }),
      node("menu", "menu", {
        text: "{{contact.greeting}}! Escolha:", variable: "flow.selectedOption", display: "LIST", maxAttempts: 3,
        options: [{ id: "sup", label: "Suporte", keywords: ["problema"] }, { id: "com", label: "Comercial", keywords: [] }],
      }),
      node("tip", "message", { source: "LIBRARY", responseKey: "FBTEST_CARREGAMENTO" }),
      node("solved", "question", { text: "Resolveu?", variable: "flow.solved", answerType: "YES_NO", maxAttempts: 2 }),
      node("check", "condition", { rules: [{ left: "flow.solved", operator: "==", right: "true" }] }),
      node("bye", "end", { message: "Que bom! Até mais.", finalizeConversation: true }),
      node("to-support", "transfer_category", { categoryId: support.id, message: "Vou te passar para o Suporte." }),
      node("to-commercial", "transfer_category", { categoryId: commercial.id, message: "Comercial já vai falar com você." }),
      ...extraNodes,
    ],
    edges: [
      edge("start", "next", "menu"), edge("menu", "opt:sup", "tip"), edge("menu", "opt:com", "to-commercial"),
      edge("tip", "next", "solved"), edge("solved", "next", "check"), edge("check", "true", "bye"), edge("check", "false", "to-support"),
      ...extraEdges,
    ],
  };
}

// Só o Bot do teste responde no canal (os demais Bots de teste ficam com a
// auto-resposta desligada) — senão o Bot atualizado mais recentemente
// "rouba" a conversa.
async function onlyThisBotResponds(botId) {
  await prisma.bot.updateMany({ where: { id: { not: botId }, autoReplyEnabled: true }, data: { autoReplyEnabled: false } });
}

async function createReadyBot(name, graph = supportGraph()) {
  const bot = await bots.createBot({ name: `${PREFIX} ${name}`, description: "teste", channels: ["META"] }, master);
  await flows.saveDraft(bot.id, bot.createdFlowId, { graph }, master);
  await flows.publishFlow(bot.id, bot.createdFlowId, {}, master);
  await onlyThisBotResponds(bot.id);
  return { bot: await bots.setAutoReply(bot.id, true, master), flowId: bot.createdFlowId };
}

let incomingCounter = 0;
async function incoming(phone, text, extra = {}) {
  incomingCounter += 1;
  const event = {
    externalId: `wamid.${PREFIX}.in.${Date.now()}.${incomingCounter}`, contactExternalId: `${PREFIX}-${phone}`, phone,
    contactName: "Maria Teste", type: "text", text, occurredAt: new Date(), ...extra,
  };
  const result = await saveIncoming(event);
  return { event, message: result.message };
}

test("criar Bot já cria o fluxo principal, nasce FLOW_BUILDER e com auto-resposta DESLIGADA", async () => {
  const bot = await bots.createBot({ name: `${PREFIX} Novo`, description: "Atendimento", channels: ["META"], executionMode: "LEGACY", type: "SYSTEM_TRIAGE" }, master);
  assert.ok(bot.createdFlowId);
  assert.equal(bot.autoReplyEnabled, false);
  assert.equal(bot.flows.length, 1);
  assert.equal(bot.flows[0].isDefault, true);
  const row = await prisma.bot.findUnique({ where: { id: bot.id } });
  assert.equal(row.executionMode, "FLOW_BUILDER");
  assert.equal(row.type, "STANDARD");
  await assert.rejects(() => bots.setAutoReply(bot.id, true, master), /Publique e ative o fluxo padrão/);
  await assert.rejects(() => bots.createBot({ name: `${PREFIX} x`, channels: [] }, master), /pelo menos um canal/);
  await assert.rejects(() => bots.listBots(agent), /Master/);
});

test("biblioteca Respostas do Bot: CRUD, código imutável e bloqueio de exclusão em uso", async () => {
  const created = await library.createResponse({ key: "fbtest carregamento", title: "Carregamento", category: "SUPORTE", text: "Verifique se os contatos estão limpos e secos, {{contact.firstName}}." }, master);
  assert.equal(created.key, "FBTEST_CARREGAMENTO");
  await assert.rejects(() => library.createResponse({ key: "FBTEST_CARREGAMENTO", title: "x", text: "y" }, master), /Já existe/);
  await assert.rejects(() => library.createResponse({ key: "FBTEST_X", title: "x", text: "y", category: "INEXISTENTE" }, master), /Categoria/);
  await assert.rejects(() => library.updateResponse(created.id, { key: "OUTRO" }, master), /não pode ser alterado/);
  const { bot, flowId } = await createReadyBot("Biblioteca");
  await assert.rejects(() => library.deleteResponse(created.id, master), /em uso/);
  await assert.rejects(() => library.updateResponse(created.id, { active: false }, master), /em uso/);
  assert.ok((await library.findUsages("FBTEST_CARREGAMENTO")).some((usage) => usage.flowId === flowId && usage.botId === bot.id));
});

test("salvar/publicar/versionar: rascunho não altera a versão ativa; rollback e restaurar para rascunho", async () => {
  const { bot, flowId } = await createReadyBot("Versoes");
  const v1 = await flows.getFlow(bot.id, flowId, master);
  assert.equal(v1.activeVersion, 1);
  assert.equal(v1.status, "ACTIVE");

  const edited = supportGraph();
  edited.nodes.find((item) => item.key === "bye").config.message = "Versão 2!";
  await flows.saveDraft(bot.id, flowId, { graph: edited }, master);
  assert.equal((await flows.getFlow(bot.id, flowId, master)).activeVersion, 1, "salvar rascunho nunca publica");
  await flows.publishFlow(bot.id, flowId, { label: "texto novo" }, master);
  assert.equal((await flows.getFlow(bot.id, flowId, master)).activeVersion, 2);

  await flows.rollbackFlow(bot.id, flowId, 1, master);
  const rolled = await flows.getFlow(bot.id, flowId, master);
  assert.equal(rolled.activeVersion, 1);
  assert.equal(rolled.graph.nodes.find((item) => item.key === "bye").config.message, "Versão 2!", "rollback não mexe no rascunho");
  await flows.restoreVersionToDraft(bot.id, flowId, 1, master);
  assert.equal((await flows.getFlow(bot.id, flowId, master)).graph.nodes.find((item) => item.key === "bye").config.message, "Que bom! Até mais.");

  // Publicar com erro é bloqueado e devolve os erros por nó.
  const broken = supportGraph();
  broken.edges = broken.edges.filter((item) => item.sourceHandle !== "opt:com");
  await flows.saveDraft(bot.id, flowId, { graph: broken }, master);
  await assert.rejects(() => flows.publishFlow(bot.id, flowId, {}, master), (error) => error.statusCode === 422 && error.details.errors.some((item) => item.code === "MENU_OUTPUT_MISSING"));
});

test("simulador: dry-run com lista clicável, biblioteca e trilha nó a nó — nada é enviado", async () => {
  const { bot, flowId } = await createReadyBot("Simulador");
  const sentBefore = await prisma.message.count();
  const first = await flows.simulateFlow(bot.id, flowId, { message: "oi", source: "ACTIVE" }, master);
  assert.equal(first.status, "WAITING_CUSTOMER");
  assert.equal(first.currentNodeKey, "menu");
  const menuOutput = first.outputs.find((output) => output.options);
  assert.deepEqual(menuOutput.options.map((option) => option.label), ["Suporte", "Comercial"]);

  const clicked = await flows.simulateFlow(bot.id, flowId, { message: "Suporte", replyId: menuOutput.options[0].replyId, state: first.state, source: "ACTIVE" }, master);
  assert.equal(clicked.currentNodeKey, "solved");
  assert.ok(clicked.outputs.some((output) => output.text === "Verifique se os contatos estão limpos e secos, Cliente."));
  assert.deepEqual(clicked.trace.map((entry) => [entry.nodeKey, entry.result, entry.branch]), [["menu", "OK", "opt:sup"], ["tip", "OK", "next"], ["solved", "WAITING", null]]);

  const done = await flows.simulateFlow(bot.id, flowId, { message: "não", state: clicked.state, source: "ACTIVE" }, master);
  assert.equal(done.status, "HANDED_OFF");
  assert.ok(done.outputs.some((output) => output.type === "event" && /Suporte/.test(output.text)));
  assert.equal(await prisma.message.count(), sentBefore, "simulação nunca grava mensagens");
});

test("execução real: inicia na conversa nova, pausa no menu, retoma com o clique e transfere para o setor", async () => {
  await createReadyBot("Real");
  const channel = fakeChannel();
  const phone = "5511900000101";
  const first = await incoming(phone, "Olá");
  assert.equal(await flows.handleIncomingVisualFlow(first.event, first.message, channel), true);
  let conversation = await prisma.conversation.findUnique({ where: { id: first.message.conversationId } });
  assert.equal(conversation.status, "BOT");
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].kind, "list");
  assert.match(channel.sent[0].payload.body, /Olá, Maria! Escolha:/);
  const execution = await prisma.botFlowExecution.findFirst({ where: { conversationId: conversation.id } });
  assert.equal(execution.status, "WAITING_CUSTOMER");
  assert.equal(execution.currentNodeKey, "menu");

  // Mesmo evento reentregue pela Meta não avança o fluxo duas vezes.
  assert.equal(await flows.handleIncomingVisualFlow(first.event, first.message, channel), true);
  assert.equal(channel.sent.length, 1);

  const click = await incoming(phone, "Comercial", { interactiveReplyId: channel.sent[0].payload.rows[1].id, interactiveTitle: "Comercial" });
  await flows.handleIncomingVisualFlow(click.event, click.message, channel);
  conversation = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(conversation.status, "NOVO");
  assert.equal(conversation.categoryId, commercial.id);
  assert.equal(channel.sent.at(-1).payload, "Comercial já vai falar com você.");
  const finished = await prisma.botFlowExecution.findUnique({ where: { id: execution.id } });
  assert.equal(finished.status, "HANDED_OFF");
  assert.ok(await prisma.conversationActivity.findFirst({ where: { conversationId: conversation.id, action: "BOT_FLOW_TRANSFERRED" } }));
  const logs = await prisma.botFlowExecutionLog.findMany({ where: { executionId: execution.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(logs.filter((log) => log.nodeType !== "metrics").map((log) => `${log.nodeKey}:${log.result}`).sort(), ["menu:OK", "menu:WAITING", "start:OK", "to-commercial:DONE"]);
  assert.equal(logs.filter((log) => log.nodeType === "metrics").length, 2);
  // Mensagem de transferência marcada: o monitor de inatividade não finaliza.
  const lastSent = await prisma.message.findFirst({ where: { conversationId: conversation.id, direction: "ENVIADA" }, orderBy: { occurredAt: "desc" } });
  assert.equal(lastSent.rawPayload.flowHandoff, true);
});

test("pausar Bot na conversa (Cancelar Bot) e conversa assumida cancelam a execução em espera", async () => {
  await createReadyBot("Pausa");
  const channel = fakeChannel();
  const phone = "5511900000102";
  const first = await incoming(phone, "Oi");
  await flows.handleIncomingVisualFlow(first.event, first.message, channel);
  await pause.pauseBot(first.message.conversationId, master);
  const next = await incoming(phone, "1");
  assert.equal(await flows.handleIncomingVisualFlow(next.event, next.message, channel), false);
  assert.equal(channel.sent.length, 1, "nada é enviado depois da pausa");
  const execution = await prisma.botFlowExecution.findFirst({ where: { conversationId: first.message.conversationId } });
  assert.equal(execution.status, "HANDED_OFF");
  assert.equal(execution.error, "HUMAN_TOOK_OVER_OR_FINALIZED");
  const resumed = await pause.resumeBot(first.message.conversationId, master);
  assert.equal(resumed.humanPausedAt, null);
});

test("kill switch global e Bot pausado bloqueiam qualquer resposta; Bot ARCHIVED_LEGACY nunca executa", async () => {
  const { bot } = await createReadyBot("Kill");
  const channel = fakeChannel();
  await governance.deactivateAutomation(master);
  try {
    const blocked = await incoming("5511900000103", "Oi");
    assert.equal(await flows.handleIncomingVisualFlow(blocked.event, blocked.message, channel), false);
  } finally {
    await governance.reactivateAutomation(master);
  }
  await bots.setBotStatus(bot.id, "PAUSED", master);
  const paused = await incoming("5511900000104", "Oi");
  assert.equal(await flows.handleIncomingVisualFlow(paused.event, paused.message, channel), false);

  // Bot antigo arquivado (mesmo com auto-resposta e fluxo publicado) não roda.
  await prisma.bot.update({ where: { id: bot.id }, data: { status: "ARCHIVED_LEGACY" } });
  const legacy = await incoming("5511900000105", "Oi");
  assert.equal(await flows.handleIncomingVisualFlow(legacy.event, legacy.message, channel), false);
  assert.equal(channel.sent.length, 0);
  assert.ok(!(await bots.listBots(master)).some((item) => item.id === bot.id), "ARCHIVED_LEGACY some da lista principal");
  assert.ok((await bots.listLegacyBots(master)).some((item) => item.id === bot.id), "e aparece no Histórico técnico");
  await assert.rejects(() => bots.getBot(bot.id, master), /não encontrado/);
  await assert.rejects(() => bots.setBotStatus(bot.id, "ARCHIVED_LEGACY", master), /inválido/);
});

test("Intervalo + Transferir para atendente: worker retoma o timer e atribui respeitando o setor", async () => {
  const graph = {
    nodes: [
      node("start", "start", { categoryId: support.id }),
      node("wait", "delay", { amount: 1, unit: "MINUTES" }),
      node("msg", "message", { text: "Obrigado por aguardar." }),
      node("ana", "transfer_user", { userId: agent.id, message: "A Ana vai te atender." }),
    ],
    edges: [edge("start", "next", "wait"), edge("wait", "next", "msg"), edge("msg", "next", "ana")],
  };
  await createReadyBot("Timer", graph);
  const channel = fakeChannel();
  const first = await incoming("5511900000106", "Oi");
  await flows.handleIncomingVisualFlow(first.event, first.message, channel);
  const execution = await prisma.botFlowExecution.findFirst({ where: { conversationId: first.message.conversationId } });
  assert.equal(execution.status, "WAITING_TIMER");
  assert.equal(await flows.processDueTimers({ channel, now: new Date() }), 0, "antes do horário nada acontece");
  assert.equal(await flows.processDueTimers({ channel, now: new Date(Date.now() + 2 * 60 * 1000) }), 1);
  const conversation = await prisma.conversation.findUnique({ where: { id: first.message.conversationId } });
  assert.equal(conversation.assignedUserId, agent.id);
  assert.equal(conversation.categoryId, support.id);
  assert.equal(conversation.status, "EM_ATENDIMENTO");
  assert.deepEqual(channel.sent.map((item) => item.payload), ["Obrigado por aguardar.", "A Ana vai te atender."]);
});

test("Ir para fluxo em produção: subfluxo publicado e ativo continua no mesmo turno", async () => {
  const main = await bots.createBot({ name: `${PREFIX} Subfluxo`, channels: ["META"] }, master);
  const sub = await flows.createFlow(main.id, { name: "Suporte" }, master);
  await flows.saveDraft(main.id, sub.id, { graph: {
    nodes: [node("start", "start"), node("hi", "message", { text: "Você está no Suporte." }), node("end", "end", { finalizeConversation: false })],
    edges: [edge("start", "next", "hi"), edge("hi", "next", "end")],
  } }, master);
  await flows.publishFlow(main.id, sub.id, {}, master);
  await flows.saveDraft(main.id, main.createdFlowId, { graph: {
    nodes: [node("start", "start"), node("go", "goto_flow", { flowId: sub.id })], edges: [edge("start", "next", "go")],
  } }, master);
  await flows.publishFlow(main.id, main.createdFlowId, {}, master);
  await onlyThisBotResponds(main.id);
  await bots.setAutoReply(main.id, true, master);
  await assert.rejects(() => flows.archiveFlow(main.id, sub.id, master), /Ir para fluxo/);

  const channel = fakeChannel();
  const first = await incoming("5511900000107", "Oi");
  await flows.handleIncomingVisualFlow(first.event, first.message, channel);
  assert.deepEqual(channel.sent.map((item) => item.payload), ["Você está no Suporte."]);
  const execution = await prisma.botFlowExecution.findFirst({ where: { conversationId: first.message.conversationId } });
  assert.equal(execution.flowId, sub.id, "a execução passa a apontar para o subfluxo");
  assert.equal(execution.status, "COMPLETED");
  assert.equal((await prisma.conversation.findUnique({ where: { id: first.message.conversationId } })).status, "HANDOFF_BOT");
});

test("endpoints de Webhook: só HTTPS, cabeçalhos cifrados/ocultos e bloqueio de rede privada", async () => {
  await assert.rejects(() => webhooks.createEndpoint({ key: "fbtest_http", name: "x", url: "http://exemplo.com" }, master), /HTTPS/);
  const previousKey = process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.INTEGRATION_ENCRYPTION_KEY = previousKey || "a".repeat(64);
  try {
    const created = await webhooks.createEndpoint({ key: "fbtest_pedido", name: "Pedido", url: "https://api.exemplo.com/pedido", headers: [{ name: "Authorization", value: "Bearer segredo" }] }, master);
    assert.deepEqual(created.headerKeys, ["Authorization"]);
    assert.ok(!JSON.stringify(await webhooks.listEndpoints(master)).includes("segredo"));

    let request = null;
    const ok = await webhooks.callEndpoint("fbtest_pedido", { pedido: "123" }, {
      lookup: async () => [{ address: "93.184.216.34" }],
      httpClient: { request: async (config) => { request = config; return { status: 200, data: { status: "Enviado" } }; } },
    });
    assert.deepEqual(ok, { ok: true, status: 200, data: { status: "Enviado" }, errorCode: null });
    assert.equal(request.headers.Authorization, "Bearer segredo");
    assert.equal(request.maxRedirects, 0);

    const privateHost = await webhooks.callEndpoint("fbtest_pedido", {}, {
      lookup: async () => [{ address: "10.0.0.5" }],
      httpClient: { request: async () => { throw new Error("não deveria chamar"); } },
    });
    assert.equal(privateHost.errorCode, "WEBHOOK_PRIVATE_HOST");
  } finally {
    if (previousKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY; else process.env.INTEGRATION_ENCRYPTION_KEY = previousKey;
  }
  for (const address of ["127.0.0.1", "192.168.0.10", "172.20.1.1", "169.254.1.1", "::1", "fd00::1"]) assert.equal(webhooks.isPrivateAddress(address), true, address);
  assert.equal(webhooks.isPrivateAddress("8.8.8.8"), false);
});

test("conversão do Bot de Triagem em fluxo: preserva ativação, sequência e idempotência", async () => {
  const triage = await prisma.bot.findFirst({ where: { type: "SYSTEM_TRIAGE", archivedAt: null } });
  assert.ok(triage, "seed cria o Bot de Triagem");
  // Isola o teste: guarda e remove fluxos existentes do Bot de Triagem.
  const existing = await prisma.botFlow.findMany({ where: { botId: triage.id }, select: { id: true } });
  await prisma.botFlow.deleteMany({ where: { id: { in: existing.map((flow) => flow.id) } } });
  await prisma.bot.update({ where: { id: triage.id }, data: { autoReplyEnabled: true } });

  const result = await ensureTriageFlow({ log: {} });
  assert.equal(result.migrated, true);
  assert.equal(result.published, true, JSON.stringify(result.errors));
  const bot = await prisma.bot.findUnique({ where: { id: triage.id } });
  assert.equal(bot.autoReplyEnabled, true, "preserva a ativação que já existia");
  assert.equal(bot.executionMode, "FLOW_BUILDER");
  const flow = await prisma.botFlow.findFirst({ where: { botId: triage.id }, include: { activeVersion: true } });
  assert.equal(flow.isDefault, true);
  assert.equal(flow.status, "ACTIVE");
  const types = flow.activeVersion.graph.nodes.map((item) => item.type);
  assert.ok(types.includes("menu") && types.includes("condition") && types.includes("transfer_category"));
  const menu = flow.activeVersion.graph.nodes.find((item) => item.type === "menu");
  assert.equal(menu.config.display, "LIST");
  assert.equal(menu.config.text, "{{bot.initialMessage}}");
  assert.equal((await ensureTriageFlow({ log: {} })).reason, "ALREADY_MIGRATED_OR_NOT_PRESENT");

  // Simulação da triagem convertida: Atendimento -> "meu pedido não chegou" -> Pedidos.
  const first = await flows.simulateFlow(triage.id, flow.id, { message: "oi", source: "ACTIVE" }, master, { now: new Date("2026-10-05T14:00:00.000Z") });
  const atendimento = first.outputs.find((output) => output.options)?.options.find((option) => option.label === "Atendimento");
  assert.ok(atendimento, "a opção Atendimento do seed vira opção do menu");
  const asked = await flows.simulateFlow(triage.id, flow.id, { message: "Atendimento", replyId: atendimento.replyId, state: first.state, source: "ACTIVE" }, master, { now: new Date("2026-10-05T14:01:00Z") });
  assert.equal(asked.currentNodeKey, "atd_ask");
  const routed = await flows.simulateFlow(triage.id, flow.id, { message: "meu pedido não chegou", state: asked.state, source: "ACTIVE" }, master, { now: new Date("2026-10-05T14:02:00Z") });
  assert.equal(routed.status, "HANDED_OFF");
  assert.ok(routed.outputs.some((output) => output.type === "event" && /Pedidos/.test(output.text)));
});
