require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const prisma = require("../src/database/prisma");
const flow = require("../src/services/bot-flow-service");

const prefix = "Flow Review Teste";
let botA;
let botB;

async function createBot(name) {
  return prisma.bot.create({
    data: {
      name,
      channel: "META",
      status: "ACTIVE",
      initialMessage: "Olá",
      outsideHoursMessage: "Fora do horário",
      fallbackMessage: "Não entendi",
      intents: { create: [{ name: `${name} intenção`, active: true, priority: 1 }] },
    },
    include: { intents: true },
  });
}

async function cleanup() {
  await prisma.knowledgeSource.deleteMany({ where: { title: { startsWith: prefix } } });
  await prisma.bot.deleteMany({ where: { name: { startsWith: prefix } } });
}

test.before(async () => {
  await cleanup();
  botA = await createBot(`${prefix} Bot A`);
  botB = await createBot(`${prefix} Bot B`);
});

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("CRUD valida campos obrigatórios por ação e normaliza maxAttempts inteiro", async () => {
  const intentId = botA.intents[0].id;
  const invalid = [
    { name: "Pergunta", action: "ASK_QUESTION" },
    { name: "Tool", action: "QUERY_TOOL" },
    { name: "Resposta", action: "RESPOND" },
    { name: "Desvio", action: "GOTO_STEP" },
  ];
  for (const input of invalid) {
    await assert.rejects(() => flow.createFlowStep(intentId, input), (error) => error.statusCode === 400);
  }

  const step = await flow.createFlowStep(intentId, {
    name: "Pergunta válida", action: "ASK_QUESTION", question: "Qual é o modelo?", maxAttempts: 2.8,
  });
  assert.equal(step.maxAttempts, 2);
});

test("fonte vinculada a outro Bot é rejeitada no cadastro e nunca usada em execução", async () => {
  const source = await prisma.knowledgeSource.create({
    data: {
      title: `${prefix} Restrita`, type: "GENERAL", source: "Manual interno",
      content: "SEGREDO-EXCLUSIVO-BOT-A", botAccesses: { create: [{ botId: botA.id }] },
    },
  });
  const intentB = botB.intents[0];

  await assert.rejects(() => flow.createFlowStep(intentB.id, {
    name: "Conhecimento proibido", action: "USE_KNOWLEDGE", knowledgeSourceId: source.id,
  }), (error) => error.statusCode === 400 && /não está disponível/.test(error.message));

  await prisma.botFlowStep.create({
    data: { intentId: intentB.id, name: "Registro legado inválido", order: 1, action: "USE_KNOWLEDGE", knowledgeSourceId: source.id },
  });
  const result = await flow.startFlow({ bot: botB, intent: intentB, channel: "META", mode: "OBSERVATION" });
  assert.equal(result.terminal, "HANDOFF");
  assert.doesNotMatch(result.responseText, /SEGREDO-EXCLUSIVO-BOT-A/);
});

test("reordenação rejeita IDs duplicados e etapas de outra intenção", async () => {
  const intentA = botA.intents[0].id;
  const intentB = botB.intents[0].id;
  const stepA = await flow.createFlowStep(intentA, { name: "Final A", action: "RESOLVED" });
  const stepB = await flow.createFlowStep(intentB, { name: "Final B", action: "RESOLVED" });

  await assert.rejects(() => flow.reorderFlowSteps(intentA, [stepA.id, stepA.id]), (error) => error.statusCode === 400);
  await assert.rejects(() => flow.reorderFlowSteps(intentA, [stepB.id]), (error) => error.statusCode === 400);
});

test("formulário exige dinamicamente os campos específicos de cada ação", () => {
  const js = fs.readFileSync(path.join(process.cwd(), "public", "js", "bots.js"), "utf8");
  assert.match(js, /flow-step-question"\)\.required = action === "ASK_QUESTION"/);
  assert.match(js, /flow-step-tool"\)\.required = action === "QUERY_TOOL"/);
  assert.match(js, /flow-step-response"\)\.required = action === "RESPOND"/);
  assert.match(js, /flow-step-goto"\)\.required = action === "GOTO_STEP"/);
});
