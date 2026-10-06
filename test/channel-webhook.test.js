require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const prisma = require("../src/database/prisma");

test.before(async () => {
  await prisma.message.deleteMany({ where: { channel: "MERCADO_LIVRE" } });
  await prisma.conversation.deleteMany({ where: { channel: "MERCADO_LIVRE" } });
  await prisma.contact.deleteMany({ where: { channel: "MERCADO_LIVRE" } });
  await prisma.externalChannelEvent.deleteMany({ where: { channel: "MERCADO_LIVRE" } });
});

test.after(async () => prisma.$disconnect());

async function startServer() {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("webhook de canal desconhecido/ainda não gerenciado responde 404 sem vazar detalhe interno", async () => {
  const { server, base } = await startServer();
  try {
    const response = await fetch(`${base}/webhooks/channels/CANAL_INEXISTENTE`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 404);
  } finally { server.close(); }
});

test("webhook do Mercado Livre rejeita payload mal formado (401) sem persistir nada", async () => {
  await prisma.integrationGlobalSettings.upsert({
    where: { id: "singleton" }, update: { newChannelsEnabled: true },
    create: { id: "singleton", newChannelsEnabled: true },
  });
  const account = await prisma.channelAccount.create({
    data: { companyId: "cmp_mibro", channel: "MERCADO_LIVRE", name: "Teste Webhook ML", enabled: true },
  });
  const { server, base } = await startServer();
  try {
    // Falta application_id (parte do formato mínimo exigido por
    // validateWebhook) — webhook real agora valida formato, não fica mais
    // permanentemente fechado (ver mercado-livre-adapter.js).
    const payload = { resource: "/questions/555444", user_id: 555, topic: "questions", sent: new Date().toISOString() };
    const response = await fetch(`${base}/webhooks/channels/MERCADO_LIVRE`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    assert.equal(response.status, 401);
    assert.equal(await prisma.externalChannelEvent.count({ where: { channelAccountId: account.id } }), 0);
    assert.equal(await prisma.message.count({ where: { channelAccountId: account.id } }), 0);
  } finally {
    server.close();
    await prisma.channelAccount.delete({ where: { id: account.id } });
    await prisma.integrationGlobalSettings.update({ where: { id: "singleton" }, data: { newChannelsEnabled: false } });
  }
});

test("webhook do Mercado Livre aceita payload com formato válido e persiste o evento (idempotente)", async () => {
  await prisma.integrationGlobalSettings.upsert({
    where: { id: "singleton" }, update: { newChannelsEnabled: true },
    create: { id: "singleton", newChannelsEnabled: true },
  });
  const account = await prisma.channelAccount.create({
    data: { companyId: "cmp_mibro", channel: "MERCADO_LIVRE", name: "Teste Webhook ML Válido", enabled: true },
  });
  const { server, base } = await startServer();
  try {
    const payload = {
      resource: "/questions/777888", user_id: 777, topic: "questions", application_id: "app-teste",
      sent: new Date().toISOString(),
    };
    const send = () => fetch(`${base}/webhooks/channels/MERCADO_LIVRE`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const first = await send();
    assert.equal(first.status, 200);
    assert.equal(await prisma.externalChannelEvent.count({ where: { channelAccountId: account.id } }), 1);
    // Reenvio do mesmo payload nunca duplica o evento (idempotência, item 4).
    const second = await send();
    assert.equal(second.status, 200);
    assert.equal(await prisma.externalChannelEvent.count({ where: { channelAccountId: account.id } }), 1);
  } finally {
    server.close();
    await prisma.message.deleteMany({ where: { channelAccountId: account.id } });
    await prisma.conversation.deleteMany({ where: { channelAccountId: account.id } });
    await prisma.externalChannelEvent.deleteMany({ where: { channelAccountId: account.id } });
    await prisma.contact.deleteMany({ where: { channel: "MERCADO_LIVRE", externalId: { startsWith: `${account.id}:` } } });
    await prisma.channelAccount.delete({ where: { id: account.id } });
    await prisma.integrationGlobalSettings.update({ where: { id: "singleton" }, data: { newChannelsEnabled: false } });
  }
});
test("webhook do Facebook Messenger processa mensagem e escolhe a ChannelAccount certa entre duas Páginas", async () => {
  await prisma.integrationGlobalSettings.upsert({
    where: { id: "singleton" }, update: { newChannelsEnabled: true },
    create: { id: "singleton", newChannelsEnabled: true },
  });
  const pageA = await prisma.channelAccount.create({
    data: { companyId: "cmp_mibro", channel: "FACEBOOK_MESSENGER", name: "Página A", enabled: true, config: { pageId: "111" } },
  });
  const pageB = await prisma.channelAccount.create({
    data: { companyId: "cmp_mibro", channel: "FACEBOOK_MESSENGER", name: "Página B", enabled: true, config: { pageId: "222" } },
  });
  const { server, base } = await startServer();
  try {
    const payload = {
      object: "page",
      entry: [{ id: "222", messaging: [{
        sender: { id: "PSID-teste" }, recipient: { id: "222" }, timestamp: Date.now(),
        message: { mid: `mid-teste-${Date.now()}`, text: "Oi, vocês entregam hoje?" },
      }] }],
    };
    const response = await fetch(`${base}/webhooks/channels/FACEBOOK_MESSENGER`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);
    assert.equal(await prisma.externalChannelEvent.count({ where: { channelAccountId: pageA.id } }), 0);
    assert.equal(await prisma.externalChannelEvent.count({ where: { channelAccountId: pageB.id } }), 1);
    const message = await prisma.message.findFirst({ where: { channelAccountId: pageB.id } });
    assert.ok(message, "esperava mensagem persistida para a Página B");
    assert.equal(message.text, "Oi, vocês entregam hoje?");
  } finally {
    server.close();
    await prisma.message.deleteMany({ where: { channelAccountId: { in: [pageA.id, pageB.id] } } });
    await prisma.conversation.deleteMany({ where: { channelAccountId: { in: [pageA.id, pageB.id] } } });
    await prisma.externalChannelEvent.deleteMany({ where: { channelAccountId: { in: [pageA.id, pageB.id] } } });
    await prisma.contact.deleteMany({ where: { channel: "FACEBOOK_MESSENGER" } });
    await prisma.channelAccount.deleteMany({ where: { id: { in: [pageA.id, pageB.id] } } });
    await prisma.integrationGlobalSettings.update({ where: { id: "singleton" }, data: { newChannelsEnabled: false } });
  }
});

test("webhook do Instagram/Facebook fica bloqueado enquanto o master switch de novos canais está desligado", async () => {
  const account = await prisma.channelAccount.create({
    data: { companyId: "cmp_mibro", channel: "INSTAGRAM_DIRECT", name: "Perfil Teste", enabled: true, config: { igUserId: "IG1" } },
  });
  const { server, base } = await startServer();
  try {
    const payload = { object: "instagram", entry: [{ id: "IG1", messaging: [{ sender: { id: "u1" }, recipient: { id: "IG1" }, message: { mid: "m1", text: "oi" } }] }] };
    const response = await fetch(`${base}/webhooks/channels/INSTAGRAM_DIRECT`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    assert.equal(response.status, 404);
    assert.equal(await prisma.externalChannelEvent.count({ where: { channelAccountId: account.id } }), 0);
  } finally {
    server.close();
    await prisma.channelAccount.delete({ where: { id: account.id } });
  }
});

test("WhatsApp/Meta continua com sua rota própria intocada (verify token) mesmo com o webhook genérico registrado", async () => {
  const { server, base } = await startServer();
  try {
    const response = await fetch(`${base}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${process.env.VERIFY_TOKEN || "invalido"}&hub.challenge=abc123`);
    assert.ok([200, 403].includes(response.status));
  } finally { server.close(); }
});
