// Multiempresa: fonte única de "quais empresas existem", "a quais o usuário
// tem acesso" e "com qual cargo". Toda regra de autorização por empresa passa
// por aqui — o frontend só recebe o resultado, nunca decide sozinho.
//
// Regras:
// - Master Global = User.role ADMIN: acesso a todas as empresas ativas.
// - Demais: só empresas com UserCompanyAccess ativo; cargo na empresa =
//   UserCompanyAccess.role, ou User.role quando nulo ("cargo padrão").
// - Cargo por empresa nunca é ADMIN: Master é sempre global (ver
//   normalizeCompanyRole).
const prisma = require("../database/prisma");

const ALL_COMPANIES = "ALL";
const COMPANY_ROLES = Object.freeze(["SUPERVISOR", "ATENDENTE"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;
const CACHE_TTL_MS = 30 * 1000;

let companyCache = { loadedAt: 0, list: null };

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function invalidateCompanyCache() {
  companyCache = { loadedAt: 0, list: null };
}

async function listCompanies({ includeInactive = false } = {}) {
  if (!companyCache.list || Date.now() - companyCache.loadedAt > CACHE_TTL_MS) {
    companyCache = {
      loadedAt: Date.now(),
      list: await prisma.company.findMany({ orderBy: [{ displayOrder: "asc" }, { name: "asc" }] }),
    };
  }
  return includeInactive ? companyCache.list : companyCache.list.filter((company) => company.active);
}

function publicCompany(company) {
  if (!company) return null;
  return {
    id: company.id, name: company.name, slug: company.slug, displayName: company.displayName,
    primaryColor: company.primaryColor, logoUrl: company.logoUrl || null, active: company.active,
  };
}

async function getCompany(id) {
  if (!id) return null;
  return (await listCompanies({ includeInactive: true })).find((company) => company.id === id) || null;
}

async function getCompanyBySlug(slug) {
  if (!slug) return null;
  return (await listCompanies({ includeInactive: true })).find((company) => company.slug === slug) || null;
}

const isGlobalMaster = (user) => user?.role === "ADMIN";

// Empresas acessíveis + cargo efetivo em cada uma. Cacheado no próprio
// objeto do usuário da requisição (req.user) para não repetir a consulta em
// cada verificação da mesma requisição.
async function companyAccess(user) {
  if (!user?.id) return [];
  if (Array.isArray(user.companyAccess)) return user.companyAccess;
  let access;
  if (isGlobalMaster(user)) {
    access = (await listCompanies()).map((company) => ({ companyId: company.id, role: "ADMIN", company: publicCompany(company) }));
  } else {
    const rows = await prisma.userCompanyAccess.findMany({
      where: { userId: user.id, active: true, company: { is: { active: true } } },
      include: { company: true },
      orderBy: { company: { displayOrder: "asc" } },
    });
    access = rows.map((row) => ({
      companyId: row.companyId, role: row.role || user.role, company: publicCompany(row.company),
      permissions: row.permissions && typeof row.permissions === "object" ? row.permissions : null,
    }));
  }
  Object.defineProperty(user, "companyAccess", { value: access, enumerable: false, configurable: true, writable: true });
  return access;
}

async function accessibleCompanyIds(user) {
  return (await companyAccess(user)).map(({ companyId }) => companyId);
}

async function roleInCompany(user, companyId) {
  return (await companyAccess(user)).find((entry) => entry.companyId === companyId)?.role || null;
}

async function canAccessCompany(user, companyId) {
  return Boolean(companyId) && (await accessibleCompanyIds(user)).includes(companyId);
}

// 404 de propósito (nunca 403): não revela a existência de recurso de outra
// empresa para quem não tem acesso a ela (prevenção de IDOR/enumeração).
async function assertCompanyAccess(user, companyId, message = "Recurso não encontrado.") {
  if (!(await canAccessCompany(user, companyId))) throw fail(message, 404);
}

// Cópia do usuário com o cargo da empresa informada — permite reaproveitar
// todas as regras existentes (canSetPriority, canManageCampaigns, escopo de
// setor…) sem duplicar a lógica por empresa. Sem acesso => null.
async function userForCompany(user, companyId) {
  const entry = (await companyAccess(user)).find((item) => item.companyId === companyId);
  if (!entry) return null;
  const { derivePermissions, pickPermissionFlags } = require("./auth-service");
  // Permissões recalculadas para o cargo DESTA empresa, com as flags do
  // cadastro sobrepostas pelas personalizadas da empresa (se houver).
  const raw = { ...(user.permissionFlags || pickPermissionFlags(user)), ...(entry.permissions || {}) };
  const role = entry.role;
  const scoped = { ...user, role, isMaster: user.role === "ADMIN", ...derivePermissions(role, raw) };
  Object.defineProperty(scoped, "permissionFlags", { value: raw, enumerable: false, configurable: true });
  Object.defineProperty(scoped, "companyAccess", { value: user.companyAccess, enumerable: false, configurable: true, writable: true });
  return scoped;
}

// Filtro "Empresa: Todas | Mibro | Sincrofit" vindo da tela. Devolve a lista
// de companyIds a consultar — sempre um subconjunto do acesso real. Pedir
// uma empresa sem acesso é 403 (o usuário escolheu explicitamente algo que
// não pode ver), nunca "todas" silenciosamente.
async function resolveCompanyFilter(user, requested) {
  const access = await companyAccess(user);
  const value = String(requested || "").trim();
  if (!value || value === ALL_COMPANIES) return access.map(({ companyId }) => companyId);
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  const companies = await listCompanies({ includeInactive: true });
  const ids = values.map((item) => (companies.find((company) => company.id === item || company.slug === item) || {}).id);
  if (ids.some((id) => !id || !access.some((entry) => entry.companyId === id))) {
    throw fail("Você não tem acesso a esta empresa.", 403);
  }
  return [...new Set(ids)];
}

// Empresa para um recurso NOVO (categoria, Bot, campanha, resposta rápida de
// empresa…): explícita quando informada, ou implícita só se o usuário tiver
// exatamente uma empresa. Nunca escolhe "a Mibro" por padrão.
async function resolveCompanyForCreate(user, requested) {
  const access = await companyAccess(user);
  if (requested) {
    const companies = await listCompanies({ includeInactive: true });
    const company = companies.find((item) => item.id === requested || item.slug === requested);
    if (!company || !access.some((entry) => entry.companyId === company.id)) throw fail("Você não tem acesso a esta empresa.", 403);
    return company.id;
  }
  if (access.length === 1) return access[0].companyId;
  throw fail("Selecione a empresa.");
}

function normalizeCompanyRole(role) {
  if (role === null || role === undefined || role === "") return null;
  if (!COMPANY_ROLES.includes(role)) throw fail("Cargo por empresa inválido (use Supervisor, Atendente ou o cargo padrão).");
  return role;
}

// Preferência persistente do filtro de empresa (item 16). Ao ler, descarta
// preferência para empresa à qual o usuário perdeu acesso.
async function getCompanyFilterPreference(user) {
  const stored = (await prisma.user.findUnique({ where: { id: user.id }, select: { companyFilterPreference: true } }))?.companyFilterPreference;
  if (!stored || stored === ALL_COMPANIES) return ALL_COMPANIES;
  const company = await getCompanyBySlug(stored);
  return company && (await canAccessCompany(user, company.id)) ? company.slug : ALL_COMPANIES;
}

async function setCompanyFilterPreference(user, value) {
  const normalized = !value || value === ALL_COMPANIES ? ALL_COMPANIES : String(value);
  if (normalized !== ALL_COMPANIES) {
    const company = await getCompanyBySlug(normalized);
    if (!company || !(await canAccessCompany(user, company.id))) throw fail("Você não tem acesso a esta empresa.", 403);
  }
  await prisma.user.update({ where: { id: user.id }, data: { companyFilterPreference: normalized } });
  return normalized;
}

// ---- Administração (Master Global) ------------------------------------------

function assertGlobalMaster(user) {
  if (!isGlobalMaster(user)) throw fail("Somente o Master pode gerenciar empresas.", 403);
}

function validateCompanyInput(data, { partial = false } = {}) {
  const out = {};
  if (!partial || data.name !== undefined) {
    if (!String(data.name || "").trim()) throw fail("Nome da empresa é obrigatório.");
    out.name = String(data.name).trim().slice(0, 80);
  }
  if (!partial || data.slug !== undefined) {
    const slug = String(data.slug || "").trim().toLowerCase();
    if (!SLUG.test(slug)) throw fail("Identificador (slug) inválido: use letras minúsculas, números e hífen.");
    if (slug === ALL_COMPANIES.toLowerCase()) throw fail("Identificador reservado.");
    out.slug = slug;
  }
  if (!partial || data.displayName !== undefined) {
    const displayName = String(data.displayName || data.name || "").trim().toUpperCase().slice(0, 20);
    if (!displayName) throw fail("Rótulo da empresa é obrigatório.");
    out.displayName = displayName;
  }
  if (!partial || data.primaryColor !== undefined) {
    if (!HEX_COLOR.test(String(data.primaryColor || ""))) throw fail("Cor inválida (use #RRGGBB).");
    out.primaryColor = String(data.primaryColor).toUpperCase();
  }
  if (data.logoUrl !== undefined) out.logoUrl = data.logoUrl ? String(data.logoUrl).slice(0, 500) : null;
  if (data.active !== undefined) out.active = Boolean(data.active);
  if (data.displayOrder !== undefined) out.displayOrder = Number.parseInt(data.displayOrder, 10) || 0;
  return out;
}

async function createCompany(data, viewer) {
  assertGlobalMaster(viewer);
  const company = await prisma.company.create({ data: validateCompanyInput(data) });
  invalidateCompanyCache();
  return publicCompany(company);
}

async function updateCompany(id, data, viewer) {
  assertGlobalMaster(viewer);
  const company = await prisma.company.update({ where: { id }, data: validateCompanyInput(data, { partial: true }) });
  invalidateCompanyCache();
  return publicCompany(company);
}

// Cores derivadas para a UI (item 51) — o front também deriva via CSS
// color-mix, isto serve a quem precisa do valor pronto (e-mail, push, CSV).
function companyAccent(company) {
  const hex = String(company?.primaryColor || "#8A8E97").replace("#", "");
  const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  return {
    color: `#${hex.toUpperCase()}`,
    border: `rgba(${r}, ${g}, ${b}, 0.7)`,
    soft: `rgba(${r}, ${g}, ${b}, 0.05)`,
  };
}

module.exports = {
  ALL_COMPANIES, COMPANY_ROLES,
  accessibleCompanyIds, assertCompanyAccess, assertGlobalMaster, canAccessCompany, companyAccent, companyAccess,
  createCompany, getCompany, getCompanyBySlug, getCompanyFilterPreference, invalidateCompanyCache, isGlobalMaster,
  listCompanies, normalizeCompanyRole, publicCompany, resolveCompanyFilter, resolveCompanyForCreate, roleInCompany,
  setCompanyFilterPreference, updateCompany, userForCompany,
};
