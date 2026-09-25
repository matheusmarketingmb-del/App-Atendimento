require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const quickReplies = require("../src/services/quick-reply-service");

const namePrefix = "QR Teste";
let master;
let agent;
let agentConversation;

async function cleanup() {
  await prisma.quickReplyUsage.deleteMany({});
  await prisma.quickReplyFavorite.deleteMany({});
  await prisma.quickReplyIntent.deleteMany({});
  await prisma.quickReply.deleteMany({ where: { name: { startsWith: namePrefix } } });
  await prisma.conversation.deleteMany({ where: { contact: { is: { externalId: { startsWith: "qr-" } } } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: "qr-" } } });
}

test.before(async () => {
  master = await prisma.user.upsert({
    where: { email: "qr-master@teste.local" }, update: {},
    create: { email: "qr-master@teste.local", name: "Master QR", role: "ADMIN", passwordHash: "x" },
  });
  agent = await prisma.user.upsert({
    where: { email: "qr-agent@teste.local" }, update: {},
    create: { email: "qr-agent@teste.local", name: "Atendente QR", role: "ATENDENTE", passwordHash: "x" },
  });
  await cleanup();
  const contact = await prisma.contact.create({ data: { externalId: "qr-agent-context", phone: "5511900000098", channel: "META" } });
  agentConversation = await prisma.conversation.create({ data: { contactId: contact.id, channel: "META", assignedUserId: agent.id } });
});

test.after(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { email: { in: ["qr-master@teste.local", "qr-agent@teste.local"] } } });
  await prisma.$disconnect();
});

test("Master cria resposta rápida com nome, atalho e texto", async () => {
  const created = await quickReplies.createQuickReply({
    name: `${namePrefix} Pedido`, shortcut: "/qrpedido", text: "Pode me informar o número do pedido?",
  }, master);
  assert.equal(created.shortcut, "/qrpedido");
  assert.equal(created.active, true);
  assert.equal(created.type, "QUICK_REPLY");
  assert.equal(created.createdBy.id, master.id);
});

test("Atendente não pode criar/editar a resposta global (só Master)", async () => {
  await assert.rejects(() => quickReplies.createQuickReply({
    name: `${namePrefix} Bloqueado`, shortcut: "/qrbloqueado", text: "x",
  }, agent), (error) => { assert.equal(error.statusCode, 403); return true; });

  const created = await quickReplies.createQuickReply({
    name: `${namePrefix} Editar`, shortcut: "/qreditar", text: "x",
  }, master);
  await assert.rejects(() => quickReplies.updateQuickReply(created.id, { text: "y" }, agent), (error) => {
    assert.equal(error.statusCode, 403);
    return true;
  });
});

test("atalho duplicado entre respostas ativas é rejeitado no backend", async () => {
  await quickReplies.createQuickReply({ name: `${namePrefix} A`, shortcut: "/qrdup", text: "x" }, master);
  await assert.rejects(() => quickReplies.createQuickReply({
    name: `${namePrefix} B`, shortcut: "/qrdup", text: "y",
  }, master), /já está em uso/);
});

test("atalho de resposta arquivada pode ser reutilizado", async () => {
  const original = await quickReplies.createQuickReply({ name: `${namePrefix} C`, shortcut: "/qrreuso", text: "x" }, master);
  await quickReplies.archiveQuickReply(original.id, master);
  const reused = await quickReplies.createQuickReply({ name: `${namePrefix} D`, shortcut: "/qrreuso", text: "y" }, master);
  assert.equal(reused.shortcut, "/qrreuso");
});

test("atalho inválido (sem /, com espaço ou script) é rejeitado", async () => {
  for (const shortcut of ["pedido", "/pedido ok", "/<script>", "/PEDIDO com espaço"]) {
    await assert.rejects(() => quickReplies.createQuickReply({
      name: `${namePrefix} Inválido`, shortcut, text: "x",
    }, master), /Atalho inválido/);
  }
});

