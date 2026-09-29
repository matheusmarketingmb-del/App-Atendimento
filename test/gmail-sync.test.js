require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const prisma = require("../src/database/prisma");
const { encryptSecrets } = require("../src/services/channels/integration-secret-service");
const { fetchGmailInbox, syncGmailAccount, syncLabel } = require("../src/services/channels/gmail-sync-service");

const accountName = "Gmail Sync Test";
let account;
const sender = "cliente.gmail.sync@example.com";
const mediaDir = path.join(os.tmpdir(), `gmail-sync-media-${process.pid}`);
process.env.MEDIA_STORAGE_DIR = mediaDir;

function gmailMessage(id, internalDate, text) {
  return {
    id, threadId: "thread-sync", internalDate: String(internalDate),
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "From", value: `Cliente Teste <${sender}>` }, { name: "Subject", value: "Teste Gmail" }],
      body: { data: Buffer.from(text).toString("base64url") },
    },
  };
}

test.before(async () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = "11".repeat(32);
  await prisma.integrationGlobalSettings.upsert({ where: { id: "singleton" }, update: { newChannelsEnabled: true }, create: { id: "singleton", newChannelsEnabled: true } });
  await prisma.channelAccount.deleteMany({ where: { name: accountName } });
  account = await prisma.channelAccount.create({ data: {
    channel: "EMAIL", name: accountName, status: "CONNECTED", enabled: true,
    oauthProvider: "GOOGLE", tokenExpiresAt: new Date(Date.now() + 3600000),
    config: { provider: "GMAIL", emailAddress: "central@example.com" },
    ...encryptSecrets({ accessToken: "access-test", refreshToken: "refresh-test" }),
  } });
});

test.after(async () => {
  await prisma.externalChannelEvent.deleteMany({ where: { channelAccountId: account.id } });
  await prisma.message.deleteMany({ where: { channelAccountId: account.id } });
  await prisma.conversation.deleteMany({ where: { channelAccountId: account.id } });
  await prisma.contact.deleteMany({ where: { channel: "EMAIL", externalId: { startsWith: `${account.id}:` } } });
  await prisma.channelAccount.delete({ where: { id: account.id } });
  await fs.rm(mediaDir, { recursive: true, force: true });
  await prisma.$disconnect();
});

test("fetch Gmail pagina INBOX e SPAM e devolve mensagens sem duplicar em ordem cronológica", async () => {
  const calls = [];
  const now = Date.now();
  const http = { get: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/messages")) {
      return options.params.pageToken
        ? { data: { messages: [{ id: "old" }] } }
        : { data: { messages: [{ id: "new" }], nextPageToken: "page-2" } };
    }
    return { data: url.endsWith("/old") ? gmailMessage("old", now - 1000, "Antiga") : gmailMessage("new", now, "Nova") };
  } };
  const result = await fetchGmailInbox({ accessToken: "token", since: new Date(now - 5000), http });
  assert.deepEqual(result.map((item) => item.id), ["old", "new"]);
  assert.equal(calls[0].options.params.labelIds, "INBOX");
  assert.ok(calls.some((call) => call.url.endsWith("/messages") && call.options.params.labelIds === "SPAM"));
  assert.match(calls[0].options.params.q, /^after:\d+$/);
});

test("fetch Gmail resolve o marcador real pelo ID, aceitando a forma exibida na busca", async () => {
  const calls = [];
  const now = Date.now();
  const http = { get: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/labels")) return { data: { labels: [{ id: "Label_863", name: "Shopify (site Mibro)" }] } };
    if (url.endsWith("/messages")) return { data: { messages: [{ id: "shop" }] } };
    return { data: gmailMessage("shop", now, "Pedido Shopify") };
  } };
  const result = await fetchGmailInbox({ accessToken: "token", since: new Date(now - 5000), label: "shopify--site-mibro-", http });
  assert.deepEqual(result.map((item) => item.id), ["shop"]);
  const listCalls = calls.filter((call) => call.url.endsWith("/messages"));
  assert.equal(listCalls.length, 1);
  assert.equal(listCalls[0].options.params.labelIds, "Label_863");
  assert.equal(listCalls[0].options.params.includeSpamTrash, true);
  assert.match(listCalls[0].options.params.q, /^after:\d+$/);
  await fetchGmailInbox({ accessToken: "token", since: new Date(now - 5000), label: "Shopify (Site Mibro)", http });
  assert.equal(calls.filter((call) => call.url.endsWith("/messages")).at(-1).options.params.labelIds, "Label_863");
});

