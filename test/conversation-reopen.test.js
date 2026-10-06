require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { saveIncoming, updateStatus } = require("../src/services/message-service");
const settingsService = require("../src/services/conversation-settings-service");

const testContacts = ["reopen-audit-test", "reopen-status-test", "reopen-disabled-test"];
const testEmail = "admin-reopen@test.local";

let originalSettings;
let admin;

test.before(async () => {
  originalSettings = await settingsService.getConversationSettings();
  admin = await prisma.user.create({ data: { companyAccess: { create: { companyId: "cmp_mibro" } }, name: "Admin Reabertura", email: testEmail, role: "ADMIN" } });
});

test.after(async () => {
  await prisma.contact.deleteMany({ where: { externalId: { in: testContacts } } });
  await prisma.conversationSettings.update({
    where: { id: "singleton" },
    data: {
      reopenConversationOnCustomerMessage: originalSettings.reopenConversationOnCustomerMessage,
      reopenWindowMinutes: originalSettings.reopenWindowMinutes,
    },
  });
  settingsService.invalidateCache();
  await prisma.user.deleteMany({ where: { email: testEmail } });
  await prisma.$disconnect();
});

test("mensagem real do cliente reabre conversa FINALIZADA e registra REOPENED_BY_CUSTOMER_MESSAGE", async () => {
  const contact = await prisma.contact.create({
    data: { companyId: "cmp_mibro", externalId: testContacts[0], phone: "5511900000101", name: "Cliente reabertura" },
  });
  const conversation = await prisma.conversation.create({
    data: { companyId: "cmp_mibro", contactId: contact.id, status: "FINALIZADO", finalizedAt: new Date() },
  });

  await saveIncoming({
    externalId: "wamid.reopen.audit", contactExternalId: testContacts[0],
    phone: "5511900000101", contactName: "Cliente reabertura", type: "text", text: "Oi, voltei",
    occurredAt: new Date(), rawPayload: { id: "wamid.reopen.audit" },
  });

  const reopened = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(reopened.status, "NOVO");
  assert.equal(reopened.finalizedAt, null);
  const activity = await prisma.conversationActivity.findFirst({
    where: { conversationId: conversation.id, action: "REOPENED_BY_CUSTOMER_MESSAGE" },
  });
  assert.ok(activity, "deveria registrar REOPENED_BY_CUSTOMER_MESSAGE");
});

test("webhook de status (entregue/lido) não reabre conversa finalizada", async () => {
  const contact = await prisma.contact.create({
    data: { companyId: "cmp_mibro", externalId: testContacts[1], phone: "5511900000102", name: "Cliente status" },
  });
  const conversation = await prisma.conversation.create({
    data: { companyId: "cmp_mibro", contactId: contact.id, status: "FINALIZADO", finalizedAt: new Date() },
  });
  const message = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: "wamid.reopen.status", channel: "META",
    direction: "ENVIADA", status: "ENVIADA", type: "text", text: "Encerrando por aqui.", occurredAt: new Date(),
  } });

  await updateStatus({ externalId: message.externalId, status: "delivered" });
  await updateStatus({ externalId: message.externalId, status: "read" });

  const untouched = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(untouched.status, "FINALIZADO");
  const activity = await prisma.conversationActivity.findFirst({
    where: { conversationId: conversation.id, action: "REOPENED_BY_CUSTOMER_MESSAGE" },
  });
  assert.equal(activity, null);
});

test("reopenConversationOnCustomerMessage = false: mensagem do cliente não reabre a conversa", async () => {
  const contact = await prisma.contact.create({
    data: { companyId: "cmp_mibro", externalId: testContacts[2], phone: "5511900000103", name: "Cliente sem reabertura" },
  });
  const conversation = await prisma.conversation.create({
    data: { companyId: "cmp_mibro", contactId: contact.id, status: "FINALIZADO", finalizedAt: new Date() },
  });

  await settingsService.updateConversationSettings(
    { reopenConversationOnCustomerMessage: false },
    admin,
  );

  await saveIncoming({
    externalId: "wamid.reopen.disabled", contactExternalId: testContacts[2],
    phone: "5511900000103", contactName: "Cliente sem reabertura", type: "text", text: "Oi?",
    occurredAt: new Date(), rawPayload: { id: "wamid.reopen.disabled" },
  });

  const stillFinalized = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(stillFinalized.status, "FINALIZADO");

  await settingsService.updateConversationSettings(
    { reopenConversationOnCustomerMessage: true },
    admin,
  );
});
