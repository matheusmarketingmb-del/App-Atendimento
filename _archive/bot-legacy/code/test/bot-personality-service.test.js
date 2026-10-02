require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const personalityService = require("../src/services/bot-personality-service");

const botNamePrefix = "Bot Personalidade Teste";
const testEmails = ["master-personality-test@teste.local", "agent-personality-test@teste.local"];
let master;
let agent;

async function cleanup() {
  await prisma.bot.deleteMany({ where: { name: { startsWith: botNamePrefix } } });
}

test.before(async () => {
  [master, agent] = await Promise.all([
    prisma.user.create({ data: { name: "Master Personalidade Teste", email: testEmails[0], role: "ADMIN" } }),
    prisma.user.create({ data: { name: "Atendente Personalidade Teste", email: testEmails[1], role: "ATENDENTE" } }),
  ]);
});

test.after(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { email: { in: testEmails } } });
  await prisma.$disconnect();
});

async function createBot(nameSuffix) {
  return prisma.bot.create({
    data: {
      name: `${botNamePrefix} ${nameSuffix}`, status: "DRAFT", channel: "META",
      initialMessage: "Olá!", outsideHoursMessage: "Fora.", fallbackMessage: "Não entendi.",
    },
  });
}

test("getPersonality: Bot sem registro próprio devolve o default da Mibro Brasil, marcado isDefault", async () => {
  await cleanup();
  const bot = await createBot("Default");
  const result = await personalityService.getPersonality(bot.id, master);
  assert.equal(result.personality, null);
  assert.equal(result.isDefault, true);
  assert.equal(result.effective.assistantName, "Assistente virtual da Mibro Brasil");
});

test("upsertPersonality cria a linha na primeira edição e mantém campos não enviados nas edições seguintes", async () => {
  await cleanup();
  const bot = await createBot("Upsert");
  const created = await personalityService.upsertPersonality(bot.id, {
    assistantName: "Léo", tone: ["informal", "direto"], forbiddenBehaviors: ["prometer desconto"],
  }, master);
  assert.equal(created.assistantName, "Léo");
  assert.deepEqual(created.tone, ["informal", "direto"]);
  assert.equal(created.preset, "PERSONALIZADO");

  const updated = await personalityService.upsertPersonality(bot.id, { roleDescription: "Vendedor" }, master);
  assert.equal(updated.assistantName, "Léo", "campo não enviado no segundo PATCH deve permanecer");
  assert.equal(updated.roleDescription, "Vendedor");
});

test("upsertPersonality rejeita lista de comportamento com item vazio", async () => {
  await cleanup();
  const bot = await createBot("Validacao");
  await assert.rejects(
    () => personalityService.upsertPersonality(bot.id, { forbiddenBehaviors: ["", "ok"] }, master),
    /inválido/,
  );
});

test("upsertPersonality: só uma conta Master pode gerenciar a personalidade de um Bot", async () => {
  await cleanup();
  const bot = await createBot("RBAC");
  await assert.rejects(
    () => personalityService.upsertPersonality(bot.id, { assistantName: "Hacker" }, agent),
    (error) => error.statusCode === 403,
  );
});

test("applyPreset substitui todos os campos pelo conteúdo do preset escolhido", async () => {
  await cleanup();
  const bot = await createBot("Preset");
  await personalityService.upsertPersonality(bot.id, { assistantName: "Antigo", additionalInstructions: "algo antigo" }, master);
  const applied = await personalityService.applyPreset(bot.id, "SUPORTE", master);
  assert.equal(applied.preset, "SUPORTE");
  assert.equal(applied.assistantName, "Suporte Mibro Brasil");
  assert.equal(applied.additionalInstructions, null, "preset substitui, nunca mescla com o que estava salvo");
});

test('applyPreset rejeita o preset "PERSONALIZADO" (não tem conteúdo pronto)', async () => {
  await cleanup();
  const bot = await createBot("PresetInvalido");
  await assert.rejects(() => personalityService.applyPreset(bot.id, "PERSONALIZADO", master), /Personalizado/);
});

test("copyPersonality copia a personalidade de um Bot para outro, inclusive quando a origem só tem o default implícito", async () => {
  await cleanup();
  const source = await createBot("Origem");
  const target = await createBot("Destino");
  const copied = await personalityService.copyPersonality(source.id, target.id, master);
  assert.equal(copied.assistantName, "Assistente virtual da Mibro Brasil");
  assert.ok(copied.forbiddenBehaviors.includes("inventar informações"));

  const targetNow = await prisma.botPersonality.findUnique({ where: { botId: target.id } });
  assert.ok(targetNow, "o Bot de destino deve passar a ter uma linha PRÓPRIA em BotPersonality");
});

test("copyPersonality rejeita copiar um Bot para ele mesmo", async () => {
  await cleanup();
  const bot = await createBot("CopiaMesmo");
  await assert.rejects(() => personalityService.copyPersonality(bot.id, bot.id, master), /diferente/);
});

test("listPresets devolve os 5 presets pedidos, com definição só para os 4 prontos", () => {
  const presets = personalityService.listPresets();
  assert.deepEqual(presets.map((p) => p.preset), ["TRIAGEM", "SUPORTE", "COMERCIAL", "POS_VENDA", "PERSONALIZADO"]);
  assert.equal(presets.find((p) => p.preset === "PERSONALIZADO").definition, null);
  assert.ok(presets.find((p) => p.preset === "COMERCIAL").definition.forbiddenBehaviors.includes("garantir funções não confirmadas"));
});
