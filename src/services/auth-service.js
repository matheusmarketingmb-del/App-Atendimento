const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../database/prisma");

const COOKIE_NAME = "mibro_session";

function secret() {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET deve possuir ao menos 32 caracteres.");
  }
  return process.env.SESSION_SECRET;
}

// Flags gravadas no cadastro do usuário (e que podem ser personalizadas por
// empresa em UserCompanyAccess.permissions).
const PERMISSION_FLAGS = Object.freeze([
  "canViewUncategorized", "canManageCategories", "canTransferConversations", "canViewConversationHistory",
  "canViewPreviousMessages", "canManageCampaigns", "canSetConversationPriority", "canStartConversations", "canMergeContacts",
]);

function pickPermissionFlags(source = {}) {
  return Object.fromEntries(PERMISSION_FLAGS.map((key) => [key, Boolean(source[key])]));
}

// Permissões efetivas para um cargo + flags. Única regra — usada no usuário
// (cargo padrão) e por empresa (company-service#userForCompany), para que o
// cargo da empresa nunca herde permissões calculadas com outro cargo.
function derivePermissions(role, raw = {}) {
  const admin = role === "ADMIN";
  return {
    canViewUncategorized: admin || Boolean(raw.canViewUncategorized),
    canManageCategories: admin || Boolean(raw.canManageCategories),
    canTransferConversations: admin || Boolean(raw.canTransferConversations),
    // Visão de equipe (cargos, permissões e carga de cada um) é só do Master.
    canViewTeamActivity: admin,
    canViewConversationHistory: admin || Boolean(raw.canViewConversationHistory),
    canViewPreviousMessages: admin || Boolean(raw.canViewPreviousMessages),
    // Campanhas/prospecção (item 27): Admin e Supervisor têm acesso por
    // padrão; um Atendente específico pode ganhar via canManageCampaigns.
    canManageCampaigns: admin || role === "SUPERVISOR" || Boolean(raw.canManageCampaigns),
    canSetConversationPriority: admin || role === "SUPERVISOR" || Boolean(raw.canSetConversationPriority),
    canStartConversations: admin || Boolean(raw.canStartConversations),
    canMergeContacts: admin || Boolean(raw.canMergeContacts),
  };
}

function publicUser(user) {
  const permissionFlags = pickPermissionFlags(user);
  const result = {
    id: user.id, name: user.name, email: user.email, role: user.role,
    isMaster: user.role === "ADMIN",
    ...derivePermissions(user.role, permissionFlags),
  };
  // Flags cruas (não serializadas): base para recalcular por empresa.
  Object.defineProperty(result, "permissionFlags", { value: permissionFlags, enumerable: false });
  return result;
}

function setSession(res, user) {
  const token = jwt.sign({ sub: user.id, sv: user.sessionVersion }, secret(), { expiresIn: "12h" });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 12 * 60 * 60 * 1000,
    path: "/",
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/" });
}

async function setup({ name, email, password }) {
  if (await prisma.user.count()) throw Object.assign(new Error("O acesso inicial já foi configurado."), { statusCode: 409 });
  if (!name?.trim()) throw Object.assign(new Error("Nome é obrigatório."), { statusCode: 400 });
  if (!/^\S+@\S+\.\S+$/.test(email || "")) throw Object.assign(new Error("E-mail inválido."), { statusCode: 400 });
  if (!password || password.length < 8) throw Object.assign(new Error("A senha deve ter ao menos 8 caracteres."), { statusCode: 400 });
  const passwordHash = await bcrypt.hash(password, 12);
  return prisma.user.create({ data: { name: name.trim(), email: email.trim().toLowerCase(), passwordHash, role: "ADMIN" } });
}

async function login({ email, password }) {
  const user = await prisma.user.findUnique({ where: { email: (email || "").trim().toLowerCase() } });
  if (!user?.active || !user.passwordHash || !(await bcrypt.compare(password || "", user.passwordHash))) {
    throw Object.assign(new Error("E-mail ou senha incorretos."), { statusCode: 401 });
  }
  return user;
}

async function userFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, secret());
    return await prisma.user.findFirst({ where: { id: payload.sub, active: true, sessionVersion: payload.sv } });
  } catch (_error) { return null; }
}

async function invalidateSession(token) {
  const user = await userFromToken(token);
  if (user) await prisma.user.update({ where: { id: user.id }, data: { sessionVersion: { increment: 1 } } });
}

module.exports = {
  COOKIE_NAME, PERMISSION_FLAGS, clearSession, derivePermissions, invalidateSession, login, pickPermissionFlags,
  publicUser, setSession, setup, userFromToken,
};
