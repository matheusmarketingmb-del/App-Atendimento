// CRUD de ChannelAccount (item 5/6/7) — Master-only. Segredos nunca
// trafegam de volta inteiros: toda leitura devolve só `secretKeys` +
// máscara. Escrita cifra antes de gravar (integration-secret-service.js).
const prisma = require("../../database/prisma");
const authorization = require("../authorization-service");
const audit = require("../audit-service");
const { encryptSecrets, decryptSecrets, maskSecret } = require("./integration-secret-service");
const { createAdapter, getAdapterClass } = require("./channel-adapter-registry");
const { ALL_MANAGED_CHANNELS, CHANNEL_LABELS, NEW_CHANNELS } = require("./channel-constants");
const oauth = require("./integration-oauth-service");
const { getGlobalSettings } = require("./integration-global-settings-service");

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function assertIntegrationManager(viewer) {
  if (!authorization.isMaster(viewer)) {
    throw authorization.forbidden("Somente uma conta Master pode gerenciar integrações.");
  }
}

// Nunca devolve os valores cifrados/segredo — só metadados + máscara do
// último trecho salvo (quando o próprio front mandou uma vez, exibimos a
// máscara com base nos 4 últimos caracteres guardados em config._secretHints,
// que não são o segredo em si).
function publicAccount(account) {
  if (!account) return null;
  const { encryptedSecrets, encryptionIv, encryptionAuthTag, config, ...rest } = account;
  const hints = config?._secretHints || {};
  return {
    ...rest,
    config: Object.fromEntries(Object.entries(config || {}).filter(([key]) => key !== "_secretHints")),
    secretHints: Object.fromEntries(account.secretKeys.map((key) => [key, hints[key] || maskSecret("****")])),
    allowedUsers: rest.accessUsers || [],
    allowedCategoryIds: Array.isArray(config?.allowedCategoryIds) ? config.allowedCategoryIds : [],
    outboundCategoryIds: Array.isArray(config?.outboundCategoryIds) ? config.outboundCategoryIds : [],
  };
}

async function listAccounts(viewer) {
  assertIntegrationManager(viewer);
  const accounts = await prisma.channelAccount.findMany({ include: { accessUsers: { include: { user: { select: { id: true, name: true, email: true } } } } }, orderBy: [{ channel: "asc" }, { name: "asc" }] });
  return accounts.map(publicAccount);
}

async function ensureAccount(id) {
  const account = await prisma.channelAccount.findUnique({ where: { id } });
  if (!account) throw fail("Conta de canal não encontrada.", 404);
  return account;
}

async function getAccount(id, viewer) {
  assertIntegrationManager(viewer);
  await ensureAccount(id);
  return publicAccount(await prisma.channelAccount.findUnique({ where: { id }, include: { accessUsers: { include: { user: { select: { id: true, name: true, email: true } } } } } }));
}

const FORBIDDEN_CONFIG_SECRET_KEYS = new Set([
  "accesstoken", "apikey", "appsecret", "clientsecret", "lwaclientsecret",
  "partnerkey", "password", "privatekey", "refreshtoken",
]);

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function assertObjectInput(value, field) {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw fail(field + " deve ser um objeto.");
  }
}

function assertNoPlaintextSecrets(config) {
  const exposed = [];
  const visit = (value, path = "config") => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (FORBIDDEN_CONFIG_SECRET_KEYS.has(normalizedKey)) exposed.push(path + "." + key);
      visit(nested, path + "." + key);
    }
  };
  visit(config);
  if (exposed.length) throw fail("Segredos devem ser enviados no campo secrets: " + exposed.join(", ") + ".");
}

function assertSecretValues(secrets) {
  const invalid = Object.entries(secrets).find(([, value]) => typeof value !== "string" || !value.trim());
  if (invalid) throw fail("Todo segredo deve ser uma string não vazia: " + invalid[0] + ".");
}

function validateChannel(channel) {
  if (!ALL_MANAGED_CHANNELS.includes(channel)) throw fail("Canal inválido para integração.");
  return channel;
}

