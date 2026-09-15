require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { send } = require("../src/services/channels/channel-message-service");
const { assertNewChannelEnabled, isSocialAutoReplyAllowed, setSocialReplyFlags } = require("../src/services/channels/integration-global-settings-service");
const { normalizeInboundMessage } = require("../src/services/channels/channel-event-normalizer");
const { persistInboundMessage } = require("../src/services/channels/omnichannel-message-service");

test.after(async () => {
  await prisma.integrationGlobalSettings.upsert({
    where: { id: "singleton" },
    update: { newChannelsEnabled: false, socialAutoReplyEnabled: false, socialCommentAutoReplyEnabled: false, socialPrivateAutoReplyEnabled: false },
    create: { id: "singleton", newChannelsEnabled: false },
  });
  await prisma.channelAccount.deleteMany({ where: { name: { startsWith: "Teste Switch" } } });
  await prisma.$disconnect();
});

test("chave global bloqueia dispatcher de novos canais sem afetar Meta", async () => {
  await prisma.integrationGlobalSettings.upsert({
    where: { id: "singleton" }, update: { newChannelsEnabled: false },
    create: { id: "singleton", newChannelsEnabled: false },
  });
  await assert.rejects(() => send({ channel: "EMAIL", to: "x" }), (error) => {
    assert.equal(error.statusCode, 503);
    assert.match(error.message, /desativadas globalmente/);
    return true;
  });
  await assert.doesNotReject(() => assertNewChannelEnabled("META"));
  const account = await prisma.channelAccount.create({
    data: { channel: "EMAIL", name: "Teste Switch Inbound", enabled: true },
  });
  const inbound = normalizeInboundMessage({
    channel: "EMAIL", channelAccountId: account.id, senderExternalId: "blocked@example.com", type: "text",
  });
  await assert.rejects(() => persistInboundMessage(inbound), (error) => error.statusCode === 503);
  assert.equal(await prisma.conversation.count({ where: { channelAccountId: account.id } }), 0);
});

test("dispatcher exige conta do mesmo canal quando novos canais são liberados", async () => {
  await prisma.integrationGlobalSettings.update({ where: { id: "singleton" }, data: { newChannelsEnabled: true } });
  const account = await prisma.channelAccount.create({ data: { channel: "EMAIL", name: "Teste Switch Conta Cruzada", enabled: true } });
  await assert.rejects(() => send({ channel: "SHOPEE", channelAccountId: account.id, to: "x" }), (error) => {
    assert.equal(error.channelErrorCode, "INVALID_PAYLOAD");
    return true;
  });
});

test("flags de auto-reply social exigem Master e ficam OFF por padrão", async () => {
  await prisma.integrationGlobalSettings.upsert({
    where: { id: "singleton" },
    update: { socialAutoReplyEnabled: false, socialCommentAutoReplyEnabled: false, socialPrivateAutoReplyEnabled: false },
    create: { id: "singleton" },
  });
  assert.equal(await isSocialAutoReplyAllowed("COMMENT"), false);
  assert.equal(await isSocialAutoReplyAllowed("PRIVATE"), false);

  await assert.rejects(() => setSocialReplyFlags({ socialAutoReplyEnabled: true }, { role: "ATENDENTE" }), (error) => {
    assert.equal(error.statusCode, 403);
    return true;
  });

  await setSocialReplyFlags({ socialAutoReplyEnabled: true, socialCommentAutoReplyEnabled: true }, { role: "ADMIN" });
  assert.equal(await isSocialAutoReplyAllowed("COMMENT"), true);
  // Chave-mestra ligada não basta sozinha para o tipo que não foi ligado.
  assert.equal(await isSocialAutoReplyAllowed("PRIVATE"), false);

  await assert.rejects(() => setSocialReplyFlags({ socialAutoReplyEnabled: "yes" }, { role: "ADMIN" }), (error) => {
    assert.equal(error.statusCode, 400);
    return true;
  });
});
