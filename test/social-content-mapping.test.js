require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const mappings = require("../src/services/channels/social-content-mapping-service");

// Item 10/11 do plano Social — post/reel só vira contexto do comentário
// quando alguém cadastra manualmente (Master). Nunca inferido sozinho.
const prefix = `content-mapping-${process.pid}`;
let master;

test.before(async () => {
  master = await prisma.user.create({ data: { name: "Master Mapping Teste", email: `${prefix}@example.com`, role: "ADMIN" } });
});

test.after(async () => {
  await prisma.socialContentMapping.deleteMany({ where: { createdByUserId: master.id } });
  await prisma.user.delete({ where: { id: master.id } });
  await prisma.$disconnect();
});

test("somente Master cria/gerencia mapeamento de publicação", async () => {
  await assert.rejects(() => mappings.createMapping({ channel: "INSTAGRAM_COMMENTS", externalPostId: "post-1" }, { role: "ATENDENTE" }), (error) => {
    assert.equal(error.statusCode, 403);
    return true;
  });
});

test("rejeita canal que não é social (nunca mapeia post de WhatsApp/e-mail)", async () => {
  await assert.rejects(() => mappings.createMapping({ channel: "EMAIL", externalPostId: "thread-1" }, master), (error) => {
    assert.equal(error.statusCode, 400);
    return true;
  });
});

test("cria mapeamento e resolveForPost devolve produto/título para o comentário", async () => {
  const created = await mappings.createMapping({
    channel: "INSTAGRAM_COMMENTS", externalPostId: "post-gps-1", title: "Mibro GS Pro 2", product: "GS_PRO_2", permalink: "https://instagram.com/p/xyz",
  }, master);
  assert.equal(created.product, "GS_PRO_2");

  const resolved = await mappings.resolveForPost("INSTAGRAM_COMMENTS", "post-gps-1");
  assert.equal(resolved.title, "Mibro GS Pro 2");
  assert.equal(resolved.product, "GS_PRO_2");

  // Post não mapeado nunca inventa contexto.
  assert.equal(await mappings.resolveForPost("INSTAGRAM_COMMENTS", "post-nao-mapeado"), null);
});

test("upsert por channel+externalPostId nunca duplica o mapeamento", async () => {
  await mappings.createMapping({ channel: "FACEBOOK_COMMENTS", externalPostId: "post-dup-1", title: "Primeiro" }, master);
  await mappings.createMapping({ channel: "FACEBOOK_COMMENTS", externalPostId: "post-dup-1", title: "Atualizado" }, master);
  const count = await prisma.socialContentMapping.count({ where: { channel: "FACEBOOK_COMMENTS", externalPostId: "post-dup-1" } });
  assert.equal(count, 1);
  const resolved = await mappings.resolveForPost("FACEBOOK_COMMENTS", "post-dup-1");
  assert.equal(resolved.title, "Atualizado");
});

test("desativar mapeamento some do resultado ativo mas resolveForPost ainda o retorna com active=false", async () => {
  const created = await mappings.createMapping({ channel: "INSTAGRAM_COMMENTS", externalPostId: "post-toggle-1", title: "Toggle" }, master);
  const disabled = await mappings.setMappingActive(created.id, false, master);
  assert.equal(disabled.active, false);
  const list = await mappings.listMappings({ channel: "INSTAGRAM_COMMENTS", active: true }, master);
  assert.equal(list.some((item) => item.id === created.id), false);
  const resolved = await mappings.resolveForPost("INSTAGRAM_COMMENTS", "post-toggle-1");
  assert.equal(resolved.active, false);
});

test("remove mapeamento permanentemente", async () => {
  const created = await mappings.createMapping({ channel: "INSTAGRAM_COMMENTS", externalPostId: "post-remove-1" }, master);
  await mappings.deleteMapping(created.id, master);
  assert.equal(await mappings.resolveForPost("INSTAGRAM_COMMENTS", "post-remove-1"), null);
});
