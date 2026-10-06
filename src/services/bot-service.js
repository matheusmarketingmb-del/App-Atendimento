// Bots (Flow Builder como único modelo): um Bot é só identidade (nome,
// descrição, canais), horário de atendimento, status e o interruptor de
// resposta automática. TODO o comportamento vive nos fluxos visuais
// (BotFlow — ver bot-visual-flow-service.js). Criar um Bot já cria o fluxo
// principal e devolve o id para abrir direto o Editor Visual.
//
// O modelo antigo (intenções, IA, Knowledge, Planner, personalidade,
// triagem fixa, versões de Bot) foi arquivado em _archive/bot-legacy/.
// Bots antigos sem fluxo ficam com status ARCHIVED_LEGACY: nunca executam,
// não aparecem na lista principal e só são consultáveis (somente leitura)
// pelo Master em "Histórico técnico" (listLegacyBots).
const prisma = require("../database/prisma");
const audit = require("./audit-service");
const { assertBotManager, fail } = require("./bot-governance-service");
const { defaultGraph } = require("./bot-visual-flow-graph");

const EDITABLE_STATUSES = new Set(["ACTIVE", "PAUSED"]);
const BOT_CHANNELS = new Set([
  "META", "INSTAGRAM_DIRECT", "INSTAGRAM_COMMENTS", "FACEBOOK_MESSENGER", "FACEBOOK_COMMENTS", "EMAIL",
  "MERCADO_LIVRE", "TIKTOK_SHOP", "AMAZON_MARKETPLACE", "SHOPEE", "SHEIN_MARKETPLACE", "GOOGLE_REVIEWS", "RECLAME_AQUI",
]);
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function requiredText(value, label, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw fail(`${label} é obrigatório.`);
  if (text.length > maxLength) throw fail(`${label} deve ter no máximo ${maxLength.toLocaleString("pt-BR")} caracteres.`);
  return text;
}

function optionalText(value, label, maxLength) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw fail(`${label} inválido.`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) throw fail(`${label} deve ter no máximo ${maxLength.toLocaleString("pt-BR")} caracteres.`);
  return text;
}

function validateTimezone(value) {
  const timezone = requiredText(value || "America/Sao_Paulo", "Timezone", 100);
  try { new Intl.DateTimeFormat("pt-BR", { timeZone: timezone }).format(new Date()); }
  catch (_error) { throw fail("Timezone inválida."); }
  return timezone;
}

function validateChannels(value) {
  if (!Array.isArray(value) || !value.length) throw fail("Selecione pelo menos um canal.");
  const unique = [...new Set(value)];
  for (const channel of unique) if (!BOT_CHANNELS.has(channel)) throw fail(`Canal inválido: ${String(channel).slice(0, 40)}`);
  return unique;
}

function validateSchedules(value) {
  if (!Array.isArray(value)) throw fail("Os horários devem ser uma lista.");
  if (value.length > 7) throw fail("Configure no máximo um horário para cada dia da semana.");
  const days = new Set();
  return value.map((item) => {
    if (!item || !Number.isInteger(item.dayOfWeek) || item.dayOfWeek < 0 || item.dayOfWeek > 6) {
      throw fail("O dia da semana deve estar entre 0 e 6.");
    }
    if (days.has(item.dayOfWeek)) throw fail("Existe mais de um horário configurado para o mesmo dia.");
    days.add(item.dayOfWeek);
    if (typeof item.enabled !== "boolean") throw fail("Informe se o horário está habilitado.");
    if (!TIME_PATTERN.test(item.startTime || "") || !TIME_PATTERN.test(item.endTime || "")) {
      throw fail("Os horários devem usar o formato HH:mm.");
    }
    if (item.endTime <= item.startTime) throw fail("O horário final deve ser posterior ao horário inicial.");
    return { dayOfWeek: item.dayOfWeek, enabled: item.enabled, startTime: item.startTime, endTime: item.endTime };
  });
}

