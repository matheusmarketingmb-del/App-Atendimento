const prisma = require("../database/prisma");

function normalizePhone(value = "") {
  return String(value).replace(/\D/g, "");
}

function validContactName(name, phone) {
  const cleanName = String(name || "").trim();

  if (!cleanName) return null;

  const nameAsPhone = normalizePhone(cleanName);
  const normalizedPhone = normalizePhone(phone);

  if (
    nameAsPhone &&
    normalizedPhone &&
    nameAsPhone === normalizedPhone
  ) {
    return null;
  }

  return cleanName;
}

// Celular brasileiro chega da Meta às vezes sem o 9º dígito (wa_id
// 551187791678) mesmo quando a conversa foi iniciada com ele (5511987791678).
// Os dois formatos são o mesmo cliente: devolve as duas grafias possíveis.
function whatsappIdVariants(value) {
  const digits = normalizePhone(value);
  if (!digits) return [];
  const variants = [digits];
  const withNine = digits.match(/^55(\d{2})9([6-9]\d{7})$/);
  if (withNine) variants.push(`55${withNine[1]}${withNine[2]}`);
  const withoutNine = digits.match(/^55(\d{2})([6-9]\d{7})$/);
  if (withoutNine) variants.push(`55${withoutNine[1]}9${withoutNine[2]}`);
  return variants;
}

// Contato já salvo com a OUTRA grafia do número. Só entra em jogo quando não
// existe contato com o ID exato — nunca troca um contato existente por outro.
async function findMetaContactByOtherVariant(externalId, db = prisma) {
  const others = whatsappIdVariants(externalId).filter((value) => value !== externalId);
  if (!others.length) return null;
  const exact = await db.contact.findUnique({
    where: { channel_externalId: { channel: "META", externalId } }, select: { id: true },
  });
  if (exact) return null;
  return db.contact.findFirst({
    where: { channel: "META", externalId: { in: others } }, orderBy: { createdAt: "asc" },
  });
}

async function findOrCreateMetaConversation(event, db = prisma) {
  const channelAccountId = event.channelAccountId || null;
  const channelScope = channelAccountId || "LEGACY";
  const contactName = validContactName(
    event.contactName,
    event.phone
  );

  const variantContact = await findMetaContactByOtherVariant(event.contactExternalId, db);
  const contact = variantContact
    ? await db.contact.update({
      where: { id: variantContact.id },
      data: contactName ? { name: contactName } : {},
    })
    : await db.contact.upsert({
    where: {
      channel_externalId: {
        channel: "META",
        externalId: event.contactExternalId
      }
    },

    update: {
      phone: event.phone,
      ...(contactName ? { name: contactName } : {})
    },

    create: {
      channel: "META",
      externalId: event.contactExternalId,
      phone: event.phone,
      name: contactName || event.phone
    }
  });

  const conversation = await db.conversation.upsert({
    where: {
      contactId_channel_channelScope: {
        contactId: contact.id,
        channel: "META",
        channelScope
      }
    },

    update: {},

    create: {
      contactId: contact.id,
      channel: "META",
      channelScope,
      channelAccountId,
      status: "NOVO"
    }
  });

  return { contact, conversation };
}

module.exports = {
  findMetaContactByOtherVariant,
  findOrCreateMetaConversation,
  whatsappIdVariants
};
