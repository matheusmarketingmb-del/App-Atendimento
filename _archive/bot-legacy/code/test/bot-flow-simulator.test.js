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
  await prisma.user.deleteMany({ where: { email: { in: ["master-flow@teste.local", "agente-flow@teste.local"] } } });
});

test.after(async () => {
  await prisma.bot.deleteMany({ where: { name: "Bot Flow Simulador HTTP" } });
  await prisma.user.deleteMany({ where: { email: { in: ["master-flow@teste.local", "agente-flow@teste.local"] } } });
  await prisma.$disconnect();
});

async function startServer() {
  let channelCalls = 0;
  const channel = new Proxy({}, { get: () => () => { channelCalls += 1; throw new Error("o simulador nunca deve chamar o canal real"); } });
  const server = createApp({ channel }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`, channelCalls: () => channelCalls };
}

test("simulador com Fluxo de atendimento: multi-turno até RESOLVED, sem nunca enviar mensagem real", async () => {
  const { server, base, channelCalls } = await startServer();
  try {
    const setup = await fetch(`${base}/api/auth/setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Master Flow", email: "master-flow@teste.local", password: "senha-segura-123" }),
    });
    assert.equal(setup.status, 201);
    const masterCookie = setup.headers.get("set-cookie").split(";")[0];

    const agentCreate = await fetch(`${base}/api/admin/users`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: masterCookie },
      body: JSON.stringify({ name: "Agente Flow", email: "agente-flow@teste.local", password: "senha-segura-123", role: "ATENDENTE" }),
    });
    assert.equal(agentCreate.status, 201);
    const agentLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "agente-flow@teste.local", password: "senha-segura-123" }),
    });
    const agentCookie = agentLogin.headers.get("set-cookie").split(";")[0];

    const createBot = await fetch(`${base}/api/bots`, {
      method: "POST", headers: { Cookie: masterCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bot Flow Simulador HTTP", channel: "META", initialMessage: "Olá!",
        outsideHoursMessage: "Fora do horário.", fallbackMessage: "Não entendi.",
      }),
    });
    assert.equal(createBot.status, 201);
    const bot = await createBot.json();

    const createIntent = await fetch(`${base}/api/bots/${bot.id}/intents`, {
      method: "POST", headers: { Cookie: masterCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Suporte de conexão HTTP", examples: ["fone nao conecta"] }),
    });
    const intent = await createIntent.json();

    // Atendente (não-Master) não pode gerenciar o fluxo — mesma regra do
    // resto do módulo de Bots (assertBotManager).
    const forbidden = await fetch(`${base}/api/bots/${bot.id}/intents/${intent.id}/flow-steps`, {
      method: "POST", headers: { Cookie: agentCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Etapa", action: "RESOLVED" }),
    });
    assert.equal(forbidden.status, 403);

    const stepAsk = await (await fetch(`${base}/api/bots/${bot.id}/intents/${intent.id}/flow-steps`, {
      method: "POST", headers: { Cookie: masterCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Funcionou?", action: "ASK_QUESTION", question: "Funcionou?", maxAttempts: 2 }),
    })).json();
    const stepResolved = await (await fetch(`${base}/api/bots/${bot.id}/intents/${intent.id}/flow-steps`, {
      method: "POST", headers: { Cookie: masterCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Resolvido", action: "RESOLVED", responseMessage: "Que bom!" }),
    })).json();
    const stepHandoff = await (await fetch(`${base}/api/bots/${bot.id}/intents/${intent.id}/flow-steps`, {
      method: "POST", headers: { Cookie: masterCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Encaminhar", action: "HANDOFF_HUMAN", responseMessage: "Vou encaminhar." }),
    })).json();
    await fetch(`${base}/api/bots/${bot.id}/intents/${intent.id}/flow-steps/${stepAsk.id}`, {
      method: "PATCH", headers: { Cookie: masterCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ onSuccessStepId: stepResolved.id, onFailureStepId: stepHandoff.id }),
    });

    const list = await fetch(`${base}/api/bots/${bot.id}/intents/${intent.id}/flow-steps`, { headers: { Cookie: masterCookie } });
    assert.equal((await list.json()).length, 3);

    await fetch(`${base}/api/bots/${bot.id}/status`, {
      method: "PATCH", headers: { Cookie: masterCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ACTIVE" }),
    });

    const first = await fetch(`${base}/api/bots/${bot.id}/simulate`, {
      method: "POST", headers: { Cookie: masterCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "meu fone nao conecta" }),
    });
    const firstResult = await first.json();
    assert.equal(firstResult.sent, false);
    assert.equal(firstResult.response, "Funcionou?");
    assert.equal(firstResult.nextState.activeFlowIntentId, intent.id);
    assert.equal(firstResult.nextState.currentFlowStepId, stepAsk.id);

    const second = await fetch(`${base}/api/bots/${bot.id}/simulate`, {
      method: "POST", headers: { Cookie: masterCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "funcionou, obrigado", state: firstResult.nextState }),
    });
    const secondResult = await second.json();
    assert.equal(secondResult.response, "Que bom!");
    assert.equal(secondResult.nextState.currentFlowStepId, null);
    assert.equal(secondResult.nextState.flowResolutionStatus, "RESOLVED");

    assert.equal(channelCalls(), 0, "o simulador não pode ter chamado o canal real em nenhum momento");
    assert.equal(await prisma.conversation.count(), 0, "o simulador não cria conversas reais");
  } finally {
    server.close();
  }
});

test("reordenar etapas do fluxo via PUT /flow-steps/reorder", async () => {
  const { server, base } = await startServer();
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "master-flow@teste.local", password: "senha-segura-123" }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const botsList = await (await fetch(`${base}/api/bots`, { headers: { Cookie: cookie } })).json();
    const botSummary = botsList.find((item) => item.name === "Bot Flow Simulador HTTP");
    const bot = await (await fetch(`${base}/api/bots/${botSummary.id}`, { headers: { Cookie: cookie } })).json();
    const intentId = bot.intents[0].id;
    const steps = await (await fetch(`${base}/api/bots/${bot.id}/intents/${intentId}/flow-steps`, { headers: { Cookie: cookie } })).json();
    const reordered = [...steps].reverse().map((step) => step.id);

    const response = await fetch(`${base}/api/bots/${bot.id}/intents/${intentId}/flow-steps/reorder`, {
      method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ stepIds: reordered }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.map((step) => step.id), reordered);
  } finally {
    server.close();
  }
});
