require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const webpush = require("web-push");
const { createApp } = require("../src/app");
const prisma = require("../src/database/prisma");
const pushService = require("../src/services/push-service");

const emails = ["push-http-master@teste.local", "push-http-agent@teste.local", "push-http-other@teste.local"];

test.before(async () => {
  await prisma.pushSubscription.deleteMany({ where: { user: { email: { in: emails } } } });
  await prisma.message.deleteMany({ where: { conversation: { contact: { externalId: { startsWith: "push-test-" } } } } });
  await prisma.conversation.deleteMany({ where: { contact: { externalId: { startsWith: "push-test-" } } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: "push-test-" } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

test.after(async () => {
  await prisma.pushSubscription.deleteMany({ where: { user: { email: { in: emails } } } });
  await prisma.message.deleteMany({ where: { conversation: { contact: { externalId: { startsWith: "push-test-" } } } } });
  await prisma.conversation.deleteMany({ where: { contact: { externalId: { startsWith: "push-test-" } } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: "push-test-" } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

async function startServer() {
  const server = createApp({ channel: {} }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function fakeSubscription(seed) {
  return { endpoint: `https://push.example.com/${seed}`, keys: { p256dh: `p256dh-${seed}`, auth: `auth-${seed}` } };
}

test("assinatura de push: cria, lista só as próprias, e bloqueia dono errado", async () => {
  const { server, base } = await startServer();
  try {
    const setup = await fetch(`${base}/api/auth/setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Master Push HTTP", email: "push-http-master@teste.local", password: "senha-segura-123" }),
    });
    assert.equal(setup.status, 201);
    const masterCookie = setup.headers.get("set-cookie").split(";")[0];

    await fetch(`${base}/api/admin/users`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: masterCookie },
      body: JSON.stringify({ companyAccess: [{ companyId: "cmp_mibro" }], name: "Atendente Push HTTP", email: "push-http-agent@teste.local", password: "senha-segura-123", role: "ATENDENTE" }),
    });
    await fetch(`${base}/api/admin/users`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: masterCookie },
      body: JSON.stringify({ companyAccess: [{ companyId: "cmp_mibro" }], name: "Outro Push HTTP", email: "push-http-other@teste.local", password: "senha-segura-123", role: "ATENDENTE" }),
    });
    const agentLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "push-http-agent@teste.local", password: "senha-segura-123" }),
    });
    const agentCookie = agentLogin.headers.get("set-cookie").split(";")[0];
    const otherLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "push-http-other@teste.local", password: "senha-segura-123" }),
    });
    const otherCookie = otherLogin.headers.get("set-cookie").split(";")[0];

    // sem autenticação
    assert.equal((await fetch(`${base}/api/push/devices`)).status, 401);

    // subscription inválida (sem keys) é tratada como erro 400, não derruba o servidor
    const invalid = await fetch(`${base}/api/push/subscriptions`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: agentCookie },
      body: JSON.stringify({ subscription: { endpoint: "https://push.example.com/sem-keys" } }),
    });
    assert.equal(invalid.status, 400);

    // cria a subscription do atendente
    const created = await fetch(`${base}/api/push/subscriptions`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: agentCookie },
      body: JSON.stringify({ subscription: fakeSubscription("agent-1"), deviceLabel: "Chrome - Windows" }),
    });
    assert.equal(created.status, 201);
    const device = await created.json();
    assert.equal(device.deviceLabel, "Chrome - Windows");
    assert.equal(device.enabled, true);

    // dispositivo aparece listado para o próprio dono
    const ownList = await fetch(`${base}/api/push/devices`, { headers: { Cookie: agentCookie } });
    const ownDevices = await ownList.json();
    assert.equal(ownDevices.length, 1);
    assert.equal(ownDevices[0].id, device.id);

    // outro usuário não vê nem remove o dispositivo alheio
    const otherList = await fetch(`${base}/api/push/devices`, { headers: { Cookie: otherCookie } });
    assert.equal((await otherList.json()).length, 0);
    const otherRemoves = await fetch(`${base}/api/push/devices/${device.id}`, { method: "DELETE", headers: { Cookie: otherCookie } });
    assert.equal(otherRemoves.status, 403);

    // remover o próprio dispositivo funciona
    const selfRemoves = await fetch(`${base}/api/push/devices/${device.id}`, { method: "DELETE", headers: { Cookie: agentCookie } });
    assert.equal(selfRemoves.status, 200);
    const afterRemoval = await fetch(`${base}/api/push/devices`, { headers: { Cookie: agentCookie } });
    assert.equal((await afterRemoval.json()).length, 0);

    // Master pode remover dispositivo de outro usuário (RBAC igual ao resto do painel)
    const secondCreate = await fetch(`${base}/api/push/subscriptions`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: agentCookie },
      body: JSON.stringify({ subscription: fakeSubscription("agent-2") }),
    });
    const secondDevice = await secondCreate.json();
    const masterRemoves = await fetch(`${base}/api/push/devices/${secondDevice.id}`, { method: "DELETE", headers: { Cookie: masterCookie } });
    assert.equal(masterRemoves.status, 200);
  } finally { server.close(); }
});

test("notifyIncomingMessage envia push só para o atendente responsável e limpa subscription expirada", async () => {
  const user = await prisma.user.create({ data: { companyAccess: { create: { companyId: "cmp_mibro" } },
    name: "Atendente Push Direto", email: "push-http-agent-direto@teste.local", role: "ATENDENTE",
  } });
  const contact = await prisma.contact.create({ data: { companyId: "cmp_mibro", externalId: "push-test-contact-1", phone: "5599999999999", name: "Cliente Push" } });
  const conversation = await prisma.conversation.create({ data: { companyId: "cmp_mibro", contactId: contact.id, assignedUserId: user.id, status: "EM_ATENDIMENTO" } });
  const subscription = await prisma.pushSubscription.create({ data: {
    userId: user.id, endpoint: "https://push.example.com/direct-1", p256dh: "p", auth: "a", deviceLabel: "Teste",
  } });
  const message = await prisma.message.create({ data: {
    conversationId: conversation.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text",
    text: "Olá, preciso de ajuda", occurredAt: new Date(),
  } });

  const originalSend = webpush.sendNotification;
  const calls = [];
  webpush.sendNotification = async (target, payload) => { calls.push({ target, payload: JSON.parse(payload) }); return { statusCode: 201 }; };
  try {
    await pushService.notifyIncomingMessage(message);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].target.endpoint, subscription.endpoint);
    assert.match(calls[0].payload.url, new RegExp(conversation.id));
    // Multiempresa (item 43): notificação de cliente sempre diz a empresa.
    assert.equal(calls[0].payload.title, "MIBRO · Cliente Push");

    // subscription inválida/expirada (410 Gone) é removida automaticamente
    webpush.sendNotification = async () => { const error = new Error("gone"); error.statusCode = 410; throw error; };
    await pushService.notifyUser(user.id, { title: "x", body: "y", url: "/" });
    const remaining = await prisma.pushSubscription.findUnique({ where: { id: subscription.id } });
    assert.equal(remaining, null);
  } finally {
    webpush.sendNotification = originalSend;
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation.id } });
    await prisma.contact.deleteMany({ where: { id: contact.id } });
    await prisma.pushSubscription.deleteMany({ where: { userId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
});

test("conversa sem atendente responsável não dispara push (evita ruído amplo)", async () => {
  const contact = await prisma.contact.create({ data: { companyId: "cmp_mibro", externalId: "push-test-contact-2", phone: "5599999999998", name: "Cliente Sem Atendente" } });
  const conversation = await prisma.conversation.create({ data: { companyId: "cmp_mibro", contactId: contact.id, status: "NOVO" } });
  const message = await prisma.message.create({ data: {
    conversationId: conversation.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text",
    text: "Primeira mensagem", occurredAt: new Date(),
  } });
  const originalSend = webpush.sendNotification;
  let called = false;
  webpush.sendNotification = async () => { called = true; return { statusCode: 201 }; };
  try {
    await pushService.notifyIncomingMessage(message);
    assert.equal(called, false);
  } finally {
    webpush.sendNotification = originalSend;
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation.id } });
    await prisma.contact.deleteMany({ where: { id: contact.id } });
  }
});
