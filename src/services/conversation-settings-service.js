// Configurações → Conversas — mesmo padrão de singleton já usado em
// campaign-settings-service.js (CampaignGlobalSettings). Fonte central de
// todos os prazos/flags de SLA, alertas, contexto do Bot e reabertura de
// conversa: nenhum outro service deve ter seu próprio número hardcoded.
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const audit = require("./audit-service");

const SETTINGS_ID = "singleton";

// Cache leve em memória (TTL curto) para as leituras de hot-path (por
// mensagem/tick de monitor) não baterem no banco a cada chamada. Invalidado
// explicitamente em updateConversationSettings.
const CACHE_TTL_MS = 5000;
let cache = null;
let cacheExpiresAt = 0;

function invalidateCache() {
  cache = null;
  cacheExpiresAt = 0;
  companyCache = null;
  companyCacheExpiresAt = 0;
}

// Multiempresa (item 39): uma empresa pode ter configuração PRÓPRIA completa
// (linha com companyId, criada como cópia da global na primeira edição);
// sem ela, vale a global ("singleton"). Remover o override volta à global.
let companyCache = null;
let companyCacheExpiresAt = 0;

async function companyOverrides(client = prisma) {
  if (client === prisma && companyCache && Date.now() < companyCacheExpiresAt) return companyCache;
  const rows = await client.conversationSettings.findMany({ where: { companyId: { not: null } } });
  const map = new Map(rows.map((row) => [row.companyId, row]));
  if (client === prisma) { companyCache = map; companyCacheExpiresAt = Date.now() + CACHE_TTL_MS; }
  return map;
}

// Configuração efetiva para uma conversa/empresa.
async function getConversationSettings(client = prisma, companyId = null) {
  if (companyId) {
    const override = (await companyOverrides(client)).get(companyId);
    if (override) return override;
  }
  return getGlobalConversationSettings(client);
}

// Plano para os monitores (SLA, finalização): cada empresa com override usa
// a dela; todas as outras conversas usam a global. `scope` é um filtro Prisma.
async function settingsPlan(client = prisma) {
  const overrides = await companyOverrides(client);
  const global = await getGlobalConversationSettings(client);
  const overrideIds = [...overrides.keys()];
  return [
    { settings: global, scope: overrideIds.length ? { companyId: { notIn: overrideIds } } : {} },
    ...[...overrides.values()].map((settings) => ({ settings, scope: { companyId: settings.companyId } })),
  ];
}

async function getGlobalConversationSettings(client = prisma) {
  if (client === prisma && cache && Date.now() < cacheExpiresAt) return cache;
  let settings;
  try {
    settings = await client.conversationSettings.upsert({
      where: { id: SETTINGS_ID }, update: {}, create: { id: SETTINGS_ID },
    });
  } catch (error) {
    // Dois monitores/processos podem tentar criar o singleton no mesmo
    // instante durante o primeiro boot. O vencedor já criou o registro;
    // o perdedor apenas relê, sem transformar essa corrida esperada em erro.
    if (error?.code !== "P2002") throw error;
    settings = await client.conversationSettings.findUnique({ where: { id: SETTINGS_ID } });
    if (!settings) throw error;
  }
  if (client === prisma) {
    cache = settings;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  }
  return settings;
}

async function resolveSettingsCompany(viewer, company) {
  if (!company || company === "ALL" || company === "GLOBAL") return null;
  const [companyId] = await require("./company-service").resolveCompanyFilter(viewer, company);
  return companyId;
}

// `company` (slug): mostra a configuração própria da empresa, ou a global
// marcada como herdada (isCompanyOverride=false).
async function getConversationSettingsForViewer(viewer, { company } = {}) {
  authorization.assertCanViewConversationSettings(viewer);
  const companyId = await resolveSettingsCompany(viewer, company);
  if (!companyId) return { ...(await getGlobalConversationSettings()), scope: "GLOBAL", isCompanyOverride: false };
  const override = (await companyOverrides()).get(companyId);
  return { ...(override || await getGlobalConversationSettings()), scope: "COMPANY", companyId, isCompanyOverride: Boolean(override) };
}

// Volta a empresa para a configuração global (remove só o override).
async function resetCompanyConversationSettings(company, actor) {
  authorization.assertMaster(actor);
  const companyId = await resolveSettingsCompany(actor, company);
  if (!companyId) throw fail("Informe a empresa.");
  const removed = await prisma.conversationSettings.deleteMany({ where: { companyId } });
  invalidateCache();
  await audit.recordAudit({
    actor, action: "CONVERSATION_SETTINGS_COMPANY_RESET", entityType: "CONVERSATION_SETTINGS", entityId: null, companyId,
    summary: "Empresa voltou a usar as configurações globais de Conversas", details: { removed: removed.count },
  });
  return getConversationSettingsForViewer(actor, { company });
}

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

