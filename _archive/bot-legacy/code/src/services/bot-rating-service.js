// Avaliação do atendimento (BotRating) e ranking dos Bots.
//
// IMPORTANTE (separação exigida): métricas de "atendimento" (attendance)
// só podem vir de BotRating/BotAgentFeedback — sinais de que o Bot
// realmente atendeu. BotObservation é modo sombra (shadow mode) e nunca
// conta como atendimento real; por isso os números derivados dela ficam
// isolados em `interpretation`, nunca somados a `attendance`.
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const audit = require("./audit-service");
const { getGlobalSettings } = require("./bot-governance-service");
const {
  MINIMUM_RATINGS_FOR_METRICS_PERCENTAGE, RATING_NEGATIVE_MAX_SCORE, RATING_POSITIVE_MIN_SCORE,
  RATING_SCORE_MAX, RATING_SCORE_MIN,
} = require("./bot-constants");

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function assertBotManager(viewer) {
  if (!authorization.isMaster(viewer)) {
    throw authorization.forbidden("Somente uma conta Master pode gerenciar Bots.");
  }
}

function periodRange(period) {
  const now = new Date();
  const from = new Date(now);
  switch (period?.preset) {
    case "today": from.setHours(0, 0, 0, 0); break;
    case "7d": from.setDate(from.getDate() - 7); break;
    case "30d": from.setDate(from.getDate() - 30); break;
    case "90d": from.setDate(from.getDate() - 90); break;
    case "custom": {
      const customFrom = period.from ? new Date(period.from) : null;
      const customTo = period.to ? new Date(period.to) : now;
      if (customFrom && Number.isNaN(customFrom.getTime())) throw fail("Data inicial inválida.");
      if (Number.isNaN(customTo.getTime())) throw fail("Data final inválida.");
      return { gte: customFrom || undefined, lte: customTo };
    }
    default: return null; // sem filtro de período (tudo)
  }
  return { gte: from, lte: now };
}

// Núcleo de validação/criação, compartilhado por submitRating() (manual,
// exige Master) e submitRatingFromBot() (o próprio motor registrando a
// resposta 1-5 do cliente — item 9). Nunca pula nenhuma validação entre os
// dois caminhos: Bot e conversa válidos, toggles ligados, nota no intervalo,
// e uma avaliação por conversa (constraint única no banco).
async function createRatingRecord(data, client = prisma) {
  const botId = data?.botId;
  if (!botId) throw fail("Bot é obrigatório para registrar a avaliação.");
  const bot = await client.bot.findFirst({ where: { id: botId, archivedAt: null } });
  if (!bot) throw fail("Bot não encontrado.", 404);
  if (!bot.ratingEnabled) throw fail("A avaliação do atendimento não está habilitada para este Bot.");
  const globalSettings = await getGlobalSettings(client);
  if (!globalSettings.ratingsEnabled) throw fail("As avaliações estão desativadas globalmente.");

  let conversation = null;
  if (data.conversationId) {
    conversation = await client.conversation.findUnique({
      where: { id: data.conversationId }, select: { id: true, channel: true },
    });
    if (!conversation) throw fail("Conversa não encontrada.", 404);
  }
  if (data.intentId) {
    const intent = await client.botIntent.findFirst({ where: { id: data.intentId, botId }, select: { id: true } });
    if (!intent) throw fail("A intenção informada não pertence a este Bot.");
  }

  const score = Number(data.score);
  if (!Number.isInteger(score) || score < RATING_SCORE_MIN || score > RATING_SCORE_MAX) {
    throw fail(`A nota deve ser um número inteiro entre ${RATING_SCORE_MIN} e ${RATING_SCORE_MAX}.`);
  }
  const comment = bot.requestRatingComment && typeof data.comment === "string"
    ? data.comment.trim().slice(0, 1000) || null : null;

  try {
    return await client.botRating.create({
      data: {
        botId,
        conversationId: data.conversationId || null,
        channel: conversation?.channel || bot.channel,
        score,
        comment,
        resolvedByBot: Boolean(data.resolvedByBot),
        intentId: data.intentId || null,
        handoffOccurred: Boolean(data.handoffOccurred),
        metadata: data.metadata || undefined,
      },
    });
  } catch (error) {
    if (error.code === "P2002") throw fail("Esta conversa já recebeu uma avaliação.");
    throw error;
  }
}

