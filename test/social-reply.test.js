require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const prisma = require("../src/database/prisma");
const { encryptSecrets } = require("../src/services/channels/integration-secret-service");
const { persistInboundMessage } = require("../src/services/channels/omnichannel-message-service");
const { sendText } = require("../src/services/message-service");

// Item 3/9/24 do plano Social: DM responde ao remetente (PSID/IGSID),
// comentário responde ao comentário original — nunca ambíguo, nunca
// misturado. Cobre os 4 sub-canais Meta "novos" via o mesmo dispatcher
// genérico já usado por E-mail (channelMessageService), sem tocar em nada
// do WhatsApp.
const prefix = `social-reply-${process.pid}`;
const noopChannel = { sendText: async () => { throw new Error("Meta (WhatsApp) não deve ser usada por aqui."); } };
const accounts = {};
const conversations = {};

async function makeAccount(channel, name, config, secrets) {
  const account = await prisma.channelAccount.create({
    data: { channel, name, status: "CONNECTED", enabled: true, config, ...encryptSecrets(secrets) },
  });
  accounts[name] = account;
  return account;
}

async function makeInboundConversation({ channel, account, senderExternalId, externalMessageId, extraMetadata = {} }) {
  const persisted = await persistInboundMessage({
    channel, channelAccountId: account.id, senderExternalId, senderName: "Cliente Social",
    externalConversationId: `post-${externalMessageId}`, externalMessageId, direction: "RECEBIDA",
    type: channel.endsWith("COMMENTS") ? "comment" : "text", text: "Esse relógio tem GPS?", occurredAt: new Date(),
    metadata: { senderExternalId, externalMessageId, ...extraMetadata },
  });
  return persisted.conversation;
}

test.before(async () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY || "44".repeat(32);
  await prisma.integrationGlobalSettings.upsert({ where: { id: "singleton" }, update: { newChannelsEnabled: true }, create: { id: "singleton", newChannelsEnabled: true } });

  await makeAccount("INSTAGRAM_DIRECT", `${prefix}-ig-direct`, { igUserId: "ig-user-1" }, { igAccessToken: "ig-token" });
  await makeAccount("INSTAGRAM_COMMENTS", `${prefix}-ig-comments`, { igUserId: "ig-user-1" }, { igAccessToken: "ig-token" });
  await makeAccount("FACEBOOK_MESSENGER", `${prefix}-fb-messenger`, { pageId: "page-1" }, { pageAccessToken: "page-token" });
  await makeAccount("FACEBOOK_COMMENTS", `${prefix}-fb-comments`, { pageId: "page-1" }, { pageAccessToken: "page-token" });

  conversations.igDirect = await makeInboundConversation({ channel: "INSTAGRAM_DIRECT", account: accounts[`${prefix}-ig-direct`], senderExternalId: "igsid-777", externalMessageId: "ig-dm-1" });
  conversations.igComments = await makeInboundConversation({ channel: "INSTAGRAM_COMMENTS", account: accounts[`${prefix}-ig-comments`], senderExternalId: "ig-user-777", externalMessageId: "ig-comment-1" });
  conversations.fbMessenger = await makeInboundConversation({ channel: "FACEBOOK_MESSENGER", account: accounts[`${prefix}-fb-messenger`], senderExternalId: "psid-888", externalMessageId: "fb-dm-1" });
  conversations.fbComments = await makeInboundConversation({ channel: "FACEBOOK_COMMENTS", account: accounts[`${prefix}-fb-comments`], senderExternalId: "fb-user-888", externalMessageId: "fb-comment-1" });
});

test.after(async () => {
  const accountIds = Object.values(accounts).map((a) => a.id);
  await prisma.message.deleteMany({ where: { channelAccountId: { in: accountIds } } });
  await prisma.conversation.deleteMany({ where: { channelAccountId: { in: accountIds } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: `${accountIds[0]}:` } } });
  for (const id of accountIds) {
    await prisma.contact.deleteMany({ where: { externalId: { startsWith: `${id}:` } } });
  }
  await prisma.channelAccount.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.integrationGlobalSettings.update({ where: { id: "singleton" }, data: { newChannelsEnabled: false } });
  await prisma.$disconnect();
});

