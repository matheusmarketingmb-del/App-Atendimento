require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const prisma = require("../src/database/prisma");
const { createApp } = require("../src/app");
const { encryptSecrets } = require("../src/services/channels/integration-secret-service");
const { persistInboundMessage } = require("../src/services/channels/omnichannel-message-service");
const { sendImage } = require("../src/services/message-service");
const { buildPublicMediaUrl, verifyMediaToken } = require("../src/services/channels/social-media-link-service");

// Item 46 do plano Social — Direct/Messenger só aceitam anexo via URL
// pública (a Meta busca sozinha, sem sessão nossa). Cobre o link assinado
// (social-media-link-service.js) de ponta a ponta: geração, verificação,
// expiração/adulteração e o envio real de imagem pelo Instagram Direct.
const prefix = `social-media-${process.pid}`;
const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]);
const noopChannel = { sendText: async () => { throw new Error("Meta (WhatsApp) não deve ser usada por aqui."); } };
let account;
let conversation;

test.before(async () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY || "55".repeat(32);
  process.env.PUBLIC_APP_URL = "https://central.example.com";
  await prisma.integrationGlobalSettings.upsert({ where: { id: "singleton" }, update: { newChannelsEnabled: true }, create: { id: "singleton", newChannelsEnabled: true } });
  account = await prisma.channelAccount.create({
    data: { channel: "INSTAGRAM_DIRECT", name: `${prefix}-ig-direct`, status: "CONNECTED", enabled: true, config: { igUserId: "ig-user-media" }, ...encryptSecrets({ igAccessToken: "ig-token" }) },
  });
  const persisted = await persistInboundMessage({
    channel: "INSTAGRAM_DIRECT", channelAccountId: account.id, senderExternalId: "igsid-media-1", senderName: "Cliente Mídia",
    externalConversationId: "post-media-1", externalMessageId: "ig-dm-media-1", direction: "RECEBIDA",
    type: "text", text: "Manda foto?", occurredAt: new Date(),
    metadata: { senderExternalId: "igsid-media-1", externalMessageId: "ig-dm-media-1" },
  });
  conversation = persisted.conversation;
});

test.after(async () => {
  await prisma.message.deleteMany({ where: { channelAccountId: account.id } });
  await prisma.conversation.deleteMany({ where: { channelAccountId: account.id } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: `${account.id}:` } } });
  await prisma.channelAccount.delete({ where: { id: account.id } });
  await prisma.integrationGlobalSettings.update({ where: { id: "singleton" }, data: { newChannelsEnabled: false } });
  await prisma.$disconnect();
});

test("buildPublicMediaUrl falha claramente sem PUBLIC_APP_URL configurada", () => {
  const saved = process.env.PUBLIC_APP_URL;
  delete process.env.PUBLIC_APP_URL;
  try {
    assert.throws(() => buildPublicMediaUrl("abc123.jpg"), (error) => {
      assert.equal(error.channelErrorCode, "NOT_SUPPORTED");
      return true;
    });
  } finally { process.env.PUBLIC_APP_URL = saved; }
});

test("token assinado verifica corretamente e rejeita adulteração/expiração", () => {
  const url = buildPublicMediaUrl("abc123.jpg", { ttlSeconds: 60 });
  const [, , , storageKey, expiresAt, token] = new URL(url).pathname.split("/");
  assert.equal(storageKey, "abc123.jpg");
  assert.equal(verifyMediaToken(storageKey, expiresAt, token), true);
  assert.equal(verifyMediaToken(storageKey, expiresAt, `${token}0`), false);
  assert.equal(verifyMediaToken(storageKey, Date.now() - 1000, token), false);
  assert.equal(verifyMediaToken("outro-arquivo.jpg", expiresAt, token), false);
});

test("Instagram Direct envia imagem via URL pública assinada e a rota /public/media serve o arquivo real", async (t) => {
  let mediaRequest;
  t.mock.method(axios, "post", async (url, body) => { mediaRequest = { url, body }; return { data: { message_id: "ig-dm-media-reply-1" } }; });
  const { message } = await sendImage({ conversationId: conversation.id, buffer: jpegBuffer, mimeType: "image/jpeg", fileName: "foto.jpg", channel: noopChannel });
  assert.match(mediaRequest.url, /ig-user-media\/messages$/);
  assert.equal(mediaRequest.body.recipient.id, "igsid-media-1");
  assert.match(mediaRequest.body.message.attachment.payload.url, /^https:\/\/central\.example\.com\/public\/media\//);
  assert.equal(message.mediaStorageKey && message.mediaStorageKey.endsWith(".jpg"), true);

  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const publicUrl = mediaRequest.body.message.attachment.payload.url.replace("https://central.example.com", `http://127.0.0.1:${server.address().port}`);
    const response = await fetch(publicUrl);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.equals(jpegBuffer), true);

    // Token adulterado nunca serve o arquivo.
    const tampered = publicUrl.slice(0, -1) + (publicUrl.endsWith("0") ? "1" : "0");
    const rejected = await fetch(tampered);
    assert.equal(rejected.status, 404);
  } finally { server.close(); }
});
