require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const axios = require("axios");
const prisma = require("../src/database/prisma");
const accounts = require("../src/services/channels/channel-account-service");
const oauth = require("../src/services/channels/integration-oauth-service");
const { decryptSecrets } = require("../src/services/channels/integration-secret-service");
const { getOAuthProvider } = require("../src/services/channels/oauth-providers");

const master = { id: "oauth-master", name: "OAuth Master", role: "ADMIN" };

test.before(async () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  process.env.GOOGLE_OAUTH_CLIENT_ID = "google-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "google-secret";
  await prisma.channelAccount.deleteMany({ where: { name: { startsWith: "OAuth Lifecycle" } } });
  await prisma.user.upsert({ where: { id: master.id }, update: { role: "ADMIN" }, create: { id: master.id, name: master.name, email: "oauth-master@teste.local", role: "ADMIN" } });
});

test.after(async () => {
  await prisma.channelAccount.deleteMany({ where: { name: { startsWith: "OAuth Lifecycle" } } });
  await prisma.user.upsert({ where: { id: master.id }, update: { role: "ADMIN" }, create: { id: master.id, name: master.name, email: "oauth-master@teste.local", role: "ADMIN" } });
  await prisma.user.deleteMany({ where: { id: master.id } });
  await prisma.$disconnect();
});

test("OAuth salva tokens cifrados, identidade automática e sobrevive a nova leitura", async () => {
  const result = await accounts.saveOAuthConnection({ companyId: "cmp_mibro",
    channel: "EMAIL", provider: "GOOGLE", preferredName: "OAuth Lifecycle Gmail",
    token: { access_token: "access-original", refresh_token: "refresh-original", expires_in: 3600, scope: "gmail.readonly gmail.send" },
    scopes: ["gmail.readonly", "gmail.send"],
    candidates: [{ id: "conta@gmail.com", name: "conta@gmail.com", username: "conta@gmail.com", config: { provider: "GMAIL", emailAddress: "conta@gmail.com" } }],
  }, master);
  assert.equal(result.account.status, "CONNECTED");
  assert.equal(result.account.externalAccountId, "conta@gmail.com");
  assert.equal(JSON.stringify(result).includes("access-original"), false);
  const stored = await prisma.channelAccount.findUnique({ where: { id: result.account.id } });
  assert.equal(decryptSecrets(stored).accessToken, "access-original");
  assert.equal(stored.oauthProvider, "GOOGLE");
  assert.deepEqual(stored.oauthScopes, ["gmail.readonly", "gmail.send"]);

  await accounts.saveOAuthConnection({ companyId: "cmp_mibro",
    accountId: stored.id, channel: "EMAIL", provider: "GOOGLE",
    token: { access_token: "access-reconnected", expires_in: 3600 },
    scopes: stored.oauthScopes,
    candidates: [{ id: "conta@gmail.com", name: "conta@gmail.com", username: "conta@gmail.com", config: { provider: "GMAIL" } }],
  }, master);
  const reread = await prisma.channelAccount.findUnique({ where: { id: stored.id } });
  assert.equal(decryptSecrets(reread).accessToken, "access-reconnected");
  assert.equal(decryptSecrets(reread).refreshToken, "refresh-original");
  assert.equal((await accounts.getAccount(stored.id, master)).status, "CONNECTED");
});

test("Meta mantém tokens fora do frontend e exige seleção quando há múltiplas páginas", async () => {
  const result = await accounts.saveOAuthConnection({ companyId: "cmp_mibro",
    channel: "FACEBOOK_MESSENGER", provider: "META", preferredName: "OAuth Lifecycle Meta",
    token: { access_token: "meta-user-token", expires_in: 3600 },
    scopes: ["pages_show_list", "pages_messaging"],
    candidates: [
      { id: "page-1", name: "Página Um", config: { pageId: "page-1" }, secretPatch: { pageAccessToken: "page-token-1" } },
      { id: "page-2", name: "Página Dois", config: { pageId: "page-2" }, secretPatch: { pageAccessToken: "page-token-2" } },
    ],
  }, master);
  assert.equal(result.selectionRequired, true);
  assert.equal(result.account.status, "AUTH_PENDING");
  assert.equal(JSON.stringify(result).includes("page-token"), false);

  const selected = await accounts.selectOAuthCandidate(result.account.id, "page-2", master);
  assert.equal(selected.status, "CONNECTED");
  assert.equal(selected.externalAccountId, "page-2");
  const stored = await prisma.channelAccount.findUnique({ where: { id: result.account.id } });
  assert.equal(decryptSecrets(stored).pageAccessToken, "page-token-2");
  assert.equal(decryptSecrets(stored).oauthCandidates, undefined);
});

test("refresh automático atualiza token e falha muda status para RECONNECT_REQUIRED", async () => {
  const account = await prisma.channelAccount.findFirst({ where: { name: "OAuth Lifecycle Gmail" } });
  await prisma.channelAccount.update({ where: { id: account.id }, data: { tokenExpiresAt: new Date(Date.now() - 1000) } });
  const originalPost = axios.post;
  try {
    axios.post = async () => ({ data: { access_token: "access-renovado", expires_in: 3600 } });
    const refreshed = await oauth.refreshAccountIfNeeded(await prisma.channelAccount.findUnique({ where: { id: account.id } }));
    assert.equal(refreshed.status, "CONNECTED");
    assert.equal(decryptSecrets(refreshed).accessToken, "access-renovado");

    await prisma.channelAccount.update({ where: { id: account.id }, data: { tokenExpiresAt: new Date(Date.now() - 1000) } });
    axios.post = async () => { throw Object.assign(new Error("401"), { response: { status: 401 } }); };
    const failed = await oauth.refreshAccountIfNeeded(await prisma.channelAccount.findUnique({ where: { id: account.id } }));
    assert.equal(failed.status, "RECONNECT_REQUIRED");
  } finally {
    axios.post = originalPost;
  }
});

test("provider inexistente e usuário sem RBAC são rejeitados", async () => {
  assert.throws(() => getOAuthProvider("INEXISTENTE"), /não está preparado/);
  await assert.rejects(() => accounts.saveOAuthConnection({ companyId: "cmp_mibro",
    channel: "EMAIL", provider: "GOOGLE", token: { access_token: "x" },
    candidates: [{ id: "x", name: "x", config: { provider: "GMAIL" } }],
  }, { id: "attendant", role: "ATENDENTE" }), (error) => error.statusCode === 403);
});
