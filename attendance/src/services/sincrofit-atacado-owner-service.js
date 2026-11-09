const COMPANY_ID = "cmp_sincrofit";
const CATEGORY_ID = "cmvgmlzsu000dsf0kd48go831";
const REPLY_SELLERS = new Set([
  "cmt8kq4tq176dpd0klvyhzvpn", // Raphael Tauber
  "cmub5ymuh01i1qn0kzjhsmpst", // Gabriela Meira
]);

async function setOwnerOnClaim(tx, { before, after, actor }) {
  if (before.assignedUserId || actor.role === "BOT") return;
  await setOwner(tx, { before, after, actor, source: "SINCROFIT_ATACADO_CLAIM" });
}

async function setOwnerOnReply(tx, { before, after, actorId }) {
  if (!REPLY_SELLERS.has(actorId) || (before.assignedUserId && before.assignedUserId !== actorId)
    || before.archivedAt || before.status === "FINALIZADO"
    || !matchesConversation(before, after, actorId)) return;
  const contact = await tx.contact.findUnique({ where: { id: after.contactId }, select: {
    updatedAt: true, preferredAssigneeId: true, preferredAssigneeEnabled: true, preferredAssigneeSetAt: true,
  } });
  await setOwner(tx, { before, after: { ...after, contact }, actor: { id: actorId }, source: "SINCROFIT_ATACADO_REPLY" });
}

function matchesConversation(before, after, actorId) {
  return after?.companyId === COMPANY_ID && after.channel === "META" && after.categoryId === CATEGORY_ID
    && before.categoryId === CATEGORY_ID && after.assignedUserId === actorId
    && !after.archivedAt && after.status !== "FINALIZADO";
}

async function setOwner(tx, { before, after, actor, source }) {
  const contact = after.contact;
  if (!matchesConversation(before, after, actor.id) || !contact || contact.preferredAssigneeId
    || contact.preferredAssigneeEnabled || contact.preferredAssigneeSetAt) return;
  const eligible = await tx.user.findFirst({ where: { id: actor.id, active: true, role: { not: "BOT" }, OR: [
    { role: "ADMIN" }, { companyAccess: { some: { companyId: COMPANY_ID, active: true } } },
  ] }, select: { id: true, name: true } });
  if (!eligible) return;

  const patch = {
    preferredAssigneeId: actor.id, preferredAssigneeEnabled: true,
    preferredAssigneeSetById: actor.id, preferredAssigneeSetAt: new Date(),
  };
  const result = await tx.contact.updateMany({
    where: { id: after.contactId, companyId: COMPANY_ID, preferredAssigneeId: null, preferredAssigneeEnabled: false,
      preferredAssigneeSetAt: null, updatedAt: contact.updatedAt },
    data: patch,
  });
  if (!result.count) return;
  const name = actor.name || eligible.name || "Atendente";
  const verb = source === "SINCROFIT_ATACADO_REPLY" ? "respondeu ao" : "assumiu o";
  await tx.auditLog.create({ data: {
    actorUserId: actor.id, actorName: name, companyId: COMPANY_ID, entityType: "CONTACT", entityId: after.contactId,
    action: "PREFERRED_ASSIGNEE_SET", summary: `${name} ${verb} atendimento em Comercial → Atacado e foi definido como vendedor fixo`,
    details: { source, conversationId: after.id, newAssigneeId: actor.id, newAssignee: name, enabled: true },
  } });
  Object.assign(contact, patch);
}

module.exports = { setOwnerOnClaim, setOwnerOnReply };
