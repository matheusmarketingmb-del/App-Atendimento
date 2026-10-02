// Utilitários de classificação compartilhados por QUALQUER provider de IA
// externa (Anthropic, Gemini, futuros) — nunca duplicados por provider.
// Contrato comum: o modelo responde um JSON {intentId, confidence, entities}
// e este módulo é o único lugar que decide se esse JSON é confiável.

function parseJsonResponse(text) {
  if (typeof text !== "string") return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_error) {
    return null;
  }
}

function validateClassification(parsed, bot) {
  const { sanitizeEntities } = require("../bot-entity-extractor");
  if (!parsed || typeof parsed !== "object") return { intentId: null, confidence: 0, entities: {} };
  const intents = bot.intents || [];
  const validIntentIds = new Set(intents.map((intent) => intent.id));
  const candidate = typeof parsed.intentId === "string" ? parsed.intentId.trim() : "";
  let intentId = validIntentIds.has(candidate) ? candidate : null;
  if (!intentId && candidate) {
    const normalizedCandidate = candidate.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const matches = intents.filter((intent) => String(intent.name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() === normalizedCandidate);
    if (matches.length === 1) intentId = matches[0].id;
  }
  const rawConfidence = Number(parsed.confidence);
  const confidence = Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : 0;
  if (!intentId) return { intentId: null, confidence: 0, entities: sanitizeEntities(parsed.entities) };
  return { intentId, confidence, entities: sanitizeEntities(parsed.entities) };
}

module.exports = { parseJsonResponse, validateClassification };
