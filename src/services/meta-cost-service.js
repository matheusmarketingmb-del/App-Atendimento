// Controle de custos da Meta — ESTIMATIVA, nunca bloqueia envio.
//
// Fonte: o webhook de STATUS do WhatsApp (sent/delivered/read) traz
// `pricing` ({ billable, pricing_model, category, type }). Cada status de uma
// mensagem nossa (Message ENVIADA no canal META) cria/atualiza UM registro
// MetaMessageCharge. Ponto único: cobre resposta, Bot, template e campanha,
// e mensagem que falhou (sem status de envio) nunca vira custo.
//
// Categoria: `pricing.category` da Meta > categoria do template enviado >
// SERVICE. Nunca classifica o texto de mensagem comum.
// Preço: tabela MetaPricing versionada (país + categoria + vigência) — nada
// de valor fixo no código. Sem preço cadastrado, o custo fica nulo
// ("sem preço"); billable=false ou tipo gratuito = 0.
const { Prisma } = require("@prisma/client");
const prisma = require("../database/prisma");
const audit = require("./audit-service");
const authorization = require("./authorization-service");
const companyService = require("./company-service");

const CATEGORIES = ["SERVICE", "MARKETING", "UTILITY", "AUTHENTICATION"];
const FREE_TYPES = new Set(["free_customer_service", "free_entry_point"]);

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// "marketing_lite" → MARKETING, "authentication-international" →
// AUTHENTICATION, "referral_conversion"/"service" → SERVICE.
function normalizeCategory(value) {
  const text = String(value || "").toLowerCase();
  if (!text) return null;
  if (text.startsWith("marketing")) return "MARKETING";
  if (text.startsWith("utility")) return "UTILITY";
  if (text.startsWith("authentication")) return "AUTHENTICATION";
  if (text === "service" || text === "referral_conversion") return "SERVICE";
  return null;
}

// País de cobrança pelo DDI do destinatário (a Meta cobra pelo país do
// número). Brasil explícito; demais ficam "INTL" (preço próprio na tabela).
function countryForPhone(phone) {
  return String(phone || "").replace(/\D/g, "").startsWith("55") ? "BR" : "INTL";
}

async function priceFor({ country, category, at }, client = prisma) {
  return client.metaPricing.findFirst({
    where: { country, category, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] },
    orderBy: { effectiveFrom: "desc" },
  });
}

function estimate({ billable, pricingType, price }) {
  if (billable === false || FREE_TYPES.has(pricingType)) return new Prisma.Decimal(0);
  return price ? new Prisma.Decimal(price.price) : null;
}

// Chamado pelo webhook para cada evento de status. Nunca lança (o webhook
// não pode falhar por causa de relatório de custo).
async function recordStatusEvent(event, { client = prisma } = {}) {
  try {
    if (event?.kind !== "status" || !event.externalId) return null;
    if (!["sent", "delivered", "read"].includes(event.status)) return null;
    const message = await client.message.findUnique({
      where: { externalId: event.externalId },
      select: {
        id: true, conversationId: true, channel: true, direction: true, type: true, occurredAt: true, rawPayload: true, channelAccountId: true,
        conversation: { select: { companyId: true, channelAccountId: true, contact: { select: { phone: true } } } },
      },
    });
    if (!message || message.channel !== "META" || message.direction !== "ENVIADA") return null;
    const pricing = event.rawPayload?.pricing || null;
    const template = message.rawPayload?.template || null;
    const existing = await client.metaMessageCharge.findUnique({ where: { messageId: message.id } });
    const category = normalizeCategory(pricing?.category) || normalizeCategory(existing?.pricingCategory)
      || normalizeCategory(template?.category) || existing?.category || "SERVICE";
    const country = existing?.country || countryForPhone(message.conversation.contact?.phone);
    const billable = typeof pricing?.billable === "boolean" ? pricing.billable : existing?.billable ?? null;
    const pricingType = pricing?.type || existing?.pricingType || null;
    const price = await priceFor({ country, category, at: message.occurredAt }, client);
    const data = {
      category, country, billable, pricingType,
      pricingCategory: pricing?.category || existing?.pricingCategory || null,
      pricingModel: pricing?.pricing_model || existing?.pricingModel || null,
      estimatedCost: estimate({ billable, pricingType, price }),
      currency: price?.currency || existing?.currency || "BRL",
      ...(["delivered", "read"].includes(event.status) && !existing?.deliveredAt ? { deliveredAt: event.occurredAt || new Date() } : {}),
    };
    return await client.metaMessageCharge.upsert({
      where: { messageId: message.id },
      update: data,
      create: {
        ...data, messageId: message.id, conversationId: message.conversationId, companyId: message.conversation.companyId,
        channelAccountId: message.channelAccountId || message.conversation.channelAccountId || null,
        messageType: message.type, templateName: template?.name || null, templateCategory: template?.category || null,
        sentAt: message.occurredAt,
      },
    });
  } catch (error) {
    console.warn("[META_COST] falha ao registrar custo (envio não afetado):", error.message);
    return null;
  }
}

