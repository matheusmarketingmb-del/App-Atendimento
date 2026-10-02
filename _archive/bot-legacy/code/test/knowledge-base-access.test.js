require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const prisma = require("../src/database/prisma");
const knowledge = require("../src/services/bot-knowledge-source-service");
const { KnowledgeSourceProvider } = require("../src/services/bot-knowledge/knowledge-provider");

const prefix = "KB Acesso Teste";
const masterEmail = "master-kb-access@teste.local";
let master;
let botA;
let botB;

async function createTestBot(name) {
  return prisma.bot.create({
    data: {
      name,
      channel: "META",
      initialMessage: "Olá",
      outsideHoursMessage: "Fora do horário",
      fallbackMessage: "Não entendi",
    },
  });
}

test.before(async () => {
  await prisma.knowledgeSource.deleteMany({ where: { title: { startsWith: prefix } } });
  await prisma.bot.deleteMany({ where: { name: { startsWith: prefix } } });
  master = await prisma.user.upsert({
    where: { email: masterEmail },
    update: {},
    create: { name: "Master KB Acesso", email: masterEmail, role: "ADMIN" },
  });
  botA = await createTestBot(prefix + " Bot A");
  botB = await createTestBot(prefix + " Bot B");
});

test.after(async () => {
  await prisma.knowledgeSource.deleteMany({ where: { title: { startsWith: prefix } } });
  await prisma.bot.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.user.deleteMany({ where: { email: masterEmail } });
  await prisma.$disconnect();
});

test("fonte pode ser global ou compartilhada com vários Bots", async () => {
  const selected = await knowledge.createKnowledgeSource({
    title: prefix + " Compartilhada",
    type: "PRODUCT",
    source: "Manual oficial",
    content: "Informação do relógio compartilhada.",
    botIds: [botA.id, botB.id, botA.id],
  }, master);
  assert.equal(selected.accessMode, "SELECTED");
  assert.deepEqual(new Set(selected.botIds), new Set([botA.id, botB.id]));

  const global = await knowledge.createKnowledgeSource({
    title: prefix + " Global",
    type: "GENERAL",
    source: "Catálogo oficial",
    content: "Informação geral para todos.",
    botIds: [],
  }, master);
  assert.equal(global.accessMode, "ALL");
  assert.deepEqual(global.botIds, []);

  const visibleForB = await knowledge.listKnowledgeSources({ botId: botB.id }, master);
  assert.ok(visibleForB.some((item) => item.id === selected.id));
  assert.ok(visibleForB.some((item) => item.id === global.id));
});

test("filtro vazio mostra fontes ativas e inativas; filtros explícitos respeitam o status", async () => {
  const inactive = await knowledge.createKnowledgeSource({
    title: prefix + " Inativa",
    type: "GENERAL",
    source: "Manual",
    active: false,
    botIds: [],
  }, master);
  const all = await knowledge.listKnowledgeSources({ active: "" }, master);
  const activeOnly = await knowledge.listKnowledgeSources({ active: "true" }, master);
  assert.ok(all.some((item) => item.id === inactive.id));
  assert.ok(!activeOnly.some((item) => item.id === inactive.id));
});
test("alterar os Bots substitui o acesso anterior sem deixar vínculo residual", async () => {
  const created = await knowledge.createKnowledgeSource({
    title: prefix + " Alteração",
    type: "MANUAL",
    source: "Manual oficial",
    content: "Conteúdo controlado.",
    botIds: [botA.id, botB.id],
  }, master);
  const updated = await knowledge.updateKnowledgeSource(created.id, { botIds: [botB.id] }, master);
  assert.deepEqual(updated.botIds, [botB.id]);

  const links = await prisma.knowledgeSourceBot.findMany({ where: { knowledgeSourceId: created.id } });
  assert.deepEqual(links.map((link) => link.botId), [botB.id]);
});

test("provider entrega fonte restrita apenas aos Bots selecionados e mantém globais", async () => {
  const token = "velocimetroquartzx";
  await knowledge.createKnowledgeSource({
    title: prefix + " Restrita " + token,
    type: "PRODUCT",
    source: "Manual oficial",
    content: token + " exclusivo do Bot A",
    botIds: [botA.id],
  }, master);
  await knowledge.createKnowledgeSource({
    title: prefix + " Pública " + token,
    type: "GENERAL",
    source: "Catálogo oficial",
    content: token + " disponível para todos",
    botIds: [],
  }, master);

  const provider = new KnowledgeSourceProvider();
  const resultsA = await provider.search(token, { botId: botA.id, minScore: 0.1 });
  const resultsB = await provider.search(token, { botId: botB.id, minScore: 0.1 });
  assert.ok(resultsA.some((item) => item.title.includes("Restrita")));
  assert.ok(resultsA.some((item) => item.title.includes("Pública")));
  assert.ok(!resultsB.some((item) => item.title.includes("Restrita")));
  assert.ok(resultsB.some((item) => item.title.includes("Pública")));
});

test("rejeita Bot inexistente ou arquivado na configuração de acesso", async () => {
  await assert.rejects(() => knowledge.createKnowledgeSource({
    title: prefix + " Inválida",
    type: "FAQ",
    source: "Manual",
    botIds: ["bot-inexistente"],
  }, master), /não existem ou estão arquivados/);
});

test("tela geral contém cadastro, filtros e seleção de acesso e a rota é Master-only", () => {
  const html = fs.readFileSync(path.join(process.cwd(), "public", "knowledge-base.html"), "utf8");
  const js = fs.readFileSync(path.join(process.cwd(), "public", "js", "knowledge-base.js"), "utf8");
  const app = fs.readFileSync(path.join(process.cwd(), "src", "app.js"), "utf8");
  assert.match(html, /id="knowledge-content"/);
  assert.match(html, /id="knowledge-access-mode"/);
  assert.match(html, /id="knowledge-bots-checklist"/);
  assert.match(html, /id="knowledge-filter-bot"/);
  assert.match(js, /botIds:/);
  assert.match(js, /Selecione ao menos um Bot/);
  assert.ok(app.includes('app.get(["/knowledge-base", "/knowledge-base.html"], requireMasterPage'));
});
