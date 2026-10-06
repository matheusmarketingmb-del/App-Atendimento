require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const { createApp } = require("../src/app");
const prisma = require("../src/database/prisma");
const MetaCloudChannel = require("../src/channels/meta-cloud-channel");
const inbox = require("../src/services/inbox-service");
const quickReplies = require("../src/services/quick-reply-service");
const optOut = require("../src/services/campaign-optout-service");
const companyService = require("../src/services/company-service");
const inboxEvents = require("../src/realtime/inbox-events");
const { listApprovedTemplates } = require("../src/services/meta-template-service");
const { getEditorOptions } = require("../src/services/bot-visual-flow-service");
const bots = require("../src/services/bot-service");
const { MIBRO, SINCROFIT } = require("./support/company");

// Multiempresa (Mibro Brasil + Sincrofit) — cenários obrigatórios do pedido:
// webhook define a empresa pelo número, Vendedor A (duas empresas), Vendedor
// B (só Mibro: sem filtro, busca, API, realtime, relatório da Sincrofit),
// Supervisor X (Supervisor na Mibro, Atendente na Sincrofit), Master Global,
// IDOR, respostas rápidas/categorias/Bots/templates/opt-out por empresa.

const DOMAIN = "@multiempresa.test";
const PASSWORD = "senha-multiempresa-123";
const PHONE = "5511988880001"; // mesmo cliente nas duas empresas
const PNID_MIBRO = "PNID_MIBRO_MT";
const PNID_SINCRO = "PNID_SINCRO_MT";
const PREFIX = "mt-";

// Canal Meta "de verdade" (parse do webhook e forAccount reais); só a ida à
// rede é simulada, registrando por qual número/WABA cada envio sairia.
class FakeMeta extends MetaCloudChannel {
  constructor(options = {}, log = []) { super(options); this.log = log; }
  forAccount(account) {
    const bound = super.forAccount(account);
    return new FakeMeta({ phoneNumberId: bound.boundPhoneNumberId, wabaId: bound.boundWabaId, token: bound.boundToken, accountId: account.id }, this.log);
  }
  async sendText(to, text) {
    this.log.push({ kind: "text", to, text, phoneNumberId: this.phoneNumberId() });
    return { externalId: `wamid.mt-${crypto.randomUUID()}`, data: {} };
  }
  async listMessageTemplates() {
    this.log.push({ kind: "templates", wabaId: this.wabaId() });
    return [{ name: `tpl_${this.wabaId()}`, language: "pt_BR", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: "Olá" }] }];
  }
  async markAsRead() {}
  async downloadMedia() { throw new Error("sem mídia neste teste"); }
}

