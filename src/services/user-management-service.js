const bcrypt = require("bcryptjs");
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const audit = require("./audit-service");

const manageableRoles = new Set(["ADMIN", "SUPERVISOR", "ATENDENTE"]);
const booleanPermissions = [
  "canViewUncategorized", "canManageCategories", "canTransferConversations", "canViewTeamActivity",
  "canViewConversationHistory",
  "canViewPreviousMessages",
  // Prioridade manual de conversa (item 16 do pedido de SLA/prioridade):
  // Admin/Supervisor sempre podem (authorization.canSetPriority), este flag
  // libera um Atendente específico sem mudar o cargo.
  "canSetConversationPriority",
  "canStartConversations",
  "canMergeContacts",
  "canManageCampaigns",
];

function validateName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw Object.assign(new Error("Nome é obrigatório."), { statusCode: 400 });
  if (name.length > 100) throw Object.assign(new Error("O nome deve ter no máximo 100 caracteres."), { statusCode: 400 });
  return name;
}

function validateEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^\S+@\S+\.\S+$/.test(email)) throw Object.assign(new Error("E-mail inválido."), { statusCode: 400 });
  return email;
}

function validateRole(value) {
  if (!manageableRoles.has(value)) throw Object.assign(new Error("Perfil de acesso inválido."), { statusCode: 400 });
  return value;
}

function validatePassword(value, required = false) {
  if (!value && !required) return null;
  if (typeof value !== "string" || value.length < 8) {
    throw Object.assign(new Error("A senha deve ter ao menos 8 caracteres."), { statusCode: 400 });
  }
  return value;
}

async function validateCategoryIds(categoryIds = []) {
  if (!Array.isArray(categoryIds)) throw Object.assign(new Error("Categorias liberadas inválidas."), { statusCode: 400 });
  const ids = [...new Set(categoryIds.filter(Boolean))];
  const count = await prisma.category.count({ where: { id: { in: ids }, active: true } });
  if (count !== ids.length) throw Object.assign(new Error("Uma das categorias liberadas não existe ou está inativa."), { statusCode: 400 });
  return ids;
}

function permissionData(data) {
  return Object.fromEntries(booleanPermissions.filter((key) => typeof data[key] === "boolean").map((key) => [key, data[key]]));
}

const publicSelection = {
  id: true, name: true, email: true, role: true, active: true, createdAt: true, updatedAt: true,
  canViewUncategorized: true, canManageCategories: true,
  canTransferConversations: true, canViewTeamActivity: true,
  canViewConversationHistory: true,
  canViewPreviousMessages: true,
  canSetConversationPriority: true,
  canStartConversations: true,
  canMergeContacts: true,
  // Prisma select: inclui o valor salvo na resposta; não concede permissão.
  canManageCampaigns: true,
  categoryAccess: { include: { category: { select: { id: true, name: true, parentId: true, color: true } } } },
  _count: { select: { assignedConversations: true, sentMessages: true } },
};

function accessSnapshot(user) {
  return {
    name: user.name,
    email: user.email,
    role: user.role,
    active: user.active,
    permissions: Object.fromEntries(booleanPermissions.map((key) => [key, Boolean(user[key])])),
    categories: (user.categoryAccess || []).map(({ category }) => ({
      id: category.id,
      name: category.name,
      parentId: category.parentId,
    })),
  };
}

async function listUsers() {
  return prisma.user.findMany({ where: { role: { not: "BOT" } }, select: publicSelection, orderBy: { name: "asc" } });
}

async function listTeamActivity(viewer) {
  if (!authorization.isMaster(viewer) && !viewer.canViewTeamActivity) {
    throw authorization.forbidden("Você não pode acompanhar a atividade da equipe.");
  }
  // Só contagens agregadas por responsável (nenhum conteúdo de conversa):
  // usa o escopo por setor para o supervisor continuar acompanhando a carga
  // da equipe mesmo sem acesso às conversas assumidas por outros.
  const scope = await authorization.sectorScope(viewer);
  const [users, assigned] = await Promise.all([
    prisma.user.findMany({
      where: { active: true, role: { not: "BOT" } },
      select: { id: true, name: true, role: true, active: true }, orderBy: { name: "asc" },
    }),
    prisma.conversation.groupBy({
      by: ["assignedUserId"], where: { AND: [{ assignedUserId: { not: null } }, scope] }, _count: { _all: true },
    }),
  ]);
  const counts = new Map(assigned.map((item) => [item.assignedUserId, item._count._all]));
  return users.map((user) => ({
    ...user, categoryAccess: [], _count: { assignedConversations: counts.get(user.id) || 0, sentMessages: 0 },
  }));
}

