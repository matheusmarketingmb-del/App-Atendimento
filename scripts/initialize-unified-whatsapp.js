// Additive activation only. NEVER deletes, moves or rewrites messages.
require("dotenv").config();
const prisma = require("../src/database/prisma");
const { encryptSecrets } = require("../src/services/channels/integration-secret-service");

async function initialize(db = prisma, { apply = false, env = process.env } = {}) {
  const accounts = await db.channelAccount.findMany({ where: { channel: "META" } });
  const contacts = await db.contact.findMany({ where: { channel: "META", whatsappInboxId: null }, select: { id: true } });
  const plan = [];
  for (const contact of contacts) {
    const conversations = await db.conversation.findMany({ where: { contactId: contact.id, channel: "META" }, orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }] });
    const root = conversations.find(c => c.assignedUserId && c.status !== "FINALIZADO") || conversations.find(c => c.status !== "FINALIZADO") || conversations[0];
    if (root) plan.push({ contactId: contact.id, conversationId: root.id, previousCards: conversations.length });
  }
  const principalExists = accounts.some(a => a.config?.isLegacyWhatsApp);
  if (!env.PHONE_NUMBER_ID || !env.WHATSAPP_TOKEN || !env.WHATSAPP_BUSINESS_ACCOUNT_ID) throw new Error("Número principal incompleto; ativação cancelada.");
  if (apply) await db.$transaction(async tx => {
    const categories = await tx.category.findMany({ where: { active: true }, select: { id: true, parentId: true } });
    // Start with the existing account-sector restrictions; master can change
    // sending sectors independently afterwards. Overlaps require selection.
    const claimed = new Set();
    for (const account of accounts.filter(a => !a.config?.isLegacyWhatsApp)) {
      const ids = account.config?.outboundCategoryIds ?? account.config?.allowedCategoryIds ?? [];
      ids.forEach(id => claimed.add(id));
      if (account.config?.outboundCategoryIds === undefined) await tx.channelAccount.update({ where: { id: account.id }, data: { config: { ...account.config, outboundCategoryIds: ids } } });
    }
    if (!principalExists) {
      const account = await tx.channelAccount.create({ data: {
        channel: "META", name: "WhatsApp principal", enabled: true, status: "CONNECTED", externalAccountId: env.PHONE_NUMBER_ID,
        config: { isLegacyWhatsApp: true, phoneNumberId: env.PHONE_NUMBER_ID, wabaId: env.WHATSAPP_BUSINESS_ACCOUNT_ID, graphVersion: env.GRAPH_VERSION,
          allowedCategoryIds: [], outboundCategoryIds: categories.filter(c => !claimed.has(c.id) && !claimed.has(c.parentId)).map(c => c.id) },
        ...encryptSecrets({ accessToken: env.WHATSAPP_TOKEN }),
      } });
      const users = await tx.user.findMany({ where: { active: true }, select: { id: true } });
      if (users.length) await tx.channelAccountUserAccess.createMany({ data: users.map(u => ({ channelAccountId: account.id, userId: u.id })) });
    }
    for (const item of plan) await tx.contact.updateMany({ where: { id: item.contactId, whatsappInboxId: null }, data: { whatsappInboxId: item.conversationId } });
  }, { timeout: 60000 });
  return { apply, principalAlreadyRegistered: principalExists, contacts: plan.length, redundantCardsHidden: plan.reduce((n, p) => n + p.previousCards - 1, 0) };
}
if (require.main === module) initialize(prisma, { apply: process.argv.includes("--apply") }).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
module.exports = { initialize };
