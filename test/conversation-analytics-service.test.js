// Motor de agregação do Relatório de Conversas — cobre a classificação
// BOT/HUMAN/CUSTOMER, cálculo de primeira resposta/tempo de resposta (nunca
// contando o Bot), detecção de "nunca respondida", comparação com período
// anterior e atribuição de resposta ao agente que realmente respondeu (não
// ao responsável atual da conversa). Nunca assume ser o único teste rodando
// contra o banco — sempre procura as próprias linhas pelo contato/usuário
// de teste.
require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const analytics = require("../src/services/conversation-analytics-service");

const emailPrefix = "analytics-teste";
const contactPrefix = "analytics-contato";

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: emailPrefix } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const contacts = await prisma.contact.findMany({ where: { externalId: { startsWith: contactPrefix } }, select: { id: true } });
  const contactIds = contacts.map((c) => c.id);
  const conversations = await prisma.conversation.findMany({ where: { contactId: { in: contactIds } }, select: { id: true } });
  const conversationIds = conversations.map((c) => c.id);
  await prisma.conversationActivity.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.conversation.deleteMany({ where: { contactId: { in: contactIds } } });
  await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

test.before(cleanup);
test.after(async () => { await cleanup(); await prisma.$disconnect(); });

const NOW = new Date();
const inPeriod = new Date(NOW.getTime() - 60 * 60 * 1000); // 1h atrás — dentro de "Hoje" e "Últimos 7 dias"

