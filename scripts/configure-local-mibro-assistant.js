// Applies ONLY to the isolated QA database; never reads credentials or writes to production.
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const LOCAL_URL = "postgresql://bot_qa:isolated-local-qa@127.0.0.1:25432/bot_qa";
const { prepareAnswers, buildPostTriageAssistantGraph } = require("../src/services/mibro-assistant-question-answer");
const { validateGraph } = require("../src/services/bot-visual-flow-graph");

async function configureLocalAssistant({ activate = false } = {}) {
  if (process.env.DATABASE_URL !== LOCAL_URL) throw new Error("Configuração permitida somente no banco local bot_qa.");
  const prisma = require("../src/database/prisma");
  const raw = execFileSync("docker", ["exec", "mibro-bot-qa-20261005b", "psql", "-U", "bot_qa", "-d", "bot_knowledge_reference_20261005", "-At", "-c",
    `SELECT COALESCE(json_agg(json_build_object('id',"id",'title',"title",'type',"type",'product',"product",'content',"content",'active',"active",'validFrom',"validFrom",'validUntil',"validUntil")),'[]') FROM "KnowledgeSource"`], { encoding: "utf8" });
  const sources = JSON.parse(raw), prepared = prepareAnswers(sources);
  const graph = buildPostTriageAssistantGraph({ products: prepared.products, availableKeys: new Set(prepared.answers.map((answer) => answer.key)) });
  const validated = validateGraph(graph, { responseKeys: new Set(prepared.answers.map((answer) => answer.key)) });
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  const hash = createHash("sha256").update(JSON.stringify({ graph: validated.graph, answers: prepared.answers })).digest("hex");
  const bot = await prisma.bot.findUnique({ where: { id: "mibro-assistant-observer" } });
  if (!bot) throw new Error("Assistente Mibro Brasil não existe no banco de teste.");
  const existingFlow = await prisma.botFlow.findFirst({ where: { botId: bot.id, isDefault: true, archivedAt: null }, include: { activeVersion: true } });
  let flowId = existingFlow?.id;
  if (bot.featureFlags?.assistantKnowledgeHash !== hash || !existingFlow?.activeVersion?.graph?.nodes?.some((node) => node.type === "start" && node.config?.trigger === "AFTER_TRIAGE")) {
    await prisma.$transaction(async (tx) => {
      for (const answer of prepared.answers) {
        const data = { title: answer.title, text: answer.text, category: "GERAL", active: true };
        await tx.botResponse.upsert({ where: { key: answer.key }, update: data, create: { key: answer.key, ...data } });
      }
      await tx.botFlow.updateMany({ where: { botId: bot.id, archivedAt: null }, data: { isDefault: false, status: "INACTIVE", archivedAt: new Date() } });
      const flow = await tx.botFlow.create({ data: { botId: bot.id, name: "Assistência após Triagem", description: "Respostas curtas da base anterior, sem IA ou consultas fictícias", draftGraph: validated.graph, isDefault: true } });
      const version = await tx.botFlowVersion.create({ data: { flowId: flow.id, version: 1, graph: validated.graph, label: "Base anterior + assistência no setor escolhido" } });
      await tx.botFlow.update({ where: { id: flow.id }, data: { activeVersionId: version.id, status: "ACTIVE" } });
      await tx.bot.update({ where: { id: bot.id }, data: {
        description: "Atende após a Triagem no setor escolhido, identifica o assunto e oferece respostas curtas da base cadastrada; chama a equipe quando necessário.",
        initialMessage: "Olá! Sou o Assistente Mibro Brasil. Vou ajudar com sua dúvida antes de chamar nossa equipe, se necessário.",
        runOnNewConversation: false,
        featureFlags: { ...(bot.featureFlags || {}), assistantAfterTriage: true, assistantKnowledgeHash: hash, assistantKnowledgeBackup: "pre-layout-20261002-01.dump", assistantKnowledgeSources: sources.filter((source) => prepared.answers.some((answer) => answer.sourceIds.includes(source.id))).map((source) => ({ id: source.id, title: source.title, hash: createHash("sha256").update(source.content).digest("hex") })) },
      } });
      flowId = flow.id;
    });
  }
  if (activate) {
    // Explicit local demo activation; no boot migration activates the production Assistant.
    await prisma.bot.updateMany({ where: { id: { in: ["system-triage-bot", bot.id] } }, data: { autoReplyEnabled: true, status: "ACTIVE" } });
    await prisma.botGlobalSettings.upsert({ where: { id: "singleton" }, update: { automationEnabled: true }, create: { id: "singleton", automationEnabled: true } });
  }
  return { sources: sources.length, answers: prepared.answers.length, products: prepared.products.length, flowId };
}
module.exports = { configureLocalAssistant };
if (require.main === module) {
  process.env.DATABASE_URL = LOCAL_URL;
  configureLocalAssistant({ activate: true }).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => require("../src/database/prisma").$disconnect());
}