// ---- relatório --------------------------------------------------------------

function periodRange({ period = "month", from, to } = {}, now = new Date()) {
  if (from || to) {
    const start = from ? new Date(from) : new Date(0);
    const end = to ? new Date(to) : now;
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) throw fail("Período inválido.");
    return { start, end };
  }
  const start = require("./operations-panel-service").startOfToday(now);
  if (period === "day") { /* início do dia no fuso da operação */ }
  else if (period === "week") start.setUTCDate(start.getUTCDate() - 6);
  else if (period === "month") start.setUTCDate(1);
  else throw fail("Período inválido (day, week ou month).");
  return { start, end: now };
}

function monthStart(now = new Date()) {
  return periodRange({ period: "month" }, now).start;
}

const toNumber = (value) => (value === null || value === undefined ? null : Number(value));

async function getCostReport(viewer, query = {}, { now = new Date() } = {}) {
  authorization.assertMaster(viewer);
  const { start, end } = periodRange(query, now);
  const companyIds = query.company && query.company !== companyService.ALL_COMPANIES
    ? await companyService.resolveCompanyFilter(viewer, query.company)
    : await companyService.accessibleCompanyIds(viewer);
  const where = { companyId: { in: companyIds }, currency: "BRL", sentAt: { gte: start, lte: end }, ...(query.channelAccountId ? { channelAccountId: String(query.channelAccountId) } : {}) };
  const [rows, unpriced, budgets, monthRows, companies, accounts] = await Promise.all([
    prisma.metaMessageCharge.groupBy({ by: ["companyId", "channelAccountId", "category"], where, _count: { _all: true }, _sum: { estimatedCost: true } }),
    prisma.metaMessageCharge.count({ where: { ...where, estimatedCost: null } }),
    prisma.metaCostBudget.findMany({ where: { companyId: { in: companyIds } } }),
    prisma.metaMessageCharge.groupBy({ by: ["companyId"], where: { companyId: { in: companyIds }, currency: "BRL", sentAt: { gte: monthStart(now), lte: now } }, _sum: { estimatedCost: true } }),
    companyService.listCompanies({ includeInactive: true }),
    prisma.channelAccount.findMany({ where: { companyId: { in: companyIds }, channel: "META" }, select: { id: true, name: true, companyId: true } }),
  ]);
  const accountNames = new Map(accounts.map(({ id, name }) => [id, name]));
  const emptyCounts = () => Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  const byCompany = new Map(companyIds.map((id) => {
    const company = companies.find((item) => item.id === id);
    return [id, {
      companyId: id, company: company ? companyService.publicCompany(company) : null,
      serviceMessages: 0, templates: 0, byCategory: emptyCounts(), estimatedCost: 0, accounts: new Map(),
    }];
  }));
  for (const row of rows) {
    const company = byCompany.get(row.companyId);
    if (!company) continue;
    const cost = toNumber(row._sum.estimatedCost) || 0;
    company.byCategory[row.category] += row._count._all;
    if (row.category === "SERVICE") company.serviceMessages += row._count._all; else company.templates += row._count._all;
    company.estimatedCost += cost;
    const key = row.channelAccountId || "none";
    if (!company.accounts.has(key)) company.accounts.set(key, { channelAccountId: row.channelAccountId, name: accountNames.get(row.channelAccountId) || "Sem número vinculado", serviceMessages: 0, templates: 0, estimatedCost: 0 });
    const account = company.accounts.get(key);
    if (row.category === "SERVICE") account.serviceMessages += row._count._all; else account.templates += row._count._all;
    account.estimatedCost += cost;
  }
  const monthCost = new Map(monthRows.map((row) => [row.companyId, toNumber(row._sum.estimatedCost) || 0]));
  const budgetByCompany = new Map(budgets.map((budget) => [budget.companyId, budget]));
  const round = (value) => Math.round(value * 100) / 100;
  const result = [...byCompany.values()].map((company) => {
    const budget = budgetByCompany.get(company.companyId);
    const used = monthCost.get(company.companyId) || 0;
    return {
      ...company, estimatedCost: round(company.estimatedCost),
      accounts: [...company.accounts.values()].map((account) => ({ ...account, estimatedCost: round(account.estimatedCost) })),
      budget: budget ? {
        monthlyBudget: toNumber(budget.monthlyBudget), currency: budget.currency, usedThisMonth: round(used),
        percent: toNumber(budget.monthlyBudget) > 0 ? Math.round((used / toNumber(budget.monthlyBudget)) * 100) : null,
      } : null,
    };
  });
  return {
    period: { start, end }, currency: "BRL", unpricedCount: unpriced,
    companies: result,
    total: {
      serviceMessages: result.reduce((sum, company) => sum + company.serviceMessages, 0),
      templates: result.reduce((sum, company) => sum + company.templates, 0),
      estimatedCost: round(result.reduce((sum, company) => sum + company.estimatedCost, 0)),
    },
  };
}

