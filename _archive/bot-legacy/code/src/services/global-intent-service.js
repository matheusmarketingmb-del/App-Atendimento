// Item 1: Biblioteca Global de Intenções. Separa significado + exemplos
// compartilhados (GlobalIntent/GlobalIntentExample) da configuração
// bot-específica (BotIntent: prioridade, resposta, categoria, ação — que já
// existia e continua sendo o que o motor de interpretação/decisão/resposta
// usa sem nenhuma mudança de comportamento). Associar/desassociar um Bot
// nunca apaga a GlobalIntent nem seus exemplos compartilhados.
const prisma = require("../database/prisma");
const audit = require("./audit-service");
const { assertBotManager, fail, getGlobalSettings } = require("./bot-governance-service");
const { normalizeText } = require("./bot-simulator-service");

function requiredText(value, label, max = 200) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw fail(`${label} é obrigatório.`);
  if (text.length > max) throw fail(`${label} deve ter no máximo ${max} caracteres.`);
  return text;
}

function optionalText(value, label, max = 2000) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (text.length > max) throw fail(`${label} deve ter no máximo ${max} caracteres.`);
  return text;
}

function normalizeExamples(examples) {
  if (examples === undefined) return undefined;
  if (!Array.isArray(examples)) throw fail("Exemplos devem ser uma lista de textos.");
  const seen = new Set();
  const result = [];
  for (const raw of examples) {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) continue;
    const key = normalizeText(text);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

async function assertLibraryEnabled() {
  const settings = await getGlobalSettings();
  if (!settings.intentLibraryEnabled) {
    throw fail("A Biblioteca Global de Intenções está desativada nas configurações de Bots.", 409);
  }
}

// Lista com a contagem de Bots que usam cada GlobalIntent (item 1: "mostrar
// contagem de bots usando cada intenção").
async function listGlobalIntents(viewer) {
  assertBotManager(viewer);
  const intents = await prisma.globalIntent.findMany({
    include: {
      examples: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      _count: { select: { botIntents: true } },
      botIntents: { select: { id: true, botId: true, active: true, bot: { select: { id: true, name: true } } } },
    },
    orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
  });
  return intents.map((intent) => ({
    ...intent,
    botsUsingCount: intent._count.botIntents,
    associations: intent.botIntents.map((assoc) => ({
      botIntentId: assoc.id, botId: assoc.botId, botName: assoc.bot.name, active: assoc.active,
    })),
  }));
}

async function getGlobalIntent(id, viewer) {
  assertBotManager(viewer);
  const intent = await prisma.globalIntent.findUnique({
    where: { id },
    include: { examples: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] }, _count: { select: { botIntents: true } } },
  });
  if (!intent) throw fail("Intenção global não encontrada.", 404);
  return intent;
}

async function createGlobalIntent(data, actor) {
  assertBotManager(actor);
  await assertLibraryEnabled();
  const name = requiredText(data.name, "Nome da intenção", 100);
  const description = optionalText(data.description, "Descrição", 1000);
  const active = data.active === undefined ? true : Boolean(data.active);
  const examples = normalizeExamples(data.examples) || [];

  return prisma.$transaction(async (transaction) => {
    const intent = await transaction.globalIntent.create({
      data: { name, description, active, examples: { create: examples.map((text) => ({ text })) } },
      include: { examples: true },
    });
    await audit.recordAudit({
      actor, action: "GLOBAL_INTENT_CREATED", entityType: "BOT", entityId: null,
      summary: `Criou a intenção global "${intent.name}"`, details: { globalIntentId: intent.id },
    }, transaction);
    return intent;
  });
}

