// Testa a integração ponta a ponta da Personalidade dentro do orquestrador
// real (orchestrate()), contra o banco. Nunca chama um provider de IA de
// verdade: todos os Bots aqui mantêm externalAiFallbackEnabled desligado
// (default), então applyPersonality() sempre cai no caminho "não aplicado"
// (ver bot-personality-prompt.test.js para a reescrita em si, testada com um
// provider injetado). O que importa provar AQUI é que, mesmo com uma
// Personalidade configurada, o Knowledge/handoff continuam saindo
// EXATAMENTE como decidido — a personalidade nunca os altera.
require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { orchestrate } = require("../src/services/bot-orchestrator-service");

const botNamePrefix = "Bot Personalidade Orq Teste";
const externalId = "bot-personality-orq-test-contact";

async function cleanup() {
  await prisma.bot.deleteMany({ where: { name: { startsWith: botNamePrefix } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: externalId } } });
  await prisma.knowledgeSource.deleteMany({ where: { title: { startsWith: "Personalidade Orq Teste" } } });
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

async function addMessage(conversation, text) {
  return prisma.message.create({
    data: {
      conversationId: conversation.id, externalId: `pers-${conversation.id}-${Math.random()}`,
      direction: "RECEBIDA", status: "RECEBIDA", type: "text", text, occurredAt: new Date(),
    },
  });
}

test("resposta de Knowledge sai exatamente igual, mesmo com Personalidade rígida configurada e Bot autorizado a usar IA externa (sem credencial real -> LOCAL_FALLBACK)", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Relogio`, status: "ACTIVE", channel: "META", autoReplyEnabled: true,
      // externalAiFallbackEnabled=true só prova que, MESMO autorizado a
      // tentar IA externa, sem credencial cadastrada o resultado cai no
      // provider LOCAL_FALLBACK (ver get-ai-provider.js) e a personalidade
      // nunca reescreve nada — o texto da Base de Conhecimento sai intacto.
      featureFlags: { knowledgeBaseEnabled: true, externalAiFallbackEnabled: true, externalAiProvider: "ANTHROPIC" },
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{
        name: "Duvida sobre NFC", active: true, priority: 1,
        examples: { create: [{ text: "esse relogio tem nfc" }] },
      }] },
      personality: {
        create: {
          preset: "PERSONALIZADO", assistantName: "Assistente Rigoroso",
          forbiddenBehaviors: ["inventar qualquer especificação de produto"],
          mandatoryBehaviors: ["citar a fonte oficial"],
        },
      },
    },
  });
  await prisma.knowledgeSource.create({
    data: {
      title: "Personalidade Orq Teste NFC", type: "PRODUCT", source: "Manual",
      content: "O modelo GS Pro 2 possui NFC. O modelo GS Lite não possui NFC.",
    },
  });

  const conversation = await seedConversation();
  const message = await addMessage(conversation, "esse relogio tem nfc");
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });

  assert.equal(result.response, "O modelo GS Pro 2 possui NFC. O modelo GS Lite não possui NFC.");
  assert.equal(result.knowledgeSourceTitle, "Personalidade Orq Teste NFC");
  assert.equal(result.personalityApplied, false, "sem credencial externa real, a personalidade nunca reescreve o texto");
});

test("handoff continua funcionando exatamente igual com Personalidade configurada", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Handoff`, status: "ACTIVE", channel: "META", autoReplyEnabled: true,
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      personality: {
        create: { preset: "PERSONALIZADO", assistantName: "Assistente Extrovertido", tone: ["divertido", "informal"] },
      },
    },
  });
  const conversation = await seedConversation();
  const message = await addMessage(conversation, "preciso falar com um atendente");
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });

  assert.equal(result.action, "HANDOFF_HUMAN");
  assert.match(result.response, /encaminhar.*atendente/i);
  assert.equal(result.personalityApplied, false, "HANDOFF_HUMAN nunca é elegível para reescrita de personalidade");
});

test("Bot sem nenhuma linha em BotPersonality continua respondendo normalmente (usa o default por trás, sem quebrar nada)", async () => {
  await cleanup();
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} SemPersonalidade`, status: "ACTIVE", channel: "META", autoReplyEnabled: true,
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: { create: [{
        name: "Saudacao pedido", active: true, priority: 1, responseMessage: "Claro, pode me passar o número do pedido?",
        examples: { create: [{ text: "quero acompanhar meu pedido" }] },
      }] },
    },
  });
  const personalityRow = await prisma.botPersonality.findUnique({ where: { botId: bot.id } });
  assert.equal(personalityRow, null);

  const conversation = await seedConversation();
  const message = await addMessage(conversation, "quero acompanhar meu pedido");
  const result = await orchestrate({ conversationId: conversation.id, messageId: message.id, message: message.text });

  assert.equal(result.response, "Claro, pode me passar o número do pedido?");
  assert.equal(result.personalityApplied, false);
});
