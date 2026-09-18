// Executa o pipeline PRIMARY da IA local exclusivamente para o simulador.
// Nao persiste logs/conversas e nao possui qualquer caminho de envio.
const { resolveFeatureFlags } = require("./bot-governance-service");
const { normalizeCaseState } = require("./bot-case-state-service");
const { KnowledgeSourceProvider } = require("./bot-knowledge/knowledge-provider");
const { resolveLocalQwenInstance } = require("./ai/get-ai-provider");
const { checkOnce: checkLocalAi } = require("./local-ai-status-service");
const { buildSystemPromptForAi, buildUserPrompt } = require("./bot-ai-prompt-service");
const {
  OLLAMA_JSON_SCHEMA, JSON_SCHEMA_EXAMPLE, validate, applyKnowledgeGuard,
} = require("./bot-ai-schema-service");

const knowledgeProvider = new KnowledgeSourceProvider();

async function callWithOneRetry(provider, { systemPrompt, userPrompt }) {
  const first = await provider.generateStructuredReply({
    systemPrompt, userPrompt, jsonSchema: OLLAMA_JSON_SCHEMA,
  });
  const firstCheck = validate(first.parsed);
  if (firstCheck.valid) return { ...first, check: firstCheck, attempts: 1 };

  const retryPrompt = `${userPrompt}\n\nATENCAO: a resposta anterior nao seguiu o formato (${firstCheck.reason}). Responda novamente apenas com o JSON valido.`;
  const second = await provider.generateStructuredReply({
    systemPrompt, userPrompt: retryPrompt, jsonSchema: OLLAMA_JSON_SCHEMA,
  });
  return { ...second, check: validate(second.parsed), attempts: 2 };
}

function disabled(reason, flags = {}) {
  return {
    eligible: false,
    status: "DISABLED",
    reason,
    provider: flags.aiProvider || null,
    model: flags.aiModel || null,
    sent: false,
  };
}

async function simulateLocalAi({ bot, message, categoryName, state, history }) {
  const flags = resolveFeatureFlags(bot);
  if (!flags.useAi || flags.aiMode === "OFF") return disabled("IA desativada neste Bot.", flags);
  if (flags.aiMode !== "PRIMARY") return disabled(`Modo ${flags.aiMode} ainda nao executa respostas no simulador.`, flags);
  if (flags.aiProvider !== "LOCAL_QWEN") return disabled("Este simulador seguro executa somente o provider LOCAL_QWEN.", flags);

  const startedAt = Date.now();
  const health = await checkLocalAi();
  if (health.status !== "ONLINE") {
    return {
      eligible: true, status: health.status, reason: health.lastError || "IA local indisponivel.",
      provider: "LOCAL_QWEN", model: flags.aiModel || health.model || null,
      latencyMs: Date.now() - startedAt, sent: false,
    };
  }

  const { provider, error } = await resolveLocalQwenInstance(flags.aiModel || undefined);
  if (!provider) {
    return {
      eligible: true, status: "ERROR", reason: error || "IA local nao configurada.",
      provider: "LOCAL_QWEN", model: flags.aiModel || null,
      latencyMs: Date.now() - startedAt, sent: false,
    };
  }

  const caseState = normalizeCaseState(state?.caseState);
  const contextEntities = state?.contextEntities && typeof state.contextEntities === "object"
    ? state.contextEntities : {};
  let knowledgeResults = [];
  try {
    knowledgeResults = await knowledgeProvider.search(message, {
      botId: bot.id,
      category: categoryName || null,
      product: contextEntities.productName || caseState.product || null,
    });
  } catch (knowledgeError) {
    return {
      eligible: true, status: "ERROR",
      reason: `Falha ao consultar a pasta local: ${knowledgeError.message}`,
      provider: "LOCAL_QWEN", model: provider.model || flags.aiModel || null,
      latencyMs: Date.now() - startedAt, sent: false,
    };
  }

  const systemPrompt = buildSystemPromptForAi(bot);
  const userPrompt = buildUserPrompt({
    categoryName: categoryName || null,
    caseState,
    knowledgeResults,
    context: flags.contextEnabled ? (history || []) : [],
    message,
    jsonSchemaExample: JSON_SCHEMA_EXAMPLE,
  });
  const result = await callWithOneRetry(provider, { systemPrompt, userPrompt });
  if (!result.check.valid) {
    return {
      eligible: true, status: "INVALID_JSON", reason: result.check.reason,
      provider: "LOCAL_QWEN", model: provider.model || flags.aiModel || null,
      latencyMs: Date.now() - startedAt, attempts: result.attempts, sent: false,
    };
  }

  const guarded = applyKnowledgeGuard(result.check.value, knowledgeResults);
  return {
    eligible: true, status: "OK", provider: "LOCAL_QWEN",
    model: provider.model || flags.aiModel || null,
    latencyMs: Date.now() - startedAt, attempts: result.attempts, sent: false,
    ...guarded,
    knowledgeUsed: knowledgeResults.map((item) => ({
      id: item.id, title: item.title, source: item.source || item.domain || null, score: item.score,
    })),
  };
}

module.exports = { simulateLocalAi };
