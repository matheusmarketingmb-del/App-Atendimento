// Flow Builder (Editor Visual de Bots): CRUD de fluxos, draft/publicação/
// versões/rollback, simulação (dry-run) e a execução real ligada ao webhook.
//
// Regras de segurança da execução real (handleIncomingVisualFlow):
//   - só roda para Bot com executionMode = FLOW_BUILDER, status ACTIVE,
//     autoReplyEnabled = true e automação global ligada (kill switch);
//   - nunca responde conversa assumida por humano, pausada ou finalizada
//     (mesma regra de triage-bot-service.js#botIsAllowedToRespond);
//   - resposta gerada por IA NUNCA é enviada: passa pelo send-mode atual
//     (DRY_RUN) — ver runFlowAiStep em bot-ai-shadow-service.js;
//   - Bots LEGACY (todos os existentes) não passam por aqui: o webhook segue
//     para a triagem atual como antes.

const prisma = require("../database/prisma");
const audit = require("./audit-service");
const { assertBotManager } = require("./bot-version-service");
const { getGlobalSettings } = require("./bot-governance-service");
const { getRecentContext } = require("./bot-conversation-state-service");
const { KnowledgeSourceProvider } = require("./bot-knowledge/knowledge-provider");
const { defaultGraph, nodeTypeCatalog, normalizeGraph, validateGraph } = require("./bot-visual-flow-graph");
const { FINISHED_STATUSES, STATUS, runTurn } = require("./bot-visual-flow-engine");

const FLOW_STATUSES = new Set(["DRAFT", "ACTIVE", "INACTIVE"]);
const MAX_SIM_STATE_BYTES = 100 * 1024;

function fail(message, statusCode = 400, extra = {}) {
  return Object.assign(new Error(message), { statusCode, ...extra });
}

function actorFields(actor, prefix) {
  return { [`${prefix}UserId`]: actor?.id || null, [`${prefix}Name`]: actor?.name || null };
}

async function ensureBot(botId, client = prisma) {
  const bot = await client.bot.findFirst({ where: { id: botId, archivedAt: null } });
  if (!bot) throw fail("Bot não encontrado.", 404);
  return bot;
}

async function ensureFlow(botId, flowId, client = prisma) {
  const flow = await client.botFlow.findFirst({
    where: { id: flowId, botId, archivedAt: null },
    include: { activeVersion: { select: { id: true, version: true, createdAt: true, publishedByName: true } } },
  });
  if (!flow) throw fail("Fluxo não encontrado.", 404);
  return flow;
}

function flowSummary(flow) {
  return {
    id: flow.id, botId: flow.botId, name: flow.name, description: flow.description, status: flow.status,
    isDefault: flow.isDefault, activeVersion: flow.activeVersion?.version || null,
    draftUpdatedAt: flow.draftUpdatedAt, updatedAt: flow.updatedAt, createdAt: flow.createdAt,
    createdByName: flow.createdByName, updatedByName: flow.updatedByName,
  };
}

function cleanName(value) {
  const name = String(value || "").trim().slice(0, 120);
  if (!name) throw fail("Informe o nome do fluxo.");
  return name;
}

// ---- leitura -------------------------------------------------------------

