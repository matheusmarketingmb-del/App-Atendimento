// Cofre de credenciais de IA externa (GEMINI/ANTHROPIC/OPENAI), gerenciado
// pelo painel — nunca mais precisa editar env na VPS para trocar uma chave.
// Cifrado com AES-256-GCM via secret-vault-service.js (mesmo algoritmo do
// resto do projeto), chave mestra PRÓPRIA (AI_SECRETS_ENCRYPTION_KEY, nunca
// INTEGRATION_ENCRYPTION_KEY — pedido explícito de isolar o "raio de
// explosão" de cada chave mestra). RBAC: só Master (Admin) lê/escreve aqui.
// GLOBAL: uma credencial por provider para toda a instalação — cada Bot só
// escolhe QUAL provider/modelo usar (featureFlags.externalAiProvider/
// externalAiModel em bot-constants.js/bot-governance-service.js), nunca tem
// sua própria chave.
const prisma = require("../../database/prisma");
const authorization = require("../authorization-service");
const audit = require("../audit-service");
const vault = require("../crypto/secret-vault-service");
const { EXTERNAL_AI_PROVIDERS } = require("../bot-constants");

const ENV_VAR = "AI_SECRETS_ENCRYPTION_KEY";
// Fallback de compatibilidade: se um provider ainda não tiver credencial
// salva no painel, cai para a variável de ambiente já documentada
// (ANTHROPIC_API_KEY/GEMINI_API_KEY/OPENAI_API_KEY) — a VPS pode continuar
// usando env se preferir, sem quebrar instalações já configuradas assim.
const ENV_KEY_BY_PROVIDER = { ANTHROPIC: "ANTHROPIC_API_KEY", GEMINI: "GEMINI_API_KEY", OPENAI: "OPENAI_API_KEY" };
const ENV_MODEL_BY_PROVIDER = { ANTHROPIC: "ANTHROPIC_MODEL", GEMINI: "GEMINI_MODEL", OPENAI: "OPENAI_MODEL" };

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function assertProvider(provider) {
  if (!EXTERNAL_AI_PROVIDERS.includes(provider)) throw fail(`Provider "${provider}" não implementado.`);
}

// Item RBAC: "somente Admin" — nunca Supervisor/Atendente, mesmo com
// canManageCampaigns ou qualquer outro flag (isso é sobre credenciais de
// infraestrutura, não sobre operar Bots/campanhas).
function assertAdmin(actor) {
  if (!authorization.isMaster(actor)) throw authorization.forbidden("Somente uma conta Master pode gerenciar chaves de API de IA.");
}

// Item 5/6: status por provider (Configurado/Não configurado/Erro) — nunca
// a chave, só os últimos 4 caracteres quando vem do painel.
async function listCredentialStatus(actor) {
  assertAdmin(actor);
  const rows = await prisma.aiProviderCredential.findMany({
    include: { updatedByUser: { select: { id: true, name: true } } },
  });
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  return EXTERNAL_AI_PROVIDERS.map((provider) => {
    const row = byProvider.get(provider);
    if (row) {
      return {
        provider, source: "PAINEL", configured: true, lastFour: row.lastFour,
        defaultModel: row.defaultModel, updatedAt: row.updatedAt, updatedBy: row.updatedByUser?.name || null,
      };
    }
    const envConfigured = Boolean(process.env[ENV_KEY_BY_PROVIDER[provider]]);
    return {
      provider, source: envConfigured ? "ENV" : "NENHUMA", configured: envConfigured,
      lastFour: envConfigured ? vault.maskSecret(process.env[ENV_KEY_BY_PROVIDER[provider]]).slice(-4) : null,
      defaultModel: process.env[ENV_MODEL_BY_PROVIDER[provider]] || null, updatedAt: null, updatedBy: null,
    };
  });
}

