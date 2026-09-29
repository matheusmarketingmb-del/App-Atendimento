const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const channelMessageService = require("./channels/channel-message-service");
const { ALL_MANAGED_CHANNELS, CHANNEL_LABELS } = require("./channels/channel-constants");
const { updateConversationAfterSending } = require("./message-service");
const { removeImage, storeDocument } = require("./media-storage-service");
const {
  listApprovedTemplates,
  sendApprovedTemplate,
  templatesConfigured,
} = require("./meta-template-service");

function normalizeOutboundPhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (digits.length < 8 || digits.length > 15) {
    throw Object.assign(new Error("Informe um telefone válido com DDD e código do país."), { statusCode: 400 });
  }
  return digits;
}

function cleanCustomName(value) {
  const name = String(value || "").trim();
  if (!name) throw Object.assign(new Error("Informe o nome do contato."), { statusCode: 400 });
  if (name.length > 160) throw Object.assign(new Error("O nome deve ter no máximo 160 caracteres."), { statusCode: 400 });
  return name;
}

async function validateTemplateSelection(channel, selection) {
  const name = String(selection?.name || "").trim();
  const language = String(selection?.language || "").trim();
  const values = selection?.values && typeof selection.values === "object" ? selection.values : {};
  if (!name || !language) {
    throw Object.assign(new Error("Selecione um template aprovado para iniciar a conversa."), { statusCode: 400 });
  }
  const template = (await listApprovedTemplates(channel))
    .find((item) => item.name === name && item.language === language);
  if (!template) throw Object.assign(new Error("Template aprovado não encontrado na Meta."), { statusCode: 404 });
  if (!template.supported) throw Object.assign(new Error(template.unsupportedReason), { statusCode: 400 });
  for (const variable of template.variables || []) {
    if (!String(values[variable.key] || "").trim()) {
      throw Object.assign(new Error(`Preencha a variável ${variable.label}.`), { statusCode: 400 });
    }
  }
  return { name, language, values };
}

async function findExistingConversation(phone, channelScope = "LEGACY") {
  return prisma.conversation.findFirst({
    where: { channel: "META", channelScope, contact: { is: { channel: "META", externalId: phone } } },
    select: { id: true, contactId: true },
  });
}

async function createOutboundConversation({ phone, customName, template, accountId = "legacy", user, channel }) {
  authorization.assertCanStartConversations(user);
  authorization.assertCanManageCampaigns(user);
  const selectedAccountId = accountId && accountId !== "legacy" ? String(accountId) : null;
  let providerChannel = channel;
  if (selectedAccountId) {
    if (!(await authorization.canAccessChannelAccount(user, selectedAccountId))) throw authorization.forbidden("Você não tem acesso a este número.");
    providerChannel = (await channelMessageService.adapterFor("META", selectedAccountId)).channel;
  }
  if (!selectedAccountId && !templatesConfigured()) {
    throw Object.assign(new Error("A criação de conversas ficará disponível após configurar os templates da Meta."), {
      statusCode: 503,
      code: "META_TEMPLATES_NOT_CONFIGURED",
    });
  }
  const normalizedPhone = normalizeOutboundPhone(phone);
  const normalizedName = cleanCustomName(customName);
  const selectedTemplate = await validateTemplateSelection(providerChannel, template);

  const channelScope = selectedAccountId || "LEGACY";
  let conversation = await findExistingConversation(normalizedPhone, channelScope);
  let created = false;
  if (conversation) {
    await authorization.assertCanViewConversation(user, conversation.id);
    await prisma.contact.update({
      where: { id: conversation.contactId },
      data: { phone: normalizedPhone, customName: normalizedName },
    });
  } else {
    const result = await prisma.$transaction(async (transaction) => {
      const contact = await transaction.contact.upsert({
        where: { channel_externalId: { channel: "META", externalId: normalizedPhone } },
        update: { phone: normalizedPhone, customName: normalizedName },
        create: {
          channel: "META", externalId: normalizedPhone, phone: normalizedPhone,
          name: normalizedName, customName: normalizedName,
        },
      });
      const current = await transaction.conversation.findUnique({
        where: { contactId_channel_channelScope: { contactId: contact.id, channel: "META", channelScope } },
        select: { id: true, contactId: true },
      });
      if (current) return { conversation: current, created: false };
      const inserted = await transaction.conversation.create({ data: {
        contactId: contact.id, channel: "META", channelScope, channelAccountId: selectedAccountId, status: "EM_ATENDIMENTO", assignedUserId: user.id,
      }, select: { id: true, contactId: true } });
      await transaction.conversationActivity.create({ data: {
        conversationId: inserted.id, actorUserId: user.id, action: "CONVERSATION_CREATED",
        details: { source: "panel", phone: normalizedPhone, assignedUserId: user.id },
      } });
      return { conversation: inserted, created: true };
    });
    conversation = result.conversation;
    created = result.created;
    if (!created) await authorization.assertCanViewConversation(user, conversation.id);
  }

  const result = await sendApprovedTemplate({
    conversationId: conversation.id,
    ...selectedTemplate,
    sentByUserId: user.id,
    channel,
  });
  return { conversationId: conversation.id, created, message: result.message };
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw Object.assign(new Error("Informe um endereço de e-mail válido."), { statusCode: 400 });
  }
  return email;
}

