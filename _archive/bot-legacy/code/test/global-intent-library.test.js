require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const globalIntents = require("../src/services/global-intent-service");
const learning = require("../src/services/bot-learning-service");

const botNamePrefix = "Bot Biblioteca Teste";
const globalIntentNamePrefix = "Intenção Global Teste";
const masterEmail = "master-global-intent-test@teste.local";
let master;

async function cleanup() {
  await prisma.botLearningSuggestion.deleteMany({ where: { title: { contains: "Biblioteca Teste" } } });
  await prisma.bot.deleteMany({ where: { name: { startsWith: botNamePrefix } } });
  await prisma.globalIntent.deleteMany({ where: { name: { startsWith: globalIntentNamePrefix } } });
}

test.before(async () => {
  master = await prisma.user.upsert({
    where: { email: masterEmail }, update: {},
    create: { name: "Master Biblioteca Teste", email: masterEmail, role: "ADMIN" },
  });
});
test.after(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { email: masterEmail } });
  await prisma.$disconnect();
});

async function createBot(name) {
  return prisma.bot.create({
    data: {
      name, status: "ACTIVE", channel: "META",
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    },
  });
}

test("dois Bots compartilham a mesma intenção global sem duplicar significado/exemplos", async () => {
  await cleanup();
  const globalIntent = await globalIntents.createGlobalIntent({
    name: `${globalIntentNamePrefix} Pedido`, description: "Cliente quer saber do pedido.",
    examples: ["onde esta meu pedido", "cade minha encomenda"],
  }, master);

  const botA = await createBot(`${botNamePrefix} A`);
  const botB = await createBot(`${botNamePrefix} B`);

  const assocA = await globalIntents.associateGlobalIntentToBot(botA.id, globalIntent.id, { responseMessage: "Resposta do Bot A." }, master);
  const assocB = await globalIntents.associateGlobalIntentToBot(botB.id, globalIntent.id, { responseMessage: "Resposta do Bot B." }, master);

  assert.equal(assocA.globalIntentId, globalIntent.id);
  assert.equal(assocB.globalIntentId, globalIntent.id);
  // Cada associação guarda a config bot-específica (resposta), mas o
  // significado/exemplos vieram da mesma GlobalIntent.
  assert.equal(assocA.responseMessage, "Resposta do Bot A.");
  assert.equal(assocB.responseMessage, "Resposta do Bot B.");
  const examplesA = await prisma.botIntentExample.findMany({ where: { intentId: assocA.id } });
  const examplesB = await prisma.botIntentExample.findMany({ where: { intentId: assocB.id } });
  assert.equal(examplesA.length, 2);
  assert.equal(examplesB.length, 2);

  const listed = await globalIntents.listGlobalIntents(master);
  const found = listed.find((item) => item.id === globalIntent.id);
  assert.equal(found.botsUsingCount, 2, "a listagem deveria mostrar quantos Bots usam a intenção");
});

test("um Bot não pode se associar duas vezes à mesma intenção global", async () => {
  await cleanup();
  const globalIntent = await globalIntents.createGlobalIntent({ name: `${globalIntentNamePrefix} Duplicada` }, master);
  const bot = await createBot(`${botNamePrefix} Duplicado`);
  await globalIntents.associateGlobalIntentToBot(bot.id, globalIntent.id, {}, master);
  await assert.rejects(() => globalIntents.associateGlobalIntentToBot(bot.id, globalIntent.id, {}, master));
});

