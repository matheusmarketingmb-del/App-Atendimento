// Núcleo de Campanhas (envio em massa via WhatsApp) — reaproveita
// INTEGRALMENTE a integração Meta já existente: listApprovedTemplates/
// sendApprovedTemplate (meta-template-service.js) e a normalização de
// telefone de outbound-conversation-service.js. Nenhum cliente HTTP novo
// para a Meta, nenhuma credencial nova.
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const audit = require("./audit-service");
const { listApprovedTemplates } = require("./meta-template-service");
const { normalizeCampaignPhone } = require("./campaign-phone-service");
const { getCampaignSettings } = require("./campaign-settings-service");
const { isOptedOut } = require("./campaign-optout-service");
const companyService = require("./company-service");
const whatsappAccounts = require("./whatsapp-account-service");

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function optionalInteger(value, label, { min, max }) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw fail(`${label} deve ser um inteiro entre ${min} e ${max}.`);
  }
  return parsed;
}

function optionalPhone(value) {
  if (value === undefined || value === null || value === "") return null;
  const phone = normalizeCampaignPhone(value);
  if (!phone) throw fail("Informe um número de teste válido com DDD.");
  return phone;
}

// Multiempresa: gerenciar campanhas é avaliado com o cargo do usuário NA
// EMPRESA da campanha. Empresa sem acesso = 404 (não revela a campanha).
async function assertCampaignCompanyPermission(actor, companyId) {
  const scoped = await companyService.userForCompany(actor, companyId);
  if (!scoped) throw fail("Campanha não encontrada.", 404);
  authorization.assertCanManageCampaigns(scoped);
  return scoped;
}

// Empresas onde o usuário pode gerenciar campanhas (lista "Todas").
async function manageableCompanyIds(viewer) {
  const ids = [];
  for (const { companyId } of await companyService.companyAccess(viewer)) {
    const scoped = await companyService.userForCompany(viewer, companyId);
    if (scoped && authorization.canManageCampaigns(scoped)) ids.push(companyId);
  }
  return ids;
}

async function findCampaignOr404(id, client = prisma, actor = null) {
  const campaign = await client.campaign.findUnique({ where: { id }, include: { channelAccount: true } });
  if (!campaign) throw fail("Campanha não encontrada.", 404);
  if (actor) await assertCampaignCompanyPermission(actor, campaign.companyId);
  return campaign;
}

// Número de envio da campanha: sempre um WhatsApp da MESMA empresa. Sem
// número explícito, só resolve sozinho se a empresa tiver um único número.
async function campaignAccountFor(companyId, channelAccountId) {
  const accounts = await whatsappAccounts.listWhatsappAccounts({ companyIds: [companyId] });
  if (channelAccountId) {
    const account = accounts.find((item) => item.id === channelAccountId);
    if (!account) throw fail("Número de WhatsApp inválido para a empresa da campanha.");
    return account;
  }
  if (accounts.length === 1) return accounts[0];
  if (!accounts.length) throw fail("A empresa não tem número de WhatsApp ativo para campanhas.");
  throw fail("Selecione o número de WhatsApp de envio da campanha.");
}

// Categoria de resposta, Bot e responsável precisam ser da mesma empresa.
async function assertCampaignReferences(companyId, { replyCategoryId, replyBotId, responsibleUserId }) {
  if (replyCategoryId) {
    const category = await prisma.category.findFirst({ where: { id: replyCategoryId, companyId }, select: { id: true } });
    if (!category) throw fail("A categoria de resposta não pertence à empresa da campanha.");
  }
  if (replyBotId) {
    const bot = await prisma.bot.findFirst({ where: { id: replyBotId, companyId }, select: { id: true } });
    if (!bot) throw fail("O Bot de resposta não pertence à empresa da campanha.");
  }
  if (responsibleUserId) {
    const user = await prisma.user.findFirst({ where: { id: responsibleUserId, active: true } });
    if (!user || !(await companyService.userForCompany(user, companyId))) {
      throw fail("O responsável não tem acesso à empresa da campanha.");
    }
  }
}

