const prisma = require("../database/prisma");
const channelMessageService = require("./channels/channel-message-service");
const { updateConversationAfterSending } = require("./message-service");

const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const PLACEHOLDER = /{{\s*([^{}]+?)\s*}}/g;

function templatesConfigured() {
  return Boolean(process.env.WHATSAPP_BUSINESS_ACCOUNT_ID?.trim());
}

function customerServiceWindowFrom(lastCustomerMessageAt, now = new Date(), configured = templatesConfigured()) {
  const last = lastCustomerMessageAt ? new Date(lastCustomerMessageAt) : null;
  const expiresAt = last ? new Date(last.getTime() + CUSTOMER_SERVICE_WINDOW_MS) : null;
  const open = Boolean(expiresAt && expiresAt.getTime() > now.getTime());
  return {
    configured,
    open,
    requiresTemplate: configured && !open,
    lastCustomerMessageAt: last?.toISOString() || null,
    expiresAt: expiresAt?.toISOString() || null,
    remainingSeconds: open ? Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000)) : 0,
  };
}

async function getCustomerServiceWindow(conversationId, now = new Date(), channelAccountId) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { contactId: true, channelAccountId: true, contact: { select: { whatsappInboxId: true } } } });
  const selectedAccountId = channelAccountId === undefined ? conversation?.channelAccountId : channelAccountId;
  const latest = await prisma.message.findFirst({
    where: {
      ...(conversation?.contact.whatsappInboxId ? { conversation: { contactId: conversation.contactId, channel: "META" } } : { conversationId }),
      channelAccountId: selectedAccountId || null,
      direction: "RECEBIDA",
      type: { not: "reaction" },
      OR: [{ externalId: { startsWith: "wamid." } }, ...(selectedAccountId ? [{ externalId: { startsWith: `${selectedAccountId}:wamid.` } }] : [])],
    },
    orderBy: { occurredAt: "desc" },
    select: { occurredAt: true },
  });
  const account = selectedAccountId ? await prisma.channelAccount.findUnique({ where: { id: selectedAccountId }, select: { config: true } }) : null;
  return customerServiceWindowFrom(latest?.occurredAt, now, selectedAccountId ? Boolean(account?.config?.wabaId) : templatesConfigured());
}

async function assertFreeFormAllowed(conversationId, now = new Date(), channelAccountId) {
  const window = await getCustomerServiceWindow(conversationId, now, channelAccountId);
  if (window.requiresTemplate) {
    throw Object.assign(new Error("A janela de 24 horas da Meta está encerrada. Envie um template aprovado para retomar o contato."), {
      statusCode: 409,
      code: "TEMPLATE_REQUIRED",
      details: { customerServiceWindow: window },
    });
  }
  return window;
}

function placeholders(text) {
  const found = [];
  for (const match of String(text || "").matchAll(PLACEHOLDER)) if (!found.includes(match[1])) found.push(match[1]);
  return found;
}

function componentExample(component, placeholder, index) {
  if (component.type === "BODY") {
    if (component.example?.body_text_named_params) {
      return component.example.body_text_named_params.find((item) => item.param_name === placeholder)?.example || "";
    }
    return component.example?.body_text?.[0]?.[index] || "";
  }
  if (component.type === "HEADER") return component.example?.header_text?.[index] || "";
  if (component.type === "BUTTONS") return component.example?.[index] || "";
  return "";
}

// Nunca assume que `components` existe/é array — a Meta pode devolver um
// template sem esse campo (ex.: rascunho antigo, resposta parcial).
function safeComponents(template) {
  return Array.isArray(template?.components) ? template.components : [];
}

