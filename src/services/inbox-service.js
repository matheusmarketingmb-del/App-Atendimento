const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const { removeImage } = require("./media-storage-service");
const audit = require("./audit-service");
const internalChat = require("./internal-chat-service");
const { getConversationSettings } = require("./conversation-settings-service");

const conversationStatuses = new Set([
  "NOVO", "EM_ATENDIMENTO", "AGUARDANDO_EQUIPE", "AGUARDANDO_CLIENTE", "HANDOFF_BOT", "BOT", "FINALIZADO",
]);
const conversationPriorities = new Set(["NORMAL", "ALTA", "URGENTE"]);
// Status "ativos" para os efeitos de fila/alerta de gestão (exclui BOT —
// fluxo de triagem automatizada — e FINALIZADO).
const activeManagedStatuses = ["NOVO", "EM_ATENDIMENTO", "AGUARDANDO_EQUIPE", "AGUARDANDO_CLIENTE", "HANDOFF_BOT"];
const notManualSpam = { OR: [{ emailMailboxOverride: null }, { emailMailboxOverride: { not: "SPAM" } }] };
const categoryColorPattern = /^#[0-9a-f]{6}$/i;

function validateCategoryName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw Object.assign(new Error("Nome da categoria é obrigatório."), { statusCode: 400 });
  if (name.length > 60) throw Object.assign(new Error("O nome da categoria deve ter no máximo 60 caracteres."), { statusCode: 400 });
  return name;
}

function validateCategoryColor(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !categoryColorPattern.test(value)) {
    throw Object.assign(new Error("Cor da categoria inválida."), { statusCode: 400 });
  }
  return value.toLowerCase();
}

function categoryCode(name) {
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50) || "CATEGORIA";
}

function activityRecord(conversationId, actorUserId, action, details) {
  return { conversationId, actorUserId: actorUserId || null, action, details: details || undefined };
}

async function recordConversationActivity({ conversationId, actorUserId, action, details }, client = prisma) {
  return client.conversationActivity.create({
    data: activityRecord(conversationId, actorUserId, action, details),
  });
}

function categoryLabelForHistory(category) {
  return category?.parent ? `${category.parent.name}: ${category.name}` : category?.name;
}

function categorySectorId(category) {
  return category?.parentId || category?.id || null;
}

function contactAuditSnapshot(conversation) {
  return {
    conversationId: conversation.id,
    contactCustomName: conversation.contact?.customName || null,
    contactName: conversation.contact?.name || null,
    contactPhone: conversation.contact?.phone || null,
    contactEmail: conversation.contact?.email || null,
  };
}

// A fila acompanha a atividade real: a conversa que recebeu ou enviou a
// mensagem mais recente aparece primeiro. Conversas sem mensagens usam a
// data de criacao como fallback.
function compareByLatestMessage(left, right) {
  const leftTime = (left.lastMessageAt || left.createdAt).getTime();
  const rightTime = (right.lastMessageAt || right.createdAt).getTime();
  return rightTime - leftTime;
}

// SLA restante (item 10 — UI): minutos até estourar (negativo = já
// estourado). Só se aplica quando o SLA correspondente está ligado e o
// status da conversa é o que aquele SLA de fato mede — fora disso (ex.:
// AGUARDANDO_CLIENTE, EM_ATENDIMENTO em dia, FINALIZADO) não há "restante"
// a mostrar, retorna null (o front trata como "sem SLA aplicável agora").
function computeSlaMinutesRemaining(conversation, settings, now) {
  const waitingSince = conversation.lastMessageAt || conversation.createdAt;
  if (conversation.status === "NOVO" && settings.firstResponseSlaEnabled) {
    const deadline = waitingSince.getTime() + settings.firstResponseSlaMinutes * 60 * 1000;
    return Math.round((deadline - now.getTime()) / 60000);
  }
  if (["AGUARDANDO_EQUIPE", "HANDOFF_BOT"].includes(conversation.status) && settings.responseSlaEnabled) {
    const deadline = waitingSince.getTime() + settings.responseSlaMinutes * 60 * 1000;
    return Math.round((deadline - now.getTime()) / 60000);
  }
  return null;
}

function contactDisplayName(contact) {
  return contact?.customName || contact?.name || contact?.email || contact?.phone || "Contato";
}

