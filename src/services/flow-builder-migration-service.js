// Migração do Bot de Triagem (type SYSTEM_TRIAGE, antes executado por
// triage-bot-service.js — arquivado em _archive/bot-legacy/) para um fluxo
// visual equivalente. Idempotente: só age se o Bot de Triagem ainda não
// tiver nenhum fluxo. Nunca apaga nada e NUNCA liga a resposta automática —
// o fluxo nasce publicado, mas o Master liga o Bot depois de validar no
// simulador.
//
// Equivalência com a triagem antiga:
//   Início -> Condição (dentro do horário/feriado?)
//     não -> Mensagem "fora do horário" -> Menu de setores   (*)
//     sim -> Menu de setores (lista interativa do WhatsApp)
//   cada opção -> Transferir para o setor (mensagem de encaminhamento)
//   opção Atendimento -> Pergunta "o que você precisa?" -> Condições por
//     palavra-chave (mesmas listas do código antigo) -> Transferir para o
//     setor correspondente; sem correspondência -> fica em Atendimento.
// (*) Diferença consciente: a triagem antiga não mostrava o menu fora do
// horário (só reenviava na próxima mensagem dentro do horário). Aqui o
// cliente já escolhe o setor e a conversa fica na fila dele para o próximo
// expediente. Ajustável no editor (troque a saída por Finalizar).
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
    .replace(/\{\{\s*categoria\s*\}\}/g, categoryName || "");
}

function buildTriageGraph(bot, categoriesByCode) {
  const options = (bot.triageOptions || []).filter((option) => option.enabled && option.category?.active);
  const nodes = [];
  const edges = [];
  const edge = (source, sourceHandle, target) => edges.push({ id: `${source}:${sourceHandle}->${target}`, source, sourceHandle, target });
  const node = (key, type, name, x, y, config) => nodes.push({ key, type, name, x, y, config });

  node("start", "start", "Início", 40, 260, { trigger: "NEW_CONVERSATION", channels: [], categoryId: null, initialMessage: "" });
  node("hours", "condition", "Dentro do horário?", 300, 260, { match: "ALL", rules: [{ left: "bot.withinBusinessHours", operator: "==", right: "true" }] });
  node("outside", "message", "Fora do horário", 560, 420, { source: "TEXT", text: convertTemplate(bot.outsideHoursMessage), responseKey: "" });
  node("menu", "menu", "Menu de setores", 820, 260, {
    text: convertTemplate(bot.initialMessage), display: "LIST", buttonLabel: "Escolher setor",
    variable: "flow.selectedOption", invalidMessage: "", maxAttempts: 3,
    options: options.map((option, index) => ({ id: `o${index + 1}`, label: option.label.slice(0, 120), keywords: [] })),
  });
  edge("start", "next", "hours");
  edge("hours", "true", "menu");
  edge("hours", "false", "outside");
  edge("outside", "next", "menu");

  let y = 40;
  options.forEach((option, index) => {
    const handle = `opt:o${index + 1}`;
    const category = option.category;
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
        categoryId: category.id, message: convertTemplate(bot.handoffMessage, { categoryName: category.name }), reason: "Triagem",
      });
      edge("menu", handle, key);
      y += 170;
    }
  });
  return { nodes, edges, viewport: { x: 0, y: 0, zoom: 0.7 } };
}

async function ensureTriageFlow({ client = prisma, log = console } = {}) {
  const bot = await client.bot.findFirst({
    where: { type: "SYSTEM_TRIAGE", archivedAt: null },
    include: {
      triageOptions: { orderBy: [{ order: "asc" }, { createdAt: "asc" }], include: { category: { select: { id: true, name: true, code: true, active: true } } } },
      visualFlows: { select: { id: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (!bot) return { migrated: false, reason: "NO_TRIAGE_BOT" };
  if (bot.visualFlows.length) return { migrated: false, reason: "ALREADY_HAS_FLOW", botId: bot.id };

  const categories = await client.category.findMany({ where: { active: true }, select: { id: true, name: true, code: true } });
  const graph = buildTriageGraph(bot, new Map(categories.map((category) => [category.code, category])));
  const categoryIds = new Set(categories.map((category) => category.id));
  for (const option of bot.triageOptions) if (option.category?.active) categoryIds.add(option.category.id);
  const { valid, errors, graph: normalized } = validateGraph(graph, { categoryIds });

  const result = await client.$transaction(async (transaction) => {
    const flow = await transaction.botFlow.create({
      data: {
        botId: bot.id, name: "Triagem", description: "Convertido automaticamente do Bot de Triagem antigo (menu de setores).",
        draftGraph: normalized, isDefault: true, createdByName: "Migração automática", updatedByName: "Migração automática",
      },
    });
    let version = null;
    if (valid) {
      version = await transaction.botFlowVersion.create({
        data: { flowId: flow.id, version: 1, graph: normalized, label: "Conversão da triagem antiga", publishedByName: "Migração automática" },
      });
      await transaction.botFlow.update({ where: { id: flow.id }, data: { activeVersionId: version.id, status: "ACTIVE" } });
    }
    // Resposta automática fica DESLIGADA — o Master liga em Bots após testar.
    await transaction.bot.update({ where: { id: bot.id }, data: { executionMode: "FLOW_BUILDER", autoReplyEnabled: false } });
    await audit.recordAudit({
      actor: null, action: "BOT_TRIAGE_MIGRATED_TO_FLOW", entityType: "BOT", entityId: bot.id,
      summary: `Bot de Triagem convertido para o fluxo visual "Triagem"${valid ? " (v1 publicada, resposta automática desligada)" : " (rascunho com pendências)"}`,
      details: { flowId: flow.id, published: valid, errors: valid ? [] : errors.slice(0, 20) },
    }, transaction);
    return { flowId: flow.id, published: valid, version: version?.version || null };
  });
  log.info?.(`[BOT_FLOW] Bot de Triagem convertido para fluxo visual (flow=${result.flowId}, publicado=${result.published}). Resposta automática desligada até o Master ligar.`);
  return { migrated: true, botId: bot.id, ...result, errors: valid ? [] : errors };
}

module.exports = { ATENDIMENTO_ROUTING, buildTriageGraph, convertTemplate, ensureTriageFlow };
