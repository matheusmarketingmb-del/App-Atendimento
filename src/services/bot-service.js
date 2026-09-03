const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const audit = require("./audit-service");
const { normalizeText } = require("./bot-simulator-service");
const { simulateOrchestration } = require("./bot-orchestrator-service");
const { simulateTriage } = require("./triage-bot-service");
const flowEngine = require("./bot-flow-service");
const learning = require("./bot-learning-service");
const governance = require("./bot-governance-service");
const { similarity } = require("./ai/local-fallback-provider");
const {
  CONTEXT_MESSAGE_LIMIT, DEFAULT_HIGH_CONFIDENCE_THRESHOLD, DEFAULT_LOW_CONFIDENCE_THRESHOLD,
  MAX_FAILED_INTERPRETATIONS, validateConfidenceThresholds,
} = require("./bot-constants");
const observationFeedbackValues = new Set(["CORRECT", "INCORRECT"]);

const botStatuses = new Set(["DRAFT", "ACTIVE", "PAUSED"]);
const botChannels = new Set([
  "META",
  "INSTAGRAM_DIRECT",
  "INSTAGRAM_COMMENTS",
  "FACEBOOK_MESSENGER",
  "FACEBOOK_COMMENTS",
  "EMAIL",
  "MERCADO_LIVRE",
  "TIKTOK_SHOP",
  "AMAZON_MARKETPLACE",
  "SHOPEE",
  "SHEIN_MARKETPLACE",
  "GOOGLE_REVIEWS",
  "RECLAME_AQUI",
]);
const fallbackActions = new Set(["USE_BOT_FALLBACK", "TRANSFER_TO_CATEGORY", "TRANSFER_TO_HUMAN"]);
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const categorySelection = { id: true, code: true, name: true, color: true, active: true };
const botInclude = {
  defaultCategory: { select: categorySelection },
  schedules: { orderBy: { dayOfWeek: "asc" } },
  holidays: { orderBy: { date: "asc" } },
  intents: {
    include: {
      category: { select: categorySelection },
      examples: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  },
  triageOptions: {
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    include: { category: { select: categorySelection } },
  },
  personality: true,
};

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function assertBotManager(viewer) {
  if (!authorization.isMaster(viewer)) {
    throw authorization.forbidden("Somente uma conta Master pode gerenciar Bots.");
  }
}

function requiredText(value, label, maxLength = 4000) {
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
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: timezone }).format(new Date());
  } catch (_error) {
    throw fail("Timezone inválida.");
  }
  return timezone;
}

async function validateCategoryId(value, client = prisma) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw fail("Categoria inválida.");
  const category = await client.category.findFirst({
    where: { id: value, active: true },
    select: { id: true },
  });
  if (!category) throw fail("Categoria não encontrada ou inativa.");
  return category.id;
}

function validateStatus(value) {
  if (!botStatuses.has(value)) throw fail("Status do Bot inválido.");
  return value;
}

function validateChannel(value) {
  if (!botChannels.has(value)) throw fail("Canal do Bot inválido.");
  return value;
}

// `channels` é aditivo ao `channel` legado (item 21) — nunca obrigatório,
// nunca substitui o campo original. Um Bot single-channel continua
// funcionando sem nunca precisar preencher isto.
function validateChannels(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw fail("channels deve ser uma lista de canais.");
  const unique = [...new Set(value)];
  for (const channel of unique) {
    if (!botChannels.has(channel)) throw fail(`Canal inválido em channels: ${channel}`);
  }
  return unique;
}

function validatePriority(value) {
  const priority = value === undefined ? 0 : value;
  if (!Number.isInteger(priority) || priority < -1000 || priority > 1000) {
    throw fail("A prioridade deve ser um número inteiro entre -1000 e 1000.");
  }
  return priority;
}

function validateThresholds(low, high) {
  const lowValue = low === undefined ? DEFAULT_LOW_CONFIDENCE_THRESHOLD : Number(low);
  const highValue = high === undefined ? DEFAULT_HIGH_CONFIDENCE_THRESHOLD : Number(high);
  if (!validateConfidenceThresholds(lowValue, highValue)) {
    throw fail("Os limites de confiança devem satisfazer 0 <= baixo <= alto <= 1.");
  }
  return { lowConfidenceThreshold: lowValue, highConfidenceThreshold: highValue };
}

function validateFallbackAction(value) {
  const action = value || "USE_BOT_FALLBACK";
  if (!fallbackActions.has(action)) throw fail("Ação de fallback inválida.");
  return action;
}

function normalizeExamples(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw fail("Os exemplos da intenção devem ser uma lista.");
  const examples = [];
  const normalized = new Set();
  for (const entry of value) {
    const text = requiredText(entry, "Exemplo da intenção", 500);
    const key = normalizeText(text);
    if (normalized.has(key)) throw fail("Remova exemplos repetidos da intenção.");
    normalized.add(key);
    examples.push(text);
  }
  if (examples.length > 100) throw fail("Cada intenção pode ter no máximo 100 exemplos.");
  return examples;
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
    if (!timePattern.test(item.startTime || "") || !timePattern.test(item.endTime || "")) {
      throw fail("Os horários devem usar o formato HH:mm.");
    }
    if (item.endTime <= item.startTime) throw fail("O horário final deve ser posterior ao horário inicial.");
    return {
      dayOfWeek: item.dayOfWeek,
      enabled: item.enabled,
      startTime: item.startTime,
      endTime: item.endTime,
    };
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
    return {
      date,
      name: requiredText(item.name, "Nome do feriado", 100),
      enabled: item.enabled === undefined ? true : item.enabled,
    };
  });
}

