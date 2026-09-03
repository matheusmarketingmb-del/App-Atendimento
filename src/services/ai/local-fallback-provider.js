// Provider sem dependência externa: usa correspondência literal (como o
// simulador original) reforçada por similaridade tolerante a erros de
// digitação e variação de palavras. É o que mantém o sistema funcionando
// quando nenhum provider de IA está configurado (ver AnthropicProvider).
const { AIProvider } = require("./ai-provider");
const { normalizeText } = require("../bot-simulator-service");
const { extractEntities } = require("../bot-entity-extractor");

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

function tokenOverlapRatio(messageTokens, exampleTokens) {
  if (!exampleTokens.length) return 0;
  const messageSet = new Set(messageTokens);
  const matched = exampleTokens.filter((token) => messageSet.has(token)).length;
  return matched / exampleTokens.length;
}

function similarity(normalizedMessage, normalizedExample) {
  if (!normalizedExample) return 0;
  if (normalizedMessage === normalizedExample) return 1;
  if (normalizedMessage.includes(normalizedExample)) return 0.95;

  const messageTokens = normalizedMessage.split(" ").filter(Boolean);
  const exampleTokens = normalizedExample.split(" ").filter(Boolean);
  const overlap = tokenOverlapRatio(messageTokens, exampleTokens);

  const maxLength = Math.max(normalizedMessage.length, normalizedExample.length) || 1;
  const distance = levenshtein(normalizedMessage, normalizedExample);
  const lexicalScore = Math.max(0, 1 - distance / maxLength);

  return Math.max(overlap * 0.85, lexicalScore * 0.7);
}

class LocalFallbackProvider extends AIProvider {
  async classifyIntent({ bot, message }) {
    const normalizedMessage = normalizeText(message);
    if (!normalizedMessage) return null;

    let best = null;
    for (const intent of bot.intents || []) {
      if (!intent.active) continue;
      for (const example of intent.examples || []) {
        const normalizedExample = normalizeText(example.text);
        const score = similarity(normalizedMessage, normalizedExample);
        if (!best || score > best.score) best = { intent, example, score };
      }
    }
    if (!best || best.score < 0.4) return null;
    return {
      intentId: best.intent.id,
      confidence: Math.min(0.97, best.score),
      entities: extractEntities(message),
      matchedExample: best.example.text,
    };
  }

  async extractEntities({ message }) {
    return extractEntities(message);
  }

  // Provider LOCAL nunca reescreve estilo (não tem LLM por trás) — mas
  // getPrimaryProvider() só devolve LOCAL_FALLBACK quando não há credencial
  // externa configurada, e bot-personality-service.js já trata
  // name === "LOCAL_FALLBACK" como "não aplicável" antes de sequer chamar
  // isto. Mantido aqui só por completude do contrato AIProvider.
  async generateResponse({ groundingText, bot, intent }) {
    return groundingText || intent?.responseMessage || bot?.fallbackMessage || "";
  }
}

module.exports = { LocalFallbackProvider, similarity };