test("Instagram Direct responde por DM ao IGSID do remetente", async (t) => {
  let request;
  t.mock.method(axios, "post", async (url, body) => { request = { url, body }; return { data: { message_id: "ig-dm-reply-1" } }; });
  const { message } = await sendText({ conversationId: conversations.igDirect.id, text: "Sim, possui GPS integrado!", channel: noopChannel });
  assert.match(request.url, /ig-user-1\/messages$/);
  assert.equal(request.body.recipient.id, "igsid-777");
  assert.equal(request.body.message.text, "Sim, possui GPS integrado!");
  assert.equal(message.channel, "INSTAGRAM_DIRECT");
  assert.equal(message.direction, "ENVIADA");
});

test("Instagram Comentários responde publicamente ao comentário original, não ao remetente", async (t) => {
  let request;
  t.mock.method(axios, "post", async (url, body) => { request = { url, body }; return { data: { id: "ig-comment-reply-1" } }; });
  await sendText({ conversationId: conversations.igComments.id, text: "Sim, possui GPS!", channel: noopChannel });
  assert.match(request.url, /ig-comment-1\/replies$/);
  assert.equal(request.body.message, "Sim, possui GPS!");
});

test("Facebook Messenger responde por DM ao PSID do remetente", async (t) => {
  let request;
  t.mock.method(axios, "post", async (url, body) => { request = { url, body }; return { data: { message_id: "fb-dm-reply-1" } }; });
  await sendText({ conversationId: conversations.fbMessenger.id, text: "Sim!", channel: noopChannel });
  assert.match(request.url, /page-1\/messages$/);
  assert.equal(request.body.recipient.id, "psid-888");
});

test("Facebook Comentários responde publicamente ao comentário original", async (t) => {
  let request;
  t.mock.method(axios, "post", async (url, body) => { request = { url, body }; return { data: { id: "fb-comment-reply-1" } }; });
  await sendText({ conversationId: conversations.fbComments.id, text: "Sim, possui!", channel: noopChannel });
  assert.match(request.url, /fb-comment-1\/comments$/);
});

test("responder sem conta de canal associada falha com erro claro (nunca envia às cegas)", async () => {
  const orphan = await prisma.conversation.create({
    data: {
      kind: "PRIVATE_CONVERSATION", channel: "INSTAGRAM_DIRECT", channelScope: "orphan-test", status: "NOVO",
      contact: { create: { channel: "INSTAGRAM_DIRECT", externalId: `orphan-test:igsid-orphan`, name: "Órfão" } },
    },
  });
  await assert.rejects(() => sendText({ conversationId: orphan.id, text: "oi", channel: noopChannel }), (error) => {
    assert.equal(error.statusCode, 400);
    return true;
  });
  await prisma.conversation.delete({ where: { id: orphan.id } });
  await prisma.contact.deleteMany({ where: { externalId: "orphan-test:igsid-orphan" } });
});

test("capabilities dos adapters sociais nunca afirmam moderação/ação não implementada", () => {
  const { createAdapter } = require("../src/services/channels/channel-adapter-registry");
  for (const channel of ["INSTAGRAM_DIRECT", "FACEBOOK_MESSENGER"]) {
    const caps = createAdapter(channel, null).capabilities();
    assert.equal(caps.canPrivateReply, true);
    assert.equal(caps.canPublicReply, false);
    assert.equal(caps.canDelete, false);
    assert.equal(caps.canHide, false);
    assert.equal(caps.canLike, false);
  }
  for (const channel of ["INSTAGRAM_COMMENTS", "FACEBOOK_COMMENTS"]) {
    const caps = createAdapter(channel, null).capabilities();
    assert.equal(caps.canPublicReply, true);
    assert.equal(caps.canPrivateReply, false);
    assert.equal(caps.canDelete, false);
    assert.equal(caps.canHide, false);
    assert.equal(caps.canLike, false);
  }
});
