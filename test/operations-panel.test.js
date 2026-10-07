// Central de Operação: escopo Supervisor x Master por empresa, indicadores,
// "precisa de atenção", equipe/presença — e nenhum conteúdo de mensagem.
require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const ops = require("../src/services/operations-panel-service");

const emailDomain = "@operacao.test";
const contactPrefix = "ops-test-";
const codePrefix = "OPS_TEST";
let seq = 0;
let mibroSector;
let sincroSector;
let financeiro;

async function cleanup() {
  const contacts = await prisma.contact.findMany({ where: { externalId: { startsWith: contactPrefix } }, select: { id: true } });
  await prisma.contact.deleteMany({ where: { id: { in: contacts.map(({ id }) => id) } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: emailDomain } } });
  await prisma.category.deleteMany({ where: { code: { startsWith: codePrefix } } });
}

async function createUser(name, { role = "ATENDENTE", access = [{ companyId: "cmp_mibro" }], categories = [] } = {}) {
  seq += 1;
  return prisma.user.create({ data: {
    name, email: `ops${seq}-${Date.now()}${emailDomain}`, role,
    companyAccess: { create: access },
    categoryAccess: { create: categories.map(({ id }) => ({ categoryId: id })) },
  } });
}

async function conversation(label, { companyId = "cmp_mibro", categoryId = null, assignedUserId = null, status = "AGUARDANDO_EQUIPE", minutesAgo = 5, contact = {}, ...extra } = {}) {
  const created = await prisma.contact.create({ data: {
    companyId, externalId: `${contactPrefix}${label}-${Date.now()}-${seq++}`, phone: `5511${String(Date.now()).slice(-9)}`, name: `Cliente ${label}`, ...contact,
  } });
  const lastMessageAt = new Date(Date.now() - minutesAgo * 60000);
  const row = await prisma.conversation.create({ data: { companyId, contactId: created.id, categoryId, assignedUserId, status, lastMessageAt, ...extra } });
  await prisma.message.create({ data: { conversationId: row.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text", text: `SEGREDO-${label}`, occurredAt: lastMessageAt } });
  return row;
}

test.before(async () => {
  await cleanup();
  mibroSector = await prisma.category.create({ data: { companyId: "cmp_mibro", code: `${codePrefix}_M_${Date.now()}`, name: "Vendas Ops" } });
  sincroSector = await prisma.category.create({ data: { companyId: "cmp_sincrofit", code: `${codePrefix}_S_${Date.now()}`, name: "Vendas Ops S" } });
  financeiro = await prisma.category.create({ data: { companyId: "cmp_mibro", code: `${codePrefix}_F_${Date.now()}`, name: "Financeiro", visibilityMode: "SECTOR_PRIVATE" } });
});
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("Atendente não acessa; Supervisor só a empresa/setor que supervisiona; Master vê tudo", async () => {
  // Ana: Supervisor na Mibro, Atendente na Sincrofit (cargo por empresa).
  const ana = await createUser("Ana Ops", { access: [{ companyId: "cmp_mibro", role: "SUPERVISOR" }, { companyId: "cmp_sincrofit", role: "ATENDENTE" }], categories: [mibroSector, sincroSector] });
  const carlos = await createUser("Carlos Ops", { categories: [mibroSector] });
  const master = await createUser("Master Ops", { role: "ADMIN" });
  const agent = await createUser("Atendente Ops", { categories: [mibroSector] });
  const mibro = await conversation("mibro", { categoryId: mibroSector.id, assignedUserId: carlos.id });
  const queue = await conversation("fila", { categoryId: mibroSector.id });
  const sincro = await conversation("sincro", { companyId: "cmp_sincrofit", categoryId: sincroSector.id });

  await assert.rejects(() => ops.getOverview(agent, {}), { statusCode: 403 });
  assert.equal(await ops.canOpenPanel(agent), false);
  assert.equal(await ops.canOpenPanel(ana), true);

  const anaView = await ops.getOverview(ana, {}, { onlineUserIds: new Set() });
  assert.deepEqual(anaView.companyIds, ["cmp_mibro"]);
  const anaIds = anaView.attention.items.map(({ conversationId }) => conversationId);
  assert.ok(anaIds.includes(queue.id), "vê a fila da Mibro, onde é Supervisora");
  assert.equal(anaIds.includes(sincro.id), false, "nunca a Sincrofit, onde Ana é atendente");
  await assert.rejects(() => ops.getOverview(ana, { company: "sincrofit" }), { statusCode: 403 });
  assert.ok(anaView.team.some(({ id }) => id === carlos.id));

  const masterView = await ops.getOverview(master, { categoryId: sincroSector.id }, { onlineUserIds: new Set() });
  assert.ok(masterView.attention.items.some(({ conversationId }) => conversationId === sincro.id));
  const masterMibro = await ops.getOverview(master, { company: "mibro", categoryId: mibroSector.id }, { onlineUserIds: new Set() });
  assert.equal(masterMibro.cards.open, 2);
  assert.equal(masterMibro.cards.waitingService, 2);
  assert.equal(masterMibro.cards.unassigned, 1);
  assert.ok(masterMibro.team.some(({ id, open }) => id === carlos.id && open === 1));
  assert.ok(mibro);
});

test("indicadores e 'precisa de atenção': SLA, cliente fixo, setor protegido, sem categoria — sem conteúdo de mensagem", async () => {
  const master = await createUser("Master Ops 2", { role: "ADMIN" });
  const carlos = await createUser("Carlos Fixo Ops", { categories: [mibroSector] });
  const ana = await createUser("Ana Fin Ops", { categories: [financeiro] });
  const breached = await conversation("sla", { categoryId: mibroSector.id, assignedUserId: carlos.id, responseSlaBreached: true, minutesAgo: 90 });
  const fixed = await conversation("fixo", { categoryId: mibroSector.id, assignedUserId: carlos.id, minutesAgo: 18, contact: { preferredAssigneeId: carlos.id, preferredAssigneeEnabled: true } });
  const fin = await conversation("fin", { categoryId: financeiro.id, assignedUserId: ana.id, minutesAgo: 32 });
  await conversation("finalizada", { categoryId: mibroSector.id, status: "FINALIZADO", finalizedAt: new Date() });

  const view = await ops.getOverview(master, { company: "mibro", categoryId: mibroSector.id }, { onlineUserIds: new Set([carlos.id]) });
  assert.equal(view.cards.slaCritical, 1);
  assert.equal(view.cards.preferredWaiting, 1);
  assert.equal(view.cards.finalizedToday, 1);
  assert.equal(view.attention.items[0].conversationId, breached.id, "vermelho primeiro");
  assert.equal(view.attention.items[0].severity, "critical");
  const fixedItem = view.attention.items.find(({ conversationId }) => conversationId === fixed.id);
  assert.equal(fixedItem.reason, "PREFERRED_WAITING");
  assert.equal(fixedItem.preferredAssignee.name, "Carlos Fixo Ops");
  assert.ok(fixedItem.waitingMinutes >= 17);
  const carlosRow = view.team.find(({ id }) => id === carlos.id);
  assert.equal(carlosRow.online, true);
  assert.equal(carlosRow.slaCritical, 1);

  const finView = await ops.getOverview(master, { categoryId: financeiro.id }, { onlineUserIds: new Set() });
  assert.equal(finView.cards.privateSectorPending, 1);
  const finItem = finView.attention.items.find(({ conversationId }) => conversationId === fin.id);
  assert.equal(finItem.reason, "PRIVATE_WAITING");
  assert.equal(finItem.privateSector, true);

  const uncategorized = await conversation("semcat", { status: "NOVO" });
  const all = await ops.getOverview(master, { categoryId: "UNCATEGORIZED" }, { onlineUserIds: new Set() });
  assert.ok(all.attention.items.some(({ conversationId, reason }) => conversationId === uncategorized.id && ["UNCATEGORIZED", "SLA_NEAR", "SLA_BREACHED"].includes(reason)));

  // Paginação do "precisa de atenção".
  const page = await ops.getOverview(master, { company: "mibro", categoryId: mibroSector.id, attentionLimit: 1 }, { onlineUserIds: new Set() });
  assert.equal(page.attention.items.length, 1);
  assert.ok(page.attention.total >= 2);

  // Nenhum texto de mensagem sai do painel (inclui o Financeiro).
  for (const payload of [view, finView, all]) assert.equal(JSON.stringify(payload).includes("SEGREDO"), false);
});

test("SLA próximo do limite e início do dia no fuso da operação", () => {
  const now = new Date("2026-10-07T15:00:00Z");
  const settings = { responseSlaEnabled: true, responseSlaMinutes: 10, firstResponseSlaEnabled: false, slaNearBreachPercent: 80 };
  const base = { status: "AGUARDANDO_EQUIPE", firstResponseSlaBreached: false, responseSlaBreached: false, createdAt: now };
  assert.equal(ops.slaState({ ...base, lastMessageAt: new Date(now - 9 * 60000) }, settings, now), "NEAR");
  assert.equal(ops.slaState({ ...base, lastMessageAt: new Date(now - 3 * 60000) }, settings, now), "OK");
  assert.equal(ops.slaState({ ...base, lastMessageAt: new Date(now - 11 * 60000) }, settings, now), "BREACHED");
  assert.equal(ops.startOfToday(new Date("2026-10-07T02:00:00Z")).toISOString(), "2026-10-06T03:00:00.000Z");
});

test("HTTP: /operacao e /api/operations só para Supervisor/Master", async () => {
  const bcrypt = require("bcryptjs");
  const { createApp } = require("../src/app");
  const passwordHash = await bcrypt.hash("senha-operacao-123", 4);
  const agent = await createUser("HTTP Atendente Ops");
  const supervisor = await createUser("HTTP Supervisor Ops", { access: [{ companyId: "cmp_mibro", role: "SUPERVISOR" }], categories: [mibroSector] });
  await prisma.user.updateMany({ where: { id: { in: [agent.id, supervisor.id] } }, data: { passwordHash } });
  const server = createApp({ channel: {} }).listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = async (email) => {
      const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "senha-operacao-123" }) });
      assert.equal(response.status, 200);
      return response.headers.get("set-cookie").split(";")[0];
    };
    const agentCookie = await login(agent.email);
    const supervisorCookie = await login(supervisor.email);
    assert.equal((await fetch(`${base}/operacao`, { headers: { Cookie: agentCookie }, redirect: "manual" })).status, 403);
    assert.equal((await fetch(`${base}/api/operations/overview`, { headers: { Cookie: agentCookie } })).status, 403);
    assert.equal((await fetch(`${base}/operacao`, { headers: { Cookie: supervisorCookie }, redirect: "manual" })).status, 200);
    const overview = await fetch(`${base}/api/operations/overview`, { headers: { Cookie: supervisorCookie } });
    assert.equal(overview.status, 200);
    assert.deepEqual((await overview.json()).companyIds, ["cmp_mibro"]);
    const options = await (await fetch(`${base}/api/operations/options`, { headers: { Cookie: supervisorCookie } })).json();
    assert.ok(options.categories.every(({ companyId }) => companyId === "cmp_mibro"));
  } finally {
    server.close();
  }
});
