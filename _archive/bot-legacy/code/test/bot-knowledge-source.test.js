require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const knowledge = require("../src/services/bot-knowledge-source-service");

const masterEmail = "master-knowledge-test@teste.local";
let master;

test.before(async () => {
  master = await prisma.user.upsert({
    where: { email: masterEmail }, update: {}, create: { name: "Master Conhecimento Teste", email: masterEmail, role: "ADMIN" },
  });
});
test.after(async () => {
  await prisma.knowledgeSource.deleteMany({ where: { title: { startsWith: "Fonte Teste" } } });
  await prisma.user.deleteMany({ where: { email: masterEmail } });
  await prisma.$disconnect();
});

test("cria, edita (incrementa versão) e calcula activeNow considerando janela de validade", async () => {
  const created = await knowledge.createKnowledgeSource({
    title: "Fonte Teste Garantia", type: "WARRANTY", source: "Manual interno", content: "Política de garantia de 1 ano.",
  }, master);
  assert.equal(created.version, 1);
  assert.equal(created.activeNow, true);

  const updated = await knowledge.updateKnowledgeSource(created.id, { content: "Política de garantia de 2 anos." }, master);
  assert.equal(updated.version, 2);

  const expired = await knowledge.createKnowledgeSource({
    title: "Fonte Teste Expirada", type: "POLICY", source: "Manual interno", validUntil: new Date(Date.now() - 24 * 60 * 60 * 1000),
  }, master);
  assert.equal(expired.activeNow, false, "fonte com validUntil no passado não deveria estar ativa agora");

  const future = await knowledge.createKnowledgeSource({
    title: "Fonte Teste Futura", type: "FAQ", source: "Manual interno", validFrom: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }, master);
  assert.equal(future.activeNow, false, "fonte com validFrom no futuro ainda não deveria estar ativa");
});

test("rejeita validFrom depois de validUntil e tipo inválido", async () => {
  await assert.rejects(() => knowledge.createKnowledgeSource({
    title: "Fonte Teste Inválida", type: "FAQ", source: "Manual interno",
    validFrom: new Date("2030-01-01"), validUntil: new Date("2020-01-01"),
  }, master));
  await assert.rejects(() => knowledge.createKnowledgeSource({ title: "Fonte Teste Tipo", type: "INVALIDO", source: "Manual interno" }, master));
});

test("rejeita fonte de conhecimento sem origem (source)", async () => {
  await assert.rejects(() => knowledge.createKnowledgeSource({ title: "Fonte Teste Sem Origem", type: "FAQ" }, master));
});

test("deletar remove a fonte e registra auditoria", async () => {
  const created = await knowledge.createKnowledgeSource({ title: "Fonte Teste Remover", type: "MANUAL", source: "Manual interno" }, master);
  await knowledge.deleteKnowledgeSource(created.id, master);
  const remaining = await prisma.knowledgeSource.findUnique({ where: { id: created.id } });
  assert.equal(remaining, null);
});

test("exige conta Master", async () => {
  const attendant = { id: "atendente-knowledge-test", role: "ATENDENTE" };
  await assert.rejects(() => knowledge.createKnowledgeSource({ title: "X", type: "FAQ", source: "Manual interno" }, attendant), (error) => error.statusCode === 403);
});
