// Biblioteca única de mensagens reutilizáveis (Respostas Rápidas). Usada
// hoje por atendentes; preparada para Bot/IA sugerirem no futuro — nunca
// enviar automaticamente a partir daqui. Backend é sempre a fonte da
// verdade: o frontend nunca decide sozinho se uma resposta pode aparecer.
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const audit = require("./audit-service");
const { contextFromConversation, previewContext, renderTemplate } = require("./quick-reply-template-service");
const { normalizeOutgoingAudio } = require("./audio-normalization-service");
const { removeImage, storeAudio } = require("./media-storage-service");

// Biblioteca pessoal (respostas rápidas de áudio): PERSONAL só aparece para
// o dono — nunca para outros atendentes, nem na tela administrativa de
// globais. Master pode editar/excluir uma pessoal (administração), mas não
// a vê no composer dele.
const MAX_PERSONAL_QUICK_REPLIES = 200;
// Canais em que o envio de áudio pela Central já existe (message-service#sendAudio).
const AUDIO_CHANNELS = new Set(["META"]);

const ALLOWED_CHANNELS = new Set([
  "META", "INSTAGRAM_DIRECT", "INSTAGRAM_COMMENTS", "FACEBOOK_MESSENGER", "FACEBOOK_COMMENTS",
  "EMAIL", "MERCADO_LIVRE", "TIKTOK_SHOP", "AMAZON_MARKETPLACE", "SHOPEE", "GOOGLE_REVIEWS", "RECLAME_AQUI",
]);
const ALLOWED_TYPES = new Set(["QUICK_REPLY", "SUGGESTED_REPLY", "AUTOMATED_REPLY"]);
const SHORTCUT_PATTERN = /^\/[a-z0-9_]{1,30}$/;
const HTML_TAG_PATTERN = /<[^>]*>/g;

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function assertQuickReplyManager(viewer) {
  if (!authorization.isMaster(viewer)) {
    throw authorization.forbidden("Somente uma conta Master pode gerenciar Respostas Rápidas.");
  }
}

function sanitizeText(value) {
  return String(value ?? "").replace(HTML_TAG_PATTERN, "").replace(/\r\n/g, "\n");
}

function requiredText(value, label, maxLength) {
  const text = typeof value === "string" ? sanitizeText(value).trim() : "";
  if (!text) throw fail(`${label} é obrigatório.`);
  if (text.length > maxLength) throw fail(`${label} deve ter no máximo ${maxLength.toLocaleString("pt-BR")} caracteres.`);
  return text;
}

// O texto pode ter múltiplas linhas (item 22) — só o trim das bordas e a
// normalização de quebras de linha, nunca colapsar linhas internas.
function requiredBody(value, label, maxLength) {
  const text = typeof value === "string" ? sanitizeText(value).trim() : "";
  if (!text) throw fail(`${label} é obrigatório.`);
  if (text.length > maxLength) throw fail(`${label} deve ter no máximo ${maxLength.toLocaleString("pt-BR")} caracteres.`);
  return text;
}

function validateShortcut(value) {
  const shortcut = String(value ?? "").trim().toLowerCase();
  if (!SHORTCUT_PATTERN.test(shortcut)) {
    throw fail("Atalho inválido. Use \"/\" seguido de letras, números ou _ (ex.: /pedido).");
  }
  return shortcut;
}

function validateChannels(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw fail("channels deve ser uma lista de canais.");
  const unique = [...new Set(value)];
  for (const channel of unique) {
    if (!ALLOWED_CHANNELS.has(channel)) throw fail(`Canal inválido: ${channel}`);
  }
  return unique;
}

function validateType(value) {
  if (value === undefined || value === null) return "QUICK_REPLY";
  if (!ALLOWED_TYPES.has(value)) throw fail("Tipo de resposta inválido.");
  return value;
}

function validateBoolean(value, label) {
  if (typeof value !== "boolean") throw fail(`${label} deve ser verdadeiro ou falso.`);
  return value;
}

function requireConversationId(value) {
  const conversationId = typeof value === "string" ? value.trim() : "";
  if (!conversationId) throw fail("conversationId é obrigatório.");
  return conversationId;
}