test("texto sanitiza HTML arbitrário mas preserva quebras de linha", async () => {
  const created = await quickReplies.createQuickReply({
    name: `${namePrefix} Multi`, shortcut: "/qrmulti", text: "<script>alert(1)</script>Linha 1\nLinha 2\nLinha 3",
  }, master);
  assert.equal(created.text.includes("<script>"), false);
  assert.equal(created.text, "alert(1)Linha 1\nLinha 2\nLinha 3");
});

test("busca considera nome, atalho, texto e categoria", async () => {
  await quickReplies.createQuickReply({ name: `${namePrefix} Rastreio`, shortcut: "/qrrastreio", text: "Rastreio do pedido" }, master);
  const results = await quickReplies.listQuickReplies({ search: "rastreio" }, master);
  assert.ok(results.some((item) => item.shortcut === "/qrrastreio"));
});

test("filtro por categoria/setor: resposta sem setor aparece para todos; com setor só aparece para o setor certo", async () => {
  const category = await prisma.category.findUniqueOrThrow({ where: { code: "PEDIDOS" } });
  const otherCategory = await prisma.category.findUniqueOrThrow({ where: { code: "SUPORTE" } });
  const generic = await quickReplies.createQuickReply({ name: `${namePrefix} Genérica`, shortcut: "/qrgenerica", text: "x" }, master);
  const sectorized = await quickReplies.createQuickReply({
    name: `${namePrefix} Setorizada`, shortcut: "/qrsetor", text: "x", categoryId: category.id,
  }, master);

  const contactRight = await prisma.contact.create({ data: { externalId: "qr-sector-contact-right", phone: "5511900000000", channel: "META" } });
  const conversationRight = await prisma.conversation.create({ data: { contactId: contactRight.id, channel: "META", categoryId: category.id } });
  const contactWrong = await prisma.contact.create({ data: { externalId: "qr-sector-contact-wrong", phone: "5511900000003", channel: "META" } });
  const conversationWrong = await prisma.conversation.create({ data: { contactId: contactWrong.id, channel: "META", categoryId: otherCategory.id } });

  const listedRight = await quickReplies.listForComposer({ conversationId: conversationRight.id }, master);
  const listedWrong = await quickReplies.listForComposer({ conversationId: conversationWrong.id }, master);

  assert.ok(listedRight.some((item) => item.id === generic.id), "genérica aparece no setor certo");
  assert.ok(listedRight.some((item) => item.id === sectorized.id), "setorizada aparece no próprio setor");
  assert.ok(listedWrong.some((item) => item.id === generic.id), "genérica aparece em qualquer setor");
  assert.ok(!listedWrong.some((item) => item.id === sectorized.id), "setorizada NÃO aparece em outro setor");
});

