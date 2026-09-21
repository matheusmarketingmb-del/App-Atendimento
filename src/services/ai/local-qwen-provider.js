// Provider da IA LOCAL (Qwen rodando via Ollama fora da VPS, tipicamente no
// PC do operador, alcançado por Tailscale). Reaproveita o MESMO contrato
// AIProvider e os MESMOS prompts de classificação/reescrita dos providers
// externos (buildIntentPrompt/buildRephrasePrompt) — só o transporte HTTP e
// o endereço mudam. Além do contrato AIProvider, expõe
// `generateStructuredReply`, usado só pelo modo PRIMARY (bot-ai-shadow-
// service.js): a IA local decide/redige o turno inteiro em JSON, não só
// reescreve um texto já pronto.
//
// Nunca chamado com host fixo: `baseUrl`/`model`/`timeoutMs` vêm sempre de
// LocalAiProviderSettings (ver local-ai-settings-service.js), resolvidos a
// cada chamada (get-ai-provider.js nunca cacheia a instância) — em
// desenvolvimento isso costuma ser http://127.0.0.1:11434 (Ollama local); em
// produção, o endereço privado Tailscale do PC.
const axios = require("axios");
const { AIProvider } = require("./ai-provider");
const { extractEntities: extractEntitiesLocally } = require("../bot-entity-extractor");
const { parseJsonResponse, validateClassification } = require("./classification-utils");
const { buildIntentPrompt, buildRephrasePrompt } = require("./anthropic-provider");
const { withQueue } = require("../local-ai-queue");
const { recordInferenceOutcome } = require("../local-ai-status-service");

const DEFAULT_TIMEOUT_MS = 45000;

// qwen3 é um modelo "thinking": sem think:false, ele gera um bloco de
// raciocínio antes da resposta, multiplicando a latência sem melhorar o
// resultado para este caso de uso (classificação/JSON estruturado curto).
// keep_alive mantém o modelo carregado na GPU entre mensagens — sem isso,
// cada chamada pagaria ~20-30s de carregamento do modelo (9+ GB).
function buildChatBody({ model, messages, format, numCtx }) {
  return {
    model,
    messages,
    stream: false,
    think: false,
    keep_alive: "30m",
    options: { num_ctx: numCtx || 6144 },
    ...(format ? { format } : {}),
  };
}

function mapOllamaError(error) {
  if (error.code === "ECONNABORTED" || /timeout/i.test(error.message || "")) {
    return Object.assign(new Error("Tempo limite excedido ao consultar a IA local."), { code: "TIMEOUT" });
  }
  if (error.code === "QUEUE_FULL" || error.code === "QUEUE_TIMEOUT") return error;
  if (error.response?.status === 404) {
    return Object.assign(new Error("Modelo não encontrado na IA local (confira `ollama list`)."), { code: "MODEL_NOT_FOUND" });
  }
  if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND" || error.code === "EHOSTUNREACH") {
    return Object.assign(new Error("IA local inacessível (endereço/rede)."), { code: "PROVIDER_UNREACHABLE" });
  }
  return Object.assign(new Error("Falha ao consultar a IA local."), { code: "PROVIDER_REQUEST_FAILED" });
}

class LocalQwenProvider extends AIProvider {
  constructor({ baseUrl, model, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    super();
    if (!baseUrl) throw new Error("Endereço da IA local (baseUrl) não configurado.");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model || "qwen3:14b";
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 180000
      ? timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  async _chat({ messages, format, numCtx }) {
    const startedAt = Date.now();
    try {
      const response = await withQueue(() => axios.post(`${this.baseUrl}/api/chat`, buildChatBody({
        model: this.model, messages, format, numCtx,
      }), { timeout: this.timeoutMs }));
      const latencyMs = Date.now() - startedAt;
      recordInferenceOutcome("OK");
      const text = response.data?.message?.content || "";
      const usage = {
        inputTokens: response.data?.prompt_eval_count ?? null,
        outputTokens: response.data?.eval_count ?? null,
      };
      return { text, usage, latencyMs };
    } catch (error) {
      const mapped = mapOllamaError(error);
      recordInferenceOutcome(mapped.code === "TIMEOUT" ? "TIMEOUT" : "ERROR");
      throw mapped;
    }
  }

  async classifyIntent({ bot, message, context }) {
    const prompt = buildIntentPrompt({ bot, message, context });
    const { text, usage } = await this._chat({ messages: [{ role: "user", content: prompt }] });
    const parsed = parseJsonResponse(text);
    const classification = validateClassification(parsed, bot);
    return { ...classification, usage };
  }

  async extractEntities({ message }) {
    return extractEntitiesLocally(message);
  }

  async generateResponse({ systemPrompt, groundingText, userMessage, bot, intent }) {
    if (!systemPrompt || !groundingText) return intent?.responseMessage || bot?.fallbackMessage || groundingText || "";
    const prompt = buildRephrasePrompt({ groundingText, userMessage });
    const { text, usage } = await this._chat({
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }],
    });
    return { text: text.trim(), usage };
  }

  // Modo PRIMARY (bot-ai-shadow-service.js): a IA decide o turno inteiro.
  // `jsonSchema` é a gramática JSON (Ollama `format`) que restringe o
  // decoder — garante JSON sintaticamente válido; a validação de
  // conteúdo (enums, campos obrigatórios) continua sendo feita por quem
  // chama (bot-ai-schema-service.js), nunca aqui.
  async generateStructuredReply({ systemPrompt, userPrompt, jsonSchema, numCtx }) {
    const { text, usage, latencyMs } = await this._chat({
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      format: jsonSchema,
      numCtx,
    });
    return { raw: text, parsed: parseJsonResponse(text), usage, latencyMs };
  }
}

module.exports = { LocalQwenProvider, mapOllamaError };
