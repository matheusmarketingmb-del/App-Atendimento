// Provider OpenAI — mesmo contrato/abstração de AnthropicProvider/
// GeminiProvider (AIProvider), reaproveitando o MESMO prompt de
// classificação (buildIntentPrompt) e os MESMOS utilitários de validação de
// resposta (classification-utils.js). Nenhuma lógica de "entender a
// intenção" duplicada, só o transporte HTTP muda. Nunca obrigatório: se não
// houver credencial (env ou painel), get-ai-provider.js nem instancia esta
// classe.
const axios = require("axios");
const { AIProvider } = require("./ai-provider");
const { extractEntities: extractEntitiesLocally } = require("../bot-entity-extractor");
const { parseJsonResponse, validateClassification } = require("./classification-utils");
const { buildIntentPrompt, buildRephrasePrompt } = require("./anthropic-provider");

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 8000;
const API_URL = "https://api.openai.com/v1/chat/completions";

// Item 4 (tratamento de rate limit/quota/autenticação/timeout): a chave só
// viaja no header Authorization, nunca na URL/query string, então nunca
// aparece em logs de acesso/URL do axios nem na mensagem de erro abaixo.
function mapOpenAiError(error) {
  if (error.code === "ECONNABORTED" || /timeout/i.test(error.message || "")) {
    return Object.assign(new Error("Tempo limite excedido ao chamar a OpenAI."), { code: "TIMEOUT" });
  }
  const status = error.response?.status;
  const apiType = error.response?.data?.error?.type;
  const apiCode = error.response?.data?.error?.code;
  if (status === 401) {
    return Object.assign(new Error("Credencial da OpenAI inválida ou sem permissão."), { code: "AUTH_ERROR" });
  }
  if (status === 429) {
    if (apiType === "insufficient_quota" || apiCode === "insufficient_quota") {
      return Object.assign(new Error("Cota da OpenAI excedida."), { code: "QUOTA_EXCEEDED" });
    }
    return Object.assign(new Error("Limite de requisições da OpenAI atingido (rate limit)."), { code: "RATE_LIMIT" });
  }
  if (status >= 400 && status < 500) {
    return Object.assign(new Error(error.response?.data?.error?.message || "Requisição inválida à OpenAI."), { code: "PROVIDER_REQUEST_FAILED" });
  }
  return Object.assign(new Error("Falha ao consultar a OpenAI."), { code: "PROVIDER_REQUEST_FAILED" });
}

class OpenAiProvider extends AIProvider {
  constructor({
    apiKey = process.env.OPENAI_API_KEY,
    model = process.env.OPENAI_MODEL || DEFAULT_MODEL,
    timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  } = {}) {
    super();
    if (!apiKey) throw new Error("OPENAI_API_KEY não configurada.");
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 30000
      ? timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  async classifyIntent({ bot, message, context }) {
    const prompt = buildIntentPrompt({ bot, message, context });
    let response;
    try {
      response = await axios.post(API_URL, {
        model: this.model,
        max_tokens: 400,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }, {
        timeout: this.timeoutMs,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
      });
    } catch (error) {
      throw mapOpenAiError(error);
    }
    const text = response.data?.choices?.[0]?.message?.content;
    const parsed = parseJsonResponse(text);
    const classification = validateClassification(parsed, bot);
    const rawUsage = response.data?.usage;
    const usage = rawUsage
      ? { inputTokens: rawUsage.prompt_tokens ?? null, outputTokens: rawUsage.completion_tokens ?? null }
      : null;
    return { ...classification, usage };
  }

  async extractEntities({ message }) {
    return extractEntitiesLocally(message);
  }

  async generateResponse({ systemPrompt, groundingText, userMessage, bot, intent }) {
    if (!systemPrompt || !groundingText) return intent?.responseMessage || bot?.fallbackMessage || groundingText || "";
    const prompt = buildRephrasePrompt({ groundingText, userMessage });
    let response;
    try {
      response = await axios.post(API_URL, {
        model: this.model,
        max_tokens: 500,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
      }, {
        timeout: this.timeoutMs,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
      });
    } catch (error) {
      throw mapOpenAiError(error);
    }
    const text = response.data?.choices?.[0]?.message?.content || "";
    const rawUsage = response.data?.usage;
    const usage = rawUsage
      ? { inputTokens: rawUsage.prompt_tokens ?? null, outputTokens: rawUsage.completion_tokens ?? null }
      : null;
    return { text: text.trim(), usage };
  }
}

module.exports = { OpenAiProvider, DEFAULT_MODEL, mapOpenAiError };
