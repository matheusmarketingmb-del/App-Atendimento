require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { orchestrate } = require("../src/services/bot-orchestrator-service");
const { detectFlowOutcome } = require("../src/services/bot-flow-service");
const registry = require("../src/services/bot-tools/tool-registry");

const botNamePrefix = "Bot Flow Teste";
const externalId = "bot-flow-test-contact";

async function cleanup() {
  await prisma.bot.deleteMany({ where: { name: { startsWith: botNamePrefix } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: externalId } } });
  await prisma.knowledgeSource.deleteMany({ where: { title: { startsWith: "Flow Teste" } } });
}

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

let phoneCounter = 0;
async function seedConversation() {
  phoneCounter += 1;
  const contact = await prisma.contact.create({
    data: { externalId: `${externalId}-${phoneCounter}`, phone: `5511977700${String(phoneCounter).padStart(3, "0")}`, name: "Cliente" },
  });
  return prisma.conversation.create({ data: { contactId: contact.id } });
}

async function sendMessage(conversation, text) {
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id, externalId: `flow-${conversation.id}-${Math.random()}`,
      direction: "RECEBIDA", status: "RECEBIDA", type: "text", text, occurredAt: new Date(),
    },
  });
  return orchestrate({ conversationId: conversation.id, messageId: message.id, message: text });
}

