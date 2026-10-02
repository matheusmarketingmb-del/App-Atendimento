require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const versions = require("../src/services/bot-version-service");

const botNamePrefix = "Bot Versao Teste";
const masterEmail = "master-versao-test@teste.local";
let master;

async function cleanup() {
  await prisma.bot.deleteMany({ where: { name: { startsWith: botNamePrefix } } });
}

test.before(async () => {
  master = await prisma.user.upsert({
    where: { email: masterEmail }, update: {}, create: { name: "Master Versão Teste", email: masterEmail, role: "ADMIN" },
  });
});
test.after(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { email: masterEmail } });
  await prisma.$disconnect();
});

test("cria versão v1, edita o Bot, cria v2, e restaurar v1 cria v3 idêntica à v1 (sem apagar histórico)", async () => {
  await cleanup();
  const bot = await prisma.bot.create({ data: {
    name: `${botNamePrefix} A`, status: "DRAFT", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    intents: { create: [{ name: "Rastreamento", active: true, examples: { create: [{ text: "rastrear pedido" }] } }] },
  } });

  const v1 = await versions.createVersion(bot.id, { label: "Primeira versão" }, master);
  assert.equal(v1.version, 1);

  await prisma.bot.update({ where: { id: bot.id }, data: { fallbackMessage: "Mensagem alterada." } });
  const v2 = await versions.createVersion(bot.id, { label: "Segunda versão" }, master);
  assert.equal(v2.version, 2);

  const list = await versions.listVersions(bot.id, master);
  assert.equal(list.length, 2);

  const preview = await versions.previewRestore(bot.id, 1, master);
  assert.equal(preview.current.fallbackMessage, "Mensagem alterada.");
  assert.equal(preview.target.fallbackMessage, "Não entendi.");

  const v3 = await versions.restoreVersion(bot.id, 1, {}, master);
  assert.equal(v3.version, 3, "restaurar deve criar uma versão NOVA, nunca voltar/apagar a v2");
  assert.equal(v3.restoredFromVersion, 1);

  const listAfter = await versions.listVersions(bot.id, master);
  assert.equal(listAfter.length, 3, "histórico de versões nunca é apagado");

  const botAfter = await prisma.bot.findUnique({ where: { id: bot.id } });
  assert.equal(botAfter.fallbackMessage, "Não entendi.", "o conteúdo real deveria voltar ao da v1");

  const auditEntries = await prisma.auditLog.count({ where: { action: "BOT_VERSION_RESTORED", entityId: bot.id } });
  assert.ok(auditEntries >= 1, "restaurar versão deveria gerar auditoria");
});

test("restaurar versão substitui intenções pelo snapshot antigo", async () => {
  await cleanup();
  const bot = await prisma.bot.create({ data: {
    name: `${botNamePrefix} B`, status: "DRAFT", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    intents: { create: [{ name: "Intenção Original", active: true, examples: { create: [{ text: "exemplo original" }] } }] },
  } });
  await versions.createVersion(bot.id, {}, master);

  await prisma.botIntent.deleteMany({ where: { botId: bot.id } });
  await prisma.botIntent.create({ data: { botId: bot.id, name: "Intenção Nova", active: true } });

  await versions.restoreVersion(bot.id, 1, {}, master);
  const intents = await prisma.botIntent.findMany({ where: { botId: bot.id } });
  assert.equal(intents.length, 1);
  assert.equal(intents[0].name, "Intenção Original");
});

test("versionamento exige conta Master", async () => {
  const attendant = { id: "atendente-versao-test", role: "ATENDENTE" };
  await assert.rejects(() => versions.createVersion("qualquer-id", {}, attendant), (error) => error.statusCode === 403);
  await assert.rejects(() => versions.listVersions("qualquer-id", attendant), (error) => error.statusCode === 403);
});
