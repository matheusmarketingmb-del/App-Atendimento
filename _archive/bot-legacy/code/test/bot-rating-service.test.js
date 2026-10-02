require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const ratings = require("../src/services/bot-rating-service");
const { getGlobalSettings } = require("../src/services/bot-governance-service");

const botNamePrefix = "Bot Rating Teste";
const externalId = "bot-rating-test-contact";
const masterEmail = "master-rating-test@teste.local";
let master;
const submitRating = (data) => ratings.submitRating(data, master);

async function cleanup() {
  await prisma.bot.deleteMany({ where: { name: { startsWith: botNamePrefix } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: externalId } } });
}

test.before(async () => {
  master = await prisma.user.upsert({
    where: { email: masterEmail }, update: {}, create: { name: "Master Rating Teste", email: masterEmail, role: "ADMIN" },
  });
  // Garante que avaliações globais estão ligadas para os testes de submissão.
  await prisma.botGlobalSettings.upsert({
    where: { id: "singleton" }, update: { ratingsEnabled: true }, create: { id: "singleton", ratingsEnabled: true },
  });
});
test.after(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { email: masterEmail } });
  await prisma.botGlobalSettings.update({ where: { id: "singleton" }, data: { ratingsEnabled: false } });
  await prisma.$disconnect();
});

let counter = 0;
async function seedConversation() {
  counter += 1;
  const contact = await prisma.contact.create({ data: {
    externalId: `${externalId}-${counter}`, phone: `551190001${String(counter).padStart(3, "0")}`, name: "Cliente",
  } });
  return prisma.conversation.create({ data: { contactId: contact.id } });
}

test("rating OFF no Bot rejeita a submissão (não solicita avaliação)", async () => {
  await cleanup();
  const bot = await prisma.bot.create({ data: {
    name: `${botNamePrefix} OFF`, status: "ACTIVE", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.", ratingEnabled: false,
  } });
  await assert.rejects(() => submitRating({ botId: bot.id, score: 5 }));
});

test("rating é persistido quando habilitado, e a mesma conversa não pode ser avaliada duas vezes", async () => {
  await cleanup();
  const bot = await prisma.bot.create({ data: {
    name: `${botNamePrefix} ON`, status: "ACTIVE", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.", ratingEnabled: true,
  } });
  const conversation = await seedConversation();
  const created = await submitRating({ botId: bot.id, conversationId: conversation.id, score: 5, resolvedByBot: true });
  assert.equal(created.score, 5);

  await assert.rejects(() => submitRating({ botId: bot.id, conversationId: conversation.id, score: 1 }));
});

test("nota fora de 1-5 é rejeitada", async () => {
  await cleanup();
  const bot = await prisma.bot.create({ data: {
    name: `${botNamePrefix} Faixa`, status: "ACTIVE", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.", ratingEnabled: true,
  } });
  await assert.rejects(() => submitRating({ botId: bot.id, score: 0 }));
  await assert.rejects(() => submitRating({ botId: bot.id, score: 6 }));
});

test("nota baixa não cria nenhuma sugestão de aprendizado automaticamente", async () => {
  await cleanup();
  const bot = await prisma.bot.create({ data: {
    name: `${botNamePrefix} NotaBaixa`, status: "ACTIVE", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.", ratingEnabled: true,
  } });
  const conversation = await seedConversation();
  await submitRating({ botId: bot.id, conversationId: conversation.id, score: 1, comment: "péssimo" });
  const suggestions = await prisma.botLearningSuggestion.findMany({ where: { botId: bot.id } });
  assert.equal(suggestions.length, 0);
});

test("métricas separam diagnóstico (Observação) de atendimento real (Rating) — Observação nunca conta como atendimento", async () => {
  await cleanup();
  const bot = await prisma.bot.create({ data: {
    name: `${botNamePrefix} Metricas`, status: "ACTIVE", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.", ratingEnabled: true,
  } });
  const conversation = await seedConversation();
  const message = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: `rating-metrics-${conversation.id}`, direction: "RECEBIDA",
    status: "RECEBIDA", type: "text", text: "oi", occurredAt: new Date(),
  } });
  // Só observação, sem avaliação nenhuma.
  await prisma.botObservation.create({ data: {
    conversationId: conversation.id, messageId: message.id, botId: bot.id, botName: bot.name, withinHours: true, action: "HANDOFF_HUMAN",
  } });

  const metrics = await ratings.ratingMetrics(bot.id, {}, master);
  assert.equal(metrics.interpretation.totalObserved, 1);
  assert.equal(metrics.interpretation.handoffs, 1);
  assert.equal(metrics.attendance.resolvedByBot, 0, "observação sozinha não pode contar como atendimento real");
  assert.equal(metrics.ratings.total, 0);

  await submitRating({ botId: bot.id, conversationId: conversation.id, score: 5, resolvedByBot: true });
  const metricsAfter = await ratings.ratingMetrics(bot.id, {}, master);
  assert.equal(metricsAfter.attendance.resolvedByBot, 1);
  assert.equal(metricsAfter.ratings.total, 1);
  assert.equal(metricsAfter.ratings.positivePct, null, "amostra pequena não deveria mostrar percentual");
});

