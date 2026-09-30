require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const prisma = require("../src/database/prisma");
const { encryptSecrets } = require("../src/services/channels/integration-secret-service");
const { persistInboundMessage } = require("../src/services/channels/omnichannel-message-service");
const { sendText } = require("../src/services/message-service");
const { removeImage } = require("../src/services/media-storage-service");
const { createOutboundEmail, listOutboundChannels } = require("../src/services/outbound-conversation-service");

const prefix = `email-outbound-${process.pid}`;
let account;
let allowed;
let denied;
let conversation;

function decodeRaw(raw) { return Buffer.from(raw, "base64url").toString("utf8"); }

test.before(async () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = "33".repeat(32);
  await prisma.integrationGlobalSettings.upsert({ where: { id: "singleton" }, update: { newChannelsEnabled: true }, create: { id: "singleton", newChannelsEnabled: true } });
  allowed = await prisma.user.create({ data: { name: "Pode iniciar", email: `${prefix}-allowed@example.com`, role: "ATENDENTE", canViewUncategorized: true, canStartConversations: true } });
  denied = await prisma.user.create({ data: { name: "Não pode iniciar", email: `${prefix}-denied@example.com`, role: "ATENDENTE", canViewUncategorized: true } });
  account = await prisma.channelAccount.create({ data: {
    channel: "EMAIL", name: prefix, status: "CONNECTED", enabled: true, oauthProvider: "GOOGLE",
    tokenExpiresAt: new Date(Date.now() + 3600000), config: { provider: "GMAIL" },
    providerMetadata: { username: "central@example.com" },
    ...encryptSecrets({ accessToken: "gmail-access", refreshToken: "gmail-refresh" }),
    accessUsers: { create: { userId: allowed.id } },
  } });
  const persisted = await persistInboundMessage({
    channel: "EMAIL", channelAccountId: account.id, senderExternalId: "cliente@example.com", senderName: "Cliente",
    externalConversationId: "thread-reply", externalMessageId: "gmail-inbound", direction: "RECEBIDA",
    type: "text", text: "Preciso de ajuda", occurredAt: new Date(),
    metadata: { subject: "Pedido 123", threadId: "thread-reply", messageId: "<message-id@example.com>", references: "<older@example.com>" },
  });
  conversation = persisted.conversation;
});

test.after(async () => {
  await prisma.message.deleteMany({ where: { channelAccountId: account.id } });
  await prisma.conversation.deleteMany({ where: { channelAccountId: account.id } });
  await prisma.contact.deleteMany({ where: { channel: "EMAIL", externalId: { startsWith: `${account.id}:` } } });
  await prisma.channelAccount.delete({ where: { id: account.id } });
  await prisma.user.deleteMany({ where: { id: { in: [allowed.id, denied.id] } } });
  await prisma.$disconnect();
});

test("resposta de conversa EMAIL usa Gmail e preserva destinatário/thread", async (t) => {
  let request;
  t.mock.method(axios, "post", async (url, body) => {
    request = { url, body };
    return { data: { id: "gmail-reply", threadId: "thread-reply" } };
  });
  const result = await sendText({
    conversationId: conversation.id, text: "Segue a resposta", sentByUserId: allowed.id,
    channel: { sendText: async () => { throw new Error("Meta não deve ser usada"); } },
  });
  assert.match(request.url, /gmail\/v1\/users\/me\/messages\/send$/);
  assert.equal(request.body.threadId, "thread-reply");
  const raw = decodeRaw(request.body.raw);
  assert.match(raw, /To: cliente@example\.com/);
  assert.match(raw, /Subject: Re: Pedido 123/);
  assert.match(raw, /In-Reply-To: <message-id@example\.com>/);
  assert.equal(result.message.channel, "EMAIL");
  assert.equal(result.message.channelAccountId, account.id);
});

test("somente usuário autorizado pode ver o canal e iniciar novo e-mail", async (t) => {
  const allowedOptions = await listOutboundChannels(allowed);
  assert.equal(allowedOptions.find((item) => item.channel === "EMAIL").enabled, true);
  assert.equal(allowedOptions.find((item) => item.channel === "META").enabled, false);
  assert.deepEqual(await listOutboundChannels(denied), []);
  await assert.rejects(() => createOutboundEmail({
    accountId: account.id, to: "novo@example.com", customName: "Novo", subject: "Olá", text: "Mensagem", user: denied,
  }), (error) => error.statusCode === 403);

  t.mock.method(axios, "post", async () => ({ data: { id: "gmail-new", threadId: "thread-new" } }));
  const created = await createOutboundEmail({
    accountId: account.id, to: "novo@example.com", customName: "Novo", subject: "Olá", text: "Mensagem", user: allowed,
  });
  assert.equal(created.created, true);
  const stored = await prisma.conversation.findUnique({ where: { id: created.conversationId }, include: { contact: true } });
  assert.equal(stored.channel, "EMAIL");
  assert.equal(stored.contact.email, "novo@example.com");
  assert.equal(stored.externalConversationId, "thread-new");
});

test("novo e-mail envia e persiste documentos", async (t) => {
  let request;
  t.mock.method(axios, "post", async (url, body) => {
    request = { url, body };
    return { data: { id: "gmail-docs", threadId: "thread-docs" } };
  });
  const created = await createOutboundEmail({
    accountId: account.id, to: "docs@example.com", customName: "Documentos", subject: "Manual", text: "Segue o manual.", user: allowed,
    attachments: [{ buffer: Buffer.from("%PDF-1.4\n% test document\n"), mimeType: "application/pdf", fileName: "manual.pdf" }],
  });
  const raw = decodeRaw(request.body.raw);
  assert.match(raw, /multipart\/mixed/);
  assert.match(raw, /filename="manual\.pdf"/);
  assert.equal(created.attachments.length, 1);
  assert.equal(created.attachments[0].type, "document");
  assert.equal(created.attachments[0].mediaFileName, "manual.pdf");
  await removeImage(created.attachments[0].mediaStorageKey);
});

test("UI expõe permissão da Equipe, oculta Nova e mantém Meta indisponível", async () => {
  const fs = require("node:fs/promises");
  const [html, js] = await Promise.all([fs.readFile("public/index.html", "utf8"), fs.readFile("public/js/app.js", "utf8")]);
  assert.match(html, /id="permission-start-conversations"/);
  assert.match(html, /id="outbound-channel-dialog"/);
  assert.match(html, /id="outbound-documents"/);
  // Botão "Nova": individual (canStartConversations) OU envio em massa (canManageCampaigns).
  assert.match(js, /new-conversation"\)\.hidden = !\(status\.user\.canStartConversations \|\| status\.user\.canManageCampaigns\)/);
  assert.match(js, /\/api\/conversations\/outbound\/email/);
  assert.match(js, /body\.append\("documents", file, file\.name\)/);
});
