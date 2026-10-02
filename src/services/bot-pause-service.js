// "Cancelar Bot" / "Retomar Bot" na Central de Atendimento: ação humana
// explícita que pausa a automação numa conversa (ConversationBotState.
// humanPausedAt). O Flow Builder checa esse campo antes de qualquer envio
// (bot-visual-flow-service.js#botIsAllowedToRespond) e cancela a execução em
// espera na próxima mensagem. Retomar nunca reenvia nada retroativamente.
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");

async function pauseBot(conversationId, actor) {
  await authorization.assertCanViewConversation(actor, conversationId);
  return prisma.conversationBotState.upsert({
    where: { conversationId },
    update: { humanPausedAt: new Date() },
    create: { conversationId, humanPausedAt: new Date() },
  });
}

async function resumeBot(conversationId, actor) {
  await authorization.assertCanViewConversation(actor, conversationId);
  return prisma.conversationBotState.upsert({
    where: { conversationId },
    update: { humanPausedAt: null },
    create: { conversationId, humanPausedAt: null },
  });
}

module.exports = { pauseBot, resumeBot };
