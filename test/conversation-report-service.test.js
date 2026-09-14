// Relatório semanal de conversas (Configurações → Conversas, nova seção só
// Master) — cobre a classificação de cada conversa (resolvida/não
// respondida/resolvida sem resposta do vendedor) e a contagem por agente.
// Nunca assume que é o único teste rodando contra o banco (outros arquivos
// de teste também criam conversas "desta semana") — por isso as asserções
// abaixo sempre procuram as próprias linhas pelo contato/usuário de teste,
// nunca comparam totais globais exatos.
require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { buildConversationReport, weekBounds } = require("../src/services/conversation-report-service");

const emailPrefix = "relatorio-semanal-teste";
const contactPrefix = "relatorio-semanal-contato";

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: emailPrefix } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const contacts = await prisma.contact.findMany({ where: { externalId: { startsWith: contactPrefix } }, select: { id: true } });
  const contactIds = contacts.map((c) => c.id);
  await prisma.message.deleteMany({ where: { conversation: { contactId: { in: contactIds } } } });
  await prisma.conversation.deleteMany({ where: { contactId: { in: contactIds } } });
  await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

test.before(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("weekBounds: semana atual (offset 0) sempre contém 'agora', e offset -1 é a semana anterior", () => {
  const now = new Date();
  const current = weekBounds(0);
  assert.ok(now >= current.start && now < current.end);
  const previous = weekBounds(-1);
  assert.equal(previous.end.getTime(), current.start.getTime());
});

test("classifica corretamente: resolvida com agente, resolvida só por bot, e nunca respondida", async () => {
  const { start } = weekBounds(0);
  const midWeek = new Date(start.getTime() + 2 * 60 * 60 * 1000);

  const [agentA, agentB] = await Promise.all([
    prisma.user.create({ data: { name: "Vendedor A Teste", email: `${emailPrefix}-a@mibro.local`, role: "ATENDENTE" } }),
    prisma.user.create({ data: { name: "Vendedor B Teste", email: `${emailPrefix}-b@mibro.local`, role: "ATENDENTE" } }),
  ]);

  // Conversa 1: cliente escreve, vendedor A responde e finaliza.
  const contact1 = await prisma.contact.create({ data: { externalId: `${contactPrefix}-1`, phone: "5511900000001", name: "Cliente Um" } });
  const conv1 = await prisma.conversation.create({
    data: {
      contactId: contact1.id, status: "FINALIZADO", assignedUserId: agentA.id,
      createdAt: midWeek, lastMessageAt: midWeek, finalizedAt: midWeek,
    },
  });
  await prisma.message.create({ data: {
    conversationId: conv1.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text", text: "Oi, preciso de ajuda", occurredAt: midWeek,
  } });
  await prisma.message.create({ data: {
    conversationId: conv1.id, direction: "ENVIADA", status: "ENVIADA", type: "text", text: "Claro, como posso ajudar?",
    occurredAt: new Date(midWeek.getTime() + 1000), sentByUserId: agentA.id,
  } });

  // Conversa 2: só o Bot respondeu (sentByUserId nulo), mas foi finalizada —
  // "finalizada sem resposta do vendedor".
  const contact2 = await prisma.contact.create({ data: { externalId: `${contactPrefix}-2`, phone: "5511900000002", name: "Cliente Dois" } });
  const conv2 = await prisma.conversation.create({
    data: { contactId: contact2.id, status: "FINALIZADO", createdAt: midWeek, lastMessageAt: midWeek, finalizedAt: midWeek },
  });
  await prisma.message.create({ data: {
    conversationId: conv2.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text", text: "Qual o horário de funcionamento?", occurredAt: midWeek,
  } });
  await prisma.message.create({ data: {
    conversationId: conv2.id, direction: "ENVIADA", status: "ENVIADA", type: "text", text: "Funcionamos das 9h às 18h.",
    occurredAt: new Date(midWeek.getTime() + 1000), sentByUserId: null,
  } });

  // Conversa 3: cliente escreveu e NUNCA teve nenhuma resposta (nem bot, nem humano).
  const contact3 = await prisma.contact.create({ data: { externalId: `${contactPrefix}-3`, phone: "5511900000003", name: "Cliente Três" } });
  const conv3 = await prisma.conversation.create({
    data: { contactId: contact3.id, status: "NOVO", createdAt: midWeek, lastMessageAt: midWeek },
  });
  await prisma.message.create({ data: {
    conversationId: conv3.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text", text: "Alguém aí?", occurredAt: midWeek,
  } });

  // Vendedor B só manda mensagens (conversa não finalizada), pra testar contagem por agente.
  const contact4 = await prisma.contact.create({ data: { externalId: `${contactPrefix}-4`, phone: "5511900000004", name: "Cliente Quatro" } });
  const conv4 = await prisma.conversation.create({
    data: { contactId: contact4.id, status: "EM_ATENDIMENTO", assignedUserId: agentB.id, createdAt: midWeek, lastMessageAt: midWeek },
  });
  await prisma.message.create({ data: {
    conversationId: conv4.id, direction: "ENVIADA", status: "ENVIADA", type: "text", text: "Mensagem 1", occurredAt: midWeek, sentByUserId: agentB.id,
  } });
  await prisma.message.create({ data: {
    conversationId: conv4.id, direction: "ENVIADA", status: "ENVIADA", type: "text", text: "Mensagem 2", occurredAt: midWeek, sentByUserId: agentB.id,
  } });

  const report = await buildConversationReport({ weekOffset: 0 });

  const row1 = report.conversations.find((item) => item.contactPhone === "5511900000001");
  assert.ok(row1, "conversa 1 deveria aparecer no relatório da semana");
  assert.equal(row1.resolved, true);
  assert.equal(row1.answered, true);
  assert.equal(row1.answeredByAgent, true);
  assert.equal(row1.resolvedWithoutAgentResponse, false);
  assert.equal(row1.lastMessagePreview, "Claro, como posso ajudar?");

  const row2 = report.conversations.find((item) => item.contactPhone === "5511900000002");
  assert.ok(row2, "conversa 2 deveria aparecer no relatório da semana");
  assert.equal(row2.resolved, true);
  assert.equal(row2.answered, true);
  assert.equal(row2.answeredByAgent, false);
  assert.equal(row2.resolvedWithoutAgentResponse, true, "finalizada só com resposta do Bot deveria contar como 'sem resposta do vendedor'");

  const row3 = report.conversations.find((item) => item.contactPhone === "5511900000003");
  assert.ok(row3, "conversa 3 deveria aparecer no relatório da semana");
  assert.equal(row3.resolved, false);
  assert.equal(row3.answered, false, "conversa sem nenhuma mensagem enviada deveria contar como não respondida");
  assert.equal(row3.lastMessagePreview, "Alguém aí?");

  const agentAEntry = report.perAgent.find((item) => item.userId === agentA.id);
  assert.ok(agentAEntry);
  assert.equal(agentAEntry.messagesSent, 1);
  assert.equal(agentAEntry.conversationsFinalized, 1);

  const agentBEntry = report.perAgent.find((item) => item.userId === agentB.id);
  assert.ok(agentBEntry);
  assert.equal(agentBEntry.messagesSent, 2);
  assert.equal(agentBEntry.conversationsFinalized, 0);

  // Vendedor B mandou mais mensagens que o Vendedor A nesta amostra — a
  // ordenação de perAgent é por messagesSent desc, então B precisa aparecer
  // antes de A na lista.
  const indexA = report.perAgent.findIndex((item) => item.userId === agentA.id);
  const indexB = report.perAgent.findIndex((item) => item.userId === agentB.id);
  assert.ok(indexB < indexA, "vendedor com mais mensagens enviadas deveria vir primeiro");
});
