const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const audit = require("./audit-service");

const contactSelect = {
  id: true, channel: true, customName: true, name: true, email: true, phone: true, identityId: true,
  conversations: { select: { id: true, channel: true, channelAccountId: true, lastMessageAt: true }, orderBy: { lastMessageAt: "desc" } },
};

function displayName(contact) {
  return contact.customName || contact.name || contact.email || (contact.phone ? `+${contact.phone}` : "Contato");
}

async function listMergeCandidates(contactId, search, viewer) {
  authorization.assertCanMergeContacts(viewer);
  await authorization.assertCanAccessContact(viewer, contactId, { act: true });
  const scope = await authorization.conversationScope(viewer);
  const current = await prisma.contact.findUnique({ where: { id: contactId }, select: { identityId: true } });
  const term = String(search || "").trim().slice(0, 120);
  const where = { id: { not: contactId }, conversations: { some: scope } };
  if (current?.identityId) where.OR = [{ identityId: null }, { identityId: { not: current.identityId } }];
  if (term) where.AND = [{ OR: ["customName", "name", "email", "phone"].map((field) => ({ [field]: { contains: term, mode: "insensitive" } })) }];
  const contacts = await prisma.contact.findMany({
    where,
    select: { ...contactSelect, conversations: { where: scope, select: { id: true, channel: true, channelAccountId: true, lastMessageAt: true }, orderBy: { lastMessageAt: "desc" } } },
    orderBy: { updatedAt: "desc" }, take: 30,
  });
  return contacts.map((contact) => ({ ...contact, displayName: displayName(contact) }));
}

async function mergeContacts(sourceContactId, targetContactId, viewer) {
  authorization.assertCanMergeContacts(viewer);
  if (!targetContactId || sourceContactId === targetContactId) throw Object.assign(new Error("Selecione outro contato."), { statusCode: 400 });
  await Promise.all([authorization.assertCanAccessContact(viewer, sourceContactId, { act: true }), authorization.assertCanAccessContact(viewer, targetContactId, { act: true })]);
  return prisma.$transaction(async (transaction) => {
    const [source, target] = await Promise.all([
      transaction.contact.findUnique({ where: { id: sourceContactId }, select: contactSelect }),
      transaction.contact.findUnique({ where: { id: targetContactId }, select: contactSelect }),
    ]);
    if (!source || !target) throw Object.assign(new Error("Contato não encontrado."), { statusCode: 404 });
    let identityId = source.identityId || target.identityId;
    if (!identityId) identityId = (await transaction.contactIdentity.create({ data: { displayName: displayName(source) }, select: { id: true } })).id;
    const secondaryIdentityId = source.identityId && target.identityId && source.identityId !== target.identityId
      ? (identityId === source.identityId ? target.identityId : source.identityId) : null;
    if (secondaryIdentityId) {
      await transaction.contact.updateMany({ where: { identityId: secondaryIdentityId }, data: { identityId } });
      await transaction.contactIdentity.delete({ where: { id: secondaryIdentityId } });
    }
    await transaction.contact.updateMany({ where: { id: { in: [sourceContactId, targetContactId] } }, data: { identityId } });
    await audit.recordAudit({ actor: viewer, action: "CONTACTS_MERGED", entityType: "CONTACT", entityId: identityId,
      summary: `Fundiu os contatos ${displayName(source)} e ${displayName(target)}`, details: { contactIds: [sourceContactId, targetContactId] } }, transaction);
    return { identityId };
  });
}

async function getMergedDestinations(contactId, viewer) {
  const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { identityId: true } });
  if (!contact?.identityId) return [];
  const scope = await authorization.conversationScope(viewer);
  const conversations = await prisma.conversation.findMany({
    where: { AND: [{ contact: { is: { identityId: contact.identityId } } }, scope] },
    select: { id: true, channel: true, channelAccountId: true, lastMessageAt: true,
      contact: { select: { id: true, customName: true, name: true, email: true, phone: true } },
      channelAccount: { select: { name: true, externalAccountId: true } } },
    orderBy: { lastMessageAt: "desc" },
  });
  return conversations.map((conversation) => ({ ...conversation, contactName: displayName(conversation.contact) }));
}

module.exports = { getMergedDestinations, listMergeCandidates, mergeContacts };
