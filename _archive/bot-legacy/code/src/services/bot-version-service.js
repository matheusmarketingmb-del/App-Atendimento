// Versionamento do Bot: snapshot completo (identidade, mensagens,
// thresholds, recursos, horários, intenções) criado sob demanda — nunca a
// cada edição. Restaurar cria uma versão NOVA a partir de uma antiga; nunca
// apaga histórico (rollback = "v13 baseada na v9", não "voltar para v9").
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const audit = require("./audit-service");

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function assertBotManager(viewer) {
  if (!authorization.isMaster(viewer)) {
    throw authorization.forbidden("Somente uma conta Master pode gerenciar Bots.");
  }
}

const snapshotBotInclude = {
  schedules: { orderBy: { dayOfWeek: "asc" } },
  intents: {
    include: { examples: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  },
};

async function ensureBot(botId, client = prisma) {
  const bot = await client.bot.findFirst({ where: { id: botId, archivedAt: null }, include: snapshotBotInclude });
  if (!bot) throw fail("Bot não encontrado.", 404);
  return bot;
}

function buildSnapshot(bot) {
  return {
    name: bot.name,
    description: bot.description,
    channel: bot.channel,
    timezone: bot.timezone,
    defaultCategoryId: bot.defaultCategoryId,
    highConfidenceThreshold: bot.highConfidenceThreshold,
    lowConfidenceThreshold: bot.lowConfidenceThreshold,
    initialMessage: bot.initialMessage,
    outsideHoursMessage: bot.outsideHoursMessage,
    fallbackMessage: bot.fallbackMessage,
    introduceWithName: bot.introduceWithName,
    presentationMessage: bot.presentationMessage,
    reintroduceOnNewSession: bot.reintroduceOnNewSession,
    autoReplyEnabled: bot.autoReplyEnabled,
    toolsEnabled: bot.toolsEnabled,
    ratingEnabled: bot.ratingEnabled,
    featureFlags: bot.featureFlags,
    toolPermissions: bot.toolPermissions,
    ratingMessage: bot.ratingMessage,
    ratingFollowupMessage: bot.ratingFollowupMessage,
    requestRatingOn: bot.requestRatingOn,
    requestRatingComment: bot.requestRatingComment,
    schedules: (bot.schedules || []).map((schedule) => ({
      dayOfWeek: schedule.dayOfWeek, enabled: schedule.enabled, startTime: schedule.startTime, endTime: schedule.endTime,
    })),
    intents: (bot.intents || []).map((intent) => ({
      name: intent.name, description: intent.description, responseMessage: intent.responseMessage,
      priority: intent.priority, active: intent.active, fallbackAction: intent.fallbackAction,
      categoryId: intent.categoryId, examples: (intent.examples || []).map((example) => example.text),
    })),
  };
}

async function nextVersionNumber(botId, client) {
  const last = await client.botVersion.findFirst({ where: { botId }, orderBy: { version: "desc" }, select: { version: true } });
  return (last?.version || 0) + 1;
}

async function createVersion(botId, { label, description } = {}, actor) {
  assertBotManager(actor);
  const bot = await ensureBot(botId);
  const version = await nextVersionNumber(botId, prisma);
  const snapshot = buildSnapshot(bot);
  const created = await prisma.$transaction(async (transaction) => {
    const row = await transaction.botVersion.create({
      data: {
        botId, version, label: label?.trim().slice(0, 100) || null, description: description?.trim().slice(0, 500) || null,
        snapshot, createdByUserId: actor.id, createdByName: actor.name || null,
      },
    });
    await audit.recordAudit({
      actor, action: "BOT_VERSION_CREATED", entityType: "BOT", entityId: botId,
      summary: `Salvou a versão v${version} do Bot ${bot.name}${label ? ` (${label})` : ""}`,
      details: { version, label: label || null },
    }, transaction);
    return row;
  });
  return created;
}

async function listVersions(botId, viewer) {
  assertBotManager(viewer);
  await ensureBot(botId);
  return prisma.botVersion.findMany({ where: { botId }, orderBy: { version: "desc" } });
}

async function ensureVersion(botId, version) {
  const row = await prisma.botVersion.findUnique({ where: { botId_version: { botId, version: Number(version) } } });
  if (!row) throw fail("Versão não encontrada.", 404);
  return row;
}

// Mostra o que mudaria antes de restaurar de fato — usado pela UI para
// "mostrar o que será alterado" antes de confirmar.
async function previewRestore(botId, version, viewer) {
  assertBotManager(viewer);
  const bot = await ensureBot(botId);
  const target = await ensureVersion(botId, version);
  return { current: buildSnapshot(bot), target: target.snapshot, targetVersion: target.version, targetLabel: target.label };
}

async function restoreVersion(botId, version, { label } = {}, actor) {
  assertBotManager(actor);
  const bot = await ensureBot(botId);
  const target = await ensureVersion(botId, version);
  const snapshot = target.snapshot;

  const result = await prisma.$transaction(async (transaction) => {
    await transaction.bot.update({
      where: { id: botId },
      data: {
        name: snapshot.name, description: snapshot.description, channel: snapshot.channel, timezone: snapshot.timezone,
        defaultCategoryId: snapshot.defaultCategoryId, highConfidenceThreshold: snapshot.highConfidenceThreshold,
        lowConfidenceThreshold: snapshot.lowConfidenceThreshold, initialMessage: snapshot.initialMessage,
        outsideHoursMessage: snapshot.outsideHoursMessage, fallbackMessage: snapshot.fallbackMessage,
        introduceWithName: snapshot.introduceWithName, presentationMessage: snapshot.presentationMessage,
        reintroduceOnNewSession: snapshot.reintroduceOnNewSession, autoReplyEnabled: snapshot.autoReplyEnabled,
        toolsEnabled: snapshot.toolsEnabled, ratingEnabled: snapshot.ratingEnabled, featureFlags: snapshot.featureFlags,
        toolPermissions: snapshot.toolPermissions, ratingMessage: snapshot.ratingMessage,
        ratingFollowupMessage: snapshot.ratingFollowupMessage, requestRatingOn: snapshot.requestRatingOn,
        requestRatingComment: snapshot.requestRatingComment,
      },
    });

    await transaction.botSchedule.deleteMany({ where: { botId } });
    if (snapshot.schedules?.length) {
      await transaction.botSchedule.createMany({ data: snapshot.schedules.map((schedule) => ({ ...schedule, botId })) });
    }

    await transaction.botIntent.deleteMany({ where: { botId } });
    for (const intent of snapshot.intents || []) {
      await transaction.botIntent.create({
        data: {
          botId, name: intent.name, description: intent.description, responseMessage: intent.responseMessage,
          priority: intent.priority, active: intent.active, fallbackAction: intent.fallbackAction,
          categoryId: intent.categoryId, examples: { create: (intent.examples || []).map((text) => ({ text })) },
        },
      });
    }

    const newVersionNumber = await nextVersionNumber(botId, transaction);
    const newVersion = await transaction.botVersion.create({
      data: {
        botId, version: newVersionNumber,
        label: label?.trim().slice(0, 100) || `Restaurado da v${target.version}`,
        description: `Rollback: conteúdo idêntico à v${target.version}.`,
        snapshot, restoredFromVersion: target.version, createdByUserId: actor.id, createdByName: actor.name || null,
      },
    });

    await audit.recordAudit({
      actor, action: "BOT_VERSION_RESTORED", entityType: "BOT", entityId: botId,
      summary: `Restaurou o Bot ${bot.name} a partir da v${target.version} (nova v${newVersionNumber})`,
      details: { fromVersion: target.version, newVersion: newVersionNumber },
    }, transaction);

    return newVersion;
  });

  return result;
}

module.exports = { assertBotManager, buildSnapshot, createVersion, listVersions, previewRestore, restoreVersion };
