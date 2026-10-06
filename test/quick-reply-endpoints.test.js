require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const prisma = require("../src/database/prisma");

test.before(async () => {
  await prisma.quickReplyUsage.deleteMany({});
  await prisma.quickReplyFavorite.deleteMany({});
  await prisma.quickReply.deleteMany({ where: { name: { startsWith: "QR HTTP" } } });
  await prisma.conversation.deleteMany({ where: { contact: { is: { externalId: { startsWith: "qr-http-" } } } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: "qr-http-" } } });
  await prisma.user.deleteMany({ where: { email: { in: ["qr-http-master@teste.local", "qr-http-agent@teste.local"] } } });
});

test.after(async () => {
  await prisma.quickReplyUsage.deleteMany({});
  await prisma.quickReplyFavorite.deleteMany({});
  await prisma.quickReply.deleteMany({ where: { name: { startsWith: "QR HTTP" } } });
  await prisma.conversation.deleteMany({ where: { contact: { is: { externalId: { startsWith: "qr-http-" } } } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: "qr-http-" } } });
  await prisma.user.deleteMany({ where: { email: { in: ["qr-http-master@teste.local", "qr-http-agent@teste.local"] } } });
  await prisma.$disconnect();
});

async function startServer(channelCalls) {
  const channel = new Proxy({}, { get: () => () => { channelCalls.count += 1; throw new Error("nunca deveria chamar o canal real"); } });
  const server = createApp({ channel }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("rotas de Respostas Rápidas: Master gerencia, atendente só usa/busca/favorita — nunca envia mensagem de verdade", async () => {
  const channelCalls = { count: 0 };
  const { server, base } = await startServer(channelCalls);
  try {
    const setup = await fetch(`${base}/api/auth/setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Master QR HTTP", email: "qr-http-master@teste.local", password: "senha-segura-123" }),
    });
    assert.equal(setup.status, 201);
    const masterCookie = setup.headers.get("set-cookie").split(";")[0];

    const agentCreate = await fetch(`${base}/api/admin/users`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: masterCookie },
      body: JSON.stringify({ companyAccess: [{ companyId: "cmp_mibro" }], name: "Atendente QR HTTP", email: "qr-http-agent@teste.local", password: "senha-segura-123", role: "ATENDENTE" }),
    });
    assert.equal(agentCreate.status, 201);
    const agentLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "qr-http-agent@teste.local", password: "senha-segura-123" }),
    });
    assert.equal(agentLogin.status, 200);
    const agentCookie = agentLogin.headers.get("set-cookie").split(";")[0];

    const withoutAuth = await fetch(`${base}/api/quick-replies`);
    assert.equal(withoutAuth.status, 401);

    const agentTriesCreate = await fetch(`${base}/api/quick-replies`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: agentCookie },
      body: JSON.stringify({ companyId: "cmp_mibro", name: "QR HTTP Bloqueado", shortcut: "/qrhttpbloqueado", text: "x" }),
    });
    assert.equal(agentTriesCreate.status, 403);

    const created = await fetch(`${base}/api/quick-replies`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: masterCookie },
      body: JSON.stringify({ companyId: "cmp_mibro", name: "QR HTTP Pedido", shortcut: "/qrhttppedido", text: "Pode me informar o número do pedido?" }),
    });
    assert.equal(created.status, 201);
    const quickReply = await created.json();

    const withoutConversation = await fetch(`${base}/api/quick-replies/composer`, { headers: { Cookie: agentCookie } });
    assert.equal(withoutConversation.status, 400);
    const agent = await prisma.user.findUniqueOrThrow({ where: { email: "qr-http-agent@teste.local" } });
    const contact = await prisma.contact.create({ data: { companyId: "cmp_mibro", externalId: "qr-http-contact", phone: "5511900000099", channel: "META" } });
    const conversation = await prisma.conversation.create({ data: { companyId: "cmp_mibro", contactId: contact.id, channel: "META", assignedUserId: agent.id } });
    const composerAsAgent = await fetch(`${base}/api/quick-replies/composer?conversationId=${conversation.id}`, { headers: { Cookie: agentCookie } });
    assert.equal(composerAsAgent.status, 200);
    const composerList = await composerAsAgent.json();
    assert.ok(composerList.some((item) => item.id === quickReply.id));

    const favorite = await fetch(`${base}/api/quick-replies/${quickReply.id}/favorite`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: agentCookie }, body: JSON.stringify({ conversationId: conversation.id, favorite: true }),
    });
    assert.equal(favorite.status, 200);
    assert.equal((await favorite.json()).favorite, true);

    // Selecionar/usar NUNCA envia mensagem real — só resolve texto e grava uso.
    const useWithoutConversation = await fetch(`${base}/api/quick-replies/${quickReply.id}/use`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: agentCookie }, body: JSON.stringify({}),
    });
    assert.equal(useWithoutConversation.status, 400);
    const used = await fetch(`${base}/api/quick-replies/${quickReply.id}/use`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: agentCookie }, body: JSON.stringify({ conversationId: conversation.id }),
    });
    assert.equal(used.status, 200);
    const usedBody = await used.json();
    assert.ok(usedBody.text.includes("número do pedido"));
    assert.equal(channelCalls.count, 0);

    const agentTriesArchive = await fetch(`${base}/api/quick-replies/${quickReply.id}`, { method: "DELETE", headers: { Cookie: agentCookie } });
    assert.equal(agentTriesArchive.status, 403);

    const archived = await fetch(`${base}/api/quick-replies/${quickReply.id}`, { method: "DELETE", headers: { Cookie: masterCookie } });
    assert.equal(archived.status, 200);
    assert.equal((await archived.json()).active, false);

    assert.equal(channelCalls.count, 0);
  } finally { server.close(); }
});

test("página administrativa /quick-replies é Master-only", async () => {
  const { server, base } = await startServer({ count: 0 });
  try {
    const agentLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "qr-http-agent@teste.local", password: "senha-segura-123" }),
    });
    const agentCookie = agentLogin.headers.get("set-cookie")?.split(";")[0];
    const page = await fetch(`${base}/quick-replies`, { headers: { Cookie: agentCookie || "" }, redirect: "manual" });
    assert.ok([302, 303, 401, 403].includes(page.status), `esperava redirecionamento/bloqueio, recebeu ${page.status}`);
  } finally { server.close(); }
});