test("métrica de baixa confiança respeita o limite configurado no Bot", async () => {
  await cleanup();
  const bot = await prisma.bot.create({ data: {
    name: botNamePrefix + " LimiteConfigurado", status: "ACTIVE", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    ratingEnabled: true, lowConfidenceThreshold: 0.7, highConfidenceThreshold: 0.85,
  } });
  const conversation = await seedConversation();
  const message = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: "rating-threshold-" + conversation.id, direction: "RECEBIDA",
    status: "RECEBIDA", type: "text", text: "talvez", occurredAt: new Date(),
  } });
  await prisma.botObservation.create({ data: {
    conversationId: conversation.id, messageId: message.id, botId: bot.id, botName: bot.name,
    withinHours: true, confidence: 0.6, action: "ASK_CLARIFICATION",
  } });

  const metrics = await ratings.ratingMetrics(bot.id, {}, master);
  assert.equal(metrics.interpretation.lowConfidence, 1);
});

test("submissão manual de avaliação exige Master", async () => {
  const attendant = { id: "atendente-rating-test", role: "ATENDENTE" };
  await assert.rejects(
    () => ratings.submitRating({ botId: "qualquer-id", score: 5 }, attendant),
    (error) => error.statusCode === 403,
  );
});
test("ranking ignora Bots abaixo da amostra mínima e não é enganoso com 1 avaliação", async () => {
  await cleanup();
  await prisma.botGlobalSettings.update({ where: { id: "singleton" }, data: { rankingEnabled: true, minimumRatingsForRanking: 3 } });
  const botFewRatings = await prisma.bot.create({ data: {
    name: `${botNamePrefix} PoucasAvaliacoes`, status: "ACTIVE", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.", ratingEnabled: true,
  } });
  const conversation = await seedConversation();
  await submitRating({ botId: botFewRatings.id, conversationId: conversation.id, score: 5 });

  const ranking = await ratings.getRanking(master);
  assert.equal(ranking.enabled, true);
  assert.ok(!ranking.ranked.some((entry) => entry.botId === botFewRatings.id), "Bot com 1 avaliação não deveria entrar no ranking com amostra mínima 3");
  assert.ok(ranking.excluded.some((entry) => entry.botId === botFewRatings.id));

  await prisma.botGlobalSettings.update({ where: { id: "singleton" }, data: { rankingEnabled: false, minimumRatingsForRanking: 20 } });
});

test("ranking desligado globalmente não expõe dados publicamente", async () => {
  await cleanup();
  await prisma.botGlobalSettings.update({ where: { id: "singleton" }, data: { rankingEnabled: false } });
  const result = await ratings.getRanking(master);
  assert.equal(result.enabled, false);
  assert.deepEqual(result.ranked, []);
});

test("filtros de período não quebram com ausência de dados", async () => {
  await cleanup();
  const bot = await prisma.bot.create({ data: {
    name: `${botNamePrefix} SemDados`, status: "ACTIVE", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.", ratingEnabled: true,
  } });
  for (const preset of ["today", "7d", "30d", "90d"]) {
    const metrics = await ratings.ratingMetrics(bot.id, { preset }, master);
    assert.equal(metrics.ratings.total, 0);
    assert.equal(metrics.ratings.average, null);
  }
});

test("métricas e ranking exigem conta Master", async () => {
  const attendant = { id: "atendente-rating-test", role: "ATENDENTE" };
  await assert.rejects(() => ratings.ratingMetrics("qualquer-id", {}, attendant), (error) => error.statusCode === 403);
  await assert.rejects(() => ratings.getRanking(attendant), (error) => error.statusCode === 403);
});
