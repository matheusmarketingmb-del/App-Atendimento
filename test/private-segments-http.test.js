// Financeiro protegido + atendente fixo pelas rotas HTTP reais (com sessão):
// sem bypass por API digitando o ID na URL. Inclui o backfill (simulação e
// aplicação) do histórico antigo.
require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { createApp } = require("../src/app");
const prisma = require("../src/database/prisma");
const backfill = require("../scripts/backfill-private-segments");

const emailDomain = "@segmentos-http.test";
const contactPrefix = "segment-http-";
const password = "senha-segmentos-123";

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { endsWith: emailDomain } }, select: { id: true } });
  const contacts = await prisma.contact.findMany({ where: { externalId: { startsWith: contactPrefix } }, select: { id: true } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: { in: users.map(({ id }) => id) } }, { entityId: { in: contacts.map(({ id }) => id) } }] } });
  await prisma.contact.deleteMany({ where: { id: { in: contacts.map(({ id }) => id) } } });
  await prisma.user.deleteMany({ where: { id: { in: users.map(({ id }) => id) } } });
  await prisma.category.deleteMany({ where: { companyId: "cmp_mibro", code: { startsWith: "FIN_HTTP_TEST" } } });
}

test.before(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("HTTP: anexo/mensagem do Financeiro 403 para quem não é do setor; detalhe sem conteúdo; atendente fixo só Supervisor/Master", async () => {
  const support = await prisma.category.findUnique({ where: { companyId_code: { companyId: "cmp_mibro", code: "SUPORTE" } } });
  const financeiro = await prisma.category.create({ data: { companyId: "cmp_mibro", code: `FIN_HTTP_TEST_${Date.now()}`, name: "Financeiro", visibilityMode: "SECTOR_PRIVATE" } });
  const passwordHash = await bcrypt.hash(password, 4);
  const makeUser = (name, email, categories, extra = {}) => prisma.user.create({ data: {
    companyAccess: { create: { companyId: "cmp_mibro" } }, name, email: `${email}${emailDomain}`, passwordHash, role: "ATENDENTE",
    canViewPreviousMessages: true, categoryAccess: { create: categories.map(({ id }) => ({ categoryId: id })) }, ...extra,
  } });
  const ana = await makeUser("HTTP Ana", "ana", [financeiro]);
  const suporte = await makeUser("HTTP Suporte", "suporte", [support]);
  const supervisor = await makeUser("HTTP Supervisor", "supervisor", [support], { role: "SUPERVISOR" });
  const contact = await prisma.contact.create({ data: { companyId: "cmp_mibro", externalId: `${contactPrefix}${Date.now()}`, phone: "5511966660000", name: "Cliente HTTP Fin" } });
  const conversation = await prisma.conversation.create({ data: { companyId: "cmp_mibro", contactId: contact.id, categoryId: financeiro.id, status: "EM_ATENDIMENTO", assignedUserId: ana.id } });
  const pdf = await prisma.message.create({ data: {
    conversationId: conversation.id, direction: "RECEBIDA", status: "RECEBIDA", type: "document", text: "boleto", occurredAt: new Date(Date.now() - 2000),
    mediaStorageKey: "segment-http/nao-existe.pdf", mediaMimeType: "application/pdf", mediaFileName: "boleto.pdf",
  } });
  assert.equal(pdf.privateCategoryId, financeiro.id);
  // Conversa passa para o Suporte (o histórico do Financeiro fica protegido).
  await prisma.conversation.update({ where: { id: conversation.id }, data: { categoryId: support.id, assignedUserId: suporte.id } });
  await prisma.message.create({ data: { conversationId: conversation.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text", text: "relógio não liga", occurredAt: new Date() } });

  const server = createApp({ channel: {} }).listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = async (email) => {
      const response = await fetch(`${base}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${email}${emailDomain}`, password }),
      });
      assert.equal(response.status, 200);
      return response.headers.get("set-cookie").split(";")[0];
    };
    const call = (cookie, path, options = {}) => fetch(`${base}${path}`, { ...options, headers: { Cookie: cookie, "Content-Type": "application/json" } });
    const suporteCookie = await login("suporte");
    const supervisorCookie = await login("supervisor");

    assert.equal((await call(suporteCookie, `/api/messages/${pdf.id}/media`)).status, 403);
    const detail = await call(suporteCookie, `/api/conversations/${conversation.id}`);
    assert.equal(detail.status, 200);
    const body = await detail.text();
    assert.equal(body.includes("boleto"), false);
    assert.match(body, /restricted_segment/);
    assert.match(body, /relógio não liga/);

    // Atendente fixo: atendente comum não altera; Supervisor da empresa sim.
    const denied = await call(suporteCookie, `/api/contacts/${contact.id}/preferred-assignee`, { method: "PUT", body: JSON.stringify({ userId: suporte.id }) });
    assert.equal(denied.status, 403);
    const saved = await call(supervisorCookie, `/api/contacts/${contact.id}/preferred-assignee`, { method: "PUT", body: JSON.stringify({ userId: suporte.id, enabled: true }) });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).assignee.id, suporte.id);
    const removed = await call(supervisorCookie, `/api/contacts/${contact.id}/preferred-assignee`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).assignee, null);
  } finally {
    server.close();
  }
});

