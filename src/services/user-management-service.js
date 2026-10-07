const bcrypt = require("bcryptjs");
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const audit = require("./audit-service");
const companyService = require("./company-service");

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

// Setores liberados só podem ser de empresas às quais o usuário tem acesso
// (`companyIds` nulo = Master Global, qualquer empresa).
async function validateCategoryIds(categoryIds = [], companyIds = null) {
  if (!Array.isArray(categoryIds)) throw Object.assign(new Error("Categorias liberadas inválidas."), { statusCode: 400 });
  const ids = [...new Set(categoryIds.filter(Boolean))];
  const rows = await prisma.category.findMany({ where: { id: { in: ids }, active: true }, select: { id: true, companyId: true } });
  if (rows.length !== ids.length) throw Object.assign(new Error("Uma das categorias liberadas não existe ou está inativa."), { statusCode: 400 });
  if (companyIds && rows.some((row) => !companyIds.includes(row.companyId))) {
    throw Object.assign(new Error("Há setor liberado de uma empresa à qual o usuário não tem acesso."), { statusCode: 400 });
  }
  return ids;
}

// Permissões personalizadas numa empresa: só flags conhecidas, booleanas.
// Nulo/ausente = usa as permissões do cadastro do usuário.
function normalizeCompanyPermissions(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("Permissões por empresa inválidas."), { statusCode: 400 });
  const { PERMISSION_FLAGS } = require("./auth-service");
  const result = {};
  for (const key of PERMISSION_FLAGS) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "boolean") throw Object.assign(new Error(`Permissão "${key}" deve ser verdadeiro ou falso.`), { statusCode: 400 });
    result[key] = value[key];
  }
  return Object.keys(result).length ? result : null;
}

// Multiempresa: [{ companyId, role, active }] — role nulo = cargo padrão do
// usuário naquela empresa; Supervisor/Atendente podem variar por empresa.
// Master (role ADMIN) é global e não precisa de linhas.
async function validateCompanyAccess(value, role) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw Object.assign(new Error("Acesso por empresa inválido."), { statusCode: 400 });
  const companies = await companyService.listCompanies({ includeInactive: true });
  const seen = new Set();
  const rows = value.map((entry) => {
    const company = companies.find((item) => item.id === entry?.companyId || item.slug === entry?.companyId);
    if (!company) throw Object.assign(new Error("Empresa inválida no acesso do usuário."), { statusCode: 400 });
    if (seen.has(company.id)) throw Object.assign(new Error("Empresa repetida no acesso do usuário."), { statusCode: 400 });
    seen.add(company.id);
    return {
      companyId: company.id,
      role: companyService.normalizeCompanyRole(entry.role),
      active: entry.active === undefined ? true : Boolean(entry.active),
      permissions: normalizeCompanyPermissions(entry.permissions),
    };
  });
  if (role !== "ADMIN" && !rows.some((row) => row.active)) {
    throw Object.assign(new Error("Libere ao menos uma empresa para este usuário."), { statusCode: 400 });
  }
  return rows;
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
  categoryAccess: { include: { category: { select: { id: true, name: true, parentId: true, color: true, companyId: true } } } },
  companyAccess: {
    select: { companyId: true, role: true, active: true, permissions: true, company: { select: { id: true, name: true, slug: true, displayName: true, primaryColor: true } } },
  },
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
      companyId: category.companyId,
    })),
    companies: (user.companyAccess || []).map((entry) => ({
      companyId: entry.companyId, company: entry.company?.displayName || null, role: entry.role, active: entry.active, permissions: entry.permissions || null,
    })),
  };
}

async function listUsers() {
  return prisma.user.findMany({ where: { role: { not: "BOT" } }, select: publicSelection, orderBy: { name: "asc" } });
}

async function listTeamActivity(viewer, { company } = {}) {
  // Visão de equipe é exclusiva do Master — o flag canViewTeamActivity do
  // cadastro não libera mais nada para Supervisor/Atendente.
  if (!authorization.isMaster(viewer)) {
    throw authorization.forbidden("Somente uma conta Master pode acompanhar a equipe.");
  }
  // Multiempresa: "Equipe" filtrada por empresa — pessoas com acesso a ela e
  // carga só das conversas dela.
  const companyIds = await companyService.resolveCompanyFilter(viewer, company);
  const filtered = company && company !== companyService.ALL_COMPANIES;
  // Só contagens agregadas por responsável (nenhum conteúdo de conversa).
  const scope = { AND: [await authorization.sectorScope(viewer), ...(filtered ? [{ companyId: { in: companyIds } }] : [])] };
  const [users, assigned] = await Promise.all([
    prisma.user.findMany({
      where: {
        active: true, role: { not: "BOT" },
        ...(filtered ? { OR: [{ role: "ADMIN" }, { companyAccess: { some: { companyId: { in: companyIds }, active: true } } }] } : {}),
      },
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
  const companyAccess = (await validateCompanyAccess(data.companyAccess, role)) ?? (role === "ADMIN" ? [] : await validateCompanyAccess([], role));
  const categoryIds = await validateCategoryIds(data.categoryIds, role === "ADMIN" ? null : companyAccess.filter((row) => row.active).map((row) => row.companyId));
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    return await prisma.$transaction(async (transaction) => {
      const user = await transaction.user.create({
        data: {
          name, email, role, passwordHash, ...permissionData(data),
          categoryAccess: { create: categoryIds.map((categoryId) => ({ categoryId })) },
          companyAccess: { create: companyAccess.map((row) => ({ ...row, permissions: row.permissions ?? undefined })) },
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
  const effectiveRole = update.role || existing.role;
  const companyAccess = await validateCompanyAccess(data.companyAccess, effectiveRole);
  const activeCompanyIds = (companyAccess || existing.companyAccess).filter((row) => row.active).map((row) => row.companyId);
  if (effectiveRole !== "ADMIN" && companyAccess === undefined && !activeCompanyIds.length) {
    throw Object.assign(new Error("Libere ao menos uma empresa para este usuário."), { statusCode: 400 });
  }
  const categoryIds = data.categoryIds === undefined ? null
    : await validateCategoryIds(data.categoryIds, effectiveRole === "ADMIN" ? null : activeCompanyIds);
  // Perder acesso a uma empresa ou trocar de cargo nela muda o que a pessoa
  // vê — derruba as sessões abertas para valer imediatamente.
  if (companyAccess !== undefined) update.sessionVersion = { increment: 1 };
  try {
    return await prisma.$transaction(async (transaction) => {
      if (companyAccess !== undefined) {
        // As empresas desativadas não aparecem no formulário. Preserva seus
        // vínculos para que reativar restaure exatamente as permissões antigas.
        const submittedIds = companyAccess.map((row) => row.companyId);
        await transaction.userCompanyAccess.deleteMany({ where: { userId: id, OR: [{ company: { is: { active: true } } }, { companyId: { in: submittedIds } }] } });
        if (companyAccess.length) await transaction.userCompanyAccess.createMany({ data: companyAccess.map((row) => ({ ...row, permissions: row.permissions ?? undefined, userId: id })) });
      }
      if (categoryIds) {
        await transaction.userCategoryAccess.deleteMany({ where: { userId: id, OR: [{ category: { is: { company: { is: { active: true } } } } }, { categoryId: { in: categoryIds } }] } });
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
