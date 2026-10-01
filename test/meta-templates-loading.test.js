require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const fs = require("node:fs");
const path = require("node:path");
const MetaCloudChannel = require("../src/channels/meta-cloud-channel");
const {
  listApprovedTemplates, listTemplates, normalizeTemplate, templatesConfigured,
} = require("../src/services/meta-template-service");
const campaigns = require("../src/services/campaign-service");
const auth = require("../src/services/auth-service");
const authorization = require("../src/services/authorization-service");
const { requireCampaignAccess } = require("../src/middleware/auth");

test("nova conversa WhatsApp usa template aprovado pela rota outbound", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const js = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
  const controller = fs.readFileSync(path.join(__dirname, "../src/controllers/inbox-controller.js"), "utf8");
  assert.match(html, /id="outbound-meta-dialog"/);
  assert.match(html, /id="outbound-meta-phone"/);
  assert.match(js, /api\("\/api\/conversations\/outbound"/);
  assert.match(controller, /createOutboundConversation\(\{ \.\.\.req\.body, user: req\.user, channel \}\)/);
  assert.doesNotMatch(controller, /createOutbound\(_req, res\)/);
});
test("Campanhas: Master acessa por padrão e demais perfis exigem liberação individual", () => {
  assert.equal(auth.publicUser({ role: "ADMIN" }).canManageCampaigns, true);
  assert.equal(auth.publicUser({ role: "SUPERVISOR", canManageCampaigns: false }).canManageCampaigns, false);
  assert.equal(auth.publicUser({ role: "SUPERVISOR", canManageCampaigns: true }).canManageCampaigns, true);
  assert.equal(authorization.canManageCampaigns({ role: "ATENDENTE", canManageCampaigns: false }), false);
  assert.equal(authorization.canManageCampaigns({ role: "ATENDENTE", canManageCampaigns: true }), true);
});
test("tela de campanhas respeita hidden e mantém modais fechados no carregamento", () => {
  const css = fs.readFileSync(path.join(__dirname, "../public/css/campaigns.css"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "../public/campaigns.html"), "utf8");
  assert.match(css, /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important/i);
  assert.match(html, /id="settings-modal"[^>]*hidden/);
  assert.match(html, /id="optouts-modal"[^>]*hidden/);
});

test("frontend mantém a área acessível quando templates da Meta estão indisponíveis", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public/js/campaigns.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "../public/campaigns.html"), "utf8");
  assert.match(js, /function setTemplatesAvailability/);
  assert.match(js, /A área de Campanhas permanece disponível em modo limitado/);
  assert.match(html, /id="campaign-api-notice"/);
});

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  Object.assign(process.env, overrides);
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

const baseEnv = { GRAPH_VERSION: "v-test", PHONE_NUMBER_ID: "phone-test", WHATSAPP_TOKEN: "token-secreto-nunca-deve-vazar", WHATSAPP_BUSINESS_ACCOUNT_ID: "waba-test" };

test("WHATSAPP_BUSINESS_ACCOUNT_ID ausente: templatesConfigured() reporta false (gate do controller antes de qualquer chamada à Meta)", async () => {
  await withEnv({ WHATSAPP_BUSINESS_ACCOUNT_ID: "" }, async () => {
    assert.equal(templatesConfigured(), false);
  });
});

test("variável de ambiente básica ausente (GRAPH_VERSION): erro claro com statusCode, nunca 500 genérico sem contexto", async () => {
  await withEnv({ ...baseEnv, GRAPH_VERSION: "" }, async () => {
    await assert.rejects(
      () => new MetaCloudChannel().listMessageTemplates(),
      (error) => { assert.equal(error.statusCode, 503); assert.match(error.message, /GRAPH_VERSION/); return true; },
    );
  });
});

