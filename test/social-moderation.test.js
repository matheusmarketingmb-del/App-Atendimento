require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const prisma = require("../src/database/prisma");
const { encryptSecrets } = require("../src/services/channels/integration-secret-service");
const { persistInboundMessage } = require("../src/services/channels/omnichannel-message-service");
const { moderateMessage } = require("../src/services/channels/social-moderation-service");

// Item 27/42 do plano Social — apagar/ocultar/curtir um comentário público.
// Nunca automático (sempre uma chamada explícita daqui, nunca disparada por
// IA), e a matriz de capability decide o que cada canal realmente aceita:
// Facebook tem "curtir comentário" na Graph API, Instagram não tem.
const prefix = `social-moderation-${process.pid}`;
let igAccount;
let fbAccount;
let master;
let attendant;
let igMessage;
let fbMessage;

test.before(async () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY || "66".repeat(32);
  await prisma.integrationGlobalSettings.upsert({ where: { id: "singleton" }, update: { newChannelsEnabled: true }, create: { id: "singleton", newChannelsEnabled: true } });
  master = await prisma.user.create({ data: { name: "Master Moderação", email: `${prefix}-master@example.com`, role: "ADMIN" } });
  attendant = await prisma.user.create({ data: { name: "Atendente Moderação", email: `${prefix}-atendente@example.com`, role: "ATENDENTE", canViewUncategorized: true } });

  igAccount = await prisma.channelAccount.create({ data: { channel: "INSTAGRAM_COMMENTS", name: `${prefix}-ig`, status: "CONNECTED", enabled: true, config: { igUserId: "ig-user-mod" }, ...encryptSecrets({ igAccessToken: "ig-token" }) } });
  fbAccount = await prisma.channelAccount.create({ data: { channel: "FACEBOOK_COMMENTS", name: `${prefix}-fb`, status: "CONNECTED", enabled: true, config: { pageId: "page-mod" }, ...encryptSecrets({ pageAccessToken: "page-token" }) } });

  const igPersisted = await persistInboundMessage({
    channel: "INSTAGRAM_COMMENTS", channelAccountId: igAccount.id, senderExternalId: "ig-user-mod-1", senderName: "Cliente IG",
    externalConversationId: "post-mod-ig-1", externalMessageId: "ig-comment-mod-1", direction: "RECEBIDA",
    type: "comment", text: "Chegou quebrado", occurredAt: new Date(),
    metadata: { senderExternalId: "ig-user-mod-1", externalMessageId: "ig-comment-mod-1" },
  });
  igMessage = igPersisted.message;
  await prisma.conversation.update({ where: { id: igPersisted.conversation.id }, data: { assignedUserId: attendant.id } });

  const fbPersisted = await persistInboundMessage({
    channel: "FACEBOOK_COMMENTS", channelAccountId: fbAccount.id, senderExternalId: "fb-user-mod-1", senderName: "Cliente FB",
    externalConversationId: "post-mod-fb-1", externalMessageId: "fb-comment-mod-1", direction: "RECEBIDA",
    type: "comment", text: "Ótimo produto!", occurredAt: new Date(),
    metadata: { senderExternalId: "fb-user-mod-1", externalMessageId: "fb-comment-mod-1" },
  });
  fbMessage = fbPersisted.message;
  await prisma.conversation.update({ where: { id: fbPersisted.conversation.id }, data: { assignedUserId: attendant.id } });
});

test.after(async () => {
  const accountIds = [igAccount.id, fbAccount.id];
  await prisma.conversationActivity.deleteMany({ where: { conversation: { channelAccountId: { in: accountIds } } } });
  await prisma.message.deleteMany({ where: { channelAccountId: { in: accountIds } } });
  await prisma.conversation.deleteMany({ where: { channelAccountId: { in: accountIds } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: `${igAccount.id}:` } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: `${fbAccount.id}:` } } });
  await prisma.channelAccount.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.user.deleteMany({ where: { id: { in: [master.id, attendant.id] } } });
  await prisma.integrationGlobalSettings.update({ where: { id: "singleton" }, data: { newChannelsEnabled: false } });
  await prisma.$disconnect();
});

