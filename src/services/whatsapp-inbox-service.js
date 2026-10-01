const prisma = require("../database/prisma");
const authorization = require("./authorization-service");

// Um ponteiro estável por contato; histórico antigo permanece nas linhas originais.
async function findInbox(contactId, db = prisma) {
  const contact = await db.contact.findUnique({ where: { id: contactId }, select: { whatsappInboxId: true } });
  if (!contact?.whatsappInboxId) return null;
  return db.conversation.findFirst({ where: { id: contact.whatsappInboxId, contactId, channel: "META" } });
}

async function attachInbox(contactId, conversationId, db = prisma) {
  await db.contact.updateMany({ where: { id: contactId, whatsappInboxId: null }, data: { whatsappInboxId: conversationId } });
  return findInbox(contactId, db);
}

function routingCandidates(category, accounts) {
  if (!category) return [];
  const exact = accounts.filter((account) => (account.config?.outboundCategoryIds || []).includes(category.id));
  if (exact.length) return exact;
  return category.parentId ? accounts.filter((account) => (account.config?.outboundCategoryIds || []).includes(category.parentId)) : [];
}

const canonicalScope = { OR: [{ channel: { not: "META" } }, { contact: { is: { whatsappInboxId: null } } }, { unifiedWhatsAppContact: { isNot: null } }] };
async function messageAccountScope(viewer) {
  if (authorization.isMaster(viewer)) return {};
  const access = await prisma.channelAccountUserAccess.findMany({ where: { userId: viewer.id }, select: { channelAccountId: true } });
  return { OR: [{ channel: { not: "META" } }, { channelAccountId: null }, { channelAccountId: { in: access.map(a => a.channelAccountId) } }] };
}

async function senderState(conversation, viewer, db = prisma) {
  const accounts = await db.channelAccount.findMany({ where: { channel: "META" }, include: { accessUsers: { select: { userId: true } } } });
  const category = conversation.categoryId ? await db.category.findUnique({ where: { id: conversation.categoryId }, select: { id: true, parentId: true } }) : null;
  const configured = routingCandidates(category, accounts);
  const available = accounts.filter((account) => account.enabled && account.status === "CONNECTED" && (!viewer || authorization.isMaster(viewer) || account.accessUsers.some(({ userId }) => userId === viewer.id)));
  const allowed = configured.length ? available.filter((a) => configured.some((b) => a.id === b.id)) : available;
  let selected = null;
  const choice = conversation.whatsappSendAccountId;
  if (choice) selected = allowed.find((a) => a.id === choice || (choice === "legacy" && a.config?.isLegacyWhatsApp)) || null;
  else if (configured.length === 1) selected = available.find((a) => a.id === configured[0].id) || null;
  else if (!category) {
    const messageScope = { conversation: { contactId: conversation.contactId, channel: "META" }, type: { not: "reaction" } };
    const latest = await db.message.findFirst({ where: { ...messageScope, direction: "RECEBIDA" }, orderBy: { occurredAt: "desc" }, select: { channelAccountId: true } })
      || await db.message.findFirst({ where: { ...messageScope, direction: "ENVIADA" }, orderBy: { occurredAt: "desc" }, select: { channelAccountId: true } });
    selected = latest ? available.find((a) => latest.channelAccountId ? a.id === latest.channelAccountId : a.config?.isLegacyWhatsApp) || null : null;
  }
  const options = allowed.map((a) => ({ id: a.config?.isLegacyWhatsApp ? "legacy" : a.id, name: a.name, address: a.providerMetadata?.username || a.config?.displayPhoneNumber || null }));
  return { selectedId: selected ? (selected.config?.isLegacyWhatsApp ? "legacy" : selected.id) : null, account: selected, options,
    reason: selected ? null : configured.length > 1 ? "Mais de um número configurado. Escolha o remetente." : configured.length === 1 ? "O número configurado está indisponível ou você não tem acesso a ele." : "Escolha o remetente ou configure um número de envio para este setor." };
}

async function applySender(conversation, userId, db = prisma) {
  if (conversation.channel !== "META") return conversation;
  const contact = await db.contact.findUnique({ where: { id: conversation.contactId }, select: { whatsappInboxId: true } });
  if (!contact?.whatsappInboxId) return conversation;
  const viewer = userId ? await db.user.findUnique({ where: { id: userId } }) : null;
  if (userId && (!viewer || !viewer.active)) throw Object.assign(new Error("Usuário de envio inválido."), { statusCode: 403 });
  const state = await senderState(conversation, viewer, db);
  if (!state.account) throw Object.assign(new Error(state.reason), { statusCode: 409, code: "WHATSAPP_SENDER_REQUIRED" });
  const selectedAccountId = state.account.config?.isLegacyWhatsApp ? null : state.account.id;
  conversation.channelAccountId = selectedAccountId;
  return conversation;
}

async function botChannel(conversation, incomingChannel) {
  const contact = await prisma.contact.findUnique({ where: { id: conversation.contactId }, select: { whatsappInboxId: true } });
  if (!contact?.whatsappInboxId) return incomingChannel;
  const current = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  await applySender(current, null);
  await require("./meta-template-service").assertFreeFormAllowed(current.id, new Date(), current.channelAccountId);
  conversation.channelAccountId = current.channelAccountId;
  return current.channelAccountId ? (await require("./channels/channel-message-service").adapterFor("META", current.channelAccountId)).channel : (incomingChannel?.phoneNumberId && incomingChannel.phoneNumberId !== process.env.PHONE_NUMBER_ID ? new (require("../channels/meta-cloud-channel"))() : incomingChannel);
}

module.exports = { findInbox, attachInbox, routingCandidates, senderState, applySender, botChannel, canonicalScope, messageAccountScope };