// Item 3: nunca inventa template — sempre confere status APROVADO na Meta
// no momento em que a campanha é criada/editada, além de a cada envio real
// (o worker também reconfere, ver campaign-worker-service.js). Multiempresa:
// sempre na WABA do número da campanha (`account`).
async function assertTemplateApproved(channel, { name, language }, account = null) {
  const templates = await listApprovedTemplates(channel, account);
  const template = templates.find((item) => item.name === name && item.language === language);
  if (!template) throw fail("Template não encontrado ou não aprovado na Meta.");
  if (template.status !== "APPROVED") throw fail(`O template está com status "${template.status}" na Meta — só templates aprovados podem ser usados em campanhas.`);
  if (!template.supported) throw fail(template.unsupportedReason);
  return template;
}

async function createCampaign(data, actor, channel) {
  // Empresa primeiro (item 35): tudo o mais é validado contra ela.
  const companyId = await companyService.resolveCompanyForCreate(actor, data?.companyId);
  await assertCampaignCompanyPermission(actor, companyId);
  const name = String(data?.name || "").trim();
  if (!name) throw fail("Informe um nome para a campanha.");
  const templateName = String(data?.templateName || "").trim();
  const templateLanguage = String(data?.templateLanguage || "").trim();
  if (!templateName || !templateLanguage) throw fail("Selecione um template aprovado.");
  const account = await campaignAccountFor(companyId, data.channelAccountId || null);
  const template = await assertTemplateApproved(channel, { name: templateName, language: templateLanguage }, account);
  await assertCampaignReferences(companyId, data);

  const campaign = await prisma.campaign.create({
    data: {
      companyId,
      name, description: data.description ? String(data.description).trim().slice(0, 2000) : null,
      channel: "META", channelAccountId: account.id,
      templateName, templateLanguage, templateCategory: template.category,
      variableMapping: data.variableMapping || undefined,
      category: data.category ? String(data.category).trim().slice(0, 120) : null,
      replyCategoryId: data.replyCategoryId || null, replyBotId: data.replyBotId || null,
      responsibleUserId: data.responsibleUserId || null,
      segmentFilters: data.segmentFilters || undefined,
      batchSize: optionalInteger(data.batchSize, "Tamanho do lote", { min: 1, max: 500 }),
      delayBetweenBatchesSeconds: optionalInteger(data.delayBetweenBatchesSeconds, "Intervalo entre lotes", { min: 1, max: 3600 }),
      maxRetries: optionalInteger(data.maxRetries, "Máximo de tentativas", { min: 0, max: 10 }),
      testPhone: optionalPhone(data.testPhone),
      createdByUserId: actor.id, updatedByUserId: actor.id,
    },
  });
  await audit.recordAudit({
    actor, action: "CAMPAIGN_CREATED", entityType: "CAMPAIGN", entityId: campaign.id, companyId,
    summary: `Criou a campanha "${campaign.name}"`,
  });
  return campaign;
}