test("ação inválida é rejeitada antes de qualquer chamada à Meta", async () => {
  await assert.rejects(() => moderateMessage({ messageId: igMessage.id, action: "ban", actor: master }), (error) => {
    assert.equal(error.statusCode, 400);
    return true;
  });
});

test("moderação só é permitida em mensagens de canal de comentário público", async () => {
  const account = await prisma.channelAccount.create({ data: { channel: "INSTAGRAM_DIRECT", name: `${prefix}-ig-direct`, status: "CONNECTED", enabled: true, config: { igUserId: "ig-dm" }, ...encryptSecrets({ igAccessToken: "t" }) } });
  const persisted = await persistInboundMessage({
    channel: "INSTAGRAM_DIRECT", channelAccountId: account.id, senderExternalId: "igsid-mod-1", externalMessageId: "ig-dm-mod-1",
    direction: "RECEBIDA", type: "text", text: "oi", occurredAt: new Date(), metadata: { senderExternalId: "igsid-mod-1", externalMessageId: "ig-dm-mod-1" },
  });
  await assert.rejects(() => moderateMessage({ messageId: persisted.message.id, action: "hide", actor: master }), (error) => {
    assert.equal(error.statusCode, 409);
    return true;
  });
  await prisma.message.deleteMany({ where: { channelAccountId: account.id } });
  await prisma.conversation.deleteMany({ where: { channelAccountId: account.id } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: `${account.id}:` } } });
  await prisma.channelAccount.delete({ where: { id: account.id } });
});

test("apagar comentário exige Master mesmo quando o atendente pode ver a conversa", async (t) => {
  t.mock.method(axios, "delete", async () => { throw new Error("nunca deveria chamar a Meta sem ser Master"); });
  await assert.rejects(() => moderateMessage({ messageId: igMessage.id, action: "delete", actor: attendant }), (error) => {
    assert.equal(error.statusCode, 403);
    return true;
  });
});

test("Instagram: ocultar comentário chama a Graph API correta e registra atividade", async (t) => {
  let request;
  t.mock.method(axios, "post", async (url, body, config) => { request = { url, config }; return { data: { success: true } }; });
  const result = await moderateMessage({ messageId: igMessage.id, action: "hide", actor: attendant });
  assert.equal(result.moderated, true);
  assert.match(request.url, /ig-comment-mod-1$/);
  assert.equal(request.config.params.hide, true);
  const activity = await prisma.conversationActivity.findFirst({ where: { conversationId: igMessage.conversationId, action: "SOCIAL_COMMENT_HIDDEN" } });
  assert.ok(activity);
});

test("Instagram: curtir comentário não é suportado (sem endpoint de like na Graph API)", async () => {
  await assert.rejects(() => moderateMessage({ messageId: igMessage.id, action: "like", actor: attendant }), (error) => {
    assert.equal(error.channelErrorCode, "NOT_SUPPORTED");
    return true;
  });
});

test("Facebook: curtir comentário chama POST /{comment-id}/likes", async (t) => {
  let request;
  t.mock.method(axios, "post", async (url, body, config) => { request = { url, config }; return { data: { success: true } }; });
  await moderateMessage({ messageId: fbMessage.id, action: "like", actor: attendant });
  assert.match(request.url, /fb-comment-mod-1\/likes$/);
});

test("Facebook: Master apaga comentário via DELETE /{comment-id}", async (t) => {
  let request;
  t.mock.method(axios, "delete", async (url, config) => { request = { url, config }; return { data: { success: true } }; });
  const result = await moderateMessage({ messageId: fbMessage.id, action: "delete", actor: master });
  assert.equal(result.moderated, true);
  assert.match(request.url, /fb-comment-mod-1$/);
});