function validateHolidays(value) {
  if (!Array.isArray(value)) throw fail("Os feriados devem ser uma lista.");
  if (value.length > 100) throw fail("Configure no máximo 100 feriados.");
  const dates = new Set();
  return value.map((item) => {
    const date = typeof item?.date === "string" ? item.date.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail("A data do feriado deve usar o formato AAAA-MM-DD.");
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw fail("Data de feriado inválida.");
    if (dates.has(date)) throw fail("Existe mais de um feriado configurado para a mesma data.");
    dates.add(date);
    if (item.enabled !== undefined && typeof item.enabled !== "boolean") throw fail("Informe se o feriado está habilitado.");
    return { date, name: requiredText(item.name, "Nome do feriado", 100), enabled: item.enabled === undefined ? true : item.enabled };
  });
}

const botInclude = {
  schedules: { orderBy: { dayOfWeek: "asc" } },
  holidays: { orderBy: { date: "asc" } },
  visualFlows: {
    where: { archivedAt: null },
    select: {
      id: true, name: true, description: true, status: true, isDefault: true, draftUpdatedAt: true, updatedAt: true,
      activeVersion: { select: { version: true } },
    },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  },
};

function botSummary(bot) {
  const flows = (bot.visualFlows || []).map((flow) => ({
    id: flow.id, name: flow.name, description: flow.description, status: flow.status, isDefault: flow.isDefault,
    activeVersion: flow.activeVersion?.version || null, draftUpdatedAt: flow.draftUpdatedAt, updatedAt: flow.updatedAt,
  }));
  return {
    id: bot.id, name: bot.name, description: bot.description, status: bot.status, type: bot.type, isSystem: bot.isSystem,
    channels: bot.channels?.length ? bot.channels : [bot.channel], timezone: bot.timezone,
    autoReplyEnabled: bot.autoReplyEnabled, createdAt: bot.createdAt, updatedAt: bot.updatedAt,
    initialMessage: bot.initialMessage, outsideHoursMessage: bot.outsideHoursMessage,
    holidayMessage: bot.holidayMessage || bot.featureFlags?.holidayMessage || "", fallbackMessage: bot.fallbackMessage, handoffMessage: bot.handoffMessage,
    runOnNewConversation: bot.runOnNewConversation, runAfterReopen: bot.runAfterReopen,
    ratingEnabled: bot.ratingEnabled, ratingMessage: bot.ratingMessage, ratingFollowupMessage: bot.ratingFollowupMessage,
    requestRatingOn: bot.requestRatingOn, requestRatingComment: bot.requestRatingComment,
    assistantAfterTriage: bot.featureFlags?.assistantAfterTriage === true,
    schedules: bot.schedules || [], holidays: bot.holidays || [],
    flows, defaultFlowId: flows.find((flow) => flow.isDefault)?.id || null,
    readyToRespond: flows.some((flow) => flow.isDefault && flow.status === "ACTIVE" && flow.activeVersion),
  };
}

// Bot editável = não excluído e não ARCHIVED_LEGACY.
async function ensureBot(botId, client = prisma) {
  const bot = await client.bot.findFirst({
    where: { id: botId, archivedAt: null, status: { not: "ARCHIVED_LEGACY" } }, include: botInclude,
  });
  if (!bot) throw fail("Bot não encontrado.", 404);
  return bot;
}

async function listBots(viewer) {
  assertBotManager(viewer);
  const bots = await prisma.bot.findMany({
    where: { archivedAt: null, status: { not: "ARCHIVED_LEGACY" } },
    include: botInclude,
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
  });
  return bots.map(botSummary);
}

async function getBot(botId, viewer) {
  assertBotManager(viewer);
  return botSummary(await ensureBot(botId));
}

// Novo Bot -> já nasce com o "Fluxo principal" (Início -> Finalizar) e a
// auto-resposta DESLIGADA: nada responde cliente até o Master publicar o
// fluxo e ligar explicitamente.
async function createBot(data, actor) {
  assertBotManager(actor);
  const channels = validateChannels(data.channels);
  const name = requiredText(data.name, "Nome", 100);
  const created = await prisma.$transaction(async (transaction) => {
    const bot = await transaction.bot.create({
      data: {
        name, description: optionalText(data.description, "Descrição", 500),
        channel: channels[0], channels, timezone: validateTimezone(data.timezone),
        status: "ACTIVE", autoReplyEnabled: false, executionMode: "FLOW_BUILDER",
        initialMessage: "", outsideHoursMessage: "", fallbackMessage: "",
      },
    });
    const flow = await transaction.botFlow.create({
      data: {
        botId: bot.id, name: "Fluxo principal", draftGraph: defaultGraph(), isDefault: true,
        createdByUserId: actor.id, createdByName: actor.name || null, updatedByUserId: actor.id, updatedByName: actor.name || null,
      },
    });
    await audit.recordAudit({
      actor, action: "BOT_CREATED", entityType: "BOT", entityId: bot.id,
      summary: `Criou o Bot ${bot.name}`, details: { channels, flowId: flow.id },
    }, transaction);
    return { botId: bot.id, flowId: flow.id };
  });
  return { ...(await getBot(created.botId, actor)), createdFlowId: created.flowId };
}