async function listConversations({
  search, category, status, assignedUser, activeOnly, priority, slaBreached, unassigned, channel,
}, viewer) {  const where = {};

  // Filtros combináveis (item 11): status aceita lista separada por vírgula
  // (ex.: "AGUARDANDO_EQUIPE,HANDOFF_BOT") sem deixar de aceitar um único
  // valor, mesmo padrão já usado para `channel` (ver channel-filter no
  // frontend). Cada filtro abaixo é independente — todos entram no mesmo
  // `AND` implícito do objeto `where`, então combinam livremente.
  if (status) {
    const statuses = String(status).split(",").map((value) => value.trim()).filter(Boolean);
    if (statuses.includes("EM_ATENDIMENTO")) {
      const regularStatuses = statuses.filter((value) => value !== "EM_ATENDIMENTO");
      where.AND = [...(where.AND || []), { OR: [
        ...(regularStatuses.length ? [{ status: { in: regularStatuses } }] : []),
        { assignedUserId: { not: null }, status: { notIn: ["NOVO", "FINALIZADO"] } },
      ] }];
    } else {
      where.status = statuses.length > 1 ? { in: statuses } : statuses[0];
    }
  } else if (activeOnly === "true") {
    where.status = { not: "FINALIZADO" };
  }

  if (priority) {
    const priorities = String(priority).split(",").map((value) => value.trim()).filter(Boolean);
    where.priority = priorities.length > 1 ? { in: priorities } : priorities[0];
  }

  // "SLA atrasado" (item 11): primeira resposta OU resposta durante
  // atendimento, qualquer um dos dois já é suficiente.
  if (slaBreached === "true") {
    where.OR = [{ firstResponseSlaBreached: true }, { responseSlaBreached: true }];
  }

  if (unassigned === "true") where.assignedUserId = null;

  if (channel) {
    const channels = String(channel).split(",").filter(Boolean);
    where.channel = channels.length > 1 ? { in: channels } : channels[0];
  }

  if (category === "UNCATEGORIZED") {
    where.categoryId = null;
  } else if (category) {
    where.category = {
      OR: [
        { code: category },
        { parent: { is: { code: category } } },
      ],
    };
  }

  if (search) {
    where.contact = {
      OR: [
        { customName: { contains: search, mode: "insensitive" } },
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { phone: { contains: search } },
      ],
    };
  }

  if (assignedUser) {
    if (
      !authorization.isMaster(viewer) &&
      !viewer.canViewTeamActivity &&
      assignedUser !== viewer.id
    ) {
      throw authorization.forbidden(
        "Você não pode consultar os atendimentos de outro usuário."
      );
    }

    where.assignedUserId = assignedUser;
  }

  const scope = await authorization.conversationScope(viewer);
  const master = authorization.isMaster(viewer);

  const conversations = await prisma.conversation.findMany({
    where: { AND: [where, scope] },

    include: {
      contact: {
        include: {
          notes: {
            orderBy: [
              { pinned: "desc" },
              { createdAt: "desc" },
            ],
            take: 1,
          },

          _count: {
            select: {
              notes: true,
            },
          },
        },
      },

      category: {
        include: {
          parent: true,
        },
      },

      channelAccount: { select: { id: true, name: true, externalAccountId: true, providerMetadata: true, config: true } },

      assignedUser: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },

      messages: {
        where: {
          type: {
            not: "reaction",
          },
        },
        orderBy: {
          occurredAt: "desc",
        },
        take: 1,
      },

      pins: {
        where: {
          userId: viewer.id,
        },
        select: {
          createdAt: true,
        },
        take: 1,
      },

      ...(master
        ? {
            masterReads: {
              where: {
                userId: viewer.id,
              },
              select: {
                readAt: true,
              },
              take: 1,
            },
          }
        : {}),
    },

    orderBy: [
      { lastMessageAt: "desc" },
      { createdAt: "desc" },
    ],
  });

  const emailConversationIds = conversations.filter((conversation) => conversation.channel === "EMAIL").map((conversation) => conversation.id);
  const emailMailboxByConversation = new Map();
  if (emailConversationIds.length) {
    const inboundEmailMessages = await prisma.message.findMany({
      where: { conversationId: { in: emailConversationIds }, channel: "EMAIL", direction: "RECEBIDA", type: { not: "reaction" } },
      select: { conversationId: true, rawPayload: true },
      orderBy: { occurredAt: "desc" },
    });
    for (const message of inboundEmailMessages) {
      if (!emailMailboxByConversation.has(message.conversationId)) {
        emailMailboxByConversation.set(message.conversationId, message.rawPayload?.gmailMailbox || "GENERAL");
      }
    }
  }

  // A listagem só traz metadata + a prévia da última mensagem. Quando o
  // atendente recebeu a conversa sem histórico, a prévia não pode ser de uma
  // mensagem da etapa oculta. Só as conversas com transferência explícita
  // sem histórico para ele precisam do cálculo completo (consulta única).
  const hiddenPreviewIds = new Set();
  if (!master && conversations.length) {
    const limitedTransfers = await prisma.conversationActivity.findMany({
      where: {
        conversationId: { in: conversations.map(({ id }) => id) },
        action: "CONVERSATION_TRANSFERRED",
        AND: [
          { details: { path: ["toUserId"], equals: viewer.id } },
          { details: { path: ["historyShared"], equals: false } },
        ],
      },
      select: { conversationId: true },
      distinct: ["conversationId"],
    });
    for (const { conversationId } of limitedTransfers) {
      const conversation = conversations.find(({ id }) => id === conversationId);
      const preview = conversation?.messages?.[0];
      if (!preview) continue;
      const { start } = await historyVisibility(conversation, viewer);
      if (start && preview.occurredAt < start) hiddenPreviewIds.add(conversationId);
    }
  }

  let masterUnreadCounts = new Map();

  if (master && conversations.length) {
    const counts = await Promise.all(
      conversations.map(async (conversation) => {
        const readAt = conversation.masterReads?.[0]?.readAt;

        /*
         * O registro será criado para cada Master no deploy.
         * Este fallback evita contar todo o histórico caso algum
         * usuário ainda não possua ConversationMasterRead.
         */
        if (!readAt) {
          return [conversation.id, conversation.unreadCount];
        }

        const unreadCount = await prisma.message.count({
          where: {
            conversationId: conversation.id,
            direction: "RECEBIDA",
            type: {
              not: "reaction",
            },
            createdAt: {
              gt: readAt,
            },
          },
        });

        return [conversation.id, unreadCount];
      })
    );

    masterUnreadCounts = new Map(counts);
  }

  const now = new Date();
  const slaSettings = await getConversationSettings();

  return conversations
    .map((conversation) => {
      const {
        pins,
        masterReads,
        ...rest
      } = conversation;

      return {
        ...rest,
        ...(hiddenPreviewIds.has(conversation.id) ? { messages: [] } : {}),

        unreadCount: master
          ? masterUnreadCounts.get(conversation.id) || 0
          : conversation.unreadCount,

        isPinned: pins.length > 0,
        ...(conversation.channel === "EMAIL" ? { emailMailbox: conversation.emailMailboxOverride || emailMailboxByConversation.get(conversation.id) || "GENERAL" } : {}),
        slaMinutesRemaining: computeSlaMinutesRemaining(conversation, slaSettings, now),
      };
    })
    // Fixadas manualmente continuam no topo por escolha explicita do usuario;
    // todas as demais seguem a ultima atividade, da mais nova para a mais antiga.
    .sort((left, right) => {
      const pinDiff = Number(right.isPinned) - Number(left.isPinned);
      if (pinDiff !== 0) return pinDiff;
      return compareByLatestMessage(left, right);
    });
}

function alertSince(value) {
  const parsed = value ? new Date(value) : new Date();
  const minimum = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (Number.isNaN(parsed.getTime())) throw Object.assign(new Error("Data inicial inválida."), { statusCode: 400 });
  return parsed < minimum ? minimum : parsed;
}

async function getUserAlerts({ since }, viewer) {
  const checkedAt = new Date();
  const occurredAfter = alertSince(since);
  const scope = await authorization.conversationScope(viewer);
  const master = authorization.isMaster(viewer);
  const alertScope = { AND: [scope, notManualSpam] };
  const waitingForViewer = {
    AND: [alertScope, { status: "AGUARDANDO_EQUIPE" }, {
      OR: [{ assignedUserId: null }, { assignedUserId: viewer.id }],
    }],
  };
  const [messages, activities] = await Promise.all([
    prisma.message.findMany({
      where: {
        createdAt: { gt: occurredAfter, lte: checkedAt }, direction: "RECEBIDA", type: { not: "reaction" },
        conversation: { is: waitingForViewer },
      },
      include: { conversation: { include: {
        contact: true,
        category: { include: { parent: true } },
        ...(master ? { masterReads: {
          where: { userId: viewer.id }, select: { readAt: true }, take: 1,
        } } : {}),
      } } },
      orderBy: { createdAt: "asc" }, take: 30,
    }),
    prisma.conversationActivity.findMany({
      where: {
        createdAt: { gt: occurredAfter, lte: checkedAt },
        action: { in: ["CATEGORY_CHANGED", "CONVERSATION_TRANSFERRED"] },
        conversation: { is: alertScope },
      },
      include: { conversation: { include: { contact: true, category: { include: { parent: true } } } } },
      orderBy: { createdAt: "asc" }, take: 30,
    }),
  ]);

const incoming = messages.filter((message) => {
  if (!master) return message.conversation.unreadCount > 0;
  const readAt = message.conversation.masterReads?.[0]?.readAt;
  return readAt
    ? new Date(message.createdAt) > new Date(readAt)
    : message.conversation.unreadCount > 0;
}).map((message) => {
  const contactName =
    message.conversation.contact.customName ||
    message.conversation.contact.name ||
    message.conversation.contact.email ||
    message.conversation.contact.phone;

  return {
    id: `message:${message.id}`,
    conversationId: message.conversationId,
    title: `${contactName} mandou uma mensagem`,
    text: "",
    createdAt: message.occurredAt,
  };
});

  const changes = activities.filter((activity) => {
    if (activity.actorUserId === viewer.id) return false;
    if (activity.action === "CONVERSATION_TRANSFERRED") return activity.details?.toUserId === viewer.id;
    return true;
  }).map((activity) => ({
    id: `activity:${activity.id}`, conversationId: activity.conversationId,
    title: activity.action === "CONVERSATION_TRANSFERRED" ? "Conversa transferida para você" : "Nova conversa na sua área",
    text: `${contactDisplayName(activity.conversation.contact)} • ${categoryLabelForHistory(activity.conversation.category) || "Sem categoria"}`,
    createdAt: activity.createdAt,
  }));
  return {
    checkedAt,
    alerts: [...incoming, ...changes]
      .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt))
      .slice(-30),
  };
}

