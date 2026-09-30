// Regras puras do envio pelo painel "Nova conversa" (individual e em massa):
// normalização/validação de telefone, lista colada, deduplicação (com e sem
// o 9º dígito), mapeamento automático de variáveis, fallback de nome,
// validação por destinatário e estimativa de custo. Sem banco, sem Meta —
// o serviço (outbound-bulk-service.js) e os testes chamam estas funções.

// Chaves usadas para decidir se dois telefones são o mesmo contato no lote —
// mesma regra de whatsappIdVariants (conversation-service.js): celular BR
// com e sem o 9º dígito é a mesma pessoa.
function phoneVariants(digits) {
  const variants = [digits];
  const withNine = digits.match(/^55(\d{2})9([6-9]\d{7})$/);
  if (withNine) variants.push(`55${withNine[1]}${withNine[2]}`);
  const withoutNine = digits.match(/^55(\d{2})([6-9]\d{7})$/);
  if (withoutNine) variants.push(`55${withoutNine[1]}9${withoutNine[2]}`);
  return variants;
}

function dedupeKey(phone) {
  return phoneVariants(phone).sort()[0];
}

/**
 * Normaliza para E.164 sem "+". Brasil: 10/11 dígitos (DDD + número) ganham
 * 55; "0" de discagem nacional/operadora é removido. Outros países só com
 * "+"/"00" explícito (8–15 dígitos). Nunca inventa DDD.
 * Retorna { phone } ou { error }.
 */
function normalizeRecipientPhone(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { error: "Telefone vazio." };
  const international = /^\s*(\+|00)/.test(raw);
  let digits = raw.replace(/\D/g, "");
  if (international && digits.startsWith("00")) digits = digits.slice(2);
  if (!international) {
    // 0 + operadora (ex.: 0 21 11 99999-9999) ou 0 + DDD (011 99999-9999).
    if (/^0\d{2}\d{2}\d{8,9}$/.test(digits) && digits.length >= 13) digits = digits.slice(3);
    else if (/^0\d{10,11}$/.test(digits)) digits = digits.slice(1);
    if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  }
  if (digits.length < 8 || digits.length > 15) return { error: "Telefone com quantidade de dígitos inválida." };
  if (digits.startsWith("55")) {
    const local = digits.slice(2);
    if (local.length !== 10 && local.length !== 11) return { error: "Telefone do Brasil deve ter DDD + número (10 ou 11 dígitos)." };
    const ddd = Number(local.slice(0, 2));
    if (ddd < 11 || ddd > 99 || local[0] === "0" || local[1] === "0") return { error: "DDD inválido." };
    if (local.length === 11 && local[2] !== "9") return { error: "Celular com 11 dígitos deve começar com 9 após o DDD." };
  } else if (!international) {
    return { error: "Inclua o código do país (+) para números fora do Brasil." };
  }
  return { phone: digits };
}

function formatPhone(phone) {
  const match = String(phone || "").match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return match ? `+55 (${match[1]}) ${match[2]}-${match[3]}` : phone ? `+${phone}` : "";
}

const LETTERS = /[A-Za-zÀ-ÿ]/;

/**
 * Lista colada: um contato por linha. Aceita "telefone", "nome;telefone",
 * "telefone;nome", separador ; , tab ou |. Linhas só com números podem ter
 * vários telefones separados por vírgula/espaço.
 */
function parsePastedList(text, { existingKeys = new Set() } = {}) {
  const valid = [];
  const invalid = [];
  const duplicates = [];
  const seen = new Set(existingKeys);
  const lines = String(text || "").split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let entries;
    if (!LETTERS.test(trimmed) && /[,;\s|]/.test(trimmed) && trimmed.replace(/\D/g, "").length > 15) {
      entries = trimmed.split(/[,;\s|]+/).filter(Boolean).map((phone) => ({ name: "", phone }));
    } else {
      const parts = trimmed.split(/[;\t|,]/).map((part) => part.trim()).filter(Boolean);
      const phonePart = parts.find((part) => !LETTERS.test(part) && part.replace(/\D/g, "").length >= 8) ?? parts[parts.length - 1] ?? "";
      const name = parts.filter((part) => part !== phonePart).join(" ").trim();
      entries = [{ name, phone: phonePart }];
    }
    for (const entry of entries) {
      const result = normalizeRecipientPhone(entry.phone);
      const row = { line: index + 1, raw: trimmed, name: entry.name.slice(0, 160) };
      if (result.error) { invalid.push({ ...row, reason: result.error }); continue; }
      const key = dedupeKey(result.phone);
      if (seen.has(key)) { duplicates.push({ ...row, phone: result.phone }); continue; }
      seen.add(key);
      valid.push({ ...row, phone: result.phone });
    }
  });
  return { valid, invalid, duplicates, summary: { valid: valid.length, invalid: invalid.length, duplicates: duplicates.length } };
}

