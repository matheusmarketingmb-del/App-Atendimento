// Chave-mestra de "novos canais" (item 34) — controla só os canais fora do
// Meta/WhatsApp. Nunca deve existir um caminho que desative Meta por aqui.
const prisma = require("../../database/prisma");
const authorization = require("../authorization-service");
const audit = require("../audit-service");
const { NEW_CHANNELS, channelError } = require("./channel-constants");

const SINGLETON_ID = "singleton";

async function getGlobalSettings() {
  return prisma.integrationGlobalSettings.upsert({
    where: { id: SINGLETON_ID },
    update: {},
    create: { id: SINGLETON_ID },
  });
}

async function getGlobalSettingsForManager(viewer) {
  if (!authorization.isMaster(viewer)) {
    throw authorization.forbidden("Somente uma conta Master pode consultar essa configuração.");
  }
  return getGlobalSettings();
}

async function assertNewChannelEnabled(channel) {
  if (!NEW_CHANNELS.includes(channel)) return;
  const settings = await getGlobalSettings();
  if (!settings.newChannelsEnabled) {
    throw channelError("NOT_SUPPORTED", "Integrações de novos canais estão desativadas globalmente.", { statusCode: 503 });
  }
}

async function setNewChannelsEnabled(enabled, actor) {
  if (!authorization.isMaster(actor)) {
    throw authorization.forbidden("Somente uma conta Master pode alterar essa configuração.");
  }
  if (typeof enabled !== "boolean") {
    throw Object.assign(new Error("enabled deve ser verdadeiro ou falso."), { statusCode: 400 });
  }
  const settings = await prisma.integrationGlobalSettings.upsert({
    where: { id: SINGLETON_ID },
    update: { newChannelsEnabled: enabled },
    create: { id: SINGLETON_ID, newChannelsEnabled: enabled },
  });
  await audit.recordAudit({
    actor, action: enabled ? "NEW_CHANNELS_ENABLED" : "NEW_CHANNELS_DISABLED", entityType: "INTEGRATION", entityId: SINGLETON_ID,
    summary: `${enabled ? "Ativou" : "Desativou"} globalmente os novos canais de integração (Meta/WhatsApp não é afetado).`,
  });
  return settings;
}

// Flags do módulo Social (item 26 do plano) — todas OFF por padrão. Cada
// uma controla um tipo de auto-reply distinto (DM x comentário público);
// socialAutoReplyEnabled é a chave-mestra do grupo (ver
// isSocialAutoReplyAllowed abaixo). Nunca confundir com newChannelsEnabled,
// que só controla se o canal recebe/envia mensagem nenhuma.
const SOCIAL_REPLY_FLAG_KEYS = Object.freeze([
  "socialAutoReplyEnabled", "socialCommentAutoReplyEnabled", "socialPrivateAutoReplyEnabled",
]);

async function setSocialReplyFlags(flags, actor) {
  if (!authorization.isMaster(actor)) {
    throw authorization.forbidden("Somente uma conta Master pode alterar essa configuração.");
  }
  const data = {};
  for (const key of SOCIAL_REPLY_FLAG_KEYS) {
    if (!(key in flags)) continue;
    if (typeof flags[key] !== "boolean") {
      throw Object.assign(new Error(`${key} deve ser verdadeiro ou falso.`), { statusCode: 400 });
    }
    data[key] = flags[key];
  }
  if (!Object.keys(data).length) {
    throw Object.assign(new Error("Nenhuma flag social válida informada."), { statusCode: 400 });
  }
  const settings = await prisma.integrationGlobalSettings.upsert({
    where: { id: SINGLETON_ID }, update: data, create: { id: SINGLETON_ID, ...data },
  });
  await audit.recordAudit({
    actor, action: "SOCIAL_REPLY_FLAGS_CHANGED", entityType: "INTEGRATION", entityId: SINGLETON_ID,
    summary: `Alterou flags de auto-reply social: ${Object.entries(data).map(([key, value]) => `${key}=${value}`).join(", ")}.`,
  });
  return settings;
}

// Auto-reply de comentário/DM social só é permitido com a chave-mestra E a
// flag específica do tipo de interação ambas ligadas (item 26/48 do plano —
// nunca ambíguo, nunca ligado por omissão).
async function isSocialAutoReplyAllowed(kind) {
  const settings = await getGlobalSettings();
  if (!settings.socialAutoReplyEnabled) return false;
  if (kind === "COMMENT") return Boolean(settings.socialCommentAutoReplyEnabled);
  if (kind === "PRIVATE") return Boolean(settings.socialPrivateAutoReplyEnabled);
  return false;
}

module.exports = {
  assertNewChannelEnabled, getGlobalSettings, getGlobalSettingsForManager, isSocialAutoReplyAllowed,
  setNewChannelsEnabled, setSocialReplyFlags,
};
