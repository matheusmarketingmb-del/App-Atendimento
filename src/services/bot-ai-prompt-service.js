// Monta o prompt enviado à IA (LOCAL_QWEN, modo PRIMARY — bot-ai-shadow-
// service.js). Reaproveita a Personalidade já configurada do Bot
// (bot-personality-service.js) para tom/identidade — nunca duplica esse
// texto aqui, só ACRESCENTA as regras duras do contrato JSON e o contexto
// desta mensagem (categoria da triagem, Case State, Knowledge, histórico).
// Orçamento de contexto deliberadamente limitado (item 8/14 do plano): nunca
// a base de Knowledge inteira, nunca a conversa inteira.
const { getEffectivePersonality, buildSystemPrompt } = require("./bot-personality-service");

const KNOWLEDGE_MAX_ITEMS = 5;
const KNOWLEDGE_ITEM_MAX_CHARS = 900;
const HISTORY_MAX_TURNS = 8;

const HARD_RULES = [
  "Você atende clientes DEPOIS da triagem inicial — a categoria/setor já foi identificada, nunca pergunte de novo qual setor o cliente quer.",
  "Use SOMENTE as informações da seção KNOWLEDGE abaixo como fonte de fatos sobre a Mibro. Se a KNOWLEDGE não tiver a informação necessária, nunca invente — prefira ASK (perguntar o que falta) ou HANDOFF.",
  "Nunca invente especificação técnica, preço, prazo, estoque ou cobertura de garantia. Nunca prometa troca, reembolso ou aprovação de garantia.",
  "Nunca finja ter consultado um pedido/nota fiscal real — sem ferramenta ao vivo disponível, oriente o canal oficial ou prepare o handoff.",
  "Não repita uma pergunta já respondida no CONTEXTO DO CASO abaixo.",
  "Responda SEMPRE com um único objeto JSON válido, sem markdown, sem texto antes ou depois, exatamente no formato do schema fornecido.",
].join("\n- ");

function formatKnowledge(results) {
  if (!results?.length) return "(nenhum resultado relevante encontrado na Knowledge)";
  return results.slice(0, KNOWLEDGE_MAX_ITEMS).map((item, index) => (
    `[K${index + 1}] (${item.domain}) ${item.title}: ${String(item.content || "").slice(0, KNOWLEDGE_ITEM_MAX_CHARS)}`
  )).join("\n");
}

function formatHistory(context) {
  const recent = (context || []).slice(-HISTORY_MAX_TURNS);
  if (!recent.length) return "(sem histórico anterior nesta conversa)";
  return recent.map((entry) => (
    `${entry.direction === "ENVIADA" ? "Bot" : "Cliente"}: ${entry.text || "[mensagem sem texto]"}`
  )).join("\n");
}

function formatCaseState(caseState) {
  if (!caseState) return "(nenhum dado ainda coletado nesta conversa)";
  const parts = [];
  if (caseState.product) parts.push(`produto: ${caseState.product}`);
  if (caseState.app) parts.push(`app: ${caseState.app}`);
  if (caseState.os) parts.push(`sistema: ${caseState.os}`);
  if (caseState.symptom) parts.push(`sintoma: ${caseState.symptom}`);
  if (caseState.questionsAsked?.length) parts.push(`perguntas já feitas: ${caseState.questionsAsked.join(" | ")}`);
  if (caseState.solutionsTried?.length) parts.push(`tentativas: ${caseState.solutionsTried.map((s) => s.description).join(" | ")}`);
  if (caseState.solutionsFailed?.length) parts.push(`sem sucesso: ${caseState.solutionsFailed.map((s) => s.description).join(" | ")}`);
  return parts.length ? parts.join("\n") : "(nenhum dado ainda coletado nesta conversa)";
}

function buildSystemPromptForAi(bot) {
  const personality = getEffectivePersonality(bot);
  return `${buildSystemPrompt(personality)}\n\nRegras obrigatórias do modo IA:\n- ${HARD_RULES}`;
}

function buildUserPrompt({ categoryName, caseState, knowledgeResults, context, message, jsonSchemaExample }) {
  return [
    `CATEGORIA (já triada): ${categoryName || "não identificada"}`,
    "",
    "CONTEXTO DO CASO:",
    formatCaseState(caseState),
    "",
    "KNOWLEDGE (fonte oficial, use apenas isto para fatos):",
    formatKnowledge(knowledgeResults),
    "",
    "HISTÓRICO RECENTE:",
    formatHistory(context),
    "",
    `MENSAGEM ATUAL DO CLIENTE: ${JSON.stringify(message)}`,
    "",
    `Responda só com um JSON no formato: ${jsonSchemaExample}`,
  ].join("\n");
}

module.exports = { buildSystemPromptForAi, buildUserPrompt };
