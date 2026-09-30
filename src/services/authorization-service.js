const prisma = require("../database/prisma");

const isMaster = (user) => user?.role === "ADMIN";

function forbidden(message = "Você não possui permissão para esta ação.") {
  return Object.assign(new Error(message), { statusCode: 403 });
}

async function allowedCategoryIds(user) {
  if (isMaster(user)) return null;
  const access = await prisma.userCategoryAccess.findMany({
    where: {
      userId: user.id,
      category: { is: {
        masterOnly: false,
        OR: [{ parentId: null }, { parent: { is: { masterOnly: false } } }],
      } },
    },
    select: { categoryId: true },
  });
  return access.map(({ categoryId }) => categoryId);
}

function channelAccountScope(user) {
  return {
    OR: [
      { channelAccountId: null },
      { channel: { notIn: ["EMAIL", "META"] } },
      { channelAccount: { is: { accessUsers: { some: { userId: user.id } } } } },
    ],
  };
}

function publicCategoryScope() {
  return {
    OR: [
      { categoryId: null },
      { category: { is: {
        masterOnly: false,
        OR: [{ parentId: null }, { parent: { is: { masterOnly: false } } }],
      } } },
    ],
  };
}

async function queueCategoryFilters(user) {
  const categoryIds = await allowedCategoryIds(user);
  const filters = [];
  if (categoryIds.length) filters.push({ categoryId: { in: categoryIds } });
  if (user.canViewUncategorized) filters.push({ categoryId: null });
  return filters;
}

// Privacidade de conversa assumida: enquanto a conversa não tem responsável
// ela fica na fila do setor (categorias liberadas / Sem categoria); depois
// que alguém assume, só o responsável atual (e o Master) enxerga.
//
// Escopo OPERACIONAL: onde o usuário pode AGIR (responder, assumir,
// transferir, finalizar, notas). Vale igual para Atendente e Supervisor.
async function operationalScope(user) {
  if (isMaster(user)) return {};
  const queue = await queueCategoryFilters(user);
  const visible = [{ assignedUserId: user.id }];
  if (queue.length) visible.push({ AND: [{ assignedUserId: null }, { OR: queue }] });
  return { AND: [{ OR: visible }, publicCategoryScope(), channelAccountScope(user)] };
}

// Equipe de supervisão (definida pelo Master) + o próprio Supervisor — para
// que ele também consulte os trechos que ele mesmo atendeu.
async function supervisedUserIds(user) {
  if (user?.role !== "SUPERVISOR") return [];
  const members = await prisma.supervisorTeamMember.findMany({ where: { supervisorId: user.id }, select: { memberId: true } });
  return [user.id, ...members.map(({ memberId }) => memberId)];
}

// Supervisão: conversas cujo responsável atual é da equipe OU pelas quais
// alguém da equipe já passou (histórico de períodos). Nunca global, nunca
// categorias exclusivas do Master. O conteúdo visível é recortado depois
// aos trechos da equipe (inbox-service#readVisibility).
function supervisionScopeFor(userIds) {
  return {
    AND: [publicCategoryScope(), { OR: [
      { assignedUserId: { in: userIds } },
      { assignmentPeriods: { some: { userId: { in: userIds } } } },
    ] }],
  };
}

// Escopo de LEITURA — o único usado por listagem, detalhe, mensagens,
// anexos, busca e contadores (a regra nunca é só visual). Master vê tudo;
// Atendente vê o operacional; Supervisor vê o operacional + a supervisão
// da equipe (somente leitura).
async function conversationScope(user) {
  if (isMaster(user)) return {};
  const operational = await operationalScope(user);
  if (user?.role !== "SUPERVISOR") return operational;
  return { OR: [operational, supervisionScopeFor(await supervisedUserIds(user))] };
}

// Inclui conversas assumidas por outros atendentes somente para métricas
// agregadas e para informar quem já está atendendo.
async function sectorScope(user) {
  if (isMaster(user)) return {};
  const queue = await queueCategoryFilters(user);
  const visible = [{ assignedUserId: user.id }, ...queue];
  return { AND: [{ OR: visible }, publicCategoryScope(), channelAccountScope(user)] };
}

async function canAccessChannelAccount(user, channelAccountId) {
  if (isMaster(user) || !channelAccountId) return true;
  return Boolean(await prisma.channelAccountUserAccess.findUnique({
    where: { channelAccountId_userId: { channelAccountId, userId: user.id } },
    select: { userId: true },
  }));
}

async function assertChannelAccountAllowsCategory(channelAccountId, categoryId) {
  if (!channelAccountId || !categoryId) return;
  const account = await prisma.channelAccount.findUnique({ where: { id: channelAccountId }, select: { config: true } });
  const allowed = Array.isArray(account?.config?.allowedCategoryIds) ? account.config.allowedCategoryIds : [];
  if (!allowed.length || allowed.includes(categoryId)) return;
  const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { parentId: true } });
  if (!category?.parentId || !allowed.includes(category.parentId)) {
    throw forbidden("Esta conta não está liberada para a categoria selecionada.");
  }
}

async function canAccessCategory(user, categoryId) {
  if (isMaster(user)) return true;
  if (!categoryId) return Boolean(user.canViewUncategorized);
  return (await allowedCategoryIds(user)).includes(categoryId);
}

