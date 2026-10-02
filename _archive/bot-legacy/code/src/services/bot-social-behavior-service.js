// Camada conversacional: reconhece saudação, agradecimento, despedida,
// small talk, confirmação, negação e pedido de humano SEM criar uma
// intenção de negócio para cada frase. Roda ao lado da intenção
// (bot-interpreter-service.js já chama isto), nunca no lugar dela.
const { normalizeText } = require("./bot-simulator-service");
const {
  CONFIRMATION_PATTERN, GOODBYE_PATTERNS, GREETING_PHRASES, HUMAN_HANDOFF_PATTERNS,
  NEGATION_PATTERN, SMALL_TALK_PATTERNS, THANKS_PATTERNS,
} = require("./bot-constants");

function matchesAny(patterns, normalized) {
  return patterns.some((pattern) => pattern.test(normalized));
}

function findGreeting(normalized) {
  return GREETING_PHRASES.find(([phrase]) => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "u").test(normalized);
  }) || null;
}

// Retorna { socialBehavior, greetingReply } — greetingReply só é preenchido
// para GREETING, com o cumprimento equivalente ("boa tarde" -> "Boa tarde!").
function detectSocialBehavior(message) {
  const normalized = normalizeText(message);
  if (!normalized) return { socialBehavior: null, greetingReply: null };

  if (matchesAny(HUMAN_HANDOFF_PATTERNS, normalized)) {
    return { socialBehavior: "HUMAN_REQUEST", greetingReply: null };
  }
  if (CONFIRMATION_PATTERN.test(normalized)) return { socialBehavior: "CONFIRMATION", greetingReply: null };
  if (NEGATION_PATTERN.test(normalized)) return { socialBehavior: "NEGATION", greetingReply: null };
  if (matchesAny(SMALL_TALK_PATTERNS, normalized)) return { socialBehavior: "SMALL_TALK", greetingReply: null };

  const greeting = findGreeting(normalized);
  if (greeting) return { socialBehavior: "GREETING", greetingReply: `${greeting[1]}!` };

  if (matchesAny(THANKS_PATTERNS, normalized)) return { socialBehavior: "THANKS", greetingReply: null };
  if (matchesAny(GOODBYE_PATTERNS, normalized)) return { socialBehavior: "GOODBYE", greetingReply: null };

  return { socialBehavior: null, greetingReply: null };
}

module.exports = { detectSocialBehavior };