async function updateBot(botId, data, actor) {
  assertBotManager(actor);
  const existing = await ensureBot(botId);
  const update = {};
  if (data.name !== undefined) update.name = requiredText(data.name, "Nome", 100);
  if (data.description !== undefined) update.description = optionalText(data.description, "Descrição", 500);
  if (data.channels !== undefined) {
    update.channels = validateChannels(data.channels);
    update.channel = update.channels[0];
  }
  if (data.timezone !== undefined) update.timezone = validateTimezone(data.timezone);
  for (const key of ["initialMessage", "outsideHoursMessage", "fallbackMessage", "handoffMessage", "ratingMessage", "ratingFollowupMessage"]) {
    if (data[key] !== undefined) update[key] = optionalText(data[key], "Mensagem", 4000) || (key.endsWith("Message") && ["initialMessage", "outsideHoursMessage", "fallbackMessage"].includes(key) ? "" : null);
  }
  if (data.holidayMessage !== undefined) update.holidayMessage = optionalText(data.holidayMessage, "Mensagem de feriado", 4000);
  for (const key of ["runOnNewConversation", "runAfterReopen", "ratingEnabled", "requestRatingComment"]) {
    if (data[key] !== undefined) {
      if (typeof data[key] !== "boolean") throw fail("Configuração inválida.");
      if (key === "runOnNewConversation" && data[key] && existing.featureFlags?.assistantAfterTriage) throw fail("Este Assistente inicia após a Triagem, não na recepção inicial.");
      update[key] = data[key];
    }
  }
  if (data.requestRatingOn !== undefined) {
    if (!["BOT_COMPLETED", "HANDOFF"].includes(data.requestRatingOn)) throw fail("Momento da avaliação inválido.");
    update.requestRatingOn = data.requestRatingOn;
  }
  if (!Object.keys(update).length) throw fail("Informe ao menos um campo para atualizar.");
  await prisma.$transaction(async (transaction) => {
    await transaction.bot.update({ where: { id: botId }, data: update });
    await audit.recordAudit({
      actor, action: "BOT_UPDATED", entityType: "BOT", entityId: botId,
      summary: `Alterou o Bot ${existing.name}`, details: { fields: Object.keys(update) },
    }, transaction);
  });
  return getBot(botId, actor);
}

async function setBotStatus(botId, status, actor) {
  assertBotManager(actor);
  if (!EDITABLE_STATUSES.has(status)) throw fail("Status do Bot inválido (use ACTIVE ou PAUSED).");
  const existing = await ensureBot(botId);
  if (existing.status === status) return botSummary(existing);
  await prisma.$transaction(async (transaction) => {
    await transaction.bot.update({ where: { id: botId }, data: { status } });
    await audit.recordAudit({
      actor, action: "BOT_STATUS_CHANGED", entityType: "BOT", entityId: botId,
      summary: `Alterou o status do Bot ${existing.name} de ${existing.status} para ${status}`,
      details: { from: existing.status, to: status },
    }, transaction);
  });
  return getBot(botId, actor);
}