// Transferência para pessoa com escolha explícita "compartilhar histórico?"
// (details.historyShared boolean). Transferências antigas/sem escolha não
// têm o campo e seguem a regra anterior (canViewPreviousMessages/limitHistory).
function isExplicitHistoryTransfer(activity) {
  return activity.action === "CONVERSATION_TRANSFERRED" && typeof activity.details?.historyShared === "boolean";
}

// Regra anterior de recorte (limitHistory do setor / canViewPreviousMessages),
// preservada para fila de setor, "assumir" e transferências sem escolha.
// Retorna null (histórico completo) ou a data a partir da qual vê.
async function legacyHistoryStart(activities, viewer) {
  if (viewer.canViewPreviousMessages) return null;
  const categoryIds = [...new Set(activities.flatMap(({ details }) => [
    details?.fromCategoryId, details?.toCategoryId,
  ]).filter(Boolean))];
  const categories = categoryIds.length ? await prisma.category.findMany({
    where: { id: { in: categoryIds } }, select: { id: true, parentId: true },
  }) : [];
  const categorySectors = new Map(categories.map((category) => [category.id, category.parentId || category.id]));
  const allowedCategoryIds = new Set(await authorization.allowedCategoryIds(viewer));
  const isSectorChange = (activity) => {
    if (activity.action !== "CATEGORY_CHANGED") return false;
    if (typeof activity.details?.sectorChanged === "boolean") return activity.details.sectorChanged;
    const fromCategoryId = activity.details?.fromCategoryId || null;
    const toCategoryId = activity.details?.toCategoryId || null;
    return (categorySectors.get(fromCategoryId) || fromCategoryId)
      !== (categorySectors.get(toCategoryId) || toCategoryId);
  };
  const reversed = [...activities].reverse();
  const latestCategoryChange = reversed.find(isSectorChange);
  if (latestCategoryChange?.details?.historyLimited === false) return null;
  const strictBoundary = reversed.find((activity) => {
    if (activity.action === "CONVERSATION_TRANSFERRED") return activity.details?.toUserId === viewer.id;
    if (!isSectorChange(activity)) return false;
    return allowedCategoryIds.has(activity.details?.toCategoryId || null);
  });
  return strictBoundary ? strictBoundary.createdAt : null;
}

// Início do histórico visível para um atendente (Master nunca passa por
// aqui). Cada forma de acesso que o atendente já recebeu nesta conversa é
// um "ponto de entrada"; ele enxerga a partir do MAIS ANTIGO deles:
//   - transferência explícita COM histórico  → histórico completo;
//   - transferência explícita SEM histórico  → a partir da transferência;
//   - assumiu da fila / transferência antiga / fila atual → regra anterior;
//   - mensagens que ele mesmo enviou         → a partir da primeira delas.
// Por isso quem recebe a conversa de volta (A → B sem histórico → A) volta a
// ver tudo: a etapa original dele E a etapa do B. Nada é apagado — é só um
// filtro de leitura. Retorna null (completo) ou a data de corte.
function resolveHistoryStart({ viewerId, activities, legacyStart, firstOwnMessageAt, inQueue }) {
  const entries = [];
  let legacyAccess = Boolean(inQueue);
  let explicitAccess = false;
  for (const activity of activities) {
    if (activity.details?.toUserId !== viewerId) continue;
    if (isExplicitHistoryTransfer(activity)) {
      explicitAccess = true;
      entries.push(activity.details.historyShared ? null : new Date(activity.createdAt));
    } else if (["CONVERSATION_TRANSFERRED", "CONVERSATION_CLAIMED"].includes(activity.action)) {
      legacyAccess = true;
    }
  }
  if (legacyAccess || !explicitAccess) entries.push(legacyStart || null);
  if (firstOwnMessageAt) entries.push(new Date(firstOwnMessageAt));
  if (!entries.length || entries.some((entry) => entry === null)) return null;
  return new Date(Math.min(...entries.map((entry) => entry.getTime())));
}

async function historyVisibility(conversation, viewer) {
  if (authorization.isMaster(viewer)) return { start: null, limited: false };
  const [activities, firstOwnMessage] = await Promise.all([
    prisma.conversationActivity.findMany({
      where: {
        conversationId: conversation.id,
        action: { in: ["CONVERSATION_TRANSFERRED", "CONVERSATION_CLAIMED", "CATEGORY_CHANGED"] },
      },
      select: { action: true, createdAt: true, details: true }, orderBy: { createdAt: "asc" },
    }),
    prisma.message.findFirst({
      where: { conversationId: conversation.id, sentByUserId: viewer.id },
      orderBy: { occurredAt: "asc" }, select: { occurredAt: true },
    }),
  ]);
  const legacyStart = await legacyHistoryStart(activities.filter((activity) => !isExplicitHistoryTransfer(activity)), viewer);
  const start = resolveHistoryStart({
    viewerId: viewer.id, activities, legacyStart,
    firstOwnMessageAt: firstOwnMessage?.occurredAt, inQueue: !conversation.assignedUserId,
  });
  return { start, limited: Boolean(start) };
}

// Transferência mais recente para o responsável atual: mostra ao novo
// atendente de quem veio, se o histórico foi compartilhado, motivo e resumo
// de handoff — inclusive quando o histórico anterior está oculto.
async function currentHandoffFor(conversation, viewer) {
  if (!conversation.assignedUserId || conversation.assignedUserId !== viewer.id) return null;
  const transfer = await prisma.conversationActivity.findFirst({
    where: { conversationId: conversation.id, action: "CONVERSATION_TRANSFERRED" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, details: true, actorUser: { select: { id: true, name: true } } },
  });
  if (!transfer || transfer.details?.toUserId !== viewer.id) return null;
  return {
    at: transfer.createdAt,
    from: transfer.details.from || null,
    transferredBy: transfer.actorUser?.name || null,
    historyShared: typeof transfer.details.historyShared === "boolean" ? transfer.details.historyShared : null,
    reason: transfer.details.reason || null,
    handoffSummary: transfer.details.handoffSummary || null,
  };
}

// Anexo/mensagem por ID: além do acesso à conversa, a mensagem precisa estar
// dentro do histórico visível do usuário (evita baixar anexo de etapa oculta
// só por conhecer o ID).
async function assertCanViewMessage(viewer, messageId) {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, conversationId: true, occurredAt: true, mediaStorageKey: true, mediaMimeType: true, mediaFileName: true },
  });
  if (!message) throw Object.assign(new Error("Mídia não encontrada."), { statusCode: 404 });
  const conversation = await authorization.assertCanViewConversation(viewer, message.conversationId);
  const { start } = await historyVisibility(conversation, viewer);
  if (start && message.occurredAt < start) throw Object.assign(new Error("Mídia não encontrada."), { statusCode: 404 });
  return message;
}