function cleanRequiredText(value, field, maxLength) {
  const text = String(value || "").trim();
  if (!text) throw Object.assign(new Error(`${field} é obrigatório.`), { statusCode: 400 });
  if (text.length > maxLength) throw Object.assign(new Error(`${field} deve ter no máximo ${maxLength} caracteres.`), { statusCode: 400 });
  return text;
}

function emailAccountScope(user) {
  return authorization.isMaster(user) ? {} : { accessUsers: { some: { userId: user.id } } };
}

async function availableEmailAccounts(user) {
  return prisma.channelAccount.findMany({
    where: { channel: "EMAIL", enabled: true, status: "CONNECTED", ...emailAccountScope(user) },
    orderBy: { name: "asc" },
    select: { id: true, name: true, externalAccountId: true, providerMetadata: true },
  });
}

async function availableMetaAccounts(user) {
  const stored = await prisma.channelAccount.findMany({
    where: { channel: "META", enabled: true, status: "CONNECTED", ...emailAccountScope(user) },
    orderBy: { name: "asc" },
    select: { id: true, name: true, externalAccountId: true, providerMetadata: true, config: true },
  });
  const rows = stored.map((account) => ({
    id: account.id, name: account.name,
    address: account.providerMetadata?.username || account.config?.displayPhoneNumber || account.externalAccountId || null,
  }));
  if (templatesConfigured()) rows.push({ id: "legacy", name: "WhatsApp principal", address: process.env.PHONE_NUMBER_ID || null });
  return rows;
}

async function listOutboundChannels(user) {
  if (!authorization.canStartConversations(user)) return [];
  const [accounts, metaAccounts] = await Promise.all([availableEmailAccounts(user), availableMetaAccounts(user)]);
  return ALL_MANAGED_CHANNELS.map((channelName) => {
    if (channelName === "EMAIL") return {
      channel: channelName, label: CHANNEL_LABELS[channelName], enabled: accounts.length > 0,
      reason: accounts.length ? null : "Nenhuma conta de e-mail conectada e liberada para você.",
      accounts: accounts.map((account) => ({
        id: account.id, name: account.name,
        address: account.providerMetadata?.username || account.externalAccountId || null,
      })),
    };
    if (channelName === "META") {
      const permitted = authorization.canManageCampaigns(user);
      const enabled = permitted && metaAccounts.length > 0;
      return {
        channel: channelName, label: CHANNEL_LABELS[channelName], enabled,
        accounts: enabled ? metaAccounts : [],
        reason: !permitted ? "Você não tem permissão para usar templates do WhatsApp." : (enabled ? null : "Nenhum número WhatsApp conectado e liberado para você."),
      };
    }
    return {
      channel: channelName, label: CHANNEL_LABELS[channelName], enabled: false, accounts: [],
      reason: "Integração ainda não liberada para iniciar conversas.",
    };
  });
}

