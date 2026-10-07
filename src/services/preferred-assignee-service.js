// Atendente fixo por cliente (Contact.preferredAssignee*).
//
// Diferente de Conversation.assignedUserId:
//   assignedUserId     = quem está atendendo a conversa AGORA (muda com
//                        assumir/transferir/finalizar, regra de sempre);
//   preferredAssignee  = para quem o cliente vai SEMPRE que iniciar um novo
//                        atendimento (preferred-assignee-routing-service).
// Transferir ou finalizar nunca mexe aqui; só Supervisor (na empresa do
// cliente) ou Master altera/remove, com histórico no AuditLog
// (PREFERRED_ASSIGNEE_SET/CHANGED/REMOVED). Ser atendente fixo NÃO dá acesso
// a segmentos privados (Financeiro) — ver private-segment-service.
const prisma = require("../database/prisma");
const audit = require("./audit-service");
const authorization = require("./authorization-service");
const companyService = require("./company-service");

const USER_SELECT = Object.freeze({ id: true, name: true, active: true, role: true });

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function contactLabel(contact) {
  return contact.customName || contact.name || contact.email || contact.phone || "Contato";
}

async function loadContact(contactId) {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: {
      id: true, companyId: true, customName: true, name: true, email: true, phone: true,
      preferredAssigneeId: true, preferredAssigneeEnabled: true, preferredAssigneeSetAt: true,
      preferredAssignee: { select: USER_SELECT }, preferredAssigneeSetBy: { select: { id: true, name: true } },
    },
  });
  if (!contact) throw fail("Contato não encontrado.", 404);
  return contact;
}

// Supervisor NA EMPRESA do cliente ou Master (cargo por empresa — Ana pode
// ser Supervisor na Mibro e Atendente na Sincrofit).
async function canManage(viewer, companyId) {
  if (authorization.isMaster(viewer)) return true;
  return (await companyService.roleInCompany(viewer, companyId)) === "SUPERVISOR";
}

function summary(contact, canEdit) {
  return {
    contactId: contact.id,
    companyId: contact.companyId,
    enabled: Boolean(contact.preferredAssigneeEnabled && contact.preferredAssigneeId),
    autoRouteEnabled: contact.preferredAssigneeEnabled,
    assignee: contact.preferredAssignee ? { id: contact.preferredAssignee.id, name: contact.preferredAssignee.name, active: contact.preferredAssignee.active } : null,
    setBy: contact.preferredAssigneeSetBy || null,
    setAt: contact.preferredAssigneeSetAt || null,
    canEdit,
  };
}

async function getPreferredAssignee(contactId, viewer) {
  await authorization.assertCanAccessContact(viewer, contactId);
  const contact = await loadContact(contactId);
  return summary(contact, await canManage(viewer, contact.companyId));
}

// Quem pode ser atendente fixo: usuário ativo, humano (não BOT), com acesso
// ATIVO à empresa do cliente (Master Global sempre). Cliente Mibro nunca vai
// para quem não acessa a Mibro.
async function eligibleAssignee(userId, companyId) {
  const user = await prisma.user.findFirst({ where: { id: userId, active: true, role: { not: "BOT" } } });
  if (!user) return null;
  return (await companyService.userForCompany(user, companyId)) ? user : null;
}

async function listCandidates(contactId, viewer) {
  await authorization.assertCanAccessContact(viewer, contactId);
  const contact = await loadContact(contactId);
  if (!(await canManage(viewer, contact.companyId))) throw authorization.forbidden("Somente Supervisor ou Master pode definir o atendente fixo.");
  const users = await prisma.user.findMany({
    where: {
      active: true, role: { not: "BOT" },
      OR: [{ role: "ADMIN" }, { companyAccess: { some: { companyId: contact.companyId, active: true } } }],
    },
    select: { id: true, name: true, role: true },
    orderBy: { name: "asc" },
  });
  return users;
}