async function ensureBot(botId, client = prisma, include = undefined) {
  const bot = await client.bot.findFirst({
    where: { id: botId, archivedAt: null },
    ...(include ? { include } : {}),
  });
  if (!bot) throw fail("Bot não encontrado.", 404);
  return bot;
}

function botSnapshot(bot) {
  return {
    name: bot.name,
    description: bot.description,
    status: bot.status,
    channel: bot.channel,
    channels: bot.channels,
    timezone: bot.timezone,
    defaultCategoryId: bot.defaultCategoryId,
    introduceWithName: bot.introduceWithName,
    autoReplyEnabled: bot.autoReplyEnabled,
    toolsEnabled: bot.toolsEnabled,
    ratingEnabled: bot.ratingEnabled,
    runOnNewConversation: bot.runOnNewConversation,
    runAfterReopen: bot.runAfterReopen,
  };
}

// Identidade + governança (seções "Identidade"/"Recursos do Bot" da tela).
// Válido tanto para criação quanto edição parcial. `existing` (quando
// informado) é usado para MESCLAR featureFlags/toolPermissions em vez de
// sobrescrever o JSON inteiro com só as chaves enviadas desta vez.
function identityAndGovernanceInput(data, existing = null) {
  const update = {};
  if (data.introduceWithName !== undefined) {
    if (typeof data.introduceWithName !== "boolean") throw fail("introduceWithName deve ser verdadeiro ou falso.");
    update.introduceWithName = data.introduceWithName;
  }
  if (data.presentationMessage !== undefined) {
    update.presentationMessage = optionalText(data.presentationMessage, "Mensagem de apresentação", 500);
  }
  if (data.reintroduceOnNewSession !== undefined) {
    if (typeof data.reintroduceOnNewSession !== "boolean") throw fail("reintroduceOnNewSession deve ser verdadeiro ou falso.");
    update.reintroduceOnNewSession = data.reintroduceOnNewSession;
  }
  // Toggles críticos: nunca herdam automaticamente, sempre exigem valor
  // booleano explícito quando enviados.
  for (const key of ["autoReplyEnabled", "toolsEnabled", "ratingEnabled"]) {
    if (data[key] !== undefined) {
      if (typeof data[key] !== "boolean") throw fail(`${key} deve ser verdadeiro ou falso.`);
      update[key] = data[key];
    }
  }
  const featureFlags = governance.validateFeatureFlagsInput(data.featureFlags);
  if (featureFlags !== undefined) {
    const stored = existing?.featureFlags && typeof existing.featureFlags === "object" ? existing.featureFlags : {};
    update.featureFlags = { ...stored, ...featureFlags };
  }
  const toolPermissions = governance.validateToolPermissionsInput(data.toolPermissions);
  if (toolPermissions !== undefined) {
    const stored = existing?.toolPermissions && typeof existing.toolPermissions === "object" ? existing.toolPermissions : {};
    update.toolPermissions = { ...stored, ...toolPermissions };
  }
  return update;
}

async function listBots(viewer) {
  assertBotManager(viewer);
  return prisma.bot.findMany({
    where: { archivedAt: null },
    include: {
      defaultCategory: { select: categorySelection },
      schedules: { orderBy: { dayOfWeek: "asc" } },
      _count: { select: { schedules: true, holidays: true, intents: true, triageOptions: true } },
    },
    orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
  });
}

// Lista achatada de todas as intenções de todos os Bots — usada pela tela
// de Respostas Rápidas para associar uma resposta a uma ou mais intenções
// (item 16), sem duplicar a listagem completa de Bots.
async function listAllIntents(viewer) {
  assertBotManager(viewer);
  const intents = await prisma.botIntent.findMany({
    where: { active: true },
    select: { id: true, name: true, botId: true, bot: { select: { name: true } } },
    orderBy: [{ bot: { name: "asc" } }, { name: "asc" }],
  });
  return intents.map((intent) => ({ id: intent.id, name: intent.name, botId: intent.botId, botName: intent.bot.name }));
}

async function getBot(botId, viewer) {
  assertBotManager(viewer);
  return ensureBot(botId, prisma, botInclude);
}

