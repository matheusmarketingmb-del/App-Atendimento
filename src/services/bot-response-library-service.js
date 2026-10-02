// Biblioteca "Respostas do Bot": textos controlados e reutilizáveis
// (BotResponse) que o nó Mensagem do Flow Builder referencia por `key`.
// Editar uma resposta atualiza todos os fluxos que a usam — inclusive
// versões já publicadas, de propósito (é a vantagem de não duplicar texto).
// Desativar/excluir uma resposta em uso é bloqueado.
const prisma = require("../database/prisma");
const audit = require("./audit-service");
const { assertBotManager, fail } = require("./bot-governance-service");

const RESPONSE_CATEGORIES = Object.freeze([
  "GERAL", "ATENDIMENTO", "SUPORTE", "COMERCIAL", "GARANTIA", "PEDIDOS", "MARKETING", "PARCERIAS",
]);
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const MAX_TEXT = 4000;

function normalizeKey(value) {
  const key = String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!KEY_PATTERN.test(key)) throw fail("Código inválido: use letras maiúsculas, números e _ (ex.: SUPORTE_CARREGAMENTO).");
  return key;
}

function validate(data, { partial = false } = {}) {
  const out = {};
  if (!partial || data.title !== undefined) {
    const title = String(data.title || "").trim();
    if (!title) throw fail("Informe o título da resposta.");
    out.title = title.slice(0, 120);
  }
  if (!partial || data.text !== undefined) {
    const text = String(data.text || "").trim();
    if (!text) throw fail("Informe o texto da resposta.");
    if (text.length > MAX_TEXT) throw fail(`O texto deve ter no máximo ${MAX_TEXT} caracteres.`);
    out.text = text;
  }
  if (!partial || data.category !== undefined) {
    const category = String(data.category || "GERAL").toUpperCase();
    if (!RESPONSE_CATEGORIES.includes(category)) throw fail("Categoria da resposta inválida.");
    out.category = category;
  }
  if (data.active !== undefined) {
    if (typeof data.active !== "boolean") throw fail("Informe se a resposta está ativa.");
    out.active = data.active;
  }
  return out;
}

// Fluxos (rascunho ou versão em uso) que referenciam a resposta — usado para
// bloquear exclusão/desativação e para mostrar "em uso em N fluxos".
async function findUsages(key) {
  const needle = `"responseKey":"${key}"`;
  const flows = await prisma.botFlow.findMany({
    where: { archivedAt: null },
    select: { id: true, name: true, botId: true, draftGraph: true, activeVersion: { select: { graph: true } } },
  });
  return flows.filter((flow) => JSON.stringify(flow.draftGraph).includes(needle)
    || JSON.stringify(flow.activeVersion?.graph || {}).includes(needle))
    .map((flow) => ({ flowId: flow.id, flowName: flow.name, botId: flow.botId }));
}

async function listResponses(viewer, { includeInactive = true } = {}) {
  assertBotManager(viewer);
  return prisma.botResponse.findMany({
    where: includeInactive ? {} : { active: true },
    orderBy: [{ category: "asc" }, { key: "asc" }],
  });
}

async function createResponse(data, actor) {
  assertBotManager(actor);
  const key = normalizeKey(data.key);
  if (await prisma.botResponse.findUnique({ where: { key } })) throw fail("Já existe uma resposta com este código.", 409);
  const created = await prisma.botResponse.create({
    data: {
      key, ...validate(data),
      createdByUserId: actor.id, createdByName: actor.name || null, updatedByUserId: actor.id, updatedByName: actor.name || null,
    },
  });
  await audit.recordAudit({ actor, action: "BOT_RESPONSE_CREATED", entityType: "BOT", entityId: null, summary: `Criou a resposta do Bot ${key}`, details: { key } });
  return created;
}

async function updateResponse(id, data, actor) {
  assertBotManager(actor);
  const existing = await prisma.botResponse.findUnique({ where: { id } });
  if (!existing) throw fail("Resposta não encontrada.", 404);
  const update = validate(data, { partial: true });
  if (data.key !== undefined && normalizeKey(data.key) !== existing.key) throw fail("O código de uma resposta não pode ser alterado (fluxos o referenciam).");
  if (update.active === false && existing.active) {
    const usages = await findUsages(existing.key);
    if (usages.length) throw fail(`Esta resposta está em uso em ${usages.length} fluxo(s): ${usages.map((item) => item.flowName).join(", ")}.`, 409);
  }
  const updated = await prisma.botResponse.update({ where: { id }, data: { ...update, updatedByUserId: actor.id, updatedByName: actor.name || null } });
  await audit.recordAudit({ actor, action: "BOT_RESPONSE_UPDATED", entityType: "BOT", entityId: null, summary: `Alterou a resposta do Bot ${existing.key}`, details: { key: existing.key, fields: Object.keys(update) } });
  return updated;
}

async function deleteResponse(id, actor) {
  assertBotManager(actor);
  const existing = await prisma.botResponse.findUnique({ where: { id } });
  if (!existing) throw fail("Resposta não encontrada.", 404);
  const usages = await findUsages(existing.key);
  if (usages.length) throw fail(`Esta resposta está em uso em ${usages.length} fluxo(s): ${usages.map((item) => item.flowName).join(", ")}.`, 409);
  await prisma.botResponse.delete({ where: { id } });
  await audit.recordAudit({ actor, action: "BOT_RESPONSE_DELETED", entityType: "BOT", entityId: null, summary: `Excluiu a resposta do Bot ${existing.key}`, details: { key: existing.key } });
  return { deleted: true };
}

// Mapa key -> texto das respostas ativas (lido a cada turno do fluxo).
async function activeResponseMap(client = prisma) {
  const rows = await client.botResponse.findMany({ where: { active: true }, select: { key: true, text: true } });
  return new Map(rows.map((row) => [row.key, row.text]));
}

module.exports = {
  RESPONSE_CATEGORIES, activeResponseMap, createResponse, deleteResponse, findUsages, listResponses, normalizeKey, updateResponse,
};
