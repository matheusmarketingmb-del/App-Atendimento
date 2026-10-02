require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { seedTriageBot } = require("../prisma/seed");
const botService = require("../src/services/bot-service");
const { handleIncomingTriage } = require("../src/services/triage-bot-service");
const { resolveBot } = require("../src/services/bot-orchestrator-service");

const masterEmail = "master-triage-integration-test@teste.local";
const botNamePrefix = "Bot Triagem Integracao Teste";
let master;
let triageBot;

async function cleanup() {
  await prisma.bot.deleteMany({ where: { name: { startsWith: botNamePrefix } } });
}

test.before(async () => {
  master = await prisma.user.upsert({
    where: { email: masterEmail },
    update: {},
    create: { name: "Master Triagem Integração Teste", email: masterEmail, role: "ADMIN" },
  });
  // Outros arquivos de teste fazem `prisma.bot.deleteMany()` sem filtro
  // (bot-flow-simulator.test.js, bot-simulator-endpoint.test.js) — recria o
  // Bot de sistema para este arquivo não depender da ordem de execução.
  triageBot = await seedTriageBot(prisma);
});

test.after(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { email: masterEmail } });
  // Garante que o Bot de sistema volta ao estado padrão para os demais
  // arquivos de teste (ex.: triage-bot.test.js), mesmo se algum teste
  // abaixo falhar no meio do caminho.
  await prisma.bot.update({
    where: { id: triageBot.id },
    data: { status: "ACTIVE", runOnNewConversation: true, runAfterReopen: true },
  });
  await prisma.$disconnect();
});

test("Bot do sistema (isSystem) não pode ser arquivado/excluído", async () => {
  await assert.rejects(
    () => botService.archiveBot(triageBot.id, master),
    /não pode ser arquivad/i,
  );
  const stillThere = await prisma.bot.findUnique({ where: { id: triageBot.id } });
  assert.equal(stillThere.archivedAt, null);
});

test("ativar/desativar (status) continua liberado para o Bot de sistema", async () => {
  const paused = await botService.updateBotStatus(triageBot.id, "PAUSED", master);
  assert.equal(paused.status, "PAUSED");
  const active = await botService.updateBotStatus(triageBot.id, "ACTIVE", master);
  assert.equal(active.status, "ACTIVE");
});

test("Bot desativado: mensagem não recebe triagem automática (mas não derruba nada)", async () => {
  const contact = await prisma.contact.create({
    data: { externalId: "triage-integration-paused-contact", phone: "5511988880001", name: "Cliente Pausado" },
  });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
  const incoming = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: "wamid.triage.integration.paused",
    direction: "RECEBIDA", status: "RECEBIDA", type: "text", text: "Olá", occurredAt: new Date(),
  } });
  const channel = { sendList: async () => { throw new Error("não deveria enviar nada"); } };

  try {
    await prisma.bot.update({ where: { id: triageBot.id }, data: { status: "PAUSED" } });
    const result = await handleIncomingTriage({}, incoming, channel, { now: new Date("2026-08-12T14:00:00.000Z") });
    assert.equal(result, false);
    const stillNovo = await prisma.conversation.findUnique({ where: { id: conversation.id } });
    assert.equal(stillNovo.status, "NOVO");
  } finally {
    await prisma.bot.update({ where: { id: triageBot.id }, data: { status: "ACTIVE" } });
    await prisma.contact.deleteMany({ where: { externalId: "triage-integration-paused-contact" } });
  }
});

test("runOnNewConversation=false não inicia a triagem numa conversa nova; runAfterReopen ainda funciona", async () => {
  const contact = await prisma.contact.create({
    data: { externalId: "triage-integration-run-new-contact", phone: "5511988880002", name: "Cliente RunNew" },
  });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
  const incoming = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: "wamid.triage.integration.runnew",
    direction: "RECEBIDA", status: "RECEBIDA", type: "text", text: "Olá", occurredAt: new Date(),
  } });
  const channel = { sendList: async () => { throw new Error("não deveria enviar nada"); } };

  try {
    await prisma.bot.update({ where: { id: triageBot.id }, data: { runOnNewConversation: false } });
    const result = await handleIncomingTriage({}, incoming, channel, { now: new Date("2026-08-12T14:00:00.000Z") });
    assert.equal(result, false);
    const stillNovo = await prisma.conversation.findUnique({ where: { id: conversation.id } });
    assert.equal(stillNovo.status, "NOVO");
  } finally {
    await prisma.bot.update({ where: { id: triageBot.id }, data: { runOnNewConversation: true } });
    await prisma.contact.deleteMany({ where: { externalId: "triage-integration-run-new-contact" } });
  }
});

