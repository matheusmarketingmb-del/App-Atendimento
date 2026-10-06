// Multiempresa: cada número de WhatsApp é uma ChannelAccount (channel META)
// vinculada a uma empresa. É o número que recebeu a mensagem que define a
// empresa da conversa — o atendente nunca escolhe.
//
// config da conta:
//   { phoneNumberId, wabaId, displayNumber }  — número cadastrado no painel
//   { legacyEnv: true }                       — número original da instalação,
//      lido de PHONE_NUMBER_ID / WHATSAPP_BUSINESS_ACCOUNT_ID / WHATSAPP_TOKEN
// Token: segredo `accessToken` da conta, quando houver; senão o WHATSAPP_TOKEN
// do .env (mesmo App Meta atendendo vários números/WABAs).
const prisma = require("../database/prisma");
const { decryptSecrets } = require("./channels/integration-secret-service");

const LEGACY_SCOPE = "LEGACY";

function accountConfig(account) {
  return account?.config && typeof account.config === "object" && !Array.isArray(account.config) ? account.config : {};
}

const isLegacyEnvAccount = (account) => accountConfig(account).legacyEnv === true;

// Conversa por (contato, número): o número original continua no escopo
// "LEGACY" (conversas existentes intactas); números novos usam o id da conta,
// para que a resposta sempre saia pelo mesmo número que recebeu.
function conversationScopeFor(account) {
  return !account || isLegacyEnvAccount(account) ? LEGACY_SCOPE : account.id;
}

function phoneNumberIdOf(account) {
  return isLegacyEnvAccount(account) ? process.env.PHONE_NUMBER_ID || null : accountConfig(account).phoneNumberId || null;
}

function wabaIdOf(account) {
  return isLegacyEnvAccount(account) ? process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || null : accountConfig(account).wabaId || null;
}

function accessTokenOf(account) {
  if (!isLegacyEnvAccount(account) && account?.encryptedSecrets) {
    try {
      const token = decryptSecrets(account)?.accessToken;
      if (token) return token;
    } catch (_error) { /* sem segredo legível: cai no token do .env */ }
  }
  return process.env.WHATSAPP_TOKEN || null;
}

async function getLegacyAccount(db = prisma) {
  return db.channelAccount.findFirst({
    where: { channel: "META", config: { path: ["legacyEnv"], equals: true } },
    orderBy: { createdAt: "asc" },
  });
}

async function listWhatsappAccounts({ companyIds = null, enabledOnly = true } = {}, db = prisma) {
  return db.channelAccount.findMany({
    where: {
      channel: "META",
      ...(enabledOnly ? { enabled: true } : {}),
      ...(companyIds ? { companyId: { in: companyIds } } : {}),
    },
    include: { company: true },
    orderBy: [{ createdAt: "asc" }],
  });
}

// Webhook → conta. phone_number_id desconhecido NUNCA é atribuído a uma
// empresa "por padrão": devolve null e o evento é ignorado (com log).
// Payload sem metadata (formato antigo/testes) = número original (.env).
async function resolveInboundAccount(phoneNumberId, db = prisma) {
  if (!phoneNumberId) return getLegacyAccount(db);
  const id = String(phoneNumberId);
  const accounts = await listWhatsappAccounts({}, db);
  const match = accounts.find((account) => !isLegacyEnvAccount(account) && String(accountConfig(account).phoneNumberId || "") === id);
  if (match) return match;
  if (process.env.PHONE_NUMBER_ID && id === String(process.env.PHONE_NUMBER_ID)) {
    return accounts.find(isLegacyEnvAccount) || null;
  }
  return null;
}

// Conta usada para responder/enviar numa conversa: sempre a da própria
// conversa. Conversas WhatsApp anteriores à fase multiempresa foram
// vinculadas à conta original pela migration.
async function accountForConversation(conversation, db = prisma) {
  if (conversation?.channelAccount) return conversation.channelAccount;
  if (conversation?.channelAccountId) return db.channelAccount.findUnique({ where: { id: conversation.channelAccountId } });
  // Sem conta vinculada: o número original só serve se for da MESMA empresa
  // — nunca responde um cliente Sincrofit pelo número da Mibro.
  const legacy = await getLegacyAccount(db);
  if (legacy && conversation?.companyId && legacy.companyId !== conversation.companyId) {
    throw Object.assign(new Error("Esta conversa não tem número de WhatsApp da empresa vinculado — envio bloqueado."), { statusCode: 409 });
  }
  return legacy;
}

// Canal Meta ligado ao número da conta. Canais de teste (sem forAccount)
// são usados como estão.
function senderFor(channel, account) {
  return account && typeof channel?.forAccount === "function" ? channel.forAccount(account) : channel;
}

// Número escolhido numa tela (iniciar conversa, campanha, templates) —
// sempre validado contra o acesso do usuário à empresa da conta. Sem
// número explícito: só resolve sozinho se o usuário (ou a empresa pedida)
// tiver exatamente um número ativo; nunca "o número padrão" às cegas.
async function resolveAccountForUser(user, { channelAccountId, company } = {}, db = prisma) {
  const companyService = require("./company-service");
  let companyIds = await companyService.accessibleCompanyIds(user);
  if (company && company !== companyService.ALL_COMPANIES) companyIds = await companyService.resolveCompanyFilter(user, company);
  if (channelAccountId) {
    const account = await db.channelAccount.findFirst({
      where: { id: channelAccountId, channel: "META", enabled: true, companyId: { in: companyIds } },
      include: { company: true },
    });
    if (!account) throw Object.assign(new Error("Número de WhatsApp não encontrado."), { statusCode: 404 });
    return account;
  }
  const accounts = await listWhatsappAccounts({ companyIds }, db);
  if (accounts.length === 1) return accounts[0];
  if (!accounts.length) throw Object.assign(new Error("Nenhum número de WhatsApp disponível para esta empresa."), { statusCode: 404 });
  throw Object.assign(new Error("Selecione o número de WhatsApp (empresa) de envio."), { statusCode: 400, code: "WHATSAPP_ACCOUNT_REQUIRED" });
}

// Representação pública (sem config/segredos) para seletores na UI.
function publicWhatsappAccount(account) {
  const config = accountConfig(account);
  return {
    id: account.id, name: account.name, companyId: account.companyId,
    displayNumber: config.displayNumber || (isLegacyEnvAccount(account) ? process.env.WHATSAPP_DISPLAY_NUMBER || null : null),
    templatesConfigured: Boolean(wabaIdOf(account)),
    company: account.company ? require("./company-service").publicCompany(account.company) : undefined,
  };
}

async function listAccountsForUser(user, { company } = {}, db = prisma) {
  const companyService = require("./company-service");
  const companyIds = company && company !== companyService.ALL_COMPANIES
    ? await companyService.resolveCompanyFilter(user, company)
    : await companyService.accessibleCompanyIds(user);
  return (await listWhatsappAccounts({ companyIds }, db)).map(publicWhatsappAccount);
}

module.exports = {
  LEGACY_SCOPE, accessTokenOf, accountConfig, accountForConversation, conversationScopeFor, getLegacyAccount,
  isLegacyEnvAccount, listAccountsForUser, listWhatsappAccounts, phoneNumberIdOf, publicWhatsappAccount,
  resolveAccountForUser, resolveInboundAccount, senderFor, wabaIdOf,
};
