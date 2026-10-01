const prisma = require("../database/prisma");
const audit = require("./audit-service");
const { businessHoursText, isBusinessHours } = require("./business-hours-service");
const { scheduleState } = require("./bot-simulator-service");

// Item "Integrar o Bot de Triagem Inicial ao sistema de Bots": este arquivo
// continua sendo o único lugar que efetivamente ENVIA a triagem (o motor
// genérico de IA em bot-orchestrator-service.js roda hoje só em modo sombra/
// observação, nunca envia mensagem real — ver bot-observation-service.js).
// A diferença é que toda configuração (mensagens, horário, opções/setores)
// agora vem do Bot type=SYSTEM_TRIAGE persistido no banco, em vez de estar
// hardcoded aqui. `isBusinessHours`/`businessHoursText` seguem exportados
// por compatibilidade (usados por outros serviços e pelos testes), mas a
// decisão real de horário passa a usar o Schedule do Bot (scheduleState),
// para não duplicar sistema de horário.
const categoryReplyPrefix = "triage_category:";

// Reclassificação dentro da categoria Atendimento (pedido do usuário, sem
// depender do motor de IA em modo sombra — ver comentário acima): ao invés de
// só confirmar o encaminhamento genérico, o Bot pergunta o que o cliente
// precisa e, se a resposta em texto livre bater com alguma palavra-chave
// abaixo, troca a categoria da conversa silenciosamente (sem repetir a
// recepção/saudação — essa só acontece uma vez, na entrada pelo Bot de
// Triagem). Sem correspondência, a conversa permanece em Atendimento e segue
// para um atendente humano normalmente. Ajuste as listas abaixo conforme a
// necessidade do negócio, sem precisar tocar na lógica.
const ATENDIMENTO_CATEGORY_CODE = "ATENDIMENTO";
const ATENDIMENTO_ASK_MESSAGE = "Claro! Me conta rapidinho o que você precisa, assim eu já te direciono para o time certo 🙂";
const ATENDIMENTO_REROUTE_MESSAGE = "Entendido! Vou repassar seu atendimento para o setor correto — um atendente vai falar com você em breve.";
const atendimentoRoutingKeywords = [
  { code: "ATACADO", patterns: ["revend", "atacad", "distribuid"] },
  { code: "PARCERIAS", patterns: ["parceria", "parceiro"] },
  { code: "COMERCIAL", patterns: ["compr", "orçament", "orcament", "preç", "prec"] },
  { code: "SUPORTE", patterns: ["problema", "defeito", "quebrad", "não funciona", "nao funciona", "erro"] },
  { code: "GARANTIA", patterns: ["garantia"] },
  { code: "PEDIDOS", patterns: ["pedido", "rastre", "entrega"] },
  { code: "TROCAS_DEVOLUCOES", patterns: ["troca", "devolu", "cancelar"] },
];

function matchAtendimentoCategoryCode(text) {
  const normalized = String(text || "").toLowerCase();
  if (!normalized) return null;
  const match = atendimentoRoutingKeywords.find(({ patterns }) => patterns.some((pattern) => normalized.includes(pattern)));
  return match?.code || null;
}

function contactFirstName(contact) {
  const name = contact?.name?.trim();
  if (!name || name === contact?.phone) return "Olá";
  return name.split(/\s+/)[0];
}

// Placeholders disponíveis nas mensagens configuráveis do Bot de Triagem:
// {{saudacao}} ("Olá" ou "Olá, Nome"), {{saudacao_virgula}} ("" ou ", Nome"),
// {{horario}} (descrição do Schedule do Bot) e {{categoria}} (setor
// escolhido, só disponível na mensagem de encaminhamento).
function renderTemplate(template, vars) {
  return String(template || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  ));
}

function greetingVars(contact) {
  const greeting = contactFirstName(contact);
  return {
    saudacao: greeting === "Olá" ? greeting : `Olá, ${greeting}`,
    saudacao_virgula: greeting === "Olá" ? "" : `, ${greeting}`,
  };
}

const weekdayShortLabels = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const weekdayFullLabels = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const weekdayShort = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
// Nomes populares de timezone (item Horário → Timezone): "America/Sao_Paulo"
// é sempre chamado de "Brasília" na fala corrente — preserva o texto atual
// do bot de triagem. Timezones não mapeadas caem para o nome da cidade.
const timezoneFriendlyNames = { "America/Sao_Paulo": "Brasília" };

