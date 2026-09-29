require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const authorization = require("../src/services/authorization-service");
const accounts = require("../src/services/channels/channel-account-service");
const { normalizeInboundMessage } = require("../src/services/channels/channel-event-normalizer");
const { persistInboundMessage } = require("../src/services/channels/omnichannel-message-service");
const inbox = require("../src/services/inbox-service");

let admin, allowed, denied, account, conversationId;
const emails = ["email-access-admin@test.local", "email-access-allowed@test.local", "email-access-denied@test.local"];

test.before(async () => {
  await prisma.integrationGlobalSettings.upsert({ where: { id: "singleton" }, update: { newChannelsEnabled: true }, create: { id: "singleton", newChannelsEnabled: true } });
  admin = await prisma.user.create({ data: { name: "Admin Acesso", email: emails[0], role: "ADMIN" } });
  allowed = await prisma.user.create({ data: { name: "Permitido", email: emails[1], role: "ATENDENTE", canViewUncategorized: true } });
  denied = await prisma.user.create({ data: { name: "Bloqueado", email: emails[2], role: "ATENDENTE", canViewUncategorized: true } });
  account = await prisma.channelAccount.create({ data: { channel: "EMAIL", name: "Email Access Test", status: "CONNECTED", enabled: true } });
  await accounts.setAccountAccess(account.id, [allowed.id], admin);
  const result = await persistInboundMessage(normalizeInboundMessage({
    channel: "EMAIL", channelAccountId: account.id, senderExternalId: "private@example.com",
    senderName: "Privado", externalConversationId: "thread-private", externalMessageId: "message-private",
    direction: "RECEBIDA", type: "text", text: "Conteúdo restrito",
  }));
  conversationId = result.conversation.id;
});

test.after(async () => {
  await prisma.externalChannelEvent.deleteMany({ where: { channelAccountId: account.id } });
  await prisma.message.deleteMany({ where: { channelAccountId: account.id } });
  await prisma.conversation.deleteMany({ where: { channelAccountId: account.id } });
  await prisma.contact.deleteMany({ where: { channel: "EMAIL", externalId: { startsWith: `${account.id}:` } } });
  await prisma.channelAccount.delete({ where: { id: account.id } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

test("somente usuário escolhido e Master visualizam a conta de e-mail", async () => {
  assert.ok((await inbox.listConversations({}, admin)).some((item) => item.id === conversationId));
  assert.ok((await inbox.listConversations({}, allowed)).some((item) => item.id === conversationId));
  assert.equal((await inbox.listConversations({}, denied)).some((item) => item.id === conversationId), false);
  await assert.rejects(() => authorization.assertCanViewConversation(denied, conversationId), (error) => error.statusCode === 404);
});

test("Master troca a lista de acesso e a autorização muda imediatamente", async () => {
  const updated = await accounts.setAccountAccess(account.id, [denied.id], admin);
  assert.deepEqual(updated.accessUsers.map((item) => item.userId), [denied.id]);
  assert.equal((await inbox.listConversations({}, allowed)).some((item) => item.id === conversationId), false);
  assert.ok((await inbox.listConversations({}, denied)).some((item) => item.id === conversationId));
});

test("qualquer usuário com acesso pode marcar spam, ocultar da fila e restaurar", async () => {
  await assert.rejects(
    () => inbox.setEmailSpamStatus(conversationId, { spam: true }, allowed),
    (error) => error.statusCode === 404,
  );
  const before = await inbox.getConversationSummary(denied);
  const marked = await inbox.setEmailSpamStatus(conversationId, { spam: true }, denied);
  assert.equal(marked.emailMailbox, "SPAM");
  assert.equal((await inbox.listConversations({}, denied)).find((item) => item.id === conversationId)?.emailMailbox, "SPAM");
  assert.equal((await inbox.getConversationSummary(denied)).total, before.total - 1);
  const restored = await inbox.setEmailSpamStatus(conversationId, { spam: false }, denied);
  assert.equal(restored.emailMailbox, "GENERAL");
  assert.equal((await inbox.getConversationSummary(denied)).total, before.total);
});
