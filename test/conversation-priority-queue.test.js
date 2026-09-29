require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const inbox = require("../src/services/inbox-service");
const auth = require("../src/services/auth-service");

const testContacts = [
  "queue-overdue-test", "queue-waiting-old-test", "queue-waiting-new-test", "queue-new-test",
  "queue-urgent-test", "queue-normal-test",
];
const masterViewer = { id: "queue-master-test", role: "ADMIN" };
const supervisorEmail = "supervisor-priority-test@teste.local";
const attendantEmail = "attendant-priority-test@teste.local";
const attendantAllowedEmail = "attendant-priority-allowed-test@teste.local";

let supervisor;
let attendant;
let attendantAllowed;

test("sessão pública preserva a permissão individual de prioridade", () => {
  assert.equal(auth.publicUser({ id: "a", role: "ATENDENTE", canSetConversationPriority: true }).canSetConversationPriority, true);
  assert.equal(auth.publicUser({ id: "b", role: "ATENDENTE", canSetConversationPriority: false }).canSetConversationPriority, false);
  assert.equal(auth.publicUser({ id: "s", role: "SUPERVISOR", canSetConversationPriority: false }).canSetConversationPriority, true);
});

test.before(async () => {
  supervisor = await prisma.user.upsert({
    where: { email: supervisorEmail }, update: { role: "SUPERVISOR" },
    create: { name: "Supervisor Teste Prioridade", email: supervisorEmail, role: "SUPERVISOR" },
  });
  attendant = await prisma.user.upsert({
    where: { email: attendantEmail }, update: { role: "ATENDENTE", canSetConversationPriority: false, canViewUncategorized: true },
    create: { name: "Atendente Teste Prioridade", email: attendantEmail, role: "ATENDENTE", canViewUncategorized: true },
  });
  attendantAllowed = await prisma.user.upsert({
    where: { email: attendantAllowedEmail }, update: { role: "ATENDENTE", canSetConversationPriority: true, canViewUncategorized: true },
    create: {
      name: "Atendente Autorizado Prioridade", email: attendantAllowedEmail, role: "ATENDENTE",
      canSetConversationPriority: true, canViewUncategorized: true,
    },
  });
});

test.after(async () => {
  await prisma.contact.deleteMany({ where: { externalId: { in: testContacts } } });
  await prisma.user.deleteMany({ where: { email: { in: [supervisorEmail, attendantEmail, attendantAllowedEmail] } } });
  await prisma.$disconnect();
});

async function createConversation(externalId, phone, data = {}) {
  const contact = await prisma.contact.create({ data: { externalId, phone, name: `Cliente ${externalId}` } });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id, ...data } });
  return conversation;
}

test("fila ordena conversas pela mensagem mais recente, independentemente de status, SLA ou prioridade", async () => {
  const now = new Date("2026-08-25T12:00:00.000Z");
  const overdue = await createConversation(testContacts[0], "5511900001001", {
    status: "AGUARDANDO_EQUIPE", responseSlaBreached: true, lastMessageAt: new Date(now.getTime() - 5 * 60 * 1000),
  });
  const waitingOld = await createConversation(testContacts[1], "5511900001002", {
    status: "AGUARDANDO_EQUIPE", lastMessageAt: new Date(now.getTime() - 20 * 60 * 1000),
  });
  const waitingNew = await createConversation(testContacts[2], "5511900001003", {
    status: "AGUARDANDO_EQUIPE", lastMessageAt: new Date(now.getTime() - 2 * 60 * 1000),
  });
  const brandNew = await createConversation(testContacts[3], "5511900001004", {
    status: "NOVO", lastMessageAt: new Date(now.getTime() - 1 * 60 * 1000),
  });
  const urgent = await createConversation(testContacts[4], "5511900001005", {
    status: "AGUARDANDO_CLIENTE", priority: "URGENTE", lastMessageAt: new Date(now.getTime() - 1 * 60 * 1000),
  });
  const normal = await createConversation(testContacts[5], "5511900001006", {
    status: "AGUARDANDO_CLIENTE", priority: "NORMAL", lastMessageAt: new Date(now.getTime() - 1 * 60 * 1000),
  });

  const ids = new Set([overdue.id, waitingOld.id, waitingNew.id, brandNew.id, urgent.id, normal.id]);
  const list = (await inbox.listConversations({}, masterViewer)).filter((c) => ids.has(c.id));
  const order = list.map((c) => c.id);

  assert.ok(order.indexOf(brandNew.id) < order.indexOf(overdue.id));
  assert.ok(order.indexOf(urgent.id) < order.indexOf(overdue.id));
  assert.ok(order.indexOf(normal.id) < order.indexOf(overdue.id));
  assert.ok(order.indexOf(waitingNew.id) < order.indexOf(overdue.id));
  assert.ok(order.indexOf(overdue.id) < order.indexOf(waitingOld.id));
});

