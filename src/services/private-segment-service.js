// Setor privado (ex.: Financeiro) — histórico protegido por segmento.
//
// Regra: enquanto a conversa está num setor principal com visibilityMode =
// SECTOR_PRIVATE (e não está FINALIZADO), toda Message/ConversationActivity/
// ContactNote criada nasce carimbada com privateCategoryId = esse setor
// (database/prisma.js aplica o carimbo em qualquer caminho de criação).
// Nada é apagado nem duplicado: o carimbo só muda quem LÊ.
//
// Quem lê um segmento privado:
//   1. Master (ADMIN) — sempre, sem consulta.
//   2. Membros do setor: UserCategoryAccess no setor principal ou em
//      qualquer subcategoria dele, numa empresa que o usuário ainda acessa
//      (configuração central em Equipe — nunca nomes no código).
// Atendente fixo, responsável atual ou participação anterior NÃO dão acesso
// a segmento privado de outro setor.
const companyService = require("./company-service");

const PRIVATE = "SECTOR_PRIVATE";

function isMaster(user) {
  return user?.role === "ADMIN";
}

// Setor principal privado de uma categoria (ou null). Subcategoria herda do
// pai — o flag só é lido no setor principal.
async function privateRootFor(categoryId, client) {
  if (!categoryId) return null;
  const category = await client.category.findUnique({
    where: { id: categoryId },
    select: { id: true, visibilityMode: true, parent: { select: { id: true, visibilityMode: true } } },
  });
  if (!category) return null;
  const root = category.parent || category;
  return root.visibilityMode === PRIVATE ? root.id : null;
}

// Mesma regra para uma categoria já carregada com `parent` (sem consulta).
function privateRootOf(category) {
  if (!category) return null;
  const root = category.parent || category;
  return root.visibilityMode === PRIVATE ? root.id : null;
}

// Carimbo para um registro novo da conversa: setor privado em vigor agora,
// ou null. Conversa finalizada encerra o segmento — a mensagem que reabre
// um atendimento novo segue as regras normais.
async function stampForConversation(conversationId, client) {
  if (!conversationId) return null;
  const conversation = await client.conversation.findUnique({
    where: { id: conversationId }, select: { categoryId: true, status: true },
  });
  if (!conversation || conversation.status === "FINALIZADO") return null;
  return privateRootFor(conversation.categoryId, client);
}

// Setores privados que o usuário pode ler. null = todos (Master). Cacheado
// no próprio objeto do usuário da requisição (mesmo padrão de
// company-service.companyAccess).
async function readablePrivateCategoryIds(user, client = require("../database/prisma")) {
  if (isMaster(user)) return null;
  if (!user?.id) return [];
  if (Array.isArray(user.privateCategoryIds)) return user.privateCategoryIds;
  const companyIds = await companyService.accessibleCompanyIds(user);
  let ids = [];
  if (companyIds.length) {
    const access = await client.userCategoryAccess.findMany({
      where: { userId: user.id, category: { is: { companyId: { in: companyIds } } } },
      select: { category: { select: { id: true, visibilityMode: true, parent: { select: { id: true, visibilityMode: true } } } } },
    });
    ids = [...new Set(access.map(({ category }) => category.parent || category)
      .filter((root) => root.visibilityMode === PRIVATE).map((root) => root.id))];
  }
  Object.defineProperty(user, "privateCategoryIds", { value: ids, enumerable: false, configurable: true, writable: true });
  return ids;
}

// Filtro Prisma "registro legível" para Message/ConversationActivity/
// ContactNote. Master = sem filtro.
function readableWhere(privateCategoryIds) {
  if (privateCategoryIds === null) return {};
  if (!privateCategoryIds.length) return { privateCategoryId: null };
  return { OR: [{ privateCategoryId: null }, { privateCategoryId: { in: privateCategoryIds } }] };
}

async function readableWhereFor(user) {
  return readableWhere(await readablePrivateCategoryIds(user));
}

function canRead(privateCategoryIds, privateCategoryId) {
  if (!privateCategoryId || privateCategoryIds === null) return true;
  return privateCategoryIds.includes(privateCategoryId);
}

async function canReadRecord(user, record) {
  return canRead(await readablePrivateCategoryIds(user), record?.privateCategoryId || null);
}

// Linha do tempo para quem não pode ler um segmento: cada sequência
// contínua de mensagens ocultas vira UM bloco, sem texto, autor, mídia nem
// contagem — só o nome do setor e o horário de início (para ordenar).
function collapseRestricted(messages, privateCategoryIds, categoryNames) {
  const timeline = [];
  for (const message of messages) {
    if (canRead(privateCategoryIds, message.privateCategoryId)) { timeline.push(message); continue; }
    const last = timeline[timeline.length - 1];
    if (last?.restricted && last.privateCategoryId === message.privateCategoryId) continue;
    timeline.push({
      id: `restricted:${message.id}`, restricted: true, type: "restricted_segment",
      privateCategoryId: message.privateCategoryId,
      categoryName: categoryNames.get(message.privateCategoryId) || "Setor restrito",
      occurredAt: message.occurredAt,
    });
  }
  return timeline;
}

// Evento de segmento que o usuário não pode ler: mantém o registro
// estrutural (entrou/saiu/transferiu/status — item 17) sem campos com
// conteúdo (motivo, resumo de handoff, prévia de nota).
const STRUCTURAL_ACTIONS = new Set([
  "CATEGORY_CHANGED", "CONVERSATION_TRANSFERRED", "CONVERSATION_CLAIMED", "ASSIGNEE_REMOVED", "STATUS_CHANGED",
  "PRIORITY_CHANGED", "PRIVATE_SEGMENT_STARTED", "PRIVATE_SEGMENT_ENDED", "REOPENED_BY_CUSTOMER_MESSAGE",
]);
const SENSITIVE_DETAIL_KEYS = ["reason", "handoffSummary", "preview", "summary", "text"];

function sanitizeActivities(activities, privateCategoryIds) {
  return activities.flatMap((activity) => {
    if (canRead(privateCategoryIds, activity.privateCategoryId)) return [activity];
    if (!STRUCTURAL_ACTIONS.has(activity.action)) return [];
    const details = activity.details && typeof activity.details === "object" ? { ...activity.details } : activity.details;
    if (details && typeof details === "object") for (const key of SENSITIVE_DETAIL_KEYS) delete details[key];
    return [{ ...activity, details, restricted: true }];
  });
}

module.exports = {
  PRIVATE, canRead, canReadRecord, collapseRestricted, privateRootFor, privateRootOf, readablePrivateCategoryIds, readableWhere,
  readableWhereFor, sanitizeActivities, stampForConversation,
};