async function updateCampaign(id, data, actor, channel) {
  const campaign = await findCampaignOr404(id, prisma, actor);
  if (data.companyId !== undefined && data.companyId !== campaign.companyId) {
    throw fail("A empresa de uma campanha não pode ser alterada.");
  }
  await assertCampaignReferences(campaign.companyId, data);
  if (!["DRAFT", "SCHEDULED"].includes(campaign.status)) {
    throw fail("Só é possível editar campanhas em rascunho ou agendadas.");
  }
  const update = { updatedByUserId: actor.id };
  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) throw fail("Informe um nome para a campanha.");
    update.name = name;
  }
  if (data.description !== undefined) update.description = data.description ? String(data.description).trim().slice(0, 2000) : null;
  let account = campaign.channelAccount;
  if (data.channelAccountId !== undefined && data.channelAccountId !== campaign.channelAccountId) {
    account = await campaignAccountFor(campaign.companyId, data.channelAccountId || null);
    update.channelAccountId = account.id;
  }
  if (data.templateName !== undefined || data.templateLanguage !== undefined || update.channelAccountId) {
    const templateName = String(data.templateName ?? campaign.templateName).trim();
    const templateLanguage = String(data.templateLanguage ?? campaign.templateLanguage).trim();
    const template = await assertTemplateApproved(channel, { name: templateName, language: templateLanguage }, account);
    update.templateName = templateName; update.templateLanguage = templateLanguage; update.templateCategory = template.category;
  }
  if (data.variableMapping !== undefined) update.variableMapping = data.variableMapping || undefined;
  if (data.category !== undefined) update.category = data.category ? String(data.category).trim().slice(0, 120) : null;
  if (data.replyCategoryId !== undefined) update.replyCategoryId = data.replyCategoryId || null;
  if (data.replyBotId !== undefined) update.replyBotId = data.replyBotId || null;
  if (data.responsibleUserId !== undefined) update.responsibleUserId = data.responsibleUserId || null;
  if (data.segmentFilters !== undefined) update.segmentFilters = data.segmentFilters || undefined;
  if (data.batchSize !== undefined) update.batchSize = optionalInteger(data.batchSize, "Tamanho do lote", { min: 1, max: 500 });
  if (data.delayBetweenBatchesSeconds !== undefined) update.delayBetweenBatchesSeconds = optionalInteger(data.delayBetweenBatchesSeconds, "Intervalo entre lotes", { min: 1, max: 3600 });
  if (data.maxRetries !== undefined) update.maxRetries = optionalInteger(data.maxRetries, "Máximo de tentativas", { min: 0, max: 10 });
  if (data.testPhone !== undefined) update.testPhone = optionalPhone(data.testPhone);

  const updated = await prisma.campaign.update({ where: { id }, data: update });
  await audit.recordAudit({
    actor, action: "CAMPAIGN_UPDATED", entityType: "CAMPAIGN", entityId: id, companyId: campaign.companyId,
    summary: `Editou a campanha "${updated.name}"`, details: { fields: Object.keys(update) },
  });
  return updated;
}

async function getCampaign(id, viewer) {
  await findCampaignOr404(id, prisma, viewer);
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: {
      company: { select: { id: true, name: true, slug: true, displayName: true, primaryColor: true } },
      channelAccount: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      responsible: { select: { id: true, name: true } },
      replyCategory: { select: { id: true, name: true } },
      replyBot: { select: { id: true, name: true } },
      _count: { select: { contacts: true } },
    },
  });
  if (!campaign) throw fail("Campanha não encontrada.", 404);
  return campaign;
}

// Item 2: abas de status.
async function listCampaigns(filters, viewer) {
  let companyIds = await manageableCompanyIds(viewer);
  if (!companyIds.length) throw authorization.forbidden("Você não tem permissão para gerenciar campanhas.");
  if (filters?.company && filters.company !== companyService.ALL_COMPANIES) {
    const requested = await companyService.resolveCompanyFilter(viewer, filters.company);
    companyIds = companyIds.filter((id) => requested.includes(id));
  }
  const where = { companyId: { in: companyIds } };
  if (filters?.status) where.status = filters.status;
  if (filters?.search) where.name = { contains: String(filters.search), mode: "insensitive" };
  return prisma.campaign.findMany({
    where, orderBy: { createdAt: "desc" }, take: 200,
    include: {
      _count: { select: { contacts: true } }, createdBy: { select: { id: true, name: true } },
      company: { select: { id: true, name: true, slug: true, displayName: true, primaryColor: true } },
      channelAccount: { select: { id: true, name: true } },
    },
  });
}

// Item 10: segmentação combinável — filtros próprios do CampaignContact
// (tags/cidade/UF/empresa/origem) mais cruzamentos simples com
// Contact/Conversation (clientes existentes, sem atendimento recente,
// respondeu/não respondeu campanha anterior). Nunca inclui opt-out.
function buildSegmentWhere(filters = {}) {
  const AND = [{ optOut: false }, { consentStatus: { not: "OPTED_OUT" } }];
  if (filters.tags?.length) AND.push({ tags: { hasSome: filters.tags } });
  if (filters.city) AND.push({ city: { equals: filters.city, mode: "insensitive" } });
  if (filters.state) AND.push({ state: { equals: filters.state, mode: "insensitive" } });
  if (filters.companyName) AND.push({ companyName: { contains: filters.companyName, mode: "insensitive" } });
  if (filters.source) AND.push({ source: filters.source });
  if (filters.contactIds?.length) AND.push({ contactId: { in: filters.contactIds } });
  return AND;
}