// ---- preços e orçamento (só Master) ----------------------------------------

async function listPricing(viewer) {
  authorization.assertMaster(viewer);
  return prisma.metaPricing.findMany({ orderBy: [{ country: "asc" }, { category: "asc" }, { effectiveFrom: "desc" }] });
}

// Novo preço: encerra o vigente da mesma (país, categoria) na data de início
// do novo — o histórico de preços nunca é apagado nem sobrescrito.
async function createPricing({ country = "BR", category, price, currency = "BRL", effectiveFrom } = {}, viewer) {
  authorization.assertMaster(viewer);
  const cleanCountry = String(country || "").trim().toUpperCase().slice(0, 8);
  if (!cleanCountry) throw fail("Informe o país (ex.: BR).");
  if (!CATEGORIES.includes(category)) throw fail("Categoria inválida.");
  const value = Number(price);
  if (!Number.isFinite(value) || value < 0 || value > 1000) throw fail("Preço inválido.");
  const start = effectiveFrom ? new Date(effectiveFrom) : new Date();
  if (Number.isNaN(start.getTime())) throw fail("Data de início inválida.");
  const cleanCurrency = String(currency || "BRL").trim().toUpperCase().slice(0, 3);
  if (cleanCurrency !== "BRL") throw fail("O relatório usa reais. Cadastre preços em BRL; não há conversão automática de moedas.");
  return prisma.$transaction(async (transaction) => {
    const next = await transaction.metaPricing.findFirst({
      where: { country: cleanCountry, category, effectiveFrom: { gt: start } }, orderBy: { effectiveFrom: "asc" },
    });
    const duplicate = await transaction.metaPricing.findFirst({ where: { country: cleanCountry, category, effectiveFrom: start } });
    if (duplicate) throw fail("Já existe um preço para essa categoria, país e início de vigência.");
    await transaction.metaPricing.updateMany({
      where: { country: cleanCountry, category, effectiveFrom: { lt: start }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: start } }] },
      data: { effectiveTo: start },
    });
    const created = await transaction.metaPricing.create({ data: {
      country: cleanCountry, category, price: new Prisma.Decimal(value), currency: cleanCurrency, effectiveFrom: start, effectiveTo: next?.effectiveFrom || null, createdById: viewer.id,
    } });
    // Cadastro posterior preenche apenas custos ainda sem preço, na vigência
    // correspondente. Estimativas já registradas não são reescritas.
    await transaction.metaMessageCharge.updateMany({
      where: { country: cleanCountry, category, estimatedCost: null, sentAt: { gte: start, ...(next ? { lt: next.effectiveFrom } : {}) } },
      data: { estimatedCost: new Prisma.Decimal(value), currency: cleanCurrency },
    });
    await audit.recordAudit({
      actor: viewer, action: "META_PRICING_CREATED", entityType: "CONVERSATION_SETTINGS", entityId: created.id,
      summary: `Cadastrou preço Meta ${category} (${cleanCountry}): ${cleanCurrency} ${value}`,
      details: { country: cleanCountry, category, price: value, currency: cleanCurrency, effectiveFrom: start },
    }, transaction);
    return created;
  });
}

async function setBudget({ company, monthlyBudget, currency = "BRL" } = {}, viewer) {
  authorization.assertMaster(viewer);
  if (!company || company === companyService.ALL_COMPANIES) throw fail("Informe a empresa.");
  if (currency !== "BRL") throw fail("O orçamento deve ser informado em BRL.");
  const [companyId] = await companyService.resolveCompanyFilter(viewer, company);
  if (!companyId || company === companyService.ALL_COMPANIES) throw fail("Informe a empresa.");
  if (monthlyBudget === null || monthlyBudget === "") {
    await prisma.metaCostBudget.deleteMany({ where: { companyId } });
    return { companyId, budget: null };
  }
  const value = Number(monthlyBudget);
  if (!Number.isFinite(value) || value < 0 || value > 10_000_000) throw fail("Orçamento inválido.");
  const budget = await prisma.metaCostBudget.upsert({
    where: { companyId },
    update: { monthlyBudget: new Prisma.Decimal(value), currency, updatedById: viewer.id },
    create: { companyId, monthlyBudget: new Prisma.Decimal(value), currency, updatedById: viewer.id },
  });
  await audit.recordAudit({
    actor: viewer, action: "META_BUDGET_UPDATED", entityType: "CONVERSATION_SETTINGS", entityId: budget.id, companyId,
    summary: `Definiu orçamento mensal Meta: ${currency} ${value}`, details: { monthlyBudget: value, currency },
  });
  return { companyId, budget: { monthlyBudget: value, currency } };
}

module.exports = {
  CATEGORIES, countryForPhone, createPricing, getCostReport, listPricing, normalizeCategory, periodRange, priceFor, recordStatusEvent, setBudget,
};