test("WABA ID ausente ao chamar o channel diretamente: erro 503 claro (mesmo fora do gate do controller)", async () => {
  await withEnv({ ...baseEnv, WHATSAPP_BUSINESS_ACCOUNT_ID: "" }, async () => {
    await assert.rejects(
      () => new MetaCloudChannel().listMessageTemplates(),
      (error) => { assert.equal(error.statusCode, 503); return true; },
    );
  });
});

async function mockGetError(status, data) {
  const previousGet = axios.get;
  axios.get = async () => { throw Object.assign(new Error("Request failed"), { response: { status, data } }); };
  return () => { axios.get = previousGet; };
}

test("401 (token inválido): mensagem clara, nunca inclui o token", async () => {
  await withEnv(baseEnv, async () => {
    const restore = await mockGetError(401, { error: { message: "Invalid OAuth access token", code: 190 } });
    try {
      await assert.rejects(
        () => new MetaCloudChannel().listMessageTemplates(),
        (error) => {
          assert.equal(error.statusCode, 502);
          assert.match(error.message, /credencial/i);
          assert.doesNotMatch(error.message, /token-secreto-nunca-deve-vazar/);
          return true;
        },
      );
    } finally { restore(); }
  });
});

test("403 (sem permissão): mensagem clara sobre escopo/permissão", async () => {
  await withEnv(baseEnv, async () => {
    const restore = await mockGetError(403, { error: { message: "Permissions error", code: 200 } });
    try {
      await assert.rejects(
        () => new MetaCloudChannel().listMessageTemplates(),
        (error) => { assert.equal(error.statusCode, 502); assert.match(error.message, /permiss/i); return true; },
      );
    } finally { restore(); }
  });
});

test("404 (WABA inválido): mensagem clara sobre WABA/Phone Number ID", async () => {
  await withEnv(baseEnv, async () => {
    const restore = await mockGetError(404, { error: { message: "Unsupported get request" } });
    try {
      await assert.rejects(
        () => new MetaCloudChannel().listMessageTemplates(),
        (error) => { assert.equal(error.statusCode, 502); assert.match(error.message, /WABA|Phone Number/i); return true; },
      );
    } finally { restore(); }
  });
});

test("429 (rate limit): statusCode 429 propagado e mensagem orienta esperar", async () => {
  await withEnv(baseEnv, async () => {
    const restore = await mockGetError(429, { error: { message: "Too many requests" } });
    try {
      await assert.rejects(
        () => new MetaCloudChannel().listMessageTemplates(),
        (error) => { assert.equal(error.statusCode, 429); assert.match(error.message, /instantes|limit/i); return true; },
      );
    } finally { restore(); }
  });
});

test("500 (Meta indisponível): mensagem clara de indisponibilidade", async () => {
  await withEnv(baseEnv, async () => {
    const restore = await mockGetError(500, { error: { message: "internal error" } });
    try {
      await assert.rejects(
        () => new MetaCloudChannel().listMessageTemplates(),
        (error) => { assert.equal(error.statusCode, 502); assert.match(error.message, /indispon/i); return true; },
      );
    } finally { restore(); }
  });
});

test("Meta indisponível (sem resposta HTTP nenhuma / timeout de rede): nunca lança um erro cru, cai no fallback seguro", async () => {
  await withEnv(baseEnv, async () => {
    const previousGet = axios.get;
    axios.get = async () => { throw Object.assign(new Error("ECONNABORTED"), { code: "ECONNABORTED" }); };
    try {
      await assert.rejects(
        () => new MetaCloudChannel().listMessageTemplates(),
        (error) => { assert.equal(error.statusCode, 502); assert.ok(error.message); return true; },
      );
    } finally { axios.get = previousGet; }
  });
});

test("payload malformado da Meta (data não é array): nunca quebra, devolve lista vazia", async () => {
  await withEnv(baseEnv, async () => {
    const previousGet = axios.get;
    axios.get = async () => ({ data: { data: "isto não é uma lista" } });
    try {
      const templates = await new MetaCloudChannel().listMessageTemplates();
      assert.deepEqual(templates, []);
    } finally { axios.get = previousGet; }
  });
});