async function estimateAudience(campaignId, filters, viewer) {
  await findCampaignOr404(campaignId, prisma, viewer);
  const where = { campaignId, AND: buildSegmentWhere(filters) };
  return { count: await prisma.campaignContact.count({ where }) };
}

// Item 29: envio de teste — nunca contabilizado como campanha real
// (isTest=true). Só para o número autorizado configurado na campanha.
async function sendTestMessage(campaignId, actor, channel) {
  const campaign = await findCampaignOr404(campaignId, prisma, actor);
  if (!campaign.testPhone) throw fail("Configure um número de teste autorizado antes de enviar.");
  const { sendApprovedTemplate } = require("./meta-template-service");
  const { findOrCreateCampaignConversation } = require("./campaign-worker-service");
  const account = await campaignAccountFor(campaign.companyId, campaign.channelAccountId);

  const conversation = await findOrCreateCampaignConversation({ phone: campaign.testPhone, name: "Teste de campanha", account });
  const values = {};
  const template = await assertTemplateApproved(channel, { name: campaign.templateName, language: campaign.templateLanguage }, account);
  for (const variable of template.variables) {
    values[variable.key] = "Teste";
  }
  const result = await sendApprovedTemplate({
    conversationId: conversation.id, name: campaign.templateName, language: campaign.templateLanguage,
    values, sentByUserId: actor.id, channel,
  });
  await audit.recordAudit({
    actor, action: "CAMPAIGN_TEST_SENT", entityType: "CAMPAIGN", entityId: campaign.id,
    summary: `Enviou mensagem de teste da campanha "${campaign.name}" para ${campaign.testPhone}`,
  });
  return { message: result.message };
}

// Itens 19/20: transições de status — sempre com auditoria de quem fez o quê.
async function scheduleCampaign(campaignId, { scheduledAt, timezone }, actor) {
  const campaign = await findCampaignOr404(campaignId, prisma, actor);
  const settings = await getCampaignSettings();
  if (!settings.allowScheduling) throw fail("Agendamento de campanhas está desativado nas configurações globais.");
  if (campaign.status !== "DRAFT") throw fail("Só é possível agendar uma campanha em rascunho.");
  await assertHasEligibleContacts(campaignId);
  if (!scheduledAt) throw fail("Informe uma data futura para o agendamento.");
  const date = new Date(scheduledAt);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) throw fail("Informe uma data futura válida para o agendamento.");
  const updated = await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: "SCHEDULED", scheduledAt: date, timezone: timezone || campaign.timezone, updatedByUserId: actor.id },
  });
  await audit.recordAudit({ actor, action: "CAMPAIGN_SCHEDULED", entityType: "CAMPAIGN", entityId: campaignId, companyId: campaign.companyId, summary: `Agendou a campanha "${campaign.name}"`, details: { scheduledAt: date } });
  return updated;
}

async function assertHasEligibleContacts(campaignId) {
  const count = await prisma.campaignContact.count({ where: { campaignId, optOut: false, status: "PENDING" } });
  if (!count) throw fail("A campanha não tem destinatários elegíveis (importe contatos primeiro).");
}

// "Enviar agora": marca QUEUED — o worker (item 17) é quem efetivamente
// promove para RUNNING e começa a mandar, respeitando o master switch.
async function queueCampaignNow(campaignId, actor) {
  const campaign = await findCampaignOr404(campaignId, prisma, actor);
  if (!["DRAFT", "SCHEDULED", "PAUSED"].includes(campaign.status)) throw fail("Esta campanha não pode ser iniciada no status atual.");
  await assertHasEligibleContacts(campaignId);
  const updated = await prisma.campaign.update({
    where: { id: campaignId }, data: { status: "QUEUED", scheduledAt: null, updatedByUserId: actor.id },
  });
  await audit.recordAudit({ actor, action: "CAMPAIGN_QUEUED", entityType: "CAMPAIGN", entityId: campaignId, companyId: campaign.companyId, summary: `Iniciou o envio da campanha "${campaign.name}"` });
  return updated;
}

