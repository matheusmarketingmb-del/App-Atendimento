require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const inbox = require("../src/services/inbox-service");
const learning = require("../src/services/bot-learning-service");

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
  const contact = await prisma.contact.create({ data: {
    externalId: `${externalId}-${phoneSuffix}`, phone: `551188880${phoneSuffix.padStart(3, "0")}`, name: "Cliente Perfil",
  } });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id, status } });
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

test("analisar para aprendizado usa exatamente a conversa informada, não outra", async () => {
  await cleanup();
  const { conversation: target } = await seedConversation({ status: "FINALIZADO", phoneSuffix: "2" });
  const { conversation: other } = await seedConversation({ status: "FINALIZADO", phoneSuffix: "3" });
  await prisma.message.create({ data: {
    conversationId: target.id, externalId: `conv-id-msg-${target.id}`, direction: "RECEBIDA", status: "RECEBIDA",
    type: "text", text: "minha duvida", occurredAt: new Date(),
  } });
  await prisma.message.create({ data: {
    conversationId: other.id, externalId: `conv-id-msg-${other.id}`, direction: "RECEBIDA", status: "RECEBIDA",
    type: "text", text: "outra duvida", occurredAt: new Date(),
  } });

  await learning.analyzeConversationManually(target.id, master);

  const targetState = await prisma.conversationLearningState.findUnique({ where: { conversationId: target.id } });
  const otherState = await prisma.conversationLearningState.findUnique({ where: { conversationId: other.id } });
  assert.ok(targetState, "a conversa analisada deveria ter estado de aprendizado registrado");
  assert.equal(otherState, null, "uma conversa diferente da informada não deveria ser tocada");
});

test("usuário sem permissão de Bots (não-master) não pode analisar pelo ID da conversa", async () => {
  await cleanup();
  const { conversation } = await seedConversation({ status: "FINALIZADO", phoneSuffix: "4" });
  const attendant = { id: "atendente-conv-id-test", role: "ATENDENTE" };
  await assert.rejects(
    () => learning.analyzeConversationManually(conversation.id, attendant),
    (error) => error.statusCode === 403,
  );
});

test("conversa incompatível (não finalizada) não é finalizada automaticamente ao tentar analisar", async () => {
  await cleanup();
  const { conversation } = await seedConversation({ status: "NOVO", phoneSuffix: "5" });
  await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: `conv-id-msg-open-${conversation.id}`, direction: "RECEBIDA",
    status: "RECEBIDA", type: "text", text: "ainda em aberto", occurredAt: new Date(),
  } });

  const result = await learning.analyzeConversationManually(conversation.id, master);
  assert.equal(result.analyzed, false);
  assert.equal(result.reason, "CONVERSATION_NOT_FINALIZED");

  const after = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(after.status, "NOVO", "a conversa não deveria ter sido finalizada automaticamente");
});

test("analisar para aprendizado não envia nenhuma mensagem nem altera o histórico da conversa", async () => {
  await cleanup();
  const { conversation } = await seedConversation({ status: "FINALIZADO", phoneSuffix: "6" });
  await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: `conv-id-msg-send-${conversation.id}`, direction: "RECEBIDA",
    status: "RECEBIDA", type: "text", text: "problema resolvido, obrigado", occurredAt: new Date(),
  } });
  const messageCountBefore = await prisma.message.count({ where: { conversationId: conversation.id } });

  await learning.analyzeConversationManually(conversation.id, master);

  const messageCountAfter = await prisma.message.count({ where: { conversationId: conversation.id } });
  assert.equal(messageCountAfter, messageCountBefore, "nenhuma mensagem deve ser criada pela análise de aprendizado");
});
