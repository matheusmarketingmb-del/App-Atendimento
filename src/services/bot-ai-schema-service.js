// Contrato JSON estruturado da resposta da IA local em modo PRIMARY (item 12
// do plano). `OLLAMA_JSON_SCHEMA` é passado como `format` na chamada ao
// Ollama — restringe a gramática do decoder, então o texto devolvido já é
// JSON sintaticamente válido. `validate()` é quem decide se o CONTEÚDO é
// confiável (enum certo, campos obrigatórios preenchidos, nunca inventar sem
// Knowledge) — nunca confia em JSON cru vindo do modelo sem checar forma.
const ACTIONS = Object.freeze(["RESPOND", "ASK", "HANDOFF", "RESOLVE"]);

const OLLAMA_JSON_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    action: { type: "string", enum: [...ACTIONS] },
    intent: { anyOf: [{ type: "string" }, { type: "null" }] },
    issue: { anyOf: [{ type: "string" }, { type: "null" }] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    entities: { type: "object" },
    missingInformation: { type: "array", items: { type: "string" } },
    response: { anyOf: [{ type: "string" }, { type: "null" }] },
    handoffCategory: { anyOf: [{ type: "string" }, { type: "null" }] },
    handoffReason: { anyOf: [{ type: "string" }, { type: "null" }] },
    summary: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["action", "confidence", "entities", "missingInformation"],
});

const JSON_SCHEMA_EXAMPLE = '{"action":"RESPOND|ASK|HANDOFF|RESOLVE","intent":null,"issue":null,"confidence":0.0,"entities":{},"missingInformation":[],"response":null,"handoffCategory":null,"handoffReason":null,"summary":null}';

function fail(reason) {
  return { valid: false, reason };
}

// Nunca lança: uma resposta inválida vira { valid: false, reason } para quem
// chama decidir (uma re-tentativa controlada ou HANDOFF seguro) — nunca um
// JSON "meio confiável" chega perto do texto enviado ao cliente.
function validate(parsed) {
  if (!parsed || typeof parsed !== "object") return fail("Resposta não é um objeto JSON.");
  if (!ACTIONS.includes(parsed.action)) return fail("Campo 'action' ausente ou inválido.");
  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return fail("Campo 'confidence' inválido.");
  if (parsed.action === "RESPOND" && !String(parsed.response || "").trim()) {
    return fail("action=RESPOND sem texto de resposta.");
  }
  if (parsed.action === "HANDOFF" && !String(parsed.handoffReason || "").trim()) {
    return fail("action=HANDOFF sem motivo do encaminhamento.");
  }
  if (parsed.entities !== undefined && (typeof parsed.entities !== "object" || Array.isArray(parsed.entities))) {
    return fail("Campo 'entities' inválido.");
  }
  if (parsed.missingInformation !== undefined && !Array.isArray(parsed.missingInformation)) {
    return fail("Campo 'missingInformation' inválido.");
  }
  return {
    valid: true,
    value: {
      action: parsed.action,
      intent: typeof parsed.intent === "string" ? parsed.intent : null,
      issue: typeof parsed.issue === "string" ? parsed.issue : null,
      confidence: Math.min(1, Math.max(0, confidence)),
      entities: parsed.entities && typeof parsed.entities === "object" ? parsed.entities : {},
      missingInformation: Array.isArray(parsed.missingInformation) ? parsed.missingInformation.filter((item) => typeof item === "string") : [],
      response: typeof parsed.response === "string" ? parsed.response.trim() : null,
      handoffCategory: typeof parsed.handoffCategory === "string" ? parsed.handoffCategory : null,
      handoffReason: typeof parsed.handoffReason === "string" ? parsed.handoffReason : null,
      summary: typeof parsed.summary === "string" ? parsed.summary : null,
    },
  };
}

// Item 7 (Knowledge First): mesmo um JSON "válido" nunca pode virar RESPOND
// quando nenhum trecho de Knowledge foi recuperado — o modelo não pode
// "saber" sobre a Mibro sozinho. Rebaixa para ASK (se sinalizou informação
// faltante) ou HANDOFF, nunca deixa RESPOND passar sem grounding.
function applyKnowledgeGuard(value, knowledgeResults) {
  if (value.action !== "RESPOND" || knowledgeResults?.length) return value;
  if (value.missingInformation.length) return { ...value, action: "ASK" };
  return {
    ...value, action: "HANDOFF",
    handoffReason: value.handoffReason || "Sem informação oficial suficiente na Knowledge para responder com segurança.",
  };
}

module.exports = { ACTIONS, OLLAMA_JSON_SCHEMA, JSON_SCHEMA_EXAMPLE, validate, applyKnowledgeGuard };