async function pauseCampaign(campaignId, actor) {
  const campaign = await findCampaignOr404(campaignId, prisma, actor);
  if (!["QUEUED", "RUNNING"].includes(campaign.status)) throw fail("Só é possível pausar uma campanha em envio.");
  const updated = await prisma.campaign.update({ where: { id: campaignId }, data: { status: "PAUSED", pausedAt: new Date(), updatedByUserId: actor.id } });
  await audit.recordAudit({ actor, action: "CAMPAIGN_PAUSED", entityType: "CAMPAIGN", entityId: campaignId, companyId: campaign.companyId, summary: `Pausou a campanha "${campaign.name}"` });
  return updated;
}

async function resumeCampaign(campaignId, actor) {
  const campaign = await findCampaignOr404(campaignId, prisma, actor);
  if (campaign.status !== "PAUSED") throw fail("Só é possível retomar uma campanha pausada.");
  const updated = await prisma.campaign.update({ where: { id: campaignId }, data: { status: "QUEUED", pausedAt: null, updatedByUserId: actor.id } });
  await audit.recordAudit({ actor, action: "CAMPAIGN_RESUMED", entityType: "CAMPAIGN", entityId: campaignId, companyId: campaign.companyId, summary: `Retomou a campanha "${campaign.name}"` });
  return updated;
}

// Item 19: cancelar nunca envia o restante nem apaga o que já foi enviado —
// só marca os destinatários ainda pendentes como SKIPPED.
async function cancelCampaign(campaignId, actor) {
  const campaign = await findCampaignOr404(campaignId, prisma, actor);
  if (["COMPLETED", "CANCELLED"].includes(campaign.status)) throw fail("Esta campanha já foi concluída ou cancelada.");
  await prisma.$transaction([
    prisma.campaign.update({ where: { id: campaignId }, data: { status: "CANCELLED", cancelledAt: new Date(), updatedByUserId: actor.id } }),
    prisma.campaignContact.updateMany({
      where: { campaignId, status: { in: ["PENDING", "QUEUED", "SENDING"] } }, data: { status: "SKIPPED" },
    }),
  ]);
  await audit.recordAudit({ actor, action: "CAMPAIGN_CANCELLED", entityType: "CAMPAIGN", entityId: campaignId, companyId: campaign.companyId, summary: `Cancelou a campanha "${campaign.name}"` });
  return findCampaignOr404(campaignId);
}

// Item 4: preview do template com um contato de exemplo — nunca "undefined".
// Busca a lista de templates aprovados uma única vez (evita uma segunda
// chamada redundante à Meta cujo resultado podia, numa corrida rara —
// template pausado/editado entre as duas chamadas —, não conter mais o
// template já validado acima, derrubando o preview com um erro cru).
async function previewTemplate(channel, { templateName, templateLanguage, variableMapping, sampleContact, channelAccountId, companyId }, viewer = null) {
  const account = viewer ? await whatsappAccounts.resolveAccountForUser(viewer, { channelAccountId, company: companyId }) : null;
  const template = await assertTemplateApproved(channel, { name: templateName, language: templateLanguage }, account);
  const sample = sampleContact || { firstName: "Cliente", fullName: "Cliente Exemplo", companyName: "Empresa Exemplo" };
  const values = {};
  for (const variable of template.variables) {
    const field = (variableMapping || {})[variable.key];
    const isStatic = field?.startsWith?.("static:");
    values[variable.key] = isStatic ? field.slice(7) : (field ? (sample[field] || variable.example || "") : (variable.example || ""));
  }
  return { ...template, renderedPreview: renderPreviewText(template, values) };
}

function renderPreviewText(template, values) {
  let text = template.previewTemplate;
  for (const variable of template.variables) {
    const value = String(values[variable.key] || variable.example || `{{${variable.placeholder}}}`);
    text = text.replaceAll(`{{${variable.placeholder}}}`, value);
  }
  return text;
}

module.exports = {
  assertCampaignCompanyPermission,
  assertTemplateApproved,
  campaignAccountFor,
  findCampaignOr404,
  manageableCompanyIds,
  buildSegmentWhere,
  cancelCampaign,
  createCampaign,
  estimateAudience,
  getCampaign,
  isOptedOut,
  listCampaigns,
  pauseCampaign,
  previewTemplate,
  queueCampaignNow,
  resumeCampaign,
  scheduleCampaign,
  sendTestMessage,
  updateCampaign,
};