async function createAccount(data, actor) {
  assertIntegrationManager(actor);
  const channel = validateChannel(data.channel);
  const name = String(data.name || "").trim();
  if (!name) throw fail("Nome da conta é obrigatório.");
  assertObjectInput(data.config, "config");
  assertObjectInput(data.secrets, "secrets");
  const config = plainObject(data.config);
  const secrets = plainObject(data.secrets);
  assertNoPlaintextSecrets(config);
  assertSecretValues(secrets);

  const secretData = Object.keys(secrets).length ? encryptSecrets(secrets) : { secretKeys: [] };
  const hints = Object.fromEntries(Object.entries(secrets).map(([key, value]) => [key, maskSecret(String(value))]));

  const account = await prisma.channelAccount.create({
    data: {
      channel, name, externalAccountId: data.externalAccountId || null,
      config: { ...config, _secretHints: hints },
      status: secretData.secretKeys.length ? "CONFIGURED" : "NOT_CONFIGURED",
      ...secretData,
    },
  });
  await audit.recordAudit({
    actor, action: "CHANNEL_ACCOUNT_CREATED", entityType: "CHANNEL_ACCOUNT", entityId: account.id,
    summary: `Criou a conta "${name}" do canal ${channel}`, details: { channel, name },
  });
  return publicAccount(account);
}

async function updateAccount(id, data, actor) {
  assertIntegrationManager(actor);
  const existing = await ensureAccount(id);
  if (existing.config?.isLegacyWhatsApp && (data.config !== undefined || data.secrets !== undefined || data.externalAccountId !== undefined)) throw fail("As credenciais do número principal são gerenciadas na configuração do servidor. Use Acessos para configurar os setores de envio.");
  const update = {};
  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) throw fail("Nome da conta não pode ficar vazio.");
    update.name = name;
  }
  if (data.externalAccountId !== undefined) update.externalAccountId = data.externalAccountId || null;

  const existingConfig = existing.config && typeof existing.config === "object" ? existing.config : {};
  const existingHints = existingConfig._secretHints || {};
  assertObjectInput(data.config, "config");
  assertObjectInput(data.secrets, "secrets");
  const incomingConfig = plainObject(data.config);
  assertNoPlaintextSecrets(incomingConfig);
  assertSecretValues(plainObject(data.secrets));
  let config = data.config !== undefined ? { ...existingConfig, ...incomingConfig } : existingConfig;

  if (data.secrets && typeof data.secrets === "object" && Object.keys(data.secrets).length) {
    const mergedSecrets = { ...decryptSecretsSafe(existing), ...data.secrets };
    const secretData = encryptSecrets(mergedSecrets);
    const hints = { ...existingHints, ...Object.fromEntries(Object.entries(data.secrets).map(([key, value]) => [key, maskSecret(String(value))])) };
    Object.assign(update, secretData, { config: { ...config, _secretHints: hints } });
    if (existing.status === "NOT_CONFIGURED") update.status = "CONFIGURED";
  } else if (data.config !== undefined) {
    update.config = config;
  }

  if (!Object.keys(update).length) throw fail("Informe ao menos um campo para atualizar.");

  const account = await prisma.channelAccount.update({ where: { id }, data: update });
  await audit.recordAudit({
    actor, action: "CHANNEL_ACCOUNT_UPDATED", entityType: "CHANNEL_ACCOUNT", entityId: id,
    summary: `Atualizou a conta "${account.name}" do canal ${account.channel}`,
    details: { updatedFields: Object.keys(update).filter((key) => key !== "encryptedSecrets" && key !== "encryptionIv" && key !== "encryptionAuthTag") },
  });
  return publicAccount(account);
}

function decryptSecretsSafe(account) {
  try {
    return decryptSecrets(account);
  } catch (_error) {
    return {};
  }
}


async function uniqueOAuthName(channel, preferredName) {
  const base = String(preferredName || CHANNEL_LABELS[channel] || channel).trim().slice(0, 70);
  let name = base;
  for (let suffix = 2; await prisma.channelAccount.findFirst({ where: { channel, name } }); suffix += 1) {
    name = `${base.slice(0, 65)} (${suffix})`;
  }
  return name;
}

function oauthSecrets(token, candidate, previous = {}) {
  return {
    ...previous,
    accessToken: token.access_token,
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    ...(candidate?.secretPatch || {}),
  };
}

function safeOAuthCandidate(candidate) {
  return { id: candidate.id, name: candidate.name, username: candidate.username || null, config: candidate.config || {} };
}

