require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const learning = require("../src/services/bot-learning-service");

const botNamePrefix = "Bot Aprendizado Teste";
const externalId = "bot-learning-test-contact";
const masterEmail = "master-learning-test@teste.local";
let master;

async function cleanup() {
  await prisma.botLearningSuggestion.deleteMany({ where: { bot: { name: { startsWith: botNamePrefix } } } });
  await prisma.bot.deleteMany({ where: { name: { startsWith: botNamePrefix } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: externalId } } });
}

test.before(async () => {
  master = await prisma.user.upsert({
    where: { email: masterEmail },
    update: {},
    create: { name: "Master Aprendizado Teste", email: masterEmail, role: "ADMIN" },
  });
});

test.after(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { email: masterEmail } });
  await prisma.$disconnect();
});

let phoneCounter = 0;
async function seedConversation({ status = "FINALIZADO" } = {}) {
  phoneCounter += 1;
  const contact = await prisma.contact.create({ data: {
    externalId: `${externalId}-${phoneCounter}`, phone: `55110000${String(phoneCounter).padStart(4, "0")}`, name: "Cliente",
  } });
  return prisma.conversation.create({ data: { contactId: contact.id, status } });
}

async function addMessage(conversation, { direction, text, sentByUserId = null, offsetSeconds = 0 }) {
  return prisma.message.create({ data: {
    conversationId: conversation.id, externalId: `learning-${conversation.id}-${direction}-${offsetSeconds}-${Math.random()}`,
    direction, status: direction === "ENVIADA" ? "ENVIADA" : "RECEBIDA", type: "text", text,
    occurredAt: new Date(Date.now() + offsetSeconds * 1000), sentByUserId,
  } });
}

test("gera sugestão de exemplo para uma intenção com baixa confiança quando a conversa foi resolvida", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} A`, status: "ACTIVE", channel: "META",
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{ name: "Suporte de conexão", active: true, examples: { create: [{ text: "nao conecta" }] } }] },
    },
    include: { intents: true },
  });
  const intent = bot.intents[0];

  const conversation = await seedConversation();
  const firstMessage = await addMessage(conversation, { direction: "RECEBIDA", text: "meu mibro n qr ligar no cel", offsetSeconds: 0 });
  await addMessage(conversation, { direction: "ENVIADA", text: "Você pode tentar reiniciar o Bluetooth do celular?", sentByUserId: master.id, offsetSeconds: 10 });
  await addMessage(conversation, { direction: "RECEBIDA", text: "funcionou, obrigado!", offsetSeconds: 20 });

  await prisma.botObservation.create({ data: {
    conversationId: conversation.id, messageId: firstMessage.id, botId: bot.id, botName: bot.name,
    withinHours: true, intentId: intent.id, intentName: intent.name, confidence: 0.4, action: "ASK_CLARIFICATION",
  } });

  const result = await learning.analyzeConversation(conversation.id);
  assert.equal(result.analyzed, true);
  assert.equal(result.resolutionSignal, "POSITIVE");
  assert.ok(result.suggestionsGenerated >= 1);

  const suggestions = await prisma.botLearningSuggestion.findMany({ where: { conversationId: conversation.id, type: "INTENT_EXAMPLE" } });
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].intentId, intent.id);
  assert.equal(suggestions[0].status, "PENDING");
  assert.doesNotMatch(suggestions[0].suggestedContent, /\bcel\b.*\d{6,}/);

  const rerun = await learning.analyzeConversationManually(conversation.id, master);
  assert.equal(rerun.analyzed, false);
  assert.equal(rerun.reason, "ALREADY_ANALYZED");
});

test("não sugere exemplo já existente na intenção (evita duplicidade)", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} B`, status: "ACTIVE", channel: "META",
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{ name: "Bateria", active: true, examples: { create: [{ text: "bateria dura pouco" }] } }] },
    },
    include: { intents: true },
  });
  const intent = bot.intents[0];
  await prisma.botIntentExample.create({ data: { intentId: intent.id, text: "bateria acabando rapido" } });

  const conversation = await seedConversation();
  const firstMessage = await addMessage(conversation, { direction: "RECEBIDA", text: "bateria acabando rapido", offsetSeconds: 0 });
  await addMessage(conversation, { direction: "RECEBIDA", text: "resolveu, valeu", offsetSeconds: 10 });
  await prisma.botObservation.create({ data: {
    conversationId: conversation.id, messageId: firstMessage.id, botId: bot.id, botName: bot.name,
    withinHours: true, intentId: intent.id, intentName: intent.name, confidence: 0.5,
  } });

  const result = await learning.analyzeConversation(conversation.id);
  assert.equal(result.analyzed, true);
  const suggestions = await prisma.botLearningSuggestion.findMany({ where: { conversationId: conversation.id, type: "INTENT_EXAMPLE" } });
  assert.equal(suggestions.length, 0);
});