async function createBot(data, actor) {
  assertBotManager(actor);
  // `type`/`isSystem` nunca vêm da API: um Bot SYSTEM_TRIAGE só existe via
  // migration de seed (item "não criar um segundo bot paralelo") — todo Bot
  // criado pela tela nasce STANDARD, mesmo que o payload tente outra coisa.
  const create = {
    name: requiredText(data.name, "Nome", 100),
    description: optionalText(data.description, "Descrição", 500),
    channel: validateChannel(data.channel),
    channels: validateChannels(data.channels) || [],
    initialMessage: requiredText(data.initialMessage, "Mensagem inicial"),
    outsideHoursMessage: requiredText(data.outsideHoursMessage, "Mensagem fora do horário"),
    fallbackMessage: requiredText(data.fallbackMessage, "Mensagem de fallback"),
    timezone: validateTimezone(data.timezone),
    defaultCategoryId: await validateCategoryId(data.defaultCategoryId),
    ...validateThresholds(data.lowConfidenceThreshold, data.highConfidenceThreshold),
    ...identityAndGovernanceInput(data),
  };
  return prisma.$transaction(async (transaction) => {
    const bot = await transaction.bot.create({ data: create, include: botInclude });
    await audit.recordAudit({
      actor,
      action: "BOT_CREATED",
      entityType: "BOT",
      entityId: bot.id,
      summary: `Criou o Bot ${bot.name}`,
      details: { bot: botSnapshot(bot) },
    }, transaction);
    return bot;
  });
}

async function updateBot(botId, data, actor) {
  assertBotManager(actor);
  const existing = await ensureBot(botId);
  const update = {};
  if (data.name !== undefined) update.name = requiredText(data.name, "Nome", 100);
  if (data.description !== undefined) update.description = optionalText(data.description, "Descrição", 500);
  if (data.channel !== undefined) update.channel = validateChannel(data.channel);
  if (data.channels !== undefined) update.channels = validateChannels(data.channels) || [];
  if (data.initialMessage !== undefined) update.initialMessage = requiredText(data.initialMessage, "Mensagem inicial");
  if (data.outsideHoursMessage !== undefined) update.outsideHoursMessage = requiredText(data.outsideHoursMessage, "Mensagem fora do horário");
  if (data.fallbackMessage !== undefined) update.fallbackMessage = requiredText(data.fallbackMessage, "Mensagem de fallback");
  if (data.handoffMessage !== undefined) update.handoffMessage = optionalText(data.handoffMessage, "Mensagem após encaminhamento", 4000);
  if (data.timezone !== undefined) update.timezone = validateTimezone(data.timezone);
  if (data.defaultCategoryId !== undefined) update.defaultCategoryId = await validateCategoryId(data.defaultCategoryId);
  for (const key of ["runOnNewConversation", "runAfterReopen"]) {
    if (data[key] !== undefined) {
      if (typeof data[key] !== "boolean") throw fail(`${key} deve ser verdadeiro ou falso.`);
      update[key] = data[key];
    }
  }
  if (data.lowConfidenceThreshold !== undefined || data.highConfidenceThreshold !== undefined) {
    Object.assign(update, validateThresholds(
      data.lowConfidenceThreshold !== undefined ? data.lowConfidenceThreshold : existing.lowConfidenceThreshold,
      data.highConfidenceThreshold !== undefined ? data.highConfidenceThreshold : existing.highConfidenceThreshold,
    ));
  }
  Object.assign(update, identityAndGovernanceInput(data, existing));
  if (!Object.keys(update).length) throw fail("Informe ao menos um campo para atualizar.");

  return prisma.$transaction(async (transaction) => {
    const bot = await transaction.bot.update({ where: { id: botId }, data: update, include: botInclude });
    await audit.recordAudit({
      actor,
      action: "BOT_UPDATED",
      entityType: "BOT",
      entityId: bot.id,
      summary: `Alterou o Bot ${bot.name}`,
      details: { before: botSnapshot(existing), after: botSnapshot(bot) },
    }, transaction);
    // Toggles críticos ganham uma entrada de auditoria própria e explícita,
    // além do BOT_UPDATED genérico acima — mais fácil de encontrar depois.
    if (update.autoReplyEnabled !== undefined && update.autoReplyEnabled !== existing.autoReplyEnabled) {
      await audit.recordAudit({
        actor, action: update.autoReplyEnabled ? "BOT_AUTO_REPLY_ENABLED" : "BOT_AUTO_REPLY_DISABLED",
        entityType: "BOT", entityId: bot.id,
        summary: `${update.autoReplyEnabled ? "Ativou" : "Desativou"} a resposta automática do Bot ${bot.name}`,
      }, transaction);
    }
    if (update.toolsEnabled !== undefined && update.toolsEnabled !== existing.toolsEnabled) {
      await audit.recordAudit({
        actor, action: update.toolsEnabled ? "BOT_TOOLS_ENABLED" : "BOT_TOOLS_DISABLED",
        entityType: "BOT", entityId: bot.id,
        summary: `${update.toolsEnabled ? "Ativou" : "Desativou"} o uso de Tools do Bot ${bot.name}`,
      }, transaction);
    }
    if (update.ratingEnabled !== undefined && update.ratingEnabled !== existing.ratingEnabled) {
      await audit.recordAudit({
        actor, action: update.ratingEnabled ? "BOT_RATING_ENABLED" : "BOT_RATING_DISABLED",
        entityType: "BOT", entityId: bot.id,
        summary: `${update.ratingEnabled ? "Ativou" : "Desativou"} a avaliação do atendimento do Bot ${bot.name}`,
      }, transaction);
    }
    return bot;
  });
}

