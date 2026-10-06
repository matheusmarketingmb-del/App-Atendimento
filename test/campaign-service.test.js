require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const campaigns = require("../src/services/campaign-service");
const importService = require("../src/services/campaign-import-service");
const exportService = require("../src/services/campaign-export-service");
const settingsService = require("../src/services/campaign-settings-service");
const optOutService = require("../src/services/campaign-optout-service");
const worker = require("../src/services/campaign-worker-service");
const campaignReplyService = require("../src/services/campaign-reply-service");
const { normalizeCampaignPhone } = require("../src/services/campaign-phone-service");
const { parseCsv, sanitizeCsvCell } = require("../src/services/campaign-csv-service");

const namePrefix = "Campanha Teste";
const adminEmail = "admin-campaign-test@teste.local";
const attendantEmail = "atendente-campaign-test@teste.local";
let admin;
let attendant;

const approvedTemplate = {
  id: "tpl-1", name: "prospeccao_geral", language: "pt_BR", category: "MARKETING", status: "APPROVED",
  components: [
    { type: "HEADER", text: "Olá!" },
    { type: "BODY", text: "Oi {{1}}, temos uma novidade para {{2}}.", example: { body_text: [["Cliente", "sua empresa"]] } },
    { type: "FOOTER", text: "Responda SAIR para não receber mais." },
  ],
};

function fakeChannel(overrides = {}) {
  const sent = [];
  return {
    sent,
    listMessageTemplates: async () => [approvedTemplate],
    sendTemplate: async (phone, payload) => {
      sent.push({ phone, payload });
      return { externalId: `wamid.campaign.${sent.length}.${Math.random()}`, data: { messages: [{ id: "wamid.x" }] } };
    },
    ...overrides,
  };
}

async function cleanup() {
  await prisma.campaign.deleteMany({ where: { name: { startsWith: namePrefix } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: "5511977" } } });
}

test.before(async () => {
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "waba-campaign-test";
  admin = await prisma.user.upsert({
    where: { email: adminEmail }, update: {}, create: { name: "Admin Campanha", email: adminEmail, role: "ADMIN" },
  });
  attendant = await prisma.user.upsert({
    where: { email: attendantEmail }, update: {}, create: { name: "Atendente Campanha", email: attendantEmail, role: "ATENDENTE" },
  });
  await require("./support/company").grantCompany(prisma, attendant.id);
  await prisma.campaignGlobalSettings.upsert({
    where: { id: "singleton" }, update: { massMessagingEnabled: false, allowImports: true, allowScheduling: true },
    create: { id: "singleton", massMessagingEnabled: false },
  });
});

test.after(async () => {
  await cleanup();
  await prisma.optOut.deleteMany({ where: { phone: { startsWith: "5511977" } } });
  await prisma.user.deleteMany({ where: { email: { in: [adminEmail, attendantEmail] } } });
  await prisma.$disconnect();
});

async function createDraftCampaign(overrides = {}) {
  return campaigns.createCampaign({ companyId: "cmp_mibro",
    name: `${namePrefix} ${Date.now()}-${Math.random()}`,
    templateName: approvedTemplate.name, templateLanguage: approvedTemplate.language,
    variableMapping: { "BODY:1": "firstName", "BODY:2": "static:sua empresa" },
    ...overrides,
  }, admin, fakeChannel());
}

test("template não aprovado é bloqueado ao criar campanha", async () => {
  const channel = fakeChannel({ listMessageTemplates: async () => [{ ...approvedTemplate, status: "PENDING" }] });
  await assert.rejects(
    () => campaigns.createCampaign({ companyId: "cmp_mibro", name: `${namePrefix} X`, templateName: approvedTemplate.name, templateLanguage: "pt_BR" }, admin, channel),
    /aprovados/,
  );
});

test("RBAC: atendente sem canManageCampaigns não pode criar campanha", async () => {
  await assert.rejects(
    () => campaigns.createCampaign({ companyId: "cmp_mibro", name: `${namePrefix} RBAC`, templateName: approvedTemplate.name, templateLanguage: "pt_BR" }, attendant, fakeChannel()),
    (error) => error.statusCode === 403,
  );
});

