require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const settingsService = require("../src/services/conversation-settings-service");

const testEmails = ["admin-cs@test.local", "sup-cs@test.local", "at-cs@test.local"];

let originalSettings;
let admin;
let supervisor;
let attendant;

test.before(async () => {
  originalSettings = await settingsService.getConversationSettings();
  [admin, supervisor, attendant] = await Promise.all([
    prisma.user.create({ data: { companyAccess: { create: { companyId: "cmp_mibro" } }, name: "Admin Teste", email: testEmails[0], role: "ADMIN" } }),
    prisma.user.create({ data: { companyAccess: { create: { companyId: "cmp_mibro" } }, name: "Supervisor Teste", email: testEmails[1], role: "SUPERVISOR" } }),
    prisma.user.create({ data: { companyAccess: { create: { companyId: "cmp_mibro" } }, name: "Atendente Teste", email: testEmails[2], role: "ATENDENTE" } }),
  ]);
});

test.after(async () => {
  // Restaura o singleton para não vazar estado de teste para outros arquivos
  // (a suíte roda serial, mas em arquivos separados, e o singleton é global).
  await prisma.conversationSettings.update({
    where: { id: "singleton" },
    data: {
      firstResponseSlaEnabled: originalSettings.firstResponseSlaEnabled,
      firstResponseSlaMinutes: originalSettings.firstResponseSlaMinutes,
      responseSlaEnabled: originalSettings.responseSlaEnabled,
      responseSlaMinutes: originalSettings.responseSlaMinutes,
      unansweredConversationAlertEnabled: originalSettings.unansweredConversationAlertEnabled,
      unansweredConversationAlertMinutes: originalSettings.unansweredConversationAlertMinutes,
      stalledConversationAlertEnabled: originalSettings.stalledConversationAlertEnabled,
      stalledConversationAlertMinutes: originalSettings.stalledConversationAlertMinutes,
      botContextTtlMinutes: originalSettings.botContextTtlMinutes,
      botResumeAfterHumanEnabled: originalSettings.botResumeAfterHumanEnabled,
      botResumeAfterHumanMinutes: originalSettings.botResumeAfterHumanMinutes,
      reopenConversationOnCustomerMessage: originalSettings.reopenConversationOnCustomerMessage,
      reopenWindowMinutes: originalSettings.reopenWindowMinutes,
      slaBusinessHoursOnly: originalSettings.slaBusinessHoursOnly,
      autoFinalizationEnabled: originalSettings.autoFinalizationEnabled,
      autoFinalizationMinutes: originalSettings.autoFinalizationMinutes,
    },
  });
  settingsService.invalidateCache();
  await prisma.auditLog.deleteMany({ where: { actorUserId: admin.id } });
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

test("defaults corretos no primeiro getConversationSettings()", async () => {
  const settings = await settingsService.getConversationSettings();
  assert.equal(settings.id, "singleton");
  assert.equal(typeof settings.firstResponseSlaEnabled, "boolean");
  assert.equal(typeof settings.reopenConversationOnCustomerMessage, "boolean");
  assert.equal(settings.reopenConversationOnCustomerMessage, true);
});

test("criação concorrente do singleton não gera erro P2002", async () => {
  await prisma.conversationSettings.deleteMany({ where: { id: "singleton" } });
  settingsService.invalidateCache();

  const results = await Promise.all(
    Array.from({ length: 8 }, () => settingsService.getConversationSettings()),
  );

  assert.equal(results.length, 8);
  assert.ok(results.every((settings) => settings.id === "singleton"));
  assert.equal(await prisma.conversationSettings.count({ where: { id: "singleton" } }), 1);
});

test("updateConversationSettings rejeita não-Admin, incluindo Supervisor", async () => {
  await assert.rejects(
    () => settingsService.updateConversationSettings({ firstResponseSlaMinutes: 5 }, attendant),
    (error) => error.statusCode === 403,
  );
  await assert.rejects(
    () => settingsService.updateConversationSettings({ firstResponseSlaMinutes: 5 }, supervisor),
    (error) => error.statusCode === 403,
  );
});

test("getConversationSettingsForViewer permite Admin e Supervisor, rejeita Atendente", async () => {
  await settingsService.getConversationSettingsForViewer(admin);
  await settingsService.getConversationSettingsForViewer(supervisor);
  await assert.rejects(
    () => settingsService.getConversationSettingsForViewer(attendant),
    (error) => error.statusCode === 403,
  );
});

test("valida faixa de valores numéricos por campo", async () => {
  await assert.rejects(
    () => settingsService.updateConversationSettings({ firstResponseSlaMinutes: 0 }, admin),
    /entre/,
  );
  await assert.rejects(
    () => settingsService.updateConversationSettings({ responseSlaMinutes: 5000 }, admin),
    /entre/,
  );
  await assert.rejects(
    () => settingsService.updateConversationSettings({ reopenWindowMinutes: -1 }, admin),
    /reopenWindowMinutes/,
  );
});

test("reopenWindowMinutes aceita null explicitamente (janela opcional)", async () => {
  const settings = await settingsService.updateConversationSettings({ reopenWindowMinutes: 60 }, admin);
  assert.equal(settings.reopenWindowMinutes, 60);
  const cleared = await settingsService.updateConversationSettings({ reopenWindowMinutes: null }, admin);
  assert.equal(cleared.reopenWindowMinutes, null);
});

test("updateConversationSettings grava before/after em AuditLog, sem secrets, e Admin pode editar", async () => {
  const before = await settingsService.getConversationSettings();
  const updated = await settingsService.updateConversationSettings({
    firstResponseSlaEnabled: true, firstResponseSlaMinutes: 12,
  }, admin);
  assert.equal(updated.firstResponseSlaEnabled, true);
  assert.equal(updated.firstResponseSlaMinutes, 12);

  const auditEntry = await prisma.auditLog.findFirst({
    where: { actorUserId: admin.id, action: "CONVERSATION_SETTINGS_UPDATED" },
    orderBy: { createdAt: "desc" },
  });
  assert.ok(auditEntry, "deveria gravar um AuditLog");
  assert.equal(auditEntry.entityType, "CONVERSATION_SETTINGS");
  assert.equal(auditEntry.details.before.firstResponseSlaMinutes, before.firstResponseSlaMinutes);
  assert.equal(auditEntry.details.after.firstResponseSlaMinutes, 12);
  assert.equal(JSON.stringify(auditEntry.details).toLowerCase().includes("password"), false);
});

test("configurações sobrevivem a uma nova leitura direta do banco (sem depender do cache do processo)", async () => {
  await settingsService.updateConversationSettings({ stalledConversationAlertMinutes: 222 }, admin);
  const fromDb = await prisma.conversationSettings.findUnique({ where: { id: "singleton" } });
  assert.equal(fromDb.stalledConversationAlertMinutes, 222);
});