async function listFlows(botId, viewer) {
  assertBotManager(viewer);
  await ensureBot(botId);
  // Listagem = metadata; o grafo só vem ao abrir o editor (getFlow).
  const flows = await prisma.botFlow.findMany({
    where: { botId, archivedAt: null },
    select: {
      id: true, botId: true, name: true, description: true, status: true, isDefault: true,
      draftUpdatedAt: true, updatedAt: true, createdAt: true, createdByName: true, updatedByName: true,
      activeVersion: { select: { version: true } },
    },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  return flows.map(flowSummary);
}

async function getFlow(botId, flowId, viewer) {
  assertBotManager(viewer);
  const bot = await ensureBot(botId);
  const flow = await ensureFlow(botId, flowId);
  const versions = await prisma.botFlowVersion.findMany({
    where: { flowId }, orderBy: { version: "desc" }, take: 50,
    select: { id: true, version: true, label: true, publishedByName: true, createdAt: true },
  });
  return {
    ...flowSummary(flow), graph: flow.draftGraph,
    bot: { id: bot.id, name: bot.name, executionMode: bot.executionMode, status: bot.status, autoReplyEnabled: bot.autoReplyEnabled },
    versions,
  };
}

async function getFlowVersion(botId, flowId, version, viewer) {
  assertBotManager(viewer);
  await ensureFlow(botId, flowId);
  const row = await prisma.botFlowVersion.findUnique({ where: { flowId_version: { flowId, version: Number(version) } } });
  if (!row) throw fail("Versão não encontrada.", 404);
  return { version: row.version, label: row.label, graph: row.graph, publishedByName: row.publishedByName, createdAt: row.createdAt };
}

// Dados para os selects do painel de propriedades (setores/usuários do
// banco — nunca nomes fixos no código).
async function getEditorOptions(botId, viewer) {
  assertBotManager(viewer);
  await ensureBot(botId);
  const [categories, users, flows] = await Promise.all([
    prisma.category.findMany({ where: { active: true }, select: { id: true, name: true, parentId: true }, orderBy: [{ displayOrder: "asc" }, { name: "asc" }] }),
    prisma.user.findMany({ where: { active: true, role: { not: "BOT" } }, select: { id: true, name: true, role: true }, orderBy: { name: "asc" } }),
    prisma.botFlow.findMany({ where: { botId, archivedAt: null }, select: { id: true, name: true } }),
  ]);
  return {
    nodeTypes: nodeTypeCatalog(), categories, users, flows,
    aiProviders: [{ id: "LOCAL_QWEN", label: "IA local (Qwen + RAG)" }],
    variables: [
      "contact.name", "contact.firstName", "contact.phone", "contact.email",
      "conversation.id", "conversation.channel",
      "bot.intent", "bot.product", "bot.confidence", "bot.needsHuman", "bot.action", "bot.answer", "bot.reason",
      "flow.selectedOption", "flow.lastAnswer", "flow.lastMessage",
      "knowledge.result", "knowledge.sources", "knowledge.confidence",
      "customer.cnpj", "customer.orderNumber",
    ],
  };
}

// ---- escrita ---------------------------------------------------------------

async function createFlow(botId, { name, description } = {}, actor) {
  assertBotManager(actor);
  await ensureBot(botId);
  const existing = await prisma.botFlow.count({ where: { botId, archivedAt: null } });
  const flow = await prisma.botFlow.create({
    data: {
      botId, name: cleanName(name), description: description ? String(description).slice(0, 500) : null,
      draftGraph: defaultGraph(), isDefault: existing === 0,
      ...actorFields(actor, "createdBy"), ...actorFields(actor, "updatedBy"),
    },
    include: { activeVersion: { select: { version: true } } },
  });
  await audit.recordAudit({
    actor, action: "BOT_FLOW_CREATED", entityType: "BOT", entityId: botId,
    summary: `Fluxo visual "${flow.name}" criado`, details: { flowId: flow.id },
  });
  return getFlow(botId, flow.id, actor);
}

// Salvar = só o draft. Um fluxo ACTIVE continua executando a versão
// publicada (activeVersionId) — nunca é alterado silenciosamente.
async function saveDraft(botId, flowId, { name, description, graph, expectedDraftUpdatedAt } = {}, actor) {
  assertBotManager(actor);
  const flow = await ensureFlow(botId, flowId);
  if (expectedDraftUpdatedAt && new Date(expectedDraftUpdatedAt).getTime() !== flow.draftUpdatedAt.getTime()) {
    throw fail("Este fluxo foi alterado em outra aba/por outra pessoa. Recarregue antes de salvar.", 409);
  }
  const data = { ...actorFields(actor, "updatedBy") };
  if (name !== undefined) data.name = cleanName(name);
  if (description !== undefined) data.description = description ? String(description).slice(0, 500) : null;
  if (graph !== undefined) {
    data.draftGraph = normalizeGraph(graph);
    data.draftUpdatedAt = new Date();
  }
  await prisma.botFlow.update({ where: { id: flowId }, data });
  return getFlow(botId, flowId, actor);
}

async function loadValidationRefs(botId) {
  const [categories, users, flows] = await Promise.all([
    prisma.category.findMany({ where: { active: true }, select: { id: true } }),
    prisma.user.findMany({ where: { active: true, role: { not: "BOT" } }, select: { id: true } }),
    prisma.botFlow.findMany({ where: { botId, archivedAt: null }, select: { id: true } }),
  ]);
  return {
    categoryIds: new Set(categories.map((row) => row.id)),
    userIds: new Set(users.map((row) => row.id)),
    flowIds: new Set(flows.map((row) => row.id)),
  };
}

async function validateFlow(botId, flowId, { graph } = {}, viewer) {
  assertBotManager(viewer);
  const flow = await ensureFlow(botId, flowId);
  const { valid, errors } = validateGraph(graph ?? flow.draftGraph, await loadValidationRefs(botId));
  return { valid, errors };
}

async function publishFlow(botId, flowId, { label } = {}, actor) {
  assertBotManager(actor);
  const flow = await ensureFlow(botId, flowId);
  const { valid, errors, graph } = validateGraph(flow.draftGraph, await loadValidationRefs(botId));
  if (!valid) throw fail("O fluxo tem erros e não pode ser publicado.", 422, { details: { errors } });
  const published = await prisma.$transaction(async (transaction) => {
    const last = await transaction.botFlowVersion.findFirst({ where: { flowId }, orderBy: { version: "desc" }, select: { version: true } });
    const version = await transaction.botFlowVersion.create({
      data: {
        flowId, version: (last?.version || 0) + 1, graph, label: label ? String(label).slice(0, 120) : null,
        ...actorFields(actor, "publishedBy"),
      },
    });
    await transaction.botFlow.update({
      where: { id: flowId },
      data: { activeVersionId: version.id, status: "ACTIVE", ...actorFields(actor, "updatedBy") },
    });
    return version;
  });
  await audit.recordAudit({
    actor, action: "BOT_FLOW_PUBLISHED", entityType: "BOT", entityId: botId,
    summary: `Fluxo visual "${flow.name}" publicado (versão ${published.version})`,
    details: { flowId, version: published.version, previousVersion: flow.activeVersion?.version || null },
  });
  return getFlow(botId, flowId, actor);
}

async function setFlowStatus(botId, flowId, status, actor) {
  assertBotManager(actor);
  if (!FLOW_STATUSES.has(status) || status === "DRAFT") throw fail("Status inválido.");
  const flow = await ensureFlow(botId, flowId);
  if (status === "ACTIVE" && !flow.activeVersionId) throw fail("Publique o fluxo antes de ativá-lo.");
  await prisma.botFlow.update({ where: { id: flowId }, data: { status, ...actorFields(actor, "updatedBy") } });
  await audit.recordAudit({
    actor, action: "BOT_FLOW_STATUS_CHANGED", entityType: "BOT", entityId: botId,
    summary: `Fluxo visual "${flow.name}" ${status === "ACTIVE" ? "ativado" : "desativado"}`, details: { flowId, from: flow.status, to: status },
  });
  return getFlow(botId, flowId, actor);
}

// Rollback: reaponta a versão ativa para uma versão anterior (versões são
// imutáveis, nada é apagado). O draft não é tocado.
async function rollbackFlow(botId, flowId, version, actor) {
  assertBotManager(actor);
  const flow = await ensureFlow(botId, flowId);
  const target = await prisma.botFlowVersion.findUnique({ where: { flowId_version: { flowId, version: Number(version) } } });
  if (!target) throw fail("Versão não encontrada.", 404);
  await prisma.botFlow.update({ where: { id: flowId }, data: { activeVersionId: target.id, status: "ACTIVE", ...actorFields(actor, "updatedBy") } });
  await audit.recordAudit({
    actor, action: "BOT_FLOW_ROLLBACK", entityType: "BOT", entityId: botId,
    summary: `Fluxo visual "${flow.name}" voltou para a versão ${target.version}`,
    details: { flowId, from: flow.activeVersion?.version || null, to: target.version },
  });
  return getFlow(botId, flowId, actor);
}

// Copia uma versão publicada para o draft (para editar a partir dela).
async function restoreVersionToDraft(botId, flowId, version, actor) {
  assertBotManager(actor);
  await ensureFlow(botId, flowId);
  const target = await prisma.botFlowVersion.findUnique({ where: { flowId_version: { flowId, version: Number(version) } } });
  if (!target) throw fail("Versão não encontrada.", 404);
  await prisma.botFlow.update({ where: { id: flowId }, data: { draftGraph: target.graph, draftUpdatedAt: new Date(), ...actorFields(actor, "updatedBy") } });
  return getFlow(botId, flowId, actor);
}

async function setDefaultFlow(botId, flowId, actor) {
  assertBotManager(actor);
  await ensureFlow(botId, flowId);
  await prisma.$transaction([
    prisma.botFlow.updateMany({ where: { botId, isDefault: true }, data: { isDefault: false } }),
    prisma.botFlow.update({ where: { id: flowId }, data: { isDefault: true } }),
  ]);
  return getFlow(botId, flowId, actor);
}

async function archiveFlow(botId, flowId, actor) {
  assertBotManager(actor);
  const flow = await ensureFlow(botId, flowId);
  const bot = await ensureBot(botId);
  if (flow.isDefault && bot.executionMode === "FLOW_BUILDER") {
    throw fail("Este é o fluxo padrão de um Bot em modo Editor Visual. Volte o Bot para o modo atual antes de arquivar.");
  }
  // Arquivar nunca apaga versões/execuções/logs (histórico e auditoria).
  await prisma.botFlow.update({ where: { id: flowId }, data: { archivedAt: new Date(), isDefault: false, status: "INACTIVE" } });
  await audit.recordAudit({
    actor, action: "BOT_FLOW_ARCHIVED", entityType: "BOT", entityId: botId,
    summary: `Fluxo visual "${flow.name}" arquivado`, details: { flowId },
  });
  return { archived: true };
}

async function setExecutionMode(botId, mode, actor) {
  assertBotManager(actor);
  if (!["LEGACY", "FLOW_BUILDER"].includes(mode)) throw fail("Modo de execução inválido.");
  const bot = await ensureBot(botId);
  if (bot.type === "SYSTEM_TRIAGE" && mode === "FLOW_BUILDER") {
    throw fail("O Bot de Triagem do sistema continua no modo atual nesta versão do Editor Visual.");
  }
  if (mode === "FLOW_BUILDER") {
    const flow = await prisma.botFlow.findFirst({ where: { botId, archivedAt: null, isDefault: true, status: "ACTIVE", activeVersionId: { not: null } } });
    if (!flow) throw fail("Publique e ative o fluxo padrão antes de usar o Editor Visual como modo de execução.");
  }
  await prisma.bot.update({ where: { id: botId }, data: { executionMode: mode } });
  await audit.recordAudit({
    actor, action: "BOT_EXECUTION_MODE_CHANGED", entityType: "BOT", entityId: botId,
    summary: `Bot "${bot.name}" agora usa ${mode === "FLOW_BUILDER" ? "o Editor Visual" : "o motor atual"}`,
    details: { from: bot.executionMode, to: mode },
  });
  return { id: botId, executionMode: mode };
}

async function listExecutions(botId, flowId, viewer) {
  assertBotManager(viewer);
  await ensureFlow(botId, flowId);
  return prisma.botFlowExecution.findMany({
    where: { flowId }, orderBy: { startedAt: "desc" }, take: 50,
    select: {
      id: true, conversationId: true, status: true, currentNodeKey: true, error: true, startedAt: true, updatedAt: true, finishedAt: true,
      version: { select: { version: true } },
    },
  });
}

async function getExecutionLogs(botId, flowId, executionId, viewer) {
  assertBotManager(viewer);
  await ensureFlow(botId, flowId);
  const execution = await prisma.botFlowExecution.findFirst({ where: { id: executionId, flowId } });
  if (!execution) throw fail("Execução não encontrada.", 404);
  const logs = await prisma.botFlowExecutionLog.findMany({ where: { executionId }, orderBy: { createdAt: "asc" }, take: 500 });
  return { execution: { id: execution.id, status: execution.status, currentNodeKey: execution.currentNodeKey, error: execution.error }, logs };
}

// ---- simulação (dry-run) --------------------------------------------------

function contactSeed(contact) {
  const name = contact?.customName || contact?.name || "";
  return { name, firstName: name.split(/\s+/)[0] || "", phone: contact?.phone || "", email: contact?.email || "" };
}

// Nunca envia nada, nunca altera Conversation/Message, nunca chama Tool
// externa. IA e Knowledge são leitura (RAG/KnowledgeSource) — iguais ao
// simulador atual do Bot.
function simulationAdapter({ bot, categories, outputs, aiStep, knowledgeProvider }) {
  const categoryName = (id) => categories.find((category) => category.id === id)?.name || null;
  return {
    skipDelays: true,
    async send(text) { if (String(text || "").trim()) outputs.push({ type: "bot", text }); },
    async sendAiAnswer(result) {
      outputs.push({ type: "ai", text: result.answer, wouldSend: Boolean(result.sendDecision?.shouldSend), sendMode: result.sendDecision?.sendMode || "DRY_RUN", blockedReason: result.sendDecision?.reason || null });
      return { simulated: true, ...result.sendDecision };
    },
    async ai({ message, model }) {
      return aiStep({ bot, message, history: [], model });
    },
    async searchKnowledge({ query, product, limit }) {
      const rows = await knowledgeProvider.search(query, { botId: bot.id, product, limit });
      return { results: rows.map((row) => ({ title: row.title, excerpt: String(row.content || "").slice(0, 600), score: row.score })) };
    },
    async transferToCategory({ categoryId, message, reason }) {
      if (!categoryName(categoryId)) throw new Error("Setor de destino não existe ou está inativo.");
      if (message?.trim()) outputs.push({ type: "bot", text: message });
      outputs.push({ type: "event", text: `Transferiria para o setor ${categoryName(categoryId)}`, reason });
      return { categoryId, categoryName: categoryName(categoryId) };
    },
    async handoff({ reason, message, categoryId }) {
      if (message?.trim()) outputs.push({ type: "bot", text: message });
      outputs.push({ type: "event", text: `Entregaria para atendimento humano${categoryId ? ` (${categoryName(categoryId) || "setor"})` : ""}`, reason });
      return { categoryId: categoryId || null };
    },
    async finish({ finalizeConversation }) {
      outputs.push({ type: "event", text: finalizeConversation ? "Finalizaria a conversa" : "Encerraria o Bot e deixaria a conversa para a equipe" });
    },
  };
}

async function simulateFlow(botId, flowId, { message, state = null, source = "DRAFT", graph: graphOverride } = {}, viewer, deps = {}) {
  assertBotManager(viewer);
  const bot = await ensureBot(botId);
  const flow = await ensureFlow(botId, flowId);
  if (state && JSON.stringify(state).length > MAX_SIM_STATE_BYTES) throw fail("Estado de simulação grande demais.");
  let graph = graphOverride ?? flow.draftGraph;
  if (source === "ACTIVE") {
    if (!flow.activeVersionId) throw fail("Este fluxo ainda não tem versão publicada.");
    graph = (await prisma.botFlowVersion.findUnique({ where: { id: flow.activeVersionId } })).graph;
  }
  const categories = await prisma.category.findMany({ where: { active: true }, select: { id: true, name: true } });
  const outputs = [];
  const adapter = simulationAdapter({
    bot, categories, outputs,
    aiStep: deps.aiStep || require("./bot-ai-shadow-service").runFlowAiStep,
    knowledgeProvider: deps.knowledgeProvider || new KnowledgeSourceProvider(prisma),
  });
  const input = state ? { type: "MESSAGE", text: String(message || "").slice(0, 2000) } : { type: "START", text: String(message || "").slice(0, 2000) };
  const seed = { contact: { name: "Cliente Teste", firstName: "Cliente", phone: "5500000000000", email: "" }, conversation: { id: "simulacao", channel: bot.channel } };
  const result = await runTurn({ graph, state, input, adapter, seed, flowName: flow.name });
  return {
    state: result.state, trace: result.trace, outputs, ignored: Boolean(result.ignored),
    visited: result.state.context?._engine?.visited || [],
    currentNodeKey: result.state.currentNodeKey, status: result.state.status,
    dryRun: true,
  };
}

// ---- execução real ---------------------------------------------------------

function botIsAllowedToRespond(conversation) {
  if (conversation.status === "FINALIZADO") return false;
  if (conversation.assignedUserId) return false;
  if (conversation.botState?.humanPausedAt) return false;
  return true;
}

function botEligible(bot, globalSettings) {
  return Boolean(bot && !bot.archivedAt && bot.executionMode === "FLOW_BUILDER" && bot.status === "ACTIVE"
    && bot.autoReplyEnabled && globalSettings.automationEnabled);
}

function liveAdapter({ conversation, bot, channel, execution, aiStep }) {
  const conversationId = conversation.id;
  const saveSent = async (text, result, system, nodeInfo = {}) => {
    const occurredAt = new Date();
    await prisma.$transaction([
      prisma.message.create({ data: {
        conversationId, externalId: conversation.channelAccountId && result?.externalId ? `${conversation.channelAccountId}:${result.externalId}` : (result?.externalId || null), channel: conversation.channel, channelAccountId: conversation.channelAccountId || null,
        direction: "ENVIADA", status: "ENVIADA", type: "text", text, occurredAt,
        rawPayload: { message: result?.data || null, system, flowId: execution.flowId, executionId: execution.id, ...nodeInfo },
      } }),
      prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: occurredAt } }),
    ]);
  };
  const send = async (text) => {
    if (!String(text || "").trim()) return;
    if (conversation.channel === "META") channel = await require("./whatsapp-inbox-service").botChannel(conversation, channel);
    const result = await channel.sendText(conversation.contact.phone, text);
    await saveSent(text, result, "visual_flow");
  };
  const activity = (action, details) => prisma.conversationActivity.create({ data: { conversationId, action, details } });
  const contactLabel = conversation.contact.customName || conversation.contact.name || conversation.contact.phone;

  const moveToCategory = async ({ categoryId, reason, action }) => {
    const category = await prisma.category.findFirst({ where: { id: categoryId, active: true } });
    if (!category) throw new Error("Setor de destino não existe ou está inativo.");
    // Só sai do Bot se ainda estiver com o Bot e sem responsável (nunca
    // tira uma conversa que um humano assumiu no meio do fluxo).
    const moved = await prisma.conversation.updateMany({
      where: { id: conversationId, status: "BOT", assignedUserId: null },
      data: { categoryId: category.id, status: "NOVO", assignedUserId: null, finalizedAt: null },
    });
    if (!moved.count) return { categoryId: category.id, categoryName: category.name, skipped: true };
    await activity(action, { categoryId: category.id, categoryName: category.name, reason, flowId: execution.flowId, executionId: execution.id });
    await audit.recordAudit({
      actor: null, action: "CONVERSATION_CATEGORY_CHANGED", entityType: "CONVERSATION", entityId: conversationId,
      summary: `Fluxo do Bot "${bot.name}" encaminhou a conversa de ${contactLabel} para ${category.name}`,
      details: {
        conversationId, contactPhone: conversation.contact.phone, from: conversation.category?.name || "Sem categoria", to: category.name,
        fromCategoryId: conversation.categoryId || null, toCategoryId: category.id, reason, flowId: execution.flowId,
      },
    });
    return { categoryId: category.id, categoryName: category.name };
  };

  return {
    skipDelays: false,
    send,
    // Resposta de IA: nunca enviada — o send-mode atual (DRY_RUN) é a
    // única saída; registra o que teria sido enviado.
    async sendAiAnswer(result) {
      return { simulated: true, ...result.sendDecision };
    },
    async ai({ message, model }) {
      const rows = await getRecentContext(conversationId, { limit: 10 }, prisma);
      const history = rows.filter((row) => row.text).map((row) => ({ role: row.direction === "RECEBIDA" ? "customer" : "assistant", content: row.text }));
      return aiStep({ bot, message, history, model });
    },
    async searchKnowledge({ query, product, limit }) {
      const rows = await new KnowledgeSourceProvider(prisma).search(query, { botId: bot.id, product, limit });
      return { results: rows.map((row) => ({ title: row.title, excerpt: String(row.content || "").slice(0, 600), score: row.score })) };
    },
    async transferToCategory({ categoryId, message, reason }) {
      await send(message);
      return moveToCategory({ categoryId, reason, action: "BOT_FLOW_TRANSFERRED" });
    },
    async handoff({ reason, message, categoryId }) {
      await send(message);
      if (categoryId) return moveToCategory({ categoryId, reason, action: "BOT_FLOW_HANDOFF" });
      // Sem setor: HANDOFF_BOT (visível para a equipe e fora do alcance da
      // triagem automática, que só age em NOVO sem categoria).
      await prisma.conversation.updateMany({ where: { id: conversationId, status: "BOT", assignedUserId: null }, data: { status: "HANDOFF_BOT" } });
      await activity("BOT_FLOW_HANDOFF", { reason, flowId: execution.flowId, executionId: execution.id });
      return { categoryId: null };
    },
    async finish({ finalizeConversation }) {
      if (finalizeConversation) {
        await prisma.conversation.updateMany({
          where: { id: conversationId, status: "BOT", assignedUserId: null },
          data: { status: "FINALIZADO", finalizedAt: new Date(), unreadCount: 0 },
        });
      } else {
        await prisma.conversation.updateMany({ where: { id: conversationId, status: "BOT", assignedUserId: null }, data: { status: "HANDOFF_BOT" } });
      }
      await activity("BOT_FLOW_COMPLETED", { finalizeConversation, flowId: execution.flowId, executionId: execution.id });
    },
  };
}

