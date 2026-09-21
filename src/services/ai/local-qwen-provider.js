// Provider da IA LOCAL — fala com o RAG Server local (rag_server.py, em
// C:\App Whats\rag), NUNCA diretamente com o Ollama. O RAG Server já faz
// busca na Knowledge (Info_Bots/ChromaDB/nomic-embed-text) + geração
// (qwen3:14b) por conta própria; o app só envia a mensagem do cliente e
// recebe de volta a resposta pronta — nenhuma lógica de prompt/Knowledge/
// JSON é duplicada aqui (ver bot-ai-shadow-service.js).
//
// Nunca chamado com host fixo: `baseUrl`/`timeoutMs` vêm sempre de
// LocalAiProviderSettings (ver local-ai-settings-service.js), resolvidos a
// cada chamada (get-ai-provider.js nunca cacheia a instância). Em
// desenvolvimento isso é http://127.0.0.1:8992 (RAG Server local); `model`
// é só informativo (o RAG Server decide sozinho qual modelo usar).
const axios = require("axios");
const { AIProvider } = require("./ai-provider");
const { withQueue } = require("../local-ai-queue");
const { recordInferenceOutcome } = require("../local-ai-status-service");

const DEFAULT_TIMEOUT_MS = 45000;

function mapRagError(error) {
  if (error.code === "ECONNABORTED" || /timeout/i.test(error.message || "")) {
    return Object.assign(new Error("Tempo limite excedido ao consultar o RAG Server."), { code: "TIMEOUT" });
  }
  if (error.code === "QUEUE_FULL" || error.code === "QUEUE_TIMEOUT") return error;
  // O RAG Server (rag_server.py) já devolve {error, message} tipados quando
  // ELE detecta Ollama offline/timeout/modelo ausente/Knowledge indisponível
  // — propaga esse código específico em vez de um genérico, para o log do
  // modo shadow mostrar a causa real (ver rag_server.py).
  const ragErrorCode = error.response?.data?.error;
  if (ragErrorCode) {
    return Object.assign(new Error(error.response.data.message || ragErrorCode), { code: `RAG_${ragErrorCode}` });
  }
  if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND" || error.code === "EHOSTUNREACH") {
    return Object.assign(new Error("RAG Server inacessível (endereço/rede)."), { code: "PROVIDER_UNREACHABLE" });
  }
  return Object.assign(new Error("Falha ao consultar o RAG Server."), { code: "PROVIDER_REQUEST_FAILED" });
}

class LocalQwenProvider extends AIProvider {
  constructor({ baseUrl, model, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    super();
    if (!baseUrl) throw new Error("Endereço do RAG Server (baseUrl) não configurado.");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model || "qwen3:14b";
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 180000
      ? timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  // Único método usado hoje pelo motor (bot-ai-shadow-service.js, modo
  // PRIMARY): POST /answer no RAG Server, que devolve a resposta já pronta
  // (busca + geração + regras de "não inventar" já aplicadas do lado dele).
  // classifyIntent/extractEntities/generateResponse do contrato AIProvider
  // continuam herdados da base (não implementados) — nada aqui os chama.
  //
  // `history` (opcional): últimas mensagens da conversa, já recortadas pelo
  // chamador (bot-ai-shadow-service.js reaproveita getRecentContext/
  // contextMaxMessages — nunca a conversa inteira). O RAG Server usa isso só
  // para resolver referência ("qual modelo?" -> "GS Pro 2") e não repetir
  // pergunta já respondida; nunca decide envio, nunca é a fonte de verdade
  // do estado da conversa (isso continua sendo ConversationBotState).
  async askRag({ message, history = [] }) {
    const startedAt = Date.now();
    let response;

    try {
      response = await withQueue(() => axios.post(
        `${this.baseUrl}/answer`,
        { message, history },
        { timeout: this.timeoutMs },
      ));
      recordInferenceOutcome("OK");
    } catch (error) {
      const mapped = mapRagError(error);
      recordInferenceOutcome(mapped.code === "TIMEOUT" ? "TIMEOUT" : "ERROR");
      throw mapped;
    }

    const data = response.data || {};
    const latencyMs = Number.isFinite(data.latencyMs) ? data.latencyMs : (Date.now() - startedAt);
    const VALID_ACTIONS = new Set(["RESPOND", "ASK", "CLARIFY", "HANDOFF", "WAIT", "RESOLVE"]);
    const VALID_CONFIDENCE = new Set(["HIGH", "MEDIUM", "LOW"]);

    return {
      answer: typeof data.answer === "string" ? data.answer.trim() : "",
      // Sempre um valor seguro mesmo se o RAG Server devolver algo
      // inesperado (versão desalinhada, resposta malformada) — nunca deixa
      // `action`/`confidence` chegarem crus/inválidos no resto do motor.
      action: VALID_ACTIONS.has(data.action) ? data.action : "HANDOFF",
      confidence: VALID_CONFIDENCE.has(data.confidence) ? data.confidence : "LOW",
      needsHuman: typeof data.needsHuman === "boolean" ? data.needsHuman : true,
      reason: typeof data.reason === "string" && data.reason ? data.reason : "unspecified",
      product: data.product || null,
      intent: data.intent || null,
      sources: Number.isFinite(data.sources) ? data.sources : null,
      // Detalhe dos chunks (arquivo/heading/produto/topic/origem/distância)
      // — só para inspeção (simulador); nunca usado em decisão do motor.
      sourceDetails: Array.isArray(data.sourceDetails) ? data.sourceDetails : [],
      searchMs: Number.isFinite(data.searchMs) ? data.searchMs : null,
      generationMs: Number.isFinite(data.generationMs) ? data.generationMs : null,
      latencyMs,
    };
  }
}

module.exports = { LocalQwenProvider, mapRagError };