async function saveOAuthConnection({ accountId = null, channel, provider, token, scopes = [], candidates = [], preferredName = null }, actor) {
  assertIntegrationManager(actor);
  if (!candidates.length) throw fail("Nenhuma conta compatível foi encontrada após a autorização.", 400);
  const existing = accountId ? await ensureAccount(accountId) : null;
  if (existing && existing.channel !== channel) throw fail("Conta OAuth não corresponde ao canal autorizado.");
  const multiple = candidates.length > 1;
  const selected = multiple ? null : candidates[0];
  const previousSecrets = existing ? decryptSecretsSafe(existing) : {};
  const secrets = oauthSecrets(token, selected, previousSecrets);
  if (multiple) secrets.oauthCandidates = Object.fromEntries(candidates.map((item) => [item.id, item.secretPatch || {}]));
  else delete secrets.oauthCandidates;
  const secretData = encryptSecrets(secrets);
  const currentConfig = existing?.config || {};
  const config = {
    ...currentConfig,
    ...(selected?.config || {}),
    ...(multiple ? { oauthCandidates: candidates.map(safeOAuthCandidate) } : {}),
    _secretHints: currentConfig._secretHints || {},
  };
  if (!multiple) delete config.oauthCandidates;
  const data = {
    oauthProvider: provider,
    oauthScopes: token.scope ? String(token.scope).split(/\s+/).filter(Boolean) : scopes,
    tokenExpiresAt: oauth.tokenExpiresAt(token),
    externalAccountId: selected?.id || null,
    providerMetadata: selected ? { displayName: selected.name, username: selected.username || null } : {},
    config,
    status: multiple ? "AUTH_PENDING" : "CONNECTED",
    lastErrorAt: null, lastErrorCode: null, lastErrorMessage: null,
    ...secretData,
  };
  let account;
  if (existing) account = await prisma.channelAccount.update({ where: { id: existing.id }, data });
  else account = await prisma.channelAccount.create({ data: { channel, name: await uniqueOAuthName(channel, preferredName || selected?.name), ...data } });
  await audit.recordAudit({
    actor, action: multiple ? "CHANNEL_OAUTH_SELECTION_REQUIRED" : "CHANNEL_OAUTH_CONNECTED",
    entityType: "CHANNEL_ACCOUNT", entityId: account.id,
    summary: multiple ? `OAuth autorizado; seleção de conta necessária (${channel})` : `Conectou "${account.name}" via ${provider}`,
    details: { channel, provider, candidateCount: candidates.length },
  });
  return { account: publicAccount(account), selectionRequired: multiple, candidates: multiple ? candidates.map(safeOAuthCandidate) : [] };
}

async function selectOAuthCandidate(id, candidateId, actor) {
  assertIntegrationManager(actor);
  const existing = await ensureAccount(id);
  const candidates = Array.isArray(existing.config?.oauthCandidates) ? existing.config.oauthCandidates : [];
  const selected = candidates.find((item) => item.id === candidateId);
  if (!selected) throw fail("Conta externa selecionada não está disponível.", 400);
  const secrets = decryptSecretsSafe(existing);
  const secretPatch = secrets.oauthCandidates?.[candidateId];
  if (!secretPatch) throw fail("Autorização pendente expirou; reconecte a integração.", 400);
  delete secrets.oauthCandidates;
  Object.assign(secrets, secretPatch);
  const { oauthCandidates: _ignored, ...cleanConfig } = existing.config || {};
  const account = await prisma.channelAccount.update({
    where: { id },
    data: {
      ...encryptSecrets(secrets), config: { ...cleanConfig, ...(selected.config || {}) },
      externalAccountId: selected.id, providerMetadata: { displayName: selected.name, username: selected.username || null },
      status: "CONNECTED", lastErrorAt: null, lastErrorCode: null, lastErrorMessage: null,
    },
  });
  await audit.recordAudit({
    actor, action: "CHANNEL_OAUTH_ACCOUNT_SELECTED", entityType: "CHANNEL_ACCOUNT", entityId: id,
    summary: `Selecionou "${selected.name}" para a integração ${existing.channel}`,
    details: { channel: existing.channel, provider: existing.oauthProvider, externalAccountId: selected.id },
  });
  return publicAccount(account);
}