// Enquanto não existir um fluxo de avaliação do cliente com token assinado,
// a submissão manual pelo painel fica restrita a Master (impede que contas
// internas comuns contaminem métricas/ranking). A resposta REAL do cliente
// (1-5 depois que o próprio Bot pediu a nota) usa submitRatingFromBot(),
// abaixo, sem essa checagem — é o motor, nunca um humano, registrando.
async function submitRating(data, actor) {
  assertBotManager(actor);
  return createRatingRecord(data);
}

// Item 9: chamado pelo orquestrador quando o cliente responde com um número
// de 1 a 5 depois que o Bot pediu a avaliação — nunca por um humano, nunca
// via painel administrativo. Mesmas validações de submitRating(), sem o
// gate de Master (não há "ator" humano nesta chamada).
async function submitRatingFromBot(data, client = prisma) {
  return createRatingRecord(data, client);
}

// Item 9: decide se ESTE turno deve pedir a avaliação do cliente — nunca em
// Observação/simulador (quem chama já garante isso), nunca duas vezes na
// mesma conversa (`state.ratingRequestedAt`), e só no momento configurado em
// `requestRatingOn` (item 4 da governança de avaliação):
//   BOT_COMPLETED  -> o Flow Engine concluiu com RESOLVED (sinal estrutural
//                      de "atendimento concluído pelo Bot", nunca inferido).
//   BEFORE_HANDOFF -> exatamente no turno em que o Bot decide encaminhar
//                      para um humano.
//   MANUAL/NEVER   -> nunca dispara sozinho.
function shouldRequestRating({ bot, globalSettings, state, decision, flow }) {
  if (!bot?.ratingEnabled || !globalSettings?.ratingsEnabled) return { request: false };
  if (state?.ratingRequestedAt) return { request: false };
  const mode = bot.requestRatingOn || "BOT_COMPLETED";
  if (mode === "BOT_COMPLETED" && flow?.resolutionStatus === "RESOLVED") return { request: true };
  if (mode === "BEFORE_HANDOFF" && decision?.action === "HANDOFF_HUMAN") return { request: true };
  return { request: false };
}