async function createUser(data, actor) {
  const name = validateName(data.name);
  const email = validateEmail(data.email);
  const role = validateRole(data.role || "ATENDENTE");
  const password = validatePassword(data.password, true);
  const categoryIds = await validateCategoryIds(data.categoryIds);
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    return await prisma.$transaction(async (transaction) => {
      const user = await transaction.user.create({
        data: {
          name, email, role, passwordHash, ...permissionData(data),
          categoryAccess: { create: categoryIds.map((categoryId) => ({ categoryId })) },
        },
        select: publicSelection,
      });
      await audit.recordAudit({
        actor,
        action: "USER_CREATED",
        entityType: "USER",
        entityId: user.id,
        summary: `Criou a conta ${user.name} (${user.email})`,
        details: { access: accessSnapshot(user) },
      }, transaction);
      return user;
    });
  } catch (error) {
    if (error.code === "P2002") throw Object.assign(new Error("Já existe uma conta com este e-mail."), { statusCode: 409 });
    throw error;
  }
}

async function updateUser(id, data, currentMasterId, actor) {
  const existing = await prisma.user.findUnique({ where: { id }, select: publicSelection });
  if (!existing || existing.role === "BOT") throw Object.assign(new Error("Usuário não encontrado."), { statusCode: 404 });
  const update = {};
  if (data.name !== undefined) update.name = validateName(data.name);
  if (data.email !== undefined) update.email = validateEmail(data.email);
  if (data.role !== undefined) update.role = validateRole(data.role);
  if (typeof data.active === "boolean") update.active = data.active;
  Object.assign(update, permissionData(data));
  const password = validatePassword(data.password);
  if (password) {
    update.passwordHash = await bcrypt.hash(password, 12);
    update.sessionVersion = { increment: 1 };
  }
  const removesMaster = existing.role === "ADMIN" && (update.role && update.role !== "ADMIN" || update.active === false);
  if (removesMaster) {
    const otherMasters = await prisma.user.count({ where: { id: { not: id }, role: "ADMIN", active: true } });
    if (!otherMasters) throw Object.assign(new Error("A central precisa manter ao menos uma conta Master ativa."), { statusCode: 400 });
  }
  if (id === currentMasterId && update.active === false) {
    throw Object.assign(new Error("Você não pode desativar sua própria conta durante a sessão."), { statusCode: 400 });
  }
  const categoryIds = data.categoryIds === undefined ? null : await validateCategoryIds(data.categoryIds);
  try {
    return await prisma.$transaction(async (transaction) => {
      if (categoryIds) {
        await transaction.userCategoryAccess.deleteMany({ where: { userId: id } });
        if (categoryIds.length) await transaction.userCategoryAccess.createMany({ data: categoryIds.map((categoryId) => ({ userId: id, categoryId })) });
      }
      const user = await transaction.user.update({ where: { id }, data: update, select: publicSelection });
      await audit.recordAudit({
        actor,
        action: "USER_UPDATED",
        entityType: "USER",
        entityId: user.id,
        summary: `Alterou a conta ${user.name} (${user.email})`,
        details: {
          before: accessSnapshot(existing),
          after: accessSnapshot(user),
          passwordChanged: Boolean(password),
        },
      }, transaction);
      return user;
    });
  } catch (error) {
    if (error.code === "P2002") throw Object.assign(new Error("Já existe uma conta com este e-mail."), { statusCode: 409 });
    throw error;
  }
}

module.exports = { createUser, listTeamActivity, listUsers, updateUser };