async function getConversation(id, viewer) {
  const scope = await authorization.conversationScope(viewer);
  const canViewHistory = authorization.isMaster(viewer) || Boolean(viewer.canViewConversationHistory);
  const access = await prisma.conversation.findFirst({
    where: { AND: [{ id }, scope] }, select: { id: true, categoryId: true, assignedUserId: true },
  });
  if (!access) {
    const error = await authorization.conversationAccessError(viewer, id);
    if (error.statusCode === 403) throw error;
    return null;
  }
  const visibility = await historyVisibility(access, viewer);
  const messageVisibility = {
    where: visibility.start ? { occurredAt: { gte: visibility.start } } : undefined,
    limited: visibility.limited,
  };
  const currentHandoff = await currentHandoffFor(access, viewer);
  return prisma.conversation.findFirst({
    where: { AND: [{ id }, scope] },
    include: {
      category: { include: { parent: true } },
      channelAccount: { select: { id: true, name: true, externalAccountId: true, providerMetadata: true, config: true } },
      assignedUser: { select: { id: true, name: true, email: true } },
      messages: {
        where: messageVisibility.where,
        include: { sentByUser: { select: { id: true, name: true } } },
        orderBy: { occurredAt: "asc" },
      },
      contact: {
        include: {
          notes: {
            include: { author: { select: { id: true, name: true } } },
            orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
          },
        },
      },
      pins: { where: { userId: viewer.id }, select: { createdAt: true }, take: 1 },
      botState: { select: { humanPausedAt: true } },
      activities: canViewHistory ? {
        // O histórico de eventos segue o mesmo recorte das mensagens: quem
        // recebeu sem histórico não vê notas/eventos da etapa anterior.
        where: visibility.start ? { createdAt: { gte: visibility.start } } : undefined,
        include: { actorUser: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
        take: 100,
      } : false,
    },
  }).then((conversation) => {
    if (!conversation) return null;
    const { pins, botState, ...result } = conversation;
    const latestInboundEmail = conversation.channel === "EMAIL"
      ? [...conversation.messages].reverse().find((message) => message.direction === "RECEBIDA" && message.type !== "reaction")
      : null;
    return {
      ...result, isPinned: pins.length > 0, canViewHistory, messageHistoryLimited: messageVisibility.limited,
      historyVisibleFrom: visibility.start, currentHandoff,
      botPausedAt: botState?.humanPausedAt || null,
      ...(conversation.channel === "EMAIL" ? { emailMailbox: conversation.emailMailboxOverride || latestInboundEmail?.rawPayload?.gmailMailbox || "GENERAL" } : {}),
    };
  });
}

async function getConversationSummary(viewer) {
  const scope = await authorization.conversationScope(viewer);
  const summaryScope = { AND: [scope, notManualSpam] };
  const master = authorization.isMaster(viewer);
  const attentionScope = { AND: [summaryScope, { status: "AGUARDANDO_EQUIPE" }, {
    OR: [{ assignedUserId: null }, { assignedUserId: viewer.id }],
  }] };
  // Contadores novos (item 12): Atrasadas/Urgentes/Sem responsável — sempre
  // dentro do escopo do usuário (mesma regra de visibilidade das demais
  // contagens) e só entre conversas ativas (nunca FINALIZADO/BOT).
  const overdueScope = { AND: [summaryScope, { status: { in: activeManagedStatuses } },
    { OR: [{ firstResponseSlaBreached: true }, { responseSlaBreached: true }] }] };
  const urgentScope = { AND: [summaryScope, { status: { in: activeManagedStatuses } }, { priority: "URGENTE" }] };
  const unassignedScope = { AND: [summaryScope, { status: { in: activeManagedStatuses } }, { assignedUserId: null }] };
  const inProgressScope = { AND: [summaryScope, { assignedUserId: { not: null } }, { status: { notIn: ["NOVO", "FINALIZADO"] } }] };
  const [total, statuses, inProgressCount, categories, waitingConversations, overdue, urgent, unassignedCount] = await Promise.all([
    prisma.conversation.count({ where: summaryScope }),
    prisma.conversation.groupBy({ by: ["status"], where: summaryScope, _count: { _all: true } }),
    prisma.conversation.count({ where: inProgressScope }),
    prisma.conversation.groupBy({
      by: ["categoryId"],
      where: summaryScope,
      _count: { _all: true },
    }),
    prisma.conversation.findMany({
      where: attentionScope,
      select: {
        id: true,
        unreadCount: true,
        ...(master ? { masterReads: {
          where: { userId: viewer.id }, select: { readAt: true }, take: 1,
        } } : {}),
      },
    }),
    prisma.conversation.count({ where: overdueScope }),
    prisma.conversation.count({ where: urgentScope }),
    prisma.conversation.count({ where: unassignedScope }),
  ]);
  const unreadWaiting = master
    ? await Promise.all(waitingConversations.map(async (conversation) => {
        const readAt = conversation.masterReads?.[0]?.readAt;
        if (!readAt) return conversation.unreadCount > 0;
        return (await prisma.message.count({ where: {
          conversationId: conversation.id,
          direction: "RECEBIDA",
          type: { not: "reaction" },
          createdAt: { gt: readAt },
        } })) > 0;
      }))
    : waitingConversations.map((conversation) => conversation.unreadCount > 0);
  return {
    total,
    attentionWaiting: unreadWaiting.filter(Boolean).length,
    overdue,
    urgent,
    unassigned: unassignedCount,
    statuses: { ...Object.fromEntries(statuses.map((item) => [item.status, item._count._all])), EM_ATENDIMENTO: inProgressCount },
    categories: Object.fromEntries(categories.map((item) => [item.categoryId, item._count._all])),
  };
}

async function addContactNote(contactId, { content, authorId, conversationId }, viewer) {
  await authorization.assertCanAccessContact(viewer, contactId);
  if (conversationId) {
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, contactId }, select: { id: true } });
    if (!conversation) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
  }
  const text = content?.trim();
  if (!text) throw Object.assign(new Error("A nota não pode ficar vazia."), { statusCode: 400 });
  if (text.length > 2000) throw Object.assign(new Error("A nota deve ter no máximo 2.000 caracteres."), { statusCode: 400 });
  try {
    return await prisma.$transaction(async (transaction) => {
      const note = await transaction.contactNote.create({
        data: { contactId, content: text, authorId: authorId || null },
        include: { author: { select: { id: true, name: true } } },
      });
      if (conversationId) await recordConversationActivity({
        conversationId, actorUserId: authorId, action: "NOTE_ADDED",
        details: { preview: text.slice(0, 120) },
      }, transaction);
      return note;
    });
  } catch (error) {
    if (error.code === "P2003") throw Object.assign(new Error("Contato não encontrado."), { statusCode: 404 });
    throw error;
  }
}

async function deleteContactNote(contactId, noteId, { conversationId }, viewer) {
  authorization.assertMaster(viewer);
  await authorization.assertCanAccessContact(viewer, contactId);
  const note = await prisma.contactNote.findFirst({ where: { id: noteId, contactId } });
  if (!note) throw Object.assign(new Error("Nota não encontrada."), { statusCode: 404 });
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, contactId }, select: { id: true },
  });
  if (!conversation) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
  return prisma.$transaction(async (transaction) => {
    await transaction.contactNote.delete({ where: { id: noteId } });
    await recordConversationActivity({
      conversationId, actorUserId: viewer.id, action: "NOTE_DELETED",
      details: { preview: note.content.slice(0, 120), wasPinned: note.pinned },
    }, transaction);
    await audit.recordAudit({
      actor: viewer,
      action: "NOTE_DELETED",
      entityType: "NOTE",
      entityId: note.id,
      summary: "Apagou uma nota interna de contato",
      details: { contactId, conversationId, preview: note.content.slice(0, 120), wasPinned: note.pinned },
    }, transaction);
    return { deleted: true };
  });
}