async function updateBotStatus(botId, status, actor) {
  assertBotManager(actor);
  const existing = await ensureBot(botId);
  const nextStatus = validateStatus(status);
  if (existing.status === nextStatus) return ensureBot(botId, prisma, botInclude);
  return prisma.$transaction(async (transaction) => {
    const bot = await transaction.bot.update({
      where: { id: botId },
      data: { status: nextStatus },
      include: botInclude,
    });
    await audit.recordAudit({
      actor,
      action: "BOT_STATUS_CHANGED",
      entityType: "BOT",
      entityId: bot.id,
      summary: `Alterou o status do Bot ${bot.name} de ${existing.status} para ${nextStatus}`,
      details: { from: existing.status, to: nextStatus },
    }, transaction);
    return bot;
  });
}

async function archiveBot(botId, actor) {
  assertBotManager(actor);
  const existing = await ensureBot(botId);
  // Item "Bot de Sistema": não permitir exclusão acidental. Ativar/desativar
  // (updateBotStatus) continua liberado — é o controle real pedido; só
  // arquivar/excluir fica bloqueado para um Bot de sistema.
  if (existing.isSystem) throw fail("Este é um Bot do sistema e não pode ser arquivado/excluído.");
  return prisma.$transaction(async (transaction) => {
    const bot = await transaction.bot.update({
      where: { id: botId },
      data: { archivedAt: new Date(), status: "PAUSED" },
      include: botInclude,
    });
    await audit.recordAudit({
      actor,
      action: "BOT_ARCHIVED",
      entityType: "BOT",
      entityId: bot.id,
      summary: `Arquivou o Bot ${bot.name}`,
      details: { before: botSnapshot(existing), archivedAt: bot.archivedAt },
    }, transaction);
    return bot;
  });
}

async function replaceSchedules(botId, value, actor) {
  assertBotManager(actor);
  const bot = await ensureBot(botId);
  const schedules = validateSchedules(value);
  return prisma.$transaction(async (transaction) => {
    await transaction.botSchedule.deleteMany({ where: { botId } });
    if (schedules.length) {
      await transaction.botSchedule.createMany({
        data: schedules.map((schedule) => ({ ...schedule, botId })),
      });
    }
    await audit.recordAudit({
      actor,
      action: "BOT_SCHEDULES_UPDATED",
      entityType: "BOT",
      entityId: bot.id,
      summary: `Alterou os horários do Bot ${bot.name}`,
      details: { schedules },
    }, transaction);
    return transaction.bot.findUnique({ where: { id: botId }, include: botInclude });
  });
}

async function replaceHolidays(botId, value, actor) {
  assertBotManager(actor);
  const bot = await ensureBot(botId);
  if (bot.type !== "SYSTEM_TRIAGE") throw fail("Apenas o Bot de Triagem aceita feriados.");
  const holidays = validateHolidays(value);
  return prisma.$transaction(async (transaction) => {
    await transaction.botHoliday.deleteMany({ where: { botId } });
    if (holidays.length) {
      await transaction.botHoliday.createMany({ data: holidays.map((holiday) => ({ ...holiday, botId })) });
    }
    await audit.recordAudit({
      actor,
      action: "BOT_HOLIDAYS_UPDATED",
      entityType: "BOT",
      entityId: bot.id,
      summary: `Alterou os feriados do Bot ${bot.name}`,
      details: { holidays },
    }, transaction);
    return transaction.bot.findUnique({ where: { id: botId }, include: botInclude });
  });
}

// Opções/setores da triagem (item "Fluxo/Opções"). Mesmo padrão de
// replaceSchedules: substitui a lista inteira numa transação, sempre
// validando a categoria de destino (nunca aceita categoria inexistente ou
// inativa — item "não permitir destino inválido").
async function validateTriageOptions(value) {
  if (!Array.isArray(value)) throw fail("As opções de triagem devem ser uma lista.");
  if (!value.length) throw fail("Configure ao menos uma opção de triagem.");
  if (value.length > 20) throw fail("O Bot de Triagem pode ter no máximo 20 opções.");
  const usedCategories = new Set();
  const options = [];
  for (const [index, item] of value.entries()) {
    const label = requiredText(item?.label, "Rótulo da opção", 24);
    const description = optionalText(item?.description, "Descrição da opção", 200);
    const categoryId = await validateCategoryId(item?.categoryId);
    if (!categoryId) throw fail("Selecione a categoria de destino de cada opção.");
    if (usedCategories.has(categoryId)) throw fail("Cada categoria só pode aparecer em uma opção de triagem.");
    usedCategories.add(categoryId);
    if (item?.enabled !== undefined && typeof item.enabled !== "boolean") throw fail("Informe se a opção está habilitada.");
    options.push({
      categoryId, label, description,
      enabled: item?.enabled === undefined ? true : item.enabled,
      order: Number.isInteger(item?.order) ? item.order : index * 10,
    });
  }
  return options;
}