test("backfill: simulação não altera nada; --apply carimba só o intervalo do Financeiro (sem apagar)", async () => {
  const commercial = await prisma.category.findUnique({ where: { companyId_code: { companyId: "cmp_mibro", code: "COMERCIAL" } } });
  const support = await prisma.category.findUnique({ where: { companyId_code: { companyId: "cmp_mibro", code: "SUPORTE" } } });
  // Setor criado NORMAL (histórico anterior ao flag), protegido depois.
  const financeiro = await prisma.category.create({ data: { companyId: "cmp_mibro", code: `FIN_HTTP_TEST_BF_${Date.now()}`, name: "Financeiro" } });
  const contact = await prisma.contact.create({ data: { companyId: "cmp_mibro", externalId: `${contactPrefix}bf-${Date.now()}`, phone: "5511955550000", name: "Cliente Backfill" } });
  const conversation = await prisma.conversation.create({ data: { companyId: "cmp_mibro", contactId: contact.id, categoryId: commercial.id, status: "EM_ATENDIMENTO" } });
  const at = (minutes) => new Date(Date.now() - (60 - minutes) * 60 * 1000);
  const msg = (minutes, text) => prisma.message.create({ data: { conversationId: conversation.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text", text, occurredAt: at(minutes) } });
  const move = (minutes, from, to) => prisma.conversationActivity.create({ data: {
    conversationId: conversation.id, action: "CATEGORY_CHANGED", createdAt: at(minutes), details: { fromCategoryId: from.id, toCategoryId: to.id },
  } });
  const before = await msg(1, "comercial");
  await move(5, commercial, financeiro);
  const during = await msg(10, "boleto antigo");
  await move(20, financeiro, support);
  const after = await msg(25, "suporte");

  const log = () => {};
  await assert.rejects(() => backfill.main({ prisma, argv: [`--category=${financeiro.id}`], log }), /ainda não está com histórico protegido/);
  await prisma.category.update({ where: { id: financeiro.id }, data: { visibilityMode: "SECTOR_PRIVATE" } });

  const dry = await backfill.main({ prisma, argv: [`--category=${financeiro.id}`], log });
  assert.equal(dry.applied, false);
  assert.equal(dry.messages, 1);
  assert.equal((await prisma.message.findUnique({ where: { id: during.id } })).privateCategoryId, null, "simulação não grava");

  const applied = await backfill.main({ prisma, argv: [`--category=${financeiro.id}`, "--apply"], log });
  assert.equal(applied.messages, 1);
  const rows = await prisma.message.findMany({ where: { conversationId: conversation.id } });
  assert.equal(rows.length, 3, "nada apagado");
  assert.equal(rows.find(({ id }) => id === during.id).privateCategoryId, financeiro.id);
  assert.equal(rows.find(({ id }) => id === before.id).privateCategoryId, null);
  assert.equal(rows.find(({ id }) => id === after.id).privateCategoryId, null);
  assert.equal(rows.find(({ id }) => id === during.id).text, "boleto antigo");
});