async function deleteConversation(id, viewer) {
  authorization.assertMaster(viewer);
  const conversation = await prisma.conversation.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      category: { select: { id: true, name: true } },
      assignedUser: { select: { id: true, name: true, email: true } },
      contact: { select: { id: true, name: true, customName: true, phone: true } },
      _count: { select: { messages: true, activities: true, pins: true } },
      messages: {
        where: { mediaStorageKey: { not: null } },
        select: { mediaStorageKey: true },
      },
    },
  });
  if (!conversation) {
    throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
  }
  await prisma.$transaction(async (transaction) => {
    await audit.recordAudit({
      actor: viewer,
      action: "CONVERSATION_DELETED",
      entityType: "CONVERSATION",
      entityId: conversation.id,
      summary: `Apagou a conversa de ${contactDisplayName(conversation.contact)}`,
      details: {
        contact: conversation.contact,
        status: conversation.status,
        category: conversation.category,
        assignedUser: conversation.assignedUser,
        removedRecords: conversation._count,
      },
    }, transaction);
    await transaction.conversation.delete({ where: { id } });
  });
  const mediaKeys = [...new Set(conversation.messages.map(({ mediaStorageKey }) => mediaStorageKey).filter(Boolean))];
  await Promise.allSettled(mediaKeys.map((storageKey) => removeImage(storageKey)));
  return { deleted: true, id };
}

async function setEmailSpamStatus(id, { spam }, viewer) {
  if (typeof spam !== "boolean") {
    throw Object.assign(new Error("Informe se a conversa deve ser marcada como spam."), { statusCode: 400 });
  }
  await authorization.assertCanViewConversation(viewer, id);
  const current = await prisma.conversation.findUnique({
    where: { id },
    select: { id: true, channel: true, emailMailboxOverride: true, contact: { select: { name: true, customName: true, email: true, phone: true } } },
  });
  if (!current) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
  if (current.channel !== "EMAIL") {
    throw Object.assign(new Error("A ação de spam está disponível somente para conversas de e-mail."), { statusCode: 409 });
  }
  const mailbox = spam ? "SPAM" : "GENERAL";
  return prisma.$transaction(async (transaction) => {
    const conversation = await transaction.conversation.update({
      where: { id }, data: { emailMailboxOverride: mailbox },
      include: { contact: true, category: { include: { parent: true } }, assignedUser: { select: { id: true, name: true, email: true } } },
    });
    await recordConversationActivity({
      conversationId: id, actorUserId: viewer.id, action: "EMAIL_SPAM_CHANGED",
      details: { spam, from: current.emailMailboxOverride || "PROVIDER", to: mailbox },
    }, transaction);
    await audit.recordAudit({
      actor: viewer, action: "EMAIL_SPAM_CHANGED", entityType: "CONVERSATION", entityId: id,
      summary: `${spam ? "Marcou" : "Removeu"} a conversa de ${contactDisplayName(current.contact)} ${spam ? "como spam" : "do spam"}`,
      details: { conversationId: id, spam, from: current.emailMailboxOverride || "PROVIDER", to: mailbox },
    }, transaction);
    return { ...conversation, emailMailbox: mailbox };
  });
}

async function setContactNotePinned(contactId, noteId, { pinned, conversationId }, viewer) {
  await authorization.assertCanAccessContact(viewer, contactId);
  if (typeof pinned !== "boolean") {
    throw Object.assign(new Error("Informe se a nota deve ser fixada."), { statusCode: 400 });
  }
  const note = await prisma.contactNote.findFirst({ where: { id: noteId, contactId } });
  if (!note) throw Object.assign(new Error("Nota não encontrada."), { statusCode: 404 });
  if (conversationId) {
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, contactId }, select: { id: true } });
    if (!conversation) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
  }
  return prisma.$transaction(async (transaction) => {
    if (pinned) {
      await transaction.contactNote.updateMany({
        where: { contactId, id: { not: noteId }, pinned: true },
        data: { pinned: false },
      });
    }
    const updated = await transaction.contactNote.update({
      where: { id: noteId }, data: { pinned },
      include: { author: { select: { id: true, name: true } } },
    });
    if (conversationId) await recordConversationActivity({
      conversationId, actorUserId: viewer.id, action: pinned ? "NOTE_PINNED" : "NOTE_UNPINNED",
      details: { preview: note.content.slice(0, 120) },
    }, transaction);
    return updated;
  });
}

function optionalTransferText(value, label, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw Object.assign(new Error(`${label} inválido.`), { statusCode: 400 });
  const text = value.trim();
  if (text.length > maxLength) {
    throw Object.assign(new Error(`${label} deve ter no máximo ${maxLength} caracteres.`), { statusCode: 400 });
  }
  return text || null;
}

