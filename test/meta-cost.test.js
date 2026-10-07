// Controle de custos da Meta: registro pelo webhook de status (pricing da
// Meta), categoria sem classificação semântica, preços versionados,
// relatório por empresa/número, orçamento (só alerta) e RBAC (só Master).
require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const costs = require("../src/services/meta-cost-service");

const emailDomain = "@custos-meta.test";
const prefix = "metacost-test-";
const COUNTRY = `T${String(Date.now()).slice(-6)}`;
let master;
let agent;

async function cleanup() {
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: prefix } } });
  await prisma.metaPricing.deleteMany({ where: { country: { startsWith: "T" } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: emailDomain } } });
}

async function sentMessage({ companyId = "cmp_mibro", type = "text", template = null, phone = "5511933330000", occurredAt = new Date() } = {}) {
  const contact = await prisma.contact.create({ data: { companyId, externalId: `${prefix}${Date.now()}-${Math.random()}`, phone, name: "Cliente Custo" } });
  const conversation = await prisma.conversation.create({ data: { companyId, contactId: contact.id, status: "AGUARDANDO_CLIENTE" } });
  return prisma.message.create({ data: {
    conversationId: conversation.id, channel: "META", direction: "ENVIADA", status: "ENVIADA", type, text: "olá", occurredAt,
    externalId: `wamid.${prefix}${Date.now()}.${Math.random()}`, rawPayload: template ? { template } : {},
  } });
}

const status = (message, value, pricing) => ({ kind: "status", externalId: message.externalId, status: value, occurredAt: new Date(), rawPayload: pricing ? { pricing } : {} });

test.before(async () => {
  await cleanup();
  master = await prisma.user.create({ data: { name: "Master Custos", email: `m${Date.now()}${emailDomain}`, role: "ADMIN" } });
  agent = await prisma.user.create({ data: { name: "Atendente Custos", email: `a${Date.now()}${emailDomain}`, role: "SUPERVISOR", companyAccess: { create: { companyId: "cmp_mibro" } } } });
});
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("categoria: pricing da Meta > template > SERVICE; billable=false custa 0; sem preço fica nulo", async () => {
  const service = await sentMessage();
  const charge = await costs.recordStatusEvent(status(service, "sent", { billable: false, pricing_model: "PMP", category: "service", type: "free_customer_service" }));
  assert.equal(charge.category, "SERVICE");
  assert.equal(Number(charge.estimatedCost), 0);
  assert.equal(charge.country, "BR");

  const template = await sentMessage({ type: "template", template: { name: "promo_outubro", category: "MARKETING" } });
  const noStatusPricing = await costs.recordStatusEvent(status(template, "sent"));
  assert.equal(noStatusPricing.category, "MARKETING");
  assert.equal(noStatusPricing.templateName, "promo_outubro");
  // Meta informa a categoria real (ex.: template recategorizado) → prevalece.
  const delivered = await costs.recordStatusEvent(status(template, "delivered", { billable: true, pricing_model: "PMP", category: "utility", type: "regular" }));
  assert.equal(delivered.category, "UTILITY");
  assert.ok(delivered.deliveredAt);
  assert.equal(await prisma.metaMessageCharge.count({ where: { messageId: template.id } }), 1, "um registro por mensagem");

  // Mensagem recebida, falha ou status desconhecido nunca vira custo.
  assert.equal(await costs.recordStatusEvent({ kind: "status", externalId: "wamid.nao-existe", status: "sent", rawPayload: {} }), null);
  assert.equal(await costs.recordStatusEvent(status(service, "failed")), null);
  assert.equal(costs.normalizeCategory("marketing_lite"), "MARKETING");
  assert.equal(costs.normalizeCategory("authentication-international"), "AUTHENTICATION");
});

test("preços versionados por vigência; relatório por empresa e número; orçamento só alerta; só Master", async () => {
  const lastMonth = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await costs.createPricing({ country: COUNTRY, category: "MARKETING", price: 0.5, effectiveFrom: lastMonth }, master);
  const newer = await costs.createPricing({ country: COUNTRY, category: "MARKETING", price: 0.6, effectiveFrom: new Date(Date.now() - 1000) }, master);
  const old = await prisma.metaPricing.findFirst({ where: { country: COUNTRY, price: 0.5 } });
  assert.ok(old.effectiveTo, "preço anterior encerrado, não apagado");
  assert.equal(Number((await costs.priceFor({ country: COUNTRY, category: "MARKETING", at: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000) })).price), 0.5);
  assert.equal((await costs.priceFor({ country: COUNTRY, category: "MARKETING", at: new Date() })).id, newer.id);

  // Envio para número do "país de teste" (DDI fora do BR = INTL) com preço.
  await costs.createPricing({ country: "INTL", category: "MARKETING", price: 1.25 }, master).catch(() => {});
  const intl = await sentMessage({ companyId: "cmp_sincrofit", type: "template", template: { name: "promo", category: "MARKETING" }, phone: "14155550000" });
  const charge = await costs.recordStatusEvent(status(intl, "sent", { billable: true, category: "marketing", type: "regular" }));
  assert.equal(charge.country, "INTL");
  assert.equal(Number(charge.estimatedCost), 1.25);
  await prisma.metaPricing.deleteMany({ where: { country: "INTL", createdById: master.id } });

  await costs.setBudget({ company: "sincrofit", monthlyBudget: 10 }, master);
  const report = await costs.getCostReport(master, { company: "sincrofit", period: "month" });
  const sincro = report.companies.find(({ companyId }) => companyId === "cmp_sincrofit");
  assert.ok(sincro.byCategory.MARKETING >= 1);
  assert.ok(sincro.estimatedCost >= 1.25);
  assert.equal(sincro.budget.monthlyBudget, 10);
  assert.ok(sincro.budget.percent >= 12);
  assert.equal(report.companies.some(({ companyId }) => companyId === "cmp_mibro"), false, "filtro de empresa");
  await costs.setBudget({ company: "sincrofit", monthlyBudget: null }, master);

  await assert.rejects(() => costs.getCostReport(agent, {}), { statusCode: 403 });
  await assert.rejects(() => costs.createPricing({ country: "BR", category: "SERVICE", price: 0 }, agent), { statusCode: 403 });
  await assert.rejects(() => costs.setBudget({ company: "mibro", monthlyBudget: 1 }, agent), { statusCode: 403 });
  await assert.rejects(() => costs.createPricing({ country: COUNTRY, category: "XPTO", price: 1 }, master), { statusCode: 400 });
});