const env = {};
const fx = {};

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { endsWith: DOMAIN } }, select: { id: true } });
  const userIds = users.map(({ id }) => id);
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.contact.deleteMany({ where: { externalId: { in: [PHONE, `${PREFIX}sup-mibro`, `${PREFIX}sup-sincro`, `${PREFIX}queue-sincro`] } } });
  await prisma.quickReply.deleteMany({ where: { shortcut: { startsWith: "/mt" } } });
  await prisma.optOut.deleteMany({ where: { phone: "5511988889999" } });
  const testBots = await prisma.bot.findMany({ where: { name: { startsWith: "MT " } }, select: { id: true } });
  await prisma.bot.deleteMany({ where: { id: { in: testBots.map(({ id }) => id) } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.category.deleteMany({ where: { code: { startsWith: "MT_" } } });
  await prisma.channelAccount.deleteMany({ where: { name: { startsWith: "MT Sincrofit" } } });
}

test.before(async () => {
  for (const key of ["PHONE_NUMBER_ID", "WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_TOKEN", "GRAPH_VERSION"]) env[key] = process.env[key];
  process.env.PHONE_NUMBER_ID = PNID_MIBRO;
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "WABA_MIBRO_MT";
  process.env.WHATSAPP_TOKEN = "token-teste";
  process.env.GRAPH_VERSION = "v0.0";
  await cleanup();

  fx.sincroAccount = await prisma.channelAccount.create({ data: {
    companyId: SINCROFIT, channel: "META", name: "MT Sincrofit Atendimento", status: "CONNECTED", enabled: true,
    config: { phoneNumberId: PNID_SINCRO, wabaId: "WABA_SINCRO_MT", displayNumber: "+55 11 4000-0000" },
  } });
  fx.mibroSupport = await prisma.category.create({ data: { companyId: MIBRO, code: "MT_SUPORTE", name: "Suporte MT", color: "#2563eb" } });
  fx.sincroSupport = await prisma.category.create({ data: { companyId: SINCROFIT, code: "MT_SUPORTE", name: "Suporte MT", color: "#2563eb" } });

  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const makeUser = (key, role, access, categories) => prisma.user.create({ data: {
    name: `MT ${key}`, email: `${key}${DOMAIN}`, passwordHash, role, canViewUncategorized: true,
    companyAccess: { create: access.map(([companyId, companyRole = null]) => ({ companyId, role: companyRole })) },
    categoryAccess: { create: categories.map((categoryId) => ({ categoryId })) },
  } });
  fx.vendA = await makeUser("venda", "ATENDENTE", [[MIBRO], [SINCROFIT]], [fx.mibroSupport.id, fx.sincroSupport.id]);
  // B tem até uma linha de setor da Sincrofit "esquecida": sem acesso à
  // empresa, ela nunca pode valer.
  fx.vendB = await makeUser("vendb", "ATENDENTE", [[MIBRO]], [fx.mibroSupport.id, fx.sincroSupport.id]);
  fx.supX = await makeUser("supx", "SUPERVISOR", [[MIBRO], [SINCROFIT, "ATENDENTE"]], [fx.mibroSupport.id, fx.sincroSupport.id]);
  fx.other = await makeUser("other", "ATENDENTE", [[MIBRO], [SINCROFIT]], [fx.mibroSupport.id, fx.sincroSupport.id]);
  fx.master = await prisma.user.create({ data: { name: "MT Master", email: `master${DOMAIN}`, passwordHash, role: "ADMIN" } });
  companyService.invalidateCompanyCache();
});

test.after(async () => {
  await cleanup();
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await prisma.$disconnect();
});

function webhookBody(phoneNumberId, messageId, text) {
  return JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: phoneNumberId, display_phone_number: "550000" },
    contacts: [{ wa_id: PHONE, profile: { name: "João Silva" } }],
    messages: [{ id: messageId, from: PHONE, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
  } }] }] });
}