async function updateGlobalIntent(id, data, actor) {
  assertBotManager(actor);
  const existing = await getGlobalIntent(id, actor);
  const update = {};
  if (data.name !== undefined) update.name = requiredText(data.name, "Nome da intenção", 100);
  if (data.description !== undefined) update.description = optionalText(data.description, "Descrição", 1000);
  if (data.active !== undefined) update.active = Boolean(data.active);
  const examples = normalizeExamples(data.examples);
  if (!Object.keys(update).length && examples === undefined) throw fail("Informe ao menos um campo para atualizar.");

  return prisma.$transaction(async (transaction) => {
    if (examples !== undefined) {
      await transaction.globalIntentExample.deleteMany({ where: { globalIntentId: id } });
    }
    const intent = await transaction.globalIntent.update({
      where: { id },
      data: { ...update, ...(examples !== undefined ? { examples: { create: examples.map((text) => ({ text })) } } : {}) },
      include: { examples: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
    });
    await audit.recordAudit({
      actor, action: "GLOBAL_INTENT_UPDATED", entityType: "BOT", entityId: null,
      summary: `Alterou a intenção global "${intent.name}"`,
      details: { globalIntentId: id, before: { name: existing.name }, after: { name: intent.name } },
    }, transaction);
    return intent;
  });
}

// Associa uma GlobalIntent já existente a um Bot: cria a BotIntent (a
// "associação" com priority/response/category/action bot-específicos),
// copiando name/description/exemplos da GlobalIntent para o motor de
// interpretação continuar funcionando exatamente como hoje.
async function associateGlobalIntentToBot(botId, globalIntentId, data = {}, actor) {
  assertBotManager(actor);
  await assertLibraryEnabled();
  const globalIntent = await getGlobalIntent(globalIntentId, actor);
  const bot = await prisma.bot.findUnique({ where: { id: botId } });
  if (!bot) throw fail("Bot não encontrado.", 404);

  const existingAssociation = await prisma.botIntent.findFirst({ where: { botId, globalIntentId } });
  if (existingAssociation) throw fail("Este Bot já está associado a esta intenção global.", 409);

  const priority = data.priority === undefined ? 0 : Number(data.priority);
  if (!Number.isInteger(priority)) throw fail("Prioridade deve ser um número inteiro.");
  const responseMessage = optionalText(data.responseMessage, "Mensagem de resposta", 4000);
  const categoryId = data.categoryId || null;
  const fallbackAction = data.fallbackAction || "USE_BOT_FALLBACK";
  const toolName = data.toolName || null;

  return prisma.$transaction(async (transaction) => {
    const botIntent = await transaction.botIntent.create({
      data: {
        botId,
        globalIntentId,
        name: globalIntent.name,
        description: globalIntent.description,
        responseMessage,
        priority,
        active: true,
        fallbackAction,
        categoryId,
        toolName,
        examples: { create: globalIntent.examples.map((example) => ({ text: example.text })) },
      },
      include: { examples: true, globalIntent: true },
    });
    await audit.recordAudit({
      actor, action: "BOT_INTENT_ASSOCIATED", entityType: "BOT", entityId: botId,
      summary: `Associou a intenção global "${globalIntent.name}" ao Bot ${bot.name}`,
      details: { globalIntentId, botIntentId: botIntent.id },
    }, transaction);
    return botIntent;
  });
}

// Remove a associação de um Bot (deleta só a BotIntent) SEM apagar a
// GlobalIntent nem os exemplos compartilhados — item 1.
async function disassociateBotIntent(botId, botIntentId, actor) {
  assertBotManager(actor);
  const botIntent = await prisma.botIntent.findFirst({ where: { id: botIntentId, botId } });
  if (!botIntent) throw fail("Associação não encontrada.", 404);
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { name: true } });

  return prisma.$transaction(async (transaction) => {
    await transaction.botIntent.delete({ where: { id: botIntentId } });
    await audit.recordAudit({
      actor, action: "BOT_INTENT_DISASSOCIATED", entityType: "BOT", entityId: botId,
      summary: `Removeu a associação da intenção com o Bot ${bot?.name || botId}`,
      details: { globalIntentId: botIntent.globalIntentId, botIntentId },
    }, transaction);
    return { deleted: true };
  });
}

// Item 1 (aprendizado supervisionado): adiciona um exemplo aprovado à
// GlobalIntent (deduplicado por texto normalizado) e propaga para as
// BotIntentExample de TODOS os Bots associados a essa GlobalIntent — assim
// todos se beneficiam imediatamente, sem esperar retraining por Bot, porque
// o motor de correspondência (local-fallback-provider) lê BotIntentExample.
async function addExampleToGlobalIntent(globalIntentId, text, client = prisma) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed || !globalIntentId) return { added: false };
  const normalized = normalizeText(trimmed);

  const existingGlobalExamples = await client.globalIntentExample.findMany({ where: { globalIntentId }, select: { text: true } });
  const alreadyGlobal = existingGlobalExamples.some((example) => normalizeText(example.text) === normalized);
  if (!alreadyGlobal) {
    await client.globalIntentExample.create({ data: { globalIntentId, text: trimmed } });
  }

  const botIntents = await client.botIntent.findMany({ where: { globalIntentId }, select: { id: true } });
  for (const botIntent of botIntents) {
    const existing = await client.botIntentExample.findMany({ where: { intentId: botIntent.id }, select: { text: true } });
    const alreadyThere = existing.some((example) => normalizeText(example.text) === normalized);
    if (!alreadyThere) {
      await client.botIntentExample.create({ data: { intentId: botIntent.id, text: trimmed } });
    }
  }

  return { added: true, propagatedToBots: botIntents.length };
}

module.exports = {
  addExampleToGlobalIntent,
  associateGlobalIntentToBot,
  createGlobalIntent,
  disassociateBotIntent,
  getGlobalIntent,
  listGlobalIntents,
  updateGlobalIntent,
};
