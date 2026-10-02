require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const prisma = require("../src/database/prisma");

test.before(async () => {
  await prisma.botObservation.deleteMany();
  await prisma.conversationBotState.deleteMany();
  await prisma.bot.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.user.deleteMany();
});

test("simulador nunca chama o canal real da Meta e mantém contexto entre mensagens (multi-turno)", async () => {
  let channelCalls = 0;
  const channel = new Proxy({}, { get: () => () => { channelCalls += 1; throw new Error("o simulador nunca deve chamar o canal real"); } });
  const server = createApp({ channel }).listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const setup = await fetch(`${base}/api/auth/setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Master Bots", email: "master-bots@teste.local", password: "senha-segura-123" }),
    });
    assert.equal(setup.status, 201);
    const cookie = setup.headers.get("set-cookie").split(";")[0];

    const createBot = await fetch(`${base}/api/bots`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bot Simulador HTTP", channel: "META", initialMessage: "Olá!",
        outsideHoursMessage: "Fora do horário.", fallbackMessage: "Não entendi.",
      }),
    });
    assert.equal(createBot.status, 201);
    const bot = await createBot.json();

    await fetch(`${base}/api/bots/${bot.id}/intents`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Acompanhar pedido", responseMessage: "Pode informar o número do pedido?",
        examples: ["onde esta meu pedido"],
      }),
    });
    await fetch(`${base}/api/bots/${bot.id}/status`, {
      method: "PATCH", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ACTIVE" }),
    });

    const first = await fetch(`${base}/api/bots/${bot.id}/simulate`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "esta meu pedido chegando" }),
    });
    assert.equal(first.status, 200);
    const firstResult = await first.json();
    assert.equal(firstResult.sent, false);
    assert.equal(firstResult.intentName, "Acompanhar pedido");
    assert.equal(firstResult.action, "ASK_CLARIFICATION");
    assert.ok(firstResult.nextState);
    assert.equal(firstResult.nextState.pendingClarification, true);

    const second = await fetch(`${base}/api/bots/${bot.id}/simulate`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "sim",
        state: firstResult.nextState,
        history: [{ direction: "RECEBIDA", text: "esta meu pedido chegando" }, { direction: "ENVIADA", text: firstResult.response }],
      }),
    });
    assert.equal(second.status, 200);
    const secondResult = await second.json();
    assert.equal(secondResult.intentId, firstResult.intentId, "o contexto de 'sim' deve manter a intenção anterior");
    assert.equal(secondResult.action, "RESPOND", "a confirmação deve concluir o esclarecimento");

    const invalidConfidence = await fetch(`${base}/api/bot-observations?minConfidence=abc`, { headers: { Cookie: cookie } });
    assert.equal(invalidConfidence.status, 400);

    const oversized = await fetch(`${base}/api/bots/${bot.id}/simulate`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "x".repeat(4001) }),
    });
    assert.equal(oversized.status, 400);

    assert.equal(channelCalls, 0, "o simulador não pode ter chamado o canal real da Meta em nenhum momento");

    const conversationCount = await prisma.conversation.count();
    assert.equal(conversationCount, 0, "o simulador não deve criar conversas reais");

    const observations = await fetch(`${base}/api/bot-observations`, { headers: { Cookie: cookie } });
    assert.equal(observations.status, 200);
    const rows = await observations.json();
    assert.equal(rows.length, 0, "o simulador não persiste em BotObservation (isso é exclusivo do modo observação real)");
  } finally {
    server.close();
    await prisma.bot.deleteMany({ where: { name: "Bot Simulador HTTP" } });
    await prisma.user.deleteMany({ where: { email: "master-bots@teste.local" } });
    await prisma.$disconnect();
  }
});