test("uma resposta aceita várias categorias e a categoria principal inclui suas subcategorias", async () => {
  const suffix = Date.now().toString(36);
  const parent = await prisma.category.create({ data: { code: `QR_PARENT_${suffix}`, name: `${namePrefix} Principal ${suffix}`, color: "#ef5b2a" } });
  const child = await prisma.category.create({ data: { code: `QR_CHILD_${suffix}`, name: `${namePrefix} Sub ${suffix}`, parentId: parent.id, color: "#ef5b2a" } });
  const extra = await prisma.category.create({ data: { code: `QR_EXTRA_${suffix}`, name: `${namePrefix} Extra ${suffix}`, color: "#ef5b2a" } });
  const outside = await prisma.category.create({ data: { code: `QR_OUT_${suffix}`, name: `${namePrefix} Fora ${suffix}`, color: "#ef5b2a" } });
  try {
    const created = await quickReplies.createQuickReply({
      name: `${namePrefix} Multicategoria ${suffix}`, shortcut: `/qrmulti_${suffix}`, text: "x",
      categoryIds: [parent.id, extra.id],
    }, master);
    assert.deepEqual(new Set(created.categoryIds), new Set([parent.id, extra.id]));
    const makeConversation = async (label, categoryId) => {
      const contact = await prisma.contact.create({
        data: { externalId: `qr-multi-${suffix}-${label}`, phone: `55${Date.now()}${label.length}`, channel: "META" },
      });
      return prisma.conversation.create({ data: { contactId: contact.id, channel: "META", categoryId } });
    };
    const childConversation = await makeConversation("child", child.id);
    const extraConversation = await makeConversation("extra", extra.id);
    const outsideConversation = await makeConversation("outside", outside.id);
    assert.ok((await quickReplies.listForComposer({ conversationId: childConversation.id }, master)).some((item) => item.id === created.id));
    assert.ok((await quickReplies.listForComposer({ conversationId: extraConversation.id }, master)).some((item) => item.id === created.id));
    assert.ok(!(await quickReplies.listForComposer({ conversationId: outsideConversation.id }, master)).some((item) => item.id === created.id));
  } finally {
    await prisma.conversation.deleteMany({ where: { contact: { is: { externalId: { startsWith: `qr-multi-${suffix}-` } } } } });
    await prisma.contact.deleteMany({ where: { externalId: { startsWith: `qr-multi-${suffix}-` } } });
    await prisma.quickReply.deleteMany({ where: { name: { contains: suffix } } });
    await prisma.category.deleteMany({ where: { id: { in: [child.id, extra.id, outside.id, parent.id] } } });
  }
});

test("filtro por canal: resposta restrita a um canal não aparece em conversa de outro canal", async () => {
  const restricted = await quickReplies.createQuickReply({
    name: `${namePrefix} Canal`, shortcut: "/qrcanal", text: "x", channels: ["EMAIL"],
  }, master);
  const contact = await prisma.contact.create({ data: { externalId: "qr-channel-contact", phone: "5511900000001", channel: "META" } });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id, channel: "META" } });

  const listed = await quickReplies.listForComposer({ conversationId: conversation.id }, master);
  assert.ok(!listed.some((item) => item.id === restricted.id));
});

test("favorito é por usuário, não global", async () => {
  const created = await quickReplies.createQuickReply({ name: `${namePrefix} Favorita`, shortcut: "/qrfav", text: "x" }, master);
  await quickReplies.setFavorite(created.id, { conversationId: agentConversation.id, favorite: true }, agent);

  const listedForAgent = await quickReplies.listForComposer({ conversationId: agentConversation.id }, agent);
  const listedForMaster = await quickReplies.listForComposer({ conversationId: agentConversation.id }, master);
  assert.equal(listedForAgent.find((item) => item.id === created.id)?.isFavorite, true);
  assert.equal(listedForMaster.find((item) => item.id === created.id)?.isFavorite, false);
});

test("favoritas aparecem primeiro na listagem do composer", async () => {
  const a = await quickReplies.createQuickReply({ name: `${namePrefix} Ordem A`, shortcut: "/qrordema", text: "x" }, master);
  const b = await quickReplies.createQuickReply({ name: `${namePrefix} Ordem B`, shortcut: "/qrordemb", text: "x" }, master);
  await quickReplies.setFavorite(b.id, { conversationId: agentConversation.id, favorite: true }, agent);
  const listed = await quickReplies.listForComposer({ conversationId: agentConversation.id, search: "Ordem" }, agent);
  const indexA = listed.findIndex((item) => item.id === a.id);
  const indexB = listed.findIndex((item) => item.id === b.id);
  assert.ok(indexB < indexA);
});

test("variável resolvida quando o dado existe no contexto da conversa", async () => {
  const created = await quickReplies.createQuickReply({
    name: `${namePrefix} Var`, shortcut: "/qrvar", text: "Olá {{firstName}}, sou {{agentName}}.",
  }, master);
  const contact = await prisma.contact.create({ data: { externalId: "qr-var-contact", phone: "5511900000002", name: "Fabio Almeida", channel: "META" } });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id, channel: "META", assignedUserId: agent.id } });

  const { text, unresolved } = await quickReplies.useQuickReply(created.id, { conversationId: conversation.id }, agent);
  assert.equal(text, "Olá Fabio, sou Atendente QR.");
  assert.deepEqual(unresolved, []);
});

