// Roteamento automático para o atendente fixo — decisão ANTERIOR ao Flow
// Builder (webhook do WhatsApp chama isto antes de handleIncomingVisualFlow),
// então nenhum Bot precisa montar essa verificação.
//
//   mensagem nova → conversa NOVO, sem responsável, sem setor, sem fluxo em
//   andamento (início de atendimento novo ou reabertura) → cliente com
//   atendente fixo ativo e válido para a empresa? → atribui a ele
//   (assignedUserId), status AGUARDANDO_EQUIPE (entra no SLA de resposta),
//   envia a mensagem curta configurável, notifica o atendente e NÃO roda
//   menu/triagem.
//
// Atendente offline/ausente: a conversa continua com ele (não há
// redistribuição automática). Atendente fixo inválido (inativo, sem acesso à
// empresa): cliente segue o fluxo comum — nunca escolhe outro sozinho.
const prisma = require("../database/prisma");
const audit = require("./audit-service");
const companyService = require("./company-service");
const { getConversationSettings } = require("./conversation-settings-service");
const { STATUS } = require("./bot-visual-flow-engine");

const ACTIVE_FLOW_STATUSES = [STATUS.WAITING_CUSTOMER, STATUS.WAITING_TIMER, STATUS.RUNNING];

async function resolveTarget(conversation) {
  const contact = conversation.contact;
  if (!contact?.preferredAssigneeEnabled || !contact.preferredAssigneeId) return null;
  if (contact.companyId !== conversation.companyId) return null;
  const user = await prisma.user.findFirst({ where: { id: contact.preferredAssigneeId, active: true, role: { not: "BOT" } } });
  if (!user || !(await companyService.userForCompany(user, conversation.companyId))) return null;
  return user;
}

// Devolve true quando o atendimento foi direcionado ao atendente fixo (o
// webhook então não chama o Flow Builder).
async function routeIncomingMessage(event, message, channel, { notify } = {}) {
  if (!message || event?.type === "reaction") return false;
  const conversation = await prisma.conversation.findUnique({
    where: { id: message.conversationId },
    include: { contact: true, channelAccount: true },
  });
  // Só WhatsApp nesta fase (onde o Bot/Flow Builder roda).
  if (!conversation || conversation.channel !== "META") return false;
  // NOVO + sem responsável + sem setor = início de atendimento (o Bot,
  // quando assume, muda o status para BOT — então aqui nunca há fluxo vivo).
  if (conversation.status !== "NOVO" || conversation.assignedUserId || conversation.categoryId) return false;
  const target = await resolveTarget(conversation);
  if (!target) return false;

  // Claim otimista: dois webhooks simultâneos nunca atribuem duas vezes nem
  // "roubam" uma conversa que alguém acabou de assumir.
  const claimed = await prisma.conversation.updateMany({
    where: { id: conversation.id, status: "NOVO", assignedUserId: null, categoryId: null },
    data: { assignedUserId: target.id, status: "AGUARDANDO_EQUIPE", finalizedAt: null },
  });
  if (!claimed.count) return false;
  // Execução de fluxo que sobrou de um atendimento anterior (ex.: menu sem
  // resposta e conversa finalizada) não pode retomar a triagem agora —
  // encerrada sem apagar nada, mesmo padrão de cancelExecution do Flow.
  await prisma.botFlowExecution.updateMany({
    where: { conversationId: conversation.id, status: { in: ACTIVE_FLOW_STATUSES } },
    data: { status: STATUS.HANDED_OFF, error: "PREFERRED_ASSIGNEE_ROUTED", finishedAt: new Date(), resumeAt: null },
  });
  await prisma.conversationActivity.create({ data: {
    conversationId: conversation.id, action: "ROUTED_TO_PREFERRED_ASSIGNEE",
    details: { toUserId: target.id, to: target.name, preferredAssignee: true, triggerMessageId: message.id },
  } });
  const contactLabel = conversation.contact.customName || conversation.contact.name || conversation.contact.phone;
  await audit.recordAudit({
    actor: null, action: "CONVERSATION_ASSIGNEE_CHANGED", entityType: "CONVERSATION", entityId: conversation.id,
    companyId: conversation.companyId,
    summary: `Atendimento de ${contactLabel} direcionado ao atendente fixo ${target.name}`,
    details: { conversationId: conversation.id, from: "Sem responsável", to: target.name, toUserId: target.id, preferredAssignee: true },
  });

  // Mensagem curta do Bot. Falha no envio nunca desfaz a atribuição.
  try {
    const settings = await getConversationSettings(prisma, conversation.companyId);
    const text = String(settings.preferredAssigneeRoutingMessage || "").trim();
    if (text) {
      const accounts = require("./whatsapp-account-service");
      const sender = accounts.senderFor(channel, await accounts.accountForConversation(conversation));
      const result = await sender.sendText(conversation.contact.phone, text);
      const occurredAt = new Date();
      await prisma.message.create({ data: {
        conversationId: conversation.id, channel: conversation.channel, channelAccountId: conversation.channelAccountId || null,
        externalId: result?.externalId || null, direction: "ENVIADA", status: "ENVIADA", type: "text", text, occurredAt,
        rawPayload: { message: result?.data || null, system: "preferred_assignee_routing", flowHandoff: true },
      } });
      await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: occurredAt } });
    }
  } catch (error) {
    console.error("[PREFERRED_ASSIGNEE] falha ao enviar mensagem de redirecionamento (conversa já atribuída):", error.message);
  }

  const push = notify || require("./push-service").notifyUser;
  Promise.resolve(push(target.id, {
    title: `${contactLabel}`,
    body: "Novo atendimento do seu cliente fixo",
    tag: `conversation-${conversation.id}`,
    url: `/?conversation=${encodeURIComponent(conversation.id)}`,
  })).catch(() => {});
  return true;
}

module.exports = { routeIncomingMessage };