const BOOLEAN_FIELDS = [
  "firstResponseSlaEnabled",
  "responseSlaEnabled",
  "unansweredConversationAlertEnabled",
  "stalledConversationAlertEnabled",
  "slaNearBreachAlertEnabled",
  "unassignedConversationAlertEnabled",
  "botResumeAfterHumanEnabled",
  "reopenConversationOnCustomerMessage",
  "slaBusinessHoursOnly",
  "autoFinalizationEnabled",
];

const MINUTES_FIELDS = {
  firstResponseSlaMinutes: { min: 1, max: 1440 },
  responseSlaMinutes: { min: 1, max: 1440 },
  unansweredConversationAlertMinutes: { min: 1, max: 1440 },
  stalledConversationAlertMinutes: { min: 1, max: 1440 },
  unassignedConversationAlertMinutes: { min: 1, max: 1440 },
  botContextTtlMinutes: { min: 1, max: 1440 },
  botResumeAfterHumanMinutes: { min: 1, max: 1440 },
  autoFinalizationMinutes: { min: 1, max: 1440 },
};

// Percentual (não minutos) — validação própria, mesma régua de erro claro.
function validateSlaNearBreachPercent(value, update) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 99) {
    throw fail('"slaNearBreachPercent" deve ser um inteiro entre 1 e 99.');
  }
  update.slaNearBreachPercent = numeric;
}

// Único campo minutos que é opcional/nulo (item 8 — janela de reabertura).
function validateReopenWindowMinutes(value, update) {
  if (value === null) {
    update.reopenWindowMinutes = null;
    return;
  }
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 43200) {
    throw fail('"reopenWindowMinutes" deve ser nulo ou um inteiro entre 1 e 43200.');
  }
  update.reopenWindowMinutes = numeric;
}

// Só Master edita — mesma régua de risco alto usada para Campanhas/Bots.
async function updateConversationSettings(data, actor) {
  authorization.assertMaster(actor);
  const update = {};

  for (const key of BOOLEAN_FIELDS) {
    if (data[key] === undefined) continue;
    if (typeof data[key] !== "boolean") throw fail(`"${key}" deve ser verdadeiro ou falso.`);
    update[key] = data[key];
  }

  for (const [key, range] of Object.entries(MINUTES_FIELDS)) {
    if (data[key] === undefined) continue;
    const value = Number(data[key]);
    if (!Number.isInteger(value) || value < range.min || value > range.max) {
      throw fail(`"${key}" deve ser um inteiro entre ${range.min} e ${range.max}.`);
    }
    update[key] = value;
  }

  if (data.reopenWindowMinutes !== undefined) {
    validateReopenWindowMinutes(data.reopenWindowMinutes, update);
  }

  if (data.slaNearBreachPercent !== undefined) {
    validateSlaNearBreachPercent(data.slaNearBreachPercent, update);
  }

  // Atendente fixo: texto curto do Bot ao redirecionar o cliente.
  if (data.preferredAssigneeRoutingMessage !== undefined) {
    const text = typeof data.preferredAssigneeRoutingMessage === "string" ? data.preferredAssigneeRoutingMessage.trim() : "";
    if (!text || text.length > 1000) throw fail('"preferredAssigneeRoutingMessage" deve ter entre 1 e 1000 caracteres.');
    update.preferredAssigneeRoutingMessage = text;
  }

  if (!Object.keys(update).length) throw fail("Informe ao menos um campo para atualizar.");

  const companyId = await resolveSettingsCompany(actor, data.company);
  if (companyId) {
    // Primeira edição da empresa: nasce como cópia da global + alterações.
    const existing = (await companyOverrides()).get(companyId);
    const { id: _id, companyId: _companyId, createdAt: _createdAt, updatedAt: _updatedAt, ...globalValues } = await getGlobalConversationSettings();
    const settings = existing
      ? await prisma.conversationSettings.update({ where: { id: existing.id }, data: update })
      : await prisma.conversationSettings.create({ data: { ...globalValues, ...update, id: `company:${companyId}`, companyId } });
    invalidateCache();
    await audit.recordAudit({
      actor, action: "CONVERSATION_SETTINGS_UPDATED", entityType: "CONVERSATION_SETTINGS", entityId: null, companyId,
      summary: "Atualizou as configurações de Conversas da empresa", details: { before: existing || null, after: settings },
    });
    return { ...settings, scope: "COMPANY", isCompanyOverride: true };
  }

  const before = await getGlobalConversationSettings();
  const settings = await prisma.conversationSettings.update({ where: { id: SETTINGS_ID }, data: update });
  invalidateCache();
  await audit.recordAudit({
    actor, action: "CONVERSATION_SETTINGS_UPDATED", entityType: "CONVERSATION_SETTINGS", entityId: null,
    summary: "Atualizou as configurações globais de Conversas", details: { before, after: settings },
  });
  return settings;
}

module.exports = {
  getConversationSettings,
  getConversationSettingsForViewer,
  getGlobalConversationSettings,
  resetCompanyConversationSettings,
  settingsPlan,
  updateConversationSettings,
  invalidateCache,
};
