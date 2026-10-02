// Endpoints de Webhook/API do Flow Builder (BotWebhookEndpoint): o Master
// cadastra URL + cabeçalhos aqui; o nó Webhook só referencia a `key`.
//
// Segurança:
//   - cabeçalhos (tokens) cifrados com INTEGRATION_ENCRYPTION_KEY (mesmo
//     cofre das integrações), nunca devolvidos pela API nem gravados em log;
//   - só HTTPS, sem redirect, timeout curto, resposta limitada;
//   - bloqueio de SSRF: o host é resolvido e recusado se cair em rede
//     privada/loopback/link-local (nunca chama a própria VPS/intranet).
const dns = require("node:dns/promises");
const net = require("node:net");
const axios = require("axios");
const prisma = require("../database/prisma");
const audit = require("./audit-service");
const vault = require("./channels/integration-secret-service");
const { assertBotManager, fail } = require("./bot-governance-service");

const KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_STORED_RESULT = 8 * 1024;

function normalizeKey(value) {
  const key = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!KEY_PATTERN.test(key)) throw fail("Código inválido: use letras minúsculas, números e _ (ex.: consulta_pedido).");
  return key;
}

function validateUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch (_error) { throw fail("URL inválida."); }
  if (url.protocol !== "https:") throw fail("Use uma URL HTTPS.");
  if (url.username || url.password) throw fail("Não coloque usuário/senha na URL — use um cabeçalho.");
  return url.toString();
}

function validateHeaders(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw fail("Cabeçalhos devem ser uma lista.");
  const headers = {};
  for (const item of value.slice(0, 10)) {
    const name = String(item?.name || "").trim();
    if (!name) continue;
    if (!HEADER_NAME_PATTERN.test(name)) throw fail(`Nome de cabeçalho inválido: ${name.slice(0, 40)}`);
    headers[name] = String(item?.value ?? "").slice(0, 2000);
  }
  return headers;
}

function publicEndpoint(row) {
  return {
    id: row.id, key: row.key, name: row.name, url: row.url, method: row.method, timeoutMs: row.timeoutMs,
    active: row.active, headerKeys: row.headerKeys, updatedByName: row.updatedByName, updatedAt: row.updatedAt,
  };
}

async function listEndpoints(viewer) {
  assertBotManager(viewer);
  return (await prisma.botWebhookEndpoint.findMany({ orderBy: { key: "asc" } })).map(publicEndpoint);
}

function buildData(data, { partial }) {
  const out = {};
  if (!partial || data.name !== undefined) {
    const name = String(data.name || "").trim();
    if (!name) throw fail("Informe o nome do endpoint.");
    out.name = name.slice(0, 120);
  }
  if (!partial || data.url !== undefined) out.url = validateUrl(data.url);
  if (data.method !== undefined || !partial) {
    const method = String(data.method || "POST").toUpperCase();
    if (!["GET", "POST"].includes(method)) throw fail("Método deve ser GET ou POST.");
    out.method = method;
  }
  if (data.timeoutMs !== undefined) {
    const timeoutMs = Number(data.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 15000) throw fail("Timeout deve ficar entre 500 e 15000 ms.");
    out.timeoutMs = timeoutMs;
  }
  if (data.active !== undefined) {
    if (typeof data.active !== "boolean") throw fail("Informe se o endpoint está ativo.");
    out.active = data.active;
  }
  const headers = validateHeaders(data.headers);
  if (headers !== undefined) {
    if (Object.keys(headers).length) {
      const encrypted = vault.encryptSecrets(headers);
      Object.assign(out, {
        encryptedHeaders: encrypted.encryptedSecrets, encryptionIv: encrypted.encryptionIv,
        encryptionAuthTag: encrypted.encryptionAuthTag, headerKeys: Object.keys(headers),
      });
    } else {
      Object.assign(out, { encryptedHeaders: null, encryptionIv: null, encryptionAuthTag: null, headerKeys: [] });
    }
  }
  return out;
}

async function createEndpoint(data, actor) {
  assertBotManager(actor);
  const key = normalizeKey(data.key);
  if (await prisma.botWebhookEndpoint.findUnique({ where: { key } })) throw fail("Já existe um endpoint com este código.", 409);
  const row = await prisma.botWebhookEndpoint.create({
    data: { key, ...buildData(data, { partial: false }), updatedByUserId: actor.id, updatedByName: actor.name || null },
  });
  await audit.recordAudit({ actor, action: "BOT_WEBHOOK_CREATED", entityType: "BOT", entityId: null, summary: `Cadastrou o endpoint de Bot ${key}`, details: { key, url: row.url } });
  return publicEndpoint(row);
}

