// Flow Builder (Editor Visual de Bots) — ÚNICO modelo de Bot: CRUD de
// fluxos, draft/publicação/versões/rollback, upload de mídia dos nós,
// simulação (dry-run) e a execução real ligada ao webhook do WhatsApp.
//
// Regras de segurança da execução real (handleIncomingVisualFlow):
//   - só roda para Bot com status ACTIVE, autoReplyEnabled = true e
//     automação global ligada (kill switch). Bots ARCHIVED_LEGACY nunca rodam;
//   - nunca responde conversa assumida por humano, pausada ("Cancelar Bot")
//     ou finalizada;
//   - nenhum nó usa IA: o fluxo é 100% determinístico.

const fs = require("node:fs/promises");
const prisma = require("../database/prisma");
const audit = require("./audit-service");
const authorization = require("./authorization-service");
const media = require("./media-storage-service");
const { assertBotManager, getGlobalSettings } = require("./bot-governance-service");
const { activeResponseMap } = require("./bot-response-library-service");
const webhookEndpoints = require("./bot-webhook-endpoint-service");
const { describeSchedule, scheduleState } = require("./bot-schedule-utils");
const {
  FLOW_VARIABLES, MEDIA_KINDS, STORAGE_KEY_PATTERN, SYSTEM_VARIABLES, defaultGraph, nodeTypeCatalog, normalizeGraph, validateGraph,
} = require("./bot-visual-flow-graph");
const { FINISHED_STATUSES, STATUS, runTurn } = require("./bot-visual-flow-engine");

const FLOW_STATUSES = new Set(["DRAFT", "ACTIVE", "INACTIVE"]);
const MAX_SIM_STATE_BYTES = 100 * 1024;
const WHATSAPP_LIST_MAX_ROWS = 10;
const MEDIA_STORE = { IMAGE: media.storeImage, AUDIO: media.storeAudio, VIDEO: media.storeVideo, DOCUMENT: media.storeDocument };
const MEDIA_MESSAGE_TYPE = { IMAGE: "image", AUDIO: "audio", VIDEO: "video", DOCUMENT: "document" };
const CHANNEL_MEDIA_SENDER = { IMAGE: "sendImage", AUDIO: "sendAudio", VIDEO: "sendVideo", DOCUMENT: "sendDocument" };

function fail(message, statusCode = 400, extra = {}) {
  return Object.assign(new Error(message), { statusCode, ...extra });
}

function actorFields(actor, prefix) {
  return { [`${prefix}UserId`]: actor?.id || null, [`${prefix}Name`]: actor?.name || null };
}

const botScheduleInclude = { schedules: true, holidays: true };

async function ensureBot(botId, client = prisma) {
  const bot = await client.bot.findFirst({
    where: { id: botId, archivedAt: null, status: { not: "ARCHIVED_LEGACY" } }, include: botScheduleInclude,
  });
  if (!bot) throw fail("Bot não encontrado.", 404);
  return bot;
}