// Descreve o Schedule do Bot em texto legível para o placeholder {{horario}}.
// Quando todos os dias habilitados compartilham o mesmo horário (caso comum,
// ex.: "segunda a sexta-feira, das 8h às 17h"), gera uma faixa compacta;
// caso contrário, lista dia a dia. Sem Schedule configurado, cai para o
// texto genérico de business-hours-service (mesma frase de sempre).
function describeSchedule(bot) {
  const enabledDays = (bot?.schedules || [])
    .filter((item) => item.enabled)
    .sort((left, right) => left.dayOfWeek - right.dayOfWeek);
  if (!enabledDays.length) return businessHoursText;

  const sameHours = enabledDays.every((item) => (
    item.startTime === enabledDays[0].startTime && item.endTime === enabledDays[0].endTime
  ));
  const hourText = (start, end) => `das ${start.replace(/^0/, "").replace(":00", "h")} às ${end.replace(/^0/, "").replace(":00", "h")}`;

  const isConsecutiveRun = enabledDays.length >= 2
    && enabledDays.every((item, index) => index === 0 || item.dayOfWeek === enabledDays[index - 1].dayOfWeek + 1);

  if (sameHours && isConsecutiveRun) {
    const first = weekdayShortLabels[enabledDays[0].dayOfWeek];
    const last = weekdayFullLabels[enabledDays[enabledDays.length - 1].dayOfWeek];
    const tzName = timezoneFriendlyNames[bot.timezone] || bot.timezone.split("/").pop().replace(/_/g, " ");
    return `${first} a ${last}, ${hourText(enabledDays[0].startTime, enabledDays[0].endTime)} (horário de ${tzName})`;
  }
  if (sameHours) {
    const days = enabledDays.map((item) => weekdayShort[item.dayOfWeek]).join(", ");
    return `${days}, ${hourText(enabledDays[0].startTime, enabledDays[0].endTime)}`;
  }
  return enabledDays.map((item) => `${weekdayShort[item.dayOfWeek]} ${hourText(item.startTime, item.endTime)}`).join("; ");
}

function categoryReplyId(categoryId) {
  return `${categoryReplyPrefix}${categoryId}`;
}

