require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { createApp } = require("../src/app");
const prisma = require("../src/database/prisma");

// Mesmas regras de privacidade/grupos, agora pelas rotas HTTP reais com
// sessão: garante que não existe bypass por API digitando o ID na URL.

const emailDomain = "@privacidade-http.test";
const contactExternalId = "privacy-http-test";
const password = "senha-privacidade-123";

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { endsWith: emailDomain } }, select: { id: true } });
  const userIds = users.map(({ id }) => id);
  const groups = await prisma.internalChat.findMany({ where: { createdByUserId: { in: userIds } }, select: { id: true } });
  await prisma.internalChat.deleteMany({ where: { id: { in: groups.map(({ id }) => id) } } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.contact.deleteMany({ where: { externalId: contactExternalId } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

test.before(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("HTTP: atendente sem acesso recebe 403 em detalhe, resposta, anexo e grupo alheio", async () => {
  const support = await prisma.category.findUnique({ where: { code: "SUPORTE" } });
  const passwordHash = await bcrypt.hash(password, 4);
  const makeUser = (name, email) => prisma.user.create({ data: {
    name, email: `${email}${emailDomain}`, passwordHash, role: "ATENDENTE",
    categoryAccess: { create: [{ categoryId: support.id }] },
  } });
  const [userA, userB] = await Promise.all([makeUser("HTTP A", "a"), makeUser("HTTP B", "b")]);
  const contact = await prisma.contact.create({ data: { externalId: contactExternalId, phone: "5511977770000", name: "Cliente HTTP" } });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id, categoryId: support.id, status: "NOVO" } });
  const media = await prisma.message.create({ data: {
    conversationId: conversation.id, direction: "RECEBIDA", status: "RECEBIDA", type: "image", occurredAt: new Date(),
    mediaStorageKey: "privacy-http/nao-existe.jpg", mediaMimeType: "image/jpeg", mediaFileName: "foto.jpg",
  } });

  const server = createApp({ channel: {} }).listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = async (email) => {
      const response = await fetch(`${base}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: `${email}${emailDomain}`, password }),
      });
      assert.equal(response.status, 200);
      return response.headers.get("set-cookie").split(";")[0];
    };
    const [cookieA, cookieB] = [await login("a"), await login("b")];
    const call = (cookie, path, options = {}) => fetch(`${base}${path}`, {
      ...options, headers: { Cookie: cookie, "Content-Type": "application/json", ...(options.headers || {}) },
    });

    // Na fila: B vê.
    assert.equal((await call(cookieB, `/api/conversations/${conversation.id}`)).status, 200);

    // A assume.
    assert.equal((await call(cookieA, `/api/conversations/${conversation.id}/claim`, { method: "POST" })).status, 200);

    // B: detalhe, resposta, leitura, anexo, assumir e alterar → 403.
    const detail = await call(cookieB, `/api/conversations/${conversation.id}`);
    assert.equal(detail.status, 403);
    assert.equal((await detail.json()).code, "CONVERSATION_ASSIGNED_TO_OTHER");
    assert.equal((await call(cookieB, `/api/conversations/${conversation.id}/messages`, { method: "POST", body: JSON.stringify({ text: "invasão" }) })).status, 403);
    assert.equal((await call(cookieB, `/api/conversations/${conversation.id}/read`, { method: "POST" })).status, 403);
    assert.equal((await call(cookieB, `/api/messages/${media.id}/media`)).status, 403);
    assert.equal((await call(cookieB, `/api/conversations/${conversation.id}/claim`, { method: "POST" })).status, 403);
    assert.equal((await call(cookieB, `/api/conversations/${conversation.id}`, { method: "PATCH", body: JSON.stringify({ status: "FINALIZADO" }) })).status, 403);
    const listB = await (await call(cookieB, "/api/conversations")).json();
    assert.equal(listB.some(({ id }) => id === conversation.id), false);
    // Exportação bruta de mensagens é só do Master.
    assert.equal((await call(cookieB, "/api/messages")).status, 403);
    // Nenhuma mensagem foi enviada por B.
    assert.equal(await prisma.message.count({ where: { conversationId: conversation.id, sentByUserId: userB.id } }), 0);

    // Grupo do chat interno: não membro não enxerga nem administra.
    const created = await call(cookieA, "/api/internal-chats/groups", { method: "POST", body: JSON.stringify({ name: "Grupo HTTP", memberIds: [userA.id] }) });
    assert.equal(created.status, 400); // precisa de ao menos 1 participante além do criador
    const outsider = await prisma.user.create({ data: { name: "HTTP C", email: `c${emailDomain}`, passwordHash, role: "ATENDENTE" } });
    const group = await (await call(cookieA, "/api/internal-chats/groups", { method: "POST", body: JSON.stringify({ name: "Grupo HTTP", memberIds: [outsider.id] }) })).json();
    assert.equal((await call(cookieB, `/api/internal-chats/${group.id}/messages`)).status, 403);
    assert.equal((await call(cookieB, `/api/internal-chats/${group.id}/messages`, { method: "POST", body: JSON.stringify({ text: "oi" }) })).status, 403);
    assert.equal((await call(cookieB, `/api/internal-chats/${group.id}/group`)).status, 404);
    assert.equal((await call(cookieB, `/api/internal-chats/${group.id}/members`, { method: "POST", body: JSON.stringify({ userIds: [userB.id] }) })).status, 404);
    const groupForA = await call(cookieA, `/api/internal-chats/${group.id}/group`);
    assert.equal(groupForA.status, 200);
    assert.equal((await groupForA.json()).memberCount, 2);
  } finally {
    server.close();
  }
});
