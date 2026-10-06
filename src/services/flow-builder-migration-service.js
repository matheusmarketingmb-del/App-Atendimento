// Migração seletiva de Triagem Inicial e Assistente Mibro Brasil.
// Preserva histórico, rascunhos e os estados de ativação existentes.
// Horários e mensagens são lidos da configuração, a cada turno.
const prisma = require("../database/prisma");
const audit = require("./audit-service");
const { validateGraph } = require("./bot-visual-flow-graph");

const ATENDIMENTO_CODE = "ATENDIMENTO";
const ATENDIMENTO_ASK_MESSAGE = "Claro! Me conta rapidinho o que você precisa, assim eu já te direciono para o time certo 🙂";
const ATENDIMENTO_REROUTE_MESSAGE = "Entendido! Vou repassar seu atendimento para o setor correto — um atendente vai falar com você em breve.";
const ATENDIMENTO_ROUTING = [
  { code: "ATACADO", patterns: ["revend", "atacad", "distribuid"] },
  { code: "PARCERIAS", patterns: ["parceria", "parceiro"] },
  { code: "COMERCIAL", patterns: ["compr", "orçament", "orcament", "preç", "prec"] },
  { code: "SUPORTE", patterns: ["problema", "defeito", "quebrad", "não funciona", "nao funciona", "erro"] },
  { code: "GARANTIA", patterns: ["garantia"] },
  { code: "PEDIDOS", patterns: ["pedido", "rastre", "entrega"] },
  { code: "TROCAS_DEVOLUCOES", patterns: ["troca", "devolu", "cancelar"] },
];

// Placeholders do Bot de Triagem -> variáveis do Flow Builder.
function convertTemplate(template, { categoryName } = {}) {
  return String(template || "")
    .replace(/\{\{\s*saudacao_virgula\s*\}\}/g, "{{contact.greetingComma}}")
    .replace(/\{\{\s*saudacao\s*\}\}/g, "{{contact.greeting}}")
    .replace(/\{\{\s*horario\s*\}\}/g, "{{bot.businessHours}}")
    .replace(/\{\{\s*categoria\s*\}\}/g, categoryName || "{{bot.categoryName}}");
}

function buildTriageGraph(bot, categoriesByCode) {
  const allOptions = (bot.triageOptions || []).filter((option) => option.enabled && option.category?.active && !option.category.masterOnly);
  const options = allOptions.filter((option) => !allOptions.some((parent) => parent.category.id === option.category.parentId));
  const nodes = [];
  const edges = [];
  const edge = (source, sourceHandle, target) => edges.push({ id: `${source}:${sourceHandle}->${target}`, source, sourceHandle, target });
  const node = (key, type, name, x, y, config) => nodes.push({ key, type, name, x, y, config });

  node("start", "start", "Início", 40, 260, { trigger: "NEW_CONVERSATION", channels: [], categoryId: null, initialMessage: "" });
  node("menu", "menu", "Menu de setores", 820, 260, {
    text: "{{bot.initialMessage}}", display: "LIST", buttonLabel: "Escolher setor",
    variable: "flow.selectedOption", invalidMessage: "", maxAttempts: 3,
    options: options.map((option, index) => ({ id: `o${index + 1}`, label: option.label.slice(0, 120), categoryId: option.category.id, categoryIds: [option.category.id, ...allOptions.filter((child) => child.category.parentId === option.category.id).map((child) => child.category.id)], keywords: [] })),
  });
  edge("start", "next", "menu");

  let y = 40;
  options.forEach((option, index) => {
    const handle = `opt:o${index + 1}`;
    const category = option.category;
    const children = allOptions.filter((item) => item.category.parentId === category.id);
    if (children.length) {
      const submenu = `submenu_${index + 1}`;
      node(submenu, "menu", category.name, 1120, y, {
        text: `Escolha uma opção de ${category.name}:`, display: "LIST", buttonLabel: "Ver opções",
        variable: "flow.selectedOption", maxAttempts: 3,
        options: [...children.map((item, i) => ({ id: `child${i + 1}`, label: item.label, categoryId: item.category.id, categoryIds: [category.id, item.category.id] })), { id: "back", label: "Voltar" }],
      });
      edge("menu", handle, submenu);
      edge(submenu, "opt:back", "menu");
      children.forEach((item, i) => {
        const key = `child_to_${index + 1}_${i + 1}`;
        node(key, "transfer_category", item.category.name, 1400, y + i * 170, {
          categoryId: item.category.id, message: "{{bot.handoffMessage}}", reason: "Triagem",
        });
        edge(submenu, `opt:child${i + 1}`, key);
      });
      y += children.length * 170 + 100;
      return;
    }
    if (category.code === ATENDIMENTO_CODE) {
      node("atd_ask", "question", "O que você precisa?", 1120, y, {
        text: ATENDIMENTO_ASK_MESSAGE, variable: "flow.atendimentoNeed", answerType: "TEXT", invalidMessage: "", maxAttempts: 3,
      });
      edge("menu", handle, "atd_ask");
      let previous = { key: "atd_ask", handle: "next" };
      let rowY = y;
      for (const route of ATENDIMENTO_ROUTING) {
        const target = categoriesByCode.get(route.code);
        if (!target) continue;
        const conditionKey = `atd_if_${route.code.toLowerCase()}`;
        const transferKey = `atd_to_${route.code.toLowerCase()}`;
        node(conditionKey, "condition", `Fala de ${target.name}?`, 1400, rowY, {
          match: "ANY", rules: route.patterns.map((pattern) => ({ left: "flow.atendimentoNeed", operator: "contains", right: pattern })),
        });
        node(transferKey, "transfer_category", `Para ${target.name}`, 1680, rowY, {
          categoryId: target.id, message: ATENDIMENTO_REROUTE_MESSAGE, reason: "Triagem: reclassificação do Atendimento",
        });
        edge(previous.key, previous.handle, conditionKey);
        edge(conditionKey, "true", transferKey);
        previous = { key: conditionKey, handle: "false" };
        rowY += 170;
      }
      node("atd_stay", "transfer_category", `Fica em ${category.name}`, 1400, rowY, { categoryId: category.id, message: "", reason: "Triagem" });
      edge(previous.key, previous.handle, "atd_stay");
      y = rowY + 200;
    } else {
      const key = `to_${index + 1}`;
      node(key, "transfer_category", `Para ${category.name}`, 1120, y, {
        categoryId: category.id, message: "{{bot.handoffMessage}}", reason: "Triagem",
      });
      edge("menu", handle, key);
      y += 170;
    }
  });
  return { nodes, edges, viewport: { x: 0, y: 0, zoom: 0.7 } };
}