async function listRatings(filters, viewer) {
  assertBotManager(viewer);
  const where = {};
  if (filters.botId) where.botId = filters.botId;
  const createdAt = periodRange(filters);
  if (createdAt) where.createdAt = createdAt;
  const take = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
  return prisma.botRating.findMany({
    where, include: { intent: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" }, take,
  });
}

function classifyScore(score) {
  if (score >= RATING_POSITIVE_MIN_SCORE) return "positive";
  if (score <= RATING_NEGATIVE_MAX_SCORE) return "negative";
  return "neutral";
}

async function ratingMetrics(botId, filters, viewer) {
  assertBotManager(viewer);
  if (!botId) throw fail("Bot é obrigatório.");
  const bot = await prisma.bot.findFirst({
    where: { id: botId, archivedAt: null }, select: { lowConfidenceThreshold: true },
  });
  if (!bot) throw fail("Bot não encontrado.", 404);
  const createdAt = periodRange(filters);
  const ratingWhere = { botId, ...(createdAt ? { createdAt } : {}) };

  const [ratings, observedTotal, observedHandoffs, observedFallbacks, observedLowConfidence] = await Promise.all([
    prisma.botRating.findMany({ where: ratingWhere, select: { score: true, handoffOccurred: true, resolvedByBot: true } }),
    prisma.botObservation.count({ where: { botId, ...(createdAt ? { createdAt } : {}) } }),
    prisma.botObservation.count({ where: { botId, action: "HANDOFF_HUMAN", ...(createdAt ? { createdAt } : {}) } }),
    prisma.botObservation.count({ where: { botId, intentId: null, ...(createdAt ? { createdAt } : {}) } }),
    prisma.botObservation.count({ where: { botId, confidence: { lt: bot.lowConfidenceThreshold }, ...(createdAt ? { createdAt } : {}) } }),
  ]);

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  let positive = 0; let neutral = 0; let negative = 0;
  for (const rating of ratings) {
    distribution[rating.score] = (distribution[rating.score] || 0) + 1;
    sum += rating.score;
    const bucket = classifyScore(rating.score);
    if (bucket === "positive") positive += 1;
    else if (bucket === "negative") negative += 1;
    else neutral += 1;
  }
  const total = ratings.length;
  const hasEnoughForPercentage = total >= MINIMUM_RATINGS_FOR_METRICS_PERCENTAGE;

  return {
    // Diagnóstico do interpretador (BotObservation) — NUNCA é "atendimento real".
    interpretation: {
      totalObserved: observedTotal, handoffs: observedHandoffs, fallbacks: observedFallbacks,
      lowConfidence: observedLowConfidence,
    },
    // Sinais de atendimento real (só existem quando alguém de fato avaliou).
    attendance: {
      resolvedByBot: ratings.filter((rating) => rating.resolvedByBot).length,
      handoffOccurred: ratings.filter((rating) => rating.handoffOccurred).length,
    },
    ratings: {
      total, average: total ? Number((sum / total).toFixed(2)) : null, distribution,
      positive, neutral, negative,
      positivePct: hasEnoughForPercentage ? Number(((positive / total) * 100).toFixed(1)) : null,
      neutralPct: hasEnoughForPercentage ? Number(((neutral / total) * 100).toFixed(1)) : null,
      negativePct: hasEnoughForPercentage ? Number(((negative / total) * 100).toFixed(1)) : null,
      sampleWarning: total > 0 && !hasEnoughForPercentage
        ? `Amostra pequena (${total} avaliação(ões)) — percentuais podem não ser representativos.` : null,
    },
  };
}

// Ranking com score equilibrado (média Bayesiana, estilo "IMDB top 250"):
//   score = (v / (v + m)) * R + (m / (v + m)) * C
// v = nº de avaliações do Bot · m = amostra mínima global · R = média do
// Bot · C = média entre todos os Bots elegíveis. Isso evita que 1 avaliação
// 5 estrelas vença 2.000 avaliações com média 4,8: quanto menor v em
// relação a m, mais o score do Bot é "puxado" para a média geral C.
async function getRanking(viewer) {
  assertBotManager(viewer);
  const globalSettings = await getGlobalSettings();
  if (!globalSettings.rankingEnabled) return { enabled: false, ranked: [], excluded: [] };

  const bots = await prisma.bot.findMany({ where: { archivedAt: null, ratingEnabled: true }, select: { id: true, name: true } });
  const grouped = await prisma.botRating.groupBy({ by: ["botId"], _avg: { score: true }, _count: { _all: true } });
  const byBotId = new Map(grouped.map((row) => [row.botId, { average: row._avg.score || 0, count: row._count._all }]));

  // Item 13: ranking nunca leva em conta só a média — taxa de resolução pelo
  // Bot (sem handoff) e taxa de handoff também entram na conta, cada uma já
  // sobre o próprio universo de avaliações do Bot (mesma amostra mínima `m`).
  const resolvedGrouped = await prisma.botRating.groupBy({
    by: ["botId"], where: { resolvedByBot: true }, _count: { _all: true },
  });
  const handoffGrouped = await prisma.botRating.groupBy({
    by: ["botId"], where: { handoffOccurred: true }, _count: { _all: true },
  });
  const resolvedByBotId = new Map(resolvedGrouped.map((row) => [row.botId, row._count._all]));
  const handoffByBotId = new Map(handoffGrouped.map((row) => [row.botId, row._count._all]));

  const m = globalSettings.minimumRatingsForRanking;
  const eligible = bots.map((bot) => ({ bot, stats: byBotId.get(bot.id) || { average: 0, count: 0 } }))
    .filter((entry) => entry.stats.count >= m);
  const globalAverage = eligible.length
    ? eligible.reduce((acc, entry) => acc + entry.stats.average, 0) / eligible.length
    : 0;

  const ranked = eligible.map(({ bot, stats }) => {
    const { average, count } = stats;
    // Bayesiano só sobre a nota (evita 1 avaliação 5 estrelas vencer 2.000
    // avaliações com média 4,8 — quanto menor `count` em relação a `m`, mais
    // o score é "puxado" para a média geral).
    const bayesianAverage = (count / (count + m)) * average + (m / (count + m)) * globalAverage;
    const resolutionRate = (resolvedByBotId.get(bot.id) || 0) / count;
    const handoffRate = (handoffByBotId.get(bot.id) || 0) / count;
    // Combina nota (peso maior), resolução (positivo) e handoff (negativo)
    // num único score 0-1, todos já na mesma escala — nunca ranqueado só
    // pela média.
    const score = 0.6 * (bayesianAverage / RATING_SCORE_MAX) + 0.25 * resolutionRate + 0.15 * (1 - handoffRate);
    return {
      botId: bot.id, botName: bot.name, averageScore: Number(average.toFixed(2)),
      ratingsCount: count,
      resolutionRate: Number(resolutionRate.toFixed(3)),
      handoffRate: Number(handoffRate.toFixed(3)),
      rankingScore: Number(score.toFixed(3)),
    };
  }).sort((left, right) => right.rankingScore - left.rankingScore);

  const excluded = bots
    .filter((bot) => (byBotId.get(bot.id)?.count || 0) < m)
    .map((bot) => ({ botId: bot.id, botName: bot.name, ratingsCount: byBotId.get(bot.id)?.count || 0, reason: "INSUFFICIENT_SAMPLE" }));

  return { enabled: true, minimumRatingsForRanking: m, ranked, excluded };
}

async function updateRatingConfig(botId, data, actor) {
  assertBotManager(actor);
  const bot = await prisma.bot.findFirst({ where: { id: botId, archivedAt: null } });
  if (!bot) throw fail("Bot não encontrado.", 404);
  const update = {};
  if (data.ratingEnabled !== undefined) {
    if (typeof data.ratingEnabled !== "boolean") throw fail("ratingEnabled deve ser verdadeiro ou falso.");
    update.ratingEnabled = data.ratingEnabled;
  }
  if (data.ratingMessage !== undefined) update.ratingMessage = data.ratingMessage?.trim().slice(0, 500) || null;
  if (data.ratingFollowupMessage !== undefined) update.ratingFollowupMessage = data.ratingFollowupMessage?.trim().slice(0, 500) || null;
  if (data.requestRatingComment !== undefined) {
    if (typeof data.requestRatingComment !== "boolean") throw fail("requestRatingComment deve ser verdadeiro ou falso.");
    update.requestRatingComment = data.requestRatingComment;
  }
  if (data.requestRatingOn !== undefined) {
    const { RATING_REQUEST_MODES } = require("./bot-constants");
    if (!RATING_REQUEST_MODES.includes(data.requestRatingOn)) throw fail("Momento de solicitar avaliação inválido.");
    update.requestRatingOn = data.requestRatingOn;
  }
  if (!Object.keys(update).length) throw fail("Informe ao menos um campo para atualizar.");

  const updated = await prisma.bot.update({ where: { id: botId }, data: update });
  await audit.recordAudit({
    actor, action: "BOT_RATING_CONFIG_UPDATED", entityType: "BOT", entityId: botId,
    summary: `Atualizou a configuração de avaliação do Bot ${bot.name}`,
    details: { before: { ratingEnabled: bot.ratingEnabled }, after: { ratingEnabled: updated.ratingEnabled } },
  });
  return updated;
}

function dayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

// Gráfico 1: nota média ao longo do tempo. Gráfico 4 (metade "atendimentos
// x handoffs") fica em observationTimeSeries — nunca somamos os dois.
async function ratingTimeSeries(botId, filters, viewer) {
  assertBotManager(viewer);
  const createdAt = periodRange(filters) || { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) };
  const rows = await prisma.botRating.findMany({
    where: { botId, createdAt }, select: { score: true, createdAt: true }, orderBy: { createdAt: "asc" },
  });
  const byDay = new Map();
  for (const row of rows) {
    const key = dayKey(row.createdAt);
    const bucket = byDay.get(key) || { date: key, sum: 0, count: 0 };
    bucket.sum += row.score; bucket.count += 1;
    byDay.set(key, bucket);
  }
  return [...byDay.values()].map((bucket) => ({
    date: bucket.date, averageScore: Number((bucket.sum / bucket.count).toFixed(2)), count: bucket.count,
  }));
}

// Gráfico 4: interpretações (BotObservation) x handoffs, ao longo do tempo —
// dado de diagnóstico, rotulado como tal (nunca chamado de "atendimentos").
async function observationTimeSeries(botId, filters, viewer) {
  assertBotManager(viewer);
  const createdAt = periodRange(filters) || { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) };
  const rows = await prisma.botObservation.findMany({
    where: { botId, createdAt }, select: { action: true, createdAt: true }, orderBy: { createdAt: "asc" },
  });
  const byDay = new Map();
  for (const row of rows) {
    const key = dayKey(row.createdAt);
    const bucket = byDay.get(key) || { date: key, totalObserved: 0, handoffs: 0 };
    bucket.totalObserved += 1;
    if (row.action === "HANDOFF_HUMAN") bucket.handoffs += 1;
    byDay.set(key, bucket);
  }
  return [...byDay.values()];
}

module.exports = {
  getRanking, listRatings, observationTimeSeries, ratingMetrics, ratingTimeSeries, submitRating,
  submitRatingFromBot, shouldRequestRating, updateRatingConfig,
};