test("classifica corretamente CUSTOMER/BOT/HUMAN e nunca conta o Bot como primeira resposta", async () => {
  const agent = await prisma.user.create({ data: { name: "Vendedor Analytics", email: `${emailPrefix}-agent-a@mibro.local`, role: "ATENDENTE" } });
  const contact = await prisma.contact.create({ data: { externalId: `${contactPrefix}-bot-first`, phone: "5511911110001", name: "Cliente Bot Primeiro" } });
  const conversation = await prisma.conversation.create({
    data: { contactId: contact.id, assignedUserId: agent.id, createdAt: inPeriod, lastMessageAt: inPeriod },
  });
  await prisma.message.create({ data: { conversationId: conversation.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text", text: "Oi", occurredAt: inPeriod } });
  // Bot responde primeiro — NÃO pode contar como "primeira resposta".
  await prisma.message.create({ data: {
    conversationId: conversation.id, direction: "ENVIADA", status: "ENVIADA", type: "text", text: "Bot: como posso ajudar?",
    occurredAt: new Date(inPeriod.getTime() + 5000), sentByUserId: null,
  } });
  // Só depois o humano responde.
  await prisma.message.create({ data: {
    conversationId: conversation.id, direction: "ENVIADA", status: "ENVIADA", type: "text", text: "Deixa eu te ajudar",
    occurredAt: new Date(inPeriod.getTime() + 60000), sentByUserId: agent.id,
  } });

  const detail = await analytics.getConversationDetail(conversation.id);
  assert.equal(detail.metrics.messageCounts.customer, 1);
  assert.equal(detail.metrics.messageCounts.bot, 1);
  assert.equal(detail.metrics.messageCounts.human, 1);
  assert.equal(detail.metrics.answeredByAgent, true);
  // Primeira resposta = 60s (cliente -> humano), NUNCA os 5s até o Bot.
  assert.equal(Math.round(detail.metrics.firstResponseSeconds), 60);
});

test("detecta conversa nunca respondida (nem pelo Bot) e alimenta o alerta correspondente", async () => {
  const contact = await prisma.contact.create({ data: { externalId: `${contactPrefix}-never`, phone: "5511911110002", name: "Cliente Nunca Respondido" } });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id, createdAt: inPeriod, lastMessageAt: inPeriod } });
  await prisma.message.create({ data: { conversationId: conversation.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text", text: "Alguém aí?", occurredAt: inPeriod } });

  const summary = await analytics.getSummary({ period: "today" });
  const row = summary.current;
  assert.ok(row.neverAnswered >= 1, "deveria contar ao menos a conversa nunca respondida criada neste teste");

  const alerts = await analytics.getAlerts({});
  const neverAnsweredAlert = alerts.find((a) => a.key === "never_answered");
  assert.ok(neverAnsweredAlert.count >= 1);

  const detail = await analytics.getConversationDetail(conversation.id);
  assert.equal(detail.metrics.answered, false);
  assert.equal(detail.metrics.firstResponseSeconds, null);
});

test("atribui a resposta a quem REALMENTE respondeu, não ao responsável atual da conversa", async () => {
  const [agentA, agentB] = await Promise.all([
    prisma.user.create({ data: { name: "Vendedor Atribuicao A", email: `${emailPrefix}-attr-a@mibro.local`, role: "ATENDENTE" } }),
    prisma.user.create({ data: { name: "Vendedor Atribuicao B", email: `${emailPrefix}-attr-b@mibro.local`, role: "ATENDENTE" } }),
  ]);
  const contact = await prisma.contact.create({ data: { externalId: `${contactPrefix}-attr`, phone: "5511911110003", name: "Cliente Atribuicao" } });
  // Responsável ATUAL é o agente B, mas quem respondeu de fato foi o A.
  const conversation = await prisma.conversation.create({
    data: { contactId: contact.id, assignedUserId: agentB.id, createdAt: inPeriod, lastMessageAt: inPeriod },
  });
  await prisma.message.create({ data: { conversationId: conversation.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text", text: "Preciso de ajuda", occurredAt: inPeriod } });
  await prisma.message.create({ data: {
    conversationId: conversation.id, direction: "ENVIADA", status: "ENVIADA", type: "text", text: "Claro!",
    occurredAt: new Date(inPeriod.getTime() + 30000), sentByUserId: agentA.id,
  } });

  const ranking = await analytics.getAgentRanking({ period: "today" });
  const rowA = ranking.agents.find((a) => a.userId === agentA.id);
  assert.ok(rowA, "vendedor A deveria aparecer no ranking por ter respondido de fato");
  assert.equal(Math.round(rowA.firstResponseAvgSeconds), 30);
});

test("comparação com período anterior: 'ontem' nunca aparece nas métricas de 'hoje'", async () => {
  const yesterday = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
  const contactToday = await prisma.contact.create({ data: { externalId: `${contactPrefix}-cmp-today`, phone: "5511911110004", name: "Cliente Hoje" } });
  const contactYesterday = await prisma.contact.create({ data: { externalId: `${contactPrefix}-cmp-yday`, phone: "5511911110005", name: "Cliente Ontem" } });
  await prisma.conversation.create({ data: { contactId: contactToday.id, createdAt: inPeriod, lastMessageAt: inPeriod } });
  await prisma.conversation.create({ data: { contactId: contactYesterday.id, createdAt: yesterday, lastMessageAt: yesterday } });

  const summary = await analytics.getSummary({ period: "today" });
  const ourTodayCount = summary.current.conversationsReceived;
  // A conversa de ontem não pode ter sido contada em "hoje".
  const onlyToday = await analytics.listConversations({ period: "today", search: "Cliente Ontem" });
  assert.equal(onlyToday.items.length, 0, "conversa de ontem não deveria aparecer no filtro 'hoje'");
  assert.ok(ourTodayCount >= 1);
});

test("listConversations: busca por nome de contato e paginação respeitam os filtros", async () => {
  const contact = await prisma.contact.create({ data: { externalId: `${contactPrefix}-search`, phone: "5511911110006", name: "Zebedeu Buscavel Teste" } });
  await prisma.conversation.create({ data: { contactId: contact.id, createdAt: inPeriod, lastMessageAt: inPeriod } });

  const result = await analytics.listConversations({ period: "today", search: "Zebedeu", pageSize: 25, page: 1 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].contactName, "Zebedeu Buscavel Teste");
});
