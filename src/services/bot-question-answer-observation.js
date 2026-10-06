const prisma = require("../database/prisma");
const { assertBotManager } = require("./bot-governance-service");

function summarizeLogs(logs) {
  const botTimes = [], customerTimes = [], options = new Map(), unmatchedByExecution = new Map();
  for (const log of logs) {
    if (Number.isFinite(log.output?.botResponseMs)) botTimes.push(log.output.botResponseMs);
    if (Number.isFinite(log.output?.customerReplyMs)) customerTimes.push(log.output.customerReplyMs);
    if (log.nodeType === "menu" && log.output?.option && !log.output?.quality) {
      const key = `${log.nodeKey}:${log.output.option}`;
      const item = options.get(key) || { node: log.nodeKey, option: log.output.option, count: 0 };
      item.count += 1; options.set(key, item);
    }
    if (log.nodeType === "menu" && log.input && log.output?.attempts && !log.output?.quality) unmatchedByExecution.set(log.executionId, (unmatchedByExecution.get(log.executionId) || 0) + 1);
  }
  const timing = (values) => ({ samples: values.length, averageMs: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null });
  return { botResponse: timing(botTimes), customerReply: timing(customerTimes),
    unmatchedMessages: [...unmatchedByExecution.values()].reduce((a, b) => a + b, 0),
    repeatedUnmatchedConversations: [...unmatchedByExecution.values()].filter((count) => count >= 3).length,
    mostUsedOptions: [...options.values()].sort((a, b) => b.count - a.count).slice(0, 20),
  };
}

async function observation(botId, viewer) {
  assertBotManager(viewer);
  const { ensureBot } = require("./bot-service");
  await ensureBot(botId);
  const from = new Date(Date.now() - 30 * 86400000);
  const logs = await prisma.botFlowExecutionLog.findMany({ where: { execution: { botId }, createdAt: { gte: from } }, orderBy: { createdAt: "desc" }, take: 10001,
    select: { nodeKey: true, nodeType: true, input: true, output: true, executionId: true } });
  const ratings = await prisma.botRating.findMany({ where: { botId, createdAt: { gte: from } }, select: { score: true } });
  return { periodDays: 30, limited: logs.length > 10000, ...summarizeLogs(logs.slice(0, 10000)),
    ratings: { count: ratings.length, average: ratings.length ? ratings.reduce((sum, item) => sum + item.score, 0) / ratings.length : null } };
}

// Survey stays in the same persisted execution; no AI, external APIs or fabricated metrics.
function withQuality(graph, bot) {
  if (!bot.ratingEnabled || bot.requestRatingOn === "HANDOFF") return graph;
  const copy = JSON.parse(JSON.stringify(graph));
  for (const node of [...copy.nodes].filter((item) => item.type === "end" && !item.key.startsWith("quality_"))) {
    const originalKey = node.key;
    node.key = `quality_end_${originalKey}`;
    const scoreKey = originalKey;
    copy.nodes.push({ key: scoreKey, type: "menu", name: "Avaliação", config: { text: bot.ratingMessage || "Como você avalia o atendimento? Escolha de 1 a 5.", variable: "flow.ratingScore", display: "TEXT", maxAttempts: 3, options: [1, 2, 3, 4, 5].map((score) => ({ id: `score${score}`, label: String(score) })) } });
    const target = bot.requestRatingComment ? `quality_comment_${originalKey}` : `quality_followup_${originalKey}`;
    for (let score = 1; score <= 5; score++) copy.edges.push({ id: `quality_${originalKey}_${score}`, source: scoreKey, sourceHandle: `opt:score${score}`, target });
    if (bot.requestRatingComment) {
      copy.nodes.push({ key: target, type: "question", name: "Comentário", config: { text: "Quer deixar um comentário? Escreva aqui ou envie ‘pular’.", variable: "flow.ratingComment", answerType: "TEXT", maxAttempts: 3 } });
      copy.edges.push({ id: `${target}:next`, source: target, sourceHandle: "next", target: `quality_followup_${originalKey}` });
    }
    copy.nodes.push({ key: `quality_followup_${originalKey}`, type: "message", name: "Obrigado", config: { source: "TEXT", text: bot.ratingFollowupMessage || "Obrigado pela sua avaliação!" } });
    copy.edges.push({ id: `quality_followup_${originalKey}:next`, source: `quality_followup_${originalKey}`, sourceHandle: "next", target: node.key });
    copy.edges.push({ id: `quality_invalid_${originalKey}`, source: scoreKey, sourceHandle: "invalid", target: node.key });
  }
  return copy;
}

module.exports = { observation, summarizeLogs, withQuality };
