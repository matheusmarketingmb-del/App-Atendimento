require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { observeIncomingMessage } = require("../src/services/bot-observation-service");
const quickReplies = require("../src/services/quick-reply-service");

const botNamePrefix = "QR Obs Bot";
const externalId = "qr-observation-contact";
let master;

async function cleanup() {
  await prisma.botObservation.deleteMany({ where: { botName: { startsWith: botNamePrefix } } });
  await prisma.conversationBotState.deleteMany({});
  await prisma.bot.deleteMany({ where: { name: { startsWith: botNamePrefix } } });
  await prisma.contact.deleteMany({ where: { externalId } });
  await prisma.quickReply.deleteMany({ where: { name: { startsWith: "QR Obs" } } });
}

test.before(async () => {
  master = await prisma.user.upsert({
    where: { email: "qr-obs-master@teste.local" }, update: {},
    create: { email: "qr-obs-master@teste.local", name: "Master QR Obs", role: "ADMIN", passwordHash: "x" },
  });
  await cleanup();
});

test.after(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { email: "qr-obs-master@teste.local" } });
  await prisma.$disconnect();
});

test("Observação anota qual Resposta Rápida o Bot teria sugerido, mas nunca envia nada", async () => {
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} Ativo`, status: "ACTIVE", channel: "META",
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
      intents: {
        create: [{
          name: "Acompanhar pedido", priority: 1, active: true, fallbackAction: "USE_BOT_FALLBACK",
          examples: { create: [{ text: "onde está meu pedido" }] },
        }],
      },
    },
    include: { intents: true },
  });

  const quickReply = await quickReplies.createQuickReply({
    name: "QR Obs Sugestão", shortcut: "/qrobssugestao", text: "Pode me informar o número do pedido?",
    availableToBots: true, intentIds: [bot.intents[0].id],
  }, master);

  const contact = await prisma.contact.create({ data: { externalId, phone: "5511900000099", name: "Cliente Obs" } });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id, channel: "META" } });
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id, channel: "META", direction: "RECEBIDA", status: "RECEBIDA",
      type: "text", text: "onde está meu pedido", occurredAt: new Date(),
    },
  });

  const result = await observeIncomingMessage(
    { type: "text", text: "onde está meu pedido" }, message, { now: new Date("2026-08-25T14:00:00.000Z") },
  );
  assert.ok(result, "a observação deve rodar normalmente");

  const observation = await prisma.botObservation.findUnique({ where: { messageId: message.id } });
  assert.equal(observation.suggestedQuickReplyId, quickReply.id);
  assert.equal(observation.suggestedQuickReplyName, "QR Obs Sugestão");

  // Nunca envia: nenhuma mensagem ENVIADA foi criada a partir da observação.
  const sentMessages = await prisma.message.count({ where: { conversationId: conversation.id, direction: "ENVIADA" } });
  assert.equal(sentMessages, 0);

  await prisma.bot.delete({ where: { id: bot.id } });
});

test("Observação sem intenção reconhecida não quebra e não anota sugestão", async () => {
  const bot = await prisma.bot.create({
    data: {
      name: `${botNamePrefix} SemIntent`, status: "ACTIVE", channel: "META",
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    },
  });
  const contact = await prisma.contact.create({ data: { externalId: `${externalId}-2`, phone: "5511900000098", name: "Cliente Obs 2" } });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id, channel: "META" } });
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id, channel: "META", direction: "RECEBIDA", status: "RECEBIDA",
      type: "text", text: "mensagem qualquer sem intenção reconhecida", occurredAt: new Date(),
    },
  });

  const result = await observeIncomingMessage(
    { type: "text", text: "mensagem qualquer sem intenção reconhecida" }, message, { now: new Date("2026-08-25T14:00:00.000Z") },
  );
  assert.ok(result);
  const observation = await prisma.botObservation.findUnique({ where: { messageId: message.id } });
  assert.equal(observation.suggestedQuickReplyId, null);

  await prisma.bot.delete({ where: { id: bot.id } });
  await prisma.contact.deleteMany({ where: { externalId: `${externalId}-2` } });
});
