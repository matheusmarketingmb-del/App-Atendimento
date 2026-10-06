// Configurações → Conversas — SLA de primeira resposta (item 1), SLA de
// resposta durante atendimento (item 2), alerta de conversa sem resposta
// (item 3) e alerta de conversa parada (item 4). Mesmo esqueleto de
// conversation-inactivity-service.js: uma função de varredura pura por
// preocupação + um monitor único com setInterval/unref/guarda de
// reentrância. Nenhuma dessas checagens finaliza conversa nem envia
// mensagem automática ao cliente — só marca indicador/gera atividade.
const prisma = require("../database/prisma");
const { settingsPlan } = require("./conversation-settings-service");
const { isBusinessHours } = require("./business-hours-service");

// Item 9: quando a SLA está restrita a horário comercial, simplesmente não
// avalia enquanto estivermos fora dele — não tenta "descontar" o tempo fora
// do expediente do cronômetro, só evita marcar atraso fora de horário.
function shouldEvaluateSla(now, settings) {
  return !settings.slaBusinessHoursOnly || isBusinessHours(now);
}

// Item 1: conversa em NOVO (cliente falou, empresa ainda não respondeu desde
// a criação/reabertura) além do prazo -> marca o indicador. Nunca finaliza,
// nunca muda status.
async function checkFirstResponseSla({ now, settings, client = prisma, scope = {} }) {
  if (!settings.firstResponseSlaEnabled || !shouldEvaluateSla(now, settings)) return 0;
  const cutoff = new Date(now.getTime() - settings.firstResponseSlaMinutes * 60 * 1000);
  const result = await client.conversation.updateMany({
    where: { ...scope, status: "NOVO", firstResponseSlaBreached: false, lastMessageAt: { lte: cutoff } },
    data: { firstResponseSlaBreached: true },
  });
  return result.count;
}

// Idempotência (item 14): só grava uma atividade de alerta por "episódio" —
// isto é, se ainda não existe um registro daquele action mais recente que o
// lastMessageAt atual da conversa.
async function alreadyAlerted(conversationId, action, since, client) {
  const existing = await client.conversationActivity.findFirst({
    where: { conversationId, action, createdAt: { gte: since } },
    select: { id: true },
  });
  return Boolean(existing);
}

// Item 2: última mensagem válida é do cliente durante atendimento
// (AGUARDANDO_EQUIPE/HANDOFF_BOT já são esse sinal na máquina de estados
// existente) além do prazo -> marca o indicador (mesmo padrão do item 1,
// não só ConversationActivity) + ConversationActivity para o alerta
// interno. Reseta quando a empresa responde (updateConversationAfterSending).
async function checkResponseSla({ now, settings, client = prisma, scope = {} }) {
  if (!settings.responseSlaEnabled || !shouldEvaluateSla(now, settings)) return 0;
  const cutoff = new Date(now.getTime() - settings.responseSlaMinutes * 60 * 1000);
  const candidates = await client.conversation.findMany({
    where: { ...scope, status: { in: ["AGUARDANDO_EQUIPE", "HANDOFF_BOT"] }, responseSlaBreached: false, lastMessageAt: { lte: cutoff } },
    select: { id: true, lastMessageAt: true },
  });
  let flagged = 0;
  for (const conversation of candidates) {
    const claimed = await client.conversation.updateMany({
      where: { ...scope, id: conversation.id, responseSlaBreached: false },
      data: { responseSlaBreached: true },
    });
    if (!claimed.count) continue;
    if (!(await alreadyAlerted(conversation.id, "SLA_RESPONSE_BREACHED", conversation.lastMessageAt, client))) {
      await client.conversationActivity.create({ data: {
        conversationId: conversation.id, action: "SLA_RESPONSE_BREACHED",
        details: { responseSlaMinutes: settings.responseSlaMinutes },
      } });
    }
    flagged += 1;
  }
  return flagged;
}