async function replaceTriageOptions(botId, value, actor) {
  assertBotManager(actor);
  const bot = await ensureBot(botId);
  if (bot.type !== "SYSTEM_TRIAGE") throw fail("Apenas o Bot de Triagem tem opções de setor.");
  const options = await validateTriageOptions(value);
  return prisma.$transaction(async (transaction) => {
    await transaction.botTriageOption.deleteMany({ where: { botId } });
    await transaction.botTriageOption.createMany({
      data: options.map((option) => ({ ...option, botId })),
    });
    await audit.recordAudit({
      actor,
      action: "BOT_TRIAGE_OPTIONS_UPDATED",
      entityType: "BOT",
      entityId: bot.id,
      summary: `Alterou as opções de triagem do Bot ${bot.name}`,
      details: { options },
    }, transaction);
    return transaction.bot.findUnique({ where: { id: botId }, include: botInclude });
  });
}

async function intentInput(data, { partial = false, existing = null } = {}) {
  const input = {};
  if (!partial || data.name !== undefined) input.name = requiredText(data.name, "Nome da intenção", 100);
  if (!partial || data.description !== undefined) input.description = optionalText(data.description, "Descrição da intenção", 500);
  if (!partial || data.responseMessage !== undefined) input.responseMessage = optionalText(data.responseMessage, "Mensagem de resposta", 4000);
  if (!partial || data.priority !== undefined) input.priority = validatePriority(data.priority);
  if (!partial || data.active !== undefined) {
    if (data.active !== undefined && typeof data.active !== "boolean") throw fail("Informe se a intenção está ativa.");
    input.active = data.active === undefined ? true : data.active;
  }
  if (!partial || data.fallbackAction !== undefined) input.fallbackAction = validateFallbackAction(data.fallbackAction);
  if (!partial || data.categoryId !== undefined) input.categoryId = await validateCategoryId(data.categoryId);
  const examples = normalizeExamples(data.examples);
  const resultingAction = input.fallbackAction ?? existing?.fallbackAction ?? "USE_BOT_FALLBACK";
  const resultingCategoryId = input.categoryId !== undefined ? input.categoryId : existing?.categoryId;
  if (resultingAction === "TRANSFER_TO_CATEGORY" && !resultingCategoryId) {
    throw fail("Selecione uma categoria para transferir esta intenção.");
  }
  return { input, examples };
}

async function createIntent(botId, data, actor) {
  assertBotManager(actor);
  const bot = await ensureBot(botId);
  const { input, examples = [] } = await intentInput(data);
  return prisma.$transaction(async (transaction) => {
    const intent = await transaction.botIntent.create({
      data: {
        ...input,
        botId,
        examples: { create: examples.map((text) => ({ text })) },
      },
      include: {
        category: { select: categorySelection },
        examples: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      },
    });
    await audit.recordAudit({
      actor,
      action: "BOT_INTENT_CREATED",
      entityType: "BOT",
      entityId: bot.id,
      summary: `Criou a intenção ${intent.name} no Bot ${bot.name}`,
      details: { intentId: intent.id, name: intent.name },
    }, transaction);
    return intent;
  });
}

async function ensureIntent(botId, intentId) {
  await ensureBot(botId);
  const intent = await prisma.botIntent.findFirst({ where: { id: intentId, botId } });
  if (!intent) throw fail("Intenção não encontrada.", 404);
  return intent;
}

async function updateIntent(botId, intentId, data, actor) {
  assertBotManager(actor);
  const existing = await ensureIntent(botId, intentId);
  const { input, examples } = await intentInput(data, { partial: true, existing });
  if (!Object.keys(input).length && examples === undefined) throw fail("Informe ao menos um campo para atualizar.");

  return prisma.$transaction(async (transaction) => {
    if (examples !== undefined) {
      await transaction.botIntentExample.deleteMany({ where: { intentId } });
    }
    const intent = await transaction.botIntent.update({
      where: { id: intentId },
      data: {
        ...input,
        ...(examples !== undefined ? { examples: { create: examples.map((text) => ({ text })) } } : {}),
      },
      include: {
        category: { select: categorySelection },
        examples: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      },
    });
    const bot = await transaction.bot.findUnique({ where: { id: botId }, select: { name: true } });
    await audit.recordAudit({
      actor,
      action: "BOT_INTENT_UPDATED",
      entityType: "BOT",
      entityId: botId,
      summary: `Alterou a intenção ${intent.name} no Bot ${bot.name}`,
      details: { intentId: intent.id, before: { name: existing.name }, after: { name: intent.name } },
    }, transaction);
    return intent;
  });
}

async function deleteIntent(botId, intentId, actor) {
  assertBotManager(actor);
  const existing = await ensureIntent(botId, intentId);
  return prisma.$transaction(async (transaction) => {
    await transaction.botIntent.delete({ where: { id: intentId } });
    const bot = await transaction.bot.findUnique({ where: { id: botId }, select: { name: true } });
    await audit.recordAudit({
      actor,
      action: "BOT_INTENT_DELETED",
      entityType: "BOT",
      entityId: botId,
      summary: `Removeu a intenção ${existing.name} do Bot ${bot.name}`,
      details: { intentId, name: existing.name },
    }, transaction);
    return { deleted: true };
  });
}

function normalizeJsonField(value, fallback) {
  return value && typeof value === "object" ? value : fallback;
}

