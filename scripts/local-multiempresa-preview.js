// Dados fictícios exclusivos do banco QA local; nunca carrega o .env.
process.env.DATABASE_URL = "postgresql://bot_qa:isolated-local-qa@127.0.0.1:25432/bot_qa";
process.env.NODE_ENV = "test";
const prisma = require("../src/database/prisma");
const bcrypt = require("bcryptjs");

async function preparePreview() {
  const user = await prisma.user.upsert({
    where: { email: "bot-qa@teste.local" }, update: {},
    create: { name: "Master QA local", email: "bot-qa@teste.local", role: "ADMIN", passwordHash: await bcrypt.hash("teste-local-bots", 4) },
  });
  for (const [companyId, label] of [["cmp_mibro", "Mibro Brasil"], ["cmp_sincrofit", "Sincrofit"]]) {
    const contactId = `preview-contact-${companyId}`;
    await prisma.contact.upsert({ where: { id: contactId }, update: {}, create: {
      id: contactId, companyId, externalId: `preview-${companyId}`, name: `Cliente demonstração — ${label}`, channel: "META",
    } });
    const conversationId = `preview-conversation-${companyId}`;
    await prisma.conversation.upsert({ where: { id: conversationId }, update: {}, create: {
      id: conversationId, companyId, contactId, channel: "META", assignedUserId: user.id,
      status: "EM_ATENDIMENTO", lastMessageAt: new Date(),
    } });
    await prisma.message.upsert({ where: { id: `preview-message-${companyId}` }, update: {}, create: {
      id: `preview-message-${companyId}`, conversationId, direction: "RECEBIDA", status: "RECEBIDA", type: "text", occurredAt: new Date(),
      text: `Olá! Gostaria de conhecer os produtos da ${label}. Esta é uma conversa fictícia para a prévia local.`,
    } });
    await prisma.quickReply.upsert({ where: { id: `preview-reply-${companyId}` }, update: {}, create: {
      id: `preview-reply-${companyId}`, name: `Boas-vindas — ${label}`, shortcut: `/ola-${companyId.replace("cmp_", "")}`,
      text: `Olá! Seja bem-vindo(a) à ${label}. Como podemos ajudar?`, scope: "COMPANY", companyId, createdByUserId: user.id,
    } });
  }
  await prisma.quickReply.upsert({ where: { id: "preview-reply-global" }, update: {}, create: {
    id: "preview-reply-global", name: "Solicitar número do pedido", shortcut: "/pedido",
    text: "Pode me informar o número do seu pedido, por favor?", scope: "GLOBAL", createdByUserId: user.id,
  } });
  console.log("Dados fictícios preparados: 2 empresas, 2 conversas e 3 respostas rápidas.");
}

preparePreview().then(() => require("./local-bot-question-answer-preview")).catch(async (error) => {
  console.error(error.message);
  await prisma.$disconnect();
  process.exitCode = 1;
});