async function persistTurn(execution, claimedStep, turn, version) {
  const { state, trace } = turn;
  const finished = FINISHED_STATUSES.has(state.status);
  const updated = await prisma.botFlowExecution.updateMany({
    where: { id: execution.id, step: claimedStep },
    data: {
      status: state.status, currentNodeKey: state.currentNodeKey, context: state.context,
      resumeAt: state.status === STATUS.WAITING_TIMER && state.resumeAt ? new Date(state.resumeAt) : null,
      error: state.error || null, step: claimedStep + 1, finishedAt: finished ? new Date() : null,
    },
  });
  if (trace.length) {
    await prisma.botFlowExecutionLog.createMany({
      data: trace.map((entry) => ({
        executionId: execution.id, flowId: execution.flowId, version: version.version,
        nodeKey: entry.nodeKey, nodeType: entry.nodeType, input: entry.input ?? undefined, output: entry.output ?? undefined,
        branch: entry.branch, result: entry.result, error: entry.error, durationMs: entry.durationMs,
      })),
    });
  }
  return updated.count > 0;
}

function toEngineState(execution) {
  return {
    currentNodeKey: execution.currentNodeKey, status: execution.status, context: execution.context || {},
    resumeAt: execution.resumeAt ? execution.resumeAt.toISOString() : null, error: execution.error || null,
  };
}