// Bot de Triagem: sempre um único Bot type=SYSTEM_TRIAGE (não arquivado).
// Se houver mais de um por engano, usa o mais antigo (criação original) e
// ignora os demais — nunca lança erro aqui, quem decide "estado seguro" em
// caso de configuração ausente/quebrada é handleIncomingTriage.
async function getTriageBot() {
  const bots = await prisma.bot.findMany({
    where: { type: "SYSTEM_TRIAGE", archivedAt: null },
    include: {
      schedules: { orderBy: { dayOfWeek: "asc" } },
      holidays: { orderBy: { date: "asc" } },
      triageOptions: {
        where: { enabled: true },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        include: { category: { select: {
          id: true, name: true, code: true, active: true, masterOnly: true,
          parentId: true,
          parent: { select: { id: true, name: true, code: true, active: true, masterOnly: true } },
        } } },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  return bots[0] || null;
}
function triageOptionAvailable(option) {
  return Boolean(option?.enabled !== false && option.category?.active
    && !option.category.masterOnly && option.category.parent?.active !== false
    && !option.category.parent?.masterOnly);
}

function availableTriageOptions(bot, conversation = null) {
  const allowedIds = Array.isArray(conversation?.channelAccount?.config?.allowedCategoryIds)
    ? conversation.channelAccount.config.allowedCategoryIds : [];
  return (bot.triageOptions || []).filter((option) => triageOptionAvailable(option)
    && (!allowedIds.length || allowedIds.includes(option.categoryId) || allowedIds.includes(option.category?.parentId)));
}

function subcategoryOptions(bot, parentId, conversation = null) {
  return availableTriageOptions(bot, conversation).filter((option) => option.category?.parentId === parentId);
}

function topLevelOptions(bot, conversation = null) {
  const available = availableTriageOptions(bot, conversation);
  const roots = available.filter((option) => !option.category?.parentId);
  const rootIds = new Set(roots.map((option) => option.categoryId));
  for (const child of available.filter((option) => option.category?.parentId)) {
    const parent = child.category.parent;
    if (!parent || rootIds.has(parent.id)) continue;
    roots.push({
      ...child, categoryId: parent.id, label: parent.name, description: null,
      order: child.order, syntheticParent: true,
      category: { ...parent, parentId: null, parent: null },
    });
    rootIds.add(parent.id);
  }
  return roots.sort((left, right) => {
    const order = (left.order || 0) - (right.order || 0);
    return order || String(left.label).localeCompare(String(right.label), "pt-BR");
  });
}
function logMisconfiguration(botId, reason, details) {
  // Nunca lança/derruba o webhook por causa de configuração inconsistente
  // (item "Fallback se configuração falhar") — só registra para diagnóstico.
  console.error(`[triage-bot] ${reason}`, { botId, ...details });
}

async function saveBotText(conversation, text, system, channel) {
  channel = await require("./whatsapp-inbox-service").botChannel(conversation, channel);
  const result = await channel.sendText(conversation.contact.phone, text);
  const occurredAt = new Date();
  await prisma.$transaction([
    prisma.message.create({ data: {
      conversationId: conversation.id, externalId: conversation.channelAccountId && result.externalId ? `${conversation.channelAccountId}:${result.externalId}` : (result.externalId || null), channel: "META", channelAccountId: conversation.channelAccountId || null,
      direction: "ENVIADA", status: "ENVIADA", type: "text", text, occurredAt,
      rawPayload: { message: result.data, system },
    } }),
    prisma.conversation.update({
      where: { id: conversation.id }, data: { status: "BOT", lastMessageAt: occurredAt },
    }),
  ]);
  return true;
}

async function sendCategoryMenu(conversation, channel, bot) {
  channel = await require("./whatsapp-inbox-service").botChannel(conversation, channel);
  const options = topLevelOptions(bot, conversation);
  if (!options.length) {
    logMisconfiguration(bot.id, "Nenhuma opção de triagem ativa/válida configurada.", {});
    return saveBotText(conversation, bot.fallbackMessage, "triage_fallback", channel);
  }
  const rows = options.map((option) => ({
    id: categoryReplyId(option.categoryId), title: option.category.name.slice(0, 24),
  }));
  const menuText = renderTemplate(bot.initialMessage, {
    ...greetingVars(conversation.contact), horario: describeSchedule(bot),
  });
  const result = await channel.sendList(conversation.contact.phone, {
    body: menuText, button: "Escolher setor", rows,
  });
  await prisma.$transaction([
    prisma.message.create({ data: {
      conversationId: conversation.id, externalId: conversation.channelAccountId && result.externalId ? `${conversation.channelAccountId}:${result.externalId}` : (result.externalId || null), channel: "META", channelAccountId: conversation.channelAccountId || null,
      direction: "ENVIADA", status: "ENVIADA", type: "interactive", text: menuText,
      occurredAt: new Date(), rawPayload: { message: result.data, system: "triage_menu" },
    } }),
    prisma.conversation.update({
      where: { id: conversation.id }, data: { status: "BOT", lastMessageAt: new Date() },
    }),
  ]);
  return true;
}

async function sendSubcategoryMenu(conversation, channel, bot, parentCategory) {
  channel = await require("./whatsapp-inbox-service").botChannel(conversation, channel);
  const options = subcategoryOptions(bot, parentCategory.id, conversation);
  if (!options.length) return false;
  const body = "Perfeito! Para continuarmos, escolha abaixo o tipo de atendimento que voc\u00ea precisa.";
  const rows = options.map((option) => ({
    id: categoryReplyId(option.categoryId), title: option.category.name.slice(0, 24),
  }));
  const result = await channel.sendList(conversation.contact.phone, {
    body, button: "Escolher op\u00e7\u00e3o", rows,
  });
  const occurredAt = new Date();
  await prisma.$transaction([
    prisma.message.create({ data: {
      conversationId: conversation.id, externalId: conversation.channelAccountId && result.externalId ? `${conversation.channelAccountId}:${result.externalId}` : (result.externalId || null), channel: "META", channelAccountId: conversation.channelAccountId || null,
      direction: "ENVIADA", status: "ENVIADA", type: "interactive", text: body,
      occurredAt, rawPayload: { message: result.data, system: "triage_subcategory_menu", parentCategoryId: parentCategory.id },
    } }),
    prisma.conversation.update({
      where: { id: conversation.id }, data: { status: "BOT", lastMessageAt: occurredAt },
    }),
  ]);
  return true;
}

async function completeTriage(conversation, categoryId, channel, bot) {
  const option = availableTriageOptions(bot, conversation).find((item) => item.categoryId === categoryId);
  if (!option) return sendCategoryMenu(conversation, channel, bot);
  const category = option.category;

  const claimed = await prisma.conversation.updateMany({
    where: { id: conversation.id, categoryId: null, status: "BOT" },
    data: { categoryId: category.id, status: "NOVO", assignedUserId: null, finalizedAt: null },
  });
  if (!claimed.count) return false;

  try {
    // Atendimento não recebe a confirmação genérica de encaminhamento: em vez
    // disso, pergunta o que o cliente precisa (a resposta é interpretada em
    // handleIncomingTriage/tryAtendimentoRerouting, sem repetir recepção).
    const isAtendimento = category.code === ATENDIMENTO_CATEGORY_CODE;
    const text = isAtendimento
      ? ATENDIMENTO_ASK_MESSAGE
      : renderTemplate(bot.handoffMessage, { ...greetingVars(conversation.contact), categoria: category.name });
    const system = isAtendimento ? "atendimento_ask" : "triage_confirmation";
    channel = await require("./whatsapp-inbox-service").botChannel(conversation, channel);
    const result = await channel.sendText(conversation.contact.phone, text);
    const occurredAt = new Date();
    await prisma.$transaction(async (transaction) => {
      await transaction.message.create({ data: {
        conversationId: conversation.id, externalId: conversation.channelAccountId && result.externalId ? `${conversation.channelAccountId}:${result.externalId}` : (result.externalId || null), channel: "META", channelAccountId: conversation.channelAccountId || null,
        direction: "ENVIADA", status: "ENVIADA", type: "text", text, occurredAt,
        rawPayload: { message: result.data, system },
      } });
      await transaction.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: occurredAt } });
      await transaction.conversationActivity.create({ data: {
        conversationId: conversation.id, action: "BOT_TRIAGE_COMPLETED",
        details: { categoryId: category.id, categoryName: category.name },
      } });
      await audit.recordAudit({
        actor: null,
        action: "CONVERSATION_CATEGORY_CHANGED",
        entityType: "CONVERSATION",
        entityId: conversation.id,
        summary: `Bot encaminhou a conversa de ${conversation.contact.customName || conversation.contact.name || conversation.contact.phone} para ${category.name}`,
        details: {
          conversationId: conversation.id,
          contactCustomName: conversation.contact.customName || null,
          contactName: conversation.contact.name || null,
          contactPhone: conversation.contact.phone,
          from: "Sem categoria",
          to: category.name,
          fromCategoryId: null,
          toCategoryId: category.id,
        },
      }, transaction);
    });
    return true;
  } catch (error) {
    await prisma.conversation.updateMany({
      where: { id: conversation.id, categoryId: category.id, status: "NOVO", assignedUserId: null },
      data: { categoryId: null, status: "BOT" },
    });
    throw error;
  }
}

// "Nova conversa" x "conversa reaberta" (itens 5/6): uma conversa é
// considerada reaberta se já existir ao menos uma reabertura registrada
// (REOPENED_BY_CUSTOMER_MESSAGE, gravada por message-service.js). Uma
// conversa que nunca foi reaberta é sempre "nova", mesmo que não seja
// literalmente a primeira mensagem (ex.: primeira tentativa falhou/retry).
async function isReopenedConversation(conversationId) {
  const count = await prisma.conversationActivity.count({
    where: { conversationId, action: "REOPENED_BY_CUSTOMER_MESSAGE" },
  });
  return count > 0;
}

async function routeTriageSelection(conversation, categoryId, channel, bot) {
  const direct = availableTriageOptions(bot, conversation).find((item) => item.categoryId === categoryId);
  const children = subcategoryOptions(bot, categoryId, conversation);
  if (children.length) {
    const parentCategory = direct?.category || children[0].category.parent;
    if (parentCategory) return sendSubcategoryMenu(conversation, channel, bot, parentCategory);
  }
  if (direct) return completeTriage(conversation, categoryId, channel, bot);
  return sendCategoryMenu(conversation, channel, bot);
}

// Só reclassifica Atendimento enquanto ninguém assumiu e a última resposta
// do Bot foi a pergunta de direcionamento. A recepção inicial não é repetida.
async function tryAtendimentoRerouting(conversation, message, channel) {
  if (conversation.category?.code !== ATENDIMENTO_CATEGORY_CODE) return null;
  if (conversation.assignedUserId || conversation.status === "FINALIZADO") return null;
  if (conversation.messages[0]?.rawPayload?.system !== "atendimento_ask") return null;

  const targetCode = matchAtendimentoCategoryCode(message.text);
  if (!targetCode) return false;

  const targetCategory = await prisma.category.findFirst({ where: { code: targetCode, active: true } });
  if (!targetCategory) return false;

  const moved = await prisma.conversation.updateMany({
    where: { id: conversation.id, categoryId: conversation.categoryId, assignedUserId: null },
    data: { categoryId: targetCategory.id },
  });
  if (!moved.count) return false;

  channel = await require("./whatsapp-inbox-service").botChannel(conversation, channel);
  const result = await channel.sendText(conversation.contact.phone, ATENDIMENTO_REROUTE_MESSAGE);
  const occurredAt = new Date();
  await prisma.$transaction(async (transaction) => {
    await transaction.message.create({ data: {
      conversationId: conversation.id,
      externalId: conversation.channelAccountId && result.externalId ? `${conversation.channelAccountId}:${result.externalId}` : (result.externalId || null),
      channel: "META", channelAccountId: conversation.channelAccountId || null,
      direction: "ENVIADA", status: "ENVIADA", type: "text", text: ATENDIMENTO_REROUTE_MESSAGE, occurredAt,
      rawPayload: { message: result.data, system: "atendimento_reroute" },
    } });
    await transaction.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: occurredAt } });
    await transaction.conversationActivity.create({ data: {
      conversationId: conversation.id, action: "BOT_TRIAGE_COMPLETED",
      details: { categoryId: targetCategory.id, categoryName: targetCategory.name, reroutedFromAtendimento: true },
    } });
    await audit.recordAudit({
      actor: null,
      action: "CONVERSATION_CATEGORY_CHANGED",
      entityType: "CONVERSATION",
      entityId: conversation.id,
      summary: `Bot reclassificou a conversa de ${conversation.contact.customName || conversation.contact.name || conversation.contact.phone} de Atendimento para ${targetCategory.name}`,
      details: {
        conversationId: conversation.id,
        contactCustomName: conversation.contact.customName || null,
        contactName: conversation.contact.name || null,
        contactPhone: conversation.contact.phone,
        from: "Atendimento",
        to: targetCategory.name,
        fromCategoryId: conversation.categoryId,
        toCategoryId: targetCategory.id,
      },
    }, transaction);
  });
  return true;
}