async function withServer(run) {
  const log = [];
  const server = createApp({ channel: new FakeMeta({}, log) }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (key) => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `${key}${DOMAIN}`, password: PASSWORD }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  };
  const call = (cookie, path, options = {}) => fetch(`${base}${path}`, {
    ...options, headers: { Cookie: cookie, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const webhook = (body) => {
    const headers = { "Content-Type": "application/json" };
    if (process.env.META_APP_SECRET) {
      headers["x-hub-signature-256"] = `sha256=${crypto.createHmac("sha256", process.env.META_APP_SECRET).update(body).digest("hex")}`;
    }
    return fetch(`${base}/webhook/whatsapp`, { method: "POST", headers, body });
  };
  try { await run({ log, login, call, webhook }); } finally { server.close(); }
}

test("webhook: o número que recebeu define a empresa; mesmo telefone vira dois clientes com históricos separados; número desconhecido é ignorado", async () => {
  await withServer(async ({ webhook }) => {
    assert.equal((await webhook(webhookBody(PNID_MIBRO, `wamid.mt-m1-${Date.now()}`, "Oi Mibro"))).status, 200);
    assert.equal((await webhook(webhookBody(PNID_SINCRO, `wamid.mt-s1-${Date.now()}`, "Oi Sincrofit"))).status, 200);
    assert.equal((await webhook(webhookBody("PNID_DESCONHECIDO", `wamid.mt-x1-${Date.now()}`, "Quem sou eu?"))).status, 200);
  });
  const contacts = await prisma.contact.findMany({ where: { externalId: PHONE }, include: { conversations: { include: { messages: true } } } });
  assert.deepEqual(contacts.map((contact) => contact.companyId).sort(), [MIBRO, SINCROFIT].sort());
  const mibro = contacts.find((contact) => contact.companyId === MIBRO);
  const sincro = contacts.find((contact) => contact.companyId === SINCROFIT);
  assert.equal(mibro.conversations.length, 1);
  assert.equal(sincro.conversations.length, 1);
  fx.mibroConversation = mibro.conversations[0];
  fx.sincroConversation = sincro.conversations[0];
  assert.equal(fx.mibroConversation.companyId, MIBRO);
  assert.equal(fx.sincroConversation.companyId, SINCROFIT);
  assert.equal(fx.sincroConversation.channelAccountId, fx.sincroAccount.id);
  assert.equal(fx.mibroConversation.channelScope, "LEGACY");
  // Históricos não se misturam.
  assert.deepEqual(fx.mibroConversation.messages.map((message) => message.text), ["Oi Mibro"]);
  assert.deepEqual(fx.sincroConversation.messages.map((message) => message.text), ["Oi Sincrofit"]);
  // Número sem conta cadastrada nunca cai "por padrão" em empresa alguma.
  assert.equal(await prisma.message.count({ where: { text: "Quem sou eu?" } }), 0);
  await prisma.conversation.updateMany({
    where: { id: { in: [fx.mibroConversation.id, fx.sincroConversation.id] } },
    data: { status: "AGUARDANDO_EQUIPE" },
  });
  await prisma.conversation.update({ where: { id: fx.mibroConversation.id }, data: { categoryId: fx.mibroSupport.id } });
  await prisma.conversation.update({ where: { id: fx.sincroConversation.id }, data: { categoryId: fx.sincroSupport.id } });
});

test("Vendedor A (Mibro + Sincrofit): vê as duas, filtra por empresa e responde pelo número certo", async () => {
  await withServer(async ({ log, login, call }) => {
    const cookie = await login("venda");
    const companies = await (await call(cookie, "/api/companies")).json();
    assert.deepEqual(companies.companies.map((company) => company.slug).sort(), ["mibro", "sincrofit"]);

    const ids = async (query = "") => (await (await call(cookie, `/api/conversations${query}`)).json()).map((item) => item.id);
    const all = await ids();
    assert.ok(all.includes(fx.mibroConversation.id) && all.includes(fx.sincroConversation.id));
    const onlySincro = await ids("?company=sincrofit");
    assert.ok(onlySincro.includes(fx.sincroConversation.id) && !onlySincro.includes(fx.mibroConversation.id));
    const onlyMibro = await ids("?company=mibro");
    assert.ok(onlyMibro.includes(fx.mibroConversation.id) && !onlyMibro.includes(fx.sincroConversation.id));

    // Cada card/conversa traz empresa e número de origem.
    const detail = await (await call(cookie, `/api/conversations/${fx.sincroConversation.id}`)).json();
    assert.equal(detail.company.slug, "sincrofit");
    assert.equal(detail.channelAccount.displayNumber, "+55 11 4000-0000");
    assert.equal(detail.channelAccount.config, undefined, "config/segredos da conta nunca vão ao front");

    // Resposta sai pelo número da própria conversa.
    assert.equal((await call(cookie, `/api/conversations/${fx.sincroConversation.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Resposta Sincrofit" }) })).status, 201);
    assert.equal((await call(cookie, `/api/conversations/${fx.mibroConversation.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Resposta Mibro" }) })).status, 201);
    // (o texto enviado leva o prefixo da equipe — formatTeamMessage)
    assert.equal(log.find((entry) => entry.text?.endsWith("Resposta Sincrofit"))?.phoneNumberId, PNID_SINCRO);
    assert.ok(log.find((entry) => entry.text?.endsWith("Resposta Mibro"))?.phoneNumberId === PNID_MIBRO);

    // Categoria de outra empresa nunca entra na conversa.
    const wrongCategory = await call(cookie, `/api/conversations/${fx.sincroConversation.id}`, { method: "PATCH", body: JSON.stringify({ categoryId: fx.mibroSupport.id }) });
    assert.equal(wrongCategory.status, 400);
    // Lista de categorias traz a empresa de cada uma (o front oferece só as da conversa).
    const categories = await (await call(cookie, "/api/categories")).json();
    assert.equal(categories.find((category) => category.id === fx.sincroSupport.id)?.companyId, SINCROFIT);
  });
});

test("Vendedor B (só Mibro): Sincrofit não aparece em filtro, busca, API (IDOR), categorias, resumo, realtime nem relatórios", async () => {
  // A respondeu antes e virou responsável: devolve as duas à fila do setor.
  await prisma.conversation.updateMany({
    where: { id: { in: [fx.mibroConversation.id, fx.sincroConversation.id] } }, data: { assignedUserId: null, status: "AGUARDANDO_EQUIPE" },
  });
  await withServer(async ({ login, call }) => {
    const cookie = await login("vendb");
    const companies = await (await call(cookie, "/api/companies")).json();
    assert.deepEqual(companies.companies.map((company) => company.slug), ["mibro"]);

    const list = await (await call(cookie, "/api/conversations")).json();
    assert.ok(list.some((item) => item.id === fx.mibroConversation.id));
    assert.ok(!list.some((item) => item.companyId === SINCROFIT));
    const search = await (await call(cookie, `/api/conversations?search=${PHONE}`)).json();
    assert.deepEqual([...new Set(search.map((item) => item.companyId))], [MIBRO]);

    assert.equal((await call(cookie, "/api/conversations?company=sincrofit")).status, 403);
    // IDOR: descobrir o ID não adianta — 404, sem revelar que existe.
    assert.equal((await call(cookie, `/api/conversations/${fx.sincroConversation.id}`)).status, 404);
    assert.notEqual((await call(cookie, `/api/conversations/${fx.sincroConversation.id}/messages`, { method: "POST", body: JSON.stringify({ text: "invasão" }) })).status, 201);
    assert.notEqual((await call(cookie, `/api/conversations/${fx.sincroConversation.id}`, { method: "PATCH", body: JSON.stringify({ status: "FINALIZADO" }) })).status, 200);
    assert.equal(await prisma.message.count({ where: { text: { contains: "invasão" } } }), 0);

    const categories = await (await call(cookie, "/api/categories")).json();
    assert.ok(!categories.some((category) => category.companyId === SINCROFIT), "setor de empresa sem acesso nunca vale");
    const summary = await (await call(cookie, "/api/conversations/summary")).json();
    assert.equal(summary.openByCompany[SINCROFIT], undefined);
    assert.equal((await call(cookie, "/api/reports/conversations/summary")).status, 403);
  });
  // Realtime: conexão só-Mibro não recebe aviso da Sincrofit; Master recebe.
  assert.equal(inboxEvents.shouldReceive({ allCompanies: false, companyIds: new Set([MIBRO]) }, [SINCROFIT]), false);
  assert.equal(inboxEvents.shouldReceive({ allCompanies: false, companyIds: new Set([MIBRO]) }, [MIBRO]), true);
  assert.equal(inboxEvents.shouldReceive({ allCompanies: true, companyIds: null }, [SINCROFIT]), true);
  assert.deepEqual(await companyService.accessibleCompanyIds({ id: fx.vendB.id, role: "ATENDENTE" }), [MIBRO]);
});

test("Supervisor X: Supervisor na Mibro e Atendente na Sincrofit — cada empresa aplica o próprio cargo", async () => {
  const makeConversation = async (externalId, companyId, categoryId, assignedUserId) => {
    const contact = await prisma.contact.create({ data: { companyId, externalId, phone: externalId, name: externalId } });
    return prisma.conversation.create({ data: { companyId, contactId: contact.id, categoryId, assignedUserId, status: "EM_ATENDIMENTO", channelScope: "LEGACY" } });
  };
  const mibroAssigned = await makeConversation(`${PREFIX}sup-mibro`, MIBRO, fx.mibroSupport.id, fx.other.id);
  const sincroAssigned = await makeConversation(`${PREFIX}sup-sincro`, SINCROFIT, fx.sincroSupport.id, fx.other.id);
  const sincroQueue = await makeConversation(`${PREFIX}queue-sincro`, SINCROFIT, fx.sincroSupport.id, null);
  const viewer = { id: fx.supX.id, role: "SUPERVISOR", canViewUncategorized: true };

  const visible = (await inbox.listConversations({}, viewer)).map((item) => item.id);
  assert.ok(visible.includes(mibroAssigned.id), "Supervisor na Mibro acompanha o setor (inclui assumidas por outros)");
  assert.ok(!visible.includes(sincroAssigned.id), "na Sincrofit é Atendente: assumida por outro fica privada");
  assert.ok(visible.includes(sincroQueue.id), "fila do setor da Sincrofit continua visível");

  // Prioridade: Supervisor pode na Mibro; como Atendente na Sincrofit, não.
  const updated = await inbox.updateConversation(mibroAssigned.id, { priority: "ALTA" }, { ...viewer });
  assert.equal(updated.priority, "ALTA");
  await assert.rejects(() => inbox.updateConversation(sincroQueue.id, { priority: "ALTA" }, { ...viewer }), /prioridade/i);

  // Transferir conversa Sincrofit para quem não acessa a Sincrofit: bloqueado.
  await assert.rejects(
    () => inbox.updateConversation(sincroQueue.id, { assignedUserId: fx.vendB.id }, { id: fx.master.id, role: "ADMIN" }),
    /empresa/i,
  );
});

test("Master Global vê e filtra todas; preferência de filtro persiste e é revalidada ao perder acesso", async () => {
  const master = { id: fx.master.id, role: "ADMIN" };
  const all = (await inbox.listConversations({}, master)).map((item) => item.companyId);
  assert.ok(all.includes(MIBRO) && all.includes(SINCROFIT));
  const filtered = await inbox.listConversations({ company: "sincrofit" }, master);
  assert.ok(filtered.length && filtered.every((item) => item.companyId === SINCROFIT));

  const vendA = { id: fx.vendA.id, role: "ATENDENTE" };
  assert.equal(await companyService.setCompanyFilterPreference(vendA, "sincrofit"), "sincrofit");
  assert.equal(await companyService.getCompanyFilterPreference({ ...vendA }), "sincrofit");
  await assert.rejects(() => companyService.setCompanyFilterPreference({ id: fx.vendB.id, role: "ATENDENTE" }, "sincrofit"), /acesso/);
  await prisma.userCompanyAccess.updateMany({ where: { userId: fx.vendA.id, companyId: SINCROFIT }, data: { active: false } });
  assert.equal(await companyService.getCompanyFilterPreference({ ...vendA }), "ALL", "preferência nunca concede acesso");
  await prisma.userCompanyAccess.updateMany({ where: { userId: fx.vendA.id, companyId: SINCROFIT }, data: { active: true } });
});

test("respostas rápidas: GLOBAL em todas, COMPANY só na própria empresa; nunca oferece resposta da outra", async () => {
  const master = { id: fx.master.id, role: "ADMIN", name: "MT Master" };
  await quickReplies.createQuickReply({ scope: "GLOBAL", name: "Saudação MT", shortcut: "/mtsaudacao", text: "Olá!" }, master);
  const renova = await quickReplies.createQuickReply({ scope: "COMPANY", companyId: MIBRO, name: "Renova MT", shortcut: "/mtrenova", text: "Renova Mibro" }, master);
  await quickReplies.createQuickReply({ scope: "COMPANY", companyId: SINCROFIT, name: "Garantia MT", shortcut: "/mtgarantia", text: "Validar garantia" }, master);
  // Mesmo atalho em outra empresa é permitido; GLOBAL repetido não.
  await quickReplies.createQuickReply({ scope: "COMPANY", companyId: SINCROFIT, name: "Renova S MT", shortcut: "/mtrenova", text: "Outro texto" }, master);
  await assert.rejects(() => quickReplies.createQuickReply({ scope: "GLOBAL", name: "X", shortcut: "/mtrenova", text: "x" }, master), /atalho/);
  await assert.rejects(() => quickReplies.createQuickReply({ scope: "GLOBAL", name: "X", shortcut: "/mtsetor", text: "x", categoryId: fx.mibroSupport.id }, master), /setor/i);

  const vendA = { id: fx.vendA.id, role: "ATENDENTE", name: "MT venda", canViewUncategorized: true };
  const sincroItems = await quickReplies.listForComposer({ conversationId: fx.sincroConversation.id }, vendA);
  const forSincro = sincroItems.map((item) => item.shortcut);
  assert.ok(forSincro.includes("/mtsaudacao") && forSincro.includes("/mtgarantia"));
  // /mtrenova existe nas duas: na conversa Sincrofit só aparece a da Sincrofit.
  assert.ok(!sincroItems.some((item) => item.companyId === MIBRO), "nenhuma resposta da Mibro numa conversa Sincrofit");
  const forMibro = (await quickReplies.listForComposer({ conversationId: fx.mibroConversation.id }, vendA)).map((item) => item.shortcut);
  assert.ok(forMibro.includes("/mtrenova") && !forMibro.includes("/mtgarantia"));
  await assert.rejects(() => quickReplies.useQuickReply(renova.id, { conversationId: fx.sincroConversation.id }, vendA), /outra empresa/);
});

test("Bots: editor só oferece setores da empresa do Bot", async () => {
  const master = { id: fx.master.id, role: "ADMIN", name: "MT Master" };
  await assert.rejects(() => bots.createBot({ name: "MT Sem empresa", channels: ["META"] }, master), /empresa/i);
  const bot = await bots.createBot({ companyId: SINCROFIT, name: "MT Triagem Sincrofit", channels: ["META"] }, master);
  assert.equal(bot.companyId, SINCROFIT);
  const options = await getEditorOptions(bot.id, master);
  assert.equal(options.bot.company.slug, "sincrofit");
  assert.ok(options.categories.some((category) => category.id === fx.sincroSupport.id));
  assert.ok(!options.categories.some((category) => category.id === fx.mibroSupport.id));
  await assert.rejects(() => bots.updateBot(bot.id, { companyId: MIBRO }, master), /empresa/i);
  const sincroOnly = await bots.listBots(master, { company: "sincrofit" });
  assert.ok(sincroOnly.every((item) => item.companyId === SINCROFIT));
});

test("templates: cada número lista os templates da própria WABA", async () => {
  const log = [];
  const channel = new FakeMeta({}, log);
  const legacy = await prisma.channelAccount.findFirst({ where: { channel: "META", config: { path: ["legacyEnv"], equals: true } } });
  const sincro = await listApprovedTemplates(channel, fx.sincroAccount);
  const mibro = await listApprovedTemplates(channel, legacy);
  assert.equal(sincro[0].name, "tpl_WABA_SINCRO_MT");
  assert.equal(mibro[0].name, "tpl_WABA_MIBRO_MT");
});

test("opt-out é por empresa: sair da Mibro não bloqueia a Sincrofit", async () => {
  await optOut.registerOptOut({ companyId: MIBRO, phone: "5511988889999", source: "MANUAL" });
  assert.equal(await optOut.isOptedOut("5511988889999", MIBRO), true);
  assert.equal(await optOut.isOptedOut("5511988889999", SINCROFIT), false);
  await assert.rejects(() => optOut.isOptedOut("5511988889999"), /companyId/);
});

test("SLA por empresa: configuração própria da Sincrofit vale só para ela; Mibro segue a global", async () => {
  const settingsService = require("../src/services/conversation-settings-service");
  const { runSlaChecks } = require("../src/services/conversation-sla-service");
  const master = { id: fx.master.id, role: "ADMIN", name: "MT Master" };
  const global = await settingsService.getGlobalConversationSettings();
  assert.equal(global.firstResponseSlaEnabled, false, "pré-condição: SLA global desligado");
  const old = new Date(Date.now() - 30 * 60 * 1000);
  const make = async (externalId, companyId) => {
    const contact = await prisma.contact.create({ data: { companyId, externalId, phone: externalId, name: externalId } });
    return prisma.conversation.create({ data: { companyId, contactId: contact.id, status: "NOVO", channelScope: "LEGACY", lastMessageAt: old } });
  };
  const sincro = await make(`${PREFIX}sla-sincro`, SINCROFIT);
  const mibro = await make(`${PREFIX}sla-mibro`, MIBRO);
  try {
    const saved = await settingsService.updateConversationSettings({ company: "sincrofit", firstResponseSlaEnabled: true, firstResponseSlaMinutes: 5 }, master);
    assert.equal(saved.isCompanyOverride, true);
    assert.equal((await settingsService.getGlobalConversationSettings()).firstResponseSlaEnabled, false, "global intacta");
    await runSlaChecks();
    assert.equal((await prisma.conversation.findUnique({ where: { id: sincro.id } })).firstResponseSlaBreached, true);
    assert.equal((await prisma.conversation.findUnique({ where: { id: mibro.id } })).firstResponseSlaBreached, false);
    const view = await settingsService.getConversationSettingsForViewer(master, { company: "mibro" });
    assert.equal(view.isCompanyOverride, false, "Mibro herda a global");
    const reset = await settingsService.resetCompanyConversationSettings("sincrofit", master);
    assert.equal(reset.isCompanyOverride, false);
  } finally {
    await prisma.conversationSettings.deleteMany({ where: { companyId: { not: null } } });
    settingsService.invalidateCache();
    await prisma.contact.deleteMany({ where: { externalId: { in: [`${PREFIX}sla-sincro`, `${PREFIX}sla-mibro`] } } });
  }
});

test("permissões por empresa: recalculadas pelo cargo da empresa e personalizáveis por empresa", async () => {
  const auth = require("../src/services/auth-service");
  const authorization = require("../src/services/authorization-service");
  const users = require("../src/services/user-management-service");
  const master = { id: fx.master.id, role: "ADMIN", name: "MT Master" };
  // Supervisor X: Supervisor (padrão) na Mibro, Atendente na Sincrofit.
  const asRequestUser = async (id) => auth.publicUser(await prisma.user.findUnique({ where: { id } }));
  let viewer = await asRequestUser(fx.supX.id);
  assert.equal((await companyService.userForCompany(viewer, MIBRO)).canManageCampaigns, true);
  assert.equal((await companyService.userForCompany(viewer, SINCROFIT)).canManageCampaigns, false,
    "cargo Atendente na Sincrofit não herda permissão calculada com o cargo padrão");

  // Vendedor A: libera transferir SÓ na Sincrofit.
  await users.updateUser(fx.vendA.id, { companyAccess: [
    { companyId: MIBRO },
    { companyId: SINCROFIT, permissions: { canTransferConversations: true, ignorada: true } },
  ] }, fx.master.id, master);
  viewer = await asRequestUser(fx.vendA.id);
  assert.equal(authorization.canTransfer(await companyService.userForCompany(viewer, SINCROFIT)), true);
  assert.equal(authorization.canTransfer(await companyService.userForCompany(viewer, MIBRO)), false);
  const stored = await prisma.userCompanyAccess.findFirst({ where: { userId: fx.vendA.id, companyId: SINCROFIT } });
  assert.deepEqual(stored.permissions, { canTransferConversations: true }, "só flags conhecidas são gravadas");
  await assert.rejects(() => users.updateUser(fx.vendA.id, { companyAccess: [{ companyId: MIBRO, permissions: { canMergeContacts: "sim" } }] }, fx.master.id, master), /verdadeiro ou falso/);
  // Restaura o cenário dos demais testes.
  await users.updateUser(fx.vendA.id, { companyAccess: [{ companyId: MIBRO }, { companyId: SINCROFIT }] }, fx.master.id, master);
});

test("áudios rápidos: da empresa só na empresa; pessoal pode ser restrito a uma empresa", async () => {
  const { webmSample } = require("./support/audio");
  const master = { id: fx.master.id, role: "ADMIN", name: "MT Master" };
  const vendA = { id: fx.vendA.id, role: "ATENDENTE", name: "MT venda", canViewUncategorized: true };
  const file = () => ({ buffer: webmSample(), originalname: "audio.webm", mimetype: "audio/webm" });
  const created = [];
  try {
    created.push(await quickReplies.createManagedAudio({ scope: "COMPANY", companyId: SINCROFIT, name: "Áudio garantia MT", shortcut: "/mtaudiogarantia" }, file(), master));
    created.push(await quickReplies.createManagedAudio({ scope: "GLOBAL", name: "Áudio olá MT", shortcut: "/mtaudioola" }, file(), master));
    created.push(await quickReplies.createPersonalAudio({ name: "Meu áudio Mibro MT", shortcut: "/mtaudiomeu", companyId: MIBRO }, file(), vendA));
    await assert.rejects(() => quickReplies.createManagedAudio({ scope: "COMPANY", companyId: SINCROFIT, name: "x", shortcut: "/mtaudiox" }, file(), vendA), /Master/);
    const shortcutsFor = async (conversationId) => (await quickReplies.listForComposer({ conversationId }, vendA)).map((item) => item.shortcut);
    const sincro = await shortcutsFor(fx.sincroConversation.id);
    const mibro = await shortcutsFor(fx.mibroConversation.id);
    assert.ok(sincro.includes("/mtaudiogarantia") && sincro.includes("/mtaudioola") && !sincro.includes("/mtaudiomeu"));
    assert.ok(!mibro.includes("/mtaudiogarantia") && mibro.includes("/mtaudioola") && mibro.includes("/mtaudiomeu"));
    // Arquivo do áudio da Sincrofit: 404 para quem só acessa a Mibro.
    await assert.rejects(() => quickReplies.getQuickReplyAudio(created[0].id, { id: fx.vendB.id, role: "ATENDENTE" }), /não encontrado/i);
  } finally {
    const rows = await prisma.quickReply.findMany({ where: { id: { in: created.map((item) => item.id) } }, select: { mediaStorageKey: true } });
    await prisma.quickReply.deleteMany({ where: { id: { in: created.map((item) => item.id) } } });
    const { removeImage } = require("../src/services/media-storage-service");
    for (const row of rows) if (row.mediaStorageKey) await removeImage(row.mediaStorageKey).catch(() => {});
  }
});