// Encerra uma execução em espera que não pode mais continuar (humano
// assumiu, Bot desligado, conversa finalizada). Nunca apaga nada.
async function cancelExecution(execution, reason) {
  await prisma.botFlowExecution.updateMany({
    where: { id: execution.id, step: execution.step },
    data: { status: STATUS.HANDED_OFF, error: reason, finishedAt: new Date(), resumeAt: null, step: execution.step + 1 },
  });
}

const conversationInclude = {
  contact: true,
  category: { select: { id: true, name: true } },
  botState: { select: { humanPausedAt: true } },
};

async function findStartBot(conversation) {
  const bots = await prisma.bot.findMany({
    where: {
      archivedAt: null, executionMode: "FLOW_BUILDER", status: "ACTIVE", autoReplyEnabled: true,
      OR: [{ channel: conversation.channel }, { channels: { has: conversation.channel } }],
    },
    orderBy: { updatedAt: "desc" },
  });
  for (const bot of bots) {
    const flow = await prisma.botFlow.findFirst({
      where: { botId: bot.id, archivedAt: null, isDefault: true, status: "ACTIVE", activeVersionId: { not: null } },
      include: { activeVersion: true },
    });
    if (flow?.activeVersion) return { bot, flow, version: flow.activeVersion };
  }
  return null;
}

