const weekdayIndexes = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
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

function categorySummary(category) {
  return category ? { id: category.id, name: category.name, code: category.code } : null;
}

function matchIntent(bot, normalizedMessage) {
  const matches = [];
  for (const intent of bot.intents || []) {
    if (!intent.active) continue;
    for (const example of intent.examples || []) {
      const normalizedExample = normalizeText(example.text);
      if (!normalizedExample) continue;
      const exact = normalizedMessage === normalizedExample;
      if (exact || normalizedMessage.includes(normalizedExample)) {
        matches.push({ intent, example, exact, specificity: normalizedExample.length });
      }
    }
  }
  matches.sort((left, right) =>
    Number(right.exact) - Number(left.exact)
    || right.intent.priority - left.intent.priority
    || right.specificity - left.specificity
    || left.intent.name.localeCompare(right.intent.name, "pt-BR")
    || left.example.id.localeCompare(right.example.id));
  return matches[0] || null;
}

function simulateBot(bot, message, { now = new Date() } = {}) {
  const normalizedMessage = normalizeText(message);
  if (!normalizedMessage) throw badRequest("Digite uma mensagem para executar a simulação.");

  const hours = scheduleState(bot, now);
  const warning = "Simulação - nenhuma mensagem foi enviada";
  if (!hours.withinHours) {
    return {
      simulation: true,
      sent: false,
      warning,
      withinHours: false,
      scheduleConfigured: hours.configured,
      response: bot.outsideHoursMessage,
      intent: null,
      matchedExample: null,
      category: categorySummary(bot.defaultCategory),
      fallbackAction: null,
    };
  }

  const match = matchIntent(bot, normalizedMessage);
  if (!match) {
    return {
      simulation: true,
      sent: false,
      warning,
      withinHours: true,
      scheduleConfigured: hours.configured,
      response: bot.fallbackMessage,
      intent: null,
      matchedExample: null,
      category: categorySummary(bot.defaultCategory),
      fallbackAction: "USE_BOT_FALLBACK",
    };
  }

  return {
    simulation: true,
    sent: false,
    warning,
    withinHours: true,
    scheduleConfigured: hours.configured,
    response: match.intent.responseMessage || bot.fallbackMessage,
    intent: {
      id: match.intent.id,
      name: match.intent.name,
      priority: match.intent.priority,
    },
    matchedExample: match.example.text,
    category: categorySummary(match.intent.category || bot.defaultCategory),
    fallbackAction: match.intent.fallbackAction,
  };
}

module.exports = { localDateParts, normalizeText, scheduleState, simulateBot };
