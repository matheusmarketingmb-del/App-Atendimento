const paging=require('./inbox-pagination');
const {emailMailboxes}=require('./email-mailbox-query');
const prisma = require("../database/prisma");
const periods = require("./assignment-period-service");
const authorization = require("./authorization-service");
const whatsappInbox = require("./whatsapp-inbox-service");
const companyService = require("./company-service");
const { removeImage } = require("./media-storage-service");
const audit = require("./audit-service");
const internalChat = require("./internal-chat-service");
const { getConversationSettings } = require("./conversation-settings-service");
const privateSegments = require("./private-segment-service");
const { masterUnreadCounts: countMasterUnread } = require("./master-unread-service");

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
  const remaining = require('./service-hours-sla').slaMinutesRemaining(conversation,settings,now);
  return remaining===null?null:remaining<0?-Math.max(1,Math.ceil(-remaining)):Math.ceil(remaining);
}

async function searchConversations(value, viewer, { company } = {}) {
  const term = String(value || "").trim().slice(0, 120);
  if (term.length < 2) return [];
  // Busca (Ctrl+K) limitada ao workspace ativo.
  const scope = { AND: [await authorization.conversationScope(viewer), { companyId: await companyService.resolveWorkspace(viewer, company) }] };
  const accountScope = await whatsappInbox.messageAccountScope(viewer);
  const contactMatch = { OR: ["customName", "name", "email", "phone"].map((field) => ({ [field]: { contains: term, mode: "insensitive" } })) };
  const messageMatch = { AND: [await privateSegments.readableWhereFor(viewer), accountScope, { type: { not: "reaction" }, text: { contains: term, mode: "insensitive" } }] };
  const results = [];
  let cursor;
  while (results.length < 20) {
    const rows = await prisma.conversation.findMany({
      where: { AND: [scope, {archivedAt:null}, whatsappInbox.canonicalScope, { OR: [{ contact: { is: contactMatch } }, { messages: { some: messageMatch } }] }] },
      select: { id: true, categoryId: true, assignedUserId: true, channel: true, contact: { select: { customName: true, name: true, email: true, phone: true } } },
      orderBy: [{ lastMessageAt: "desc" }, { id: "asc" }], take: 50,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    for (const conversation of rows) {
      const visibility = await readVisibility(conversation, viewer);
      const message = await prisma.message.findFirst({
        where: { AND: [messageMatch, { conversationId: conversation.id }, periods.windowsWhere(visibility.windows, "occurredAt") || {}] },
        select: { id: true, text: true, occurredAt: true }, orderBy: { occurredAt: "desc" },
      });
      const contactHit = Object.values(conversation.contact).some((text) => String(text || "").toLocaleLowerCase("pt-BR").includes(term.toLocaleLowerCase("pt-BR")));
      if (!message && !contactHit) continue;
      const text = message?.text || "";
      const matchAt = text.toLocaleLowerCase("pt-BR").indexOf(term.toLocaleLowerCase("pt-BR"));
      const start = Math.max(0, matchAt - 45);
      results.push({
        id: conversation.id, name: contactDisplayName(conversation.contact), phone: conversation.contact.phone,
        channel: conversation.channel, messageId: message?.id || null,
        excerpt: text ? `${start ? "…" : ""}${text.slice(start, start + 180)}${text.length > start + 180 ? "…" : ""}` : "",
      });
      if (results.length === 20) break;
    }
    if (rows.length < 50) break;
    cursor = rows[rows.length - 1].id;
  }
  return results;
}

function contactDisplayName(contact) {
  return contact?.customName || contact?.name || contact?.email || contact?.phone || "Contato";
}

// Empresa e conta de origem — identificação visual (badge/borda/composer).
// Só campos públicos: nunca config/segredos da ChannelAccount.
const COMPANY_SELECT = Object.freeze({ id: true, name: true, slug: true, displayName: true, primaryColor: true });
const CHANNEL_ACCOUNT_SELECT = Object.freeze({ id: true, name: true, channel: true, config: true });

function channelAccountSummary(account) {
  if (!account) return null;
  const config = account.config && typeof account.config === "object" ? account.config : {};
  const displayNumber = config.displayNumber || config.displayPhoneNumber || (config.legacyEnv ? process.env.WHATSAPP_DISPLAY_NUMBER || null : null);
  return { id: account.id, name: account.name, channel: account.channel, displayNumber: displayNumber || null };
}

// Atendente fixo na lista: só id/nome (badge discreto "★ Carlos").
const PREFERRED_ASSIGNEE_SELECT = Object.freeze({ id: true, name: true });

async function listConversations({
  search, category, status, assignedUser, activeOnly, priority, slaBreached, unassigned, channel, company, preferredAssignee, limit, cursor, mailbox, excludeMarketplaces, respectHidden, selectedId, archived,
}, viewer) {
  if(archived!==undefined&&!['true','false'].includes(archived))throw Object.assign(new Error('Filtro de arquivo inválido.'),{statusCode:400});
  const where = {archivedAt:archived==='true'?{not:null}:null};

  // Workspace (área de trabalho): a lista é sempre de UMA empresa — a pedida
  // (validada; sem acesso = 403) ou o workspace salvo do usuário. Nunca
  // mistura empresas. O escopo de segurança (conversationScope) continua
  // sendo aplicado abaixo — este filtro só restringe, nunca amplia.
  where.companyId = await companyService.resolveWorkspace(viewer, company);

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
    const sla=require('./service-hours-sla'),at=new Date();
    const context=(await sla.loadSlaCalendars(prisma,at,[where.companyId])).get(where.companyId);
    const settings=await getConversationSettings(prisma,where.companyId);
    where.AND = [...(where.AND || []), { channel: { not: "EMAIL" } },sla.slaOverdueWhere(settings,context)];
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

  const contactFilters = [];
  if (search) {
    contactFilters.push({
      OR: [
        { customName: { contains: search, mode: "insensitive" } },
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { phone: { contains: search } },
      ],
    });
  }

  // Atendente fixo: "ANY" (com), "NONE" (sem), "ME" (meus clientes fixos)
  // ou um userId. Consultar o de outra pessoa é só Master/Supervisor.
  if (preferredAssignee) {
    const value = String(preferredAssignee);
    if (value === "ANY") contactFilters.push({ preferredAssigneeEnabled: true, preferredAssigneeId: { not: null } });
    else if (value === "NONE") contactFilters.push({ OR: [{ preferredAssigneeEnabled: false }, { preferredAssigneeId: null }] });
    else {
      const userId = value === "ME" ? viewer.id : value;
      if (userId !== viewer.id && !authorization.isMaster(viewer)
        && !(await companyService.companyAccess(viewer)).some(({ role }) => role === "SUPERVISOR")) {
        throw authorization.forbidden("Você não pode consultar os clientes fixos de outro usuário.");
      }
      contactFilters.push({ preferredAssigneeEnabled: true, preferredAssigneeId: userId });
    }
  }
  if (contactFilters.length) where.contact = contactFilters.length === 1 ? contactFilters[0] : { AND: contactFilters };

  if (assignedUser) {
    if (
      !authorization.isMaster(viewer) &&
      assignedUser !== viewer.id &&
      !(await authorization.supervisedUserIds(viewer)).includes(assignedUser)
    ) {
      throw authorization.forbidden(
        "Você não pode consultar os atendimentos de outro usuário."
      );
    }

    where.assignedUserId = assignedUser;
  }

  const scope = await authorization.conversationScope(viewer);
  const master = authorization.isMaster(viewer);
  // Setor privado: prévia da última mensagem e nota mais recente nunca vêm
  // de um segmento que o usuário não pode ler.
  const readable = await privateSegments.readableWhereFor(viewer);

  let page=null;
  if(limit!==undefined){
    const size=Number(limit);if(!Number.isInteger(size)||size<1||size>5000)throw Object.assign(new Error('Tamanho de página inválido.'),{statusCode:400});
    let rows=await prisma.conversation.findMany({where:{AND:[where,scope,whatsappInbox.canonicalScope]},select:{id:true,channel:true,categoryId:true,assignedUserId:true,unreadCount:true,...(master?{masterReads:{where:{userId:viewer.id},select:{readAt:true},take:1}}:{}),emailMailboxOverride:true,lastMessageAt:true,createdAt:true,pins:{where:{userId:viewer.id},select:{userId:true}}}});
    if(!master&&rows.length){
      const operational=new Set((await prisma.conversation.findMany({where:{AND:[{id:{in:rows.map(row=>row.id)}},await authorization.operationalScope(viewer)]},select:{id:true}})).map(row=>row.id));
      const supervised=rows.filter(row=>!operational.has(row.id));
      const windows=await require('./supervision-window-batch-service').supervisionWindowsMany(supervised,await authorization.supervisedUserIds(viewer),prisma);
      const accountScope=await whatsappInbox.messageAccountScope(viewer);
      for(const row of supervised){row.unreadCount=0;const visible=windows.get(row.id);if(visible){const latest=await prisma.message.findFirst({where:{AND:[{conversationId:row.id,type:{not:'reaction'}},periods.windowsWhere(visible,'occurredAt')||{},accountScope,readable]},orderBy:[{occurredAt:'desc'},{id:'desc'}],select:{occurredAt:true}});row.lastMessageAt=latest?.occurredAt||null;}}
    }
    if(excludeMarketplaces==='true')rows=rows.filter(row=>!['MERCADO_LIVRE','TIKTOK_SHOP','AMAZON_MARKETPLACE','SHOPEE','SHEIN_MARKETPLACE'].includes(row.channel));
    const mailboxes=await emailMailboxes(prisma,rows.filter(row=>row.channel==='EMAIL').map(row=>row.id));
    rows=rows.filter(row=>row.channel==='EMAIL'?(mailbox?((row.emailMailboxOverride||mailboxes.get(row.id)||'GENERAL')===mailbox):((row.emailMailboxOverride||mailboxes.get(row.id)||'GENERAL')!=='SPAM')):true);
    if(respectHidden==='true'){const preference=await getCategoryVisibility(viewer);if(preference.hideUncategorized||preference.hiddenCategoryIds.length){const unread=master?await countMasterUnread(rows,prisma):new Map(rows.map(row=>[row.id,row.unreadCount]));rows=rows.filter(row=>row.id===selectedId||unread.get(row.id)>0||(row.categoryId?!preference.hiddenCategoryIds.includes(row.categoryId):!preference.hideUncategorized));}}
    page=paging.listPage(rows,size,paging.decodeCursor(cursor));
  }
  const conversations = await prisma.conversation.findMany({
    where: { AND: [where, scope, whatsappInbox.canonicalScope, ...(page?[{id:{in:page.items.map(row=>row.id)}}]:[])] },

    include: {
      contact: {
        include: {
          preferredAssignee: { select: PREFERRED_ASSIGNEE_SELECT },
          notes: {
            where: readable,
            orderBy: [
              { pinned: "desc" },
              { createdAt: "desc" },
            ],
            take: 1,
          },

          _count: {
            select: {
              notes: { where: readable },
            },
          },
        },
      },

      category: {
        include: {
          parent: true,
        },
      },

      company: { select: COMPANY_SELECT },
      channelAccount: { select: { ...CHANNEL_ACCOUNT_SELECT, externalAccountId: true, providerMetadata: true } },

      assignedUser: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },

      messages: {
        where: {
          AND: [await whatsappInbox.messageAccountScope(viewer), readable],
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
  const emailMailboxByConversation = await emailMailboxes(prisma,emailConversationIds);

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

  // Supervisor: conversas que ele só enxerga por supervisão (a equipe já
  // passou por elas, mas ele não pode agir) mostram apenas o trecho da
  // equipe — a prévia/horário nunca revelam mensagens de fora desse trecho
  // e o contador de não lidas do atendente não é exposto.
  const supervisionOnly = new Map();
  if (["SUPERVISOR", "ATENDENTE"].includes(viewer.role) && conversations.length) {
    const ids = conversations.map(({ id }) => id);
    const operational = new Set((await prisma.conversation.findMany({
      where: { AND: [{ id: { in: ids } }, await authorization.operationalScope(viewer)] }, select: { id: true },
    })).map(({ id }) => id));
    const team = await authorization.supervisedUserIds(viewer);
    const onlySupervised = conversations.filter(({ id }) => !operational.has(id));
    const supervisionWindowsByConversation = await require('./supervision-window-batch-service').supervisionWindowsMany(onlySupervised, team, prisma);
    for (const conversation of onlySupervised) {
      const windows = supervisionWindowsByConversation.get(conversation.id);
      let preview = conversation.messages?.[0] || null;
      if (windows && preview && !periods.withinWindows(preview.occurredAt, windows)) {
        preview = await prisma.message.findFirst({
          where: { conversationId: conversation.id, type: { not: "reaction" }, ...periods.windowsWhere(windows, "occurredAt"), AND: [await whatsappInbox.messageAccountScope(viewer)] },
          orderBy: { occurredAt: "desc" },
        });
      }
      supervisionOnly.set(conversation.id, { preview, lastMessageAt: windows ? preview?.occurredAt || null : conversation.lastMessageAt });
    }
  }

  let masterUnreadCounts = new Map();

  if (master && conversations.length) {
    masterUnreadCounts = await countMasterUnread(conversations, prisma);
  }

  const now = new Date();
  // SLA da empresa de cada conversa (configuração própria ou a global).
  const slaSettingsByCompany = new Map();
  for (const companyId of new Set(conversations.map((conversation) => conversation.companyId))) {
    slaSettingsByCompany.set(companyId, await getConversationSettings(prisma, companyId));
  }
  await require('./service-hours-sla').attachSlaCalendars(slaSettingsByCompany,prisma,now);

  const items=conversations
    .map((conversation) => {
      const {
        pins,
        masterReads,
        ...rest
      } = conversation;

      const supervised = supervisionOnly.get(conversation.id);
      const remaining=computeSlaMinutesRemaining(conversation,slaSettingsByCompany.get(conversation.companyId),now);
      return {
        ...rest,
        firstResponseSlaBreached:remaining!==null&&remaining<0&&conversation.status==='NOVO',
        responseSlaBreached:remaining!==null&&remaining<0&&['AGUARDANDO_EQUIPE','HANDOFF_BOT'].includes(conversation.status),
        channelAccount: channelAccountSummary(rest.channelAccount),
        ...(hiddenPreviewIds.has(conversation.id) ? { messages: [] } : {}),
        ...(supervised ? {
          accessMode: "SUPERVISION", messages: supervised.preview ? [supervised.preview] : [],
          lastMessageAt: supervised.lastMessageAt, unreadCount: 0,
        } : {}),

        unreadCount: master
          ? masterUnreadCounts.get(conversation.id) || 0
          : supervised ? 0 : conversation.unreadCount,

        isPinned: pins.length > 0,
        ...(conversation.channel === "EMAIL" ? { emailMailbox: conversation.emailMailboxOverride || emailMailboxByConversation.get(conversation.id) || "GENERAL" } : {}),
        slaMinutesRemaining: remaining,
      };
    })
    // Fixadas manualmente continuam no topo por escolha explicita do usuario;
    // todas as demais seguem a ultima atividade, da mais nova para a mais antiga.
    .sort((left, right) => {
      const pinDiff = Number(right.isPinned) - Number(left.isPinned);
      if (pinDiff !== 0) return pinDiff;
      return compareByLatestMessage(left, right);
    });
  const byId=new Map(items.map(row=>[row.id,row]));
  return page?{items:page.items.map(row=>byId.get(row.id)).filter(Boolean),total:page.total,nextCursor:page.nextCursor}:items;
}

function alertSince(value) {
  const parsed = value ? new Date(value) : new Date();
  const minimum = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (Number.isNaN(parsed.getTime())) throw Object.assign(new Error("Data inicial inválida."), { statusCode: 400 });
  return parsed < minimum ? minimum : parsed;
}

async function getUserAlerts({ since, company, allCompanies }, viewer) {
  const checkedAt = new Date();
  const occurredAfter = alertSince(since);
  const acrossWorkspaces = allCompanies === "true";
  const scope = await authorization.operationalScope(viewer);
  const master = authorization.isMaster(viewer);
  const alertScope = { AND: [scope, { archivedAt: null }, notManualSpam,
    ...(acrossWorkspaces ? [] : [{ companyId: await companyService.resolveWorkspace(viewer, company) }])] };
  const readable = await privateSegments.readableWhereFor(viewer);
  const accountScope = await whatsappInbox.messageAccountScope(viewer);
  const companySelect = { select: { id: true, displayName: true, slug: true } };
  const waitingForViewer = {
    AND: [alertScope, { status: acrossWorkspaces ? { in: activeManagedStatuses } : "AGUARDANDO_EQUIPE" }, {
      OR: [{ assignedUserId: null }, { assignedUserId: viewer.id }],
    }],
  };
  const [messages, activities] = await Promise.all([
    prisma.message.findMany({
      where: {
        createdAt: { gt: occurredAfter, lte: checkedAt }, direction: "RECEBIDA", type: { not: "reaction" },
        AND: [readable, accountScope],
        conversation: { is: waitingForViewer },
      },
      include: { conversation: { include: {
        contact: true,
        company: companySelect,
        ...(master ? { masterReads: {
          where: { userId: viewer.id }, select: { readAt: true }, take: 1,
        } } : {}),
      } } },
      orderBy: { createdAt: "asc" }, take: 30,
    }),
    prisma.conversationActivity.findMany({
      where: {
        createdAt: { gt: occurredAfter, lte: checkedAt },
        action: { in: ["CATEGORY_CHANGED", "CONVERSATION_TRANSFERRED", "BOT_FLOW_TRANSFERRED", "BOT_FLOW_HANDOFF",
          "BOT_TRIAGE_COMPLETED", "INBOUND_CATEGORY_ASSIGNED"] },
        AND: [readable],
        conversation: { is: alertScope },
      },
      include: { conversation: { include: { contact: true, company: companySelect, category: { include: { parent: true } } } } },
      orderBy: { createdAt: "asc" }, take: 30,
    }),
  ]);

const companyLabel = (conversation) => (conversation.company?.displayName || conversation.company?.slug || "Central").toLocaleUpperCase("pt-BR");
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
    title: `${contactName || "Cliente"} mandou uma mensagem na ${companyLabel(message.conversation)}`,
    companyId: message.conversation.company?.id,
    company: message.conversation.company?.slug,
    text: "",
    createdAt: message.occurredAt,
  };
});

  const changes = activities.filter((activity) => {
    if (activity.actorUserId === viewer.id || activity.conversation.status === "FINALIZADO") return false;
    if (activity.action === "CONVERSATION_TRANSFERRED") return activity.details?.toUserId === viewer.id;
    const details = activity.details || {};
    if (activity.action === "CATEGORY_CHANGED") {
      return Object.hasOwn(details, "toCategoryId") && details.toCategoryId === activity.conversation.categoryId;
    }
    if (activity.action === "BOT_FLOW_HANDOFF" && !Object.hasOwn(details, "previousCategoryId")) return false;
    if (Object.hasOwn(details, "previousCategoryId") && details.previousCategoryId === details.categoryId) return false;
    return Boolean(details.categoryId && details.categoryId === activity.conversation.categoryId);
  }).map((activity) => ({
    id: `activity:${activity.id}`, conversationId: activity.conversationId,
    title: activity.action === "CONVERSATION_TRANSFERRED"
      ? `Conversa transferida para você na ${companyLabel(activity.conversation)}`
      : `Novo atendimento na sua caixa na ${companyLabel(activity.conversation)}`,
    companyId: activity.conversation.company?.id,
    company: activity.conversation.company?.slug,
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

// Visibilidade de LEITURA: janelas de tempo que o usuário pode ler.
//   - Master: tudo.
//   - Acesso operacional (responsável/fila): regra de histórico do atendente
//     (historyVisibility — "compartilhar histórico?" continua valendo).
//   - Supervisão: SOMENTE os trechos em que alguém da equipe dele (ou ele
//     mesmo) foi responsável — a escolha de compartilhar histórico com o
//     próximo atendente nunca restringe a supervisão desses trechos.
// Retorna { windows: null (completo) | [{from,to}], limited, start, mode }.
async function readVisibility(conversation, viewer) {
  if (authorization.isMaster(viewer)) return { windows: null, limited: false, start: null, mode: "FULL" };
  const windows = [];
  const operational = await authorization.canActOnConversation(viewer, conversation.id);
  if (operational) {
    const { start } = await historyVisibility(conversation, viewer);
    windows.push({ from: start, to: null });
  }
  if (viewer.role === "SUPERVISOR" || (!operational && viewer.role === "ATENDENTE")) {
    const team = await authorization.supervisedUserIds(viewer);
    windows.push(...await periods.supervisionWindows(conversation, team));
  }
  const merged = periods.mergeWindows(windows);
  if (periods.isFullWindow(merged)) return { windows: null, limited: false, start: null, mode: operational ? "OPERATIONAL" : "SUPERVISION" };
  return {
    windows: merged, limited: true,
    start: merged.length === 1 && merged[0].to === null ? merged[0].from : null,
    mode: operational ? "OPERATIONAL" : "SUPERVISION",
  };
}

// Transferência mais recente para o responsável atual: mostra ao novo
// atendente de quem veio, se o histórico foi compartilhado, motivo e resumo
// de handoff — inclusive quando o histórico anterior está oculto.
async function currentHandoffFor(conversation, viewer) {
  if (!conversation.assignedUserId || conversation.assignedUserId !== viewer.id) return null;
  const transfer = await prisma.conversationActivity.findFirst({
    where: { conversationId: conversation.id, action: "CONVERSATION_TRANSFERRED" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, details: true, privateCategoryId: true, actorUser: { select: { id: true, name: true } } },
  });
  if (!transfer || transfer.details?.toUserId !== viewer.id) return null;
  // A atribuição e o compartilhamento de histórico não autorizam conteúdo
  // de um segmento privado. Mantém só os metadados estruturais nesse caso.
  const canReadDetails = await privateSegments.canReadRecord(viewer, transfer);
  return {
    at: transfer.createdAt,
    from: transfer.details.from || null,
    transferredBy: transfer.actorUser?.name || null,
    historyShared: typeof transfer.details.historyShared === "boolean" ? transfer.details.historyShared : null,
    reason: canReadDetails ? transfer.details.reason || null : null,
    handoffSummary: canReadDetails ? transfer.details.handoffSummary || null : null,
  };
}

// Anexo/mensagem por ID: além do acesso à conversa, a mensagem precisa estar
// dentro do histórico visível do usuário (evita baixar anexo de etapa oculta
// só por conhecer o ID).
// Setor privado: mensagem/anexo de segmento que o usuário não pode ler é
// 403 mesmo para quem acessa a conversa e conhece o ID (IDOR). Segmento
// privado legível ignora o corte de histórico (Ana/Emily recuperam o
// Financeiro anterior).
async function assertCanViewMessage(viewer, messageId) {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, conversationId: true, channelAccountId: true, occurredAt: true, mediaStorageKey: true, mediaMimeType: true, mediaFileName: true, privateCategoryId: true },
  });
  if (!message) throw Object.assign(new Error("Mídia não encontrada."), { statusCode: 404 });
  const conversation = await authorization.assertCanViewConversation(viewer, message.conversationId);
  if (!(await privateSegments.canReadRecord(viewer, message))) throw authorization.forbidden("Conteúdo restrito ao setor responsável.");
  const visibility = await readVisibility(conversation, viewer);
  const { windows } = visibility;
  const readablePrivateHistory = Boolean(message.privateCategoryId) && visibility.mode !== "SUPERVISION";
  if (!(await authorization.canAccessChannelAccount(viewer, message.channelAccountId))) throw Object.assign(new Error("Mídia não encontrada."), { statusCode: 404 });
  const original = await prisma.conversation.findUnique({ where: { id: message.conversationId }, select: { contactId: true, channel: true } });
  const root = original.channel === "META" ? await whatsappInbox.findInbox(original.contactId) : null;
  if (root && root.id !== message.conversationId) {
    await authorization.assertCanViewConversation(viewer, root.id);
    const currentVisibility = await readVisibility(root, viewer);
    if (!(readablePrivateHistory && currentVisibility.mode !== "SUPERVISION") && !periods.withinWindows(message.occurredAt, currentVisibility.windows)) throw Object.assign(new Error("Mídia não encontrada."), { statusCode: 404 });
  }
  if (!readablePrivateHistory && !periods.withinWindows(message.occurredAt, windows)) throw Object.assign(new Error("Mídia não encontrada."), { statusCode: 404 });
  return message;
}

// Nomes dos setores privados que aparecem nos blocos "🔒 Atendimento X".
async function privateCategoryNames(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const categories = await prisma.category.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(categories.map(({ id, name }) => [id, name]));
}

// Mesmas regras de getConversation, como filtro reutilizável: busca, favoritos,
// fixadas e citações nunca alcançam o que a linha do tempo esconderia.
async function readableMessageScope(id, viewer) {
  const requested = await prisma.conversation.findUnique({ where: { id }, select: { channel: true, contactId: true } });
  const root = requested?.channel === "META" ? await whatsappInbox.findInbox(requested.contactId) : null;
  const rootId = root?.id || id;
  const scope = await authorization.conversationScope(viewer);
  const conversation = await prisma.conversation.findFirst({
    where: { AND: [{ id: rootId }, scope] },
    select: { id: true, companyId: true, categoryId: true, assignedUserId: true, contactId: true, channel: true },
  });
  if (!conversation) throw await authorization.conversationAccessError(viewer, id);
  const visibility = await readVisibility(conversation, viewer);
  const readablePrivateIds = await privateSegments.readablePrivateCategoryIds(viewer);
  const window = periods.windowsWhere(visibility.windows, "occurredAt");
  const rootWindow = window && visibility.mode !== "SUPERVISION" && readablePrivateIds?.length
    ? { OR: [window, { privateCategoryId: { in: readablePrivateIds } }] } : window;
  const branches = [{ AND: [{ conversationId: conversation.id }, rootWindow || {}] }];
  if (root) {
    const siblings = await prisma.conversation.findMany({ where: { AND: [{ contactId: conversation.contactId, channel: "META", id: { not: conversation.id } }, scope] } });
    for (const sibling of siblings) {
      const siblingVisibility = await readVisibility(sibling, viewer);
      branches.push({ AND: [{ conversationId: sibling.id }, window || {}, periods.windowsWhere(siblingVisibility.windows, "occurredAt") || {}] });
    }
  }
  return {
    conversation,
    where: { AND: [{ OR: branches }, await whatsappInbox.messageAccountScope(viewer), privateSegments.readableWhere(readablePrivateIds)] },
  };
}

async function getConversation(id, viewer, history={}) {
  const { adOriginFromMessage } = require("./ad-origin-service");
  const { ASSISTANT_INTAKE_BOTS, visibleAssistantIntake } = require("./assistant-intake");
  const requested = await prisma.conversation.findUnique({ where: { id }, select: { channel: true, contactId: true, unreadCount: true } });
  if (requested?.channel === "META") {
    const root = await whatsappInbox.findInbox(requested.contactId);
    if (root && root.id !== id) return getConversation(root.id, viewer,history);
  }
  const scope = await authorization.conversationScope(viewer);
  const canViewHistory = authorization.isMaster(viewer) || Boolean(viewer.canViewConversationHistory);
  const access = await prisma.conversation.findFirst({
    where: { AND: [{ id }, scope] }, select: { id: true, companyId:true, categoryId: true, assignedUserId: true },
  });
  if (!access) {
    const error = await authorization.conversationAccessError(viewer, id);
    if (error.statusCode === 403) throw error;
    return null;
  }
  const visibility = await readVisibility(access, viewer);
  const slaAt=new Date();
  const slaCompany=access.companyId;
  const slaConfig=new Map([[slaCompany,await getConversationSettings(prisma,slaCompany)]]);
  await require('./service-hours-sla').attachSlaCalendars(slaConfig,prisma,slaAt);
  // Setor privado: segmentos legíveis (Financeiro do membro) entram mesmo
  // antes do corte de histórico; os ilegíveis dentro da janela viram blocos
  // "🔒" abaixo (collapseRestricted) — o conteúdo nunca sai daqui.
  const readablePrivateIds = await privateSegments.readablePrivateCategoryIds(viewer);
  const withinWindow = (field) => {
    const window = periods.windowsWhere(visibility.windows, field);
    if (!window) return undefined;
    if (visibility.mode === "SUPERVISION") return window;
    return readablePrivateIds?.length ? { OR: [window, { privateCategoryId: { in: readablePrivateIds } }] } : window;
  };
  const messageVisibility = {
    where: withinWindow("occurredAt"),
    limited: visibility.limited,
  };
  const accountScope = await whatsappInbox.messageAccountScope(viewer);
  const originScopes = [{ AND: [{ conversationId: id }, messageVisibility.where || {}] }];
  const siblingVisibilityScope = [];
  const currentHandoff = await currentHandoffFor(access, viewer);
  return prisma.conversation.findFirst({
    where: { AND: [{ id }, scope] },
    include: {
      category: { include: { parent: true } },
      company: { select: COMPANY_SELECT },
      channelAccount: { select: { ...CHANNEL_ACCOUNT_SELECT, externalAccountId: true, providerMetadata: true } },
      assignedUser: { select: { id: true, name: true, email: true } },
      messages: {
        where: { AND: [messageVisibility.where || {}, accountScope,paging.historyWhere(history),paging.sharedWhere(history)] },
        include: { sentByUser: { select: { id: true, name: true } } },
        orderBy: history.limit?[{occurredAt:'desc'},{id:'desc'}]:{occurredAt:'asc'},
        ...(history.limit&&!history.from?{take:history.limit+1}:{}),
      },
      contact: {
        include: {
          preferredAssignee: { select: { id: true, name: true, active: true } },
          preferredAssigneeSetBy: { select: { id: true, name: true } },
          notes: {
            where: { AND: [privateSegments.readableWhere(readablePrivateIds), ...(visibility.mode === "SUPERVISION" ? [periods.windowsWhere(visibility.windows, "createdAt") || {}] : [])] },
            include: { author: { select: { id: true, name: true } } },
            orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
          },
        },
      },
      pins: { where: { userId: viewer.id }, select: { createdAt: true }, take: 1 },
      botState: { select: { humanPausedAt: true } },
      botFlowExecutions: requested?.channel === "META" && !history.sharedOnly ? {
        where: { botId: { in: ASSISTANT_INTAKE_BOTS } },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { status: true, context: true, finishedAt: true },
      } : false,
      activities: canViewHistory ? {
        // O histórico de eventos segue o mesmo recorte das mensagens: quem
        // recebeu sem histórico não vê notas/eventos da etapa anterior.
        where: withinWindow("createdAt"),
        include: { actorUser: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
        take: 100,
      } : false,
    },
  }).then(async (conversation) => {
    if (!conversation) return null;
    if (conversation.channel === "META" && conversation.contact.whatsappInboxId === conversation.id) {
      const siblings = await prisma.conversation.findMany({ where: { AND: [{ contactId: conversation.contactId, channel: "META", id: { not: id } }, scope] } });
      for (const sibling of siblings) {
        const siblingVisibility = await readVisibility(sibling, viewer);
        siblingVisibilityScope.push([sibling.id, siblingVisibility]);
        // Both the current transfer restriction and the original conversation's
        // permissions apply. Unification must never reopen hidden history.
        const siblingScope = { AND: [
          { conversationId: sibling.id }, periods.windowsWhere(visibility.windows, "occurredAt") || {},
          periods.windowsWhere(siblingVisibility.windows, "occurredAt") || {},
        ] };
        if (history.adOrigin) originScopes.push(siblingScope);
        const messages = await prisma.message.findMany({ where: { AND: [
          siblingScope, accountScope,paging.historyWhere(history),paging.sharedWhere(history),
        ] }, include: { sentByUser: { select: { id: true, name: true } } },orderBy:[{occurredAt:'desc'},{id:'desc'}],...(history.limit&&!history.from?{take:history.limit+1}:{}) });
        conversation.messages.push(...messages);
      }
      conversation.messages.sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));
    }
    let historyPage;
    if(history.limit){
      conversation.messages.sort((a,b)=>a.occurredAt-b.occurredAt||a.id.localeCompare(b.id));
      const hasMore=history.from?null:conversation.messages.length>history.limit;
      if(!history.from)conversation.messages=conversation.messages.slice(-history.limit);
      historyPage={hasMore,nextCursor:paging.encodeCursor(conversation.messages[0])};
    }
    siblingVisibilityScope.sort(([left], [right]) => left.localeCompare(right));
    const historyScope=require('node:crypto').createHash('sha256').update(JSON.stringify([visibility,readablePrivateIds,accountScope,siblingVisibilityScope])).digest('hex');
    const { pins, botState, botFlowExecutions, ...result } = conversation;
    const latestInboundEmail = conversation.channel === 'EMAIL' ? {rawPayload:{gmailMailbox:(await emailMailboxes(prisma,[conversation.id])).get(conversation.id)}} : null;
    const hiddenIds = result.messages.filter((message) => !privateSegments.canRead(readablePrivateIds, message.privateCategoryId))
      .map(({ privateCategoryId }) => privateCategoryId);
    const messages = hiddenIds.length
      ? privateSegments.collapseRestricted(result.messages, readablePrivateIds, await privateCategoryNames(hiddenIds))
      : result.messages;
    const assistantIntake = await visibleAssistantIntake(botFlowExecutions?.[0], messages, ids => prisma.message.findMany({
      where: { id: { in: ids }, conversationId: id, direction: "RECEBIDA",
        AND: [messageVisibility.where || {}, accountScope, privateSegments.readableWhere(readablePrivateIds)] },
      select: { id: true, direction: true, text: true },
    }));
    let adOrigin = null;
    if (conversation.channel === "META" && !history.sharedOnly) {
      for (let index = messages.length - 1; index >= 0 && !adOrigin; index--) {
        adOrigin = adOriginFromMessage(messages[index]);
      }
      if (history.adOrigin && !adOrigin && (historyPage?.hasMore || history.from || history.before)) {
        const source = await prisma.message.findFirst({
          where: { channel: "META", direction: "RECEBIDA", rawPayload: { path: ["referral", "source_type"], equals: "ad" },
            AND: [{ OR: originScopes }, accountScope, privateSegments.readableWhere(readablePrivateIds)] },
          select: { id: true, occurredAt: true, channel: true, direction: true, rawPayload: true },
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        });
        adOrigin = adOriginFromMessage(source);
      }
    }
    const activities = Array.isArray(result.activities)
      ? privateSegments.sanitizeActivities(result.activities, readablePrivateIds) : result.activities;
    await require("./chat-message-service").attachChatData(messages, viewer, conversation.id);
    const remaining=computeSlaMinutesRemaining(conversation,slaConfig.get(slaCompany),slaAt);
    return {
      ...result, messages, activities, ...(assistantIntake ? { assistantIntake } : {}), ...(historyPage?{messagePage:{...historyPage,scope:historyScope}}:{}),
      ...(adOrigin || history.adOrigin ? { adOrigin } : {}),
      slaMinutesRemaining:remaining,
      firstResponseSlaBreached:conversation.status==='NOVO'&&remaining!==null&&remaining<0,
      responseSlaBreached:['AGUARDANDO_EQUIPE','HANDOFF_BOT'].includes(conversation.status)&&remaining!==null&&remaining<0,
      privateSegmentRestricted: hiddenIds.length > 0,
      channelAccount: channelAccountSummary(result.channelAccount), isPinned: pins.length > 0, canViewHistory, messageHistoryLimited: messageVisibility.limited,
      historyVisibleFrom: visibility.start, currentHandoff,
      // SUPERVISION = somente leitura dos trechos da equipe (visibleWindows).
      accessMode: visibility.mode, visibleWindows: visibility.windows,
      botPausedAt: botState?.humanPausedAt || null,
      ...(conversation.channel === "EMAIL" ? { emailMailbox: conversation.emailMailboxOverride || latestInboundEmail?.rawPayload?.gmailMailbox || "GENERAL" } : {}),
    };
  });
}

async function getSidebarSummary(viewer,{company,excludeMarketplaces}={}){
  const companyId = await companyService.resolveWorkspace(viewer, company);
  const scope={AND:[await authorization.conversationScope(viewer),{archivedAt:null},{companyId},whatsappInbox.canonicalScope]};
  const master=authorization.isMaster(viewer);
  const sidebarCategoryIds = master ? null : new Set(await authorization.allowedCategoryIds(viewer));
  const canCountUncategorized = master || Boolean((await companyService.userForCompany(viewer, companyId))?.canViewUncategorized);
  let rows=await prisma.conversation.findMany({where:scope,select:{id:true,companyId:true,channel:true,emailMailboxOverride:true,categoryId:true,status:true,priority:true,assignedUserId:true,unreadCount:true,lastMessageAt:true,createdAt:true,...(master?{masterReads:{where:{userId:viewer.id},select:{readAt:true},take:1}}:{})}});
  const mailboxes=await emailMailboxes(prisma,rows.filter(row=>row.channel==='EMAIL').map(row=>row.id));
  rows=rows.filter(row=>(excludeMarketplaces!=='true'||!['MERCADO_LIVRE','TIKTOK_SHOP','AMAZON_MARKETPLACE','SHOPEE','SHEIN_MARKETPLACE'].includes(row.channel))&&(row.channel!=='EMAIL'||(row.emailMailboxOverride||mailboxes.get(row.id)||'GENERAL')!=='SPAM'));
  const waiting=rows.filter(row=>row.status==='AGUARDANDO_EQUIPE');
  const counts=master?await countMasterUnread(waiting,prisma):new Map(waiting.map(row=>[row.id,row.unreadCount]));
  if(!master&&waiting.length){const allowed=new Set((await prisma.conversation.findMany({where:{AND:[{id:{in:waiting.map(row=>row.id)}},await authorization.operationalScope(viewer)]},select:{id:true}})).map(row=>row.id));for(const row of waiting)if(!allowed.has(row.id))counts.set(row.id,0);}
  const settings=new Map();for(const id of new Set(rows.map(row=>row.companyId)))settings.set(id,await getConversationSettings(prisma,id));
  const result={total:rows.length,statuses:{EM_ATENDIMENTO:0},categories:{},overdue:0,urgent:0,unassigned:0,attentionWaiting:0,openByCompany:{}};
  const now=new Date();
  await require('./service-hours-sla').attachSlaCalendars(settings,prisma,now);
  for (const row of rows) {
    result.statuses[row.status] = (result.statuses[row.status] || 0) + 1;
    if (row.priority === "URGENTE") result.urgent++;
    if (!row.assignedUserId && row.status !== "FINALIZADO") result.unassigned++;
    if (computeSlaMinutesRemaining(row, settings.get(row.companyId), now) < 0) result.overdue++;
    if (row.categoryId ? !sidebarCategoryIds || sidebarCategoryIds.has(row.categoryId) : canCountUncategorized) {
      const key = row.categoryId || "null";
      result.categories[key] = (result.categories[key] || 0) + 1;
    }
    if (row.status === "AGUARDANDO_EQUIPE" && counts.get(row.id) > 0) result.attentionWaiting++;
    if (row.status !== "FINALIZADO") result.openByCompany[row.companyId] = (result.openByCompany[row.companyId] || 0) + 1;
  }
  result.statuses.EM_ATENDIMENTO=rows.filter(row=>row.assignedUserId&&!['NOVO','FINALIZADO'].includes(row.status)).length;
  return result;
}

async function getConversationSummary(viewer, { company } = {}) {
  const securityScope = await authorization.conversationScope(viewer);
  // Contadores da barra lateral = SÓ o workspace ativo (nunca contagem global).
  const scope = { AND: [securityScope, { companyId: await companyService.resolveWorkspace(viewer, company) }] };
  const summaryScope = { AND: [scope, {archivedAt:null}, notManualSpam, whatsappInbox.canonicalScope] };
  const master = authorization.isMaster(viewer);
  const attentionScope = { AND: [summaryScope, { status: "AGUARDANDO_EQUIPE" }, {
    OR: [{ assignedUserId: null }, { assignedUserId: viewer.id }],
  }] };
  // Contadores novos (item 12): Atrasadas/Urgentes/Sem responsável — sempre
  // dentro do escopo do usuário (mesma regra de visibilidade das demais
  // contagens) e só entre conversas ativas (nunca FINALIZADO/BOT).
  const slaNow=new Date(),sla=require('./service-hours-sla'),slaCompany=scope.AND[1].companyId;
  const slaContext=(await sla.loadSlaCalendars(prisma,slaNow,[slaCompany])).get(slaCompany);
  const overdueScope = { AND: [summaryScope,{channel:{not:'EMAIL'}},sla.slaOverdueWhere(await getConversationSettings(prisma,slaCompany),slaContext)] };
  const urgentScope = { AND: [summaryScope, { status: { in: activeManagedStatuses } }, { priority: "URGENTE" }] };
  const unassignedScope = { AND: [summaryScope, { status: { in: activeManagedStatuses } }, { assignedUserId: null }] };
  const inProgressScope = { AND: [summaryScope, { assignedUserId: { not: null } }, { status: { notIn: ["NOVO", "FINALIZADO"] } }] };
  const [total, statuses, inProgressCount, categories, waitingConversations, overdue, urgent, unassignedCount, byCompany] = await Promise.all([
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
    // Quebra por empresa (item 41): conversas ativas (não finalizadas) de
    // cada empresa visível — "Abertas: 42 · Mibro 25 · Sincrofit 17".
    prisma.conversation.groupBy({
      by: ["companyId"], where: { AND: [summaryScope, { status: { not: "FINALIZADO" } }] }, _count: { _all: true },
    }),
  ]);
  const waitingCounts = master ? await countMasterUnread(waitingConversations, prisma) : null;
  const unreadWaiting = waitingConversations.map(conversation =>
    (master ? waitingCounts.get(conversation.id) : conversation.unreadCount) > 0);
  return {
    total,
    attentionWaiting: unreadWaiting.filter(Boolean).length,
    overdue,
    urgent,
    unassigned: unassignedCount,
    statuses: { ...Object.fromEntries(statuses.map((item) => [item.status, item._count._all])), EM_ATENDIMENTO: inProgressCount },
    categories: Object.fromEntries(categories.map((item) => [item.categoryId, item._count._all])),
    openByCompany: Object.fromEntries(byCompany.map((item) => [item.companyId, item._count._all])),
  };
}

// Workspaces: mensagens recebidas ainda não lidas, por empresa acessível —
// alimenta o contador e a pulsação das abas MIBRO | SINCROFIT. Usa o estado
// REAL de leitura (o mesmo da lista): Conversation.unreadCount para
// Atendente/Supervisor e ConversationMasterRead para o Master. Só mensagens
// RECEBIDAS (nunca enviadas) e sem reações; cada mensagem conta uma vez porque
// a contagem vem do banco, não de eventos somados no navegador.
// `latestUnreadAt`/`latestUnreadId` = mensagem não lida mais recente: o
// navegador só pulsa a aba quando ela muda (novidade), nunca por histórico.
async function getWorkspaceUnread(viewer) {
  const access = await companyService.companyAccess(viewer);
  const baseScope = { AND: [await authorization.operationalScope(viewer), {archivedAt:null}, notManualSpam, whatsappInbox.canonicalScope] };
  const master = authorization.isMaster(viewer);
  const workspaces = [];
  for (const { companyId, company } of access) {
    const companyScope = { AND: [baseScope, { companyId }] };
    let unreadConversations = 0;
    let unreadMessages = 0;
    let latest = null;
    if (!master) {
      const unreadScope = { AND: [companyScope, { unreadCount: { gt: 0 } }] };
      const [aggregate, newest] = await Promise.all([
        prisma.conversation.aggregate({ where: unreadScope, _count: { _all: true }, _sum: { unreadCount: true } }),
        prisma.message.findFirst({
          where: { direction: "RECEBIDA", type: { not: "reaction" }, conversation: { is: unreadScope } },
          orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true },
        }),
      ]);
      unreadConversations = aggregate._count._all;
      unreadMessages = aggregate._sum.unreadCount || 0;
      latest = newest;
    } else {
      const candidates = await prisma.conversation.findMany({
        where: companyScope,
        select: { id: true, unreadCount: true, masterReads: { where: { userId: viewer.id }, select: { readAt: true }, take: 1 } },
      });
      const withRead = candidates.filter((conversation) => conversation.masterReads[0]?.readAt).map(({ id }) => id);
      const withoutRead = candidates.filter((conversation) => !conversation.masterReads[0]?.readAt && conversation.unreadCount > 0);
      const rows = withRead.length ? await prisma.$queryRaw`
        SELECT m."conversationId" AS "conversationId", count(*)::int AS "count", max(m."createdAt") AS "latestAt"
        FROM "Message" m
        JOIN "ConversationMasterRead" r ON r."conversationId" = m."conversationId" AND r."userId" = ${viewer.id}
        WHERE m."conversationId" = ANY(${withRead}::text[])
          AND m."direction"::text = 'RECEBIDA' AND m."type" <> 'reaction' AND m."createdAt" > r."readAt"
        GROUP BY m."conversationId"` : [];
      unreadConversations = rows.length + withoutRead.length;
      unreadMessages = rows.reduce((total, row) => total + Number(row.count || 0), 0)
        + withoutRead.reduce((total, conversation) => total + conversation.unreadCount, 0);
      const unreadIds = [...rows.map((row) => row.conversationId), ...withoutRead.map(({ id }) => id)];
      latest = unreadIds.length ? await prisma.message.findFirst({
        where: { conversationId: { in: unreadIds }, direction: "RECEBIDA", type: { not: "reaction" } },
        orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true },
      }) : null;
    }
    workspaces.push({
      companyId, slug: company?.slug || null, unreadConversations, unreadMessages,
      latestUnreadAt: latest?.createdAt || null, latestUnreadId: latest?.id || null,
    });
  }
  return { workspaces, checkedAt: new Date().toISOString() };
}

async function addContactNote(contactId, { content, authorId, conversationId }, viewer) {
  await authorization.assertCanAccessContact(viewer, contactId, { act: true });
  let privateCategoryId = null;
  if (conversationId) {
    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, contactId }, select: { id: true } });
    if (!conversation) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
    // Nota escrita durante o Financeiro fica restrita ao setor (o cadastro
    // do contato é compartilhado com quem atende depois).
    privateCategoryId = await privateSegments.stampForConversation(conversationId, prisma);
  }
  const text = content?.trim();
  if (!text) throw Object.assign(new Error("A nota não pode ficar vazia."), { statusCode: 400 });
  if (text.length > 2000) throw Object.assign(new Error("A nota deve ter no máximo 2.000 caracteres."), { statusCode: 400 });
  try {
    return await prisma.$transaction(async (transaction) => {
      const note = await transaction.contactNote.create({
        data: { contactId, content: text, authorId: authorId || null, privateCategoryId },
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
    await transaction.conversationActivity.create({ data: {
      ...activityRecord(conversationId, viewer.id, "NOTE_DELETED", { preview: note.content.slice(0, 120), wasPinned: note.pinned }),
      ...(note.privateCategoryId ? { privateCategoryId: note.privateCategoryId } : {}),
    } });
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
  // Figurinhas/GIFs da biblioteca e mensagens encaminhadas dividem o arquivo.
  const [stillInMessages, stillInLibrary] = await Promise.all([
    prisma.message.findMany({ where: { mediaStorageKey: { in: mediaKeys } }, select: { mediaStorageKey: true }, distinct: ["mediaStorageKey"] }),
    prisma.mediaAsset.findMany({ where: { storageKey: { in: mediaKeys } }, select: { storageKey: true }, distinct: ["storageKey"] }),
  ]);
  const shared = new Set([...stillInMessages.map((row) => row.mediaStorageKey), ...stillInLibrary.map((row) => row.storageKey)]);
  await Promise.allSettled(mediaKeys.filter((storageKey) => !shared.has(storageKey)).map((storageKey) => removeImage(storageKey)));
  return { deleted: true, id };
}

async function setEmailSpamStatus(id, { spam }, viewer) {
  if (typeof spam !== "boolean") {
    throw Object.assign(new Error("Informe se a conversa deve ser marcada como spam."), { statusCode: 400 });
  }
  await authorization.assertCanActOnConversation(viewer, id);
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
  await authorization.assertCanAccessContact(viewer, contactId, { act: true });
  if (typeof pinned !== "boolean") {
    throw Object.assign(new Error("Informe se a nota deve ser fixada."), { statusCode: 400 });
  }
  const note = await prisma.contactNote.findFirst({ where: { id: noteId, contactId } });
  if (!note || !(await privateSegments.canReadRecord(viewer, note))) throw Object.assign(new Error("Nota não encontrada."), { statusCode: 404 });
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
    if (conversationId) await transaction.conversationActivity.create({ data: {
      ...activityRecord(conversationId, viewer.id, pinned ? "NOTE_PINNED" : "NOTE_UNPINNED", { preview: note.content.slice(0, 120) }),
      // Prévia de nota do Financeiro continua restrita ao setor.
      ...(note.privateCategoryId ? { privateCategoryId: note.privateCategoryId } : {}),
    } });
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
  categoryId, status, assignedUserId, priority, limitHistory, shareHistory, transferReason, handoffSummary, whatsappSendAccountId,
}, viewer) {
  if (shareHistory !== undefined && typeof shareHistory !== "boolean") {
    throw Object.assign(new Error("Informe se o histórico deve ser compartilhado."), { statusCode: 400 });
  }
  const reason = optionalTransferText(transferReason, "Motivo da transferência", 500);
  if (whatsappSendAccountId !== undefined) throw Object.assign(new Error("O número de envio é definido automaticamente pela categoria. Configure os Acessos da integração."), { statusCode: 400 });
  const summary = optionalTransferText(handoffSummary, "Resumo de handoff", 2000);
  const currentAccess = await authorization.assertCanActOnConversation(viewer, id);
  const currentSnapshot = await prisma.conversation.findUnique({
    where: { id },
    include: {
      contact: { select: { whatsappInboxId: true } },
      category: { include: { parent: true } },
      assignedUser: { select: { id: true, name: true } },
    },
  });
  if (!currentSnapshot) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
  // Multiempresa: permissões avaliadas com o cargo do usuário NA EMPRESA da
  // conversa (Supervisor na Mibro pode ser Atendente na Sincrofit).
  const companyId = currentSnapshot.companyId;
  const actor = (await companyService.userForCompany(viewer, companyId)) || viewer;
  if (status && !conversationStatuses.has(status)) {
    throw Object.assign(new Error("Status inválido."), { statusCode: 400 });
  }
  if (priority !== undefined) {
    if (!conversationPriorities.has(priority)) {
      throw Object.assign(new Error("Prioridade inválida."), { statusCode: 400 });
    }
    authorization.assertCanSetPriority(actor);
  }
  let targetCategory = currentSnapshot.category;
  if (categoryId) {
    // Categoria precisa ser da MESMA empresa da conversa — nunca "Renova
    // Mibro" numa conversa Sincrofit.
    targetCategory = await prisma.category.findFirst({
      where: { id: categoryId, active: true, companyId }, include: { parent: true },
    });
    if (!targetCategory) throw Object.assign(new Error("Categoria não encontrada ou inativa."), { statusCode: 400 });
    if (currentSnapshot.channel !== "META") await authorization.assertChannelAccountAllowsCategory(currentSnapshot.channelAccountId, categoryId);
    if (!authorization.isMaster(viewer) && (targetCategory.masterOnly || targetCategory.parent?.masterOnly)) {
      throw authorization.forbidden("Esta categoria e exclusiva para contas Master.");
    }
  }
  if (categoryId === null) targetCategory = null;
  if (categoryId === null && !authorization.canTransfer(actor)
    && !(await authorization.canAccessCategory(actor, null))) {
    throw authorization.forbidden("Você não pode remover a categoria desta conversa.");
  }
  if (assignedUserId) {
    const user = await prisma.user.findFirst({ where: { id: assignedUserId, active: true } });
    if (!user) throw Object.assign(new Error("Atendente não encontrado ou inativo."), { statusCode: 400 });
    const target = await companyService.userForCompany(user, companyId);
    if (!target) throw Object.assign(new Error("O atendente não tem acesso à empresa desta conversa."), { statusCode: 400 });
    const canUseSender = currentSnapshot.channel === "META" && currentSnapshot.contact.whatsappInboxId && categoryId !== undefined
      ? (await whatsappInbox.senderState({ ...currentSnapshot, categoryId: targetCategory?.id || null, whatsappSendAccountId: null }, user)).options.length > 0
      : await authorization.canAccessChannelAccount(user, currentSnapshot.channelAccountId);
    if (!canUseSender) {
      throw Object.assign(new Error("O atendente não foi liberado para esta conta de canal."), { statusCode: 400 });
    }
    const targetCategoryId = categoryId !== undefined ? categoryId : currentAccess.categoryId;
    if (!(await authorization.canAccessCategory(target, targetCategoryId))) {
      throw Object.assign(new Error("O atendente não possui acesso à categoria desta conversa."), { statusCode: 400 });
    }
  }
  if (assignedUserId !== undefined && !authorization.canTransfer(actor) && assignedUserId !== viewer.id) {
    throw authorization.forbidden("Você não pode transferir esta conversa.");
  }
  const data = {};
  if (currentSnapshot.channel === "META" && categoryId !== undefined && categoryId !== currentSnapshot.categoryId) {
    data.whatsappSendAccountId = null;
    const candidates = whatsappInbox.routingCandidates(targetCategory, await prisma.channelAccount.findMany({ where: { channel: "META", companyId, enabled: true, status: "CONNECTED" } }));
    data.channelAccountId = candidates.length === 1 && !candidates[0].config?.isLegacyWhatsApp ? candidates[0].id : null;
  }
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
      if((categoryId!==undefined&&currentSnapshot.categoryId!==updated.categoryId)||(assignedUserId&&currentSnapshot.assignedUserId!==updated.assignedUserId)){
        const fixedOwner=await require('./commercial-template-owner-service').clearOwnerOnCategoryTransfer(transaction,{before:currentSnapshot,after:updated,actor:viewer});
        if(fixedOwner.cleared)Object.assign(updated.contact,fixedOwner.contactPatch);
      }
      if (assignedUserId === viewer.id) {
        await require("./sincrofit-atacado-owner-service").setOwnerOnClaim(transaction, { before: currentSnapshot, after: updated, actor: viewer });
      }
      const activities = [];
      // Setor privado: os eventos desta alteração recebem o carimbo do
      // estado FINAL (entrar no Financeiro já é do Financeiro; sair dele —
      // com motivo/resumo para quem recebe — já é do setor de destino).
      const fromPrivate = currentSnapshot.status === "FINALIZADO" ? null : privateSegments.privateRootOf(currentSnapshot.category);
      const toPrivate = updated.status === "FINALIZADO" ? null : privateSegments.privateRootOf(updated.category);
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
        // Evento e período com o MESMO horário: a transferência que encerra
        // um trecho aparece na linha do tempo de quem supervisiona o trecho.
        const changedAt = new Date();
        activities.push({ ...activityRecord(id, viewer.id, action, details), createdAt: changedAt });
        await periods.recordAssignmentChange(transaction, {
          conversationId: id, toUserId: updated.assignedUserId, at: changedAt,
          reason: action === "CONVERSATION_CLAIMED" ? "CLAIMED" : "TRANSFERRED",
          endReason: action === "ASSIGNEE_REMOVED" ? "REMOVED" : "TRANSFERRED",
          transferredById: action === "CONVERSATION_TRANSFERRED" ? viewer.id : null,
        });
      }
      if (status && currentSnapshot.status !== updated.status) {
        activities.push(activityRecord(id, viewer.id, "STATUS_CHANGED", { from: currentSnapshot.status, to: updated.status }));
      }
      if (priority !== undefined && currentSnapshot.priority !== updated.priority) {
        activities.push(activityRecord(id, viewer.id, "PRIORITY_CHANGED", { from: currentSnapshot.priority, to: updated.priority }));
      }
      if (fromPrivate !== toPrivate) {
        if (fromPrivate) {
          activities.push(activityRecord(id, viewer.id, "PRIVATE_SEGMENT_ENDED", {
            categoryId: fromPrivate, category: categoryLabelForHistory(currentSnapshot.category?.parent || currentSnapshot.category),
            to: updated.category ? categoryLabelForHistory(updated.category) : "Sem categoria",
          }));
        }
        if (toPrivate) {
          activities.push(activityRecord(id, viewer.id, "PRIVATE_SEGMENT_STARTED", {
            categoryId: toPrivate, category: categoryLabelForHistory(updated.category?.parent || updated.category),
            from: currentSnapshot.category ? categoryLabelForHistory(currentSnapshot.category) : "Sem categoria",
            responsible: updated.assignedUser?.name || null,
          }));
        }
      }
      if (activities.length) {
        await transaction.conversationActivity.createMany({
          data: activities.map((activity) => ({ ...activity, privateCategoryId: toPrivate })),
        });
      }
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
          companyId,
          ...entry,
        }, transaction);
      }
           return updated;
  });

    // Fora do expediente: alguém assumiu/recebeu a conversa ou ela foi
    // finalizada — o lembrete pendente deixa de fazer sentido.
    if (result.status === "FINALIZADO" || (result.assignedUserId && result.assignedUserId !== currentSnapshot.assignedUserId)) {
      await require("./after-hours-reminder-service").cancelSafely(id, result.status === "FINALIZADO" ? "CONVERSATION_FINALIZED" : "HUMAN_ASSIGNED");
    }

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
  const requested = await prisma.conversation.findUnique({ where: { id }, select: { channel: true, contactId: true } });
  if (requested?.channel === "META") {
    const root = await whatsappInbox.findInbox(requested.contactId);
    if (root && root.id !== id) return markAsRead(root.id, { channel, viewer });
  }
  if (viewer && !authorization.isMaster(viewer) && !(await authorization.canActOnConversation(viewer, id))) {
    // Leitura passiva de supervisão: não zera as não lidas do atendente nem
    // confirma leitura ao cliente.
    const conversation = await prisma.conversation.findUnique({ where: { id } });
    if (!conversation) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
    return { ...conversation, unreadCount: 0, readReceiptSent: false, passive: true, changed: false };
  }
  const [latestUnread, latestIncoming] = await Promise.all([
    prisma.message.findFirst({
      where: {
        conversationId: id,
        direction: "RECEBIDA",
        status: { not: "LIDA" },
        externalId: { not: null },
      },
      orderBy: { occurredAt: "desc" },
      select: { externalId: true, channelAccountId: true },
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
      const receiptChannel = latestUnread.channelAccountId ? (await require("./channels/channel-message-service").adapterFor("META", latestUnread.channelAccountId)).channel : channel;
      const providerId = latestUnread.channelAccountId && latestUnread.externalId.startsWith(`${latestUnread.channelAccountId}:`) ? latestUnread.externalId.slice(latestUnread.channelAccountId.length + 1) : latestUnread.externalId;
      await receiptChannel.markAsRead(providerId);
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
  const marked = await prisma.message.updateMany({
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
        changed: marked.count > 0,
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
      // Sem nada novo lido, ninguém precisa recarregar: publicar aqui criava
      // um ciclo SSE → refresh → /read → SSE entre os painéis abertos.
      changed: marked.count > 0 || Boolean(requested?.unreadCount),
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

// Multiempresa: só categorias das empresas acessíveis (cada item traz
// companyId/company para o front oferecer, numa conversa, apenas as
// categorias da empresa dela). `company` = filtro opcional da tela.
async function listCategories(viewer, { company } = {}) {
  const filters = [await authorization.companyScope(viewer)];
  if (company && company !== companyService.ALL_COMPANIES) {
    filters.push({ companyId: { in: await companyService.resolveCompanyFilter(viewer, company) } });
  }
  const publicCategoryScope = { masterOnly: false, OR: [{ parentId: null }, { parent: { is: { masterOnly: false } } }] };
  if (!authorization.isMaster(viewer)) filters.push(publicCategoryScope);
  let selectableIds = null;
  if (!authorization.isMaster(viewer)) {
    const categoryIds = await authorization.allowedCategoryIds(viewer);
    selectableIds = new Set(categoryIds);
    filters.push({ OR: [
      { id: { in: categoryIds } },
      { children: { some: { id: { in: categoryIds }, masterOnly: false } } },
    ] });
  }
  const where = { AND: filters };
  const [categories, preferences] = await Promise.all([prisma.category.findMany({
    where,
    include: { parent: { select: { id: true, name: true, code: true, active: true, visibilityMode: true } }, company: { select: COMPANY_SELECT } },
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
  const scope = await authorization.operationalScope(viewer);
  const conversation = await prisma.conversation.findFirst({
    where: { AND: [{ id: conversationId }, scope] },
    select: { id: true, companyId: true, channel: true, channelAccountId: true },
  });
  if (!conversation) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });

  const publicCategoryScope = {
    masterOnly: false,
    OR: [{ parentId: null }, { parent: { is: { masterOnly: false } } }],
  };
  const categories = await prisma.category.findMany({
    where: authorization.isMaster(viewer)
      ? { active: true, companyId: conversation.companyId }
      : { AND: [{ active: true, companyId: conversation.companyId }, publicCategoryScope] },
    include: { parent: { select: { id: true, name: true, code: true, active: true } } },
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
  });
  if (conversation.channel === "META" || !conversation.channelAccountId) return categories.map((category) => ({ ...category, selectable: true }));

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

async function getCategoryVisibility(viewer, client = prisma) {
  const preferences = await client.user.findUnique({
    where: { id: viewer.id },
    select: { hideUncategorized: true, hiddenCategories: { select: { categoryId: true } } },
  });
  return { hideUncategorized: Boolean(preferences?.hideUncategorized), hiddenCategoryIds: preferences?.hiddenCategories.map(({ categoryId }) => categoryId) || [] };
}

async function setCategoryVisibility({ categoryId, hidden, reset, company }, viewer) {
  if (reset === true) {
    const companyId = await companyService.resolveWorkspace(viewer, company);
    const scopedViewer = await authorization.forCompany(viewer, companyId);
    return prisma.$transaction(async (tx) => {
      await tx.userHiddenCategory.deleteMany({ where: { userId: viewer.id, category: { is: { companyId } } } });
      if (scopedViewer.canViewUncategorized || authorization.isMaster(scopedViewer)) {
        await tx.user.updateMany({ where: { id: viewer.id, hideUncategorized: true }, data: { hideUncategorized: false } });
      }
      return getCategoryVisibility(viewer, tx);
    });
  }
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
  const name = validateCategoryName(data.name);
  const color = validateCategoryColor(data.color) || "#6b7280";
  const parentId = data.parentId || null;
  let companyId;
  if (parentId) {
    const parent = await prisma.category.findFirst({ where: {
      id: parentId, active: true, parentId: null,
      ...(authorization.isMaster(viewer) ? {} : { masterOnly: false }),
    } });
    if (!parent) throw Object.assign(new Error("A categoria principal não existe, está inativa ou já é uma subcategoria."), { statusCode: 400 });
    await companyService.assertCompanyAccess(viewer, parent.companyId, "A categoria principal não existe, está inativa ou já é uma subcategoria.");
    if (data.companyId && data.companyId !== parent.companyId) {
      throw Object.assign(new Error("A subcategoria deve ser da mesma empresa da categoria principal."), { statusCode: 400 });
    }
    companyId = parent.companyId;
  } else {
    companyId = await companyService.resolveCompanyForCreate(viewer, data.companyId);
  }
  authorization.assertCanManageCategories(await authorization.forCompany(viewer, companyId));
  const baseCode = categoryCode(name);
  const order = await prisma.category.aggregate({ where: { companyId }, _max: { displayOrder: true } });
  for (let suffix = 1; suffix <= 100; suffix += 1) {
    const code = suffix === 1 ? baseCode : `${baseCode}_${suffix}`;
    try {
      return await prisma.$transaction(async (transaction) => {
        const category = await transaction.category.create({
          data: { companyId, code, name, color, parentId, masterOnly: Boolean(data.masterOnly), displayOrder: (order._max.displayOrder || 0) + 10 },
        });
        await audit.recordAudit({
          actor: viewer,
          action: "CATEGORY_CREATED",
          entityType: "CATEGORY",
          entityId: category.id,
          companyId,
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
  const existing = await prisma.category.findUnique({ where: { id }, include: { parent: { select: { masterOnly: true } } } });
  if (!existing) throw Object.assign(new Error("Categoria não encontrada."), { statusCode: 404 });
  await companyService.assertCompanyAccess(viewer, existing.companyId, "Categoria não encontrada.");
  authorization.assertCanManageCategories(await authorization.forCompany(viewer, existing.companyId));
  if (data.companyId !== undefined && data.companyId !== existing.companyId) {
    throw Object.assign(new Error("A empresa de uma categoria não pode ser alterada."), { statusCode: 400 });
  }
  if ((existing.masterOnly || existing.parent?.masterOnly || data.masterOnly !== undefined) && !authorization.isMaster(viewer)) {
    throw authorization.forbidden("Somente uma conta Master pode alterar categorias restritas.");
  }
  const allowed = {};
  if (data.name !== undefined) allowed.name = validateCategoryName(data.name);
  if (data.color !== undefined) allowed.color = validateCategoryColor(data.color);
  if (typeof data.active === "boolean") allowed.active = data.active;
  if (typeof data.masterOnly === "boolean") allowed.masterOnly = data.masterOnly;
  if (Number.isInteger(data.displayOrder)) allowed.displayOrder = data.displayOrder;
  // Histórico protegido (Financeiro): decisão de alto risco — só Master, e
  // só no setor principal (subcategoria herda).
  if (data.visibilityMode !== undefined && data.visibilityMode !== existing.visibilityMode) {
    if (!authorization.isMaster(viewer)) throw authorization.forbidden("Somente uma conta Master pode proteger o histórico de um setor.");
    if (!["NORMAL", privateSegments.PRIVATE].includes(data.visibilityMode)) {
      throw Object.assign(new Error("Visibilidade inválida."), { statusCode: 400 });
    }
    if (data.parentId !== undefined ? data.parentId : existing.parentId) {
      throw Object.assign(new Error("O histórico protegido é definido no setor principal; a subcategoria herda."), { statusCode: 400 });
    }
    allowed.visibilityMode = data.visibilityMode;
  }
  if (data.parentId && (allowed.visibilityMode || existing.visibilityMode) === privateSegments.PRIVATE) {
    throw Object.assign(new Error("Um setor com histórico protegido não pode virar subcategoria."), { statusCode: 400 });
  }
  if (data.parentId !== undefined) {
    const parentId = data.parentId || null;
    if (parentId === id) throw Object.assign(new Error("Uma categoria não pode ser sua própria categoria principal."), { statusCode: 400 });
    if (parentId) {
      const [parent, children] = await Promise.all([
        prisma.category.findFirst({ where: {
          id: parentId, active: true, parentId: null, companyId: existing.companyId,
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
        companyId: category.companyId,
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
  await authorization.assertCanAccessContact(viewer, contactId, { act: true });

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

// Lista para atribuir/transferir. `companyIds` diz em quais empresas cada
// pessoa pode receber conversa (o backend revalida em updateConversation).
// Quem não é Master só enxerga colegas de empresas que ele mesmo acessa.
async function listUsers(viewer) {
  const where = authorization.isMaster(viewer) || viewer.canTransferConversations
    ? { active: true } : { id: viewer.id, active: true };
  const [users, companies, viewerCompanyIds] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true, name: true, email: true, role: true,
        companyAccess: { where: { active: true }, select: { companyId: true, role: true } },
      },
      orderBy: { name: "asc" },
    }),
    companyService.listCompanies(),
    companyService.accessibleCompanyIds(viewer),
  ]);
  const activeIds = new Set(companies.map(({ id }) => id));
  const visible = new Set(viewerCompanyIds);
  return users.map(({ companyAccess, ...user }) => {
    const companyIds = user.role === "ADMIN"
      ? [...activeIds]
      : companyAccess.map(({ companyId }) => companyId).filter((id) => activeIds.has(id));
    return { ...user, companyIds: companyIds.filter((id) => visible.has(id)) };
  }).filter((user) => user.id === viewer.id || user.companyIds.length);
}

module.exports = {
  readableMessageScope,
  addContactNote, assertCanViewMessage, readVisibility, conversationPriorities, conversationStatuses, createCategory, deleteContactNote, deleteConversation,
  getConversation, getConversationSummary, getSidebarSummary, getUserAlerts, listCategories, listTransferCategories,
  resolveHistoryStart,
  getWorkspaceUnread, searchConversations, listConversations, listUsers, markAsRead, recordConversationActivity, setContactNotePinned, setConversationPinned, setEmailSpamStatus,
  getCategoryVisibility, setCategoryVisibility, updateCategory, updateContactCustomName, updateConversation,
};
