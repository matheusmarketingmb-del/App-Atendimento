// Sanitização obrigatória antes de qualquer texto de conversa real virar
// sugestão de aprendizado. Remove dados pessoais/identificadores específicos
// (CPF, CNPJ, e-mail, telefone, número de pedido, série, códigos de
// rastreio, sequências longas de dígitos que podem ser token/senha/chave).
// Reaproveita os mesmos padrões do extrator de entidades (bot-entity-extractor.js)
// em vez de duplicar regex — a diferença é que aqui os valores são REMOVIDOS,
// não extraídos.
const { patterns } = require("./bot-entity-extractor");
const { LEARNING_TEXT_MAX_LENGTH } = require("./bot-constants");

function asGlobal(pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

const personalDataPatterns = [
  ...Object.values(patterns).map(asGlobal),
  /\b\d{2}\s?9?\d{4}[-\s]?\d{4}\b/g, // telefone BR com ou sem 9º dígito
  /\b\d{6,}\b/g, // sequência longa de dígitos (token/senha/chave/id específico)
];

// Remove qualquer trecho reconhecido como dado pessoal e normaliza espaços.
function redactPersonalData(text) {
  let sanitized = String(text || "");
  for (const pattern of personalDataPatterns) {
    sanitized = sanitized.replace(pattern, " ");
  }
  return sanitized.replace(/\s{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
}

// Sanitiza e trunca para uso como exemplo/sugestão de aprendizado. Retorna
// null quando não sobra conteúdo útil (mensagem era só dado pessoal).
function sanitizeForLearning(text, { maxLength = LEARNING_TEXT_MAX_LENGTH } = {}) {
  const sanitized = redactPersonalData(text).slice(0, maxLength).trim();
  if (sanitized.length < 3) return null;
  return sanitized;
}

// Respostas humanas podem conter o nome do atendente ou do cliente. Esses
// nomes não devem virar personalidade do Bot. A estrutura da resposta é
// preservada e a apresentação passa a usar o nome configurado do próprio Bot.
function sanitizeAgentResponse(text, { maxLength = LEARNING_TEXT_MAX_LENGTH } = {}) {
  let sanitized = redactPersonalData(text);

  // "Olá! Eu sou a Thalia, assistente..." -> "Olá! Eu sou a {{botName}}, assistente..."
  sanitized = sanitized.replace(
    /(\b(?:[Ee]u\s+)?[Ss]ou\s+)(?:a|o)?\s*\p{Lu}[\p{L}'’-]{1,30}(?=\s*[,!.-]|\s+(?:da|do|de)\b)/gu,
    "$1a {{botName}}",
  );

  // "Bom dia, Vinicius! Tudo bem?" -> "Bom dia! Tudo bem?"
  sanitized = sanitized.replace(
    /^([Bb]om\s+dia|[Bb]oa\s+tarde|[Bb]oa\s+noite|[Oo]lá|[Oo]i)[,!]?\s+\p{Lu}[\p{L}'’-]{1,30}\s*([!,.?])/u,
    "$1$2",
  );

  // Remove vocativos fora da saudação: "Pode sim, Vinicius!" e "Vinicius, respondendo...".
  sanitized = sanitized.replace(/,\s*\p{Lu}[\p{L}'’-]{1,30}(?=\s*[!,])/gu, "");
  sanitized = sanitized.replace(/^\p{Lu}[\p{L}'’-]{1,30},\s*/u, "");

  sanitized = sanitized.replace(/\s{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
  sanitized = sanitized.slice(0, maxLength).trim();
  return sanitized.length >= 3 ? sanitized : null;
}

module.exports = { redactPersonalData, sanitizeAgentResponse, sanitizeForLearning };
