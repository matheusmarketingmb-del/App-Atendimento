// Regressão AO VIVO do caminho REAL de decisão de envio — chama
// shadowIncomingMessage() de verdade (Prisma + RAG Server real), com
// { simulateAutoReplyEnabled: true } (nunca persiste isso no Bot real).
// Precisa do rag/rag_server.py rodando em 127.0.0.1:8992.
//
// Uso: node scripts/send-decision-regression-live.js
require("dotenv").config();
const prisma = require("../src/database/prisma");
const { shadowIncomingMessage } = require("../src/services/bot-ai-shadow-service");
const { checkOnce } = require("../src/services/local-ai-status-service");

const botName = "Bot Send Decision Regression Live";
const externalId = "send-decision-regression-live-contact";

async function cleanup() {
  await prisma.bot.deleteMany({ where: { name: botName } });
  await prisma.contact.deleteMany({ where: { externalId } });
}

async function seedBot() {
  const category = await prisma.category.findFirst();
  return prisma.bot.create({
    data: {
      name: botName, status: "ACTIVE", channel: "META", initialMessage: "Olá!",
      outsideHoursMessage: "Fora do horário.", fallbackMessage: "Não entendi.",
      defaultCategoryId: category?.id || null,
      // autoReplyEnabled=false no registro real — os testes usam
      // simulateAutoReplyEnabled=true, nunca este valor persistido.
      autoReplyEnabled: false,
      featureFlags: { useAi: true, aiMode: "PRIMARY", aiProvider: "LOCAL_QWEN" },
    },
  });
}

async function seedConversationWithHistory(botId, turns) {
  const contact = await prisma.contact.create({ data: { externalId, phone: "5511999990000", name: "Cliente Regressão" } });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
  await prisma.conversationBotState.create({ data: { conversationId: conversation.id, activeBotId: botId } });

  let lastMessage = null;
  const base = Date.now();
  for (const [index, turn] of turns.entries()) {
    lastMessage = await prisma.message.create({
      data: {
        conversationId: conversation.id, externalId: `wamid.${Math.random().toString(36).slice(2)}`,
        direction: turn.role === "customer" ? "RECEBIDA" : "ENVIADA",
        status: turn.role === "customer" ? "RECEBIDA" : "ENVIADA",
        // Timestamps crescentes garantem ordem determinística — vários
        // inserts no mesmo milissegundo quebrariam getRecentContext (que
        // ordena por occurredAt).
        type: "text", text: turn.content, occurredAt: new Date(base + index * 1000),
      },
    });
  }
  return { contact, conversation, lastMessage };
}

const CASES = [
  ["CASO 1: 'meu GS Pro 2 não carrega'", [{ role: "customer", content: "meu GS Pro 2 não carrega" }],
    (r) => ["WAIT", "ASK", "RESPOND"].includes(r.action) && r.confidence !== "LOW" && r.needsHuman === false],
  ["CASO 2: 'quero falar com uma pessoa'", [{ role: "customer", content: "quero falar com uma pessoa" }],
    (r) => r.action === "HANDOFF" && r.needsHuman === true && r.sendDecision.shouldSend === false],
  ["CASO 3: 'meu relógio está quente e a tela levantou'", [{ role: "customer", content: "meu relógio está quente e a tela levantou" }],
    (r) => r.action === "HANDOFF" && r.needsHuman === true && r.sendDecision.shouldSend === false],
  ["CASO 4: 'GS Pro 2 tem GPS L1 + L5?'", [{ role: "customer", content: "GS Pro 2 tem GPS L1 + L5?" }],
    (r) => r.action === "RESPOND" && r.sendDecision.shouldSend === true],
  ["CASO 5: 'Explorer S faz pagamento por aproximação?'", [{ role: "customer", content: "Explorer S faz pagamento por aproximação?" }],
    (r) => r.confidence !== "HIGH" && (r.confidence !== "LOW" || r.sendDecision.shouldSend === false)],
  ["CASO 6: 'quanto custa o Lite 3 Pro?'", [{ role: "customer", content: "quanto custa o Lite 3 Pro?" }],
    (r) => !/r\$\s?\d/i.test(r.response)],
  ["CASO 9: answer vazio (simulado via força de action inválida não se aplica aqui — validado via unit test dedicado)", null, () => true],
  ["CASO 10: action=RESOLVE após troubleshooting", [
    { role: "customer", content: "meu GS Pro 2 não carrega" },
    { role: "assistant", content: "Confira se os contatos do relógio e do carregador estão limpos e secos." },
    { role: "customer", content: "funcionou" },
  ], (r) => r.action === "RESOLVE" && r.sendDecision.shouldSend === false],
  ["SEÇÃO 11: histórico — 'GS Pro 2' após pergunta de modelo continua em charging", [
    { role: "customer", content: "meu relógio não carrega" },
    { role: "assistant", content: "Qual é o modelo?" },
    { role: "customer", content: "GS Pro 2" },
  ], (r) => (r.intent === "charging" || r.product === "GS Pro 2")],
];

async function main() {
  // Sem o poller de src/app.js rodando neste script isolado, localAiStatus
  // nunca fica ONLINE sozinho — checa uma vez manualmente antes dos casos.
  await checkOnce();
  await cleanup();
  const bot = await seedBot();
  let passed = 0;
  const failures = [];

  for (const [label, turns, check] of CASES) {
    if (!turns) { console.log(`SKIP ${label}`); continue; }
    const { conversation, lastMessage } = await seedConversationWithHistory(bot.id, turns);
    const lastTurn = turns[turns.length - 1];
    const event = { type: "text", text: lastTurn.content };
    const result = await shadowIncomingMessage(event, lastMessage, { simulateAutoReplyEnabled: true });

    const ok = result && check(result);
    console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
    if (result) {
      console.log(
        `      action=${result.action} confidence=${result.confidence} needsHuman=${result.needsHuman} `
        + `reason=${result.reason} shouldSend=${result.sendDecision?.shouldSend} sendMode=${result.sendDecision?.sendMode} `
        + `blockedReason=${result.sendDecision?.reason}`,
      );
      console.log(`      resposta: ${(result.response || "").slice(0, 150)}`);
      if (result.sendDecision?.simulated) {
        console.log(`      [DRY_RUN confirmado] wouldSend=${result.sendDecision.simulated.wouldSend} channel=${result.sendDecision.simulated.channel}`);
      }
    } else {
      console.log("      shadowIncomingMessage devolveu null");
    }
    if (ok) passed += 1; else failures.push(label);

    await prisma.conversationBotState.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.botAiShadowLog.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } });
    await prisma.conversation.deleteMany({ where: { id: conversation.id } });
    await prisma.contact.deleteMany({ where: { externalId } });
  }

  console.log(`\n${passed}/${CASES.filter(([, turns]) => turns).length} cenários passaram.`);
  await cleanup();
  await prisma.$disconnect();
  if (failures.length) process.exit(1);
}

main().catch(async (error) => { console.error(error); await cleanup(); process.exit(1); });