async function ensureTriageFlow({ client = prisma, log = console } = {}) {
  return ensureQuestionAnswerBots({ client, log });
}

function buildAssistantGraph(bot) {
  const intents = (bot.intents || []).filter((intent) => intent.active);
  const nodes = [{ key: "start", type: "start", name: "Início", config: { trigger: "NEW_CONVERSATION", channels: [], initialMessage: "" } }];
  const edges = [];
  const link = (source, sourceHandle, target) => edges.push({ id: `${source}:${sourceHandle}:${target}`, source, sourceHandle, target });
  const add = (key, type, name, config) => nodes.push({ key, type, name, x: 300 + nodes.length * 45, y: nodes.length * 90, config });
  add("menu", "menu", "Perguntas e respostas", {
    text: "{{bot.initialMessage}}", display: "LIST", variable: "flow.selectedOption", maxAttempts: 3,
    options: intents.map((intent, i) => ({ id: `i${i}`, label: intent.name.slice(0, 120), keywords: (intent.examples || []).map((example) => example.text || example.example).filter(Boolean) })),
  });
  add("fallback", "human_handoff", "Continuar com a equipe", { message: "{{bot.fallbackMessage}}", reason: "Sem resposta configurada no modelo de perguntas e respostas" });
  link("start", "next", intents.length ? "menu" : "fallback");
  if (intents.length) link("menu", "invalid", "fallback");
  intents.forEach((intent, i) => {
    const steps = (intent.flowSteps || []).filter((step) => step.active).sort((a, b) => a.order - b.order);
    const keyFor = (step) => `i${i}_${step.id}`;
    if (!steps.length) {
      const key = `answer${i}`;
      add(key, intent.responseMessage ? "message" : "human_handoff", intent.name,
        intent.responseMessage ? { source: "TEXT", text: convertTemplate(intent.responseMessage) } : { message: "{{bot.fallbackMessage}}", categoryId: intent.categoryId, reason: "Resposta não configurada" });
      link("menu", `opt:i${i}`, key);
      if (!intent.responseMessage) {
        const question = `question${i}`;
        add(question, "question", intent.name, { text: `Conte um pouco mais sobre ${intent.name.toLocaleLowerCase("pt-BR")}.`, variable: `customer.answer${i}`, answerType: "TEXT", maxAttempts: 3 });
        edges.find((edge) => edge.source === "menu" && edge.sourceHandle === `opt:i${i}`).target = question;
        link(question, "next", key);
      }
      if (intent.responseMessage) {
        const end = `end${i}`;
        add(end, intent.categoryId ? "transfer_category" : "end", "Concluir", intent.categoryId ? { categoryId: intent.categoryId, message: "{{bot.handoffMessage}}" } : { finalizeConversation: false });
        link(key, "next", end);
      }
      return;
    }
    link("menu", `opt:i${i}`, keyFor(steps[0]));
    steps.forEach((step, position) => {
      const next = steps.find((item) => item.id === step.nextStepId) || steps[position + 1];
      const key = keyFor(step);
      if (step.action === "ASK_QUESTION") {
        add(key, "question", step.name, { text: convertTemplate(step.question), variable: `customer.answer${i}_${position}`, answerType: "TEXT", maxAttempts: step.maxAttempts });
      } else if (step.action === "RESPOND") {
        add(key, "message", step.name, { source: "TEXT", text: convertTemplate(step.responseMessage) });
      } else if (step.action === "RESOLVED") {
        add(key, "end", step.name, { message: convertTemplate(step.responseMessage), finalizeConversation: false });
      } else {
        // Knowledge/tools are not converted into invented answers. Keep the original rows and hand off safely.
        add(key, "human_handoff", step.name, { message: convertTemplate(step.responseMessage || bot.fallbackMessage), categoryId: intent.categoryId, reason: "Etapa antiga requer revisão manual (sem IA ou consulta automática)" });
      }
      if (["ASK_QUESTION", "RESPOND"].includes(step.action)) link(key, "next", next ? keyFor(next) : "fallback");
    });
  });
  return { nodes: intents.length ? nodes : nodes.filter((node) => node.key !== "menu"), edges };
}