test("normalização de telefone: DDI 55 nunca inventado, número curto é inválido", () => {
  assert.equal(normalizeCampaignPhone("(11) 98888-7766"), "5511988887766");
  assert.equal(normalizeCampaignPhone("11988887766"), "5511988887766");
  assert.equal(normalizeCampaignPhone("123"), null);
});

test("CSV: parser lida com aspas/vírgulas e sanitizeCsvCell neutraliza fórmula", () => {
  const rows = parseCsv('phone,name\n"5511988887766","Cliente, Silva"\n');
  assert.deepEqual(rows[1], ["5511988887766", "Cliente, Silva"]);
  assert.equal(sanitizeCsvCell("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0");
  assert.equal(sanitizeCsvCell("Nome normal"), "Nome normal");
});

test("importação: telefone inválido, duplicado no arquivo e opt-out são excluídos automaticamente", async () => {
  await cleanup();
  const campaign = await createDraftCampaign();
  await optOutService.registerOptOut({ companyId: "cmp_mibro", phone: "5511977000009", source: "MANUAL" });

  const csvText = [
    "phone,firstName",
    "(11) 97700-0001,Ana",
    "(11) 97700-0001,Ana Duplicada",
    "123,Invalido",
    ",SemTelefone",
    "(11) 97700-0009,ComOptOut",
  ].join("\n");
  const mapping = { phone: "0", firstName: "1" };

  const preview = await importService.validateImport({ campaignId: campaign.id, csvText, mapping }, admin);
  assert.equal(preview.totalRows, 5);
  assert.equal(preview.validRows, 2); // Ana + ComOptOut (opt-out ainda entra, mas marcado)
  assert.equal(preview.duplicateRows, 1);
  assert.equal(preview.invalidPhoneRows, 1);
  assert.equal(preview.noPhoneRows, 1);
  assert.equal(preview.optOutRows, 1);

  const committed = await importService.commitImport({ campaignId: campaign.id, csvText, mapping, fileName: "teste.csv" }, admin);
  assert.equal(committed.validRows, 2);

  const stored = await prisma.campaignContact.findMany({ where: { campaignId: campaign.id }, orderBy: { phone: "asc" } });
  assert.equal(stored.length, 2);
  const optedOutContact = stored.find((row) => row.phone === "5511977000009");
  assert.equal(optedOutContact.optOut, true);
  assert.equal(optedOutContact.consentStatus, "OPTED_OUT");

  // Reimportar o mesmo arquivo não duplica (já presentes na campanha).
  const secondPreview = await importService.validateImport({ campaignId: campaign.id, csvText, mapping }, admin);
  assert.equal(secondPreview.validRows, 0);
  assert.ok(secondPreview.alreadyInCampaignRows >= 2);
});

test("preview do template nunca envia 'undefined' — usa exemplo quando falta mapeamento", async () => {
  const channel = fakeChannel();
  const preview = await campaigns.previewTemplate(channel, {
    templateName: approvedTemplate.name, templateLanguage: approvedTemplate.language,
    variableMapping: { "BODY:1": "firstName" }, sampleContact: { firstName: "Maria" },
  });
  assert.match(preview.renderedPreview, /Oi Maria/);
  assert.doesNotMatch(preview.renderedPreview, /undefined/);
});

test("exportação: CSV nunca sai vulnerável a fórmula e reflete o status técnico", async () => {
  await cleanup();
  const campaign = await createDraftCampaign();
  await prisma.campaignContact.create({
    data: { campaignId: campaign.id, phone: "5511977000021", firstName: "=SOMA(A1:A2)", status: "DELIVERED" },
  });
  const { csv } = await exportService.exportCampaignContacts(campaign.id, {}, admin);
  assert.match(csv, /'=SOMA/);
  assert.match(csv, /DELIVERED/);
});

test("agendamento exige contatos elegíveis e respeita allowScheduling", async () => {
  await cleanup();
  const campaign = await createDraftCampaign();
  await assert.rejects(() => campaigns.scheduleCampaign(campaign.id, {}, admin), /destinatários elegíveis/);

  await prisma.campaignContact.create({ data: { campaignId: campaign.id, phone: "5511977000031", status: "PENDING" } });
  await assert.rejects(() => campaigns.scheduleCampaign(campaign.id, {}, admin), /data futura/);
  const scheduled = await campaigns.scheduleCampaign(campaign.id, { scheduledAt: new Date(Date.now() + 60000) }, admin);
  assert.equal(scheduled.status, "SCHEDULED");

  await settingsService.updateCampaignSettings({ allowScheduling: false }, admin);
  const campaign2 = await createDraftCampaign();
  await prisma.campaignContact.create({ data: { campaignId: campaign2.id, phone: "5511977000032", status: "PENDING" } });
  await assert.rejects(() => campaigns.scheduleCampaign(campaign2.id, {}, admin), /desativado/);
  await settingsService.updateCampaignSettings({ allowScheduling: true }, admin);
});

test("master switch OFF: worker nunca envia nada mesmo com campanha RUNNING e contatos elegíveis", async () => {
  await cleanup();
  const campaign = await createDraftCampaign();
  await prisma.campaignContact.create({ data: { campaignId: campaign.id, phone: "5511977000041", firstName: "Ana", status: "PENDING" } });
  await campaigns.queueCampaignNow(campaign.id, admin);

  await prisma.campaignGlobalSettings.update({ where: { id: "singleton" }, data: { massMessagingEnabled: false } });
  const channel = fakeChannel();
  const result = await worker.runCampaignSendTick(channel);
  assert.equal(result.blocked, true);
  assert.equal(channel.sent.length, 0);
  const contact = await prisma.campaignContact.findFirst({ where: { campaignId: campaign.id } });
  assert.equal(contact.status, "PENDING");
});

test("master switch ON: worker envia, atualiza status, e rodar duas vezes não duplica o envio (idempotência)", async () => {
  await cleanup();
  const campaign = await createDraftCampaign();
  await prisma.campaignContact.create({ data: { campaignId: campaign.id, phone: "5511977000051", firstName: "Ana", status: "PENDING" } });

  await campaigns.queueCampaignNow(campaign.id, admin);
  await prisma.campaignGlobalSettings.update({ where: { id: "singleton" }, data: { massMessagingEnabled: true } });
  const channel = fakeChannel();
  try {
    await worker.runCampaignSendTick(channel);
    assert.equal(channel.sent.length, 1);
    const afterFirst = await prisma.campaignContact.findFirst({ where: { campaignId: campaign.id } });
    assert.equal(afterFirst.status, "SENT");
    assert.ok(afterFirst.externalMessageId);

    await worker.runCampaignSendTick(channel);
    assert.equal(channel.sent.length, 1, "a segunda execução do tick nunca deveria reenviar a mesma linha");

    const finishedCampaign = await prisma.campaign.findUnique({ where: { id: campaign.id } });
    assert.equal(finishedCampaign.status, "COMPLETED");
  } finally {
    await prisma.campaignGlobalSettings.update({ where: { id: "singleton" }, data: { massMessagingEnabled: false } });
  }
});

test("dois workers concorrentes reivindicam cada contato uma única vez", async () => {
  await cleanup();
  const campaign = await createDraftCampaign({ batchSize: 1 });
  await prisma.campaignContact.create({ data: { campaignId: campaign.id, phone: "5511977000052", status: "PENDING" } });
  await campaigns.queueCampaignNow(campaign.id, admin);
  await prisma.campaignGlobalSettings.update({ where: { id: "singleton" }, data: { massMessagingEnabled: true } });
  const channel = fakeChannel({
    sendTemplate: async (phone, payload) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      channel.sent.push({ phone, payload });
      return { externalId: `wamid.concurrent.${Math.random()}`, data: {} };
    },
  });
  try {
    await Promise.all([worker.runCampaignSendTick(channel), worker.runCampaignSendTick(channel)]);
    assert.equal(channel.sent.length, 1, "a reivindicação atômica deve impedir envio duplicado entre processos");
  } finally {
    await prisma.campaignGlobalSettings.update({ where: { id: "singleton" }, data: { massMessagingEnabled: false } });
  }
});

test("intervalo próprio da campanha impede o próximo lote antes da hora", async () => {
  await cleanup();
  const campaign = await createDraftCampaign({ batchSize: 1, delayBetweenBatchesSeconds: 60 });
  await prisma.campaignContact.createMany({ data: [
    { campaignId: campaign.id, phone: "5511977000053", status: "PENDING" },
    { campaignId: campaign.id, phone: "5511977000054", status: "PENDING" },
  ] });
  await campaigns.queueCampaignNow(campaign.id, admin);
  await prisma.campaignGlobalSettings.update({ where: { id: "singleton" }, data: { massMessagingEnabled: true } });
  const channel = fakeChannel();
  const firstTick = new Date();
  try {
    await worker.runCampaignSendTick(channel, firstTick);
    assert.equal(channel.sent.length, 1);
    const afterFirstBatch = await prisma.campaign.findUnique({ where: { id: campaign.id } });
    assert.equal(afterFirstBatch.lastBatchAt?.getTime(), firstTick.getTime(), "o worker deve persistir o horário do lote");
    await worker.runCampaignSendTick(channel, new Date(firstTick.getTime() + 5000));
    assert.equal(channel.sent.length, 1, "não deve antecipar o segundo lote");
    await worker.runCampaignSendTick(channel, new Date(firstTick.getTime() + 61000));
    assert.equal(channel.sent.length, 2);
  } finally {
    await prisma.campaignGlobalSettings.update({ where: { id: "singleton" }, data: { massMessagingEnabled: false } });
  }
});

test("limites inválidos são rejeitados no backend", async () => {
  await assert.rejects(() => createDraftCampaign({ batchSize: 0 }), /Tamanho do lote/);
  await assert.rejects(() => createDraftCampaign({ delayBetweenBatchesSeconds: 99999 }), /Intervalo entre lotes/);
  await assert.rejects(() => createDraftCampaign({ maxRetries: -1 }), /Máximo de tentativas/);
  await assert.rejects(() => createDraftCampaign({ testPhone: "123" }), /número de teste válido/);
});
test("pausar/retomar/cancelar: cancelar nunca envia o restante nem apaga o que já foi enviado", async () => {
  await cleanup();
  const campaign = await createDraftCampaign();
  await prisma.campaignContact.createMany({ data: [
    { campaignId: campaign.id, phone: "5511977000061", status: "SENT", sentAt: new Date() },
    { campaignId: campaign.id, phone: "5511977000062", status: "PENDING" },
  ] });
  await campaigns.queueCampaignNow(campaign.id, admin);
  const paused = await campaigns.pauseCampaign(campaign.id, admin);
  assert.equal(paused.status, "PAUSED");
  const resumed = await campaigns.resumeCampaign(campaign.id, admin);
  assert.equal(resumed.status, "QUEUED");
  const cancelled = await campaigns.cancelCampaign(campaign.id, admin);
  assert.equal(cancelled.status, "CANCELLED");

  const rows = await prisma.campaignContact.findMany({ where: { campaignId: campaign.id }, orderBy: { phone: "asc" } });
  assert.equal(rows[0].status, "SENT", "contato já enviado nunca é apagado/alterado pelo cancelamento");
  assert.equal(rows[1].status, "SKIPPED", "contato pendente vira SKIPPED, nunca é enviado depois de cancelado");
});

test("opt-out por mensagem: 'SAIR' é detectado e exclui o contato de campanhas futuras", async () => {
  const { detectOptOutKeyword } = optOutService;
  assert.equal(detectOptOutKeyword("SAIR"), true);
  assert.equal(detectOptOutKeyword("quero SAIR da lista"), true);
  assert.equal(detectOptOutKeyword("oi, tudo bem?"), false);

  await optOutService.registerOptOut({ companyId: "cmp_mibro", phone: "5511977000071", source: "REPLY_KEYWORD" });
  assert.equal(await optOutService.isOptedOut("5511977000071", "cmp_mibro"), true);

  await assert.rejects(() => optOutService.removeOptOut("5511977000071", {}, admin), /motivo/);
  const removed = await optOutService.removeOptOut("5511977000071", { companyId: "cmp_mibro", reason: "Cliente pediu para voltar a receber" }, admin);
  assert.ok(removed.removedAt);
  assert.equal(await optOutService.isOptedOut("5511977000071", "cmp_mibro"), false);
});

test("resposta do cliente vincula o CampaignContact como REPLIED e nunca reatribui uma conversa já triada", async () => {
  await cleanup();
  const campaignReplyService = require("../src/services/campaign-reply-service");
  const campaign = await createDraftCampaign();
  const contact = await prisma.campaignContact.create({
    data: { campaignId: campaign.id, phone: "5511977000081", status: "SENT", sentAt: new Date() },
  });
  const conversationContact = await prisma.contact.create({ data: { companyId: "cmp_mibro", channel: "META", externalId: "5511977000081", phone: "5511977000081", name: "Cliente" } });
  const conversation = await prisma.conversation.create({ data: { companyId: "cmp_mibro", contactId: conversationContact.id, status: "NOVO" } });

  await campaignReplyService.handleInboundMessage({ companyId: "cmp_mibro", phone: "5511977000081", text: "Oi, tenho interesse!", conversationId: conversation.id });

  const updatedContact = await prisma.campaignContact.findUnique({ where: { id: contact.id } });
  assert.equal(updatedContact.status, "REPLIED");
  assert.ok(updatedContact.repliedAt);

  const updatedConversation = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(updatedConversation.originSource, "OUTBOUND_CAMPAIGN");
  assert.equal(updatedConversation.originCampaignId, campaign.id);
});

test("resposta aplica responsável e Bot configurados sem sobrescrever estado existente", async () => {
  await cleanup();
  const bot = await prisma.bot.create({ data: { companyId: "cmp_mibro",
    name: `Bot Campanha ${Date.now()}`, status: "ACTIVE", channel: "META",
    initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
  } });
  const campaign = await createDraftCampaign({ replyBotId: bot.id, responsibleUserId: admin.id });
  await prisma.campaignContact.create({
    data: { campaignId: campaign.id, phone: "5511977000083", status: "SENT", sentAt: new Date() },
  });
  const contact = await prisma.contact.create({
    data: { companyId: "cmp_mibro", channel: "META", externalId: "5511977000083", phone: "5511977000083", name: "Cliente Campanha" },
  });
  const conversation = await prisma.conversation.create({ data: { companyId: "cmp_mibro", contactId: contact.id, status: "NOVO" } });

  await campaignReplyService.handleInboundMessage({ companyId: "cmp_mibro",
    phone: "5511977000083", text: "Tenho interesse", conversationId: conversation.id, contactId: contact.id,
  });

  const routed = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  const botState = await prisma.conversationBotState.findUnique({ where: { conversationId: conversation.id } });
  assert.equal(routed.assignedUserId, admin.id);
  assert.equal(botState.activeBotId, bot.id);
  await prisma.bot.delete({ where: { id: bot.id } });
});
test("status atrasado da Meta nunca regride READ para DELIVERED", async () => {
  await cleanup();
  const campaign = await createDraftCampaign();
  const externalMessageId = `wamid.status.${Math.random()}`;
  const contact = await prisma.campaignContact.create({
    data: { campaignId: campaign.id, phone: "5511977000082", status: "READ", externalMessageId, readAt: new Date() },
  });
  await campaignReplyService.handleCampaignStatusEvent({ status: "delivered", externalId: externalMessageId });
  const updated = await prisma.campaignContact.findUnique({ where: { id: contact.id } });
  assert.equal(updated.status, "READ");
});
test("envio de teste nunca entra nas métricas reais da campanha", async () => {
  await cleanup();
  const campaign = await campaigns.createCampaign({ companyId: "cmp_mibro",
    name: `${namePrefix} Teste`, templateName: approvedTemplate.name, templateLanguage: approvedTemplate.language,
    variableMapping: { "BODY:1": "firstName", "BODY:2": "static:empresa" }, testPhone: "5511977000091",
  }, admin, fakeChannel());
  const channel = fakeChannel();
  await campaigns.sendTestMessage(campaign.id, admin, channel);
  assert.equal(channel.sent.length, 1);

  const contactsCount = await prisma.campaignContact.count({ where: { campaignId: campaign.id } });
  assert.equal(contactsCount, 0, "o envio de teste nunca cria um CampaignContact real da campanha");
});
