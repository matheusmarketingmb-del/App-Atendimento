const prisma = require("../database/prisma");
const auth = require("./authorization-service");
const audit = require("./audit-service");
const features = require("./chat-features");

let expiresAt = 0;
let pending;

async function refresh() {
  if (Date.now() < expiresAt) return;
  if (!pending) {
    pending = prisma.chatFeatureSettings.findUnique({ where: { id: "singleton" } })
      .then(row => { features.setConfigured(row?.values || {}); expiresAt = Date.now() + 2000; })
      .finally(() => { pending = null; });
  }
  await pending;
}

async function read(viewer) {
  auth.assertMaster(viewer);
  const row = await prisma.chatFeatureSettings.findUnique({ where: { id: "singleton" } });
  features.setConfigured(row?.values || {});
  return { revision: row?.revision || 0, values: Object.fromEntries(Object.keys(features.FLAGS).map(key => [key, features.isEnabled(key)])) };
}

async function save(viewer, input) {
  auth.assertMaster(viewer);
  if (!input || !Number.isInteger(input.revision) || input.revision < 0 || !input.values || typeof input.values !== "object" || Array.isArray(input.values)
    || Object.keys(input.values).some(key => !Object.hasOwn(features.FLAGS, key) || typeof input.values[key] !== "boolean")) {
    throw Object.assign(new Error("Configuração de recursos inválida."), { statusCode: 400 });
  }
  const result = await prisma.$transaction(async tx => {
    const current = await tx.chatFeatureSettings.upsert({ where: { id: "singleton" }, create: {}, update: {} });
    if (current.revision !== input.revision) throw Object.assign(new Error("Os recursos foram alterados por outra pessoa. Atualize a página."), { statusCode: 409 });
    const values = { ...current.values, ...input.values };
    const updated = await tx.chatFeatureSettings.updateMany({ where: { id: current.id, revision: current.revision }, data: { values, revision: { increment: 1 } } });
    if (updated.count !== 1) throw Object.assign(new Error("A configuração mudou. Atualize a página."), { statusCode: 409 });
    await audit.recordAudit({ actor: viewer, action: "CHAT_FEATURES_UPDATED", entityType: "CONVERSATION_SETTINGS", entityId: current.id,
      summary: "Alterou os recursos do chat", details: { previous: current.values, values } }, tx);
    return { values, revision: current.revision + 1 };
  });
  features.setConfigured(result.values);
  expiresAt = Date.now() + 2000;
  return { revision: result.revision, values: Object.fromEntries(Object.keys(features.FLAGS).map(key => [key, features.isEnabled(key)])) };
}

async function middleware(_req, _res, next) {
  try { await refresh(); next(); } catch (error) { next(error); }
}

module.exports = { read, save, middleware };
