require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const oauth = require("../src/services/channels/integration-oauth-service");
const { getOAuthProvider, getOAuthScopes } = require("../src/services/channels/oauth-providers");


test("Google OAuth separa os scopes minimos de Gmail e Google Reviews por canal", () => {
  assert.deepEqual(getOAuthScopes("GOOGLE", "EMAIL"), [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ]);
  assert.deepEqual(getOAuthScopes("GOOGLE", "GOOGLE_REVIEWS"), [
    "https://www.googleapis.com/auth/business.manage",
  ]);
  assert.equal(getOAuthScopes("GOOGLE", "EMAIL").includes("https://www.googleapis.com/auth/business.manage"), false);
});

test("Google OAuth solicita refresh token sem expor segredo no frontend", () => {
  const google = getOAuthProvider("GOOGLE");
  assert.deepEqual(google.extraAuthParams, { access_type: "offline", prompt: "consent" });
  assert.equal(Object.hasOwn(google, "clientSecret"), false);
});


test("Meta OAuth usa scopes por canal e nunca mistura comentários com Gmail", () => {
  assert.deepEqual(getOAuthScopes("META", "FACEBOOK_MESSENGER"), ["pages_show_list", "pages_manage_metadata", "pages_messaging"]);
  assert.ok(getOAuthScopes("META", "INSTAGRAM_DIRECT").includes("instagram_manage_messages"));
  assert.equal(getOAuthScopes("META", "INSTAGRAM_DIRECT").some((scope) => scope.startsWith("https://www.googleapis.com/")), false);
});

test("Google OAuth usa PKCE S256 e nunca devolve o verifier ao frontend", async () => {
  const result = await oauth.createAuthorizationRequest({
    channel: "EMAIL", provider: "GOOGLE", clientId: "google-id",
    redirectUri: "https://app.example/oauth-callback.html", actorUserId: "master-a",
    scopes: getOAuthScopes("GOOGLE", "EMAIL"),
  });
  const url = new URL(result.url);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.equal(JSON.stringify(result).includes("codeVerifier"), false);
  const stored = await prisma.channelOAuthState.findUnique({ where: { state: result.state } });
  assert.ok(stored.metadata.codeVerifier);
});

test("Amazon OAuth usa application_id e preserva state sem parâmetros incompatíveis", async () => {
  const result = await oauth.createAuthorizationRequest({
    channel: "AMAZON_MARKETPLACE", provider: "AMAZON", clientId: "amzn-app-id",
    redirectUri: "https://app.example/oauth-callback.html", actorUserId: "master-a",
  });
  const url = new URL(result.url);
  assert.equal(url.searchParams.get("application_id"), "amzn-app-id");
  assert.ok(url.searchParams.get("state"));
  assert.equal(url.searchParams.has("client_id"), false);
  assert.equal(url.searchParams.has("redirect_uri"), false);
  assert.equal(url.searchParams.has("response_type"), false);
});
let account;

test.before(async () => {
  await prisma.channelOAuthState.deleteMany({});
  await prisma.channelAccount.deleteMany({ where: { name: "Teste OAuth seguro" } });
  account = await prisma.channelAccount.create({ data: { companyId: "cmp_mibro", channel: "MERCADO_LIVRE", name: "Teste OAuth seguro" } });
});

test.after(async () => {
  await prisma.channelOAuthState.deleteMany({ where: { channelAccountId: account.id } });
  await prisma.channelAccount.delete({ where: { id: account.id } });
  await prisma.$disconnect();
});

async function createState(actorUserId = "master-a") {
  return oauth.createAuthorizationRequest({
    channel: "MERCADO_LIVRE", channelAccountId: account.id, provider: "MERCADO_LIVRE",
    clientId: "client-id", redirectUri: "https://app.example/oauth/callback", actorUserId,
  });
}

test("state OAuth fica vinculado ao usuário que iniciou e não é queimado por outro usuário", async () => {
  const { state } = await createState();
  await assert.rejects(() => oauth.consumeState(state, "master-b"), (error) => error.statusCode === 403);
  const stored = await prisma.channelOAuthState.findUnique({ where: { state } });
  assert.equal(stored.consumedAt, null);
  assert.equal(stored.metadata.actorUserId, "master-a");
});

test("consumo concorrente do mesmo state OAuth permite exatamente um callback", async () => {
  const { state } = await createState();
  const results = await Promise.allSettled([
    oauth.consumeState(state, "master-a"),
    oauth.consumeState(state, "master-a"),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
});

test("state OAuth expirado nunca é consumido", async () => {
  const { state } = await createState();
  await prisma.channelOAuthState.update({ where: { state }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await assert.rejects(() => oauth.consumeState(state, "master-a"), (error) => error.statusCode === 400);
});
