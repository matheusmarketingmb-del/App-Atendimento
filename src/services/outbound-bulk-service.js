// Envio pelo painel "Nova conversa" — individual continua em
// outbound-conversation-service.js (envio imediato de 1 template); o envio
// em massa REAPROVEITA Campanhas: cada envio vira um lote (Campaign com
// origin = "PANEL") processado pelo mesmo worker/fila (campaign-worker-
// service.js), com os mesmos status, opt-out, métricas e histórico. Nunca
// dispara nada dentro da requisição HTTP.
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const audit = require("./audit-service");
const channelMessageService = require("./channels/channel-message-service");
const { listApprovedTemplates, templatesConfigured } = require("./meta-template-service");
const { getCampaignSettings } = require("./campaign-settings-service");
const { DEFAULT_MAX_CAMPAIGN_RECIPIENTS } = require("./campaign-constants");
const rules = require("./bulk-send-rules");

const LEGACY_ACCOUNT_ID = "legacy";
const PANEL_ORIGIN = "PANEL";
const QUALITY_CACHE_MS = 5 * 60 * 1000;
const qualityCache = new Map();

function fail(message, statusCode = 400, code) {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
}

function assertCanBulkSend(user) {
  if (!authorization.canManageCampaigns(user)) {
    throw authorization.forbidden("Você não tem permissão para envio em massa. Peça ao Master para liberar “Campanhas e templates”.");
  }
}

function assertCanUsePanel(user) {
  if (!authorization.canStartConversations(user) && !authorization.canManageCampaigns(user)) {
    throw authorization.forbidden("Você não tem permissão para iniciar conversas.");
  }
}

// ------------------------------------------------------ Números remetentes

