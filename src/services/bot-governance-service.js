// Governança dos Bots (Flow Builder): permissão de gestão (só Master) e a
// configuração global com o kill switch "Automação de Bots".
//
// A versão anterior (feature flags de IA, permissões de Tools, apresentação
// por nome, observação/aprendizado/ranking) foi arquivada em
// _archive/bot-legacy/ — as colunas correspondentes de BotGlobalSettings
// continuam no banco, só não são mais lidas.
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const audit = require("./audit-service");

const GLOBAL_SETTINGS_ID = "singleton";

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function assertBotManager(viewer) {
  if (!authorization.isMaster(viewer)) {
    throw authorization.forbidden("Somente uma conta Master pode gerenciar Bots.");
  }
}

async function getGlobalSettings(client = prisma) {
  return client.botGlobalSettings.upsert({
    where: { id: GLOBAL_SETTINGS_ID }, update: {}, create: { id: GLOBAL_SETTINGS_ID },
  });
}

function publicSettings(settings) {
  return {
    automationEnabled: settings.automationEnabled,
    killSwitchActivatedAt: settings.killSwitchActivatedAt,
    updatedAt: settings.updatedAt,
  };
}

async function getGlobalSettingsForManager(viewer) {
  assertBotManager(viewer);
  return publicSettings(await getGlobalSettings());
}

// Kill switch: desliga IMEDIATAMENTE toda resposta automática de todos os
// Bots, sem afetar recebimento de mensagens, atendimento humano ou dados.
async function deactivateAutomation(actor) {
  assertBotManager(actor);
  await getGlobalSettings();
  const settings = await prisma.botGlobalSettings.update({
    where: { id: GLOBAL_SETTINGS_ID },
    data: { automationEnabled: false, killSwitchActivatedAt: new Date(), killSwitchActivatedByUserId: actor.id },
  });
  await audit.recordAudit({
    actor, action: "BOT_KILL_SWITCH_ACTIVATED", entityType: "BOT", entityId: null,
    summary: `${actor.name || "Uma conta Master"} desativou a automação dos Bots (kill switch)`,
  });
  return publicSettings(settings);
}

async function reactivateAutomation(actor) {
  assertBotManager(actor);
  await getGlobalSettings();
  const settings = await prisma.botGlobalSettings.update({
    where: { id: GLOBAL_SETTINGS_ID },
    data: { automationEnabled: true, killSwitchActivatedAt: null, killSwitchActivatedByUserId: null },
  });
  await audit.recordAudit({
    actor, action: "BOT_KILL_SWITCH_DEACTIVATED", entityType: "BOT", entityId: null,
    summary: `${actor.name || "Uma conta Master"} reativou a automação dos Bots`,
  });
  return publicSettings(settings);
}

module.exports = {
  assertBotManager, deactivateAutomation, fail, getGlobalSettings, getGlobalSettingsForManager, reactivateAutomation,
};