function templateVariables(template) {
  const variables = [];
  for (const component of safeComponents(template)) {
    if (["BODY", "HEADER"].includes(component.type) && component.format !== "IMAGE" && component.format !== "VIDEO" && component.format !== "DOCUMENT") {
      placeholders(component.text).forEach((placeholder, index) => variables.push({
        key: `${component.type}:${placeholder}`,
        component: component.type,
        placeholder,
        label: `${component.type === "HEADER" ? "Cabeçalho" : "Mensagem"} — {{${placeholder}}}`,
        example: componentExample(component, placeholder, index),
      }));
    }
    if (component.type === "BUTTONS") {
      (component.buttons || []).forEach((button, index) => {
        if (button.type === "URL" && placeholders(button.url).length) variables.push({
          key: `BUTTON:${index}`,
          component: "BUTTON",
          placeholder: String(index),
          label: `Link do botão “${button.text || index + 1}”`,
          example: button.example?.[0] || "",
        });
      });
    }
  }
  return variables;
}

function renderText(text, variables, values) {
  let rendered = String(text || "");
  for (const variable of variables) {
    if (!["BODY", "HEADER"].includes(variable.component)) continue;
    const replacement = String(values[variable.key] || variable.example || `{{${variable.placeholder}}}`);
    rendered = rendered.replaceAll(`{{${variable.placeholder}}}`, replacement);
  }
  return rendered;
}

// Formato interno previsível, sempre com os mesmos campos — o frontend
// nunca precisa checar se uma chave existe: {id, name, language, category,
// status, components, variables} + os campos derivados de apresentação
// (supported/preview/etc.) já usados pelo restante do app.
const DEFAULT_BRAZIL_RATES = {
  MARKETING: 0.3217,
  UTILITY: 0.035,
  AUTHENTICATION: 0.035,
  SERVICE: 0,
};

function templatePricing(category) {
  const normalizedCategory = String(category || "").toUpperCase();
  if (!(normalizedCategory in DEFAULT_BRAZIL_RATES)) return null;
  const raw = process.env[`WHATSAPP_RATE_BRL_${normalizedCategory}`];
  const configured = raw === undefined || String(raw).trim() === "" ? Number.NaN : Number(raw);
  return {
    market: "BR", currency: "BRL",
    rate: Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_BRAZIL_RATES[normalizedCategory],
    basis: "DELIVERED_MESSAGE", baseRate: true, updatedAt: "2026-09-11",
  };
}
function normalizeTemplate(template) {
  const components = safeComponents(template);
  const variables = templateVariables(template);
  const defaults = Object.fromEntries(variables.map((variable) => [variable.key, variable.example]));
  const header = components.find((component) => component.type === "HEADER");
  const body = components.find((component) => component.type === "BODY");
  const footer = components.find((component) => component.type === "FOOTER");
  const unsupportedHeader = header && ["IMAGE", "VIDEO", "DOCUMENT", "LOCATION"].includes(header.format);
  return {
    id: template.id ?? null,
    name: template.name ?? null,
    language: template.language ?? null,
    category: template.category ?? null,
    status: template.status ?? null,
    pricing: templatePricing(template.category),
    components,
    supported: !unsupportedHeader,
    unsupportedReason: unsupportedHeader ? `O template usa cabeçalho ${String(header.format).toLowerCase()}, ainda não disponível neste envio.` : null,
    preview: [renderText(header?.text, variables, defaults), renderText(body?.text, variables, defaults), footer?.text]
      .filter(Boolean).join("\n\n"),
    previewTemplate: [header?.text, body?.text, footer?.text].filter(Boolean).join("\n\n"),
    variables,
  };
}

async function listApprovedTemplates(channel) {
  const templates = await channel.listMessageTemplates();
  const rows = Array.isArray(templates) ? templates : [];
  return rows
    .map(normalizeTemplate)
    .sort((left, right) => String(left.name).localeCompare(String(right.name), "pt-BR"));
}

