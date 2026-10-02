require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { submitAgentFeedback } = require("../src/services/bot-agent-feedback-service");

const externalId = "bot-agent-feedback-test-contact";
const agentEmail = "agente-feedback-test@teste.local";
let agent;

test.before(async () => {
  agent = await prisma.user.upsert({
    where: { email: agentEmail }, update: {}, create: { name: "Atendente Feedback Teste", email: agentEmail, role: "ATENDENTE" },
  });
});
test.after(async () => {
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: externalId } } });
  await prisma.user.deleteMany({ where: { email: agentEmail } });
  await prisma.$disconnect();
});

test("feedback do atendente é distinto da avaliação do cliente e não pode ser duplicado na mesma conversa", async () => {
  const contact = await prisma.contact.create({ data: { externalId, phone: "5511900002001", name: "Cliente" } });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });

  const created = await submitAgentFeedback(conversation.id, { helpful: true, comment: "Ajudou bastante" }, agent);
  assert.equal(created.helpful, true);
  assert.equal(created.userId, agent.id);

  await assert.rejects(() => submitAgentFeedback(conversation.id, { helpful: false }, agent));

  const custBotRatings = await prisma.botRating.count({ where: { conversationId: conversation.id } });
  assert.equal(custBotRatings, 0, "feedback do atendente não deve criar/afetar BotRating (avaliação do cliente)");
});

test("exige valor booleano para helpful", async () => {
  const contact = await prisma.contact.create({ data: { externalId: `${externalId}-2`, phone: "5511900002002", name: "Cliente 2" } });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
  await assert.rejects(() => submitAgentFeedback(conversation.id, {}, agent));
});