async function createOutboundEmail({ accountId, to, customName, subject, text, attachments = [], user }) {
  authorization.assertCanStartConversations(user);
  const email = normalizeEmail(to);
  const name = cleanCustomName(customName || email);
  const cleanSubject = cleanRequiredText(subject, "Assunto", 240);
  const cleanBody = cleanRequiredText(text, "Mensagem", 20000);
  if (!Array.isArray(attachments) || attachments.length > 10) {
    throw Object.assign(new Error("Envie no máximo 10 documentos por e-mail."), { statusCode: 400 });
  }
  const attachmentBytes = attachments.reduce((total, attachment) => total + (attachment.buffer?.length || 0), 0);
  if (attachmentBytes > 20 * 1024 * 1024) {
    throw Object.assign(new Error("Os documentos do e-mail devem somar no máximo 20 MB."), { statusCode: 413 });
  }
  const account = await prisma.channelAccount.findFirst({
    where: { id: String(accountId || ""), channel: "EMAIL", enabled: true, status: "CONNECTED", ...emailAccountScope(user) },
    select: { id: true },
  });
  if (!account) throw authorization.forbidden("Esta conta de e-mail não está conectada ou não foi liberada para você.");

  const externalContactId = `${account.id}:${email}`;
  const existing = await prisma.conversation.findFirst({
    where: { channel: "EMAIL", channelAccountId: account.id, contact: { is: { externalId: externalContactId } } },
    select: { id: true },
  });
  if (existing) await authorization.assertCanViewConversation(user, existing.id);

  const storedAttachments = [];
  try {
    for (const attachment of attachments) {
      storedAttachments.push(await storeDocument({
        buffer: attachment.buffer, mimeType: attachment.mimeType, fileName: attachment.fileName,
      }));
    }
  } catch (error) {
    await Promise.allSettled(storedAttachments.map((attachment) => removeImage(attachment.storageKey)));
    throw error;
  }
  let providerResult;
  try {
    providerResult = await channelMessageService.send({
      channel: "EMAIL", channelAccountId: account.id, kind: storedAttachments.length ? "media" : "text",
      to: email, subject: cleanSubject, text: cleanBody,
      ...(storedAttachments.length ? { attachments: storedAttachments.map((stored, index) => ({
        buffer: attachments[index].buffer, mimeType: stored.mimeType, filename: stored.fileName,
      })) } : {}),
    });
  } catch (error) {
    await Promise.allSettled(storedAttachments.map((attachment) => removeImage(attachment.storageKey)));
    throw error;
  }
  const occurredAt = new Date();
  let stored;
  try {
    stored = await prisma.$transaction(async (transaction) => {
    const contact = await transaction.contact.upsert({
      where: { channel_externalId: { channel: "EMAIL", externalId: externalContactId } },
      update: { email, customName: name },
      create: { channel: "EMAIL", externalId: externalContactId, email, name, customName: name },
    });
    const conversation = await transaction.conversation.upsert({
      where: { contactId_channel_channelScope: { contactId: contact.id, channel: "EMAIL", channelScope: account.id } },
      update: { channelAccountId: account.id, externalConversationId: providerResult.data?.threadId || undefined },
      create: {
        contactId: contact.id, channel: "EMAIL", channelScope: account.id, channelAccountId: account.id,
        externalConversationId: providerResult.data?.threadId || null, kind: "EMAIL_THREAD",
        status: "EM_ATENDIMENTO", assignedUserId: user.id,
      },
    });
      const message = await transaction.message.create({ data: {
      conversationId: conversation.id,
      externalId: providerResult.externalId ? `${account.id}:${providerResult.externalId}` : null,
      channel: "EMAIL", channelAccountId: account.id, direction: "ENVIADA", status: "ENVIADA",
      type: "text", text: cleanBody, occurredAt, sentByUserId: user.id,
      rawPayload: { providerMessage: providerResult.data || null, subject: cleanSubject, threadId: providerResult.data?.threadId || null },
      } });
      const attachmentMessages = [];
      for (const attachment of storedAttachments) {
        attachmentMessages.push(await transaction.message.create({ data: {
          conversationId: conversation.id, channel: "EMAIL", channelAccountId: account.id,
          direction: "ENVIADA", status: "ENVIADA", type: "document", text: null, occurredAt,
          sentByUserId: user.id, mediaStorageKey: attachment.storageKey, mediaMimeType: attachment.mimeType,
          mediaFileName: attachment.fileName, mediaSize: attachment.size,
          rawPayload: { providerMessage: providerResult.data || null, subject: cleanSubject, threadId: providerResult.data?.threadId || null, attachment: true },
        } }));
      }
      return { conversation, message, attachmentMessages };
    });
  } catch (error) {
    await Promise.allSettled(storedAttachments.map((attachment) => removeImage(attachment.storageKey)));
    throw error;
  }
  await updateConversationAfterSending({ conversationId: stored.conversation.id, sentByUserId: user.id, occurredAt });
  return { conversationId: stored.conversation.id, created: !existing, message: stored.message, attachments: stored.attachmentMessages };
}
module.exports = { createOutboundConversation, createOutboundEmail, listOutboundChannels, normalizeOutboundPhone };
