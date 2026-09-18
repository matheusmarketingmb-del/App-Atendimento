// MODO SHADOW: roda a IA local (LOCAL_QWEN) para um Bot com featureFlags.
// useAi=true, em paralelo ao atendimento real, registrando o que ela
// TERIA respondido — nunca envia nada ao cliente. Espelha o espírito de
// bot-observation-service.js (nunca deve derrubar o webhook, nunca decide
// nada sozinho), mas é um caminho independente do interpretador legado:
// enquanto aiMode=PRIMARY, é a própria IA (Knowledge + JSON estruturado)
// quem decide o turno, não interpret()/decide().
//
// A separação pedida explicitamente pelo usuário é respeitada em toda a
// função: useAi controla só se a IA RODA; autoReplyEnabled (bot-ai-gate-
// service.js) controla só se ela PODERIA enviar — aqui ela nunca envia,
// mesmo quando autoReplyEligible sai `true`.
const prisma = require("../database/prisma");
const { resolveBot } = require("./bot-orchestrator-service");
const { resolveFeatureFlags, getGlobalSettings } = require("./bot-governance-service");
const { getRecentContext } = require("./bot-conversation-state-service");
const { normalizeCaseState } = require("./bot-case-state-service");
const { KnowledgeSourceProvider } = require("./bot-knowledge/knowledge-provider");
const { resolveLocalQwenInstance } = require("./ai/get-ai-provider");
const { getState: getLocalAiState } = require("./local-ai-status-service");
const { resolveAutoReplyEligibility } = require("./bot-ai-gate-service");
const { buildSystemPromptForAi, buildUserPrompt } = require("./bot-ai-prompt-service");
const { OLLAMA_JSON_SCHEMA, JSON_SCHEMA_EXAMPLE, validate, applyKnowledgeGuard } = require("./bot-ai-schema-service");

const knowledgeProvider = new KnowledgeSourceProvider();

async function persistLog(data, client = prisma) {
  try {
    await client.botAiShadowLog.create({ data });
  } catch (error) {
    // Falha ao registrar o shadow log nunca pode propagar — é só auditoria.
    console.error("[BOT_AI_SHADOW] falha ao gravar log (ignorada)", error.message);
  }
}

// Uma única correção controlada (item 12: "tentar uma única correção
// controlada ou fazer handoff seguro") — nunca insiste indefinidamente.
async function callWithOneRetry(provider, { systemPrompt, userPrompt }) {
  const first = await provider.generateStructuredReply({ systemPrompt, userPrompt, jsonSchema: OLLAMA_JSON_SCHEMA });
  const firstCheck = validate(first.parsed);
  if (firstCheck.valid) return { ...first, check: firstCheck, attempts: 1 };

  const retryPrompt = `${userPrompt}\n\nATENÇÃO: sua resposta anterior não seguiu o formato pedido (${firstCheck.reason}). Responda de novo, só com o JSON válido.`;
  const second = await provider.generateStructuredReply({ systemPrompt, userPrompt: retryPrompt, jsonSchema: OLLAMA_JSON_SCHEMA });
  const secondCheck = validate(second.parsed);
  return { ...second, check: secondCheck, attempts: 2 };
}

