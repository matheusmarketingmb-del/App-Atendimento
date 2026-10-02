// Item 15 (custo/uso de IA externa): registra métricas simples de cada
// chamada REAL a um provider externo (Anthropic/OpenAI/Gemini) — nunca do
// provider local, nunca do simulador (bot-orchestrator-service.js só chama
// isto a partir de orchestrate(), não de simulateOrchestration()). Sem
// dashboard nesta fase — só a contagem/soma que já responde "quanto o
// fallback está sendo usado" (bot-learning-endpoints.js/relatórios futuros
// podem consultar BotAiUsage diretamente).
const prisma = require("../database/prisma");

async function recordAiUsage({ botId = null, provider, reason, usage = null }, client = prisma) {
  if (!provider) return null;
  try {
    return await client.botAiUsage.create({
      data: {
        botId: botId || null,
        provider,
        reason: reason || "UNKNOWN",
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
      },
    });
  } catch (error) {
    // Nunca pode derrubar a resposta ao cliente por falha ao gravar métrica.
    console.error("[BOT_AI_USAGE] falha ao registrar (ignorada)", error.message);
    return null;
  }
}

async function usageSummary({ botId, provider, since } = {}, client = prisma) {
  const where = {};
  if (botId) where.botId = botId;
  if (provider) where.provider = provider;
  if (since) where.createdAt = { gte: since };
  const grouped = await client.botAiUsage.groupBy({
    by: ["provider", "reason"],
    where,
    _count: { _all: true },
    _sum: { inputTokens: true, outputTokens: true },
  });
  return grouped.map((row) => ({
    provider: row.provider,
    reason: row.reason,
    calls: row._count._all,
    inputTokens: row._sum.inputTokens || 0,
    outputTokens: row._sum.outputTokens || 0,
  }));
}

module.exports = { recordAiUsage, usageSummary };
