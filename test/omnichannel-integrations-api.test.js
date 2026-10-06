require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createApp } = require("../src/app");
const prisma = require("../src/database/prisma");

test.before(async () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  await prisma.channelAccount.deleteMany({ where: { name: { startsWith: "Teste Integração" } } });
  await prisma.auditLog.deleteMany();
  await prisma.user.deleteMany();
});

test.after(async () => {
  await prisma.channelAccount.deleteMany({ where: { name: { startsWith: "Teste Integração" } } });
  await prisma.user.deleteMany({ where: { email: "master-integrations@teste.local" } });
  await prisma.$disconnect();
});

async function startServer() {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("painel de Integrações: CRUD nunca devolve segredo em texto puro e respeita permissão Master", async () => {
  const { server, base } = await startServer();
  try {
    const setup = await fetch(`${base}/api/auth/setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Master Integrations", email: "master-integrations@teste.local", password: "senha-segura-123" }),
    });
    assert.equal(setup.status, 201);
    const cookie = setup.headers.get("set-cookie").split(";")[0];

    const withoutAuth = await fetch(`${base}/api/integrations/overview`);
    assert.equal(withoutAuth.status, 401);

    const overview = await fetch(`${base}/api/integrations/overview`, { headers: { Cookie: cookie } });
    assert.equal(overview.status, 200);
    const overviewBody = await overview.json();
    assert.ok(overviewBody.some((item) => item.channel === "META"));
    assert.ok(overviewBody.some((item) => item.channel === "SHOPEE"));

    const plaintextSecret = await fetch(`${base}/api/integrations/accounts`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ companyId: "cmp_mibro",
        channel: "TIKTOK_SHOP", name: "Teste Integração segredo público",
        config: { appKey: "public", appSecret: "nao-pode-ficar-no-json" },
      }),
    });
    assert.equal(plaintextSecret.status, 400);
    assert.equal(await prisma.channelAccount.count({ where: { name: "Teste Integração segredo público" } }), 0);

    const created = await fetch(`${base}/api/integrations/accounts`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ companyId: "cmp_mibro",
        channel: "MERCADO_LIVRE", name: "Teste Integração ML",
        secrets: { accessToken: "APP_USR-super-secreto-123456" },
        config: { sellerId: "123" },
      }),
    });
    assert.equal(created.status, 201);
    const account = await created.json();
    assert.equal(account.status, "CONFIGURED");
    assert.equal(JSON.stringify(account).includes("super-secreto"), false);
    assert.ok(account.secretHints.accessToken.endsWith("3456"));
    assert.deepEqual(account.secretKeys, ["accessToken"]);

    const list = await fetch(`${base}/api/integrations/accounts`, { headers: { Cookie: cookie } });
    const listBody = await list.json();
    assert.equal(JSON.stringify(listBody).includes("super-secreto"), false);

    const stored = await prisma.channelAccount.findUnique({ where: { id: account.id } });
    assert.equal(JSON.stringify(stored.config).includes("super-secreto"), false);

    const invalidBoolean = await fetch(`${base}/api/integrations/accounts/${account.id}/enabled`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ enabled: "false" }),
    });
    assert.equal(invalidBoolean.status, 400);

    const disable = await fetch(`${base}/api/integrations/accounts/${account.id}/enabled`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disable.status, 200);
    assert.equal((await disable.json()).enabled, false);

    const removed = await fetch(`${base}/api/integrations/accounts/${account.id}`, { method: "DELETE", headers: { Cookie: cookie } });
    assert.equal(removed.status, 200);
  } finally {
    server.close();
  }
});

test("configuração global de novos canais nunca desativa Meta/WhatsApp", async () => {
  const { server, base } = await startServer();
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "master-integrations@teste.local", password: "senha-segura-123" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];

    const invalidBoolean = await fetch(`${base}/api/integrations/settings`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ newChannelsEnabled: "false" }),
    });
    assert.equal(invalidBoolean.status, 400);

    const disable = await fetch(`${base}/api/integrations/settings`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ newChannelsEnabled: false }),
    });
    assert.equal(disable.status, 200);

    const overview = await fetch(`${base}/api/integrations/overview`, { headers: { Cookie: cookie } });
    const overviewBody = await overview.json();
    const meta = overviewBody.find((item) => item.channel === "META");
    assert.equal(meta.capabilities.canSendMessages, true);

    await fetch(`${base}/api/integrations/settings`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ newChannelsEnabled: true }),
    });
  } finally {
    server.close();
  }
});
