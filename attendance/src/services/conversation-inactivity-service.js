const prisma = require("../database/prisma");
const { settingsPlan } = require("./conversation-settings-service");

const defaultInactivityMinutes = 1440;

async function finalizeInactiveConversations({
  now = new Date(), inactivityMinutes = defaultInactivityMinutes, client = prisma, scope = {},
} = {}) {
  const cutoff = new Date(now.getTime() - inactivityMinutes * 60 * 1000);
  const humanMessage = { direction: "ENVIADA", sentByUserId: { not: null }, sentByUser: { is: { role: { not: "BOT" } } }, status: { in: ["ENVIADA", "ENTREGUE", "LIDA"] } };
  const meaningfulMessage = { type: { not: "reaction" }, OR: [{ direction: "RECEBIDA" }, humanMessage] };
  const candidates = await client.conversation.findMany({
    where: { ...scope, archivedAt:null, status: { notIn: ["FINALIZADO", "NOVO", "BOT", "HANDOFF_BOT", "AGUARDANDO_EQUIPE"] }, lastMessageAt: { lte: cutoff }, assignedUserId: { not: null }, assignedUser: { is: { active: true, role: { not: "BOT" } } } },
    select: {
      id: true, assignedUserId: true, status: true, lastMessageAt: true,
      messages: {
        where: meaningfulMessage,
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }, { id: "desc" }], take: 1,
        select: { direction: true, rawPayload: true, occurredAt: true, createdAt: true },
      },
    },
  });
  let finalized = 0;
  for (const conversation of candidates) {
    // Só expira o silêncio do cliente após uma resposta humana.
    // Bot e triagem não transformam uma espera por atendimento em conclusão.
    const lastMessage = conversation.messages[0];
    if (!lastMessage || lastMessage.direction !== "ENVIADA") continue;
    if (lastMessage.rawPayload?.system || lastMessage.rawPayload?.flowHandoff) continue;
    await client.$transaction(async (transaction) => {
      const updated = await transaction.conversation.updateMany({
        where: {
          id: conversation.id, archivedAt: null, assignedUserId: conversation.assignedUserId,
          status: conversation.status, lastMessageAt: conversation.lastMessageAt,
          assignedUser: { is: { active: true, role: { not: "BOT" } } },
          messages: { none: { type: { not: "reaction" }, direction: "RECEBIDA", OR: [
            { occurredAt: { gt: lastMessage.occurredAt } },
            { occurredAt: lastMessage.occurredAt, createdAt: { gte: lastMessage.createdAt } },
          ] } },
        },
        // Mantém categoria, responsável e histórico; as regras de acesso
        // continuam sendo aplicadas pelo serviço de autorização.
        data: {
          status: "FINALIZADO", unreadCount: 0, finalizedAt: now,
        },
      });
      if (!updated.count) return;
      await transaction.conversationActivity.create({ data: {
        conversationId: conversation.id, action: "AUTO_FINALIZED_INACTIVITY",
        details: { inactivityMinutes },
      } });
      finalized += 1;
      await transaction.afterHoursReminder.updateMany({
        where: { conversationId: conversation.id, status: "PENDING" }, data: { status: "CANCELLED", reason: "CONVERSATION_FINALIZED" },
      });
    });
  }
  return finalized;
}

function startInactivityMonitor({
  intervalMs = 60 * 1000, inactivityMinutes, onChange,
} = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      // Configurações → Conversas (item 11): o default de produção vem do
      // singleton central, não mais de uma constante fixa. `inactivityMinutes`
      // continua aceito como override explícito (usado pelos testes).
      // Multiempresa: cada empresa com configuração própria usa a dela.
      const plan = inactivityMinutes !== undefined
        ? [{ settings: { autoFinalizationEnabled: true, autoFinalizationMinutes: inactivityMinutes }, scope: {} }]
        : await settingsPlan();
      let finalized = 0;
      for (const { settings, scope } of plan) {
        if (!settings.autoFinalizationEnabled) continue;
        finalized += await finalizeInactiveConversations({ inactivityMinutes: settings.autoFinalizationMinutes, scope });
      }
      if (finalized) onChange?.(finalized);
    } catch (error) {
      console.error("Erro ao finalizar conversas inativas:", error);
    } finally {
      running = false;
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { defaultInactivityMinutes, finalizeInactiveConversations, startInactivityMonitor };
