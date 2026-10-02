// Item 2 (Handoff Humano): captura e persiste o contexto estruturado no
// momento do HANDOFF_HUMAN (Bot atual, intenção, confiança, categoria,
// entidades extraídas, última informação relevante, perguntas já feitas,
// soluções já tentadas) e gera um resumo curto e factual — NUNCA
// "chain-of-thought" do modelo, só fatos já conhecidos, montados de forma
// determinística (sem chamar IA).
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");

function buildSummary({
  botName, intentName, confidence, category, lastRelevantInfo, questionsAsked, solutionsTried,
  product, flowResolutionStatus, currentStepName, handoffReason,
}) {
  const parts = [];
  if (botName) {
    parts.push(intentName
      ? `O Bot ${botName} identificou a intenção "${intentName}"${typeof confidence === "number" ? ` com ${Math.round(confidence * 100)}% de confiança` : ""}${category ? `, na categoria "${category}"` : ""}.`
      : `O Bot ${botName} não conseguiu identificar a intenção do cliente com confiança suficiente.`);
  }
  if (product) parts.push(`Produto/modelo informado: "${product}".`);
  if (lastRelevantInfo) parts.push(`Última mensagem relevante do cliente: "${lastRelevantInfo}".`);
  if (questionsAsked && questionsAsked.length) {
    parts.push(`${questionsAsked.length} pergunta(s) de esclarecimento foram feitas pelo Bot antes do encaminhamento.`);
  }
  if (solutionsTried && solutionsTried.length) {
    parts.push(`${solutionsTried.length} resposta(s)/tentativa(s) já foram oferecidas pelo Bot.`);
  }
  if (currentStepName) parts.push(`Parou na etapa "${currentStepName}" do fluxo de atendimento.`);
  if (flowResolutionStatus === "HANDED_OFF") parts.push("O fluxo de atendimento não conseguiu resolver sozinho.");
  if (handoffReason) parts.push(`Motivo do encaminhamento: ${handoffReason}`);
  if (!parts.length) parts.push("Conversa encaminhada para atendimento humano sem informações adicionais disponíveis.");
  return parts.slice(0, 6).join(" ");
}

// Item 2 (handoff inteligente): quando o handoff acontece DENTRO de um Flow
// Engine, os dados estruturados do fluxo (produto coletado, soluções
// tentadas com nome/ação/resultado, etapa em que parou) são muito mais
// precisos que o heurístico de mensagens abaixo — sempre preferidos quando
// disponíveis.
function deriveFlowSignals(flow) {
  if (!flow) return null;
  const questionsAsked = (flow.askedQuestions || []).length;
  const solutionsTried = (flow.attemptedSolutions || []).map((item) => (
    `${item.name} (${item.action}): ${item.outcome === "SUCCESS" ? "ajudou" : "não ajudou"}`
  ));
  return { questionsAskedCount: questionsAsked, solutionsTried };
}

// `context` são as últimas mensagens já carregadas pelo orquestrador
// ({direction, text, occorridas}) — nunca busca nada novo, só reaproveita.
function deriveConversationSignals(context = []) {
  const botMessages = context.filter((m) => m.direction === "ENVIADA" && typeof m.text === "string" && m.text.trim());
  const questionsAsked = botMessages.filter((m) => m.text.trim().endsWith("?")).map((m) => m.text);
  const solutionsTried = botMessages.filter((m) => !m.text.trim().endsWith("?")).map((m) => m.text);
  return { questionsAsked, solutionsTried };
}

async function captureHandoffContext({
  conversationId, bot, interpretation, decision, message, context = [], flow = null, product = null,
}, client = prisma) {
  const flowSignals = deriveFlowSignals(flow);
  const { questionsAsked, solutionsTried } = flowSignals
    ? { questionsAsked: flow.askedQuestions || [], solutionsTried: flowSignals.solutionsTried }
    : deriveConversationSignals(context);
  const confidence = typeof interpretation?.confidence === "number" ? interpretation.confidence : null;
  const currentStepName = flow?.terminalStepName || (flow?.attemptedSolutions?.length
    ? flow.attemptedSolutions[flow.attemptedSolutions.length - 1].name
    : null);
  const summary = buildSummary({
    botName: bot?.name || null,
    intentName: interpretation?.intentName || null,
    confidence,
    category: decision?.categoryName || null,
    lastRelevantInfo: message || null,
    questionsAsked,
    solutionsTried,
    product,
    flowResolutionStatus: flow?.resolutionStatus || null,
    currentStepName,
    handoffReason: decision?.summary || null,
  });

  return client.botHandoffContext.create({
    data: {
      conversationId,
      botId: bot?.id || null,
      botName: bot?.name || null,
      intentId: interpretation?.intentId || null,
      intentName: interpretation?.intentName || null,
      confidence,
      category: decision?.categoryName || null,
      extractedEntities: interpretation?.entities || {},
      lastRelevantInfo: message || null,
      questionsAsked,
      solutionsTried,
      product,
      flowResolutionStatus: flow?.resolutionStatus || null,
      currentStepName,
      handoffReason: decision?.summary || null,
      summary,
    },
  });
}

async function listHandoffContexts(conversationId, viewer, client = prisma) {
  await authorization.assertCanViewConversation(viewer, conversationId);
  return client.botHandoffContext.findMany({ where: { conversationId }, orderBy: { createdAt: "desc" } });
}

async function getLatestHandoffContext(conversationId, client = prisma) {
  return client.botHandoffContext.findFirst({ where: { conversationId }, orderBy: { createdAt: "desc" } });
}

// "[Cancelar Bot]": ação humana explícita — o atendente força a pausa mesmo
// que ninguém tenha assumido a conversa ainda (ex.: bot de triagem ainda
// tentando classificar). Grava ConversationBotState.humanPausedAt; todo
// mecanismo de envio de bot (triage-bot-service.js e, quando deixar de ser
// sombra, bot-orchestrator-service.js) passa a checar esse campo antes de
// responder — ver botIsAllowedToRespond em triage-bot-service.js. Usa upsert
// porque uma conversa que nunca rodou o orquestrador não tem
// ConversationBotState ainda.
async function pauseBot(conversationId, actor) {
  await authorization.assertCanViewConversation(actor, conversationId);
  return prisma.conversationBotState.upsert({
    where: { conversationId },
    update: { humanPausedAt: new Date() },
    create: { conversationId, humanPausedAt: new Date() },
  });
}

// "[Retomar Bot]" (item 2): ação humana explícita — nunca automática, nunca
// disparada pelo motor de decisão. Só limpa a pausa (ConversationBotState.
// humanPausedAt); o Bot volta a poder responder na PRÓXIMA mensagem, nunca
// reenvia nada retroativamente. Upsert pelo mesmo motivo de pauseBot: pode
// ser chamado numa conversa que nunca teve o estado criado.
async function resumeBot(conversationId, actor) {
  await authorization.assertCanViewConversation(actor, conversationId);

  const updated = await prisma.conversationBotState.upsert({
    where: { conversationId },
    update: { humanPausedAt: null },
    create: { conversationId, humanPausedAt: null },
  });

  const latestHandoff = await getLatestHandoffContext(conversationId);
  if (latestHandoff && !latestHandoff.resumedAt) {
    await prisma.botHandoffContext.update({
      where: { id: latestHandoff.id },
      data: { resumedAt: new Date(), resumedByUserId: actor.id },
    });
  }

  return updated;
}

module.exports = {
  captureHandoffContext, deriveConversationSignals, getLatestHandoffContext, listHandoffContexts, pauseBot, resumeBot,
};