// Fluxo de atendimento (item 7 - UI): CRUD das etapas de uma intenção.
// Mesma permissão (Master) e mesma checagem de posse (ensureIntent confirma
// que a intenção pertence a este Bot) usadas no resto do módulo de intenções.
async function listFlowSteps(botId, intentId, actor) {
  assertBotManager(actor);
  await ensureIntent(botId, intentId);
  return flowEngine.listFlowSteps(intentId);
}

async function createFlowStep(botId, intentId, data, actor) {
  assertBotManager(actor);
  const intent = await ensureIntent(botId, intentId);
  const step = await flowEngine.createFlowStep(intentId, data);
  await audit.recordAudit({
    actor, action: "BOT_FLOW_STEP_CREATED", entityType: "BOT", entityId: botId,
    summary: `Criou a etapa "${step.name}" no fluxo da intenção ${intent.name}`,
    details: { intentId, stepId: step.id, name: step.name, action: step.action },
  });
  return step;
}

async function updateFlowStep(botId, intentId, stepId, data, actor) {
  assertBotManager(actor);
  const intent = await ensureIntent(botId, intentId);
  const existing = await prisma.botFlowStep.findFirst({ where: { id: stepId, intentId }, select: { id: true, name: true } });
  if (!existing) throw fail("Etapa não encontrada.", 404);
  const step = await flowEngine.updateFlowStep(stepId, data);
  await audit.recordAudit({
    actor, action: "BOT_FLOW_STEP_UPDATED", entityType: "BOT", entityId: botId,
    summary: `Alterou a etapa "${step.name}" no fluxo da intenção ${intent.name}`,
    details: { intentId, stepId, before: { name: existing.name }, after: { name: step.name } },
  });
  return step;
}

async function deleteFlowStep(botId, intentId, stepId, actor) {
  assertBotManager(actor);
  const intent = await ensureIntent(botId, intentId);
  const existing = await prisma.botFlowStep.findFirst({ where: { id: stepId, intentId }, select: { id: true, name: true } });
  if (!existing) throw fail("Etapa não encontrada.", 404);
  const result = await flowEngine.deleteFlowStep(stepId);
  await audit.recordAudit({
    actor, action: "BOT_FLOW_STEP_DELETED", entityType: "BOT", entityId: botId,
    summary: `Removeu a etapa "${existing.name}" do fluxo da intenção ${intent.name}`,
    details: { intentId, stepId },
  });
  return result;
}

async function reorderFlowSteps(botId, intentId, orderedStepIds, actor) {
  assertBotManager(actor);
  await ensureIntent(botId, intentId);
  if (!Array.isArray(orderedStepIds) || !orderedStepIds.length) throw fail("Informe a ordem das etapas.");
  return flowEngine.reorderFlowSteps(intentId, orderedStepIds);
}

function normalizeSimulatorState(state) {
  if (!state || typeof state !== "object") return null;
  return {
    activeBotId: typeof state.activeBotId === "string" ? state.activeBotId : null,
    lastIntentId: typeof state.lastIntentId === "string" ? state.lastIntentId : null,
    lastConfidence: Number.isFinite(state.lastConfidence)
      ? Math.min(1, Math.max(0, state.lastConfidence)) : null,
    failedInterpretations: Number.isInteger(state.failedInterpretations)
      ? Math.min(MAX_FAILED_INTERPRETATIONS, Math.max(0, state.failedInterpretations)) : 0,
    pendingClarification: Boolean(state.pendingClarification),
    extractedEntities: state.extractedEntities && typeof state.extractedEntities === "object" ? state.extractedEntities : {},
    // Item 8 (Simulador): o Flow Engine roda pelo mesmo pipeline de uma
    // conversa real (bot-orchestrator-service.js), então o estado de fluxo
    // também precisa ir e voltar pelo cliente, igual ao restante do estado.
    activeFlowIntentId: typeof state.activeFlowIntentId === "string" ? state.activeFlowIntentId : null,
    currentFlowStepId: typeof state.currentFlowStepId === "string" ? state.currentFlowStepId : null,
    flowCollectedEntities: normalizeJsonField(state.flowCollectedEntities, {}),
    flowAskedQuestions: Array.isArray(state.flowAskedQuestions) ? state.flowAskedQuestions : [],
    flowAttemptedSolutions: Array.isArray(state.flowAttemptedSolutions) ? state.flowAttemptedSolutions : [],
    flowFailedSteps: Array.isArray(state.flowFailedSteps) ? state.flowFailedSteps : [],
    flowStepAttempts: normalizeJsonField(state.flowStepAttempts, {}),
    flowResolutionStatus: typeof state.flowResolutionStatus === "string" ? state.flowResolutionStatus : null,
  };
}

function normalizeSimulatorHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((entry) => entry && typeof entry.text === "string")
    .slice(-CONTEXT_MESSAGE_LIMIT)
    .map((entry) => ({
      direction: entry.direction === "ENVIADA" ? "ENVIADA" : "RECEBIDA",
      text: entry.text.slice(0, 4000),
    }));
}

