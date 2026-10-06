require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { normalizeInboundMessage } = require("../src/services/channels/channel-event-normalizer");
const { persistInboundMessage } = require("../src/services/channels/omnichannel-message-service");

const accountIds = {};

test.before(async () => {
  await prisma.integrationGlobalSettings.upsert({
    where: { id: "singleton" }, update: { newChannelsEnabled: true },
    create: { id: "singleton", newChannelsEnabled: true },
  });
  await prisma.message.deleteMany({ where: { channel: { in: ["MERCADO_LIVRE", "GOOGLE_REVIEWS", "RECLAME_AQUI", "EMAIL"] } } });
  await prisma.conversation.deleteMany({ where: { channel: { in: ["MERCADO_LIVRE", "GOOGLE_REVIEWS", "RECLAME_AQUI", "EMAIL"] } } });
  await prisma.contact.deleteMany({ where: { channel: { in: ["MERCADO_LIVRE", "GOOGLE_REVIEWS", "RECLAME_AQUI", "EMAIL"] } } });
  await prisma.channelAccount.deleteMany({ where: { name: { startsWith: "Teste Mensageria" } } });
  await prisma.channelAccount.createMany({ data: [
    { companyId: "cmp_mibro", channel: "MERCADO_LIVRE", name: "Teste Mensageria ML 1", enabled: true },
    { companyId: "cmp_mibro", channel: "MERCADO_LIVRE", name: "Teste Mensageria ML 2", enabled: true },
    { companyId: "cmp_mibro", channel: "GOOGLE_REVIEWS", name: "Teste Mensageria Google", enabled: true },
    { companyId: "cmp_mibro", channel: "RECLAME_AQUI", name: "Teste Mensageria RA", enabled: true },
    { companyId: "cmp_mibro", channel: "EMAIL", name: "Teste Mensageria Email", enabled: true },
  ] });
  const accounts = await prisma.channelAccount.findMany({ where: { name: { startsWith: "Teste Mensageria" } } });
  for (const account of accounts) accountIds[account.name] = account.id;
});

test.after(async () => {
  await prisma.message.deleteMany({ where: { channelAccountId: { in: Object.values(accountIds) } } });
  await prisma.conversation.deleteMany({ where: { channelAccountId: { in: Object.values(accountIds) } } });
  await prisma.contact.deleteMany({ where: { channel: { in: ["MERCADO_LIVRE", "GOOGLE_REVIEWS", "RECLAME_AQUI", "EMAIL"] } } });
  await prisma.channelAccount.deleteMany({ where: { id: { in: Object.values(accountIds) } } });
  await prisma.integrationGlobalSettings.update({ where: { id: "singleton" }, data: { newChannelsEnabled: false } });
  await prisma.$disconnect();
});

test("contato sem telefone (Mercado Livre) é persistido normalmente com phone null", async () => {
  const normalized = normalizeInboundMessage({
    channel: "MERCADO_LIVRE", channelAccountId: accountIds["Teste Mensageria ML 1"], type: "question", senderExternalId: "buyer-777", senderName: "Comprador Teste",
    externalConversationId: "/questions/777", externalMessageId: "ml-msg-1", text: null,
  });
  const { contact, conversation, message } = await persistInboundMessage(normalized);
  assert.equal(contact.phone, null);
  assert.equal(contact.channel, "MERCADO_LIVRE");
  assert.equal(conversation.kind, "PUBLIC_QUESTION");
  assert.equal(message.channel, "MERCADO_LIVRE");
});

test("externalConversationId nunca é usado como Conversation.id — os dois ficam distintos", async () => {
  const normalized = normalizeInboundMessage({
    channel: "MERCADO_LIVRE", channelAccountId: accountIds["Teste Mensageria ML 1"], type: "question", senderExternalId: "buyer-888",
    externalConversationId: "/questions/888", externalMessageId: "ml-msg-2",
  });
  const { conversation } = await persistInboundMessage(normalized);
  assert.notEqual(conversation.id, conversation.externalConversationId);
  assert.equal(conversation.externalConversationId, "/questions/888");
});

test("evento com o mesmo externalMessageId nunca duplica a mensagem (idempotência)", async () => {
  const normalized = normalizeInboundMessage({
    channel: "MERCADO_LIVRE", channelAccountId: accountIds["Teste Mensageria ML 1"], type: "question", senderExternalId: "buyer-999",
    externalConversationId: "/questions/999", externalMessageId: "ml-msg-3",
  });
  const first = await persistInboundMessage(normalized);
  const second = await persistInboundMessage(normalized);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.message.id, second.message.id);
  const count = await prisma.message.count({ where: { externalId: accountIds["Teste Mensageria ML 1"] + ":ml-msg-3" } });
  assert.equal(count, 1);
});

test("duas contas do mesmo canal mantêm conversas e IDs externos isolados", async () => {
  const base = {
    channel: "MERCADO_LIVRE", type: "question", senderExternalId: "buyer-shared",
    externalConversationId: "/questions/shared", externalMessageId: "same-provider-id",
  };
  const first = await persistInboundMessage(normalizeInboundMessage({
    ...base, channelAccountId: accountIds["Teste Mensageria ML 1"],
  }));
  const second = await persistInboundMessage(normalizeInboundMessage({
    ...base, channelAccountId: accountIds["Teste Mensageria ML 2"],
  }));
  assert.notEqual(first.conversation.id, second.conversation.id);
  assert.notEqual(first.contact.id, second.contact.id);
  assert.notEqual(first.message.externalId, second.message.externalId);
  assert.equal(first.conversation.channelAccountId, accountIds["Teste Mensageria ML 1"]);
  assert.equal(second.conversation.channelAccountId, accountIds["Teste Mensageria ML 2"]);
});

test("Google Review normaliza para o tipo de conversa REVIEW", async () => {
  const normalized = normalizeInboundMessage({
    channel: "GOOGLE_REVIEWS", channelAccountId: accountIds["Teste Mensageria Google"], type: "review", senderExternalId: "reviewer-1", senderName: "Cliente Google",
    externalMessageId: "gr-1", text: "Ótimo atendimento!",
  });
  const { conversation } = await persistInboundMessage(normalized);
  assert.equal(conversation.kind, "REVIEW");
});

test("Reclame Aqui normaliza para o tipo de conversa COMPLAINT (caso, não chat)", async () => {
  const normalized = normalizeInboundMessage({
    channel: "RECLAME_AQUI", channelAccountId: accountIds["Teste Mensageria RA"], type: "unknown", senderExternalId: "case-1", senderName: "Reclamante",
    externalMessageId: "ra-1",
  });
  const { conversation } = await persistInboundMessage(normalized);
  assert.equal(conversation.kind, "COMPLAINT");
});

test("E-mail mantém threading via externalConversationId (thread do provider)", async () => {
  const normalized = normalizeInboundMessage({
    channel: "EMAIL", channelAccountId: accountIds["Teste Mensageria Email"], type: "text", senderExternalId: "cliente@exemplo.com", senderName: "Cliente Exemplo",
    externalConversationId: "thread-abc-123", externalMessageId: "email-msg-1", text: "Preciso de ajuda com meu pedido.",
  });
  const { conversation } = await persistInboundMessage(normalized);
  assert.equal(conversation.kind, "EMAIL_THREAD");
  assert.equal(conversation.externalConversationId, "thread-abc-123");
});