test("templates sem campo components: normalizeTemplate nunca lança, variables/components ficam como array vazio", () => {
  const normalized = normalizeTemplate({ id: "t1", name: "sem_componentes", language: "pt_BR", category: "UTILITY", status: "APPROVED" });
  assert.deepEqual(normalized.components, []);
  assert.deepEqual(normalized.variables, []);
  assert.equal(normalized.supported, true);
});

test("template com header/body/footer/buttons e variáveis: normaliza para o formato interno previsível", () => {
  const template = {
    id: "t2", name: "com_tudo", language: "pt_BR", category: "MARKETING", status: "APPROVED",
    components: [
      { type: "HEADER", format: "TEXT", text: "Olá {{1}}", example: { header_text: ["Cliente"] } },
      { type: "BODY", text: "Sua encomenda {{1}} chegou em {{2}}.", example: { body_text: [["12345", "São Paulo"]] } },
      { type: "FOOTER", text: "Equipe Mibro" },
      { type: "BUTTONS", buttons: [{ type: "URL", text: "Rastrear", url: "https://exemplo.com/{{1}}", example: ["abc"] }] },
    ],
  };
  const normalized = normalizeTemplate(template);
  assert.equal(normalized.id, "t2");
  assert.equal(normalized.status, "APPROVED");
  assert.deepEqual(normalized.components, template.components);
  assert.ok(normalized.variables.length >= 3);
  assert.ok(normalized.variables.some((v) => v.component === "BUTTON"));
  assert.match(normalized.preview, /São Paulo|Cliente/);
});

test("template com header de mídia (IMAGE): marcado como não suportado, nunca quebra a listagem", () => {
  const normalized = normalizeTemplate({
    id: "t3", name: "com_imagem", language: "pt_BR", category: "MARKETING", status: "APPROVED",
    components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Confira a novidade!" }],
  });
  assert.equal(normalized.supported, false);
  assert.match(normalized.unsupportedReason, /image/i);
});

test("catálogo de campanhas retorna todos os status e resumo da sincronização", async () => {
  await withEnv(baseEnv, async () => {
    const channel = { listAllMessageTemplates: async () => [
      { id: "a", name: "aprovado", language: "pt_BR", category: "UTILITY", status: "APPROVED", components: [] },
      { id: "p", name: "pendente", language: "en_US", category: "MARKETING", status: "PENDING", components: [] },
      { id: "r", name: "rejeitado", language: "pt_BR", category: "AUTHENTICATION", status: "REJECTED", components: [] },
    ] };
    const result = await listTemplates(channel);
    assert.equal(result.templates.length, 3);
    assert.deepEqual(result.sync.byStatus, { APPROVED: 1, PENDING: 1, REJECTED: 1 });
    assert.equal(result.sync.wabaId, "waba-test");
    assert.equal(result.sync.tokenSource, "WHATSAPP_TOKEN");
  });
});
test("templates pausados/rejeitados nunca aparecem na listagem padrão (só APPROVED)", async () => {
  await withEnv(baseEnv, async () => {
    const previousGet = axios.get;
    axios.get = async () => ({ data: { data: [
      { id: "a", name: "aprovado", language: "pt_BR", category: "MARKETING", status: "APPROVED" },
      { id: "b", name: "pausado", language: "pt_BR", category: "MARKETING", status: "PAUSED" },
      { id: "c", name: "rejeitado", language: "pt_BR", category: "MARKETING", status: "REJECTED" },
      { id: "d", name: "sem_id_ou_nome", language: "pt_BR", category: "MARKETING", status: "APPROVED" },
    ] } });
    try {
      const channel = new MetaCloudChannel();
      const rows = await channel.listMessageTemplates();
      assert.deepEqual(rows.map((r) => r.name), ["aprovado", "sem_id_ou_nome"]);
      const normalized = await listApprovedTemplates(channel);
      assert.deepEqual(normalized.map((t) => t.status), ["APPROVED", "APPROVED"]);
    } finally { axios.get = previousGet; }
  });
});

