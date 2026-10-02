require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const prisma = require("../src/database/prisma");

test.before(async () => {
  await prisma.botLearningSuggestion.deleteMany();
  await prisma.botObservation.deleteMany();
  await prisma.conversationBotState.deleteMany();
  await prisma.bot.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.user.deleteMany();
});

test("rotas de observações e aprendizado respondem autenticadas e nunca tocam no canal real", async () => {
  let channelCalls = 0;
  const channel = new Proxy({}, { get: () => () => { channelCalls += 1; throw new Error("nunca deveria chamar o canal real"); } });
  const server = createApp({ channel }).listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const setup = await fetch(`${base}/api/auth/setup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Master Learning HTTP", email: "master-learning-http@teste.local", password: "senha-segura-123" }),
    });
    assert.equal(setup.status, 201);
    const cookie = setup.headers.get("set-cookie").split(";")[0];

    const obsMetrics = await fetch(`${base}/api/bot-observations/metrics`, { headers: { Cookie: cookie } });
    assert.equal(obsMetrics.status, 200);
    const obsMetricsBody = await obsMetrics.json();
    assert.equal(typeof obsMetricsBody.total, "number");

    const learningMetrics = await fetch(`${base}/api/bot-learning/metrics`, { headers: { Cookie: cookie } });
    assert.equal(learningMetrics.status, 200);
    const learningMetricsBody = await learningMetrics.json();
    assert.equal(typeof learningMetricsBody.pending, "number");

    const suggestions = await fetch(`${base}/api/bot-learning/suggestions`, { headers: { Cookie: cookie } });
    assert.equal(suggestions.status, 200);
    assert.deepEqual(await suggestions.json(), []);

    const analyze = await fetch(`${base}/api/bot-learning/conversations/conversa-inexistente/analyze`, { method: "POST", headers: { Cookie: cookie } });
    assert.equal(analyze.status, 200);
    const analyzeBody = await analyze.json();
    assert.equal(analyzeBody.analyzed, false);
    assert.equal(analyzeBody.reason, "CONVERSATION_NOT_FOUND");

    const withoutAuth = await fetch(`${base}/api/bot-observations/metrics`);
    assert.equal(withoutAuth.status, 401);

    assert.equal(channelCalls, 0);
  } finally {
    server.close();
    await prisma.user.deleteMany({ where: { email: "master-learning-http@teste.local" } });
    await prisma.$disconnect();
  }
});