test("agrupa RESPONSE por tópico e marca CONFLITO quando soluções divergem", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} C`, status: "ACTIVE", channel: "META",
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    },
  });

  const conversation1 = await seedConversation();
  const firstMessage1 = await addMessage(conversation1, { direction: "RECEBIDA", text: "nao chegam notificacoes do whatsapp no relogio", offsetSeconds: 0 });
  await addMessage(conversation1, { direction: "ENVIADA", text: "Verifique se o Bluetooth está sempre ligado no celular.", sentByUserId: master.id, offsetSeconds: 10 });
  await addMessage(conversation1, { direction: "RECEBIDA", text: "funcionou", offsetSeconds: 20 });
  await prisma.botObservation.create({ data: {
    conversationId: conversation1.id, messageId: firstMessage1.id, botId: bot.id, botName: bot.name, withinHours: true,
  } });
  const r1 = await learning.analyzeConversation(conversation1.id);
  assert.equal(r1.analyzed, true);

  const conversation2 = await seedConversation();
  const firstMessage2 = await addMessage(conversation2, { direction: "RECEBIDA", text: "nao chegam notificacoes do whatsapp no relogio", offsetSeconds: 0 });
  await addMessage(conversation2, { direction: "ENVIADA", text: "Verifique se o Bluetooth está sempre ligado no celular.", sentByUserId: master.id, offsetSeconds: 10 });
  await addMessage(conversation2, { direction: "RECEBIDA", text: "deu certo, obrigado", offsetSeconds: 20 });
  await prisma.botObservation.create({ data: {
    conversationId: conversation2.id, messageId: firstMessage2.id, botId: bot.id, botName: bot.name, withinHours: true,
  } });
  await learning.analyzeConversation(conversation2.id);

  const responseSuggestions = await prisma.botLearningSuggestion.findMany({ where: { botId: bot.id, type: "RESPONSE" } });
  assert.equal(responseSuggestions.length, 1, "mesma solução para o mesmo tópico deve agrupar, não duplicar");
  assert.equal(responseSuggestions[0].sourceCount, 2);

  const conversation3 = await seedConversation();
  const firstMessage3 = await addMessage(conversation3, { direction: "RECEBIDA", text: "nao chegam notificacoes do whatsapp no relogio", offsetSeconds: 0 });
  await addMessage(conversation3, { direction: "ENVIADA", text: "Reinstale o aplicativo Mibro Fit e refaça o pareamento do zero.", sentByUserId: master.id, offsetSeconds: 10 });
  await addMessage(conversation3, { direction: "RECEBIDA", text: "agora foi, valeu", offsetSeconds: 20 });
  await prisma.botObservation.create({ data: {
    conversationId: conversation3.id, messageId: firstMessage3.id, botId: bot.id, botName: bot.name, withinHours: true,
  } });
  await learning.analyzeConversation(conversation3.id);

  const afterConflict = await prisma.botLearningSuggestion.findMany({ where: { botId: bot.id, type: "RESPONSE" }, orderBy: { createdAt: "asc" } });
  assert.equal(afterConflict.length, 2, "solução divergente para o mesmo tópico cria uma segunda sugestão");
  assert.ok(afterConflict.every((row) => row.metadata?.conflict === true));
});

test("mantém sugestões de resposta isoladas por Bot", async () => {
  await cleanup();
  const botA = await prisma.bot.create({ data: {
    name: `${botNamePrefix} Isolado A`, status: "ACTIVE", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
  } });
  const botB = await prisma.bot.create({ data: {
    name: `${botNamePrefix} Isolado B`, status: "ACTIVE", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
  } });
  const topic = "relogio nao recebe notificacoes";
  const solution = "Ative novamente o acesso às notificações no celular.";
  await prisma.botLearningSuggestion.create({ data: {
    botId: botA.id, type: "RESPONSE", title: "Notificações",
    suggestedContent: solution, metadata: { topic },
  } });

  const conversation = await seedConversation();
  const firstMessage = await addMessage(conversation, { direction: "RECEBIDA", text: topic, offsetSeconds: 0 });
  await addMessage(conversation, {
    direction: "ENVIADA", text: solution, sentByUserId: master.id, offsetSeconds: 10,
  });
  await addMessage(conversation, { direction: "RECEBIDA", text: "funcionou", offsetSeconds: 20 });
  await prisma.botObservation.create({ data: {
    conversationId: conversation.id, messageId: firstMessage.id,
    botId: botB.id, botName: botB.name, withinHours: true,
  } });

  const result = await learning.analyzeConversation(conversation.id);
  assert.equal(result.analyzed, true);
  const [responsesA, responsesB] = await Promise.all([
    prisma.botLearningSuggestion.findMany({ where: { botId: botA.id, type: "RESPONSE" } }),
    prisma.botLearningSuggestion.findMany({ where: { botId: botB.id, type: "RESPONSE" } }),
  ]);
  assert.equal(responsesA.length, 1);
  assert.equal(responsesA[0].sourceCount, 1);
  assert.equal(responsesB.length, 1);
  assert.equal(responsesB[0].sourceCount, 1);
});

test("não analisa conversas que ainda não foram finalizadas", async () => {
  await cleanup();
  const conversation = await seedConversation({ status: "NOVO" });
  await addMessage(conversation, { direction: "RECEBIDA", text: "oi", offsetSeconds: 0 });
  const result = await learning.analyzeConversation(conversation.id);
  assert.equal(result.analyzed, false);
  assert.equal(result.reason, "CONVERSATION_NOT_FINALIZED");
});

test("aprovar INTENT_EXAMPLE cria o exemplo na intenção; rejeitar não altera nada", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} D`, status: "ACTIVE", channel: "META",
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{ name: "Garantia", active: true, examples: { create: [{ text: "quero acionar garantia" }] } }] },
    },
    include: { intents: true },
  });
  const intent = bot.intents[0];
  const conversation = await seedConversation();

  const approve = await prisma.botLearningSuggestion.create({ data: {
    botId: bot.id, intentId: intent.id, conversationId: conversation.id, type: "INTENT_EXAMPLE",
    title: "Novo exemplo", suggestedContent: "meu produto quebrou na garantia",
  } });
  const approved = await learning.approveSuggestion(approve.id, {}, master);
  assert.equal(approved.status, "APPROVED");
  const examples = await prisma.botIntentExample.findMany({ where: { intentId: intent.id } });
  assert.ok(examples.some((example) => example.text === "meu produto quebrou na garantia"));

  const reject = await prisma.botLearningSuggestion.create({ data: {
    botId: bot.id, intentId: intent.id, conversationId: conversation.id, type: "INTENT_EXAMPLE",
    title: "Outro exemplo", suggestedContent: "produto com defeito de fabrica",
  } });
  const rejected = await learning.rejectSuggestion(reject.id, master);
  assert.equal(rejected.status, "REJECTED");
  await assert.rejects(() => learning.approveSuggestion(reject.id, {}, master));

  const examplesAfterReject = await prisma.botIntentExample.findMany({ where: { intentId: intent.id } });
  assert.ok(!examplesAfterReject.some((example) => example.text === "produto com defeito de fabrica"));
});

test("editar uma sugestão pendente muda o status para EDITED e o conteúdo", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} E`, status: "DRAFT", channel: "META",
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    },
  });
  const suggestion = await prisma.botLearningSuggestion.create({ data: {
    botId: bot.id, type: "NEW_INTENT", title: "Rascunho", suggestedContent: "texto original",
  } });
  const edited = await learning.editSuggestion(
    suggestion.id,
    { suggestedContent: "texto revisado pelo humano com CPF 111.222.333-44" },
    master,
  );
  assert.equal(edited.status, "EDITED");
  assert.equal(edited.suggestedContent, "texto revisado pelo humano com CPF");
  assert.doesNotMatch(edited.suggestedContent, /111\.222\.333-44/);
});