// Simulador multi-turno: nunca usa o canal real da Meta nem toca em
// Conversation/ConversationBotState. O "estado" e o "histórico" trafegam
// inteiramente pelo cliente (tela de Bots), que os devolve a cada chamada.
async function simulate(botId, message, viewer, { state, history, replyId } = {}) {
  assertBotManager(viewer);
  const bot = await ensureBot(botId, prisma, botInclude);
  // O Bot de Triagem não usa o motor de intenções/IA (é lista fixa de
  // setores) — o simulador dele espelha handleIncomingTriage em vez de
  // simulateOrchestration. Ver triage-bot-service.simulateTriage.
  if (bot.type === "SYSTEM_TRIAGE") {
    return simulateTriage(bot, { message, replyId });
  }
  const simulatorMessage = requiredText(message, "Mensagem da simulação", 4000);
  const result = await simulateOrchestration({
    bot,
    message: simulatorMessage,
    context: normalizeSimulatorHistory(history),
    state: normalizeSimulatorState(state),
  });
  return { ...result, simulation: true, sent: false, warning: "Simulação - nenhuma mensagem foi enviada" };
}

async function listObservations(filters, viewer) {
  assertBotManager(viewer);
  const where = {};
  if (filters.botId) where.botId = filters.botId;
  if (filters.intentId) where.intentId = filters.intentId;
  if (filters.intentName) where.intentName = { contains: filters.intentName, mode: "insensitive" };
  if (filters.minConfidence !== undefined && filters.minConfidence !== "") {
    const minConfidence = Number(filters.minConfidence);
    if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      throw fail("A confiança mínima deve estar entre 0 e 1.");
    }
    where.confidence = { gte: minConfidence };
  }
  if (filters.from || filters.to) {
    const from = filters.from ? new Date(filters.from) : null;
    const to = filters.to ? new Date(filters.to) : null;
    if (from && Number.isNaN(from.getTime())) throw fail("Data inicial inválida.");
    if (to && Number.isNaN(to.getTime())) throw fail("Data final inválida.");
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(filters.to)) to.setUTCHours(23, 59, 59, 999);
    if (from && to && from > to) throw fail("A data inicial deve ser anterior à data final.");
    where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }
  const take = filters.limit === undefined || filters.limit === "" ? 50 : Number(filters.limit);
  if (!Number.isInteger(take) || take < 1 || take > 200) {
    throw fail("O limite de observações deve ser um inteiro entre 1 e 200.");
  }
  const rows = await prisma.botObservation.findMany({
    where,
    include: {
      conversation: { include: { contact: { select: { name: true, customName: true, phone: true } } } },
      message: { select: { text: true, occurredAt: true } },
    },
    orderBy: { createdAt: "desc" },
    take,
  });
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    conversationId: row.conversationId,
    contact: row.conversation?.contact
      ? (row.conversation.contact.customName || row.conversation.contact.name || row.conversation.contact.phone)
      : null,
    message: row.message?.text || null,
    botId: row.botId,
    botName: row.botName,
    intentId: row.intentId,
    intentName: row.intentName,
    socialBehavior: row.socialBehavior,
    confidence: row.confidence,
    action: row.action,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    provider: row.provider,
    status: row.status,
    errorCode: row.errorCode,
    extractedEntities: row.extractedEntities,
    feedback: row.feedback,
    feedbackIntentId: row.feedbackIntentId,
  }));
}

// Métricas simples da tela de Observações (req. "não mostrar percentual
// enganoso de precisão" quando ainda há pouco feedback humano registrado).
async function observationMetrics(viewer) {
  assertBotManager(viewer);
  const [total, high, medium, low, correct, incorrect, noIntent, humanRequests] = await Promise.all([
    prisma.botObservation.count(),
    prisma.botObservation.count({ where: { confidence: { gte: DEFAULT_HIGH_CONFIDENCE_THRESHOLD } } }),
    prisma.botObservation.count({ where: { confidence: { gte: DEFAULT_LOW_CONFIDENCE_THRESHOLD, lt: DEFAULT_HIGH_CONFIDENCE_THRESHOLD } } }),
    prisma.botObservation.count({ where: { OR: [{ confidence: { lt: DEFAULT_LOW_CONFIDENCE_THRESHOLD } }, { confidence: null }] } }),
    prisma.botObservation.count({ where: { feedback: "CORRECT" } }),
    prisma.botObservation.count({ where: { feedback: "INCORRECT" } }),
    prisma.botObservation.count({ where: { intentId: null } }),
    prisma.botObservation.count({ where: { socialBehavior: "HUMAN_REQUEST" } }),
  ]);
  const reviewed = correct + incorrect;
  return {
    total, highConfidence: high, mediumConfidence: medium, lowConfidence: low,
    correct, incorrect, reviewed,
    accuracy: reviewed >= 5 ? correct / reviewed : null,
    noIntent, humanRequests,
  };
}

