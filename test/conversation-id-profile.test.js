require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const inbox = require("../src/services/inbox-service");

const externalId = "conversation-id-profile-test";
const masterEmail = "master-conv-id-test@teste.local";
let master;

async function cleanup() {
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: externalId } } });
}

test.before(async () => {
  master = await prisma.user.upsert({
    where: { email: masterEmail }, update: {},
    create: { name: "Master Conversa ID Teste", email: masterEmail, role: "ADMIN" },
  });
});

test.after(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { email: masterEmail } });
  await prisma.$disconnect();
});

async function seedConversation({ status = "NOVO", phoneSuffix = "0" } = {}) {
  const contact = await prisma.contact.create({ data: { companyId: "cmp_mibro",
    externalId: `${externalId}-${phoneSuffix}`, phone: `551188880${phoneSuffix.padStart(3, "0")}`, name: "Cliente Perfil",
  } });
  const conversation = await prisma.conversation.create({ data: { companyId: "cmp_mibro", contactId: contact.id, status } });
  return { contact, conversation };
}

test("o perfil da conversa expõe o Conversation.id real, distinto do contactId e do telefone", async () => {
  await cleanup();
  const { contact, conversation } = await seedConversation({ phoneSuffix: "1" });
  const detail = await inbox.getConversation(conversation.id, master);
  assert.equal(detail.id, conversation.id);
  assert.notEqual(detail.id, contact.id);
  assert.notEqual(detail.id, contact.phone);
});

// Os testes de "Analisar para aprendizado" (sistema de Bots legado) foram
// arquivados em _archive/bot-legacy/code/test/conversation-id-profile.test.js.