// ----------------------------------------------------------------- Variáveis

const VARIABLE_SOURCES = Object.freeze({
  CONTACT_NAME: "Nome do contato",
  FIRST_NAME: "Primeiro nome do contato",
  AGENT_NAME: "Seu nome (quem envia)",
  AGENT_FIRST_NAME: "Seu primeiro nome",
  STATIC: "Texto fixo para todos",
  MANUAL: "Preencher por contato",
});

const NAME_SOURCES = new Set(["CONTACT_NAME", "FIRST_NAME"]);

const fold = (value) => String(value || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Sugestão automática de fonte para uma variável do template. */
function suggestVariableSource(variable) {
  const key = fold(variable.placeholder).replace(/[^a-z0-9]+/g, "_");
  if (/^(first_?name|primeiro_?nome)$/.test(key)) return "FIRST_NAME";
  if (/(customer|client|cliente|contact|contato)_?(name|nome)|^(name|nome|nome_cliente)$/.test(key)) return "CONTACT_NAME";
  if (/(agent|atendente|vendedor|seller|consultor|representante)(_?(name|nome))?$|^(nome_)?(atendente|vendedor|consultor)$/.test(key)) return "AGENT_NAME";
  // Posicional ({{1}}) no corpo: só sugere nome quando o exemplo aprovado
  // na Meta parece um nome de pessoa (ex.: "Maria"). Números/códigos nunca.
  if (variable.component === "BODY" && variable.placeholder === "1" && /^[A-ZÀ-Ý][a-zà-ÿ]{1,20}$/.test(String(variable.example || "").trim())) return "FIRST_NAME";
  return null;
}

function defaultMapping(variables) {
  return Object.fromEntries((variables || []).map((variable) => {
    const source = suggestVariableSource(variable);
    return [variable.key, source ? { source, auto: true } : { source: "MANUAL", auto: false }];
  }));
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

/**
 * Valores finais de um destinatário. Nome ausente nunca vira "Olá, !": usa
 * o fallback configurado para a variável ou marca como pendência.
 */
function resolveRecipientValues(variables, mapping, recipient, agent) {
  const values = {};
  const missing = [];
  let nameMissing = false;
  for (const variable of variables || []) {
    const rule = mapping?.[variable.key] || { source: "MANUAL" };
    const override = recipient.values?.[variable.key];
    let value = "";
    if (override !== undefined && String(override).trim()) value = String(override).trim();
    else if (rule.source === "CONTACT_NAME") value = String(recipient.name || "").trim();
    else if (rule.source === "FIRST_NAME") value = firstName(recipient.name);
    else if (rule.source === "AGENT_NAME") value = String(agent?.name || "").trim();
    else if (rule.source === "AGENT_FIRST_NAME") value = firstName(agent?.name);
    else if (rule.source === "STATIC") value = String(rule.value || "").trim();
    if (!value && NAME_SOURCES.has(rule.source)) {
      if (recipient.useNameFallback && String(rule.fallback || "").trim()) value = String(rule.fallback).trim();
      else nameMissing = true;
    } else if (!value) missing.push(variable.key);
    values[variable.key] = value;
  }
  // `missing` = variáveis sem valor que NÃO são de nome (nome ausente é
  // reportado à parte, com as opções editar / sem nome / remover).
  return { values, missing, nameMissing };
}

// ------------------------------------------------------------ Validação

const ISSUE_LABELS = Object.freeze({
  INVALID_PHONE: "Telefone inválido",
  DUPLICATE: "Duplicado no lote",
  OPTED_OUT: "Não deseja receber mensagens (opt-out)",
  TEMPLATE_MISSING: "Sem template",
  TEMPLATE_NOT_APPROVED: "Template não aprovado",
  TEMPLATE_UNSUPPORTED: "Template não suportado neste envio",
  NAME_MISSING: "Nome ausente",
  MISSING_VARIABLE: "Variável obrigatória sem valor",
  SENDER_UNAVAILABLE: "Número remetente indisponível",
  CONTACT_NOT_ALLOWED: "Contato fora do seu acesso",
});

function templateKey(name, language) {
  return `${name}|${language}`;
}

/**
 * Valida o lote inteiro. Um problema bloqueia só aquele destinatário — os
 * demais válidos continuam (erro individual nunca derruba o lote).
 */
function validateRecipients(recipients, { templates, mappings, defaultTemplate, agent, optedOut = new Set(), senderAvailable = true, forbiddenContactIds = new Set() }) {
  const seen = new Set();
  const byKey = new Map((templates || []).map((template) => [templateKey(template.name, template.language), template]));
  return recipients.map((recipient) => {
    const issues = [];
    const normalized = normalizeRecipientPhone(recipient.phone);
    const phone = normalized.phone || null;
    if (!phone) issues.push("INVALID_PHONE");
    if (phone) {
      const key = dedupeKey(phone);
      if (seen.has(key)) issues.push("DUPLICATE");
      seen.add(key);
      if (phoneVariants(phone).some((variant) => optedOut.has(variant))) issues.push("OPTED_OUT");
    }
    if (recipient.contactId && forbiddenContactIds.has(recipient.contactId)) issues.push("CONTACT_NOT_ALLOWED");
    if (!senderAvailable) issues.push("SENDER_UNAVAILABLE");
    const selection = recipient.templateName ? { name: recipient.templateName, language: recipient.templateLanguage } : defaultTemplate;
    let template = null;
    let values = {};
    if (!selection?.name) issues.push("TEMPLATE_MISSING");
    else {
      template = byKey.get(templateKey(selection.name, selection.language)) || null;
      if (!template || (template.status && template.status !== "APPROVED")) issues.push("TEMPLATE_NOT_APPROVED");
      else if (template.supported === false) issues.push("TEMPLATE_UNSUPPORTED");
      else {
        const resolved = resolveRecipientValues(template.variables, mappings?.[templateKey(template.name, template.language)] || defaultMapping(template.variables), recipient, agent);
        values = resolved.values;
        if (resolved.nameMissing) issues.push("NAME_MISSING");
        if (resolved.missing.length) issues.push("MISSING_VARIABLE");
      }
    }
    return {
      key: recipient.key ?? phone ?? recipient.phone,
      contactId: recipient.contactId || null,
      name: String(recipient.name || "").trim(),
      phone,
      rawPhone: recipient.phone,
      template: template ? { name: template.name, language: template.language, category: template.category } : (selection?.name ? { name: selection.name, language: selection.language, category: null } : null),
      values,
      issues,
      ok: issues.length === 0,
    };
  });
}

// ----------------------------------------------------------------- Custo

/**
 * Estimativa por categoria usando a tarifa já exposta em template.pricing
 * (meta-template-service.js). Valor estimado — o real é definido pela Meta.
 */
function estimateCost(validatedRecipients, templates) {
  const pricing = new Map((templates || []).map((template) => [templateKey(template.name, template.language), template.pricing]));
  const byCategory = {};
  let total = 0;
  let unknown = 0;
  for (const recipient of validatedRecipients) {
    if (!recipient.ok || !recipient.template) continue;
    const category = String(recipient.template.category || "OUTRA").toUpperCase();
    const rate = Number(pricing.get(templateKey(recipient.template.name, recipient.template.language))?.rate);
    byCategory[category] ??= { count: 0, cost: 0 };
    byCategory[category].count += 1;
    if (Number.isFinite(rate)) { byCategory[category].cost += rate; total += rate; } else unknown += 1;
  }
  const round = (value) => Math.round(value * 10000) / 10000;
  for (const entry of Object.values(byCategory)) entry.cost = round(entry.cost);
  return { currency: "BRL", total: round(total), byCategory, withoutRate: unknown, disclaimer: "Valor estimado. O valor real é definido pela Meta." };
}

function summarize(validated, templates) {
  const count = (issue) => validated.filter((recipient) => recipient.issues.includes(issue)).length;
  const ready = validated.filter((recipient) => recipient.ok);
  return {
    total: validated.length,
    ready: ready.length,
    blocked: validated.length - ready.length,
    templates: new Set(ready.map((recipient) => templateKey(recipient.template.name, recipient.template.language))).size,
    invalid: count("INVALID_PHONE"),
    duplicates: count("DUPLICATE"),
    optedOut: count("OPTED_OUT"),
    nameMissing: count("NAME_MISSING"),
    missingVariables: count("MISSING_VARIABLE"),
    templateNotApproved: count("TEMPLATE_NOT_APPROVED") + count("TEMPLATE_MISSING") + count("TEMPLATE_UNSUPPORTED"),
    cost: estimateCost(validated, templates),
  };
}

module.exports = {
  ISSUE_LABELS,
  NAME_SOURCES,
  VARIABLE_SOURCES,
  dedupeKey,
  defaultMapping,
  estimateCost,
  formatPhone,
  normalizeRecipientPhone,
  parsePastedList,
  phoneVariants,
  resolveRecipientValues,
  suggestVariableSource,
  summarize,
  templateKey,
  validateRecipients,
};