async function updateConversation(id, {
  categoryId, status, assignedUserId, priority, limitHistory, shareHistory, transferReason, handoffSummary,
}, viewer) {
  if (shareHistory !== undefined && typeof shareHistory !== "boolean") {
    throw Object.assign(new Error("Informe se o histórico deve ser compartilhado."), { statusCode: 400 });
  }
  const reason = optionalTransferText(transferReason, "Motivo da transferência", 500);
  const summary = optionalTransferText(handoffSummary, "Resumo de handoff", 2000);
  const currentAccess = await authorization.assertCanViewConversation(viewer, id);
  const currentSnapshot = await prisma.conversation.findUnique({
    where: { id },
    include: {
      category: { include: { parent: true } },
      assignedUser: { select: { id: true, name: true } },
    },
  });
  if (!currentSnapshot) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
  if (status && !conversationStatuses.has(status)) {
    throw Object.assign(new Error("Status inválido."), { statusCode: 400 });
  }
  if (priority !== undefined) {
    if (!conversationPriorities.has(priority)) {
      throw Object.assign(new Error("Prioridade inválida."), { statusCode: 400 });
    }
    authorization.assertCanSetPriority(viewer);
  }
  let targetCategory = currentSnapshot.category;
  if (categoryId) {
    targetCategory = await prisma.category.findFirst({
      where: { id: categoryId, active: true }, include: { parent: true },
    });
    if (!targetCategory) throw Object.assign(new Error("Categoria não encontrada ou inativa."), { statusCode: 400 });
    await authorization.assertChannelAccountAllowsCategory(currentSnapshot.channelAccountId, categoryId);
    if (!authorization.isMaster(viewer) && (targetCategory.masterOnly || targetCategory.parent?.masterOnly)) {
      throw authorization.forbidden("Esta categoria e exclusiva para contas Master.");
    }
  }
  if (categoryId === null) targetCategory = null;
  if (categoryId === null && !authorization.canTransfer(viewer)
    && !(await authorization.canAccessCategory(viewer, null))) {
    throw authorization.forbidden("Você não pode remover a categoria desta conversa.");
  }
  if (assignedUserId) {
    const user = await prisma.user.findFirst({ where: { id: assignedUserId, active: true } });
    if (!user) throw Object.assign(new Error("Atendente não encontrado ou inativo."), { statusCode: 400 });
    if (!(await authorization.canAccessChannelAccount(user, currentSnapshot.channelAccountId))) {
      throw Object.assign(new Error("O atendente não foi liberado para esta conta de canal."), { statusCode: 400 });
    }
    const targetCategoryId = categoryId !== undefined ? categoryId : currentAccess.categoryId;
    if (!(await authorization.canAccessCategory(user, targetCategoryId))) {
      throw Object.assign(new Error("O atendente não possui acesso à categoria desta conversa."), { statusCode: 400 });
    }
  }
  if (assignedUserId !== undefined && !authorization.canTransfer(viewer) && assignedUserId !== viewer.id) {
    throw authorization.forbidden("Você não pode transferir esta conversa.");
  }
  const data = {};
  if (categoryId !== undefined) data.categoryId = categoryId || null;
  if (assignedUserId !== undefined) data.assignedUserId = assignedUserId || null;
  if (priority !== undefined) data.priority = priority;
  const sectorChanged = categoryId !== undefined
    && categorySectorId(currentSnapshot.category) !== categorySectorId(targetCategory);
  if (sectorChanged && assignedUserId === undefined) data.assignedUserId = null;
  if (status) {
    data.status = status;
    data.finalizedAt = status === "FINALIZADO" ? new Date() : null;
  }
  if (assignedUserId && !status && !currentSnapshot.assignedUserId && currentSnapshot.status !== "FINALIZADO") {
    data.status = "NOVO";
  }
  try {
    const result = await prisma.$transaction(async (transaction) => {
      // Troca de responsável é condicionada ao responsável lido acima: se
      // outro atendente assumiu no meio tempo, a atualização não acontece
      // (dois "assumir" simultâneos nunca deixam a conversa com o errado).
      const updated = await transaction.conversation.update({
        where: data.assignedUserId !== undefined ? { id, assignedUserId: currentSnapshot.assignedUserId } : { id }, data,
        include: { contact: true, category: { include: { parent: true } }, assignedUser: { select: { id: true, name: true, email: true } } },
      });
      const activities = [];
      if (categoryId !== undefined && currentSnapshot.categoryId !== updated.categoryId
        && (sectorChanged || currentSnapshot.assignedUserId !== viewer.id)) {
        activities.push(activityRecord(id, viewer.id, "CATEGORY_CHANGED", {
          from: currentSnapshot.category ? categoryLabelForHistory(currentSnapshot.category) : "Sem categoria",
          to: updated.category ? categoryLabelForHistory(updated.category) : "Sem categoria",
          fromCategoryId: currentSnapshot.categoryId, toCategoryId: updated.categoryId,
          sectorChanged, historyLimited: limitHistory === true,
          ...(reason ? { reason } : {}),
        }));
      }
      // Auditoria da transferência entre pessoas: quem transferiu, de quem,
      // para quem, setores de origem/destino, se o histórico foi
      // compartilhado, motivo e resumo de handoff. `historyShared` só é
      // gravado quando a escolha foi feita (ausente = regra anterior).
      let transferDetails = null;
      if (currentSnapshot.assignedUserId !== updated.assignedUserId) {
        const action = !updated.assignedUserId ? "ASSIGNEE_REMOVED"
          : !currentSnapshot.assignedUserId && updated.assignedUserId === viewer.id ? "CONVERSATION_CLAIMED"
            : "CONVERSATION_TRANSFERRED";
        const details = {
          from: currentSnapshot.assignedUser?.name || "Sem responsável",
          to: updated.assignedUser?.name || "Sem responsável",
          fromUserId: currentSnapshot.assignedUserId, toUserId: updated.assignedUserId,
        };
        if (action === "CONVERSATION_TRANSFERRED") {
          transferDetails = {
            transferredByUserId: viewer.id,
            fromCategoryId: currentSnapshot.categoryId, toCategoryId: updated.categoryId,
            fromCategory: currentSnapshot.category ? categoryLabelForHistory(currentSnapshot.category) : "Sem categoria",
            toCategory: updated.category ? categoryLabelForHistory(updated.category) : "Sem categoria",
            ...(typeof shareHistory === "boolean" ? { historyShared: shareHistory } : {}),
            ...(reason ? { reason } : {}),
            ...(summary ? { handoffSummary: summary } : {}),
          };
          Object.assign(details, transferDetails);
        } else if (reason) {
          details.reason = reason;
        }
        activities.push(activityRecord(id, viewer.id, action, details));
      }
      if (status && currentSnapshot.status !== updated.status) {
        activities.push(activityRecord(id, viewer.id, "STATUS_CHANGED", { from: currentSnapshot.status, to: updated.status }));
      }
      if (priority !== undefined && currentSnapshot.priority !== updated.priority) {
        activities.push(activityRecord(id, viewer.id, "PRIORITY_CHANGED", { from: currentSnapshot.priority, to: updated.priority }));
      }
      if (activities.length) await transaction.conversationActivity.createMany({ data: activities });
      const contact = contactAuditSnapshot(updated);
      const audits = [];
      if (currentSnapshot.categoryId !== updated.categoryId) {
        const from = currentSnapshot.category ? categoryLabelForHistory(currentSnapshot.category) : "Sem categoria";
        const to = updated.category ? categoryLabelForHistory(updated.category) : "Sem categoria";
        audits.push({
          action: "CONVERSATION_CATEGORY_CHANGED",
          summary: `Alterou a categoria da conversa de ${contactDisplayName(updated.contact)}: ${from} → ${to}`,
          details: {
            ...contact, from, to, fromCategoryId: currentSnapshot.categoryId,
            toCategoryId: updated.categoryId, historyLimited: limitHistory === true,
          },
        });
      }
      if (currentSnapshot.assignedUserId !== updated.assignedUserId) {
        const from = currentSnapshot.assignedUser?.name || "Sem responsável";
        const to = updated.assignedUser?.name || "Sem responsável";
        audits.push({
          action: "CONVERSATION_ASSIGNEE_CHANGED",
          summary: `Alterou o responsável da conversa de ${contactDisplayName(updated.contact)}: ${from} → ${to}`,
          details: {
            ...contact, from, to, fromUserId: currentSnapshot.assignedUserId, toUserId: updated.assignedUserId,
            ...(transferDetails || {}),
          },
        });
      }
      if (currentSnapshot.status !== updated.status) {
        audits.push({
          action: "CONVERSATION_STATUS_CHANGED",
          summary: `Alterou o status da conversa de ${contactDisplayName(updated.contact)}: ${currentSnapshot.status} → ${updated.status}`,
          details: { ...contact, from: currentSnapshot.status, to: updated.status },
        });
      }
      if (priority !== undefined && currentSnapshot.priority !== updated.priority) {
        audits.push({
          action: "CONVERSATION_PRIORITY_CHANGED",
          summary: `Alterou a prioridade da conversa de ${contactDisplayName(updated.contact)}: ${currentSnapshot.priority} → ${updated.priority}`,
          details: { ...contact, from: currentSnapshot.priority, to: updated.priority },
        });
      }
      for (const entry of audits) {
        await audit.recordAudit({
          actor: viewer,
          entityType: "CONVERSATION",
          entityId: id,
          ...entry,
        }, transaction);
      }
           return updated;
  });





    return result;
  } catch (error) {
    if (error.code === "P2025" && data.assignedUserId !== undefined) {
      throw Object.assign(new Error("O responsável desta conversa acabou de mudar. Atualize e tente novamente."), { statusCode: 409 });
    }
    if (error.code === "P2025") throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
    throw error;
  }
}

