// Extração determinística de entidades a partir de texto livre.
// Serve como base sempre disponível (independe de provider de IA) e como
// validação de qualquer entidade sugerida por um provider externo.

const patterns = {
  email: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  cpf: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/,
  cnpj: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/,
  trackingCode: /\b[A-Z]{2}\d{9}[A-Z]{2}\b/i,
  orderNumber: /(?:pedido|order|compra)\s*n?[ºo°.:#]*\s*(\d{4,10})\b|#(\d{4,10})\b/i,
  serialNumber: /\b(?:s\/?n|serial)\s*[:.]?\s*([a-z0-9]{6,20})\b/i,
};

function extractEntities(message) {
  const text = String(message || "");
  const entities = {};

  const email = text.match(patterns.email);
  if (email) entities.email = email[0].toLowerCase();

  const cnpj = text.match(patterns.cnpj);
  if (cnpj) entities.cnpj = cnpj[0];
  else {
    const cpf = text.match(patterns.cpf);
    if (cpf) entities.cpf = cpf[0];
  }

  const tracking = text.match(patterns.trackingCode);
  if (tracking) entities.trackingCode = tracking[0].toUpperCase();

  const order = text.match(patterns.orderNumber);
  if (order) entities.orderNumber = order[1] || order[2];

  const serial = text.match(patterns.serialNumber);
  if (serial) entities.serialNumber = serial[1];

  return entities;
}

const allowedEntityKeys = new Set([
  "orderNumber", "cpf", "cnpj", "serialNumber", "email", "productName", "trackingCode",
]);

// Mantém apenas chaves conhecidas e valores string não vazios, descartando
// qualquer coisa inventada por um provider externo.
function sanitizeEntities(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return {};
  const sanitized = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (!allowedEntityKeys.has(key)) continue;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 200) continue;
    sanitized[key] = trimmed;
  }
  return sanitized;
}

function mergeEntities(...sources) {
  const merged = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(sanitizeEntities(source))) {
      if (!merged[key]) merged[key] = value;
    }
  }
  return merged;
}

module.exports = { allowedEntityKeys, extractEntities, mergeEntities, patterns, sanitizeEntities };