// Item 3: alerta interno (para equipe/responsável) de mensagem do cliente
// sem resposta — não envia nada ao cliente. Mesma condição-base do item 2,
// prazo e ação de auditoria próprios.
async function checkUnansweredConversationAlert({ now, settings, client = prisma, scope = {} }) {
  if (!settings.unansweredConversationAlertEnabled) return 0;
  const cutoff = new Date(now.getTime() - settings.unansweredConversationAlertMinutes * 60 * 1000);
  const candidates = await client.conversation.findMany({
    where: { ...scope, status: { in: ["AGUARDANDO_EQUIPE", "HANDOFF_BOT"] }, lastMessageAt: { lte: cutoff } },
    select: { id: true, lastMessageAt: true },
  });
  let flagged = 0;
  for (const conversation of candidates) {
    if (await alreadyAlerted(conversation.id, "UNANSWERED_CONVERSATION_ALERT", conversation.lastMessageAt, client)) continue;
    await client.conversationActivity.create({ data: {
      conversationId: conversation.id, action: "UNANSWERED_CONVERSATION_ALERT",
      details: { unansweredConversationAlertMinutes: settings.unansweredConversationAlertMinutes },
    } });
    flagged += 1;
  }
  return flagged;
}

// Item 4: conversa em atendimento (qualquer lado aguardando) sem nenhuma
// movimentação relevante por muito tempo — alerta interno "Conversa sem
// atividade há Xh", nunca finaliza por causa disto.
async function checkStalledConversationAlert({ now, settings, client = prisma, scope = {} }) {
  if (!settings.stalledConversationAlertEnabled) return 0;
  const cutoff = new Date(now.getTime() - settings.stalledConversationAlertMinutes * 60 * 1000);
  const candidates = await client.conversation.findMany({
    where: { ...scope, status: { in: ["EM_ATENDIMENTO", "AGUARDANDO_EQUIPE", "AGUARDANDO_CLIENTE", "HANDOFF_BOT"] }, lastMessageAt: { lte: cutoff } },
    select: { id: true, lastMessageAt: true },
  });
  let flagged = 0;
  for (const conversation of candidates) {
    if (await alreadyAlerted(conversation.id, "STALLED_CONVERSATION_ALERT", conversation.lastMessageAt, client)) continue;
    await client.conversationActivity.create({ data: {
      conversationId: conversation.id, action: "STALLED_CONVERSATION_ALERT",
      details: { stalledConversationAlertMinutes: settings.stalledConversationAlertMinutes },
    } });
    flagged += 1;
  }
  return flagged;
}

// Alerta interno de SLA "próximo do limite" (item 3 do pedido de SLA/
// prioridade): dispara quando já passou X% do prazo configurado, mas ainda
// não estourou. Avalia os dois SLAs (primeira resposta e resposta durante
// atendimento) com o mesmo percentual central — nunca finaliza nem envia
// nada ao cliente, só ConversationActivity para a equipe. Idempotente pelo
// mesmo padrão de "episódio" (não repete enquanto lastMessageAt não mudar).
async function checkSlaNearBreachAlert({ now, settings, client = prisma, scope = {} }) {
  if (!settings.slaNearBreachAlertEnabled || !shouldEvaluateSla(now, settings)) return 0;
  const percent = Math.min(Math.max(settings.slaNearBreachPercent, 1), 99) / 100;
  let flagged = 0;

  if (settings.firstResponseSlaEnabled) {
    const nearCutoff = new Date(now.getTime() - settings.firstResponseSlaMinutes * percent * 60 * 1000);
    const candidates = await client.conversation.findMany({
      where: { ...scope, status: "NOVO", firstResponseSlaBreached: false, lastMessageAt: { lte: nearCutoff } },
      select: { id: true, lastMessageAt: true },
    });
    for (const conversation of candidates) {
      if (await alreadyAlerted(conversation.id, "SLA_NEAR_BREACH_FIRST_RESPONSE", conversation.lastMessageAt, client)) continue;
      await client.conversationActivity.create({ data: {
        conversationId: conversation.id, action: "SLA_NEAR_BREACH_FIRST_RESPONSE",
        details: { firstResponseSlaMinutes: settings.firstResponseSlaMinutes, percent: settings.slaNearBreachPercent },
      } });
      flagged += 1;
    }
  }

  if (settings.responseSlaEnabled) {
    const nearCutoff = new Date(now.getTime() - settings.responseSlaMinutes * percent * 60 * 1000);
    const candidates = await client.conversation.findMany({
      where: { ...scope, status: { in: ["AGUARDANDO_EQUIPE", "HANDOFF_BOT"] }, responseSlaBreached: false, lastMessageAt: { lte: nearCutoff } },
      select: { id: true, lastMessageAt: true },
    });
    for (const conversation of candidates) {
      if (await alreadyAlerted(conversation.id, "SLA_NEAR_BREACH_RESPONSE", conversation.lastMessageAt, client)) continue;
      await client.conversationActivity.create({ data: {
        conversationId: conversation.id, action: "SLA_NEAR_BREACH_RESPONSE",
        details: { responseSlaMinutes: settings.responseSlaMinutes, percent: settings.slaNearBreachPercent },
      } });
      flagged += 1;
    }
  }

  return flagged;
}