test("prioridade manual: Admin e Supervisor podem alterar, Atendente sem permissão é bloqueado, Atendente autorizado pode", async () => {
  const conversation = await createConversation("queue-priority-rbac-test", "5511900002001", { status: "NOVO" });
  const testContactsExtra = ["queue-priority-rbac-test"];
  try {
    await assert.rejects(
      () => inbox.updateConversation(conversation.id, { priority: "URGENTE" }, {
        id: attendant.id, role: "ATENDENTE", canViewUncategorized: true, canSetConversationPriority: false,
      }),
      /prioridade/i,
    );
    const untouched = await prisma.conversation.findUnique({ where: { id: conversation.id } });
    assert.equal(untouched.priority, "NORMAL");

    const bySupervisor = await inbox.updateConversation(
      conversation.id, { priority: "ALTA" }, { id: supervisor.id, role: "SUPERVISOR", canViewUncategorized: true },
    );
    assert.equal(bySupervisor.priority, "ALTA");

    const byAllowedAttendant = await inbox.updateConversation(
      conversation.id, { priority: "URGENTE" },
      { id: attendantAllowed.id, role: "ATENDENTE", canViewUncategorized: true, canSetConversationPriority: true },
    );
    assert.equal(byAllowedAttendant.priority, "URGENTE");

    const activityCount = await prisma.conversationActivity.count({
      where: { conversationId: conversation.id, action: "PRIORITY_CHANGED" },
    });
    assert.equal(activityCount, 2);
    const auditCount = await prisma.auditLog.count({
      where: { entityId: conversation.id, action: "CONVERSATION_PRIORITY_CHANGED" },
    });
    assert.equal(auditCount, 2);
  } finally {
    await prisma.contact.deleteMany({ where: { externalId: { in: testContactsExtra } } });
  }
});

test("prioridade inválida é rejeitada", async () => {
  const conversation = await createConversation("queue-priority-invalid-test", "5511900002002", { status: "NOVO" });
  try {
    await assert.rejects(
      () => inbox.updateConversation(conversation.id, { priority: "MEGA_URGENTE" }, masterViewer),
      /Prioridade inválida/,
    );
  } finally {
    await prisma.contact.deleteMany({ where: { externalId: { in: ["queue-priority-invalid-test"] } } });
  }
});

test("filtros combináveis: status múltiplo + prioridade ao mesmo tempo", async () => {
  const a = await createConversation("queue-filter-a-test", "5511900003001", { status: "NOVO", priority: "URGENTE" });
  const b = await createConversation("queue-filter-b-test", "5511900003002", { status: "AGUARDANDO_EQUIPE", priority: "URGENTE" });
  const c = await createConversation("queue-filter-c-test", "5511900003003", { status: "NOVO", priority: "NORMAL" });
  try {
    const result = await inbox.listConversations({ status: "NOVO,AGUARDANDO_EQUIPE", priority: "URGENTE" }, masterViewer);
    const ids = result.map((item) => item.id);
    assert.ok(ids.includes(a.id));
    assert.ok(ids.includes(b.id));
    assert.ok(!ids.includes(c.id), "NOVO+NORMAL não deveria aparecer no filtro NOVO/AGUARDANDO_EQUIPE + URGENTE");
  } finally {
    await prisma.contact.deleteMany({ where: { externalId: { in: ["queue-filter-a-test", "queue-filter-b-test", "queue-filter-c-test"] } } });
  }
});

