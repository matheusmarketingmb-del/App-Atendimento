// Configuração GLOBAL do provider LOCAL_QWEN (LocalAiProviderSettings,
// registro único "singleton") — host/porta/modelo padrão, nunca uma
// credencial (baseUrl é um endereço de rede privada, tipicamente Tailscale,
// nunca uma chave). Reutilizado por QUALQUER Bot com featureFlags.aiProvider
// = "LOCAL_QWEN": nunca uma instância por Bot (ver ai/get-ai-provider.js).
const prisma = require("../database/prisma");

const SINGLETON_ID = "singleton";

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

async function getSettings(client = prisma) {
  const existing = await client.localAiProviderSettings.findUnique({ where: { id: SINGLETON_ID } });
  if (existing) return existing;
  return client.localAiProviderSettings.create({ data: { id: SINGLETON_ID } });
}

// Nunca expõe mais do que o necessário para a UI decidir o que mostrar —
// `baseUrl` aparece porque não é segredo (é um endereço de rede privada),
// mas isso é decidido aqui, num único lugar, não espalhado pelos controllers.
function toPublicView(settings) {
  return {
    enabled: settings.enabled,
    baseUrl: settings.baseUrl,
    defaultModel: settings.defaultModel,
    timeoutMs: settings.timeoutMs,
    maxConcurrency: settings.maxConcurrency,
    updatedAt: settings.updatedAt,
  };
}

function assertMaster(viewer) {
  const authorization = require("./authorization-service");
  if (!authorization.isMaster(viewer)) {
    throw authorization.forbidden("Somente uma conta Master pode configurar a IA local.");
  }
}

async function updateSettings(data, actor, client = prisma) {
  assertMaster(actor);
  const update = {};
  if (data.enabled !== undefined) {
    if (typeof data.enabled !== "boolean") throw fail("Informe se a IA local está habilitada.");
    update.enabled = data.enabled;
  }
  if (data.baseUrl !== undefined) {
    const baseUrl = String(data.baseUrl || "").trim();
    if (baseUrl && !/^https?:\/\/[^\s]+$/i.test(baseUrl)) throw fail("Endereço da IA local inválido.");
    update.baseUrl = baseUrl ? baseUrl.replace(/\/+$/, "") : null;
  }
  if (data.defaultModel !== undefined) {
    const defaultModel = String(data.defaultModel || "").trim();
    if (!defaultModel) throw fail("Informe o modelo padrão da IA local.");
    update.defaultModel = defaultModel.slice(0, 120);
  }
  if (data.timeoutMs !== undefined) {
    const timeoutMs = Number(data.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) {
      throw fail("Timeout da IA local deve ser um inteiro entre 1000 e 180000 ms.");
    }
    update.timeoutMs = timeoutMs;
  }
  if (data.maxConcurrency !== undefined) {
    const maxConcurrency = Number(data.maxConcurrency);
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 4) {
      throw fail("Concorrência máxima da IA local deve ser um inteiro entre 1 e 4.");
    }
    update.maxConcurrency = maxConcurrency;
  }
  if (!Object.keys(update).length) throw fail("Informe ao menos um campo para atualizar.");
  update.updatedByUserId = actor?.id || null;

  await getSettings(client); // garante que o singleton existe antes do update.
  return client.localAiProviderSettings.update({ where: { id: SINGLETON_ID }, data: update });
}

module.exports = { getSettings, toPublicView, updateSettings, SINGLETON_ID };
