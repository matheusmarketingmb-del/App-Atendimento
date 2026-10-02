// Governança do motor de Bots: feature flags por Bot (validadas/tipadas,
// nunca strings soltas), permissões de Tools, apresentação por nome, e a
// configuração global (inclui o kill switch "Automação de Bots").
//
// PRINCÍPIO: implementar não significa ativar. Todo toggle aqui tem um
// default seguro e nada muda o comportamento de um Bot já existente até que
// um Master mude a configuração explicitamente.
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const audit = require("./audit-service");
const {
  BOOLEAN_FEATURE_FLAG_KEYS, DEFAULT_PRESENTATION_MESSAGE, ENUM_FEATURE_FLAG_KEYS, FEATURE_FLAG_DEFAULTS,
  FLOAT_FEATURE_FLAG_RANGES, FREE_TEXT_FEATURE_FLAG_KEYS, NUMERIC_FEATURE_FLAG_RANGES, PRESENTATION_ALLOWED_VARS,
  RATING_REQUEST_MODES,
} = require("./bot-constants");

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function assertBotManager(viewer) {
  if (!authorization.isMaster(viewer)) {
    throw authorization.forbidden("Somente uma conta Master pode gerenciar Bots.");
  }
}

// Mescla os defaults com o que estiver salvo — assim um Bot antigo (JSON
// vazio) automaticamente herda os defaults novos sem precisar de backfill.
function resolveFeatureFlags(bot) {
  const stored = bot?.featureFlags && typeof bot.featureFlags === "object" ? bot.featureFlags : {};
  return { ...FEATURE_FLAG_DEFAULTS, ...stored };
}

function resolveToolPermissions(bot) {
  const stored = bot?.toolPermissions && typeof bot.toolPermissions === "object" ? bot.toolPermissions : {};
  const { listTools } = require("./bot-tools/tool-registry");
  const permissions = {};
  for (const tool of listTools()) permissions[tool.name] = Boolean(stored[tool.name]);
  return permissions;
}

// Valida e normaliza o JSON de featureFlags recebido do formulário. Rejeita
// qualquer chave desconhecida e qualquer valor fora do tipo/faixa esperados.
function validateFeatureFlagsInput(input) {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("Recursos do Bot inválidos.");
  const result = {};
  for (const key of BOOLEAN_FEATURE_FLAG_KEYS) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") throw fail(`O recurso "${key}" deve ser verdadeiro ou falso.`);
    result[key] = input[key];
  }
  for (const [key, range] of Object.entries(NUMERIC_FEATURE_FLAG_RANGES)) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < range.min || value > range.max) {
      throw fail(`O valor de "${key}" deve ser um inteiro entre ${range.min} e ${range.max}.`);
    }
    result[key] = value;
  }
  for (const [key, range] of Object.entries(FLOAT_FEATURE_FLAG_RANGES)) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < range.min || value > range.max) {
      throw fail(`O valor de "${key}" deve ser um número entre ${range.min} e ${range.max}.`);
    }
    result[key] = value;
  }
  for (const [key, allowed] of Object.entries(ENUM_FEATURE_FLAG_KEYS)) {
    if (input[key] === undefined) continue;
    if (!allowed.includes(input[key])) throw fail(`"${key}" deve ser um dos valores: ${allowed.join(", ")}.`);
    result[key] = input[key];
  }
  for (const [key, { maxLength }] of Object.entries(FREE_TEXT_FEATURE_FLAG_KEYS)) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "string") throw fail(`"${key}" deve ser um texto.`);
    result[key] = input[key].trim().slice(0, maxLength);
  }
  return result;
}

function validateToolPermissionsInput(input) {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("Permissões de Tools inválidas.");
  const { listTools } = require("./bot-tools/tool-registry");
  const validNames = new Set(listTools().map((tool) => tool.name));
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (!validNames.has(key)) continue;
    if (typeof value !== "boolean") throw fail(`A permissão da Tool "${key}" deve ser verdadeira ou falsa.`);
    result[key] = value;
  }
  return result;
}

function validateRequestRatingOn(value) {
  if (value === undefined) return undefined;
  if (!RATING_REQUEST_MODES.includes(value)) throw fail("Momento de solicitar avaliação inválido.");
  return value;
}

// Substituição segura: só aceita {{botName}}. Qualquer outro `{{...}}` é
// removido em vez de interpretado, para nunca virar um template arbitrário.
function renderPresentationMessage(template, { botName }) {
  const source = (typeof template === "string" && template.trim()) ? template : DEFAULT_PRESENTATION_MESSAGE;
  return source.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, name) => (
    PRESENTATION_ALLOWED_VARS.includes(name) && name === "botName" ? botName : ""
  ));
}

const GLOBAL_SETTINGS_ID = "singleton";

async function getGlobalSettings(client = prisma) {
  return client.botGlobalSettings.upsert({
    where: { id: GLOBAL_SETTINGS_ID }, update: {}, create: { id: GLOBAL_SETTINGS_ID },
  });
}

async function getGlobalSettingsForManager(viewer) {
  assertBotManager(viewer);
  return getGlobalSettings();
}

async function updateGlobalSettings(data, actor) {
  assertBotManager(actor);
  const update = {};
  for (const key of ["observationEnabled", "learningEnabled", "ratingsEnabled", "rankingEnabled", "intentLibraryEnabled"]) {
    if (data[key] !== undefined) {
      if (typeof data[key] !== "boolean") throw fail(`"${key}" deve ser verdadeiro ou falso.`);
      update[key] = data[key];
    }
  }
  if (data.minimumRatingsForRanking !== undefined) {
    const value = Number(data.minimumRatingsForRanking);
    if (!Number.isInteger(value) || value < 1 || value > 10000) {
      throw fail("A amostra mínima para ranking deve ser um inteiro entre 1 e 10000.");
    }
    update.minimumRatingsForRanking = value;
  }
  // O master switch de automação só é alterado pelo kill switch dedicado
  // (activateAutomation/deactivateAutomation), nunca por este PATCH genérico
  // — evita desligar automação "sem querer" junto de outro ajuste.
  if (!Object.keys(update).length) throw fail("Informe ao menos um campo para atualizar.");

  const before = await getGlobalSettings();
  const settings = await prisma.botGlobalSettings.update({ where: { id: GLOBAL_SETTINGS_ID }, data: update });
  await audit.recordAudit({
    actor, action: "BOT_GLOBAL_SETTINGS_UPDATED", entityType: "BOT", entityId: null,
    summary: "Atualizou as configurações globais de Bots",
    details: { before, after: settings },
  });
  return settings;
}

// Kill switch: desliga IMEDIATAMENTE toda automação (resposta automática e
// Tools) sem afetar recebimento de mensagens, triagem, atendimento humano ou
// dados/configuração salvos. Observação/Aprendizado têm toggle próprio e
// continuam funcionando se estiverem ligados (são passivos).
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
  return settings;
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
  return settings;
}

module.exports = {
  assertBotManager,
  deactivateAutomation,
  fail,
  getGlobalSettings,
  getGlobalSettingsForManager,
  reactivateAutomation,
  renderPresentationMessage,
  resolveFeatureFlags,
  resolveToolPermissions,
  updateGlobalSettings,
  validateFeatureFlagsInput,
  validateRequestRatingOn,
  validateToolPermissionsInput,
};