async function updateEndpoint(id, data, actor) {
  assertBotManager(actor);
  const existing = await prisma.botWebhookEndpoint.findUnique({ where: { id } });
  if (!existing) throw fail("Endpoint não encontrado.", 404);
  const row = await prisma.botWebhookEndpoint.update({
    where: { id }, data: { ...buildData(data, { partial: true }), updatedByUserId: actor.id, updatedByName: actor.name || null },
  });
  await audit.recordAudit({ actor, action: "BOT_WEBHOOK_UPDATED", entityType: "BOT", entityId: null, summary: `Alterou o endpoint de Bot ${existing.key}`, details: { key: existing.key } });
  return publicEndpoint(row);
}

async function deleteEndpoint(id, actor) {
  assertBotManager(actor);
  const existing = await prisma.botWebhookEndpoint.findUnique({ where: { id } });
  if (!existing) throw fail("Endpoint não encontrado.", 404);
  const needle = `"endpointKey":"${existing.key}"`;
  const flows = await prisma.botFlow.findMany({ where: { archivedAt: null }, select: { name: true, draftGraph: true, activeVersion: { select: { graph: true } } } });
  const using = flows.filter((flow) => JSON.stringify(flow.draftGraph).includes(needle) || JSON.stringify(flow.activeVersion?.graph || {}).includes(needle));
  if (using.length) throw fail(`Endpoint em uso em ${using.length} fluxo(s): ${using.map((flow) => flow.name).join(", ")}.`, 409);
  await prisma.botWebhookEndpoint.delete({ where: { id } });
  await audit.recordAudit({ actor, action: "BOT_WEBHOOK_DELETED", entityType: "BOT", entityId: null, summary: `Excluiu o endpoint de Bot ${existing.key}`, details: { key: existing.key } });
  return { deleted: true };
}

// ---- execução (chamado pelo nó Webhook) ------------------------------------

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

async function assertPublicHost(url, lookup = dns.lookup) {
  const { hostname } = new URL(url);
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) {
    throw Object.assign(new Error("Endpoint aponta para uma rede privada/local — bloqueado."), { code: "WEBHOOK_PRIVATE_HOST" });
  }
}

function truncateResult(data) {
  const text = typeof data === "string" ? data : JSON.stringify(data ?? null);
  if (text.length <= MAX_STORED_RESULT) return data ?? null;
  return { truncated: true, preview: text.slice(0, MAX_STORED_RESULT) };
}

// fields: objeto já renderizado pelo motor (valores string). GET -> query,
// POST -> corpo JSON. Nunca lança: devolve { ok, status, data, errorCode }.
async function callEndpoint(key, fields, { httpClient = axios, lookup } = {}) {
  const endpoint = await prisma.botWebhookEndpoint.findUnique({ where: { key } });
  if (!endpoint || !endpoint.active) return { ok: false, status: null, data: null, errorCode: "WEBHOOK_NOT_FOUND" };
  try {
    await assertPublicHost(endpoint.url, lookup);
    const headers = endpoint.encryptedHeaders ? vault.decryptSecrets({
      encryptedSecrets: endpoint.encryptedHeaders, encryptionIv: endpoint.encryptionIv, encryptionAuthTag: endpoint.encryptionAuthTag,
    }) : {};
    const response = await httpClient.request({
      url: endpoint.url, method: endpoint.method, timeout: endpoint.timeoutMs, maxRedirects: 0,
      maxContentLength: MAX_RESPONSE_BYTES, maxBodyLength: MAX_RESPONSE_BYTES,
      headers: { Accept: "application/json", ...headers },
      ...(endpoint.method === "GET" ? { params: fields } : { data: fields }),
      validateStatus: () => true,
    });
    const ok = response.status >= 200 && response.status < 300;
    return { ok, status: response.status, data: truncateResult(response.data), errorCode: ok ? null : `HTTP_${response.status}` };
  } catch (error) {
    return { ok: false, status: null, data: null, errorCode: error.code === "ECONNABORTED" ? "WEBHOOK_TIMEOUT" : (error.code || "WEBHOOK_FAILED") };
  }
}

module.exports = {
  callEndpoint, createEndpoint, deleteEndpoint, isPrivateAddress, listEndpoints, normalizeKey, updateEndpoint, validateUrl,
};
