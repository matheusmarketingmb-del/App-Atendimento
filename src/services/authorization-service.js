const prisma = require("../database/prisma");
const companyService = require("./company-service");
const privateSegments = require("./private-segment-service");

const isMaster = (user) => user?.role === "ADMIN";

// Escopo que nunca casa com nada (usuário sem nenhuma empresa liberada).
const NO_ACCESS = Object.freeze({ id: { in: [] } });

function forbidden(message = "Você não possui permissão para esta ação.") {
  return Object.assign(new Error(message), { statusCode: 403 });
}

// Setores liberados — só de empresas às quais o usuário ainda tem acesso
// (perder o acesso à empresa derruba junto os setores dela).
async function allowedCategoryIds(user) {
  if (isMaster(user)) return null;
  const companyIds = await companyService.accessibleCompanyIds(user);
  if (!companyIds.length) return [];
  const access = await prisma.userCategoryAccess.findMany({
    where: { userId: user.id, category: { is: { companyId: { in: companyIds } } } },
    select: { categoryId: true },
  });
  return access.map(({ categoryId }) => categoryId);
}

function emailAccountScope(user) {
  return {
    OR: [
      { channel: { not: "EMAIL" } },
      { channelAccount: { is: { accessUsers: { some: { userId: user.id } } } } },
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

// Setor privado (Financeiro): membros do setor acompanham as conversas que
// estão NELE agora, mesmo assumidas por outro membro (Emily vê a conversa
// que a Ana assumiu) — mesma ideia do Supervisor na área dele. Só o setor
// atual: conversa que saiu do Financeiro volta às regras normais (o
// histórico privado dela continua legível para o membro, ver
// private-segment-service).
async function privateSectorCategoryIds(user) {
  const roots = await privateSegments.readablePrivateCategoryIds(user);
  if (!roots?.length) return [];
  const children = await prisma.category.findMany({ where: { parentId: { in: roots } }, select: { id: true } });
  return [...roots, ...children.map(({ id }) => id)];
}

// Privacidade de conversa assumida: enquanto a conversa não tem responsável
// ela fica na fila do setor (categorias liberadas / Sem categoria); depois
// que alguém assume, só o responsável atual (e o Master) enxerga. Este é o
// escopo único usado por listagem, detalhe, mensagens, anexos, envio, busca,
// alertas e contadores — a regra nunca é só visual.
// Exceção: o Supervisor acompanha as áreas que gerencia (categorias
// liberadas), então vê também as conversas já assumidas por outros nelas.
// Multiempresa: a regra acima é aplicada POR EMPRESA, com o cargo que o
// usuário tem naquela empresa (Ana pode ser Supervisor na Mibro e Atendente
// na Sincrofit). Empresa sem acesso nunca entra no OR — vale também para
// busca por ID direto (IDOR): a conversa simplesmente não é encontrada.
async function conversationScope(user) {
  if (isMaster(user)) return {};
  const access = await companyService.companyAccess(user);
  if (!access.length) return NO_ACCESS;
  const categoryIds = await allowedCategoryIds(user);
  const privateSectorIds = await privateSectorCategoryIds(user);
  const branches = access.map(({ companyId, role, permissions }) => {
    // "Sem categoria" pode ser liberado por empresa (permissões da empresa).
    const uncategorized = permissions && typeof permissions.canViewUncategorized === "boolean"
      ? permissions.canViewUncategorized : Boolean(user.canViewUncategorized);
    const queue = [];
    if (categoryIds.length) queue.push({ categoryId: { in: categoryIds } });
    if (uncategorized) queue.push({ categoryId: null });
    const visible = [{ assignedUserId: user.id }];
    if (role === "SUPERVISOR") visible.push(...queue);
    else if (queue.length) visible.push({ AND: [{ assignedUserId: null }, { OR: queue }] });
    if (privateSectorIds.length) visible.push({ categoryId: { in: privateSectorIds } });
    return { AND: [{ companyId }, { OR: visible }] };
  });
  return { AND: [{ OR: branches }, emailAccountScope(user)] };
}

// Escopo por setor (regra anterior à privacidade): inclui conversas já
// assumidas por outros atendentes do setor. Nunca é usado para entregar
// conteúdo — só para métricas agregadas (atividade da equipe) e para dizer
// "em atendimento por Fulano" a quem é do setor. Também restrito às
// empresas acessíveis.
async function sectorScope(user) {
  if (isMaster(user)) return {};
  const companyIds = await companyService.accessibleCompanyIds(user);
  if (!companyIds.length) return NO_ACCESS;
  const queue = await queueCategoryFilters(user);
  const visible = [{ assignedUserId: user.id }, ...queue];
  return { AND: [{ companyId: { in: companyIds } }, { OR: visible }, emailAccountScope(user)] };
}

async function canAccessCategory(user, categoryId) {
  if (isMaster(user)) return true;
  if (!categoryId) return Boolean(user.canViewUncategorized);
  return (await allowedCategoryIds(user)).includes(categoryId);
}

// Permissão avaliada com o cargo/permissões do usuário NA EMPRESA do recurso.
// Sem acesso à empresa => 404 (não revela o recurso).
async function forCompany(user, companyId) {
  const scoped = await companyService.userForCompany(user, companyId);
  if (!scoped) throw Object.assign(new Error("Recurso não encontrado."), { statusCode: 404 });
  return scoped;
}

// Escopo Prisma para recursos com coluna companyId (Contact, Category, Bot,
// Campaign…): Master Global vê tudo; demais só empresas liberadas.
async function companyScope(user) {
  if (isMaster(user)) return {};
  const companyIds = await companyService.accessibleCompanyIds(user);
  return companyIds.length ? { companyId: { in: companyIds } } : NO_ACCESS;
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

async function assertCanAccessContact(user, contactId) {
  const scope = await conversationScope(user);
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
  return isMaster(user) || user?.role === "SUPERVISOR" || Boolean(user?.canManageCampaigns);
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
  allowedCategoryIds, assertCanAccessContact, assertCanManageCampaigns, assertCanManageCategories, assertCanMergeContacts, assertCanStartConversations,
  assertCanSetPriority, assertCanViewConversation, assertCanViewConversationSettings, assertMaster,
  canAccessCategory, canManageCampaigns, canMergeContacts, canSetPriority, canStartConversations, canTransfer, canViewConversationSettings,
  companyScope, conversationAccessError, conversationScope, forCompany, forbidden, isMaster, sectorScope,
};