async function setConversationPinned(id, { pinned }, viewer) {
  await authorization.assertCanViewConversation(viewer, id);
  if (typeof pinned !== "boolean") {
    throw Object.assign(new Error("Informe se a conversa deve ser fixada."), { statusCode: 400 });
  }
  const [conversation, currentPin] = await Promise.all([
    prisma.conversation.findUnique({ where: { id }, include: { contact: true } }),
    prisma.conversationPin.findUnique({
      where: { userId_conversationId: { userId: viewer.id, conversationId: id } },
      select: { createdAt: true },
    }),
  ]);
  if (!conversation) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
  if (Boolean(currentPin) === pinned) return { conversationId: id, pinned };
  await prisma.$transaction(async (transaction) => {
    if (pinned) {
      await transaction.conversationPin.create({ data: { userId: viewer.id, conversationId: id } });
    } else {
      await transaction.conversationPin.delete({
        where: { userId_conversationId: { userId: viewer.id, conversationId: id } },
      });
    }
    await audit.recordAudit({
      actor: viewer,
      action: pinned ? "CONVERSATION_PINNED" : "CONVERSATION_UNPINNED",
      entityType: "CONVERSATION",
      entityId: id,
      summary: `${pinned ? "Fixou" : "Desafixou"} a conversa de ${contactDisplayName(conversation.contact)}`,
      details: contactAuditSnapshot(conversation),
    }, transaction);
  });
  return { conversationId: id, pinned };
}

