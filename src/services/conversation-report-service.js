// Relatório semanal de conversas (Configurações → Conversas → nova seção,
// visível só para Master). Sempre calculado NA HORA a partir do estado atual
// do banco — nunca um job/cron nem uma tabela de snapshot: "atualizado por
// semana" aqui significa que a semana de referência sempre é a atual (ou
// qualquer semana anterior pedida via `weekOffset`), então o relatório já
// nasce sempre em dia, sem depender de nenhum processo em segundo plano.
//
// Semana = segunda 00:00 até o domingo seguinte 23:59:59 (horário local do
// servidor), mesmo padrão usado no resto do sistema (nenhuma conversão de
// fuso horário adicional é feita aqui).
const prisma = require("../database/prisma");

function weekBounds(weekOffset = 0) {
  const now = new Date();
  const diffToMonday = (now.getDay() + 6) % 7; // 0 = segunda, ..., 6 = domingo
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday + weekOffset * 7);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const lastDay = new Date(end.getTime() - 1);
  const fmt = (date) => date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  return { start, end, label: `${fmt(start)} a ${fmt(lastDay)}` };
}

const MEDIA_LABELS = { image: "[imagem]", video: "[vídeo]", audio: "[áudio]", document: "[documento]", sticker: "[figurinha]", reaction: "[reação]" };
function previewFor(message) {
  if (!message) return null;
  if (message.type === "text" && message.text) return message.text.slice(0, 160);
  return MEDIA_LABELS[message.type] || `[${message.type}]`;
}

function contactLabel(contact) {
  if (!contact) return "Contato removido";
  return contact.customName || contact.name || contact.phone || contact.email || "Sem nome";
}

const CONVERSATION_LIST_LIMIT = 500;

async function buildConversationReport({ weekOffset = 0 } = {}, client = prisma) {
  const { start, end, label } = weekBounds(Number.isFinite(Number(weekOffset)) ? Number(weekOffset) : 0);

  // Coorte da semana: qualquer conversa com atividade (última mensagem) OU
  // criada dentro da janela — cobre tanto "conversa nova esta semana" quanto
  // "conversa antiga que teve movimento esta semana".
  const cohort = await client.conversation.findMany({
    where: {
      OR: [
        { lastMessageAt: { gte: start, lt: end } },
        { createdAt: { gte: start, lt: end } },
      ],
    },
    select: {
      id: true, status: true, finalizedAt: true, lastMessageAt: true, createdAt: true, assignedUserId: true,
      assignedUser: { select: { id: true, name: true } },
      contact: { select: { name: true, customName: true, phone: true, email: true } },
      category: { select: { name: true, color: true } },
    },
    orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
    take: CONVERSATION_LIST_LIMIT,
  });
  const cohortIds = cohort.map((item) => item.id);

  const [answeredGroups, answeredByAgentGroups, lastMessages, finalizedTotal, agentActivity, agentFinalized] = await Promise.all([
    cohortIds.length
      ? client.message.groupBy({ by: ["conversationId"], where: { conversationId: { in: cohortIds }, direction: "ENVIADA" }, _count: { _all: true } })
      : [],
    cohortIds.length
      ? client.message.groupBy({ by: ["conversationId"], where: { conversationId: { in: cohortIds }, direction: "ENVIADA", sentByUserId: { not: null } }, _count: { _all: true } })
      : [],
    cohortIds.length
      ? client.message.findMany({
        where: { conversationId: { in: cohortIds } }, orderBy: { occurredAt: "desc" }, distinct: ["conversationId"],
        select: { conversationId: true, text: true, type: true, direction: true, occurredAt: true },
      })
      : [],
    client.conversation.count({ where: { status: "FINALIZADO", finalizedAt: { gte: start, lt: end } } }),
    client.message.groupBy({
      by: ["sentByUserId"], where: { direction: "ENVIADA", sentByUserId: { not: null }, occurredAt: { gte: start, lt: end } }, _count: { _all: true },
    }),
    client.conversation.groupBy({
      by: ["assignedUserId"], where: { status: "FINALIZADO", finalizedAt: { gte: start, lt: end }, assignedUserId: { not: null } }, _count: { _all: true },
    }),
  ]);

  const answeredSet = new Set(answeredGroups.map((item) => item.conversationId));
  const answeredByAgentSet = new Set(answeredByAgentGroups.map((item) => item.conversationId));
  const lastMessageByConversation = new Map(lastMessages.map((item) => [item.conversationId, item]));

  const rows = cohort.map((conversation) => {
    const answered = answeredSet.has(conversation.id);
    const answeredByAgent = answeredByAgentSet.has(conversation.id);
    const resolved = conversation.status === "FINALIZADO";
    const lastMessage = lastMessageByConversation.get(conversation.id) || null;
    return {
      id: conversation.id,
      contactName: contactLabel(conversation.contact),
      contactPhone: conversation.contact?.phone || null,
      contactEmail: conversation.contact?.email || null,
      status: conversation.status,
      categoryName: conversation.category?.name || null,
      categoryColor: conversation.category?.color || null,
      assignedUserName: conversation.assignedUser?.name || null,
      createdAt: conversation.createdAt,
      finalizedAt: conversation.finalizedAt,
      lastMessageAt: conversation.lastMessageAt,
      lastMessagePreview: previewFor(lastMessage),
      lastMessageFromCustomer: lastMessage?.direction === "RECEBIDA",
      resolved,
      answered,
      answeredByAgent,
      resolvedWithoutAgentResponse: resolved && !answeredByAgent,
    };
  });

  const totals = {
    conversationsInWeek: rows.length,
    newConversations: cohort.filter((item) => item.createdAt >= start && item.createdAt < end).length,
    resolved: rows.filter((item) => item.resolved).length,
    finalizedTotal,
    unanswered: rows.filter((item) => !item.answered).length,
    resolvedWithoutAgentResponse: rows.filter((item) => item.resolvedWithoutAgentResponse).length,
  };

  const agentUserIds = [...new Set([
    ...agentActivity.map((item) => item.sentByUserId),
    ...agentFinalized.map((item) => item.assignedUserId),
  ])].filter(Boolean);
  const agentUsers = agentUserIds.length
    ? await client.user.findMany({ where: { id: { in: agentUserIds } }, select: { id: true, name: true, email: true, role: true, active: true } })
    : [];
  const agentUserMap = new Map(agentUsers.map((user) => [user.id, user]));
  const messagesByAgent = new Map(agentActivity.map((item) => [item.sentByUserId, item._count._all]));
  const finalizedByAgent = new Map(agentFinalized.map((item) => [item.assignedUserId, item._count._all]));

  const perAgent = agentUserIds.map((id) => ({
    userId: id,
    name: agentUserMap.get(id)?.name || "Usuário removido",
    email: agentUserMap.get(id)?.email || null,
    role: agentUserMap.get(id)?.role || null,
    active: agentUserMap.get(id)?.active ?? null,
    messagesSent: messagesByAgent.get(id) || 0,
    conversationsFinalized: finalizedByAgent.get(id) || 0,
  })).sort((a, b) => b.messagesSent - a.messagesSent);

  return {
    weekStart: start, weekEnd: end, weekLabel: label, weekOffset: Number(weekOffset) || 0,
    truncated: cohort.length >= CONVERSATION_LIST_LIMIT,
    totals, perAgent, conversations: rows,
  };
}

module.exports = { buildConversationReport, weekBounds, CONVERSATION_LIST_LIMIT };