async function phoneProfile(cacheKey, providerChannel) {
  const cached = qualityCache.get(cacheKey);
  if (cached && Date.now() - cached.at < QUALITY_CACHE_MS) return cached.value;
  let value = null;
  try {
    if (typeof providerChannel?.getPhoneNumberProfile === "function") {
      const profile = await providerChannel.getPhoneNumberProfile();
      value = { displayPhoneNumber: profile?.display_phone_number || null, verifiedName: profile?.verified_name || null, quality: profile?.quality_rating || null };
    }
  } catch (_error) {
    value = null; // perfil é informativo — nunca bloqueia a listagem
  }
  qualityCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

const ACCOUNT_STATUS_REASON = {
  DISABLED: "Número desativado.", NOT_CONFIGURED: "Número não configurado.", CONFIGURED: "Número ainda não conectado.",
  AUTH_PENDING: "Autorização pendente.", DEGRADED: "Número com instabilidade.", ERROR: "Número com erro de conexão.",
  NEEDS_APPROVAL: "Número aguardando aprovação.", RECONNECT_REQUIRED: "Reconecte o número antes de usar.",
};

/**
 * Números WhatsApp que o usuário pode ver no seletor. Os indisponíveis
 * (desconectado, desativado, sem permissão) aparecem desabilitados com o
 * motivo — nunca podem ser usados para envio (validado de novo no backend).
 */
async function listSenderNumbers(user, defaultChannel) {
  assertCanUsePanel(user);
  const accounts = await prisma.channelAccount.findMany({
    where: { channel: "META", ...(authorization.isMaster(user) ? {} : { accessUsers: { some: { userId: user.id } } }) },
    orderBy: { name: "asc" },
    select: { id: true, name: true, status: true, enabled: true, externalAccountId: true, providerMetadata: true, config: true },
  });
  const rows = await Promise.all(accounts.map(async (account) => {
    const available = account.enabled && account.status === "CONNECTED";
    let profile = null;
    if (available) {
      try { profile = await phoneProfile(account.id, (await channelMessageService.adapterFor("META", account.id)).channel); } catch (_error) { profile = null; }
    }
    return {
      id: account.id,
      name: account.name,
      phone: profile?.displayPhoneNumber || account.config?.displayPhoneNumber || account.providerMetadata?.displayPhoneNumber || null,
      verifiedName: profile?.verifiedName || null,
      wabaId: account.config?.wabaId || account.config?.businessAccountId || account.providerMetadata?.wabaId || null,
      quality: profile?.quality || null,
      status: account.status,
      available,
      reason: available ? null : (!account.enabled ? "Número desativado." : ACCOUNT_STATUS_REASON[account.status] || "Número indisponível."),
    };
  }));
  if (templatesConfigured()) {
    const profile = await phoneProfile(LEGACY_ACCOUNT_ID, defaultChannel);
    rows.push({
      id: LEGACY_ACCOUNT_ID, name: "WhatsApp principal", phone: profile?.displayPhoneNumber || null,
      verifiedName: profile?.verifiedName || null, wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || null,
      quality: profile?.quality || null, status: "CONNECTED", available: true, reason: null,
    });
  }
  return rows;
}

/** Resolve o canal do número escolhido — sempre revalida acesso e conexão. */
async function resolveSender(user, accountId, defaultChannel) {
  const id = String(accountId || LEGACY_ACCOUNT_ID);
  if (id === LEGACY_ACCOUNT_ID) {
    if (!templatesConfigured()) throw fail("O número principal ainda não está configurado para templates.", 409, "SENDER_UNAVAILABLE");
    return { accountId: null, channel: defaultChannel, name: "WhatsApp principal" };
  }
  if (!(await authorization.canAccessChannelAccount(user, id))) throw authorization.forbidden("Você não tem acesso a este número.");
  const account = await prisma.channelAccount.findUnique({ where: { id }, select: { id: true, channel: true, name: true, enabled: true, status: true } });
  if (!account || account.channel !== "META") throw fail("Número não encontrado.", 404);
  if (!account.enabled || account.status !== "CONNECTED") throw fail("Este número está desconectado ou desativado e não pode enviar.", 409, "SENDER_UNAVAILABLE");
  return { accountId: account.id, channel: (await channelMessageService.adapterFor("META", account.id)).channel, name: account.name };
}

async function listSenderTemplates(user, accountId, defaultChannel) {
  assertCanUsePanel(user);
  const sender = await resolveSender(user, accountId, defaultChannel);
  return (await listApprovedTemplates(sender.channel)).filter((template) => !template.status || template.status === "APPROVED");
}

// ---------------------------------------------------- Contatos da Central

function periodRange(filters) {
  const days = { "7": 7, "30": 30, "90": 90 }[String(filters.period || "")];
  if (days) return { gte: new Date(Date.now() - days * 86_400_000) };
  if (filters.period === "custom") {
    const range = {};
    if (/^\d{4}-\d{2}-\d{2}$/.test(filters.from || "")) range.gte = new Date(`${filters.from}T00:00:00-03:00`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(filters.to || "")) range.lt = new Date(new Date(`${filters.to}T00:00:00-03:00`).getTime() + 86_400_000);
    return Object.keys(range).length ? range : null;
  }
  return null;
}

/**
 * Filtro de conversas visíveis ao usuário (mesmo escopo RBAC da Central —
 * atendente só vê as próprias/da fila; supervisor as áreas que gerencia).
 */
async function conversationFilter(user, filters) {
  const AND = [await authorization.conversationScope(user), { channel: "META" }];
  if (filters.categoryId === "none") AND.push({ categoryId: null });
  else if (filters.categoryId) AND.push({ categoryId: String(filters.categoryId) });
  if (filters.assignedUserId === "none") AND.push({ assignedUserId: null });
  else if (filters.assignedUserId) AND.push({ assignedUserId: String(filters.assignedUserId) });
  if (filters.channelAccountId === LEGACY_ACCOUNT_ID) AND.push({ channelAccountId: null });
  else if (filters.channelAccountId) AND.push({ channelAccountId: String(filters.channelAccountId) });
  if (filters.origin === "CAMPAIGN") AND.push({ originSource: "OUTBOUND_CAMPAIGN" });
  if (filters.origin === "ORGANIC") AND.push({ originSource: null });
  const range = periodRange(filters);
  // "Já conversaram conosco" = existe mensagem RECEBIDA do cliente (no
  // período, quando informado); "Nunca conversou" = só mensagens nossas.
  if (filters.conversed === "yes") AND.push({ messages: { some: { direction: "RECEBIDA", ...(range ? { occurredAt: range } : {}) } } });
  else if (filters.conversed === "no") AND.push({ messages: { none: { direction: "RECEBIDA" } } });
  else if (range) AND.push({ lastMessageAt: range });
  return { AND };
}

async function contactWhere(user, filters) {
  const where = { channel: "META", phone: { not: null }, conversations: { some: await conversationFilter(user, filters) } };
  const q = String(filters.q || "").trim();
  if (q) {
    const digits = q.replace(/\D/g, "");
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { customName: { contains: q, mode: "insensitive" } },
      ...(digits.length >= 4 ? [{ phone: { contains: digits } }] : []),
    ];
  }
  return where;
}