async function ensureFlow(botId, flowId, client = prisma) {
  const flow = await client.botFlow.findFirst({
    where: { id: flowId, botId, archivedAt: null },
    include: { activeVersion: { select: { id: true, version: true, createdAt: true, publishedByName: true, graph: true } } },
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
    ...flowSummary(flow), graph: normalizeGraph(flow.draftGraph),
    bot: { id: bot.id, name: bot.name, status: bot.status, autoReplyEnabled: bot.autoReplyEnabled, type: bot.type },
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

// Dados para os selects do painel de propriedades (setores/usuários/fluxos/
// respostas/endpoints do banco — nunca nomes fixos no código).
async function getEditorOptions(botId, viewer) {
  assertBotManager(viewer);
  const bot = await ensureBot(botId);
  const [categories, users, flows, responses, webhooks] = await Promise.all([
    prisma.category.findMany({ where: { active: true }, select: { id: true, name: true, parentId: true }, orderBy: [{ displayOrder: "asc" }, { name: "asc" }] }),
    prisma.user.findMany({ where: { active: true, role: { not: "BOT" } }, select: { id: true, name: true, role: true }, orderBy: { name: "asc" } }),
    prisma.botFlow.findMany({ where: { botId, archivedAt: null }, select: { id: true, name: true, status: true, isDefault: true, activeVersionId: true }, orderBy: { createdAt: "asc" } }),
    prisma.botResponse.findMany({ where: { active: true }, select: { key: true, title: true, category: true, text: true }, orderBy: [{ category: "asc" }, { key: "asc" }] }),
    prisma.botWebhookEndpoint.findMany({ where: { active: true }, select: { key: true, name: true, method: true }, orderBy: { key: "asc" } }),
  ]);
  return {
    bot: { id: bot.id, name: bot.name, channels: bot.channels?.length ? bot.channels : [bot.channel] },
    nodeTypes: nodeTypeCatalog(), categories, users, responses, webhooks,
    flows: flows.map((flow) => ({ id: flow.id, name: flow.name, status: flow.status, isDefault: flow.isDefault, published: Boolean(flow.activeVersionId) })),
    mediaKinds: MEDIA_KINDS,
    variables: [...SYSTEM_VARIABLES, ...FLOW_VARIABLES, "customer.orderNumber", "customer.cnpj", "customer.cpf", "customer.email", "custom.campo"],
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
  });
  await audit.recordAudit({
    actor, action: "BOT_FLOW_CREATED", entityType: "BOT", entityId: botId,
    summary: `Fluxo visual "${flow.name}" criado`, details: { flowId: flow.id },
  });
  return getFlow(botId, flow.id, actor);
}

// Salvar = só o draft. Um fluxo ACTIVE continua executando a versão
// publicada (activeVersionId) — editar nunca altera o que está no ar.
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

async function existingMediaKeys(graph) {
  const keys = [...new Set((graph.nodes || []).filter((node) => node.type === "media" && node.config?.storageKey).map((node) => node.config.storageKey))];
  const found = new Set();
  for (const key of keys) {
    try { await fs.access(media.resolveMedia(key)); found.add(key); } catch (_error) { /* inexistente */ }
  }
  return found;
}

async function loadValidationRefs(botId, flowId, graph) {
  const [categories, users, flows, responses, webhooks, mediaKeys] = await Promise.all([
    prisma.category.findMany({ where: { active: true }, select: { id: true } }),
    prisma.user.findMany({ where: { active: true, role: { not: "BOT" } }, select: { id: true } }),
    prisma.botFlow.findMany({ where: { botId, archivedAt: null }, select: { id: true } }),
    prisma.botResponse.findMany({ where: { active: true }, select: { key: true } }),
    prisma.botWebhookEndpoint.findMany({ where: { active: true }, select: { key: true } }),
    existingMediaKeys(normalizeGraph(graph)),
  ]);
  return {
    currentFlowId: flowId,
    categoryIds: new Set(categories.map((row) => row.id)),
    userIds: new Set(users.map((row) => row.id)),
    flowIds: new Set(flows.map((row) => row.id)),
    responseKeys: new Set(responses.map((row) => row.key)),
    webhookKeys: new Set(webhooks.map((row) => row.key)),
    mediaKeys,
  };
}

async function validateFlow(botId, flowId, { graph } = {}, viewer) {
  assertBotManager(viewer);
  const flow = await ensureFlow(botId, flowId);
  const target = graph ?? flow.draftGraph;
  const { valid, errors, warnings } = validateGraph(target, await loadValidationRefs(botId, flowId, target));
  return { valid, errors, warnings };
}

async function publishFlow(botId, flowId, { label } = {}, actor) {
  assertBotManager(actor);
  const flow = await ensureFlow(botId, flowId);
  const { valid, errors, warnings, graph } = validateGraph(flow.draftGraph, await loadValidationRefs(botId, flowId, flow.draftGraph));
  if (!valid) throw fail("O fluxo tem erros e não pode ser publicado.", 422, { details: { errors, warnings } });
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
  if (flow.isDefault) throw fail("Este é o fluxo padrão do Bot. Defina outro fluxo como padrão antes de arquivar.");
  const needle = `"flowId":"${flowId}"`;
  const others = await prisma.botFlow.findMany({
    where: { botId, archivedAt: null, id: { not: flowId } },
    select: { name: true, draftGraph: true, activeVersion: { select: { graph: true } } },
  });
  const callers = others.filter((other) => JSON.stringify(other.draftGraph).includes(needle) || JSON.stringify(other.activeVersion?.graph || {}).includes(needle));
  if (callers.length) throw fail(`Outros fluxos vão para este (Ir para fluxo): ${callers.map((item) => item.name).join(", ")}. Ajuste-os antes de arquivar.`);
  // Arquivar nunca apaga versões/execuções/logs (histórico e auditoria).
  await prisma.botFlow.update({ where: { id: flowId }, data: { archivedAt: new Date(), isDefault: false, status: "INACTIVE" } });
  await audit.recordAudit({
    actor, action: "BOT_FLOW_ARCHIVED", entityType: "BOT", entityId: botId,
    summary: `Fluxo visual "${flow.name}" arquivado`, details: { flowId },
  });
  return { archived: true };
}

async function uploadFlowMedia(botId, { kind, buffer, mimeType, fileName }, actor) {
  assertBotManager(actor);
  await ensureBot(botId);
  const store = MEDIA_STORE[kind];
  if (!store) throw fail("Tipo de mídia inválido (use IMAGE, AUDIO, VIDEO ou DOCUMENT).");
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw fail("Envie um arquivo.");
  const stored = await store({ buffer, mimeType, fileName });
  return { kind, storageKey: stored.storageKey, mimeType: stored.mimeType, fileName: stored.fileName, size: stored.size };
}

async function getFlowMediaPath(botId, storageKey, viewer) {
  assertBotManager(viewer);
  await ensureBot(botId);
  if (!STORAGE_KEY_PATTERN.test(String(storageKey || ""))) throw fail("Mídia inválida.", 404);
  return media.resolveMedia(storageKey);
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
  const execution = await prisma.botFlowExecution.findFirst({ where: { id: executionId, botId } });
  if (!execution) throw fail("Execução não encontrada.", 404);
  const logs = await prisma.botFlowExecutionLog.findMany({ where: { executionId }, orderBy: { createdAt: "asc" }, take: 500 });
  return { execution: { id: execution.id, status: execution.status, currentNodeKey: execution.currentNodeKey, error: execution.error }, logs };
}

// ---- contexto inicial (variáveis de sistema) ------------------------------

function contactSeed(contact) {
  const name = contact?.customName || contact?.name || "";
  const realName = name && name !== contact?.phone ? name : "";
  const firstName = realName.split(/\s+/)[0] || "";
  return {
    name: realName, firstName, phone: contact?.phone || "", email: contact?.email || "",
    greeting: firstName ? `Olá, ${firstName}` : "Olá", greetingComma: firstName ? `, ${firstName}` : "",
  };
}

function botSeed(bot, now) {
  const withinBusinessHours = scheduleState(bot, now).withinHours;
  return { name: bot.name, businessHours: describeSchedule(bot), withinBusinessHours };
}

function buildSeed({ bot, contact, conversation, now }) {
  const botVars = botSeed(bot, now);
  return {
    contact: contactSeed(contact), bot: botVars,
    conversation: { id: conversation.id, channel: conversation.channel, withinBusinessHours: botVars.withinBusinessHours },
  };
}

// Variáveis de sistema são recalculadas a cada turno (ex.: horário pode ter
// mudado entre a pergunta e a resposta) — nunca ficam congeladas no estado.
function refreshSystemContext(state, seed) {
  if (!state?.context) return state;
  state.context.contact = { ...(state.context.contact || {}), ...seed.contact };
  state.context.bot = { ...seed.bot };
  state.context.conversation = { ...(state.context.conversation || {}), ...seed.conversation };
  return state;
}

// ---- simulação (dry-run) --------------------------------------------------

// Nunca envia nada, nunca altera Conversation/Message. Webhooks só são
// chamados se o Master marcar explicitamente "chamar webhooks no teste".
function simulationAdapter({ bot, refs, outputs, source, callWebhooks, callWebhook }) {
  const categoryName = (id) => refs.categories.find((category) => category.id === id)?.name || null;
  return {
    skipDelays: true,
    async send(text) { if (String(text || "").trim()) outputs.push({ type: "bot", text }); },
    async sendMenu({ text, options }) {
      outputs.push({ type: "bot", text, options: options.map((option) => ({ replyId: option.replyId, label: option.label })), display: "LIST" });
    },
    async sendMedia({ kind, fileName, caption }) {
      outputs.push({ type: "media", kind, text: `[${kind}] ${fileName || "arquivo"}${caption ? ` — ${caption}` : ""}` });
    },
    async transferToCategory({ categoryId, message, reason }) {
      if (!categoryName(categoryId)) throw new Error("Setor de destino não existe ou está inativo.");
      if (message?.trim()) outputs.push({ type: "bot", text: message });
      outputs.push({ type: "event", text: `Transferiria para o setor ${categoryName(categoryId)}`, reason });
      return { categoryId, categoryName: categoryName(categoryId) };
    },
    async transferToUser({ userId, categoryId, message, reason }) {
      const user = refs.users.find((item) => item.id === userId);
      if (!user) throw new Error("Atendente não existe ou está inativo.");
      if (message?.trim()) outputs.push({ type: "bot", text: message });
      outputs.push({ type: "event", text: `Transferiria para ${user.name}${categoryId && categoryName(categoryId) ? ` (${categoryName(categoryId)})` : ""}`, reason });
      return { userId, userName: user.name };
    },
    async handoff({ reason, message, categoryId }) {
      if (message?.trim()) outputs.push({ type: "bot", text: message });
      outputs.push({ type: "event", text: `Entregaria para atendimento humano${categoryId ? ` (${categoryName(categoryId) || "setor"})` : ""}`, reason });
      return { categoryId: categoryId || null };
    },
    async finish({ finalizeConversation }) {
      outputs.push({ type: "event", text: finalizeConversation ? "Finalizaria a conversa" : "Encerraria o Bot e deixaria a conversa para a equipe" });
    },
    async loadFlow(flowId) {
      const target = await prisma.botFlow.findFirst({ where: { id: flowId, botId: bot.id, archivedAt: null }, include: { activeVersion: true } });
      if (!target) return null;
      const graph = source === "ACTIVE" ? target.activeVersion?.graph : target.draftGraph;
      if (!graph) return null;
      outputs.push({ type: "event", text: `Seguiria para o fluxo "${target.name}"` });
      return { flowId: target.id, versionId: source === "ACTIVE" ? target.activeVersionId : null, version: source === "ACTIVE" ? target.activeVersion?.version : null, name: target.name, graph };
    },
    async callWebhook({ endpointKey, fields }) {
      if (!callWebhooks) {
        outputs.push({ type: "event", text: `Chamaria o endpoint "${endpointKey}" (não chamado no teste)` });
        return { ok: true, simulated: true, status: null, data: null };
      }
      const result = await callWebhook(endpointKey, fields);
      outputs.push({ type: "event", text: `Endpoint "${endpointKey}": ${result.ok ? `HTTP ${result.status}` : `falhou (${result.errorCode})`}` });
      return result;
    },
  };
}

async function simulateFlow(botId, flowId, {
  message, replyId, state = null, source = "DRAFT", graph: graphOverride, callWebhooks = false, contactName,
} = {}, viewer, deps = {}) {
  assertBotManager(viewer);
  const bot = await ensureBot(botId);
  const flow = await ensureFlow(botId, flowId);
  if (state && JSON.stringify(state).length > MAX_SIM_STATE_BYTES) throw fail("Estado de simulação grande demais.");
  // Uma simulação que já passou por "Ir para fluxo" continua no fluxo atual
  // do estado (sempre do mesmo Bot).
  let current = { flowId: flow.id, name: flow.name, versionId: null, version: null };
  let graph = graphOverride ?? flow.draftGraph;
  if (source === "ACTIVE") {
    if (!flow.activeVersion) throw fail("Este fluxo ainda não tem versão publicada.");
    graph = flow.activeVersion.graph;
    current = { ...current, versionId: flow.activeVersion.id, version: flow.activeVersion.version };
  }
  if (state?.flow?.flowId && state.flow.flowId !== flow.id) {
    const other = await ensureFlow(botId, state.flow.flowId);
    graph = source === "ACTIVE" ? other.activeVersion?.graph : other.draftGraph;
    if (!graph) throw fail("O fluxo atual da simulação não tem versão publicada.");
    current = { flowId: other.id, name: other.name, versionId: source === "ACTIVE" ? other.activeVersion?.id : null, version: source === "ACTIVE" ? other.activeVersion?.version : null };
  }
  const [categories, users] = await Promise.all([
    prisma.category.findMany({ where: { active: true }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { active: true, role: { not: "BOT" } }, select: { id: true, name: true } }),
  ]);
  const outputs = [];
  const adapter = simulationAdapter({
    bot, refs: { categories, users }, outputs, source, callWebhooks: callWebhooks === true,
    callWebhook: deps.callWebhook || webhookEndpoints.callEndpoint,
  });
  const text = String(message || "").slice(0, 2000);
  const input = state ? { type: "MESSAGE", text, replyId: replyId ? String(replyId).slice(0, 120) : null } : { type: "START", text };
  const now = deps.now || new Date();
  const seed = buildSeed({
    bot, now, contact: { name: String(contactName || "Cliente Teste").slice(0, 80), phone: "5500000000000", email: "" },
    conversation: { id: "simulacao", channel: (bot.channels?.[0] || bot.channel) },
  });
  const result = await runTurn({
    graph, flow: current, state: state ? refreshSystemContext(JSON.parse(JSON.stringify(state)), seed) : null,
    input, adapter, seed, responses: await activeResponseMap(), now,
  });
  return {
    state: result.state, trace: result.trace, outputs, ignored: Boolean(result.ignored),
    currentNodeKey: result.state.currentNodeKey, currentFlowId: result.state.flow?.flowId || flow.id,
    status: result.state.status, dryRun: true,
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
  return Boolean(bot && !bot.archivedAt && bot.status === "ACTIVE" && bot.autoReplyEnabled && globalSettings.automationEnabled);
}

function liveAdapter({ conversation, bot, channel, execution, deps }) {
  const conversationId = conversation.id;
  const callWebhook = deps.callWebhook || webhookEndpoints.callEndpoint;
  const saveSent = async (data) => {
    const occurredAt = new Date();
    await prisma.$transaction([
      prisma.message.create({ data: {
        conversationId, channel: conversation.channel, direction: "ENVIADA", status: "ENVIADA", occurredAt, ...data,
        rawPayload: { ...(data.rawPayload || {}), system: "visual_flow", flowId: execution.flowId, executionId: execution.id },
      } }),
      prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: occurredAt } }),
    ]);
  };
  // flowHandoff marca a mensagem de encaminhamento: o monitor de
  // inatividade nunca finaliza uma conversa que está esperando a equipe.
  const send = async (text, { flowHandoff = false } = {}) => {
    if (!String(text || "").trim()) return;
    const result = await channel.sendText(conversation.contact.phone, text);
    await saveSent({ externalId: result?.externalId || null, type: "text", text, rawPayload: { message: result?.data || null, ...(flowHandoff ? { flowHandoff: true } : {}) } });
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
    // Lista interativa só no WhatsApp e até 10 opções (limite da Meta); fora
    // disso cai para o texto numerado — o cliente pode responder igual.
    async sendMenu({ text, fallbackText, buttonLabel, options }) {
      if (conversation.channel !== "META" || options.length > WHATSAPP_LIST_MAX_ROWS || typeof channel.sendList !== "function") {
        return send(fallbackText);
      }
      const rows = options.map((option) => ({ id: option.replyId, title: option.label.slice(0, 24) }));
      const result = await channel.sendList(conversation.contact.phone, { body: text || fallbackText, button: buttonLabel.slice(0, 20), rows });
      await saveSent({ externalId: result?.externalId || null, type: "interactive", text: fallbackText, rawPayload: { message: result?.data || null } });
    },
    async sendMedia({ kind, storageKey, mimeType, fileName, caption }) {
      const buffer = await fs.readFile(media.resolveMedia(storageKey));
      // Cópia própria por mensagem: excluir a conversa nunca apaga o arquivo
      // do nó (que outras conversas continuam usando).
      const stored = await MEDIA_STORE[kind]({ buffer, mimeType, fileName });
      const result = await channel[CHANNEL_MEDIA_SENDER[kind]](conversation.contact.phone, {
        buffer, mimeType: stored.mimeType, fileName: stored.fileName, caption: caption || undefined,
      });
      await saveSent({
        externalId: result?.externalId || null, type: MEDIA_MESSAGE_TYPE[kind], text: caption || null,
        mediaStorageKey: stored.storageKey, mediaMimeType: stored.mimeType, mediaFileName: stored.fileName, mediaSize: stored.size,
        rawPayload: { message: result?.data || null },
      });
    },
    async transferToCategory({ categoryId, message, reason }) {
      await send(message, { flowHandoff: true });
      return moveToCategory({ categoryId, reason, action: "BOT_FLOW_TRANSFERRED" });
    },
    // Mesmo sistema de atribuição da Central: responsável + setor (o
    // atendente precisa ter acesso ao setor), status EM_ATENDIMENTO, histórico
    // e auditoria. Nunca tira uma conversa de quem já assumiu.
    async transferToUser({ userId, categoryId, message, reason }) {
      const user = await prisma.user.findFirst({ where: { id: userId, active: true, role: { not: "BOT" } } });
      if (!user) throw new Error("Atendente não existe ou está inativo.");
      const targetCategoryId = categoryId || conversation.categoryId || null;
      if (targetCategoryId && !(await prisma.category.findFirst({ where: { id: targetCategoryId, active: true }, select: { id: true } }))) {
        throw new Error("Setor de destino não existe ou está inativo.");
      }
      if (!(await authorization.canAccessCategory(user, targetCategoryId))) throw new Error("O atendente não tem acesso ao setor desta conversa.");
      await send(message, { flowHandoff: true });
      const moved = await prisma.conversation.updateMany({
        where: { id: conversationId, status: "BOT", assignedUserId: null },
        data: { assignedUserId: user.id, categoryId: targetCategoryId, status: "EM_ATENDIMENTO", finalizedAt: null },
      });
      if (!moved.count) return { userId: user.id, userName: user.name, skipped: true };
      await activity("BOT_FLOW_TRANSFERRED_TO_USER", { toUserId: user.id, to: user.name, categoryId: targetCategoryId, reason, flowId: execution.flowId, executionId: execution.id });
      await audit.recordAudit({
        actor: null, action: "CONVERSATION_ASSIGNEE_CHANGED", entityType: "CONVERSATION", entityId: conversationId,
        summary: `Fluxo do Bot "${bot.name}" transferiu a conversa de ${contactLabel} para ${user.name}`,
        details: { conversationId, contactPhone: conversation.contact.phone, from: "Sem responsável", to: user.name, toUserId: user.id, toCategoryId: targetCategoryId, reason, flowId: execution.flowId },
      });
      return { userId: user.id, userName: user.name };
    },
    async handoff({ reason, message, categoryId }) {
      await send(message, { flowHandoff: true });
      if (categoryId) return moveToCategory({ categoryId, reason, action: "BOT_FLOW_HANDOFF" });
      // Sem setor: HANDOFF_BOT (visível para a equipe e fora do alcance do
      // início automático, que só age em NOVO sem categoria).
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
    // Subfluxo em produção: mesmo Bot, publicado e ativo.
    async loadFlow(flowId) {
      const target = await prisma.botFlow.findFirst({
        where: { id: flowId, botId: bot.id, archivedAt: null, status: "ACTIVE", activeVersionId: { not: null } },
        include: { activeVersion: true },
      });
      if (!target?.activeVersion) return null;
      return { flowId: target.id, versionId: target.activeVersion.id, version: target.activeVersion.version, name: target.name, graph: target.activeVersion.graph };
    },
    async callWebhook({ endpointKey, fields }) {
      return callWebhook(endpointKey, fields);
    },
  };
}

async function persistTurn(execution, claimedStep, turn) {
  const { state, trace } = turn;
  const finished = FINISHED_STATUSES.has(state.status);
  const updated = await prisma.botFlowExecution.updateMany({
    where: { id: execution.id, step: claimedStep },
    data: {
      status: state.status, currentNodeKey: state.currentNodeKey, context: state.context,
      // "Ir para fluxo": a execução passa a apontar para o fluxo/versão atual.
      ...(state.flow?.flowId && state.flow?.versionId ? { flowId: state.flow.flowId, versionId: state.flow.versionId } : {}),
      resumeAt: state.status === STATUS.WAITING_TIMER && state.resumeAt ? new Date(state.resumeAt) : null,
      error: state.error || null, step: claimedStep + 1, finishedAt: finished ? new Date() : null,
    },
  });
  if (trace.length) {
    await prisma.botFlowExecutionLog.createMany({
      data: trace.map((entry) => ({
        executionId: execution.id, flowId: entry.flowId || execution.flowId, version: entry.version ?? execution.version?.version ?? 0,
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
    flow: { flowId: execution.flowId, versionId: execution.versionId, version: execution.version?.version ?? null, name: execution.flow?.name || "" },
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
  botState: { select: { humanPausedAt: true, activeBotId: true } },
};

async function findStartBot(conversation) {
  const bots = await prisma.bot.findMany({
    where: {
      archivedAt: null, status: "ACTIVE", autoReplyEnabled: true,
      OR: [{ channel: conversation.channel }, { channels: { has: conversation.channel } }],
    },
    include: botScheduleInclude,
    orderBy: { updatedAt: "desc" },
  });
  // "Bot de resposta" de uma Campanha (ConversationBotState.activeBotId)
  // tem prioridade sobre os demais Bots do canal.
  const preferred = conversation.botState?.activeBotId;
  bots.sort((left, right) => Number(right.id === preferred) - Number(left.id === preferred));
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

async function runLiveTurn({ execution, claimedStep, conversation, bot, channel, version, flowName, input, now, deps }) {
  const adapter = liveAdapter({ conversation, bot, channel, execution, deps });
  const seed = buildSeed({ bot, contact: conversation.contact, conversation, now });
  const state = execution.currentNodeKey || execution.status !== STATUS.RUNNING ? refreshSystemContext(toEngineState(execution), seed) : null;
  let turn;
  try {
    turn = await runTurn({
      graph: version.graph, flow: { flowId: execution.flowId, versionId: version.id, version: version.version, name: flowName },
      state, input, adapter, seed, responses: await activeResponseMap(), now,
    });
  } catch (error) {
    // Nunca derruba o processamento geral: registra e entrega para humano.
    turn = {
      state: { ...(state || { context: {} }), status: STATUS.FAILED, error: error.message?.slice(0, 500) || "Falha no fluxo" },
      trace: [{ nodeKey: execution.currentNodeKey || "?", nodeType: "engine", result: "ERROR", error: error.message?.slice(0, 500), durationMs: 0 }],
    };
    await prisma.conversation.updateMany({ where: { id: conversation.id, status: "BOT", assignedUserId: null }, data: { status: "HANDOFF_BOT" } }).catch(() => {});
  }
  await persistTurn({ ...execution, version }, claimedStep, turn);
  return turn;
}

// Hook do webhook do WhatsApp. Devolve true quando o Flow Builder é dono
// desta mensagem; false quando nenhum fluxo se aplica (a mensagem já foi
// salva e segue para a equipe normalmente).
async function handleIncomingVisualFlow(event, message, channel, { now = new Date(), ...deps } = {}) {
  if (event.type === "reaction") return false;
  const conversation = await prisma.conversation.findUnique({ where: { id: message.conversationId }, include: conversationInclude });
  if (!conversation) return false;
  let globalSettings = null;
  const eligible = async (bot) => {
    globalSettings ||= await getGlobalSettings(prisma);
    return botEligible(bot, globalSettings);
  };
  const text = event.type === "text" ? String(event.text || "") : (event.interactiveTitle || event.text || "");
  const replyId = event.interactiveReplyId || null;

  const active = await prisma.botFlowExecution.findFirst({
    where: { conversationId: conversation.id, status: { in: [STATUS.WAITING_CUSTOMER, STATUS.WAITING_TIMER, STATUS.RUNNING] } },
    orderBy: { startedAt: "desc" },
    include: { version: true, flow: { select: { name: true } } },
  });

  if (active) {
    if (active.lastMessageId === message.id) return true; // reentrega do mesmo evento
    const bot = await prisma.bot.findUnique({ where: { id: active.botId }, include: botScheduleInclude });
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
      flowName: active.flow.name, input: { type: "MESSAGE", text, replyId }, now, deps,
    });
    return true;
  }

  // Reentrega de uma mensagem que já foi consumida por uma execução (mesmo
  // que ela já tenha terminado): continua sendo do Flow Builder.
  const consumed = await prisma.botFlowExecution.findFirst({ where: { conversationId: conversation.id, lastMessageId: message.id }, select: { id: true } });
  if (consumed) return true;

  // Início: conversa nova, sem categoria, sem responsável — nunca "rouba"
  // uma conversa já em atendimento.
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
    flowName: target.flow.name, input: { type: "START", text }, now, deps,
  });
  return true;
}

// Worker do nó Intervalo: nunca "dorme" dentro de um request — a execução
// fica WAITING_TIMER com resumeAt e este tick retoma quando vencer.
async function processDueTimers({ channel, now = new Date(), limit = 20, ...deps } = {}) {
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
      const bot = await prisma.bot.findUnique({ where: { id: execution.botId }, include: botScheduleInclude });
      if (!botIsAllowedToRespond(execution.conversation)) { await cancelExecution(execution, "HUMAN_TOOK_OVER_OR_FINALIZED"); continue; }
      if (!botEligible(bot, globalSettings)) { await cancelExecution(execution, "BOT_DISABLED"); continue; }
      const claimed = await prisma.botFlowExecution.updateMany({
        where: { id: execution.id, step: execution.step, status: STATUS.WAITING_TIMER },
        data: { step: execution.step + 1 },
      });
      if (!claimed.count) continue;
      await runLiveTurn({
        execution, claimedStep: execution.step + 1, conversation: execution.conversation, bot, channel, version: execution.version,
        flowName: execution.flow.name, input: { type: "TIMER" }, now, deps,
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
  archiveFlow, botEligible, createFlow, getEditorOptions, getExecutionLogs, getFlow, getFlowMediaPath, getFlowVersion,
  handleIncomingVisualFlow, listExecutions, listFlows, processDueTimers, publishFlow, restoreVersionToDraft, rollbackFlow,
  saveDraft, setDefaultFlow, setFlowStatus, simulateFlow, startVisualFlowWorker, uploadFlowMedia, validateFlow,
};
