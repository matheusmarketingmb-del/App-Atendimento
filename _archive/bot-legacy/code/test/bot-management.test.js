const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeText,
  scheduleState,
  simulateBot,
} = require("../src/services/bot-simulator-service");
const {
  assertBotManager,
  validateHolidays,
  validateSchedules,
} = require("../src/services/bot-service");

function botFixture(overrides = {}) {
  return {
    id: "bot-1",
    name: "Bot de teste",
    timezone: "America/Sao_Paulo",
    outsideHoursMessage: "Estamos fora do horário.",
    fallbackMessage: "Não entendi sua mensagem.",
    defaultCategory: { id: "cat-default", name: "Atendimento", code: "ATENDIMENTO" },
    schedules: [],
    intents: [],
    ...overrides,
  };
}

test("normaliza caixa, acentos e espaços para comparar mensagens", () => {
  assert.equal(normalizeText("  OLÁ,   assistência  "), "ola, assistencia");
});

test("prioriza correspondência exata antes da prioridade da intenção", () => {
  const bot = botFixture({
    intents: [
      {
        id: "intent-priority",
        name: "Intenção prioritária",
        priority: 100,
        active: true,
        responseMessage: "Resposta prioritária",
        fallbackAction: "USE_BOT_FALLBACK",
        category: null,
        examples: [{ id: "example-priority", text: "garantia" }],
      },
      {
        id: "intent-exact",
        name: "Intenção exata",
        priority: 1,
        active: true,
        responseMessage: "Resposta exata",
        fallbackAction: "TRANSFER_TO_CATEGORY",
        category: { id: "cat-garantia", name: "Garantia", code: "GARANTIA" },
        examples: [{ id: "example-exact", text: "preciso de garantia" }],
      },
    ],
  });

  const result = simulateBot(bot, "Preciso de GARANTIA");
  assert.equal(result.intent.id, "intent-exact");
  assert.equal(result.response, "Resposta exata");
  assert.equal(result.category.id, "cat-garantia");
  assert.equal(result.sent, false);
});

test("usa prioridade e especificidade nas correspondências contidas", () => {
  const bot = botFixture({
    intents: [
      {
        id: "intent-low",
        name: "Baixa",
        priority: 1,
        active: true,
        responseMessage: "Baixa",
        fallbackAction: "USE_BOT_FALLBACK",
        category: null,
        examples: [{ id: "example-long", text: "segunda via do pedido" }],
      },
      {
        id: "intent-high",
        name: "Alta",
        priority: 5,
        active: true,
        responseMessage: "Alta",
        fallbackAction: "TRANSFER_TO_HUMAN",
        category: null,
        examples: [{ id: "example-short", text: "pedido" }],
      },
    ],
  });

  const result = simulateBot(bot, "Quero consultar meu pedido agora");
  assert.equal(result.intent.id, "intent-high");
  assert.equal(result.fallbackAction, "TRANSFER_TO_HUMAN");
});

test("retorna fallback local sem enviar mensagem quando nenhuma intenção corresponde", () => {
  const result = simulateBot(botFixture(), "assunto desconhecido");
  assert.equal(result.response, "Não entendi sua mensagem.");
  assert.equal(result.intent, null);
  assert.equal(result.fallbackAction, "USE_BOT_FALLBACK");
  assert.match(result.warning, /nenhuma mensagem foi enviada/i);
});

test("respeita horário e timezone configurados", () => {
  const bot = botFixture({
    schedules: [{
      id: "schedule-1",
      dayOfWeek: 1,
      enabled: true,
      startTime: "08:00",
      endTime: "17:00",
    }],
  });
  const within = new Date("2026-08-24T15:00:00.000Z");
  const outside = new Date("2026-08-24T21:00:00.000Z");

  assert.equal(scheduleState(bot, within).withinHours, true);
  assert.equal(scheduleState(bot, outside).withinHours, false);
  const result = simulateBot(bot, "olá", { now: outside });
  assert.equal(result.response, "Estamos fora do horário.");
  assert.equal(result.withinHours, false);
  assert.equal(result.intent, null);
});

test("considera o Bot disponível enquanto nenhum horário foi configurado", () => {
  assert.deepEqual(scheduleState(botFixture()), {
    configured: false,
    withinHours: true,
    schedule: null,
    holiday: null,
  });
});

test("feriado ativo fecha o Bot durante todo o dia no timezone configurado", () => {
  const bot = botFixture({
    schedules: [{ dayOfWeek: 1, enabled: true, startTime: "08:00", endTime: "17:00" }],
    holidays: [{ date: "2026-08-24", name: "Feriado local", enabled: true }],
  });
  const result = scheduleState(bot, new Date("2026-08-24T15:00:00.000Z"));
  assert.equal(result.withinHours, false);
  assert.equal(result.holiday.name, "Feriado local");

  bot.holidays[0].enabled = false;
  assert.equal(scheduleState(bot, new Date("2026-08-24T15:00:00.000Z")).withinHours, true);
});

test("valida datas reais, nomes e duplicidade dos feriados", () => {
  assert.deepEqual(validateHolidays([{ date: "2026-12-25", name: "Natal", enabled: true }]), [
    { date: "2026-12-25", name: "Natal", enabled: true },
  ]);
  assert.throws(() => validateHolidays([{ date: "2026-02-30", name: "Inválido" }]), /inválida/i);
  assert.throws(() => validateHolidays([
    { date: "2026-12-25", name: "Natal" },
    { date: "2026-12-25", name: "Duplicado" },
  ]), /mais de um feriado/i);
});

test("valida dias, formato, ordem e duplicidade dos horários", () => {
  assert.deepEqual(validateSchedules([{
    dayOfWeek: 1,
    enabled: true,
    startTime: "08:00",
    endTime: "17:00",
  }]), [{
    dayOfWeek: 1,
    enabled: true,
    startTime: "08:00",
    endTime: "17:00",
  }]);

  assert.throws(
    () => validateSchedules([
      { dayOfWeek: 1, enabled: true, startTime: "08:00", endTime: "17:00" },
      { dayOfWeek: 1, enabled: false, startTime: "09:00", endTime: "18:00" },
    ]),
    /mais de um horário/i,
  );
  assert.throws(
    () => validateSchedules([{ dayOfWeek: 7, enabled: true, startTime: "08:00", endTime: "17:00" }]),
    /entre 0 e 6/i,
  );
  assert.throws(
    () => validateSchedules([{ dayOfWeek: 2, enabled: true, startTime: "18:00", endTime: "08:00" }]),
    /posterior/i,
  );
});

test("restringe o gerenciamento de Bots à conta Master", () => {
  assert.doesNotThrow(() => assertBotManager({ id: "master", role: "ADMIN" }));
  assert.throws(
    () => assertBotManager({ id: "agent", role: "ATENDENTE" }),
    (error) => error.statusCode === 403 && /Master/.test(error.message),
  );
});