// Item "salvar/substituir": upsert — sempre cifra de novo (nunca reaproveita
// IV antigo), sempre substitui o registro inteiro (nunca faz merge parcial
// de uma chave com outra).
async function saveCredential(provider, { apiKey, defaultModel }, actor) {
  assertAdmin(actor);
  assertProvider(provider);
  const key = String(apiKey || "").trim();
  if (!key || key.length < 8) throw fail("Informe uma API Key válida.");
  if (key.length > 4000) throw fail("API Key excede o tamanho máximo aceito.");
  const model = defaultModel ? String(defaultModel).trim().slice(0, 120) : null;

  const { encryptedSecrets, encryptionIv, encryptionAuthTag } = vault.encryptSecrets({ apiKey: key }, ENV_VAR);
  const saved = await prisma.aiProviderCredential.upsert({
    where: { provider },
    create: {
      provider, encryptedKey: encryptedSecrets, encryptionIv, encryptionAuthTag,
      lastFour: key.slice(-4), defaultModel: model, updatedByUserId: actor.id,
    },
    update: {
      encryptedKey: encryptedSecrets, encryptionIv, encryptionAuthTag,
      lastFour: key.slice(-4), defaultModel: model, updatedByUserId: actor.id,
    },
  });

  // Item "auditoria sem registrar secret": só metadado — nunca a chave, nem
  // sequer os últimos 4 caracteres (evita reduzir demais o espaço de busca
  // em logs de auditoria).
  await audit.recordAudit({
    actor, action: "AI_PROVIDER_CREDENTIAL_SAVED", entityType: "AI_PROVIDER_CREDENTIAL", entityId: provider,
    summary: `Configurou a chave de API do provider ${provider}`,
    details: { provider, defaultModel: model, keyLength: key.length },
  });

  return { provider: saved.provider, configured: true, lastFour: saved.lastFour, defaultModel: saved.defaultModel };
}

async function removeCredential(provider, actor) {
  assertAdmin(actor);
  assertProvider(provider);
  const existing = await prisma.aiProviderCredential.findUnique({ where: { provider } });
  if (!existing) throw fail("Nenhuma credencial salva para este provider.", 404);
  await prisma.aiProviderCredential.delete({ where: { provider } });
  await audit.recordAudit({
    actor, action: "AI_PROVIDER_CREDENTIAL_REMOVED", entityType: "AI_PROVIDER_CREDENTIAL", entityId: provider,
    summary: `Removeu a chave de API do provider ${provider}`,
  });
  return { provider, configured: false };
}

// Uso INTERNO (nunca exposto por controller): resolve a chave/modelo que
// get-ai-provider.js deve usar para instanciar um provider — painel primeiro,
// env como compatibilidade. Nunca lança: provider sem credencial em lugar
// nenhum simplesmente devolve { apiKey: null }.
async function resolveCredential(provider) {
  const row = await prisma.aiProviderCredential.findUnique({ where: { provider } });
  if (row) {
    try {
      const { apiKey } = vault.decryptSecrets({
        encryptedSecrets: row.encryptedKey, encryptionIv: row.encryptionIv, encryptionAuthTag: row.encryptionAuthTag,
      }, ENV_VAR);
      return { apiKey: apiKey || null, model: row.defaultModel || null, source: "PAINEL" };
    } catch (error) {
      // Chave mestra ausente/errada: nunca derruba a app — só reporta como
      // não configurado (o erro real fica só no log do servidor).
      console.error(`[AI_CREDENTIAL] falha ao decifrar credencial de ${provider} (ignorada)`, error.message);
      return { apiKey: null, model: row.defaultModel || null, source: "ERROR" };
    }
  }
  const envKey = process.env[ENV_KEY_BY_PROVIDER[provider]] || null;
  return { apiKey: envKey, model: process.env[ENV_MODEL_BY_PROVIDER[provider]] || null, source: envKey ? "ENV" : "NENHUMA" };
}

module.exports = { listCredentialStatus, removeCredential, resolveCredential, saveCredential };