async function accessibleConversation(viewer, value) {
  const conversationId = requireConversationId(value);
  await authorization.assertCanActOnConversation(viewer, conversationId);
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { contact: true, category: { select: { id: true, parentId: true } } },
  });
  if (!conversation) throw fail("Conversa não encontrada.", 404);
  return conversation;
}

async function categoryAndAncestorIds(categoryId) {
  const ids = [];
  const visited = new Set();
  let currentId = categoryId || null;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    ids.push(currentId);
    const category = await prisma.category.findUnique({ where: { id: currentId }, select: { parentId: true } });
    currentId = category?.parentId || null;
  }
  return ids;
}
function linkedCategoryIds(quickReply) {
  const linked = (quickReply.categories || []).map((link) => link.categoryId);
  return [...new Set(linked.length ? linked : (quickReply.categoryId ? [quickReply.categoryId] : []))];
}
async function assertApplicableToConversation(quickReply, conversation) {
  if (quickReply.contentType === "AUDIO" && !AUDIO_CHANNELS.has(conversation.channel)) {
    throw fail("O canal desta conversa ainda não suporta envio de áudio.");
  }
  // Pessoal: a categoria é só organização da biblioteca do atendente, não
  // restringe em qual conversa ele pode usar.
  if (quickReply.scope === "PERSONAL") return;
  if (quickReply.channels.length && !quickReply.channels.includes(conversation.channel)) {
    throw fail("Esta resposta rápida não está disponível para o canal desta conversa.");
  }
  const selectedIds = linkedCategoryIds(quickReply);
  if (!selectedIds.length) return;
  const conversationScope = await categoryAndAncestorIds(conversation.categoryId);
  if (!selectedIds.some((categoryId) => conversationScope.includes(categoryId))) {
    throw fail("Esta resposta rápida não está disponível para o setor desta conversa.");
  }
}
async function validateCategoryIds(categoryIds, legacyCategoryId) {
  const source = categoryIds === undefined ? (legacyCategoryId ? [legacyCategoryId] : []) : categoryIds;
  if (!Array.isArray(source)) throw fail("categoryIds deve ser uma lista de categorias.");
  const ids = [...new Set(source.filter(Boolean))];
  if (!ids.length) return [];
  const found = await prisma.category.findMany({ where: { id: { in: ids }, active: true }, select: { id: true } });
  if (found.length !== ids.length) throw fail("Uma ou mais categorias/setores não foram encontradas.");
  return ids;
}
function addAnd(where, condition) {
  if (!where.AND) where.AND = [];
  where.AND.push(condition);
}

async function validateIntentIds(intentIds) {
  if (!Array.isArray(intentIds) || !intentIds.length) return [];
  const unique = [...new Set(intentIds)];
  const found = await prisma.botIntent.findMany({ where: { id: { in: unique } }, select: { id: true } });
  if (found.length !== unique.length) throw fail("Uma ou mais intenções associadas não foram encontradas.");
  return unique;
}

