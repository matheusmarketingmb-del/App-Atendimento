// Garantias da migração: Flow Builder é o ÚNICO modelo de Bot — nada de
// Legacy, IA, RAG, Planner, Knowledge, provider/model ou shadow no runtime,
// na API ou na interface. O app sobe e o Bot funciona sem IA/RAG/Ollama.
require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const prisma = require("../src/database/prisma");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const email = "fbonly-master@teste.local";

function listFiles(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? listFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
  ));
}

test.after(async () => {
  await prisma.bot.deleteMany({ where: { name: { startsWith: "fbonly" } } });
  await prisma.user.deleteMany({ where: { email } });
  await prisma.$disconnect();
});

test("runtime: nenhum módulo de IA/RAG/Planner/Knowledge/Shadow/Legacy existe ou é carregado", () => {
  const removed = [
    "src/services/ai", "src/services/bot-tools", "src/services/bot-knowledge",
    "src/services/bot-ai-shadow-service.js", "src/services/bot-ai-gate-service.js", "src/services/bot-agent-planner-service.js",
    "src/services/bot-orchestrator-service.js", "src/services/bot-interpreter-service.js", "src/services/bot-observation-service.js",
    "src/services/bot-learning-service.js", "src/services/triage-bot-service.js", "src/services/local-ai-status-service.js",
    "src/services/bot-knowledge-source-service.js", "src/services/bot-flow-service.js", "src/controllers/local-ai-controller.js",
    "public/knowledge-base.html", "public/js/knowledge-base.js",
  ];
  for (const file of removed) assert.equal(fs.existsSync(path.join(root, file)), false, `${file} deveria ter sido removido do runtime`);
  for (const file of ["_archive/bot-legacy/BOT_LEGACY_ARCHIVE.md", "_archive/bot-legacy/code/src/services/ai/local-qwen-provider.js", "_archive/bot-legacy/code/rag/rag_server.py"]) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} deveria estar preservado no arquivo`);
  }

  require("../src/app");
  require("../src/services/flow-builder-migration-service");
  const loaded = Object.keys(require.cache).map((file) => path.relative(root, file).replace(/\\/g, "/"));
  const forbidden = loaded.filter((file) => /^src\/services\/(ai\/|bot-ai-|local-ai|bot-orchestrator|bot-interpreter|bot-learning|bot-observation|triage-bot|bot-agent|bot-knowledge|global-intent)/.test(file));
  assert.deepEqual(forbidden, []);
});

test("código ativo não referencia IA/RAG/Ollama/Qwen nem modo Legacy", () => {
  const files = [...listFiles("src"), "server.js", ...listFiles("public/js"), "public/bots.html", "public/flow-builder.html", "public/index.html"]
    .filter((file) => /\.(js|html)$/.test(file));
  const offenders = [];
  for (const file of files) {
    const content = read(file);
    for (const pattern of [/qwen/i, /ollama/i, /rag_server|RAG Server/, /LOCAL_QWEN/, /getAiProvider|get-ai-provider/, /shadowIncomingMessage|BotAiShadowLog\b(?!.*deprecated)/, /knowledge-sources/, /\/api\/local-ai/, /executionMode\s*===?\s*"LEGACY"/, /Modelo clássico/i]) {
      if (pattern.test(content)) offenders.push(`${file} ~ ${pattern}`);
    }
  }
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(read("server.js"), /local-ai|localAiStatus/);
});

test("dependências: nenhuma biblioteca de IA no package.json", () => {
  const pkg = JSON.parse(read("package.json"));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const name of deps) assert.doesNotMatch(name, /openai|anthropic|gemini|google\/generative|langchain|ollama|chroma/i);
});

test("frontend: tela de Bots não mostra Legacy/IA e o Novo Bot abre direto o Editor Visual", () => {
  const html = read("public/bots.html");
  const js = read("public/js/bots.js");
  for (const forbidden of [/LEGACY"|executionMode/, /Chaves de IA|ai-keys/, /Observações|Aprendizado|Ranking/, /Personalidade|Intenç/, /provider|aiModel|aiMode|requiresAi|Planner|Shadow/i, /Base de conhecimento/]) {
    assert.doesNotMatch(html, forbidden);
    assert.doesNotMatch(js, forbidden);
  }
  assert.match(html, /Novo Bot/);
  assert.match(js, /location\.href = editorUrl\(bot\.id, bot\.createdFlowId\)/);
  const editor = read("public/js/flow-builder.js");
  assert.doesNotMatch(editor, /execution-mode|toggleExecutionMode|AI_MODES|aiProviders|sendAnswer/);
  assert.doesNotMatch(read("public/flow-builder.html"), /Usar Editor Visual|dry-run da IA|Respostas geradas por IA/);
  assert.doesNotMatch(read("public/index.html"), /bot-suggestion|Analisar para aprendizado|knowledge-base-button/);
});

test("API: cria Bot só no Flow Builder, rotas antigas não existem mais e o simulador funciona sem IA", async () => {
  const { createApp } = require("../src/app");
  await prisma.user.deleteMany({ where: { email } });
  await prisma.user.create({ data: { companyAccess: { create: { companyId: "cmp_mibro" } }, name: "Master FB Only", email, role: "ADMIN", passwordHash: await bcrypt.hash("senha-segura-123", 4) } });
  const channel = new Proxy({}, { get: () => () => { throw new Error("nunca deveria chamar o canal real"); } });
  const server = createApp({ channel }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "senha-segura-123" }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const call = (url, options = {}) => fetch(`${base}${url}`, { ...options, headers: { "Content-Type": "application/json", Cookie: cookie } });

    const created = await call("/api/bots", { method: "POST", body: JSON.stringify({ companyId: "cmp_mibro", name: "fbonly Bot", channels: ["META"], executionMode: "LEGACY" }) });
    assert.equal(created.status, 201);
    const bot = await created.json();
    assert.ok(bot.createdFlowId);
    assert.equal((await prisma.bot.findUnique({ where: { id: bot.id } })).executionMode, "FLOW_BUILDER");

    for (const [method, url] of [
      ["PATCH", `/api/bots/${bot.id}/execution-mode`], ["POST", `/api/bots/${bot.id}/simulate`], ["GET", "/api/local-ai/status"],
      ["GET", "/api/knowledge-sources"], ["GET", "/api/bot-ai-providers"], ["GET", "/api/bot-ai-credentials"], ["GET", "/api/bot-observations"],
      ["GET", "/api/bot-learning/suggestions"], ["GET", "/api/global-intents"], ["GET", "/api/bots/intents"], ["GET", `/api/conversations/x/bot-suggestion`],
    ]) {
      const response = await call(url, { method, ...(method === "GET" ? {} : { body: "{}" }) });
      assert.equal(response.status, 404, `${method} ${url} ainda responde (${response.status})`);
    }

    const options = await (await call(`/api/bots/${bot.id}/visual-flow-options`)).json();
    assert.ok(!options.nodeTypes.some((item) => ["ai", "knowledge", "classify_intent"].includes(item.type)));
    assert.equal(options.aiProviders, undefined);

    const simulated = await call(`/api/bots/${bot.id}/visual-flows/${bot.createdFlowId}/simulate`, { method: "POST", body: JSON.stringify({ message: "oi" }) });
    assert.equal(simulated.status, 200);
    const result = await simulated.json();
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.dryRun, true);

    const autoReply = await call(`/api/bots/${bot.id}/auto-reply`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
    assert.equal(autoReply.status, 400, "sem fluxo publicado não liga a resposta automática");
    const publish = await call(`/api/bots/${bot.id}/visual-flows/${bot.createdFlowId}/publish`, { method: "POST", body: "{}" });
    assert.equal(publish.status, 200);
    assert.equal((await call(`/api/bots/${bot.id}/auto-reply`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })).status, 200);

    for (const page of ["/bots", "/flow-builder"]) assert.equal((await call(page)).status, 200);
    for (const page of ["/knowledge-base", "/knowledge-base.html", "/js/knowledge-base.js"]) assert.equal((await call(page)).status, 404, page);
  } finally {
    server.close();
  }
});