// Ligar a auto-resposta exige um fluxo padrão publicado e ativo — nunca liga
// "no escuro" um Bot que ainda não tem o que executar.
async function setAutoReply(botId, enabled, actor) {
  assertBotManager(actor);
  if (typeof enabled !== "boolean") throw fail("Informe se a resposta automática deve ficar ligada.");
  const existing = await ensureBot(botId);
  if (enabled && !botSummary(existing).readyToRespond) {
    throw fail("Publique e ative o fluxo padrão antes de ligar a resposta automática.");
  }
  if (existing.autoReplyEnabled === enabled) return botSummary(existing);
  await prisma.$transaction(async (transaction) => {
    await transaction.bot.update({ where: { id: botId }, data: { autoReplyEnabled: enabled } });
    await audit.recordAudit({
      actor, action: enabled ? "BOT_AUTO_REPLY_ENABLED" : "BOT_AUTO_REPLY_DISABLED", entityType: "BOT", entityId: botId,
      summary: `${enabled ? "Ativou" : "Desativou"} a resposta automática do Bot ${existing.name}`,
    }, transaction);
  });
  return getBot(botId, actor);
}

async function archiveBot(botId, actor) {
  assertBotManager(actor);
  const existing = await ensureBot(botId);
  if (existing.isSystem) throw fail("Este é um Bot do sistema e não pode ser excluído.");
  await prisma.$transaction(async (transaction) => {
    await transaction.bot.update({ where: { id: botId }, data: { archivedAt: new Date(), status: "PAUSED", autoReplyEnabled: false } });
    await audit.recordAudit({
      actor, action: "BOT_ARCHIVED", entityType: "BOT", entityId: botId, summary: `Arquivou o Bot ${existing.name}`,
    }, transaction);
  });
  return { archived: true };
}

async function replaceSchedules(botId, value, actor) {
  assertBotManager(actor);
  const bot = await ensureBot(botId);
  const schedules = validateSchedules(value);
  await prisma.$transaction(async (transaction) => {
    await transaction.botSchedule.deleteMany({ where: { botId } });
    if (schedules.length) await transaction.botSchedule.createMany({ data: schedules.map((schedule) => ({ ...schedule, botId })) });
    await audit.recordAudit({
      actor, action: "BOT_SCHEDULES_UPDATED", entityType: "BOT", entityId: botId,
      summary: `Alterou os horários do Bot ${bot.name}`, details: { schedules },
    }, transaction);
  });
  return getBot(botId, actor);
}

async function replaceHolidays(botId, value, actor) {
  assertBotManager(actor);
  const bot = await ensureBot(botId);
  const holidays = validateHolidays(value);
  await prisma.$transaction(async (transaction) => {
    await transaction.botHoliday.deleteMany({ where: { botId } });
    if (holidays.length) await transaction.botHoliday.createMany({ data: holidays.map((holiday) => ({ ...holiday, botId })) });
    await audit.recordAudit({
      actor, action: "BOT_HOLIDAYS_UPDATED", entityType: "BOT", entityId: botId,
      summary: `Alterou os feriados do Bot ${bot.name}`, details: { holidays },
    }, transaction);
  });
  return getBot(botId, actor);
}

// "Histórico técnico" (só Master, somente leitura): Bots do sistema antigo
// marcados ARCHIVED_LEGACY na migração. Mostra só o resumo + contagens —
// o código que os executava está em _archive/bot-legacy/.
async function listLegacyBots(viewer) {
  assertBotManager(viewer);
  const bots = await prisma.bot.findMany({
    where: { status: "ARCHIVED_LEGACY" },
    select: {
      id: true, name: true, description: true, channel: true, channels: true, type: true, createdAt: true, updatedAt: true,
      featureFlags: true, archivedAt: true,
      _count: { select: { intents: true, observations: true, learningSuggestions: true, knowledgeSources: true, versions: true } },
    },
    orderBy: { name: "asc" },
  });
  return bots.map((bot) => ({
    id: bot.id, name: bot.name, description: bot.description, type: bot.type,
    channels: bot.channels?.length ? bot.channels : [bot.channel], createdAt: bot.createdAt, updatedAt: bot.updatedAt,
    deletedAt: bot.archivedAt, statusBeforeArchive: bot.featureFlags?.legacyStatusBeforeArchive || null,
    legacyArchivedAt: bot.featureFlags?.legacyArchivedAt || null, counts: bot._count,
  }));
}

module.exports = {
  BOT_CHANNELS, archiveBot, createBot, ensureBot, getBot, listBots, listLegacyBots, replaceHolidays, replaceSchedules,
  setAutoReply, setBotStatus, updateBot, validateHolidays, validateSchedules,
};