test("fetch Gmail mantém busca textual como fallback quando o marcador não é encontrado", async () => {
  const calls = [];
  const now = Date.now();
  const http = { get: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/labels")) return { data: { labels: [] } };
    if (url.endsWith("/messages")) return { data: { messages: [] } };
    return { data: gmailMessage("unused", now, "") };
  } };
  await fetchGmailInbox({ accessToken: "token", since: new Date(now - 5000), label: "Outro marcador", http });
  const listCall = calls.find((call) => call.url.endsWith("/messages"));
  assert.equal(listCall.options.params.labelIds, undefined);
  assert.match(listCall.options.params.q, /^label:"Outro marcador" after:\d+$/);
});

test("marcador de sincronização: conta > GMAIL_SYNC_LABEL > padrão; vazio desliga", () => {
  const previous = process.env.GMAIL_SYNC_LABEL;
  try {
    delete process.env.GMAIL_SYNC_LABEL;
    assert.equal(syncLabel({ config: {} }), "Shopify (site Mibro)");
    process.env.GMAIL_SYNC_LABEL = "Pedidos";
    assert.equal(syncLabel({ config: {} }), "Pedidos");
    assert.equal(syncLabel({ config: { gmailSyncLabel: " Loja " } }), "Loja");
    process.env.GMAIL_SYNC_LABEL = "";
    assert.equal(syncLabel({ config: {} }), null);
  } finally {
    if (previous === undefined) delete process.env.GMAIL_SYNC_LABEL;
    else process.env.GMAIL_SYNC_LABEL = previous;
  }
});

test("sincronização importa e-mail recebido uma única vez e avança o cursor", async () => {
  const raw = gmailMessage("gmail-msg-1", Date.now(), "Mensagem recebida de teste");
  const http = { get: async (url) => url.endsWith("/messages") ? { data: { messages: [{ id: raw.id }] } } : { data: raw } };
  assert.equal(await syncGmailAccount(account, { http }), 1);
  const refreshed = await prisma.channelAccount.findUnique({ where: { id: account.id } });
  assert.ok(refreshed.config.gmailSyncCursorAt);
  assert.equal(await syncGmailAccount(refreshed, { http }), 0);
  assert.equal(await prisma.message.count({ where: { channelAccountId: account.id, externalId: `${account.id}:${raw.id}` } }), 1);
});

test("sincronização baixa anexo, remove placeholder e grava o e-mail do remetente", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const raw = gmailMessage("gmail-msg-attachment", Date.now(), "[image:foto.png]");
  raw.payload = {
    mimeType: "multipart/mixed", headers: raw.payload.headers,
    parts: [
      { mimeType: "text/plain", body: { data: Buffer.from("[image:foto.png]").toString("base64url") } },
      { partId: "1", filename: "foto.png", mimeType: "image/png", body: { attachmentId: "attachment-1" } },
    ],
  };
  const http = { get: async (url) => {
    if (url.endsWith("/messages")) return { data: { messages: [{ id: raw.id }] } };
    if (url.includes("/attachments/")) return { data: { data: png.toString("base64url") } };
    return { data: raw };
  } };
  const current = await prisma.channelAccount.findUnique({ where: { id: account.id } });
  assert.equal(await syncGmailAccount(current, { http }), 1);
  const message = await prisma.message.findUnique({ where: { externalId: `${account.id}:${raw.id}:attachment:attachment-1` } });
  assert.equal(message.type, "image");
  assert.equal(message.mediaFileName, "foto.png");
  assert.ok(message.mediaStorageKey);
  assert.equal(message.text, null);
  const contact = await prisma.contact.findFirst({ where: { channel: "EMAIL", externalId: `${account.id}:${sender}` } });
  assert.equal(contact.email, sender);
});
