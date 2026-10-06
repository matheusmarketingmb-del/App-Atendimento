const prisma = require("../database/prisma");
const { updateConversationAfterSending } = require("./message-service");

const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const PLACEHOLDER = /{{\s*([^{}]+?)\s*}}/g;

// Com `account`: o número tem WABA configurada? Sem conta: .env (original).
function templatesConfigured(account = null) {
  if (account) return Boolean(require("./whatsapp-account-service").wabaIdOf(account));
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

async function getCustomerServiceWindow(conversationId, now = new Date()) {
  const latest = await prisma.message.findFirst({
    where: {
      conversationId,
      direction: "RECEBIDA",
      type: { not: "reaction" },
      externalId: { startsWith: "wamid." },
    },
    orderBy: { occurredAt: "desc" },
    select: { occurredAt: true },
  });
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { channelAccount: true } });
  return customerServiceWindowFrom(latest?.occurredAt, now, templatesConfigured(conversation?.channelAccount || null));
}

async function assertFreeFormAllowed(conversationId) {
  const window = await getCustomerServiceWindow(conversationId);
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
    components,
    supported: !unsupportedHeader,
    unsupportedReason: unsupportedHeader ? `O template usa cabeçalho ${String(header.format).toLowerCase()}, ainda não disponível neste envio.` : null,
    preview: [renderText(header?.text, variables, defaults), renderText(body?.text, variables, defaults), footer?.text]
      .filter(Boolean).join("\n\n"),
    previewTemplate: [header?.text, body?.text, footer?.text].filter(Boolean).join("\n\n"),
    variables,
  };
}

// Multiempresa: templates pertencem à WABA do número (`account`) — nunca
// mistura templates Mibro e Sincrofit. Sem conta: número original (.env).
async function listApprovedTemplates(channel, account = null) {
  const templates = await require("./whatsapp-account-service").senderFor(channel, account).listMessageTemplates();
  const rows = Array.isArray(templates) ? templates : [];
  return rows
    .map(normalizeTemplate)
    .sort((left, right) => String(left.name).localeCompare(String(right.name), "pt-BR"));
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

async function sendApprovedTemplate({ conversationId, name, language, values = {}, sentByUserId, channel }) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { contact: true, channelAccount: true } });
  if (!conversation) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
  // Sempre pelo número (e WABA) da própria conversa.
  const accounts = require("./whatsapp-account-service");
  const sender = accounts.senderFor(channel, await accounts.accountForConversation(conversation));
  const templates = await sender.listMessageTemplates();
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
  const result = await sender.sendTemplate(conversation.contact.phone, { name, language, components });
  const occurredAt = new Date();
  const preview = [
    ...(template.components || []).filter((item) => ["HEADER", "BODY"].includes(item.type)).map((item) => renderText(item.text, normalized.variables, values)),
    (template.components || []).find((item) => item.type === "FOOTER")?.text,
  ].filter(Boolean).join("\n\n");
  const message = await prisma.message.create({ data: {
    conversationId, externalId: result.externalId, channel: conversation.channel,
    channelAccountId: conversation.channelAccountId || null,
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
  normalizeTemplate,
  sendApprovedTemplate,
  templateComponents,
  templatesConfigured,
};