// Já houve uma execução nesta "sessão" da conversa (desde a última
// reabertura)? Evita reiniciar o fluxo a cada mensagem depois de um
// handoff/fim — só uma nova sessão (conversa reaberta) começa de novo.
async function hadExecutionThisSession(conversationId) {
  const reopened = await prisma.conversationActivity.findFirst({
    where: { conversationId, action: "REOPENED_BY_CUSTOMER_MESSAGE" }, orderBy: { createdAt: "desc" }, select: { createdAt: true },
  });
  const count = await prisma.botFlowExecution.count({
    where: { conversationId, ...(reopened ? { startedAt: { gte: reopened.createdAt } } : {}) },
  });
  return count > 0;
}

async function runLiveTurn({ execution, claimedStep, conversation, bot, channel, version, flowName, input, aiStep, now }) {
  const adapter = liveAdapter({ conversation, bot, channel, execution, aiStep });
  const seed = { contact: contactSeed(conversation.contact), conversation: { id: conversation.id, channel: conversation.channel } };
  const state = execution.currentNodeKey || execution.status !== STATUS.RUNNING ? toEngineState(execution) : null;
  let turn;
  try {
    turn = await runTurn({ graph: version.graph, state, input, adapter, seed, flowName, now });
  } catch (error) {
    // Nunca derruba o processamento geral: registra e entrega para humano.
    turn = {
      state: { ...(state || { context: {} }), status: STATUS.FAILED, error: error.message?.slice(0, 500) || "Falha no fluxo" },
      trace: [{ nodeKey: execution.currentNodeKey || "?", nodeType: "engine", result: "ERROR", error: error.message?.slice(0, 500), durationMs: 0 }],
    };
    await prisma.conversation.updateMany({ where: { id: conversation.id, status: "BOT", assignedUserId: null }, data: { status: "HANDOFF_BOT" } }).catch(() => {});
  }
  await persistTurn(execution, claimedStep, turn, version);
  return turn;
}

