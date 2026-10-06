// Isolated preview: no production database, no background workers, no sending channels.
process.env.DATABASE_URL = "postgresql://bot_qa:isolated-local-qa@127.0.0.1:25432/bot_qa";
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "isolated-bot-question-answer-preview-only-20261005";
const prisma = require("../src/database/prisma");
const bcrypt = require("bcryptjs");
const { createApp } = require("../src/app");
const { ensureQuestionAnswerBots } = require("../src/services/flow-builder-migration-service");
(async () => {
  await ensureQuestionAnswerBots();
  await require("./configure-local-mibro-assistant").configureLocalAssistant({ activate: true });
  await prisma.user.upsert({ where: { email: "bot-qa@teste.local" }, update: {}, create: { name: "Master QA local", email: "bot-qa@teste.local", role: "ADMIN", passwordHash: await bcrypt.hash("teste-local-bots", 4) } });
  const disabled = new Proxy({}, { get: () => async () => { throw new Error("Envio real bloqueado na prévia local."); } });
  const server = createApp({ channel: disabled }).listen(3339, "127.0.0.1", () => console.log("Prévia isolada: http://127.0.0.1:3339/bots.html"));
  process.on("SIGINT", () => server.close(async () => { await prisma.$disconnect(); process.exit(0); }));
})().catch(async (error) => { console.error(error.message); await prisma.$disconnect(); process.exitCode = 1; });
