const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const { whatsappIdVariants } = require("./conversation-service");
const channelMessageService = require("./channels/channel-message-service");
const { ALL_MANAGED_CHANNELS, CHANNEL_LABELS } = require("./channels/channel-constants");
const { updateConversationAfterSending } = require("./message-service");
const whatsappAccounts = require("./whatsapp-account-service");
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

async function validateTemplateSelection(channel, selection, account = null) {
  const name = String(selection?.name || "").trim();
  const language = String(selection?.language || "").trim();
  const values = selection?.values && typeof selection.values === "object" ? selection.values : {};
  if (!name || !language) {
    throw Object.assign(new Error("Selecione um template aprovado para iniciar a conversa."), { statusCode: 400 });
  }
  const template = (await listApprovedTemplates(channel, account))
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

// Multiempresa: procura só na empresa/número escolhidos — o mesmo telefone
// na outra empresa é outro cliente, com outra conversa.
async function findExistingConversation(phone, account) {
  // Primeiro o número exato; se não houver, a outra grafia (com/sem o 9º
  // dígito) — evita abrir uma segunda conversa para o mesmo cliente.
  const channelScope = whatsappAccounts.conversationScopeFor(account);
  for (const externalId of whatsappIdVariants(phone)) {
    const conversation = await prisma.conversation.findFirst({
      where: {
        companyId: account.companyId, channel: "META", channelScope,
        contact: { is: { companyId: account.companyId, channel: "META", externalId } },
      },
      select: { id: true, contactId: true },
    });
    if (conversation) return conversation;
  }
  return null;
}

// `channelAccountId` = número (e portanto empresa) escolhido na tela "Nova
// conversa". Validado contra o acesso do usuário; nunca cai num número
// padrão quando o usuário tem mais de um.
async function createOutboundConversation({ phone, customName, template, user, channel, channelAccountId, company }) {
  const account = await whatsappAccounts.resolveAccountForUser(user, { channelAccountId, company });
  authorization.assertCanStartConversations(await authorization.forCompany(user, account.companyId));
  if (!templatesConfigured(account)) {
    throw Object.assign(new Error("A criação de conversas ficará disponível após configurar os templates da Meta."), {
      statusCode: 503,
      code: "META_TEMPLATES_NOT_CONFIGURED",
    });
  }
  const normalizedPhone = normalizeOutboundPhone(phone);
  const normalizedName = cleanCustomName(customName);
  const selectedTemplate = await validateTemplateSelection(channel, template, account);

  let conversation = await findExistingConversation(normalizedPhone, account);
  let created = false;
  if (conversation) {
    await authorization.assertCanViewConversation(user, conversation.id);
    await prisma.contact.update({
      where: { id: conversation.contactId },
      data: { phone: normalizedPhone, customName: normalizedName },
    });
  } else {
    const result = await prisma.$transaction(async (transaction) => {
      const companyId = account.companyId;
      const channelScope = whatsappAccounts.conversationScopeFor(account);
      const contact = await transaction.contact.upsert({
        where: { companyId_channel_externalId: { companyId, channel: "META", externalId: normalizedPhone } },
        update: { phone: normalizedPhone, customName: normalizedName },
        create: {
          companyId, channel: "META", externalId: normalizedPhone, phone: normalizedPhone,
          name: normalizedName, customName: normalizedName,
        },
      });
      const current = await transaction.conversation.findUnique({
        where: { contactId_channel_channelScope: { contactId: contact.id, channel: "META", channelScope } },
        select: { id: true, contactId: true },
      });
      if (current) return { conversation: current, created: false };
      const inserted = await transaction.conversation.create({ data: {
        companyId, contactId: contact.id, channel: "META", channelScope, channelAccountId: account.id,
        status: "EM_ATENDIMENTO", assignedUserId: user.id,
      }, select: { id: true, contactId: true } });
      await transaction.conversationActivity.create({ data: {
        conversationId: inserted.id, actorUserId: user.id, action: "CONVERSATION_CREATED",
        details: { source: "panel", phone: normalizedPhone, assignedUserId: user.id, companyId, channelAccountId: account.id },
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

async function listOutboundChannels(user) {
  // Multiempresa: lista se puder iniciar conversa em ALGUMA empresa; o envio
  // revalida a empresa da conta escolhida.
  const companyService = require("./company-service");
  let allowed = false;
  for (const { companyId } of await companyService.companyAccess(user)) {
    if (authorization.canStartConversations(await companyService.userForCompany(user, companyId))) { allowed = true; break; }
  }
  if (!allowed) return [];
  const accounts = await availableEmailAccounts(user);
  return ALL_MANAGED_CHANNELS.map((channelName) => {
    if (channelName === "EMAIL") return {
      channel: channelName, label: CHANNEL_LABELS[channelName], enabled: accounts.length > 0,
      reason: accounts.length ? null : "Nenhuma conta de e-mail conectada e liberada para você.",
      accounts: accounts.map((account) => ({
        id: account.id, name: account.name,
        address: account.providerMetadata?.username || account.externalAccountId || null,
      })),
    };
    return {
      channel: channelName, label: CHANNEL_LABELS[channelName], enabled: false, accounts: [],
      reason: channelName === "META"
        ? "Início de conversa pela Meta desativado temporariamente."
        : "Integração ainda não liberada para iniciar conversas.",
    };
  });
}

async function createOutboundEmail({ accountId, to, customName, subject, text, user }) {
  const email = normalizeEmail(to);
  const name = cleanCustomName(customName || email);
  const cleanSubject = cleanRequiredText(subject, "Assunto", 240);
  const cleanBody = cleanRequiredText(text, "Mensagem", 20000);
  const account = await prisma.channelAccount.findFirst({
    where: {
      id: String(accountId || ""), channel: "EMAIL", enabled: true, status: "CONNECTED", ...emailAccountScope(user),
      ...(await authorization.companyScope(user)),
    },
    select: { id: true, companyId: true },
  });
  if (!account) throw authorization.forbidden("Esta conta de e-mail não está conectada ou não foi liberada para você.");
  authorization.assertCanStartConversations(await authorization.forCompany(user, account.companyId));

  const externalContactId = `${account.id}:${email}`;
  const existing = await prisma.conversation.findFirst({
    where: { channel: "EMAIL", channelAccountId: account.id, contact: { is: { externalId: externalContactId } } },
    select: { id: true },
  });
  if (existing) await authorization.assertCanViewConversation(user, existing.id);

  const providerResult = await channelMessageService.send({
    channel: "EMAIL", channelAccountId: account.id, kind: "text",
    to: email, subject: cleanSubject, text: cleanBody,
  });
  const occurredAt = new Date();
  const stored = await prisma.$transaction(async (transaction) => {
    const contact = await transaction.contact.upsert({
      where: { companyId_channel_externalId: { companyId: account.companyId, channel: "EMAIL", externalId: externalContactId } },
      update: { email, customName: name },
      create: { companyId: account.companyId, channel: "EMAIL", externalId: externalContactId, email, name, customName: name },
    });
    const conversation = await transaction.conversation.upsert({
      where: { contactId_channel_channelScope: { contactId: contact.id, channel: "EMAIL", channelScope: account.id } },
      update: { channelAccountId: account.id, externalConversationId: providerResult.data?.threadId || undefined },
      create: {
        companyId: account.companyId, contactId: contact.id, channel: "EMAIL", channelScope: account.id, channelAccountId: account.id,
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
    return { conversation, message };
  });
  await updateConversationAfterSending({ conversationId: stored.conversation.id, sentByUserId: user.id, occurredAt });
  return { conversationId: stored.conversation.id, created: !existing, message: stored.message };
}
module.exports = { createOutboundConversation, createOutboundEmail, listOutboundChannels, normalizeOutboundPhone };