test("aprovar um exemplo novo melhora a intenção global e se propaga para todos os Bots associados", async () => {
  await cleanup();
  const globalIntent = await globalIntents.createGlobalIntent({
    name: `${globalIntentNamePrefix} Propagação`, examples: ["quero rastrear meu pedido"],
  }, master);
  const botA = await createBot(`${botNamePrefix} Propagação A`);
  const botB = await createBot(`${botNamePrefix} Propagação B`);
  const assocA = await globalIntents.associateGlobalIntentToBot(botA.id, globalIntent.id, {}, master);
  const assocB = await globalIntents.associateGlobalIntentToBot(botB.id, globalIntent.id, {}, master);

  const suggestion = await prisma.botLearningSuggestion.create({
    data: {
      botId: botA.id, intentId: assocA.id, type: "INTENT_EXAMPLE", status: "PENDING",
      title: "Biblioteca Teste: novo exemplo", suggestedContent: "onde esta minha encomenda",
    },
  });

  await learning.approveSuggestion(suggestion.id, {}, master);

  const globalExamples = await prisma.globalIntentExample.findMany({ where: { globalIntentId: globalIntent.id } });
  assert.ok(globalExamples.some((example) => example.text === "onde esta minha encomenda"), "o exemplo aprovado deveria entrar na GlobalIntent");

  const examplesA = await prisma.botIntentExample.findMany({ where: { intentId: assocA.id } });
  const examplesB = await prisma.botIntentExample.findMany({ where: { intentId: assocB.id } });
  assert.ok(examplesA.some((example) => example.text === "onde esta minha encomenda"), "Bot A (quem gerou a sugestão) deveria ganhar o exemplo");
  assert.ok(examplesB.some((example) => example.text === "onde esta minha encomenda"), "Bot B (só associado) também deveria ganhar o exemplo, sem precisar de retraining manual");
});

test("aprovar o mesmo exemplo duas vezes não duplica (dedupe por texto normalizado)", async () => {
  await cleanup();
  const globalIntent = await globalIntents.createGlobalIntent({ name: `${globalIntentNamePrefix} Dedupe` }, master);
  const bot = await createBot(`${botNamePrefix} Dedupe`);
  const assoc = await globalIntents.associateGlobalIntentToBot(bot.id, globalIntent.id, {}, master);

  const suggestion1 = await prisma.botLearningSuggestion.create({
    data: { botId: bot.id, intentId: assoc.id, type: "INTENT_EXAMPLE", status: "PENDING", title: "Biblioteca Teste: dedupe", suggestedContent: "Quero Saber Do Meu Pedido" },
  });
  await learning.approveSuggestion(suggestion1.id, {}, master);

  const suggestion2 = await prisma.botLearningSuggestion.create({
    data: { botId: bot.id, intentId: assoc.id, type: "INTENT_EXAMPLE", status: "PENDING", title: "Biblioteca Teste: dedupe 2", suggestedContent: "quero saber do meu pedido" },
  });
  await learning.approveSuggestion(suggestion2.id, {}, master);

  const globalExamples = await prisma.globalIntentExample.findMany({ where: { globalIntentId: globalIntent.id } });
  const matches = globalExamples.filter((example) => example.text.toLowerCase().includes("quero saber do meu pedido"));
  assert.equal(matches.length, 1, "textos equivalentes (case/pontuação) não deveriam duplicar o exemplo global");
});

test("remover a associação de um Bot NUNCA apaga a intenção global nem seus exemplos", async () => {
  await cleanup();
  const globalIntent = await globalIntents.createGlobalIntent({
    name: `${globalIntentNamePrefix} Remoção`, examples: ["quero trocar um produto"],
  }, master);
  const botA = await createBot(`${botNamePrefix} Remoção A`);
  const botB = await createBot(`${botNamePrefix} Remoção B`);
  const assocA = await globalIntents.associateGlobalIntentToBot(botA.id, globalIntent.id, {}, master);
  await globalIntents.associateGlobalIntentToBot(botB.id, globalIntent.id, {}, master);

  await globalIntents.disassociateBotIntent(botA.id, assocA.id, master);

  const stillThere = await prisma.globalIntent.findUnique({ where: { id: globalIntent.id }, include: { examples: true } });
  assert.ok(stillThere, "a GlobalIntent deveria continuar existindo");
  assert.equal(stillThere.examples.length, 1, "os exemplos globais não deveriam ser apagados");

  const removedAssociation = await prisma.botIntent.findUnique({ where: { id: assocA.id } });
  assert.equal(removedAssociation, null, "a associação (BotIntent) do Bot A deveria ter sumido");

  const listed = await globalIntents.listGlobalIntents(master);
  const found = listed.find((item) => item.id === globalIntent.id);
  assert.equal(found.botsUsingCount, 1, "só o Bot B deveria continuar contando como associado");
});

test("exige conta Master para todas as operações de biblioteca", async () => {
  const attendant = { id: "atendente-global-intent-test", role: "ATENDENTE" };
  await assert.rejects(() => globalIntents.createGlobalIntent({ name: "X" }, attendant), (error) => error.statusCode === 403);
  await assert.rejects(() => globalIntents.listGlobalIntents(attendant), (error) => error.statusCode === 403);
});
