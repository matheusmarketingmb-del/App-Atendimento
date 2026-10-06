const prisma = require("../database/prisma");
const { saveIncoming } = require("./message-service");

function clean(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (digits.length < 12 || digits.length > 13) {
    throw Object.assign(new Error("Telefone inválido."), { statusCode: 400 });
  }
  return digits;
}

function normalizeLead(payload) {
  const lead = {
    leadId: clean(payload?.lead_id, 100),
    name: clean(payload?.name, 160),
    email: clean(payload?.email, 254).toLowerCase(),
    phone: normalizePhone(payload?.phone),
    cnpj: clean(payload?.cnpj, 24),
    campaign: clean(payload?.campaign, 120),
    pageUrl: clean(payload?.page_url, 2_000),
    utmSource: clean(payload?.utm_source, 200),
    utmMedium: clean(payload?.utm_medium, 200),
    utmCampaign: clean(payload?.utm_campaign, 200),
    utmContent: clean(payload?.utm_content, 200),
  };
  if (!lead.leadId || !lead.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
    throw Object.assign(new Error("Cadastro inválido."), { statusCode: 400 });
  }
  if (lead.cnpj.replace(/\D/g, "").length !== 14) {
    throw Object.assign(new Error("CNPJ inválido."), { statusCode: 400 });
  }
  return lead;
}

async function registerExternalLead(payload) {
  const lead = normalizeLead(payload);
  const externalId = `lp-atacado:${lead.leadId}`;
  const text = [
    "Novo cadastro — LP Atacado Mibro",
    `Nome: ${lead.name}`,
    `E-mail: ${lead.email}`,
    `Telefone: ${lead.phone}`,
    `CNPJ: ${lead.cnpj}`,
    `Campanha: ${lead.campaign || "não informada"}`,
    `Página: ${lead.pageUrl || "não informada"}`,
  ].join("\n");

  const result = await saveIncoming({
    externalId,
    contactExternalId: lead.phone,
    phone: lead.phone,
    contactName: lead.name,
    type: "text",
    text,
    occurredAt: new Date(),
    rawPayload: { source: "lp_atacado_mibro", ...lead },
  });

  const conversation = await prisma.conversation.findUnique({
    where: { id: result.message.conversationId },
  });
  // Lead da LP da Mibro entra pelo número original (Mibro) — o setor
  // Comercial procurado é o da MESMA empresa da conversa.
  const commercial = conversation
    ? await prisma.category.findFirst({ where: { code: "COMERCIAL", companyId: conversation.companyId } })
    : null;
  if (conversation && commercial && !conversation.categoryId) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { categoryId: commercial.id, status: "NOVO", finalizedAt: null },
    });
  }

  return {
    leadId: lead.leadId,
    conversationId: result.message.conversationId,
    duplicate: result.duplicate,
  };
}

module.exports = { normalizeLead, registerExternalLead };