async function setEnabled(id, enabled, actor) {
  assertIntegrationManager(actor);
  const existing = await ensureAccount(id);
  if (typeof enabled !== "boolean") throw fail("enabled deve ser verdadeiro ou falso.");
  const account = await prisma.channelAccount.update({
    where: { id }, data: { enabled, status: enabled && existing.status === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : existing.status },
  });
  await audit.recordAudit({
    actor, action: enabled ? "CHANNEL_ACCOUNT_ENABLED" : "CHANNEL_ACCOUNT_DISABLED", entityType: "CHANNEL_ACCOUNT", entityId: id,
    summary: `${enabled ? "Ativou" : "Desativou"} a conta "${account.name}" do canal ${account.channel}`,
  });
  return publicAccount(account);
}

async function deleteAccount(id, actor) {
  assertIntegrationManager(actor);
  const existing = await ensureAccount(id);
  await prisma.channelAccount.delete({ where: { id } });
  await audit.recordAudit({
    actor, action: "CHANNEL_ACCOUNT_DELETED", entityType: "CHANNEL_ACCOUNT", entityId: id,
    summary: `Removeu a conta "${existing.name}" do canal ${existing.channel}`,
  });
  return { deleted: true };
}

async function setAccountAccess(id, userIds, categoryIds, actor, outboundCategoryIds) {
  if (actor === undefined) { actor = categoryIds; categoryIds = undefined; }
  assertIntegrationManager(actor);
  const account = await ensureAccount(id);
  if (categoryIds === undefined) categoryIds = Array.isArray(account.config?.allowedCategoryIds) ? account.config.allowedCategoryIds : [];
  if (!Array.isArray(userIds) || userIds.some((value) => typeof value !== "string" || !value)) throw fail("userIds deve ser uma lista de usuários.");
  if (!Array.isArray(categoryIds) || categoryIds.some((value) => typeof value !== "string" || !value)) throw fail("categoryIds deve ser uma lista de categorias.");
  const uniqueIds = [...new Set(userIds)];
  const uniqueCategoryIds = [...new Set(categoryIds)];
  if (outboundCategoryIds === undefined) outboundCategoryIds = account.config?.outboundCategoryIds || [];
  if (!Array.isArray(outboundCategoryIds) || outboundCategoryIds.some((value) => typeof value !== "string" || !value)) throw fail("Categorias de envio inválidas.");
  const uniqueOutboundIds = [...new Set(outboundCategoryIds)];
  if (uniqueOutboundIds.length !== await prisma.category.count({ where: { id: { in: uniqueOutboundIds }, active: true } })) throw fail("Uma categoria de envio é inválida ou inativa.");
  const [validUsers, validCategories] = await Promise.all([
    uniqueIds.length ? prisma.user.findMany({ where: { id: { in: uniqueIds }, active: true }, select: { id: true } }) : [],
    uniqueCategoryIds.length ? prisma.category.findMany({ where: { id: { in: uniqueCategoryIds }, active: true }, select: { id: true } }) : [],
  ]);
  if (validUsers.length !== uniqueIds.length) throw fail("Um ou mais usuários selecionados são inválidos ou estão inativos.");
  if (validCategories.length !== uniqueCategoryIds.length) throw fail("Uma ou mais categorias selecionadas são inválidas ou estão inativas.");
  const currentConfig = plainObject(account.config);
  await prisma.$transaction(async (transaction) => {
    await transaction.channelAccountUserAccess.deleteMany({ where: { channelAccountId: id } });
    if (uniqueIds.length) await transaction.channelAccountUserAccess.createMany({ data: uniqueIds.map((userId) => ({ channelAccountId: id, userId })) });
    await transaction.channelAccount.update({ where: { id }, data: { config: { ...currentConfig, allowedCategoryIds: uniqueCategoryIds, outboundCategoryIds: uniqueOutboundIds } } });
  });
  await audit.recordAudit({
    actor, action: "CHANNEL_ACCOUNT_ACCESS_UPDATED", entityType: "CHANNEL_ACCOUNT", entityId: id,
    summary: `Atualizou os acessos da conta "${account.name}"`,
    details: { channel: account.channel, userIds: uniqueIds, categoryIds: uniqueCategoryIds, outboundCategoryIds: uniqueOutboundIds },
  });
  return publicAccount(await prisma.channelAccount.findUnique({
    where: { id }, include: { accessUsers: { include: { user: { select: { id: true, name: true, email: true } } } } },
  }));
}
// Só verifica credenciais/escopo — nunca envia nada real (item 12).
async function testConnection(id, actor) {
  assertIntegrationManager(actor);
  let account = await ensureAccount(id);
  account = await oauth.refreshAccountIfNeeded(account);
  const globalSettings = await getGlobalSettings();
  if (NEW_CHANNELS.includes(account.channel) && !globalSettings.newChannelsEnabled) {
    throw fail("Integrações de novos canais estão desativadas globalmente.");
  }
  const buildAccountAdapter = (stored) => createAdapter(stored.channel, {
    ...stored, secrets: decryptSecretsSafe(stored),
    config: Object.fromEntries(Object.entries(stored.config || {}).filter(([key]) => key !== "_secretHints")),
  });
  let adapter = buildAccountAdapter(account);
  if (!adapter) throw fail("Canal sem adapter disponível.");

  let result;
  let status;
  let connectionError = null;
  try {
    result = await adapter.testConnection();
  } catch (error) {
    connectionError = error;
    if (account.oauthProvider && error.channelErrorCode === "TOKEN_EXPIRED") {
      account = await oauth.refreshAccountIfNeeded(account, { force: true });
      if (account.status === "CONNECTED") {
        adapter = buildAccountAdapter(account);
        try {
          result = await adapter.testConnection();
          connectionError = null;
        } catch (retryError) { connectionError = retryError; }
      }
    }
  }
  if (connectionError) {
    status = account.oauthProvider && (account.status === "RECONNECT_REQUIRED" || ["TOKEN_EXPIRED", "AUTH_ERROR"].includes(connectionError.channelErrorCode)) ? "RECONNECT_REQUIRED" : "ERROR";
    await prisma.channelAccount.update({
      where: { id }, data: { status, lastErrorAt: new Date(), lastErrorCode: connectionError.channelErrorCode || "PROVIDER_ERROR", lastErrorMessage: connectionError.message?.slice(0, 300) },
    });
    await audit.recordAudit({
      actor, action: "CHANNEL_CONNECTION_TEST_FAILED", entityType: "CHANNEL_ACCOUNT", entityId: id,
      summary: `Teste de conexão falhou para "${account.name}" (${account.channel})`,
      details: { errorCode: connectionError.channelErrorCode || "PROVIDER_ERROR" },
    });
    throw fail(connectionError.message || "Falha ao testar conexão.", connectionError.statusCode || 502);
  }
  status = result.status || "CONNECTED";

  await prisma.channelAccount.update({
    where: { id }, data: { status, ...(result.externalAccountId ? { externalAccountId: result.externalAccountId } : {}), ...(result.providerMetadata ? { providerMetadata: result.providerMetadata } : {}), lastSyncAt: status === "CONNECTED" ? new Date() : undefined, lastErrorAt: null, lastErrorCode: null, lastErrorMessage: null },
  });
  await audit.recordAudit({
    actor, action: "CHANNEL_CONNECTION_TESTED", entityType: "CHANNEL_ACCOUNT", entityId: id,
    summary: `Testou a conexão de "${account.name}" (${account.channel}): ${status}`,
  });
  return { status, message: result.message || null };
}

// Visão consolidada para os cards da tela de Integrações (item 6), inclui
// canais sem nenhuma conta ainda cadastrada.
async function listChannelOverview(viewer) {
  assertIntegrationManager(viewer);
  const accounts = await prisma.channelAccount.findMany({ include: { accessUsers: { include: { user: { select: { id: true, name: true, email: true } } } } }, orderBy: { createdAt: "asc" } });
  const byChannel = new Map();
  for (const account of accounts) {
    if (!byChannel.has(account.channel)) byChannel.set(account.channel, []);
    byChannel.get(account.channel).push(publicAccount(account));
  }
  return ALL_MANAGED_CHANNELS.map((channel) => ({
    channel,
    adapterAvailable: Boolean(getAdapterClass(channel)),
    capabilities: createAdapter(channel)?.capabilities() || null,
    accounts: byChannel.get(channel) || [],
  }));
}

module.exports = {
  assertIntegrationManager, createAccount, deleteAccount, getAccount, listAccounts,
  listChannelOverview, saveOAuthConnection, selectOAuthCandidate, setAccountAccess, setEnabled, testConnection, updateAccount,
};
