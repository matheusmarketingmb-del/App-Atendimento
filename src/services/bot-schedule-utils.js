// Utilidades puras compartilhadas pelo Flow Builder e por Campanhas
// (opt-out por palavra-chave): normalização de texto e horário de
// atendimento do Bot (BotSchedule/BotHoliday). Sem I/O.
//
// Extraídas de bot-simulator-service.js (sistema de Bots legado, arquivado
// em _archive/bot-legacy/) sem mudança de comportamento.
const weekdayIndexes = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim();
}

function localDateParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    dayOfWeek: weekdayIndexes[values.weekday],
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

// Sem horário configurado = sempre dentro do horário (configured: false).
// Feriado habilitado na data local = fora do horário o dia inteiro.
function scheduleState(bot, now = new Date()) {
  const schedules = Array.isArray(bot.schedules) ? bot.schedules : [];
  const holidays = Array.isArray(bot.holidays) ? bot.holidays : [];
  const { dayOfWeek, date, time } = localDateParts(now, bot.timezone);
  const holiday = holidays.find((item) => item.enabled !== false && item.date === date) || null;
  if (holiday) return { configured: true, withinHours: false, schedule: null, holiday };
  if (!schedules.length) return { configured: false, withinHours: true, schedule: null, holiday: null };
  const schedule = schedules.find((item) => item.dayOfWeek === dayOfWeek) || null;
  return {
    configured: true,
    withinHours: Boolean(schedule?.enabled && time >= schedule.startTime && time < schedule.endTime),
    schedule,
    holiday: null,
  };
}

const weekdayShortLabels = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const weekdayFullLabels = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const weekdayShort = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const timezoneFriendlyNames = { "America/Sao_Paulo": "Brasília" };
const DEFAULT_HOURS_TEXT = "segunda a sexta-feira, das 8h às 17h (horário de Brasília)";

// Texto legível do horário do Bot (variável {{bot.businessHours}}) — mesma
// regra do antigo Bot de Triagem: faixa compacta quando todos os dias
// habilitados compartilham o horário, senão dia a dia.
function describeSchedule(bot) {
  const enabledDays = (bot?.schedules || [])
    .filter((item) => item.enabled)
    .sort((left, right) => left.dayOfWeek - right.dayOfWeek);
  if (!enabledDays.length) return DEFAULT_HOURS_TEXT;

  const sameHours = enabledDays.every((item) => (
    item.startTime === enabledDays[0].startTime && item.endTime === enabledDays[0].endTime
  ));
  const hourText = (start, end) => `das ${start.replace(/^0/, "").replace(":00", "h")} às ${end.replace(/^0/, "").replace(":00", "h")}`;
  const isConsecutiveRun = enabledDays.length >= 2
    && enabledDays.every((item, index) => index === 0 || item.dayOfWeek === enabledDays[index - 1].dayOfWeek + 1);

  if (sameHours && isConsecutiveRun) {
    const first = weekdayShortLabels[enabledDays[0].dayOfWeek];
    const last = weekdayFullLabels[enabledDays[enabledDays.length - 1].dayOfWeek];
    const timezone = bot.timezone || "America/Sao_Paulo";
    const tzName = timezoneFriendlyNames[timezone] || timezone.split("/").pop().replace(/_/g, " ");
    return `${first} a ${last}, ${hourText(enabledDays[0].startTime, enabledDays[0].endTime)} (horário de ${tzName})`;
  }
  if (sameHours) {
    const days = enabledDays.map((item) => weekdayShort[item.dayOfWeek]).join(", ");
    return `${days}, ${hourText(enabledDays[0].startTime, enabledDays[0].endTime)}`;
  }
  return enabledDays.map((item) => `${weekdayShort[item.dayOfWeek]} ${hourText(item.startTime, item.endTime)}`).join("; ");
}

module.exports = { describeSchedule, localDateParts, normalizeText, scheduleState };