async function markAsRead(id, { channel, viewer } = {}) {
  const [latestUnread, latestIncoming] = await Promise.all([
    prisma.message.findFirst({
      where: {
        conversationId: id,
        direction: "RECEBIDA",
        status: { not: "LIDA" },
        externalId: { not: null },
      },
      orderBy: { occurredAt: "desc" },
      select: { externalId: true },
    }),
    prisma.message.findFirst({
      where: { conversationId: id, direction: "RECEBIDA", type: { not: "reaction" } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  const now = new Date();
  const viewedAt = latestIncoming?.createdAt > now ? latestIncoming.createdAt : now;

  let readReceiptSent = false;

  if (
    latestUnread?.externalId &&
    typeof channel?.markAsRead === "function"
  ) {
    try {
      await channel.markAsRead(latestUnread.externalId);
      readReceiptSent = true;
    } catch (error) {
      console.error(
        "Não foi possível confirmar a leitura na Meta:",
        {
          conversationId: id,
          message: error.message,
        }
      );
    }
  }

  // A leitura no painel é válida mesmo quando a Meta recusa o recibo
  // (por exemplo, para uma mensagem antiga). Isso também impede novas
  // tentativas a cada atualização da conversa aberta.
  await prisma.message.updateMany({
    where: {
      conversationId: id,
      direction: "RECEBIDA",
      status: { not: "LIDA" },
    },
    data: {
      status: "LIDA",
    },
  });

  try {
    if (authorization.isMaster(viewer)) {
      await prisma.conversationMasterRead.upsert({
        where: {
          userId_conversationId: {
            userId: viewer.id,
            conversationId: id,
          },
        },
        update: {
          readAt: viewedAt,
        },
        create: {
          userId: viewer.id,
          conversationId: id,
          readAt: viewedAt,
        },
      });

      const conversation = await prisma.conversation.findUnique({
        where: {
          id,
        },
      });

      if (!conversation) {
        throw Object.assign(
          new Error("Conversa não encontrada."),
          {
            statusCode: 404,
          }
        );
      }

      return {
        ...conversation,
        unreadCount: 0,
        readReceiptSent,
      };
    }

    const conversation = await prisma.conversation.update({
      where: {
        id,
      },
      data: {
        unreadCount: 0,
      },
    });

    return {
      ...conversation,
      readReceiptSent,
    };
  } catch (error) {
    if (error.code === "P2025") {
      throw Object.assign(
        new Error("Conversa não encontrada."),
        {
          statusCode: 404,
        }
      );
    }

    throw error;
  }
}

async function listCategories(viewer) {
  const publicCategoryScope = {
    masterOnly: false,
    OR: [{ parentId: null }, { parent: { is: { masterOnly: false } } }],
  };
  let where = authorization.isMaster(viewer) ? undefined : publicCategoryScope;
  let selectableIds = null;
  if (!authorization.isMaster(viewer)) {
    const categoryIds = await authorization.allowedCategoryIds(viewer);
    selectableIds = new Set(categoryIds);
    where = { AND: [publicCategoryScope, { OR: [
      { id: { in: categoryIds } },
      { children: { some: { id: { in: categoryIds }, masterOnly: false } } },
    ] }] };
  }
  const [categories, preferences] = await Promise.all([prisma.category.findMany({
    where,
    include: { parent: { select: { id: true, name: true, code: true, active: true } } },
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
  }), prisma.user.findUnique({
    where: { id: viewer.id },
    select: { hideUncategorized: true, hiddenCategories: { select: { categoryId: true } } },
  })]);
  const hiddenIds = new Set(preferences?.hiddenCategories.map(({ categoryId }) => categoryId) || []);
  return categories.map((category) => ({
    ...category, selectable: selectableIds ? selectableIds.has(category.id) : true, hidden: hiddenIds.has(category.id),
  }));
}

async function listTransferCategories(conversationId, viewer) {
  const scope = await authorization.conversationScope(viewer);
  const conversation = await prisma.conversation.findFirst({
    where: { AND: [{ id: conversationId }, scope] },
    select: { id: true, channelAccountId: true },
  });
  if (!conversation) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });

  const publicCategoryScope = {
    masterOnly: false,
    OR: [{ parentId: null }, { parent: { is: { masterOnly: false } } }],
  };
  const categories = await prisma.category.findMany({
    where: authorization.isMaster(viewer)
      ? { active: true }
      : { AND: [{ active: true }, publicCategoryScope] },
    include: { parent: { select: { id: true, name: true, code: true, active: true } } },
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
  });
  if (!conversation.channelAccountId) return categories.map((category) => ({ ...category, selectable: true }));

  const account = await prisma.channelAccount.findUnique({
    where: { id: conversation.channelAccountId },
    select: { config: true },
  });
  const allowedIds = Array.isArray(account?.config?.allowedCategoryIds)
    ? account.config.allowedCategoryIds.filter(Boolean)
    : [];
  if (!allowedIds.length) return categories.map((category) => ({ ...category, selectable: true }));

  const allowed = new Set(allowedIds);
  const groupingParents = new Set(categories
    .filter((category) => allowed.has(category.id) || allowed.has(category.parentId))
    .map((category) => category.parentId)
    .filter(Boolean));
  return categories
    .filter((category) => allowed.has(category.id) || allowed.has(category.parentId) || groupingParents.has(category.id))
    .map((category) => ({ ...category, selectable: allowed.has(category.id) || allowed.has(category.parentId) }));
}

async function getCategoryVisibility(viewer) {
  const preferences = await prisma.user.findUnique({
    where: { id: viewer.id },
    select: { hideUncategorized: true, hiddenCategories: { select: { categoryId: true } } },
  });
  return { hideUncategorized: Boolean(preferences?.hideUncategorized), hiddenCategoryIds: preferences?.hiddenCategories.map(({ categoryId }) => categoryId) || [] };
}

async function setCategoryVisibility({ categoryId, hidden }, viewer) {
  if (typeof hidden !== "boolean") throw Object.assign(new Error("Informe se a categoria deve ficar oculta."), { statusCode: 400 });
  if (categoryId === null || categoryId === "UNCATEGORIZED") {
    if (!authorization.isMaster(viewer) && !viewer.canViewUncategorized) throw authorization.forbidden("Você não possui acesso a Sem categoria.");
    await prisma.user.update({ where: { id: viewer.id }, data: { hideUncategorized: hidden } });
    return getCategoryVisibility(viewer);
  }
  const visibleCategories = await listCategories(viewer);
  const target = visibleCategories.find(({ id }) => id === categoryId);
  if (!target) throw Object.assign(new Error("Categoria não encontrada."), { statusCode: 404 });
  if (hidden) {
    const cascadeIds = target.parentId
      ? [categoryId]
      : [categoryId, ...visibleCategories.filter((category) => category.parentId === categoryId).map(({ id }) => id)];
    await prisma.$transaction(cascadeIds.map((id) => prisma.userHiddenCategory.upsert({
      where: { userId_categoryId: { userId: viewer.id, categoryId: id } }, update: {}, create: { userId: viewer.id, categoryId: id },
    })));
  } else {
    await prisma.userHiddenCategory.deleteMany({ where: { userId: viewer.id, categoryId } });
  }
  return getCategoryVisibility(viewer);
}

async function createCategory(data, viewer) {
  if (data.masterOnly === true && !authorization.isMaster(viewer)) {
    throw authorization.forbidden("Somente uma conta Master pode restringir categorias.");
  }
  authorization.assertCanManageCategories(viewer);
  const name = validateCategoryName(data.name);
  const color = validateCategoryColor(data.color) || "#6b7280";
  const parentId = data.parentId || null;
  if (parentId) {
    const parent = await prisma.category.findFirst({ where: {
      id: parentId, active: true, parentId: null,
      ...(authorization.isMaster(viewer) ? {} : { masterOnly: false }),
    } });
    if (!parent) throw Object.assign(new Error("A categoria principal não existe, está inativa ou já é uma subcategoria."), { statusCode: 400 });
  }
  const baseCode = categoryCode(name);
  const order = await prisma.category.aggregate({ _max: { displayOrder: true } });
  for (let suffix = 1; suffix <= 100; suffix += 1) {
    const code = suffix === 1 ? baseCode : `${baseCode}_${suffix}`;
    try {
      return await prisma.$transaction(async (transaction) => {
        const category = await transaction.category.create({
          data: { code, name, color, parentId, masterOnly: Boolean(data.masterOnly), displayOrder: (order._max.displayOrder || 0) + 10 },
        });
        await audit.recordAudit({
          actor: viewer,
          action: "CATEGORY_CREATED",
          entityType: "CATEGORY",
          entityId: category.id,
          summary: `Criou a categoria ${category.name}`,
          details: { category },
        }, transaction);
        return category;
      });
    } catch (error) {
      if (error.code !== "P2002") throw error;
    }
  }
  throw Object.assign(new Error("Não foi possível gerar um código único para a categoria."), { statusCode: 409 });
}

async function updateCategory(id, data, viewer) {
  authorization.assertCanManageCategories(viewer);
  const existing = await prisma.category.findUnique({ where: { id }, include: { parent: { select: { masterOnly: true } } } });
  if (!existing) throw Object.assign(new Error("Categoria não encontrada."), { statusCode: 404 });
  if ((existing.masterOnly || existing.parent?.masterOnly || data.masterOnly !== undefined) && !authorization.isMaster(viewer)) {
    throw authorization.forbidden("Somente uma conta Master pode alterar categorias restritas.");
  }
  const allowed = {};
  if (data.name !== undefined) allowed.name = validateCategoryName(data.name);
  if (data.color !== undefined) allowed.color = validateCategoryColor(data.color);
  if (typeof data.active === "boolean") allowed.active = data.active;
  if (typeof data.masterOnly === "boolean") allowed.masterOnly = data.masterOnly;
  if (Number.isInteger(data.displayOrder)) allowed.displayOrder = data.displayOrder;
  if (data.parentId !== undefined) {
    const parentId = data.parentId || null;
    if (parentId === id) throw Object.assign(new Error("Uma categoria não pode ser sua própria categoria principal."), { statusCode: 400 });
    if (parentId) {
      const [parent, children] = await Promise.all([
        prisma.category.findFirst({ where: {
          id: parentId, active: true, parentId: null,
          ...(authorization.isMaster(viewer) ? {} : { masterOnly: false }),
        } }),
        prisma.category.count({ where: { parentId: id } }),
      ]);
      if (!parent) throw Object.assign(new Error("A categoria principal não existe, está inativa ou já é uma subcategoria."), { statusCode: 400 });
      if (children) throw Object.assign(new Error("Remova ou mova as subcategorias antes de transformar esta categoria em subcategoria."), { statusCode: 400 });
    }
    allowed.parentId = parentId;
  }
  try {
    return await prisma.$transaction(async (transaction) => {
      const category = await transaction.category.update({ where: { id }, data: allowed });
      if (allowed.masterOnly === true) {
        await transaction.botTriageOption.updateMany({
          where: { category: { is: { OR: [{ id }, { parentId: id }] } } }, data: { enabled: false },
        });
      }
      await audit.recordAudit({
        actor: viewer,
        action: "CATEGORY_UPDATED",
        entityType: "CATEGORY",
        entityId: category.id,
        summary: `Alterou a categoria ${category.name}`,
        details: { before: existing, after: category },
      }, transaction);
      return category;
    });
  } catch (error) {
    if (error.code === "P2025") throw Object.assign(new Error("Categoria não encontrada."), { statusCode: 404 });
    throw error;
  }
}

async function updateContactCustomName(contactId, customName, viewer) {
  await authorization.assertCanAccessContact(viewer, contactId);

  const value = String(customName || "").trim();

  if (value.length > 120) {
    throw Object.assign(
      new Error("O nome personalizado deve ter no máximo 120 caracteres."),
      { statusCode: 400 }
    );
  }

  const contact = await prisma.contact.update({
    where: { id: contactId },
    data: {
      customName: value || null,
    },
  });

  return contact;
}

async function listUsers(viewer) {
  const where = authorization.isMaster(viewer) || viewer.canViewTeamActivity || viewer.canTransferConversations
    ? { active: true } : { id: viewer.id, active: true };
  return prisma.user.findMany({
    where,
    select: { id: true, name: true, email: true, role: true },
    orderBy: { name: "asc" },
  });
}

module.exports = {
  addContactNote, assertCanViewMessage, conversationPriorities, conversationStatuses, createCategory, deleteContactNote, deleteConversation,
  getConversation, getConversationSummary, getUserAlerts, listCategories, listTransferCategories,
  resolveHistoryStart,
  listConversations, listUsers, markAsRead, recordConversationActivity, setContactNotePinned, setConversationPinned, setEmailSpamStatus,
  getCategoryVisibility, setCategoryVisibility, updateCategory, updateContactCustomName, updateConversation,
};