// Feedback humano sobre uma observação (nunca sobre a conversa real).
// Quando incorreta + intenção correta informada, opcionalmente vira uma
// sugestão de aprendizado (mesma trilha de aprovação humana de sempre).
async function recordObservationFeedback(observationId, data, actor) {
  assertBotManager(actor);
  const observation = await prisma.botObservation.findUnique({ where: { id: observationId } });
  if (!observation) throw fail("Observação não encontrada.", 404);
  if (!observationFeedbackValues.has(data.feedback)) {
    throw fail("Informe se a observação estava correta ou incorreta.");
  }

  let correctedIntentId = null;
  if (data.feedback === "INCORRECT" && data.correctedIntentId) {
    const intent = await prisma.botIntent.findFirst({
      where: { id: data.correctedIntentId, ...(observation.botId ? { botId: observation.botId } : {}) },
    });
    if (!intent) throw fail("Intenção correta não encontrada para este Bot.");
    correctedIntentId = intent.id;
  }

  const updated = await prisma.botObservation.update({
    where: { id: observationId },
    data: {
      feedback: data.feedback, feedbackIntentId: correctedIntentId,
      feedbackByUserId: actor.id, feedbackAt: new Date(),
    },
  });

  if (data.addAsExample && correctedIntentId) {
    const message = await prisma.message.findUnique({ where: { id: observation.messageId }, select: { text: true } });
    if (message?.text) {
      await learning.createSuggestionFromObservationFeedback({
        observationMessageText: message.text, botId: observation.botId, intentId: correctedIntentId,
        conversationId: observation.conversationId,
      });
    }
  }

  return updated;
}

const INTENT_CONFLICT_THRESHOLD = 0.5;

// Análise auxiliar (#10): compara nome+descrição+exemplos de cada par de
// intenções ativas com o mesmo comparador usado pelo LocalFallbackProvider
// — sem duplicar lógica de similaridade. Só avisa, nunca bloqueia.
async function listIntentConflicts(botId, viewer) {
  assertBotManager(viewer);
  const bot = await ensureBot(botId, prisma, botInclude);
  const intents = (bot.intents || []).filter((intent) => intent.active);
  const conflicts = [];
  for (let i = 0; i < intents.length; i += 1) {
    for (let j = i + 1; j < intents.length; j += 1) {
      const a = intents[i]; const b = intents[j];
      const textA = normalizeText(`${a.name} ${a.description || ""} ${(a.examples || []).map((example) => example.text).join(" ")}`);
      const textB = normalizeText(`${b.name} ${b.description || ""} ${(b.examples || []).map((example) => example.text).join(" ")}`);
      const score = similarity(textA, textB);
      if (score >= INTENT_CONFLICT_THRESHOLD) {
        conflicts.push({
          intentAId: a.id, intentAName: a.name, intentBId: b.id, intentBName: b.name,
          similarity: Number(score.toFixed(2)),
          reason: "Nome, descrição e/ou exemplos muito parecidos entre as duas intenções.",
        });
      }
    }
  }
  return conflicts.sort((left, right) => right.similarity - left.similarity);
}

// Métricas por intenção (#41): usa BotObservation (diagnóstico do
// interpretador) e BotRating (sinal real, quando existir) — nunca mistura
// os dois como se fossem a mesma coisa.
async function intentMetrics(botId, viewer) {
  assertBotManager(viewer);
  await ensureBot(botId);
  const [observed, handoffs, ratings, intents] = await Promise.all([
    prisma.botObservation.groupBy({ by: ["intentId"], where: { botId, intentId: { not: null } }, _count: { _all: true }, _avg: { confidence: true } }),
    prisma.botObservation.groupBy({ by: ["intentId"], where: { botId, intentId: { not: null }, action: "HANDOFF_HUMAN" }, _count: { _all: true } }),
    prisma.botRating.groupBy({ by: ["intentId"], where: { botId, intentId: { not: null } }, _count: { _all: true }, _avg: { score: true } }),
    prisma.botIntent.findMany({ where: { botId }, select: { id: true, name: true } }),
  ]);
  const handoffMap = new Map(handoffs.map((row) => [row.intentId, row._count._all]));
  const ratingMap = new Map(ratings.map((row) => [row.intentId, { count: row._count._all, avg: row._avg.score }]));
  const nameMap = new Map(intents.map((intent) => [intent.id, intent.name]));
  return observed.map((row) => ({
    intentId: row.intentId,
    intentName: nameMap.get(row.intentId) || "Intenção removida",
    triggeredCount: row._count._all,
    averageConfidence: row._avg.confidence != null ? Number(row._avg.confidence.toFixed(2)) : null,
    handoffCount: handoffMap.get(row.intentId) || 0,
    ratingsCount: ratingMap.get(row.intentId)?.count || 0,
    averageRating: ratingMap.get(row.intentId)?.avg != null ? Number(ratingMap.get(row.intentId).avg.toFixed(2)) : null,
  })).sort((left, right) => right.triggeredCount - left.triggeredCount);
}

module.exports = {
  archiveBot,
  assertBotManager,
  createBot,
  createIntent,
  deleteIntent,
  getBot,
  intentMetrics,
  listAllIntents,
  listBots,
  listIntentConflicts,
  listObservations,
  observationMetrics,
  recordObservationFeedback,
  replaceSchedules,
  replaceHolidays,
  replaceTriageOptions,
  simulate,
  updateBot,
  updateBotStatus,
  updateIntent,
  validateSchedules,
  validateHolidays,
  // Fluxo de atendimento (Flow Engine).
  listFlowSteps,
  createFlowStep,
  updateFlowStep,
  deleteFlowStep,
  reorderFlowSteps,
};