test("variável ausente mantém o placeholder e é reportada, nunca inventa valor", async () => {
  const created = await quickReplies.createQuickReply({
    name: `${namePrefix} VarAusente`, shortcut: "/qrvarausente", text: "Pedido {{orderNumber}} confirmado.",
  }, master);
  const { text, unresolved } = await quickReplies.useQuickReply(created.id, { conversationId: agentConversation.id }, agent);
  assert.equal(text, "Pedido {{orderNumber}} confirmado.");
  assert.deepEqual(unresolved, ["orderNumber"]);
});

test("usar uma resposta grava métrica de uso (quickReplyId, userId, source)", async () => {
  const created = await quickReplies.createQuickReply({ name: `${namePrefix} Métrica`, shortcut: "/qrmetrica", text: "x" }, master);
  await quickReplies.useQuickReply(created.id, { conversationId: agentConversation.id }, agent);
  const usage = await prisma.quickReplyUsage.findFirst({ where: { quickReplyId: created.id } });
  assert.equal(usage.userId, agent.id);
  assert.equal(usage.source, "AGENT");
});

test("resposta inativa não é retornada pelo seletor do composer nem pode ser usada", async () => {
  const created = await quickReplies.createQuickReply({ name: `${namePrefix} Inativa`, shortcut: "/qrinativa", text: "x" }, master);
  await quickReplies.updateQuickReply(created.id, { active: false }, master);
  const listed = await quickReplies.listForComposer({ conversationId: agentConversation.id }, agent);
  assert.ok(!listed.some((item) => item.id === created.id));
  await assert.rejects(() => quickReplies.useQuickReply(created.id, { conversationId: agentConversation.id }, agent), /não está mais ativa/);
});

test("arquivar preserva o registro e o histórico de uso (nunca apaga de verdade)", async () => {
  const created = await quickReplies.createQuickReply({ name: `${namePrefix} Arquivo`, shortcut: "/qrarquivo", text: "x" }, master);
  await quickReplies.useQuickReply(created.id, { conversationId: agentConversation.id }, agent);
  await quickReplies.archiveQuickReply(created.id, master);
  const stillThere = await quickReplies.getQuickReply(created.id, master);
  assert.equal(stillThere.active, false);
  assert.ok(stillThere.archivedAt);
  const usage = await prisma.quickReplyUsage.findFirst({ where: { quickReplyId: created.id } });
  assert.ok(usage);
});

test("intenções associadas não duplicam texto — só ligam por referência", async () => {
  const bot = await prisma.bot.create({
    data: {
      name: `${namePrefix} Bot`, channel: "META", initialMessage: "oi", outsideHoursMessage: "fora", fallbackMessage: "?",
      intents: { create: [{ name: "Acompanhar pedido", priority: 1, active: true, fallbackAction: "USE_BOT_FALLBACK" }] },
    },
    include: { intents: true },
  });
  const created = await quickReplies.createQuickReply({
    name: `${namePrefix} Intent`, shortcut: "/qrintent", text: "x", intentIds: [bot.intents[0].id],
  }, master);
  assert.deepEqual(created.intentIds, [bot.intents[0].id]);
  const suggestion = await quickReplies.suggestQuickReplyForIntent(bot.intents[0].id);
  assert.equal(suggestion, null, "sem availableToBots/SUGGESTED_REPLY, não deve sugerir");

  const suggested = await quickReplies.updateQuickReply(created.id, { availableToBots: true }, master);
  assert.equal(suggested.availableToBots, true);
  const suggestion2 = await quickReplies.suggestQuickReplyForIntent(bot.intents[0].id);
  assert.equal(suggestion2.id, created.id);

  await prisma.bot.delete({ where: { id: bot.id } });
});