async function searchCentralContacts(user, filters = {}) {
  // Também usado pelo modo individual ("Contato já cadastrado"); o escopo
  // RBAC da Central limita o que cada usuário encontra.
  assertCanUsePanel(user);
  const take = Math.min(Math.max(Number(filters.limit) || 50, 1), 100);
  const page = Math.max(Number(filters.page) || 1, 1);
  const where = await contactWhere(user, filters);
  const convWhere = await conversationFilter(user, filters);
  const [total, contacts] = await Promise.all([
    prisma.contact.count({ where }),
    prisma.contact.findMany({
      where, take, skip: (page - 1) * take, orderBy: { updatedAt: "desc" },
      select: {
        id: true, name: true, customName: true, phone: true,
        conversations: {
          where: convWhere, orderBy: { lastMessageAt: "desc" }, take: 1,
          select: {
            id: true, lastMessageAt: true, status: true,
            category: { select: { id: true, name: true, color: true } },
            assignedUser: { select: { id: true, name: true } },
            channelAccount: { select: { id: true, name: true } },
            originSource: true,
          },
        },
      },
    }),
  ]);
  const optedOut = new Set((await prisma.optOut.findMany({
    where: { removedAt: null, phone: { in: contacts.flatMap((contact) => rules.phoneVariants(contact.phone)) } }, select: { phone: true },
  })).map((row) => row.phone));
  return {
    total, page, pageSize: take,
    contacts: contacts.map((contact) => {
      const conversation = contact.conversations[0] || null;
      return {
        contactId: contact.id,
        name: contact.customName || contact.name || "",
        phone: contact.phone,
        phoneLabel: rules.formatPhone(contact.phone),
        optedOut: rules.phoneVariants(contact.phone).some((phone) => optedOut.has(phone)),
        lastConversationAt: conversation?.lastMessageAt || null,
        conversationStatus: conversation?.status || null,
        channel: conversation?.channelAccount?.name || "WhatsApp principal",
        category: conversation?.category || null,
        assignedUser: conversation?.assignedUser || null,
        origin: conversation?.originSource === "OUTBOUND_CAMPAIGN" ? "Campanha" : "Cliente iniciou",
      };
    }),
  };
}

/** "Selecionar todos os resultados" — ids + dados mínimos, limitado ao máximo por lote. */
async function selectAllCentralContacts(user, filters = {}) {
  assertCanBulkSend(user);
  const settings = await getCampaignSettings();
  const max = settings.maxCampaignRecipients || DEFAULT_MAX_CAMPAIGN_RECIPIENTS;
  const where = await contactWhere(user, filters);
  const total = await prisma.contact.count({ where });
  const contacts = await prisma.contact.findMany({ where, take: max, orderBy: { updatedAt: "desc" }, select: { id: true, name: true, customName: true, phone: true } });
  return {
    total, limit: max, truncated: total > max,
    contacts: contacts.map((contact) => ({ contactId: contact.id, name: contact.customName || contact.name || "", phone: contact.phone })),
  };
}