async function listTemplates(channel) {
  const templates = typeof channel.listAllMessageTemplates === "function"
    ? await channel.listAllMessageTemplates()
    : await channel.listMessageTemplates();
  const access = typeof channel.inspectAccessTokenScopes === "function"
    ? await channel.inspectAccessTokenScopes()
    : { scopes: null, valid: null, error: null };
  const rows = (Array.isArray(templates) ? templates : []).map(normalizeTemplate).sort((left, right) => {
    const priority = { APPROVED: 0, PENDING: 1, REJECTED: 2 };
    return (priority[left.status] ?? 9) - (priority[right.status] ?? 9)
      || String(left.name).localeCompare(String(right.name), "pt-BR");
  });
  const byStatus = rows.reduce((counts, template) => {
    counts[template.status || "UNKNOWN"] = (counts[template.status || "UNKNOWN"] || 0) + 1;
    return counts;
  }, {});
  return {
    templates: rows,
    sync: {
      syncedAt: new Date().toISOString(), total: rows.length, byStatus,
      wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID?.trim() || null,
      tokenSource: "WHATSAPP_TOKEN", scopes: access.scopes, tokenValid: access.valid,
      scopeCheckError: access.error,
    },
  };
}
function templateComponents(template, values) {
  const variables = templateVariables(template);
  const components = [];
  for (const type of ["HEADER", "BODY"]) {
    const selected = variables.filter((variable) => variable.component === type);
    if (!selected.length) continue;
    components.push({
      type: type.toLowerCase(),
      parameters: selected.map((variable) => ({
        type: "text",
        text: String(values[variable.key] || "").trim(),
        ...(!/^\d+$/.test(variable.placeholder) ? { parameter_name: variable.placeholder } : {}),
      })),
    });
  }
  for (const variable of variables.filter((item) => item.component === "BUTTON")) {
    components.push({
      type: "button", sub_type: "url", index: variable.placeholder,
      parameters: [{ type: "text", text: String(values[variable.key] || "").trim() }],
    });
  }
  return components;
}

async function sendApprovedTemplate({ conversationId, name, language, values = {}, sentByUserId, channel, requestedAccountId }) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { contact: true } });
  if (!conversation) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
  await require("./whatsapp-inbox-service").applySender(conversation, sentByUserId, prisma, requestedAccountId);
  const providerChannel = conversation.channelAccountId ? (await channelMessageService.adapterFor("META", conversation.channelAccountId)).channel : channel;
  const templates = await providerChannel.listMessageTemplates();
  const template = templates.find((item) => item.name === name && item.language === language && item.status === "APPROVED");
  if (!template) throw Object.assign(new Error("Template aprovado não encontrado na Meta."), { statusCode: 404 });
  const normalized = normalizeTemplate(template);
  if (!normalized.supported) throw Object.assign(new Error(normalized.unsupportedReason), { statusCode: 400 });
  for (const variable of normalized.variables) {
    if (!String(values[variable.key] || "").trim()) {
      throw Object.assign(new Error(`Preencha a variável ${variable.label}.`), { statusCode: 400 });
    }
  }
  const components = templateComponents(template, values);
  const result = await providerChannel.sendTemplate(conversation.contact.phone, { name, language, components });
  const occurredAt = new Date();
  const preview = [
    ...(template.components || []).filter((item) => ["HEADER", "BODY"].includes(item.type)).map((item) => renderText(item.text, normalized.variables, values)),
    (template.components || []).find((item) => item.type === "FOOTER")?.text,
  ].filter(Boolean).join("\n\n");
  const message = await prisma.message.create({ data: {
    conversationId, externalId: conversation.channelAccountId && result.externalId ? `${conversation.channelAccountId}:${result.externalId}` : result.externalId, channel: conversation.channel, channelAccountId: conversation.channelAccountId || null,
    direction: "ENVIADA", status: "ENVIADA", type: "template", text: preview,
    occurredAt, sentByUserId: sentByUserId || null,
    rawPayload: { message: result.data, template: { name, language, category: template.category, values } },
  } });
  await updateConversationAfterSending({ conversationId, sentByUserId, occurredAt });
  return { message, providerData: result.data };
}

module.exports = {
  CUSTOMER_SERVICE_WINDOW_MS,
  assertFreeFormAllowed,
  customerServiceWindowFrom,
  getCustomerServiceWindow,
  listApprovedTemplates,
  listTemplates,
  normalizeTemplate,
  sendApprovedTemplate,
  templateComponents,
  templatePricing,
  templatesConfigured,
};