async function handleIncomingTriage(event, message, channel, { now = new Date() } = {}) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: message.conversationId },
    include: {
      contact: true,
      channelAccount: { select: { config: true } },
      category: { select: { id: true, code: true } },
      messages: {
        where: { direction: "ENVIADA" }, orderBy: { occurredAt: "desc" }, take: 1,
        select: { rawPayload: true },
      },
    },
  });
  if (!conversation) return false;
  if (conversation.categoryId) {
    const rerouted = await tryAtendimentoRerouting(conversation, message, channel);
    return rerouted === null ? false : rerouted; // null = regra não se aplica -> Human takeover / já triado.
  }

  const bot = await getTriageBot();
  if (!bot) {
    logMisconfiguration(null, "Nenhum Bot SYSTEM_TRIAGE configurado — mensagem entregue sem triagem automática.", {});
    return false;
  }
  // Ativar/Desativar (item 3): desativado nunca impede a mensagem de entrar
  // na Central (já foi salva por saveIncoming antes desta chamada) — só
  // impede a automação de responder.
  if (bot.status !== "ACTIVE") return false;

  if (event.interactiveReplyId?.startsWith(categoryReplyPrefix)) {
    if (!scheduleState(bot, now).withinHours) return false;
    return routeTriageSelection(conversation, event.interactiveReplyId.slice(categoryReplyPrefix.length), channel, bot);
  }

  const hours = scheduleState(bot, now);
  const businessHours = hours.withinHours;
  const lastAutomation = conversation.messages[0]?.rawPayload?.system;
  const isRetryAfterHours = conversation.status === "BOT" && businessHours && lastAutomation === "after_hours";
  if (conversation.status === "NOVO") {
    const reopened = await isReopenedConversation(conversation.id);
    if (reopened && !bot.runAfterReopen) return false;
    if (!reopened && !bot.runOnNewConversation) return false;
  } else if (!isRetryAfterHours) {
    return false;
  }

  const claimed = await prisma.conversation.updateMany({
    where: {
      id: conversation.id, categoryId: null,
      status: conversation.status, updatedAt: conversation.updatedAt,
    },
    data: { status: "BOT" },
  });
  if (!claimed.count) return false;
  try {
    if (!businessHours) {
      const text = renderTemplate(hours.holiday && bot.holidayMessage ? bot.holidayMessage : bot.outsideHoursMessage, {
        ...greetingVars(conversation.contact), horario: describeSchedule(bot),
      });
      return await saveBotText(conversation, text, "after_hours", channel);
    }
    return await sendCategoryMenu(conversation, channel, bot);
  } catch (error) {
    await prisma.conversation.updateMany({
      where: { id: conversation.id, categoryId: null, status: "BOT" }, data: { status: "NOVO" },
    });
    throw error;
  }
}