// Monta o fluxo do exemplo do pedido (item 4): modelo -> aplicativo ->
// aparece no Bluetooth? -> conhecimento de pareamento -> funcionou? ->
// RESOLVED (sim) ou HANDOFF_HUMAN (não).
async function createSuporteConexaoBot({ autoReplyEnabled = true, withKnowledge = true, botOverrides = {} } = {}) {
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Suporte Conexão`, status: "ACTIVE", channel: "META",
      autoReplyEnabled, toolsEnabled: true,
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{
        name: "Suporte de conexão", active: true, priority: 1,
        examples: { create: [{ text: "meu fone nao conecta" }, { text: "nao consigo parear o fone" }] },
      }] },
      ...botOverrides,
    },
    include: { intents: true },
  });
  const intentId = bot.intents[0].id;

  if (withKnowledge) {
    await prisma.knowledgeSource.create({
      data: {
        title: "Flow Teste Pareamento", type: "PROCEDURE", intentId, active: true,
        content: "Mantenha pressionado o botão por 5 segundos até a luz piscar e selecione o fone na lista de Bluetooth do celular.",
      },
    });
  }

  const s1 = await prisma.botFlowStep.create({ data: { intentId, name: "Modelo", order: 1, action: "ASK_QUESTION", question: "Qual é o modelo do seu produto?", entityKey: "modelo" } });
  const s2 = await prisma.botFlowStep.create({ data: { intentId, name: "Aplicativo", order: 2, action: "ASK_QUESTION", question: "Você já instalou o aplicativo Mibro Fit?", entityKey: "aplicativo" } });
  const s3 = await prisma.botFlowStep.create({ data: { intentId, name: "Aparece no Bluetooth", order: 3, action: "ASK_QUESTION", question: "O produto aparece na lista de dispositivos Bluetooth do celular?" } });
  const s4 = await prisma.botFlowStep.create({ data: { intentId, name: "Procedimento de pareamento", order: 4, action: "USE_KNOWLEDGE" } });
  const s5 = await prisma.botFlowStep.create({ data: { intentId, name: "Funcionou?", order: 5, action: "ASK_QUESTION", question: "Depois disso, funcionou?" } });
  const s6 = await prisma.botFlowStep.create({ data: { intentId, name: "Resolvido", order: 6, action: "RESOLVED", responseMessage: "Ótimo! Fico feliz em ajudar." } });
  const s7 = await prisma.botFlowStep.create({ data: { intentId, name: "Encaminhar humano", order: 7, action: "HANDOFF_HUMAN", responseMessage: "Vou chamar um especialista para te ajudar." } });

  await prisma.botFlowStep.update({ where: { id: s1.id }, data: { nextStepId: s2.id } });
  await prisma.botFlowStep.update({ where: { id: s2.id }, data: { nextStepId: s3.id } });
  await prisma.botFlowStep.update({ where: { id: s3.id }, data: { onSuccessStepId: s4.id, onFailureStepId: s7.id } });
  await prisma.botFlowStep.update({ where: { id: s4.id }, data: { nextStepId: s5.id } });
  await prisma.botFlowStep.update({ where: { id: s5.id }, data: { onSuccessStepId: s6.id, onFailureStepId: s7.id } });

  return { bot, intentId, steps: { s1, s2, s3, s4, s5, s6, s7 } };
}

test("fluxo completo de suporte de conexão: coleta dados, usa conhecimento real e resolve", async () => {
  await cleanup();
  const { intentId } = await createSuporteConexaoBot();
  const conversation = await seedConversation();

  const r1 = await sendMessage(conversation, "meu fone nao conecta");
  assert.equal(r1.action, "RESPOND");
  assert.match(r1.response, /modelo/i);

  const r2 = await sendMessage(conversation, "GS Pro 2");
  assert.match(r2.response, /aplicativo/i);

  const r3 = await sendMessage(conversation, "Mibro Fit");
  assert.match(r3.response, /bluetooth/i);

  const r4 = await sendMessage(conversation, "sim");
  // Etapa 4 (USE_KNOWLEDGE) é automática: a resposta já deve trazer o
  // conteúdo real da KnowledgeSource junto com a pergunta "funcionou?".
  assert.match(r4.response, /5 segundos/);
  assert.match(r4.response, /funcionou/i);

  const r5 = await sendMessage(conversation, "funcionou, obrigado");
  assert.equal(r5.action, "RESPOND");
  assert.equal(r5.response, "Ótimo! Fico feliz em ajudar.");

  const state = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.equal(state.currentFlowStepId, null);
  assert.equal(state.flowResolutionStatus, "RESOLVED");
  assert.equal(state.activeFlowIntentId, intentId);
  assert.deepEqual(state.flowCollectedEntities, { modelo: "GS Pro 2", aplicativo: "Mibro Fit" });
});

test('"sim" é interpretado no contexto da etapa atual, não como uma nova classificação de intenção', async () => {
  await cleanup();
  await createSuporteConexaoBot();
  const conversation = await seedConversation();
  await sendMessage(conversation, "meu fone nao conecta");
  await sendMessage(conversation, "GS Pro 2");
  await sendMessage(conversation, "Mibro Fit");

  const r = await sendMessage(conversation, "sim");
  assert.equal(r.provider, "FLOW_ENGINE", '"sim" deveria ser tratado pelo Flow Engine, não reclassificado do zero');
  assert.match(r.response, /5 segundos/);
});

test("campo já coletado não é perguntado de novo", async () => {
  await cleanup();
  const { steps } = await createSuporteConexaoBot();
  const conversation = await seedConversation();
  await sendMessage(conversation, "meu fone nao conecta");
  const r2 = await sendMessage(conversation, "GS Pro 2");

  const state = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.equal(state.flowCollectedEntities.modelo, "GS Pro 2");
  assert.deepEqual(state.flowAskedQuestions, [steps.s1.id, steps.s2.id]);
  // A próxima pergunta é a da etapa 2 (aplicativo) — nunca volta a perguntar
  // o modelo, que já foi coletado.
  assert.doesNotMatch(r2.response, /modelo/i);
  assert.match(r2.response, /aplicativo/i);
});

test("uma etapa que volta ao início do fluxo pula as perguntas já respondidas em vez de repeti-las", async () => {
  await cleanup();
  const { steps } = await createSuporteConexaoBot();
  const conversation = await seedConversation();
  await sendMessage(conversation, "meu fone nao conecta");
  await sendMessage(conversation, "GS Pro 2");
  await sendMessage(conversation, "Mibro Fit");

  // Em vez de seguir para a Base de Conhecimento, a confirmação do
  // Bluetooth volta para a etapa 1 (propositalmente, só para este teste) —
  // "modelo" e "aplicativo" já foram coletados e não devem ser perguntados
  // de novo; o motor deve atravessar as duas e cair de volta na pergunta
  // real da etapa 3 (que ainda não tem entidade e por isso é repetida).
  await prisma.botFlowStep.update({ where: { id: steps.s3.id }, data: { onSuccessStepId: steps.s1.id } });
  const r = await sendMessage(conversation, "sim");

  assert.doesNotMatch(r.response, /modelo/i);
  assert.doesNotMatch(r.response, /aplicativo/i);
  assert.match(r.response, /bluetooth/i);

  const state = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.deepEqual(state.flowCollectedEntities, { modelo: "GS Pro 2", aplicativo: "Mibro Fit" });
});

test("solução positiva ('funcionou') encerra o fluxo como RESOLVED", async () => {
  await cleanup();
  await createSuporteConexaoBot();
  const conversation = await seedConversation();
  await sendMessage(conversation, "meu fone nao conecta");
  await sendMessage(conversation, "GS Pro 2");
  await sendMessage(conversation, "Mibro Fit");
  await sendMessage(conversation, "sim");
  const final = await sendMessage(conversation, "agora funcionou");

  assert.equal(final.action, "RESPOND");
  const state = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.equal(state.flowResolutionStatus, "RESOLVED");
  assert.equal(state.currentFlowStepId, null);
});

test("solução negativa ('não funcionou') não encerra — segue para a próxima ação (handoff, no exemplo)", async () => {
  await cleanup();
  await createSuporteConexaoBot();
  const conversation = await seedConversation();
  await sendMessage(conversation, "meu fone nao conecta");
  await sendMessage(conversation, "GS Pro 2");
  await sendMessage(conversation, "Mibro Fit");
  await sendMessage(conversation, "sim");
  const final = await sendMessage(conversation, "não funcionou, continua igual");

  assert.equal(final.action, "HANDOFF_HUMAN");
  assert.equal(final.response, "Vou chamar um especialista para te ajudar.");
  const state = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.equal(state.flowResolutionStatus, "HANDED_OFF");
});

test("etapa sem Bluetooth visível ('não') vai direto para o handoff configurado na ação de falha", async () => {
  await cleanup();
  await createSuporteConexaoBot();
  const conversation = await seedConversation();
  await sendMessage(conversation, "meu fone nao conecta");
  await sendMessage(conversation, "GS Pro 2");
  await sendMessage(conversation, "Mibro Fit");
  const final = await sendMessage(conversation, "não, não aparece");

  assert.equal(final.action, "HANDOFF_HUMAN");
});

test("limite de tentativas: resposta ambígua repetida esgota o máximo e encaminha para humano, sem perguntar para sempre", async () => {
  await cleanup();
  const { steps } = await createSuporteConexaoBot();
  await prisma.botFlowStep.update({ where: { id: steps.s3.id }, data: { maxAttempts: 2 } });
  const conversation = await seedConversation();
  await sendMessage(conversation, "meu fone nao conecta");
  await sendMessage(conversation, "GS Pro 2");
  await sendMessage(conversation, "Mibro Fit");

  const retry = await sendMessage(conversation, "talvez, não tenho certeza");
  assert.equal(retry.action, "RESPOND");
  assert.match(retry.response, /bluetooth/i);

  const exhausted = await sendMessage(conversation, "sei lá, não sei dizer");
  assert.equal(exhausted.action, "HANDOFF_HUMAN", "esgotou as tentativas — nunca deveria ficar perguntando para sempre");
  const state = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.equal(state.flowResolutionStatus, "HANDED_OFF");
});

test("handoff explícito grava BotHandoffContext, e o fluxo é retomável só manualmente depois", async () => {
  await cleanup();
  await createSuporteConexaoBot();
  const conversation = await seedConversation();
  await sendMessage(conversation, "meu fone nao conecta");
  await sendMessage(conversation, "GS Pro 2");
  await sendMessage(conversation, "Mibro Fit");
  await sendMessage(conversation, "sim");
  await sendMessage(conversation, "não funcionou");

  const contexts = await prisma.botHandoffContext.findMany({ where: { conversationId: conversation.id } });
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].resumedAt, null);
});

test("conhecimento ausente na etapa: nunca inventa procedimento, segue pela ação de falha", async () => {
  await cleanup();
  await createSuporteConexaoBot({ withKnowledge: false });
  const conversation = await seedConversation();
  await sendMessage(conversation, "meu fone nao conecta");
  await sendMessage(conversation, "GS Pro 2");
  await sendMessage(conversation, "Mibro Fit");
  const r = await sendMessage(conversation, "sim");

  // Sem KnowledgeSource cadastrada, a etapa 4 (USE_KNOWLEDGE) falha e o fluxo
  // segue direto para a etapa 5 (nextStepId) — nunca fabrica um procedimento.
  assert.doesNotMatch(r.response, /5 segundos/);
  assert.match(r.response, /funcionou/i);
});

test("Bot pausado: automação inteira para, o fluxo nunca chega a iniciar", async () => {
  await cleanup();
  const { bot } = await createSuporteConexaoBot();
  await prisma.bot.update({ where: { id: bot.id }, data: { status: "PAUSED" } });
  const conversation = await seedConversation();
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id, externalId: `flow-paused-${Math.random()}`,
      direction: "RECEBIDA", status: "RECEBIDA", type: "text", text: "meu fone nao conecta", occurredAt: new Date(),
    },
  });
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });
  assert.equal(result, null, "sem nenhum Bot ACTIVE para o canal, orchestrate() não deveria resolver nenhum Bot");
});

test("Observação (autoReplyEnabled=false): uma etapa QUERY_TOOL nunca executa a Tool de verdade, e nunca fabrica resposta", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Pedido Fluxo`, status: "ACTIVE", channel: "META",
      autoReplyEnabled: false, toolsEnabled: true, toolPermissions: { OrderTool: true },
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{
        name: "Rastrear pedido com fluxo", active: true, priority: 1,
        examples: { create: [{ text: "quero rastrear meu pedido" }] },
      }] },
    },
    include: { intents: true },
  });
  const intentId = bot.intents[0].id;
  const ask = await prisma.botFlowStep.create({ data: { intentId, name: "Número do pedido", order: 1, action: "ASK_QUESTION", question: "Qual o número do pedido?", entityKey: "orderNumber" } });
  const query = await prisma.botFlowStep.create({ data: { intentId, name: "Consulta pedido", order: 2, action: "QUERY_TOOL", toolName: "OrderTool" } });
  const resolved = await prisma.botFlowStep.create({ data: { intentId, name: "Resolvido", order: 3, action: "RESOLVED" } });
  const handoff = await prisma.botFlowStep.create({ data: { intentId, name: "Encaminhar", order: 4, action: "HANDOFF_HUMAN", responseMessage: "Vou te encaminhar." } });
  await prisma.botFlowStep.update({ where: { id: ask.id }, data: { nextStepId: query.id } });
  await prisma.botFlowStep.update({ where: { id: query.id }, data: { onSuccessStepId: resolved.id, onFailureStepId: handoff.id } });

  let executed = false;
  const tool = registry.tools.OrderTool;
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (...args) => { executed = true; return originalExecute(...args); };
  try {
    const conversation = await seedConversation();
    await sendMessage(conversation, "quero rastrear meu pedido");
    const final = await sendMessage(conversation, "123456789");
    assert.equal(executed, false, "modo observação nunca deveria chamar tool.execute() de verdade");
    assert.equal(final.action, "HANDOFF_HUMAN", "sem dado real da Tool (observação), a etapa segue pela ação de falha, nunca inventa um resultado");
  } finally {
    tool.execute = originalExecute;
  }
});

test("detectFlowOutcome reconhece frases de resolução positivas e negativas (item 6)", () => {
  assert.equal(detectFlowOutcome("funcionou!"), "RESOLVED");
  assert.equal(detectFlowOutcome("deu certo, obrigado"), "RESOLVED");
  assert.equal(detectFlowOutcome("agora foi"), "RESOLVED");
  assert.equal(detectFlowOutcome("resolveu o problema"), "RESOLVED");
  assert.equal(detectFlowOutcome("não funcionou"), "NOT_RESOLVED");
  assert.equal(detectFlowOutcome("continua igual"), "NOT_RESOLVED");
  assert.equal(detectFlowOutcome("não resolveu ainda"), "NOT_RESOLVED");
  assert.equal(detectFlowOutcome("qualquer outra coisa"), null);
});