// 403 "em atendimento por Fulano" para quem é do setor e perdeu acesso
// porque outro atendente assumiu; 404 para qualquer outro caso (não revela
// nem a existência da conversa a quem nunca poderia vê-la).
async function conversationAccessError(user, conversationId) {
  if (user && !isMaster(user)) {
    const locked = await prisma.conversation.findFirst({
      where: { AND: [{ id: conversationId }, { assignedUserId: { not: null } }, await sectorScope(user)] },
      select: { assignedUser: { select: { name: true } } },
    });
    if (locked) {
      return Object.assign(
        new Error(`Conversa em atendimento por ${locked.assignedUser?.name || "outro atendente"}.`),
        { statusCode: 403, code: "CONVERSATION_ASSIGNED_TO_OTHER" },
      );
    }
  }
  return Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
}

async function assertCanViewConversation(user, conversationId) {
  const scope = await conversationScope(user);
  const conversation = await prisma.conversation.findFirst({
    where: { AND: [{ id: conversationId }, scope] },
    select: { id: true, categoryId: true, assignedUserId: true, contactId: true },
  });
  if (!conversation) throw await conversationAccessError(user, conversationId);
  return conversation;
}

async function canActOnConversation(user, conversationId) {
  if (isMaster(user)) return true;
  return Boolean(await prisma.conversation.findFirst({
    where: { AND: [{ id: conversationId }, await operationalScope(user)] }, select: { id: true },
  }));
}

// Ações (responder, assumir, transferir, finalizar, notas…). O acesso de
// supervisão é somente leitura: nunca torna o Supervisor responsável.
async function assertCanActOnConversation(user, conversationId) {
  const scope = await operationalScope(user);
  const conversation = await prisma.conversation.findFirst({
    where: { AND: [{ id: conversationId }, scope] },
    select: { id: true, categoryId: true, assignedUserId: true, contactId: true },
  });
  if (conversation) return conversation;
  const readable = await prisma.conversation.findFirst({
    where: { AND: [{ id: conversationId }, await conversationScope(user)] }, select: { id: true },
  });
  if (readable) {
    throw Object.assign(new Error("Acesso de supervisão é somente leitura: você pode acompanhar, mas não responder ou alterar esta conversa."), {
      statusCode: 403, code: "SUPERVISION_READ_ONLY",
    });
  }
  throw await conversationAccessError(user, conversationId);
}

async function assertCanAccessContact(user, contactId, { act = false } = {}) {
  const scope = act ? await operationalScope(user) : await conversationScope(user);
  const conversation = await prisma.conversation.findFirst({
    where: { AND: [{ contactId }, scope] }, select: { id: true },
  });
  if (!conversation) throw forbidden("Você não tem acesso a este contato.");
}

function assertMaster(user) {
  if (!isMaster(user)) throw forbidden("Somente uma conta Master pode gerenciar usuários.");
}

function assertCanManageCategories(user) {
  if (!isMaster(user) && !user?.canManageCategories) throw forbidden("Você não pode gerenciar categorias.");
}

function canTransfer(user) {
  return isMaster(user) || Boolean(user?.canTransferConversations);
}

// Prioridade manual de conversa (item 16 — RBAC do pedido de SLA/
// prioridade): Admin/Supervisor sempre podem; Atendente só com o flag
// explícito, mesmo padrão de canManageCampaigns/canTransfer acima.
function canSetPriority(user) {
  return isMaster(user) || user?.role === "SUPERVISOR" || Boolean(user?.canSetConversationPriority);
}

function assertCanSetPriority(user) {
  if (!canSetPriority(user)) throw forbidden("Você não pode alterar a prioridade desta conversa.");
}

// Campanhas/prospecção (item 27): Admin e Supervisor por padrão; Atendente
// só com o flag explícito canManageCampaigns.
function canStartConversations(user) {
  return isMaster(user) || Boolean(user?.canStartConversations);
}

function assertCanStartConversations(user) {
  if (!canStartConversations(user)) throw forbidden("Você não tem permissão para iniciar conversas.");
}

function canMergeContacts(user) {
  return isMaster(user) || Boolean(user?.canMergeContacts);
}

function assertCanMergeContacts(user) {
  if (!canMergeContacts(user)) throw forbidden("Você não tem permissão para fundir contatos.");
}

function canManageCampaigns(user) {
  return isMaster(user) || Boolean(user?.canManageCampaigns);
}

function assertCanManageCampaigns(user) {
  if (!canManageCampaigns(user)) throw forbidden("Você não tem permissão para gerenciar campanhas.");
}

// Configurações → Conversas: Admin edita (via assertMaster), Supervisor só
// visualiza — mesma régua de "edição de alto risco não delegável" usada em
// Campanhas/Bots, mas com leitura liberada para Supervisor acompanhar SLAs.
function canViewConversationSettings(user) {
  return isMaster(user) || user?.role === "SUPERVISOR";
}

function assertCanViewConversationSettings(user) {
  if (!canViewConversationSettings(user)) {
    throw forbidden("Você não pode visualizar as configurações de Conversas.");
  }
}

module.exports = {
  assertCanActOnConversation, canActOnConversation, operationalScope, supervisedUserIds, supervisionScopeFor,
  allowedCategoryIds, assertCanAccessContact, assertCanManageCampaigns, assertCanManageCategories, assertCanMergeContacts, assertCanStartConversations,
  assertCanSetPriority, assertCanViewConversation, assertCanViewConversationSettings, assertMaster,
  assertChannelAccountAllowsCategory, canAccessCategory, canAccessChannelAccount, canManageCampaigns, canMergeContacts, canSetPriority, canStartConversations, canTransfer, canViewConversationSettings,
  conversationAccessError, conversationScope, forbidden, isMaster, sectorScope,
};