/** Filtros disponíveis (categorias, responsáveis e números visíveis ao usuário). */
async function centralFilterOptions(user) {
  assertCanBulkSend(user);
  const scope = await authorization.conversationScope(user);
  const [categories, users] = await Promise.all([
    prisma.category.findMany({ where: { active: true, conversations: { some: scope } }, orderBy: [{ displayOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, color: true } }),
    prisma.user.findMany({ where: { active: true, role: { not: "BOT" }, assignedConversations: { some: scope } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return { categories, users };
}

// ------------------------------------------------------ Prévia do lote

function cleanRecipients(input) {
  if (!Array.isArray(input)) throw fail("Informe os destinatários.");
  return input.slice(0, 20000).map((recipient, index) => ({
    key: String(recipient?.key ?? index),
    contactId: recipient?.contactId ? String(recipient.contactId) : null,
    name: String(recipient?.name || "").trim().slice(0, 160),
    phone: String(recipient?.phone || ""),
    templateName: recipient?.templateName ? String(recipient.templateName) : null,
    templateLanguage: recipient?.templateLanguage ? String(recipient.templateLanguage) : null,
    values: recipient?.values && typeof recipient.values === "object" ? recipient.values : undefined,
    useNameFallback: Boolean(recipient?.useNameFallback),
  }));
}

/**
 * Valida tudo NO BACKEND (nunca confia na tela): número remetente, acesso a
 * cada contato da Central, opt-out, template aprovado, variáveis e
 * duplicidade. Também reaproveita o nome/contato já cadastrado por telefone.
 */
async function buildPreview(user, payload, defaultChannel) {
  assertCanBulkSend(user);
  const settings = await getCampaignSettings();
  const recipients = cleanRecipients(payload?.recipients);
  const max = settings.maxCampaignRecipients || DEFAULT_MAX_CAMPAIGN_RECIPIENTS;
  if (!recipients.length) throw fail("Adicione ao menos um destinatário.");
  if (recipients.length > max) throw fail(`O limite por envio é de ${max} destinatários.`);

  let sender = null;
  let senderError = null;
  try { sender = await resolveSender(user, payload?.accountId, defaultChannel); }
  catch (error) { if (error.statusCode === 403) throw error; senderError = error.message; }
  const templates = sender ? await listApprovedTemplates(sender.channel) : [];

  // Telefone já cadastrado → reaproveita o Contact (nunca duplica).
  const normalizedPhones = recipients.map((recipient) => rules.normalizeRecipientPhone(recipient.phone).phone).filter(Boolean);
  const variants = [...new Set(normalizedPhones.flatMap(rules.phoneVariants))];
  const existing = variants.length ? await prisma.contact.findMany({
    where: { channel: "META", externalId: { in: variants } }, select: { id: true, externalId: true, name: true, customName: true },
  }) : [];
  const existingByVariant = new Map(existing.map((contact) => [contact.externalId, contact]));
  for (const recipient of recipients) {
    const phone = rules.normalizeRecipientPhone(recipient.phone).phone;
    const found = phone && rules.phoneVariants(phone).map((variant) => existingByVariant.get(variant)).find(Boolean);
    // O vínculo vem do telefone resolvido no servidor, nunca de um ID enviado pela tela.
    recipient.contactId = found?.id || null;
    if (!found) continue;
    recipient.existingContact = true;
    if (!recipient.name) recipient.name = found.customName || found.name || "";
  }

  // Só entram contatos que o usuário pode ver na Central (mesmo escopo RBAC).
  // Telefone digitado/importado que já pertence a uma conversa de outro
  // atendente também é bloqueado — mesma regra do envio individual (403).
  const contactIds = [...new Set(recipients.map((recipient) => recipient.contactId).filter(Boolean))];
  const allowed = contactIds.length
    ? new Set((await prisma.contact.findMany({
      // Contato sem nenhuma conversa não pertence a ninguém ainda: liberado.
      where: { id: { in: contactIds }, OR: [{ conversations: { some: await authorization.conversationScope(user) } }, { conversations: { none: {} } }] }, select: { id: true },
    })).map((contact) => contact.id))
    : new Set();
  const forbiddenContactIds = new Set(contactIds.filter((id) => !allowed.has(id)));

  const optedOut = new Set((await prisma.optOut.findMany({ where: { removedAt: null, phone: { in: variants } }, select: { phone: true } })).map((row) => row.phone));
  const validated = rules.validateRecipients(recipients, {
    templates,
    mappings: payload?.mappings || {},
    defaultTemplate: payload?.defaultTemplate?.name ? { name: String(payload.defaultTemplate.name), language: String(payload.defaultTemplate.language || "") } : null,
    agent: { name: user.name },
    optedOut,
    senderAvailable: Boolean(sender),
    forbiddenContactIds,
  }).map((row, index) => ({ ...row, existingContact: Boolean(recipients[index].existingContact) }));

  return {
    sender: sender ? { accountId: sender.accountId || LEGACY_ACCOUNT_ID, name: sender.name } : null,
    senderError,
    massMessagingEnabled: settings.massMessagingEnabled,
    summary: rules.summarize(validated, templates),
    recipients: validated,
    templates: templates.filter((template) => validated.some((row) => row.template?.name === template.name && row.template?.language === template.language))
      .map((template) => ({ name: template.name, language: template.language, category: template.category, pricing: template.pricing })),
  };
}

async function previewBulkSend(user, payload, defaultChannel) {
  const preview = await buildPreview(user, payload, defaultChannel);
  return { ...preview, issueLabels: rules.ISSUE_LABELS };
}

// ------------------------------------------------------ Criação do lote

function defaultBatchName(user, now = new Date()) {
  const when = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(now);
  return `Envio pelo painel — ${when} — ${user.name}`;
}

/**
 * Cria o lote (Campaign origin=PANEL) com os destinatários válidos em
 * QUEUED. O worker é quem envia, respeitando lote/intervalo, opt-out e o
 * master switch. `idempotencyKey` obrigatório: repetir o mesmo pedido
 * devolve o mesmo lote em vez de criar outro.
 */
async function createBulkSend(user, payload, defaultChannel) {
  assertCanBulkSend(user);
  const idempotencyKey = String(payload?.idempotencyKey || "").trim();
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) throw fail("Pedido de envio sem identificador de idempotência.");
  const existing = await prisma.campaign.findUnique({ where: { idempotencyKey } });
  if (existing) {
    if (existing.createdByUserId !== user.id) throw fail("Identificador de envio já utilizado.", 409);
    return { campaignId: existing.id, duplicateRequest: true, ...(await batchCounts(existing.id)) };
  }

  const preview = await buildPreview(user, payload, defaultChannel);
  if (!preview.sender) throw fail(preview.senderError || "Número remetente indisponível.", 409, "SENDER_UNAVAILABLE");
  const ready = preview.recipients.filter((recipient) => recipient.ok);
  if (!ready.length) throw fail("Nenhum destinatário válido para envio. Revise os itens bloqueados.");
  if (payload?.confirmedCount !== undefined && Number(payload.confirmedCount) !== ready.length) {
    throw fail("A lista mudou desde a revisão. Revise novamente antes de confirmar.", 409, "PREVIEW_CHANGED");
  }

  const templateUsage = new Map();
  for (const recipient of ready) {
    const key = rules.templateKey(recipient.template.name, recipient.template.language);
    templateUsage.set(key, { ...recipient.template, count: (templateUsage.get(key)?.count || 0) + 1 });
  }
  const main = [...templateUsage.values()].sort((a, b) => b.count - a.count)[0];
  const name = String(payload?.name || "").trim().slice(0, 160) || defaultBatchName(user);

  let campaign;
  try {
    campaign = await prisma.$transaction(async (transaction) => {
      const created = await transaction.campaign.create({
        data: {
          name, origin: PANEL_ORIGIN, idempotencyKey, channel: "META", channelAccountId: preview.sender.accountId === LEGACY_ACCOUNT_ID ? null : preview.sender.accountId,
          templateName: main.name, templateLanguage: main.language, templateCategory: main.category,
          category: "Envio pelo painel",
          // Resposta do cliente cai para quem enviou, se a conversa ainda não tiver responsável.
          responsibleUserId: user.id,
          status: "QUEUED", createdByUserId: user.id, updatedByUserId: user.id,
        },
      });
      await transaction.campaignContact.createMany({
        data: ready.map((recipient) => ({
          campaignId: created.id, contactId: recipient.contactId || null, phone: recipient.phone,
          fullName: recipient.name || null, firstName: recipient.name ? recipient.name.split(/\s+/)[0] : null,
          source: recipient.contactId ? "WHATSAPP" : "MANUAL_IMPORT", status: "QUEUED",
          templateName: recipient.template.name, templateLanguage: recipient.template.language, templateCategory: recipient.template.category,
          variableValues: recipient.values,
        })),
        skipDuplicates: true,
      });
      return created;
    });
  } catch (error) {
    // Corrida entre dois cliques simultâneos: o índice único resolve.
    if (error?.code === "P2002") {
      const raced = await prisma.campaign.findUnique({ where: { idempotencyKey } });
      if (raced) {
        if (raced.createdByUserId !== user.id) throw fail("Identificador de envio já utilizado.", 409);
        return { campaignId: raced.id, duplicateRequest: true, ...(await batchCounts(raced.id)) };
      }
    }
    throw error;
  }

  await audit.recordAudit({
    actor: user, action: "PANEL_BULK_SEND_CREATED", entityType: "CAMPAIGN", entityId: campaign.id,
    summary: `Criou envio pelo painel "${campaign.name}" com ${ready.length} destinatário(s)`,
    details: {
      sender: preview.sender, recipients: ready.length, blocked: preview.summary.blocked,
      templates: [...templateUsage.values()].map(({ name: template, language, category, count }) => ({ template, language, category, count })),
      estimatedCost: preview.summary.cost.total,
    },
  });
  return {
    campaignId: campaign.id, duplicateRequest: false, queued: ready.length, blocked: preview.summary.blocked,
    massMessagingEnabled: preview.massMessagingEnabled,
  };
}

// --------------------------------------------------- Acompanhamento

async function batchCounts(campaignId) {
  const grouped = await prisma.campaignContact.groupBy({ by: ["status"], where: { campaignId, isTest: false }, _count: { _all: true } });
  const counts = Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const sent = ["SENT", "DELIVERED", "READ", "REPLIED"].reduce((sum, status) => sum + (counts[status] || 0), 0);
  return { total, counts, sent, failed: counts.FAILED || 0 };
}

async function assertCanSeeBatch(user, campaign) {
  if (!campaign) throw fail("Envio não encontrado.", 404);
  if (campaign.createdByUserId === user.id || authorization.isMaster(user)) return;
  throw fail("Envio não encontrado.", 404);
}

async function getBulkSend(user, campaignId) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: String(campaignId) },
    include: { createdBy: { select: { id: true, name: true } }, channelAccount: { select: { id: true, name: true } } },
  });
  await assertCanSeeBatch(user, campaign);
  const settings = await getCampaignSettings();
  const recipients = await prisma.campaignContact.findMany({
    where: { campaignId: campaign.id, isTest: false }, orderBy: { createdAt: "asc" }, take: 500,
    select: { id: true, phone: true, fullName: true, templateName: true, status: true, sentAt: true, deliveredAt: true, readAt: true, repliedAt: true, failedAt: true, failureReason: true, contactId: true },
  });
  return {
    id: campaign.id, name: campaign.name, status: campaign.status, origin: campaign.origin,
    sender: campaign.channelAccount?.name || "WhatsApp principal", createdBy: campaign.createdBy, createdAt: campaign.createdAt,
    massMessagingEnabled: settings.massMessagingEnabled,
    ...(await batchCounts(campaign.id)),
    recipients: recipients.map((recipient) => ({ ...recipient, phoneLabel: rules.formatPhone(recipient.phone) })),
  };
}

async function listMyBulkSends(user) {
  assertCanBulkSend(user);
  const campaigns = await prisma.campaign.findMany({
    where: { origin: PANEL_ORIGIN, ...(authorization.isMaster(user) ? {} : { createdByUserId: user.id }) },
    orderBy: { createdAt: "desc" }, take: 20,
    select: { id: true, name: true, status: true, createdAt: true, createdBy: { select: { name: true } } },
  });
  return Promise.all(campaigns.map(async (campaign) => ({ ...campaign, ...(await batchCounts(campaign.id)) })));
}

/** Histórico de templates recebidos por um contato (painel do contato). */
async function contactTemplateHistory(user, contactId) {
  await authorization.assertCanAccessContact(user, String(contactId));
  const contact = await prisma.contact.findUnique({ where: { id: String(contactId) }, select: { id: true, phone: true } });
  if (!contact) throw fail("Contato não encontrado.", 404);
  const phones = contact.phone ? rules.phoneVariants(contact.phone) : [];
  const rows = await prisma.campaignContact.findMany({
    where: { isTest: false, OR: [{ contactId: contact.id }, ...(phones.length ? [{ phone: { in: phones } }] : [])] },
    orderBy: { createdAt: "desc" }, take: 50,
    select: {
      id: true, status: true, templateName: true, sentAt: true, deliveredAt: true, readAt: true, repliedAt: true, failedAt: true, createdAt: true,
      campaign: { select: { id: true, name: true, templateName: true, origin: true, createdBy: { select: { name: true } } } },
    },
  });
  return rows.map((row) => ({
    id: row.id, status: row.status, template: row.templateName || row.campaign.templateName,
    campaign: { id: row.campaign.id, name: row.campaign.name, origin: row.campaign.origin }, sentBy: row.campaign.createdBy?.name || null,
    sentAt: row.sentAt, deliveredAt: row.deliveredAt, readAt: row.readAt, repliedAt: row.repliedAt, failedAt: row.failedAt, createdAt: row.createdAt,
  }));
}

module.exports = {
  LEGACY_ACCOUNT_ID,
  PANEL_ORIGIN,
  centralFilterOptions,
  contactTemplateHistory,
  createBulkSend,
  getBulkSend,
  listMyBulkSends,
  listSenderNumbers,
  listSenderTemplates,
  previewBulkSend,
  resolveSender,
  searchCentralContacts,
  selectAllCentralContacts,
};