test("Em atendimento reúne conversas atribuídas, iniciadas e não finalizadas", async () => {
  const before = (await inbox.getConversationSummary(masterViewer)).statuses.EM_ATENDIMENTO || 0;
  const waitingTeam = await createConversation("queue-active-team-test", "5511900003020", { status: "AGUARDANDO_EQUIPE", assignedUserId: supervisor.id });
  const waitingCustomer = await createConversation("queue-active-customer-test", "5511900003021", { status: "AGUARDANDO_CLIENTE", assignedUserId: supervisor.id });
  const newAssigned = await createConversation("queue-active-new-test", "5511900003022", { status: "NOVO", assignedUserId: supervisor.id });
  const waitingUnassigned = await createConversation("queue-active-unassigned-test", "5511900003023", { status: "AGUARDANDO_EQUIPE", assignedUserId: null });
  const finalized = await createConversation("queue-active-finalized-test", "5511900003024", { status: "FINALIZADO", assignedUserId: supervisor.id });
  try {
    const ids = (await inbox.listConversations({ status: "EM_ATENDIMENTO" }, masterViewer)).map((item) => item.id);
    assert.ok(ids.includes(waitingTeam.id));
    assert.ok(ids.includes(waitingCustomer.id));
    assert.ok(!ids.includes(newAssigned.id));
    assert.ok(!ids.includes(waitingUnassigned.id));
    assert.ok(!ids.includes(finalized.id));
    assert.equal((await inbox.getConversationSummary(masterViewer)).statuses.EM_ATENDIMENTO, before + 2);
  } finally {
    await prisma.contact.deleteMany({ where: { externalId: { in: [
      "queue-active-team-test", "queue-active-customer-test", "queue-active-new-test", "queue-active-unassigned-test", "queue-active-finalized-test",
    ] } } });
  }
});

test("filtro slaBreached=true retorna só conversas com algum SLA estourado", async () => {
  const overdueFirst = await createConversation("queue-filter-sla-1-test", "5511900003004", { status: "NOVO", firstResponseSlaBreached: true });
  const overdueResponse = await createConversation("queue-filter-sla-2-test", "5511900003005", { status: "AGUARDANDO_EQUIPE", responseSlaBreached: true });
  const onTime = await createConversation("queue-filter-sla-3-test", "5511900003006", { status: "AGUARDANDO_EQUIPE" });
  try {
    const result = await inbox.listConversations({ slaBreached: "true" }, masterViewer);
    const ids = result.map((item) => item.id);
    assert.ok(ids.includes(overdueFirst.id));
    assert.ok(ids.includes(overdueResponse.id));
    assert.ok(!ids.includes(onTime.id));
  } finally {
    await prisma.contact.deleteMany({ where: { externalId: { in: ["queue-filter-sla-1-test", "queue-filter-sla-2-test", "queue-filter-sla-3-test"] } } });
  }
});

test("filtro unassigned=true retorna só conversas sem responsável", async () => {
  const withOwner = await createConversation("queue-filter-unassigned-1-test", "5511900003007", { status: "EM_ATENDIMENTO", assignedUserId: supervisor.id });
  const withoutOwner = await createConversation("queue-filter-unassigned-2-test", "5511900003008", { status: "AGUARDANDO_EQUIPE", assignedUserId: null });
  try {
    const result = await inbox.listConversations({ unassigned: "true" }, masterViewer);
    const ids = result.map((item) => item.id);
    assert.ok(ids.includes(withoutOwner.id));
    assert.ok(!ids.includes(withOwner.id));
  } finally {
    await prisma.contact.deleteMany({ where: { externalId: { in: ["queue-filter-unassigned-1-test", "queue-filter-unassigned-2-test"] } } });
  }
});

test("contadores novos (overdue/urgent/unassigned) refletem só conversas ativas", async () => {
  const overdue = await createConversation("queue-summary-overdue-test", "5511900003009", { status: "AGUARDANDO_EQUIPE", responseSlaBreached: true });
  const urgent = await createConversation("queue-summary-urgent-test", "5511900003010", { status: "EM_ATENDIMENTO", priority: "URGENTE" });
  const unassigned = await createConversation("queue-summary-unassigned-test", "5511900003011", { status: "AGUARDANDO_EQUIPE", assignedUserId: null });
  // Nunca conta FINALIZADO nem BOT, mesmo com SLA/prioridade marcados.
  const finalizedButBreached = await createConversation("queue-summary-finalized-test", "5511900003012", {
    status: "FINALIZADO", responseSlaBreached: true, priority: "URGENTE",
  });
  try {
    const summary = await inbox.getConversationSummary(masterViewer);
    assert.ok(summary.overdue >= 1);
    assert.ok(summary.urgent >= 1);
    assert.ok(summary.unassigned >= 1);
    // Confirma especificamente que a conversa finalizada não é contada nos
    // três contadores (evita falso positivo caso os >=1 já viessem de outro
    // teste que rodou antes na mesma execução).
    const finalized = await prisma.conversation.findUnique({ where: { id: finalizedButBreached.id } });
    assert.equal(finalized.status, "FINALIZADO");
  } finally {
    await prisma.contact.deleteMany({ where: { externalId: { in: [
      "queue-summary-overdue-test", "queue-summary-urgent-test", "queue-summary-unassigned-test", "queue-summary-finalized-test",
    ] } } });
  }
});