async function shadowIncomingMessage(event, message, { now = new Date(), channel = "META" } = {}) {
  if (event.type !== "text" || !event.text) return null;

  const conversation = await prisma.conversation.findUnique({
    where: { id: message.conversationId },
    include: {
      category: { select: { name: true } },
      botState: true,
    },
  });
  if (!conversation) return null;

  const bot = await resolveBot(conversation.botState?.activeBotId || null, channel, prisma);
  if (!bot) return null;

  const flags = resolveFeatureFlags(bot);
  if (!flags.useAi || flags.aiMode === "OFF") return null;
  // Modo PRIMARY é o único implementado até aqui (Fase 6/8 do plano) —
  // FALLBACK/UNDERSTANDING_ONLY/RESPONSE_ONLY ficam para uma próxima etapa,
  // sem fingir suporte que ainda não existe.
  if (flags.aiMode !== "PRIMARY") return null;
  // Mesmo raciocínio para o provider: só LOCAL_QWEN está implementado. Um
  // Bot que escolher outro valor de aiProvider simplesmente não roda IA
  // ainda — nunca cai silenciosamente em Gemini/OpenAI/Anthropic.
  if (flags.aiProvider !== "LOCAL_QWEN") return null;

  const startedAt = Date.now();
  const localAiStatus = getLocalAiState().status;
  const globalSettings = await getGlobalSettings(prisma);
  const gate = resolveAutoReplyEligibility({
    bot, flags, globalAutomationEnabled: globalSettings.automationEnabled, localAiStatus,
  });

  const baseLog = {
    conversationId: message.conversationId, messageId: message.id, botId: bot.id,
    provider: "LOCAL_QWEN", model: flags.aiModel || null, aiMode: flags.aiMode,
    autoReplyEligible: gate.allowed, autoReplyBlockedReason: gate.allowed ? null : gate.reason,
  };

  // Item 5 do plano de teste: PC desligado/indisponível -> nunca chama a IA,
  // só registra o motivo. Nunca cai para outro provider.
  if (localAiStatus !== "ONLINE") {
    await persistLog({ ...baseLog, status: localAiStatus, errorCode: "PROVIDER_" + localAiStatus, latencyMs: Date.now() - startedAt });
    return null;
  }

  try {
    const { provider, error } = await resolveLocalQwenInstance(flags.aiModel || undefined);
    if (!provider) {
      await persistLog({ ...baseLog, status: "ERROR", errorCode: "PROVIDER_NOT_CONFIGURED", latencyMs: Date.now() - startedAt });
      return null;
    }

    const state = conversation.botState;
    const caseState = normalizeCaseState(state?.caseState);
    const contextEntities = state?.contextEntities || {};
    const context = flags.contextEnabled
      ? await getRecentContext(message.conversationId, { beforeMessageId: message.id, limit: flags.contextMaxMessages }, prisma)
      : [];

    let knowledgeResults = [];
    try {
      knowledgeResults = await knowledgeProvider.search(event.text, {
        botId: bot.id, category: conversation.category?.name || null,
        product: contextEntities.productName || caseState.product || null,
      });
    } catch (knowledgeError) {
      console.error("[BOT_AI_SHADOW] falha na busca de Knowledge (ignorada)", knowledgeError.message);
    }

    const systemPrompt = buildSystemPromptForAi(bot);
    const userPrompt = buildUserPrompt({
      categoryName: conversation.category?.name || null, caseState, knowledgeResults, context,
      message: event.text, jsonSchemaExample: JSON_SCHEMA_EXAMPLE,
    });

    const result = await callWithOneRetry(provider, { systemPrompt, userPrompt });
    const latencyMs = Date.now() - startedAt;

    if (!result.check.valid) {
      await persistLog({
        ...baseLog, status: "INVALID_JSON", errorCode: "AI_JSON_INVALID", latencyMs,
        knowledgeUsed: knowledgeResults.map((item) => ({ id: item.id, title: item.title })),
      });
      return null;
    }

    const guarded = applyKnowledgeGuard(result.check.value, knowledgeResults);
    await persistLog({
      ...baseLog, status: "OK", latencyMs,
      action: guarded.action, intent: guarded.intent, issue: guarded.issue, confidence: guarded.confidence,
      entities: guarded.entities, missingInformation: guarded.missingInformation,
      responseText: guarded.response, handoffCategory: guarded.handoffCategory, handoffReason: guarded.handoffReason,
      summary: guarded.summary,
      knowledgeUsed: knowledgeResults.map((item) => ({ id: item.id, title: item.title, score: item.score })),
    });
    return guarded;
  } catch (error) {
    await persistLog({
      ...baseLog, status: "ERROR", errorCode: error.code || "PROVIDER_REQUEST_FAILED",
      latencyMs: Date.now() - startedAt,
    });
    return null;
  }
}

module.exports = { shadowIncomingMessage };