test("item malformado sem id/name é descartado antes de chegar ao normalizador", async () => {
  await withEnv(baseEnv, async () => {
    const previousGet = axios.get;
    axios.get = async () => ({ data: { data: [
      { status: "APPROVED" }, // sem id/name
      { id: "ok", name: "valido", language: "pt_BR", category: "MARKETING", status: "APPROVED" },
    ] } });
    try {
      const rows = await new MetaCloudChannel().listMessageTemplates();
      assert.deepEqual(rows.map((r) => r.name), ["valido"]);
    } finally { axios.get = previousGet; }
  });
});

test("previewTemplate: uma única chamada à Meta (nunca duas), nunca lança erro cru quando o template some entre validação e uso", async () => {
  const approvedTemplate = {
    id: "tpl-x", name: "prospeccao_unica", language: "pt_BR", category: "MARKETING", status: "APPROVED",
    components: [{ type: "BODY", text: "Oi {{1}}!", example: { body_text: [["Cliente"]] } }],
  };
  let calls = 0;
  const channel = { listMessageTemplates: async () => { calls += 1; return [approvedTemplate]; } };
  const preview = await campaigns.previewTemplate(channel, {
    templateName: "prospeccao_unica", templateLanguage: "pt_BR", variableMapping: {}, sampleContact: { firstName: "Maria" },
  });
  assert.equal(calls, 1, "previewTemplate não deveria consultar a Meta mais de uma vez por chamada");
  assert.match(preview.renderedPreview, /Cliente|Oi/);
});

test("previewTemplate: template não encontrado/aprovado nunca derruba com TypeError cru — sempe um erro claro", async () => {
  const channel = { listMessageTemplates: async () => [] };
  await assert.rejects(
    () => campaigns.previewTemplate(channel, { templateName: "nao_existe", templateLanguage: "pt_BR", variableMapping: {} }),
    (error) => { assert.ok(error.statusCode); assert.match(error.message, /não encontrado|aprovado/i); return true; },
  );
});

test("middleware bloqueia templates e campanhas sem permissão individual", () => {
  let statusCode = null;
  let payload = null;
  const res = { status(code) { statusCode = code; return this; }, json(body) { payload = body; return this; } };
  let nextCalled = false;
  requireCampaignAccess({ user: { role: "ATENDENTE", canManageCampaigns: false } }, res, () => { nextCalled = true; });
  assert.equal(statusCode, 403);
  assert.equal(nextCalled, false);
  assert.match(payload.error, /permissão/i);
  requireCampaignAccess({ user: { role: "SUPERVISOR", canManageCampaigns: true } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("frontend mantém aviso explicativo e oculta ações de templates sem permissão", () => {
  const js = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
  const controller = fs.readFileSync(path.join(__dirname, "../src/controllers/inbox-controller.js"), "utf8");
  assert.match(js, /open-templates[^\n]+!configured \|\| !canUseTemplates/);
  assert.match(js, /service-window-notice[^\n]+!closed/);
  assert.match(js, /open-required-template[^\n]+!canUseTemplates \|\| unavailable/);
  assert.match(app, /api\/meta\/templates[^\n]+requireCampaignAccess/);
  assert.match(controller, /replyTemplate[\s\S]{0,100}assertCanManageCampaigns/);
});

test("template inclui tarifa base configurável em BRL por mensagem entregue", async () => {
  await withEnv({ WHATSAPP_RATE_BRL_MARKETING: "0.4321" }, async () => {
    const normalized = normalizeTemplate({ id:"price", name:"price", language:"pt_BR", category:"MARKETING", status:"APPROVED" });
    assert.equal(normalized.pricing.rate, 0.4321);
    assert.equal(normalized.pricing.currency, "BRL");
    assert.equal(normalized.pricing.basis, "DELIVERED_MESSAGE");
  });
});
