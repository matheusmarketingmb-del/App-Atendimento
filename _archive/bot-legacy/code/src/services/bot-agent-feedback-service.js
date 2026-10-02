// Feedback do ATENDENTE ("o bot ajudou?") após handoff — sinal distinto da
// avaliação do cliente (bot-rating-service.js). Nunca misturar os dois.
const prisma = require("../database/prisma");

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

async function submitAgentFeedback(conversationId, data, actor) {
  if (!actor?.id) throw fail("Usuário não autenticado.", 401);
  if (typeof data.helpful !== "boolean") throw fail("Informe se o Bot ajudou (verdadeiro ou falso).");
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true } });
  if (!conversation) throw fail("Conversa não encontrada.", 404);

  const comment = typeof data.comment === "string" ? data.comment.trim().slice(0, 1000) || null : null;
  try {
    return await prisma.botAgentFeedback.create({
      data: { conversationId, botId: data.botId || null, userId: actor.id, helpful: data.helpful, comment },
    });
  } catch (error) {
    if (error.code === "P2002") throw fail("Você já registrou um feedback para esta conversa.");
    throw error;
  }
}

async function listAgentFeedback(conversationId) {
  return prisma.botAgentFeedback.findMany({
    where: { conversationId }, include: { user: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" },
  });
}

module.exports = { listAgentFeedback, submitAgentFeedback };