// Alerta interno de "conversa sem responsável" (item 3): conversa ativa
// (não NOVO — que naturalmente ainda não tem responsável e já aparece na
// fila — nem BOT/FINALIZADO) sem assignedUserId há X minutos. Idempotente
// pelo mesmo padrão de "episódio".
async function checkUnassignedConversationAlert({ now, settings, client = prisma, scope = {} }) {
  if (!settings.unassignedConversationAlertEnabled) return 0;
  const cutoff = new Date(now.getTime() - settings.unassignedConversationAlertMinutes * 60 * 1000);
  const candidates = await client.conversation.findMany({
    where: {
      ...scope,
      assignedUserId: null,
      status: { in: ["AGUARDANDO_EQUIPE", "AGUARDANDO_CLIENTE", "HANDOFF_BOT"] },
      lastMessageAt: { lte: cutoff },
    },
    select: { id: true, lastMessageAt: true },
  });
  let flagged = 0;
  for (const conversation of candidates) {
    if (await alreadyAlerted(conversation.id, "UNASSIGNED_CONVERSATION_ALERT", conversation.lastMessageAt, client)) continue;
    await client.conversationActivity.create({ data: {
      conversationId: conversation.id, action: "UNASSIGNED_CONVERSATION_ALERT",
      details: { unassignedConversationAlertMinutes: settings.unassignedConversationAlertMinutes },
    } });
    flagged += 1;
  }
  return flagged;
}

async function runSlaChecksFor({ now, client, settings, scope }) {
  return {
    firstResponseBreached: await checkFirstResponseSla({ now, settings, client, scope }),
    responseBreached: await checkResponseSla({ now, settings, client, scope }),
    unansweredAlerted: await checkUnansweredConversationAlert({ now, settings, client, scope }),
    stalledAlerted: await checkStalledConversationAlert({ now, settings, client, scope }),
    slaNearBreachAlerted: await checkSlaNearBreachAlert({ now, settings, client, scope }),
    unassignedAlerted: await checkUnassignedConversationAlert({ now, settings, client, scope }),
  };
}

// Multiempresa: cada empresa com configuração própria é avaliada com a dela;
// as demais com a global. `settings` explícito (testes) vale para todas.
async function runSlaChecks({ now = new Date(), client = prisma, settings } = {}) {
  const plan = settings ? [{ settings, scope: {} }] : await settingsPlan(client);
  const totals = {};
  for (const entry of plan) {
    const results = await runSlaChecksFor({ now, client, ...entry });
    for (const [key, value] of Object.entries(results)) totals[key] = (totals[key] || 0) + value;
  }
  return totals;
}

function startSlaMonitor({ intervalMs = 60 * 1000, onChange } = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const results = await runSlaChecks();
      const total = Object.values(results).reduce((sum, value) => sum + value, 0);
      if (total) onChange?.(results);
    } catch (error) {
      console.error("Erro ao avaliar SLAs/alertas de conversas:", error);
    } finally {
      running = false;
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  checkFirstResponseSla, checkResponseSla, checkStalledConversationAlert,
  checkUnansweredConversationAlert, checkSlaNearBreachAlert, checkUnassignedConversationAlert,
  runSlaChecks, startSlaMonitor,
};