// Item 20: atalho não pode ser ambíguo entre respostas ativas/não
// arquivadas. Reaproveitar um atalho de uma resposta arquivada é permitido.
// Globais não colidem com pessoais de terceiros (o Master nem pode saber que
// existem); uma pessoal não pode repetir uma global ativa nem outra pessoal
// do mesmo dono.
async function assertShortcutAvailable(shortcut, excludeId = null, { ownerUserId = null } = {}) {
  const scopeFilter = ownerUserId
    ? { OR: [{ scope: "GLOBAL" }, { scope: "PERSONAL", ownerUserId }] }
    : { scope: "GLOBAL" };
  const conflict = await prisma.quickReply.findFirst({
    where: { shortcut, archivedAt: null, ...scopeFilter, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  if (conflict) throw fail(`O atalho "${shortcut}" já está em uso por outra resposta ativa.`);
}

const quickReplyInclude = {
  category: { select: { id: true, name: true, code: true, color: true, parentId: true } },
  categories: {
    include: { category: { select: { id: true, name: true, code: true, color: true, parentId: true } } },
    orderBy: { createdAt: "asc" },
  },
  createdBy: { select: { id: true, name: true } },
  intents: { include: { botIntent: { select: { id: true, name: true, botId: true } } } },
  _count: { select: { usages: true, favorites: true } },
};

function serialize(quickReply, { favoritedByUserId } = {}) {
  return {
    id: quickReply.id,
    name: quickReply.name,
    shortcut: quickReply.shortcut,
    text: quickReply.text,
    categoryId: quickReply.categoryId,
    category: quickReply.category || quickReply.categories?.[0]?.category || null,
    categoryIds: linkedCategoryIds(quickReply),
    categories: (quickReply.categories || []).map((link) => link.category),
    channels: quickReply.channels,
    availableToAgents: quickReply.availableToAgents,
    availableToBots: quickReply.availableToBots,
    type: quickReply.type,
    scope: quickReply.scope || "GLOBAL",
    contentType: quickReply.contentType || "TEXT",
    ownerUserId: quickReply.ownerUserId || null,
    // Áudio: só metadados + URL autenticada (nunca o storageKey interno).
    audio: quickReply.contentType === "AUDIO" ? {
      url: `/api/quick-replies/${encodeURIComponent(quickReply.id)}/audio`,
      mimeType: quickReply.mediaMimeType, fileName: quickReply.mediaFileName,
      size: quickReply.mediaSize, durationMs: quickReply.mediaDurationMs,
    } : null,
    active: quickReply.active,
    archivedAt: quickReply.archivedAt,
    createdBy: quickReply.createdBy || null,
    intentIds: (quickReply.intents || []).map((link) => link.botIntent.id),
    intents: (quickReply.intents || []).map((link) => link.botIntent),
    usageCount: quickReply._count?.usages ?? 0,
    favoriteCount: quickReply._count?.favorites ?? 0,
    isFavorite: favoritedByUserId !== undefined ? Boolean(favoritedByUserId) : undefined,
    createdAt: quickReply.createdAt,
    updatedAt: quickReply.updatedAt,
  };
}

async function ensureQuickReply(id) {
  const quickReply = await prisma.quickReply.findUnique({ where: { id }, include: quickReplyInclude });
  if (!quickReply) throw fail("Resposta rápida não encontrada.", 404);
  return quickReply;
}

// Tela administrativa (Master) só gerencia as globais — pessoais têm rotas
// próprias (personal-audio) e não aparecem nela.
async function ensureGlobalQuickReply(id) {
  const quickReply = await ensureQuickReply(id);
  if (quickReply.scope === "PERSONAL") throw fail("Resposta rápida não encontrada.", 404);
  return quickReply;
}

// Pessoal: 404 (e não 403) para quem não é o dono — nem confirma que existe.
function assertCanSeePersonal(quickReply, viewer, { allowMaster = false } = {}) {
  if (quickReply.scope !== "PERSONAL") return;
  if (quickReply.ownerUserId === viewer?.id) return;
  if (allowMaster && authorization.isMaster(viewer)) return;
  throw fail("Resposta rápida não encontrada.", 404);
}

// Auditoria nunca guarda conteúdo binário — só metadados do áudio.
function snapshot(quickReply) {
  return {
    scope: quickReply.scope, contentType: quickReply.contentType,
    ...(quickReply.contentType === "AUDIO" ? {
      audio: { mimeType: quickReply.mediaMimeType, size: quickReply.mediaSize, durationMs: quickReply.mediaDurationMs },
    } : {}),
    name: quickReply.name, shortcut: quickReply.shortcut, text: quickReply.text,
    categoryId: quickReply.categoryId, categoryIds: linkedCategoryIds(quickReply),
    channels: quickReply.channels, type: quickReply.type,
    active: quickReply.active, availableToAgents: quickReply.availableToAgents, availableToBots: quickReply.availableToBots,
  };
}

// Item 6: listagem administrativa (Master) com busca/filtros — nunca faz
// N+1 (um único findMany com include).
async function listQuickReplies(filters, viewer) {
  assertQuickReplyManager(viewer);
  const where = { scope: "GLOBAL" };
  if (filters.active === "true") where.active = true;
  if (filters.active === "false") where.active = false;
  if (filters.includeArchived !== "true") where.archivedAt = null;
  if (filters.categoryId) {
    const categoryIds = await categoryAndAncestorIds(filters.categoryId);
    addAnd(where, { OR: [
      { categories: { some: { categoryId: { in: categoryIds } } } },
      { categoryId: { in: categoryIds } },
    ] });
  }
  if (filters.channel) where.OR = [{ channels: { isEmpty: true } }, { channels: { has: filters.channel } }];
  if (filters.type) where.type = validateType(filters.type);
  if (filters.search?.trim()) {
    const term = filters.search.trim().slice(0, 120);
    addAnd(where, {
      OR: [
        { name: { contains: term, mode: "insensitive" } },
        { shortcut: { contains: term, mode: "insensitive" } },
        { text: { contains: term, mode: "insensitive" } },
        { category: { is: { name: { contains: term, mode: "insensitive" } } } },
        { categories: { some: { category: { name: { contains: term, mode: "insensitive" } } } } },
      ],
    });
  }
  const rows = await prisma.quickReply.findMany({
    where, include: quickReplyInclude, orderBy: [{ name: "asc" }],
  });
  return rows.map((row) => serialize(row));
}

async function getQuickReply(id, viewer) {
  assertQuickReplyManager(viewer);
  return serialize(await ensureGlobalQuickReply(id));
}

async function createQuickReply(data, actor) {
  assertQuickReplyManager(actor);
  const categoryIds = await validateCategoryIds(data.categoryIds, data.categoryId);
  const create = {
    name: requiredText(data.name, "Nome", 100),
    shortcut: validateShortcut(data.shortcut),
    text: requiredBody(data.text, "Texto", 4000),
    categoryId: categoryIds[0] || null,
    channels: validateChannels(data.channels),
    availableToAgents: data.availableToAgents === undefined ? true : validateBoolean(data.availableToAgents, "availableToAgents"),
    availableToBots: data.availableToBots === undefined ? false : validateBoolean(data.availableToBots, "availableToBots"),
    type: validateType(data.type),
    active: data.active === undefined ? true : validateBoolean(data.active, "active"),
    createdByUserId: actor?.id || null,
  };
  await assertShortcutAvailable(create.shortcut);
  const intentIds = await validateIntentIds(data.intentIds);

  const quickReply = await prisma.$transaction(async (transaction) => {
    const created = await transaction.quickReply.create({ data: create });
    if (categoryIds.length) {
      await transaction.quickReplyCategory.createMany({
        data: categoryIds.map((categoryId) => ({ quickReplyId: created.id, categoryId })),
      });
    }
    if (intentIds.length) {
      await transaction.quickReplyIntent.createMany({
        data: intentIds.map((botIntentId) => ({ quickReplyId: created.id, botIntentId })),
      });
    }
    await audit.recordAudit({
      actor, action: "QUICK_REPLY_CREATED", entityType: "QUICK_REPLY", entityId: created.id,
      summary: `Criou a resposta rápida "${created.name}" (${created.shortcut})`,
      details: { after: { ...snapshot(created), categoryIds } },
    }, transaction);
    return transaction.quickReply.findUnique({ where: { id: created.id }, include: quickReplyInclude });
  });
  return serialize(quickReply);
}

async function updateQuickReply(id, data, actor) {
  assertQuickReplyManager(actor);
  const existing = await ensureGlobalQuickReply(id);
  const update = {};
  if (data.name !== undefined) update.name = requiredText(data.name, "Nome", 100);
  if (data.shortcut !== undefined) {
    update.shortcut = validateShortcut(data.shortcut);
    await assertShortcutAvailable(update.shortcut, id);
  }
  if (data.text !== undefined) update.text = requiredBody(data.text, "Texto", 4000);
  const categoryIds = data.categoryIds !== undefined || data.categoryId !== undefined
    ? await validateCategoryIds(data.categoryIds, data.categoryId)
    : null;
  if (categoryIds !== null) update.categoryId = categoryIds[0] || null;
  if (data.channels !== undefined) update.channels = validateChannels(data.channels);
  if (data.availableToAgents !== undefined) update.availableToAgents = validateBoolean(data.availableToAgents, "availableToAgents");
  if (data.availableToBots !== undefined) update.availableToBots = validateBoolean(data.availableToBots, "availableToBots");
  if (data.type !== undefined) update.type = validateType(data.type);
  if (data.active !== undefined) update.active = validateBoolean(data.active, "active");
  if (!Object.keys(update).length && data.intentIds === undefined && categoryIds === null) {
    throw fail("Informe ao menos um campo para atualizar.");
  }

  const intentIds = data.intentIds !== undefined ? await validateIntentIds(data.intentIds) : null;

  const quickReply = await prisma.$transaction(async (transaction) => {
    if (Object.keys(update).length) await transaction.quickReply.update({ where: { id }, data: update });
    if (categoryIds !== null) {
      await transaction.quickReplyCategory.deleteMany({ where: { quickReplyId: id } });
      if (categoryIds.length) {
        await transaction.quickReplyCategory.createMany({
          data: categoryIds.map((categoryId) => ({ quickReplyId: id, categoryId })),
        });
      }
    }
    if (intentIds !== null) {
      await transaction.quickReplyIntent.deleteMany({ where: { quickReplyId: id } });
      if (intentIds.length) {
        await transaction.quickReplyIntent.createMany({
          data: intentIds.map((botIntentId) => ({ quickReplyId: id, botIntentId })),
        });
      }
    }
    const after = await transaction.quickReply.findUnique({ where: { id }, include: quickReplyInclude });
    await audit.recordAudit({
      actor, action: "QUICK_REPLY_UPDATED", entityType: "QUICK_REPLY", entityId: id,
      summary: `Alterou a resposta rápida "${after.name}" (${after.shortcut})`,
      details: { before: snapshot(existing), after: snapshot(after) },
    }, transaction);
    return after;
  });
  return serialize(quickReply);
}

async function archiveQuickReply(id, actor) {
  assertQuickReplyManager(actor);
  const existing = await ensureGlobalQuickReply(id);
  const quickReply = await prisma.$transaction(async (transaction) => {
    const archived = await transaction.quickReply.update({
      where: { id }, data: { active: false, archivedAt: new Date() }, include: quickReplyInclude,
    });
    await audit.recordAudit({
      actor, action: "QUICK_REPLY_ARCHIVED", entityType: "QUICK_REPLY", entityId: id,
      summary: `Arquivou a resposta rápida "${existing.name}" (${existing.shortcut})`,
    }, transaction);
    return archived;
  });
  return serialize(quickReply);
}

// Item 7/8/9: listagem para o seletor do composer — só o que o atendente
// pode realmente usar (ativo, disponível a atendentes, canal/setor
// compatíveis com a conversa informada).
async function listForComposer({ conversationId, search, categoryId }, viewer) {
  const conversation = await accessibleConversation(viewer, conversationId);
  if (categoryId && categoryId !== conversation.categoryId) {
    throw authorization.forbidden("O filtro informado não pertence à conversa selecionada.");
  }

  const globalWhere = { scope: "GLOBAL", active: true, archivedAt: null, availableToAgents: true };
  addAnd(globalWhere, { OR: [{ channels: { isEmpty: true } }, { channels: { has: conversation.channel } }] });
  const categoryIds = await categoryAndAncestorIds(conversation.categoryId);
  addAnd(globalWhere, categoryIds.length ? { OR: [
    { AND: [{ categories: { none: {} } }, { categoryId: null }] },
    { categories: { some: { categoryId: { in: categoryIds } } } },
    { categoryId: { in: categoryIds } },
  ] } : { AND: [{ categories: { none: {} } }, { categoryId: null }] });
  // Pessoais: só as do próprio atendente (nunca de outro usuário).
  const personalWhere = { scope: "PERSONAL", ownerUserId: viewer.id, active: true, archivedAt: null };
  if (categoryId) personalWhere.categoryId = categoryId;
  const where = { OR: [globalWhere, personalWhere] };
  if (search?.trim()) {
    const term = search.trim().slice(0, 120);
    const normalizedTerm = term.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const searchOr = [
      { name: { contains: term, mode: "insensitive" } },
      { shortcut: { contains: term, mode: "insensitive" } },
      { text: { contains: term, mode: "insensitive" } },
      { category: { is: { name: { contains: term, mode: "insensitive" } } } },
      { categories: { some: { category: { name: { contains: term, mode: "insensitive" } } } } },
    ];
    // Busca por tipo: "audio"/"áudio" ou "texto".
    if (normalizedTerm.length >= 3 && "audio".startsWith(normalizedTerm)) searchOr.push({ contentType: "AUDIO" });
    if (normalizedTerm.length >= 3 && "texto".startsWith(normalizedTerm)) searchOr.push({ contentType: "TEXT" });
    where.AND = [{ OR: searchOr }];
  }

  const [rows, favorites] = await Promise.all([
    prisma.quickReply.findMany({ where, include: quickReplyInclude, orderBy: [{ name: "asc" }] }),
    prisma.quickReplyFavorite.findMany({ where: { userId: viewer.id }, select: { quickReplyId: true } }),
  ]);
  const favoriteIds = new Set(favorites.map((row) => row.quickReplyId));

  return rows
    .map((row) => ({
      ...serialize(row, { favoritedByUserId: favoriteIds.has(row.id) }),
      availableInConversation: row.contentType !== "AUDIO" || AUDIO_CHANNELS.has(conversation.channel),
    }))
    .sort((a, b) => {
      if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
      if (a.usageCount !== b.usageCount) return b.usageCount - a.usageCount;
      return a.name.localeCompare(b.name, "pt-BR");
    });
}

async function setFavorite(quickReplyId, { conversationId, favorite }, actor) {
  const quickReply = await ensureQuickReply(quickReplyId);
  assertCanSeePersonal(quickReply, actor);
  const conversation = await accessibleConversation(actor, conversationId);
  if (!quickReply.active || quickReply.archivedAt || !quickReply.availableToAgents) {
    throw fail("Esta resposta rápida não está disponível para atendentes.");
  }
  await assertApplicableToConversation(quickReply, conversation);
  const normalizedFavorite = validateBoolean(favorite, "favorite");
  if (normalizedFavorite) {
    await prisma.quickReplyFavorite.upsert({
      where: { quickReplyId_userId: { quickReplyId, userId: actor.id } },
      update: {}, create: { quickReplyId, userId: actor.id },
    });
  } else {
    await prisma.quickReplyFavorite.deleteMany({ where: { quickReplyId, userId: actor.id } });
  }
  return { favorite: normalizedFavorite };
}

// Item 8/13/28: usar uma resposta NUNCA envia mensagem — só resolve
// variáveis e devolve o texto para o atendente revisar no composer.
// Toda validação de acesso (ativa, disponível a atendentes, canal, setor)
// acontece aqui, nunca só no frontend.
async function useQuickReply(quickReplyId, { conversationId }, actor, { source = "AGENT", preview = false } = {}) {
  const quickReply = await ensureQuickReply(quickReplyId);
  assertCanSeePersonal(quickReply, actor);
  if (!preview) {
    if (!quickReply.active || quickReply.archivedAt) throw fail("Esta resposta rápida não está mais ativa.");
    if (!quickReply.availableToAgents) throw fail("Esta resposta rápida não está disponível para atendentes.");
  }

  const conversation = preview && !conversationId ? null : await accessibleConversation(actor, conversationId);
  if (conversation) await assertApplicableToConversation(quickReply, conversation);

  // Áudio: devolve só a referência para o composer carregar o player — o
  // envio continua sendo um clique explícito do atendente em "Enviar".
  if (quickReply.contentType === "AUDIO") {
    if (!preview) {
      await prisma.quickReplyUsage.create({
        data: { quickReplyId, userId: actor?.id || null, conversationId: conversationId || null, source },
      });
    }
    const serialized = serialize(quickReply);
    return { text: "", unresolved: [], audio: serialized.audio, quickReply: serialized };
  }

  const context = conversation
    ? contextFromConversation({ conversation, agent: actor })
    : { agentName: actor?.name || null };
  const { text, unresolved } = renderTemplate(quickReply.text, context);

  if (!preview) {
    await prisma.quickReplyUsage.create({
      data: { quickReplyId, userId: actor?.id || null, conversationId: conversationId || null, source },
    });
  }

  return { text, unresolved, quickReply: serialize(quickReply) };
}

// Item 14: preview administrativo com dado fictício, nunca grava uso.
function previewQuickReplyText(text, viewer) {
  assertQuickReplyManager(viewer);
  return renderTemplate(requiredBody(text, "Texto", 4000), previewContext());
}

// Item 15/33: candidatos a sugestão para uma intenção específica —
// reutilizado pelo modo Observação (nunca envia, só anota a sugestão).
async function suggestQuickReplyForIntent(intentId) {
  if (!intentId) return null;
  const link = await prisma.quickReplyIntent.findFirst({
    where: {
      botIntentId: intentId,
      quickReply: { active: true, archivedAt: null, OR: [{ availableToBots: true }, { type: "SUGGESTED_REPLY" }] },
    },
    include: { quickReply: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return link?.quickReply || null;
}

async function listSuggestions({ intentId, conversationId }, viewer) {
  const conversation = await accessibleConversation(viewer, conversationId);
  const suggestion = await suggestQuickReplyForIntent(intentId);
  if (!suggestion) return [];
  const quickReply = await ensureQuickReply(suggestion.id);
  try { await assertApplicableToConversation(quickReply, conversation); }
  catch { return []; }
  return [suggestion];
}

// ===== Biblioteca pessoal de áudios =====

async function ensurePersonalAudio(id, actor) {
  const quickReply = await ensureQuickReply(id);
  if (quickReply.scope !== "PERSONAL" || quickReply.contentType !== "AUDIO" || quickReply.archivedAt) {
    throw fail("Resposta rápida não encontrada.", 404);
  }
  assertCanSeePersonal(quickReply, actor, { allowMaster: true });
  return quickReply;
}

async function storePersonalAudio(file, declaredDurationMs) {
  if (!file?.buffer?.length) throw fail("Grave ou selecione um áudio.");
  const audio = normalizeOutgoingAudio({ buffer: file.buffer, fileName: file.originalname, declaredDurationMs });
  const media = await storeAudio({ buffer: audio.buffer, mimeType: audio.mimeType, fileName: audio.fileName });
  return { ...media, durationMs: audio.durationMs };
}

async function createPersonalAudio(data, file, actor) {
  if (!actor?.id) throw authorization.forbidden();
  const name = requiredText(data.name, "Nome", 100);
  const shortcut = validateShortcut(data.shortcut);
  const categoryId = await validateCategoryId(data.categoryId || null);
  await assertShortcutAvailable(shortcut, null, { ownerUserId: actor.id });
  const owned = await prisma.quickReply.count({ where: { scope: "PERSONAL", ownerUserId: actor.id, archivedAt: null } });
  if (owned >= MAX_PERSONAL_QUICK_REPLIES) {
    throw fail(`Limite de ${MAX_PERSONAL_QUICK_REPLIES} respostas rápidas pessoais atingido.`);
  }
  const media = await storePersonalAudio(file, data.durationMs);
  try {
    const quickReply = await prisma.$transaction(async (transaction) => {
      const created = await transaction.quickReply.create({ data: {
        name, shortcut, text: "", categoryId, channels: [], availableToAgents: true, availableToBots: false,
        type: "QUICK_REPLY", scope: "PERSONAL", contentType: "AUDIO", ownerUserId: actor.id, createdByUserId: actor.id,
        mediaStorageKey: media.storageKey, mediaMimeType: media.mimeType, mediaFileName: media.fileName,
        mediaSize: media.size, mediaDurationMs: media.durationMs,
      } });
      await audit.recordAudit({
        actor, action: "QUICK_REPLY_CREATED", entityType: "QUICK_REPLY", entityId: created.id,
        summary: `Criou a resposta rápida pessoal de áudio "${created.name}" (${created.shortcut})`,
        details: { after: snapshot(created) },
      }, transaction);
      return transaction.quickReply.findUnique({ where: { id: created.id }, include: quickReplyInclude });
    });
    return serialize(quickReply);
  } catch (error) {
    await removeImage(media.storageKey).catch(() => {});
    throw error;
  }
}

async function updatePersonalAudio(id, data, file, actor) {
  const existing = await ensurePersonalAudio(id, actor);
  const update = {};
  if (data.name !== undefined) update.name = requiredText(data.name, "Nome", 100);
  if (data.shortcut !== undefined) {
    update.shortcut = validateShortcut(data.shortcut);
    await assertShortcutAvailable(update.shortcut, id, { ownerUserId: existing.ownerUserId });
  }
  if (data.categoryId !== undefined) update.categoryId = await validateCategoryId(data.categoryId || null);
  const media = file?.buffer?.length ? await storePersonalAudio(file, data.durationMs) : null;
  if (media) {
    Object.assign(update, {
      mediaStorageKey: media.storageKey, mediaMimeType: media.mimeType, mediaFileName: media.fileName,
      mediaSize: media.size, mediaDurationMs: media.durationMs,
    });
  }
  if (!Object.keys(update).length) throw fail("Informe ao menos um campo para atualizar.");
  let quickReply;
  try {
    quickReply = await prisma.$transaction(async (transaction) => {
      const after = await transaction.quickReply.update({ where: { id }, data: update, include: quickReplyInclude });
      await audit.recordAudit({
        actor, action: "QUICK_REPLY_UPDATED", entityType: "QUICK_REPLY", entityId: id,
        summary: `Alterou a resposta rápida pessoal de áudio "${after.name}" (${after.shortcut})${media ? " — áudio substituído" : ""}`,
        details: { before: snapshot(existing), after: snapshot(after) },
      }, transaction);
      return after;
    });
  } catch (error) {
    if (media) await removeImage(media.storageKey).catch(() => {});
    throw error;
  }
  if (media && existing.mediaStorageKey) await removeImage(existing.mediaStorageKey).catch(() => {});
  return serialize(quickReply);
}

// Exclusão real (não arquiva): é conteúdo pessoal — sai do banco e do
// storage. Mensagens já enviadas com esse áudio têm cópia própria.
async function deletePersonalAudio(id, actor) {
  const existing = await ensurePersonalAudio(id, actor);
  await prisma.$transaction(async (transaction) => {
    await transaction.quickReply.delete({ where: { id } });
    await audit.recordAudit({
      actor, action: "QUICK_REPLY_DELETED", entityType: "QUICK_REPLY", entityId: id,
      summary: `Excluiu a resposta rápida pessoal de áudio "${existing.name}" (${existing.shortcut})`,
      details: { before: snapshot(existing) },
    }, transaction);
  });
  if (existing.mediaStorageKey) await removeImage(existing.mediaStorageKey).catch(() => {});
  return { deleted: true };
}

// Arquivo do áudio: só para o dono (ou Master, administrativo).
async function getQuickReplyAudio(id, viewer) {
  const quickReply = await ensureQuickReply(id);
  if (quickReply.contentType !== "AUDIO" || !quickReply.mediaStorageKey) throw fail("Áudio não encontrado.", 404);
  assertCanSeePersonal(quickReply, viewer, { allowMaster: true });
  return { storageKey: quickReply.mediaStorageKey, mimeType: quickReply.mediaMimeType, fileName: quickReply.mediaFileName };
}

module.exports = {
  AUDIO_CHANNELS, MAX_PERSONAL_QUICK_REPLIES, createPersonalAudio, deletePersonalAudio, getQuickReplyAudio, updatePersonalAudio,
  archiveQuickReply, assertQuickReplyManager, createQuickReply, getQuickReply, listForComposer,
  listQuickReplies, listSuggestions, previewQuickReplyText, setFavorite, suggestQuickReplyForIntent,
  updateQuickReply, useQuickReply,
};
