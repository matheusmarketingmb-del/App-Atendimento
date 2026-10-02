// Itens 5-8, 10, 11: quem VALIDA e EXECUTA uma Tool sugerida pela decisão
// (QUERY_TOOL). A IA/interpretador só sugere `{action:"QUERY_TOOL", tool,
// entities}` (bot-decision-service.js); aqui o backend confere, nesta ordem:
// 1) a Tool existe no registry e está habilitada; 2) riskLevel permite
// execução nesta fase (nunca SENSITIVE_ACTION); 3) o Bot tem
// toolsEnabled=true; 4) o Bot tem permissão explícita para esta Tool
// (Bot.toolPermissions); 5) as entidades obrigatórias estão presentes.
// Só depois disso tool.execute() é chamado — e mesmo assim NUNCA em modo
// observação (item 11), que só registra o que teria acontecido.
const { getTool } = require("./bot-tools/tool-registry");
const { resolveToolPermissions } = require("./bot-governance-service");

const CLARIFICATION_QUESTIONS = {
  orderNumber: "Pode me informar o número do pedido?",
  trackingCode: "Pode me informar o código de rastreio?",
  serialNumber: "Pode me informar o número de série do produto?",
  productName: "Qual é o nome ou o código do produto?",
  email: "Pode me informar o e-mail usado na compra?",
  cpf: "Pode me informar o CPF usado na compra?",
  cnpj: "Pode me informar o CNPJ usado na compra?",
};

function clarificationFor(missing) {
  const key = (missing || [])[0];
  return CLARIFICATION_QUESTIONS[key] || "Pode me dar mais um detalhe para eu continuar te ajudando?";
}

// Nunca inventa dado: se a Tool não está disponível, cai para a resposta
// padrão do Bot (RESPOND com bot.fallbackMessage/intent.responseMessage já
// resolvido por bot-response-service.js) em vez de fabricar um resultado.
function safeFallbackDecision(decision, reason) {
  return {
    ...decision,
    action: "RESPOND",
    toolResponseText: null,
    toolUnavailableReason: reason,
    summary: `${decision.summary} (Tool indisponível: ${reason}; respondendo com a mensagem padrão em vez de inventar dados.)`,
  };
}

function validateToolCall({ bot, decision, channel }) {
  const toolName = decision.toolName;
  const tool = getTool(toolName);
  if (!tool) return { status: "UNAVAILABLE", reason: "TOOL_NOT_FOUND" };
  if (!tool.enabled) return { status: "UNAVAILABLE", reason: "TOOL_DISABLED" };
  if (tool.riskLevel === "SENSITIVE_ACTION") return { status: "UNAVAILABLE", reason: "SENSITIVE_ACTION_BLOCKED" };
  if (!bot.toolsEnabled) return { status: "UNAVAILABLE", reason: "BOT_TOOLS_DISABLED" };
  const permissions = resolveToolPermissions(bot);
  if (!permissions[toolName]) return { status: "UNAVAILABLE", reason: "TOOL_NOT_PERMITTED" };
  const check = tool.canExecute({ channel, entities: decision.entities || {} });
  if (!check.ok) {
    if (check.reason === "MISSING_ENTITIES") return { status: "NEEDS_CLARIFICATION", missing: check.missing };
    return { status: "UNAVAILABLE", reason: check.reason };
  }
  return { status: "OK", tool };
}

// `mode`: "LIVE" (pode executar de verdade, se toda validação passar) ou
// "OBSERVATION" (item 11: nunca chama tool.execute(), só registra o que
// teria sido chamado — toolName/entities ficam disponíveis para o chamador
// gravar em BotObservation.toolName/toolResult).
async function resolveToolDecision({ bot, decision, channel, mode = "LIVE" }) {
  if (decision.action !== "QUERY_TOOL" || !decision.toolName) return decision;

  const validation = validateToolCall({ bot, decision, channel });

  if (validation.status === "NEEDS_CLARIFICATION") {
    return {
      ...decision,
      action: "ASK_CLARIFICATION",
      needsClarification: true,
      clarificationQuestion: clarificationFor(validation.missing),
      summary: `${decision.summary} Faltam dados obrigatórios (${(validation.missing || []).join(", ")}) para consultar a Tool "${decision.toolName}".`,
    };
  }

  if (validation.status === "UNAVAILABLE") {
    return safeFallbackDecision(decision, validation.reason);
  }

  if (mode === "OBSERVATION") {
    return {
      ...decision,
      action: "RESPOND",
      toolResponseText: null,
      toolObservedOnly: true,
      summary: `${decision.summary} (Modo observação: a Tool "${decision.toolName}" NÃO foi executada de verdade.)`,
    };
  }

  const { tool } = validation;
  const result = await tool.execute(decision.entities || {});
  if (!result || !result.success) {
    return { ...safeFallbackDecision(decision, (result && result.reason) || "TOOL_FAILED"), toolResult: result || null };
  }
  return {
    ...decision,
    action: "RESPOND",
    toolResult: result,
    // Texto final montado SOMENTE com dados reais devolvidos pela Tool
    // (result.message) — nunca fabricado aqui nem pela IA.
    toolResponseText: result.message || null,
  };
}

module.exports = { resolveToolDecision, validateToolCall, clarificationFor };