test("runAfterReopen=false não reinicia a triagem numa conversa reaberta", async () => {
  const contact = await prisma.contact.create({
    data: { externalId: "triage-integration-reopen-contact", phone: "5511988880003", name: "Cliente Reopen" },
  });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id, status: "NOVO" } });
  await prisma.conversationActivity.create({ data: {
    conversationId: conversation.id, action: "REOPENED_BY_CUSTOMER_MESSAGE", details: {},
  } });
  const incoming = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: "wamid.triage.integration.reopen",
    direction: "RECEBIDA", status: "RECEBIDA", type: "text", text: "Olá de novo", occurredAt: new Date(),
  } });
  const channel = { sendList: async () => { throw new Error("não deveria enviar nada"); } };

  try {
    await prisma.bot.update({ where: { id: triageBot.id }, data: { runAfterReopen: false } });
    const result = await handleIncomingTriage({}, incoming, channel, { now: new Date("2026-08-12T14:00:00.000Z") });
    assert.equal(result, false);
  } finally {
    await prisma.bot.update({ where: { id: triageBot.id }, data: { runAfterReopen: true } });
    await prisma.contact.deleteMany({ where: { externalId: "triage-integration-reopen-contact" } });
  }
});

test("criar Bot pela API ignora type/isSystem do payload — nasce sempre STANDARD", async () => {
  const created = await botService.createBot({
    name: `${botNamePrefix} Standard`,
    channel: "META",
    initialMessage: "Olá!",
    outsideHoursMessage: "Fora do horário.",
    fallbackMessage: "Não entendi.",
    type: "SYSTEM_TRIAGE",
    isSystem: true,
  }, master);
  assert.equal(created.type, "STANDARD");
  assert.equal(created.isSystem, false);
});

test("opções de triagem: rejeita categoria inválida/duplicada e persiste ordem/habilitação", async () => {
  // Bot de triagem isolado (nasce depois do seed, então getTriageBot()
  // continua escolhendo o Bot de sistema original nos outros testes).
  const isolatedBot = await prisma.bot.create({ data: {
    name: `${botNamePrefix} Opções`, status: "ACTIVE", type: "SYSTEM_TRIAGE",
    channel: "META", initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Fallback.",
  } });
  const atendimento = await prisma.category.findUnique({ where: { code: "ATENDIMENTO" } });
  const suporte = await prisma.category.findUnique({ where: { code: "SUPORTE" } });

  await assert.rejects(
    () => botService.replaceTriageOptions(isolatedBot.id, [
      { label: "Inválida", categoryId: "categoria-que-nao-existe", enabled: true, order: 10 },
    ], master),
    /categoria|não encontrada/i,
  );

  await assert.rejects(
    () => botService.replaceTriageOptions(isolatedBot.id, [
      { label: "Um", categoryId: atendimento.id, enabled: true, order: 10 },
      { label: "Dois", categoryId: atendimento.id, enabled: true, order: 20 },
    ], master),
    /uma opção/i,
  );

  const updated = await botService.replaceTriageOptions(isolatedBot.id, [
    { label: "Atendimento", categoryId: atendimento.id, enabled: true, order: 20 },
    { label: "Suporte (desabilitado)", categoryId: suporte.id, enabled: false, order: 10 },
  ], master);
  assert.equal(updated.triageOptions.length, 2);
  assert.equal(updated.triageOptions[0].label, "Suporte (desabilitado)");
  assert.equal(updated.triageOptions[0].enabled, false);
  assert.equal(updated.triageOptions[1].label, "Atendimento");
});

test("simulador do Bot de Triagem: nunca envia mensagem real e reflete horário/opções configurados", async () => {
  const result = await botService.simulate(triageBot.id, "Olá", master, {});
  assert.equal(result.simulation, true);
  assert.equal(result.sent, false);
  assert.match(result.response, /bem-vindo\(a\) à Mibro Brasil/i);
  assert.ok(Array.isArray(result.options) && result.options.length === 4);
});

test("feriados da Triagem são persistidos e podem ser removidos sem mudar o calendário padrão", async () => {
  try {
    const updated = await botService.replaceHolidays(triageBot.id, [
      { date: "2026-12-25", name: "Natal", enabled: true },
    ], master);
    assert.equal(updated.holidays.length, 1);
    assert.equal(updated.holidays[0].name, "Natal");
    await assert.rejects(
      () => botService.replaceHolidays(triageBot.id, [
        { date: "2026-12-25", name: "Natal" },
        { date: "2026-12-25", name: "Duplicado" },
      ], master),
      /mais de um feriado/i,
    );
  } finally {
    await botService.replaceHolidays(triageBot.id, [], master);
  }
});

test("motor de IA (orchestrator) nunca resolve o Bot de Triagem como Bot comum do canal", async () => {
  const resolved = await resolveBot(null, "META", prisma);
  assert.notEqual(resolved?.id, triageBot.id);
});