// Hook do webhook. Devolve true quando o Flow Builder é dono desta mensagem
// (a triagem legada NÃO deve rodar); false para seguir o caminho atual.
async function handleIncomingVisualFlow(event, message, channel, { now = new Date(), aiStep } = {}) {
  if (event.type === "reaction") return false;
  const conversation = await prisma.conversation.findUnique({ where: { id: message.conversationId }, include: conversationInclude });
  if (!conversation) return false;
  // Só consulta o kill switch global quando o Flow Builder realmente for
  // decidir algo (evita uma escrita/consulta extra em toda mensagem legada).
  let globalSettings = null;
  const eligible = async (bot) => {
    globalSettings ||= await getGlobalSettings(prisma);
    return botEligible(bot, globalSettings);
  };
  const runAi = aiStep || require("./bot-ai-shadow-service").runFlowAiStep;
  const text = event.type === "text" ? String(event.text || "") : (event.interactiveTitle || event.text || "");

  const active = await prisma.botFlowExecution.findFirst({
    where: { conversationId: conversation.id, status: { in: [STATUS.WAITING_CUSTOMER, STATUS.WAITING_TIMER, STATUS.RUNNING] } },
    orderBy: { startedAt: "desc" },
    include: { version: true, flow: { select: { name: true } } },
  });

  if (active) {
    if (active.lastMessageId === message.id) return true; // reentrega do mesmo evento
    const bot = await prisma.bot.findUnique({ where: { id: active.botId } });
    if (!botIsAllowedToRespond(conversation)) { await cancelExecution(active, "HUMAN_TOOK_OVER_OR_FINALIZED"); return false; }
    if (!(await eligible(bot))) { await cancelExecution(active, "BOT_DISABLED"); return false; }
    if (active.status !== STATUS.WAITING_CUSTOMER) return true; // RUNNING/WAITING_TIMER: mensagem salva, fluxo não avança duas vezes
    // Claim otimista: só uma mensagem avança o fluxo a partir deste passo.
    const claimed = await prisma.botFlowExecution.updateMany({
      where: { id: active.id, step: active.step, status: STATUS.WAITING_CUSTOMER },
      data: { step: active.step + 1, lastMessageId: message.id },
    });
    if (!claimed.count) return true;
    await runLiveTurn({
      execution: active, claimedStep: active.step + 1, conversation, bot, channel, version: active.version,
      flowName: active.flow.name, input: { type: "MESSAGE", text }, aiStep: runAi, now,
    });
    return true;
  }

  // Reentrega de uma mensagem que já foi consumida por uma execução (mesmo
  // que ela já tenha terminado): continua sendo do Flow Builder.
  const consumed = await prisma.botFlowExecution.findFirst({ where: { conversationId: conversation.id, lastMessageId: message.id }, select: { id: true } });
  if (consumed) return true;

  // Início: mesma pré-condição da triagem (conversa nova, sem categoria,
  // sem responsável) — nunca "rouba" uma conversa já em atendimento.
  if (!botIsAllowedToRespond(conversation) || conversation.categoryId || conversation.status !== "NOVO") return false;
  const target = await findStartBot(conversation);
  if (!target || !(await eligible(target.bot))) return false;
  const startNode = (target.version.graph?.nodes || []).find((node) => node.type === "start");
  const allowedChannels = startNode?.config?.channels || [];
  if (allowedChannels.length && !allowedChannels.includes(conversation.channel)) return false;
  if (startNode?.config?.trigger !== "ANY_MESSAGE" && await hadExecutionThisSession(conversation.id)) return false;

  const claimedConversation = await prisma.conversation.updateMany({
    where: { id: conversation.id, categoryId: null, assignedUserId: null, status: conversation.status, updatedAt: conversation.updatedAt },
    data: { status: "BOT" },
  });
  if (!claimedConversation.count) return false;
  const execution = await prisma.botFlowExecution.create({
    data: {
      conversationId: conversation.id, botId: target.bot.id, flowId: target.flow.id, versionId: target.version.id,
      status: STATUS.RUNNING, lastMessageId: message.id, step: 0,
    },
  });
  await prisma.conversationActivity.create({ data: {
    conversationId: conversation.id, action: "BOT_FLOW_STARTED",
    details: { botId: target.bot.id, flowId: target.flow.id, version: target.version.version, executionId: execution.id },
  } });
  await runLiveTurn({
    execution, claimedStep: 0, conversation: { ...conversation, status: "BOT" }, bot: target.bot, channel, version: target.version,
    flowName: target.flow.name, input: { type: "START", text }, aiStep: runAi, now,
  });
  return true;
}