async function setPreferredAssignee(contactId, { userId, enabled = true, reason } = {}, viewer) {
  await authorization.assertCanAccessContact(viewer, contactId);
  const contact = await loadContact(contactId);
  if (!(await canManage(viewer, contact.companyId))) throw authorization.forbidden("Somente Supervisor ou Master pode definir o atendente fixo.");
  if (typeof enabled !== "boolean") throw fail("Informe se os novos atendimentos devem ser direcionados automaticamente.");
  const note = reason === undefined || reason === null ? null : String(reason).trim().slice(0, 500) || null;
  const targetId = userId || contact.preferredAssigneeId;
  if (!targetId) throw fail("Selecione o atendente fixo.");
  const target = await eligibleAssignee(targetId, contact.companyId);
  if (!target) throw fail("O atendente precisa estar ativo e ter acesso à empresa deste cliente.");
  if (target.id === contact.preferredAssigneeId && enabled === contact.preferredAssigneeEnabled) {
    return summary(contact, true);
  }
  const action = !contact.preferredAssigneeId ? "PREFERRED_ASSIGNEE_SET" : "PREFERRED_ASSIGNEE_CHANGED";
  await prisma.$transaction(async (transaction) => {
    await transaction.contact.update({
      where: { id: contactId },
      data: {
        preferredAssigneeId: target.id, preferredAssigneeEnabled: enabled,
        preferredAssigneeSetById: viewer.id, preferredAssigneeSetAt: new Date(),
      },
    });
    await audit.recordAudit({
      actor: viewer, action, entityType: "CONTACT", entityId: contactId, companyId: contact.companyId,
      summary: action === "PREFERRED_ASSIGNEE_SET"
        ? `Definiu ${target.name} como atendente fixo de ${contactLabel(contact)}`
        : `Alterou o atendente fixo de ${contactLabel(contact)}: ${contact.preferredAssignee?.name || "—"} → ${target.name}`,
      details: {
        contactId, previousAssigneeId: contact.preferredAssigneeId || null, previousAssignee: contact.preferredAssignee?.name || null,
        newAssigneeId: target.id, newAssignee: target.name,
        previousEnabled: contact.preferredAssigneeEnabled, enabled, reason: note,
      },
    }, transaction);
  });
  return summary(await loadContact(contactId), true);
}

// Remove o vínculo: o cliente volta ao fluxo comum de Bot/triagem. A
// conversa atual (assignedUserId) não é alterada.
async function removePreferredAssignee(contactId, { reason } = {}, viewer) {
  await authorization.assertCanAccessContact(viewer, contactId);
  const contact = await loadContact(contactId);
  if (!(await canManage(viewer, contact.companyId))) throw authorization.forbidden("Somente Supervisor ou Master pode remover o atendente fixo.");
  if (!contact.preferredAssigneeId) return summary(contact, true);
  const note = reason === undefined || reason === null ? null : String(reason).trim().slice(0, 500) || null;
  await prisma.$transaction(async (transaction) => {
    await transaction.contact.update({
      where: { id: contactId },
      data: { preferredAssigneeId: null, preferredAssigneeEnabled: false, preferredAssigneeSetById: viewer.id, preferredAssigneeSetAt: new Date() },
    });
    await audit.recordAudit({
      actor: viewer, action: "PREFERRED_ASSIGNEE_REMOVED", entityType: "CONTACT", entityId: contactId, companyId: contact.companyId,
      summary: `Removeu ${contact.preferredAssignee?.name || "o atendente fixo"} como atendente fixo de ${contactLabel(contact)}`,
      details: {
        contactId, previousAssigneeId: contact.preferredAssigneeId, previousAssignee: contact.preferredAssignee?.name || null,
        newAssigneeId: null, reason: note,
      },
    }, transaction);
  });
  return summary(await loadContact(contactId), true);
}

async function listHistory(contactId, viewer) {
  await authorization.assertCanAccessContact(viewer, contactId);
  const contact = await loadContact(contactId);
  if (!(await canManage(viewer, contact.companyId))) throw authorization.forbidden("Somente Supervisor ou Master pode ver o histórico do atendente fixo.");
  return prisma.auditLog.findMany({
    where: { entityType: "CONTACT", entityId: contactId, action: { startsWith: "PREFERRED_ASSIGNEE_" } },
    select: { id: true, action: true, summary: true, details: true, actorName: true, createdAt: true },
    orderBy: { createdAt: "desc" }, take: 50,
  });
}

module.exports = {
  eligibleAssignee, getPreferredAssignee, listCandidates, listHistory, removePreferredAssignee, setPreferredAssignee,
};