async function ensureQuestionAnswerBots({ client = prisma, log = console } = {}) {
  const bots = await client.bot.findMany({
    where: { archivedAt: null },
    include: {
      triageOptions: { orderBy: { order: "asc" }, include: { category: true } },
      intents: { include: { examples: true, flowSteps: true }, orderBy: { priority: "desc" } },
      visualFlows: { select: { id: true, activeVersionId: true, isDefault: true } },
    },
  });
  const selected = bots.filter((bot) => bot.id === "system-triage-bot" || bot.id === "mibro-assistant-observer" || ["Triagem Inicial", "Assistente Mibro Brasil"].includes(bot.name));
  const pending = selected.filter((bot) => bot.featureFlags?.questionAnswerMigration !== 2 || !bot.visualFlows.some((flow) => flow.isDefault && flow.activeVersionId));
  if (!pending.length) return { migrated: false, reason: "ALREADY_MIGRATED_OR_NOT_PRESENT" };
  const categories = await client.category.findMany({ where: { active: true }, select: { id: true, name: true, code: true, masterOnly: true } });
  const categoryIds = new Set(categories.map((category) => category.id));
  const plans = pending.map((bot) => {
    const graph = bot.type === "SYSTEM_TRIAGE" ? buildTriageGraph(bot, new Map(categories.filter((c) => !c.masterOnly).map((c) => [c.code, c]))) : buildAssistantGraph(bot);
    const checked = validateGraph(graph, { categoryIds });
    if (!checked.valid) throw new Error(`Conversão de ${bot.name} bloqueada: ${checked.errors.map((error) => error.message).join("; ")}`);
    return { bot, graph: checked.graph };
  });
  await client.$transaction(async (transaction) => {
    for (const { bot, graph } of plans) {
      await transaction.botFlow.updateMany({ where: { botId: bot.id, isDefault: true }, data: { isDefault: false } });
      const flow = await transaction.botFlow.create({ data: { botId: bot.id, name: "Perguntas e respostas", description: "Conversão preservando configurações e histórico", draftGraph: graph, isDefault: true } });
      const version = await transaction.botFlowVersion.create({ data: { flowId: flow.id, version: 1, graph, label: "Conversão para perguntas e respostas" } });
      await transaction.botFlow.update({ where: { id: flow.id }, data: { activeVersionId: version.id, status: "ACTIVE" } });
      const flags = bot.featureFlags || {};
      await transaction.bot.update({ where: { id: bot.id }, data: {
        executionMode: "FLOW_BUILDER", status: flags.questionAnswerMigration ? bot.status : (flags.legacyStatusBeforeArchive || bot.status),
        autoReplyEnabled: flags.questionAnswerMigration ? bot.autoReplyEnabled : (flags.legacyAutoReplyBeforeMigration ?? bot.autoReplyEnabled),
        featureFlags: { ...flags, questionAnswerMigration: 2, availabilityManaged: true },
      } });
      await audit.recordAudit({ actor: null, action: "BOT_QUESTION_ANSWER_MIGRATED", entityType: "BOT", entityId: bot.id, summary: `Converteu ${bot.name}; configurações e dados antigos preservados`, details: { flowId: flow.id } }, transaction);
    }
    for (const bot of bots.filter((item) => !selected.some((selectedBot) => selectedBot.id === item.id) && item.status !== "ARCHIVED_LEGACY")) {
      await transaction.bot.update({ where: { id: bot.id }, data: { status: "ARCHIVED_LEGACY", autoReplyEnabled: false, featureFlags: { ...(bot.featureFlags || {}), legacyStatusBeforeArchive: bot.status, legacyAutoReplyBeforeMigration: bot.autoReplyEnabled, legacyArchivedAt: new Date().toISOString() } } });
    }
  });
  log.info?.(`[BOT_FLOW] ${plans.length} Bots convertidos; histórico preservado.`);
  return { migrated: true, published: true, botIds: plans.map(({ bot }) => bot.id) };
}


module.exports = { ATENDIMENTO_ROUTING, buildTriageGraph, buildAssistantGraph, convertTemplate, ensureTriageFlow, ensureQuestionAnswerBots };