// Simulador (item "Preview/Simulador"): mesma lógica de decisão de
// handleIncomingTriage, mas sem tocar em Conversation/Message/canal real —
// espelha o padrão puro de bot-simulator-service.simulateBot. `replyId` é o
// id de categoria escolhido (equivalente a um clique no item da lista);
// omitido, simula a primeira mensagem do cliente.
function simulateTriage(bot, { message, replyId, now = new Date() } = {}) {
  const contact = { name: "" };
  const hours = scheduleState(bot, now);
  const warning = "Simulação - nenhuma mensagem foi enviada";
  if (bot.status !== "ACTIVE") {
    return { simulation: true, sent: false, warning, active: false, response: null };
  }
  if (replyId) {
    const option = availableTriageOptions(bot).find((item) => item.categoryId === replyId);
    const children = subcategoryOptions(bot, replyId);
    if (!hours.withinHours) {
      return { simulation: true, sent: false, warning, withinHours: false, response: null };
    }
    if (children.length) {
      const parentCategory = option?.category || children[0].category.parent;
      return {
        simulation: true, sent: false, warning, withinHours: true, step: "SUBCATEGORY",
        response: "Perfeito! Para continuarmos, escolha abaixo o tipo de atendimento que voc\u00ea precisa.",
        parentCategory: { id: parentCategory.id, name: parentCategory.name, code: parentCategory.code },
        options: children.map((child) => ({
          id: child.categoryId, label: child.label, categoryName: child.category.name,
        })),
      };
    }
    if (!option) {
      return {
        simulation: true, sent: false, warning, withinHours: true,
        response: renderTemplate(bot.initialMessage, { ...greetingVars(contact), horario: describeSchedule(bot) }),
        note: "Opção inválida — o menu seria reenviado.",
      };
    }
    return {
      simulation: true, sent: false, warning, withinHours: true,
      response: renderTemplate(bot.handoffMessage, { ...greetingVars(contact), categoria: option.category.name }),
      category: { id: option.category.id, name: option.category.name, code: option.category.code },
    };
  }
  if (!hours.withinHours) {
    return {
      simulation: true, sent: false, warning, withinHours: false,
      response: renderTemplate(hours.holiday && bot.holidayMessage ? bot.holidayMessage : bot.outsideHoursMessage, { ...greetingVars(contact), horario: describeSchedule(bot) }),
    };
  }
  const options = topLevelOptions(bot);
  if (!options.length) {
    return {
      simulation: true, sent: false, warning, withinHours: true,
      response: bot.fallbackMessage,
      note: "Nenhuma opção de triagem ativa — mensagem de fallback seria usada.",
    };
  }
  return {
    simulation: true, sent: false, warning, withinHours: true,
    response: renderTemplate(bot.initialMessage, { ...greetingVars(contact), horario: describeSchedule(bot) }),
    options: options.map((option) => ({ id: option.categoryId, label: option.category.name, categoryName: option.category.name })),
  };
}

module.exports = {
  businessHoursText, categoryReplyId, describeSchedule, getTriageBot,
  handleIncomingTriage, isBusinessHours, renderTemplate, simulateTriage,
};