// Worker do nó Intervalo: nunca "dorme" dentro de um request — a execução
// fica WAITING_TIMER com resumeAt e este tick retoma quando vencer.
async function processDueTimers({ channel, now = new Date(), limit = 20, aiStep } = {}) {
  const due = await prisma.botFlowExecution.findMany({
    where: { status: STATUS.WAITING_TIMER, resumeAt: { lte: now } },
    orderBy: { resumeAt: "asc" }, take: limit,
    include: { version: true, flow: { select: { name: true } }, conversation: { include: conversationInclude } },
  });
  if (!due.length) return 0;
  const globalSettings = await getGlobalSettings(prisma);
  let processed = 0;
  for (const execution of due) {
    try {
      const bot = await prisma.bot.findUnique({ where: { id: execution.botId } });
      if (!botIsAllowedToRespond(execution.conversation)) { await cancelExecution(execution, "HUMAN_TOOK_OVER_OR_FINALIZED"); continue; }
      if (!botEligible(bot, globalSettings)) { await cancelExecution(execution, "BOT_DISABLED"); continue; }
      const claimed = await prisma.botFlowExecution.updateMany({
        where: { id: execution.id, step: execution.step, status: STATUS.WAITING_TIMER },
        data: { step: execution.step + 1 },
      });
      if (!claimed.count) continue;
      await runLiveTurn({
        execution, claimedStep: execution.step + 1, conversation: execution.conversation, bot, channel, version: execution.version,
        flowName: execution.flow.name, input: { type: "TIMER" }, aiStep: aiStep || require("./bot-ai-shadow-service").runFlowAiStep, now,
      });
      processed += 1;
    } catch (error) {
      console.error("[BOT_FLOW] falha ao retomar timer (ignorada, próximo tick tenta de novo):", execution.id, error.message);
    }
  }
  return processed;
}

function startVisualFlowWorker({ channel, onChange, intervalMs = 5000 } = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const processed = await processDueTimers({ channel });
      if (processed && onChange) onChange();
    } catch (error) {
      console.error("[BOT_FLOW] worker de timers falhou:", error.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = {
  archiveFlow, createFlow, getEditorOptions, getExecutionLogs, getFlow, getFlowVersion, handleIncomingVisualFlow,
  listExecutions, listFlows, processDueTimers, publishFlow, restoreVersionToDraft, rollbackFlow, saveDraft,
  setDefaultFlow, setExecutionMode, setFlowStatus, simulateFlow, startVisualFlowWorker, validateFlow,
};
