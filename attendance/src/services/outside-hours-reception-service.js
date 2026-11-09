const crypto = require('node:crypto');
const { REVISION, resolveCalendar, closedPeriod } = require('./assistant-runtime-calendar');
const PENDING = ['NOVO', 'BOT', 'HANDOFF_BOT', 'AGUARDANDO_EQUIPE'];
const MESSAGE = 'Recebemos sua mensagem. Nosso atendimento humano está fora do expediente. Sua solicitação ficará registrada para a equipe continuar no próximo período de atendimento.';
const claimId = (companyId, conversationId, period) => 'ooh:' + crypto.createHash('sha256').update(JSON.stringify([companyId, conversationId, period])).digest('hex');
const humanFree = c => c && !c.archivedAt && PENDING.includes(c.status) && !c.assignedUserId && !c.botState?.humanPausedAt && !c.category?.masterOnly;
async function boundedSend(operation, timeoutMs = 12000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('SEND_OUTCOME_UNKNOWN')), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
function noticeText(bot, conversation, holiday) {
  const name = conversation.contact?.customName || conversation.contact?.name || '';
  const firstName = name.split(/\s+/)[0] || '';
  const raw = (holiday && (bot.holidayMessage || bot.featureFlags?.holidayMessage)) || bot.outsideHoursMessage || MESSAGE;
  const values = { saudacao: firstName ? `Olá, ${firstName}` : 'Olá', saudacao_virgula: firstName ? `, ${firstName}` : '', horario: require('./bot-schedule-utils').describeSchedule(bot), categoria: conversation.category?.name || 'Atendimento' };
  return String(raw).replace(/\{\{\s*(saudacao_virgula|saudacao|horario|categoria)\s*\}\}/g, (_, key) => values[key]);
}

// Dependency injection keeps all tests offline. A durable unique claim precedes
// provider I/O; ambiguous failures are never retried automatically.
async function receiveOutsideHours({ db, conversation, message, active, now, automationEnabled, automationStillEnabled, continueWithAssistant, send, isOptedOut, assertWindow, privateStamp }) {
  if (!automationEnabled || conversation.channel !== 'META' || !humanFree(conversation) || !conversation.companyId) return false;
  // A unified inbox may currently display another sender. Only the inbound
  // message chooses the account; null is the historical primary number.
  const inboundScope = Object.hasOwn(message, 'channelAccountId') ? message.channelAccountId : conversation.channelAccountId;
  const inboundAccount = inboundScope ? await db.channelAccount.findUnique({ where: { id: inboundScope } }) : await db.channelAccount.findFirst({ where: {
    companyId: conversation.companyId, channel: 'META', OR: [{ config: { path: ['legacyEnv'], equals: true } }, { config: { path: ['isLegacyWhatsApp'], equals: true } }],
  } });
  if (!inboundAccount || inboundAccount.companyId !== conversation.companyId || inboundAccount.channel !== 'META') return false;
  const bot = await db.bot.findFirst({ where: {
    companyId: conversation.companyId, type: 'SYSTEM_TRIAGE', archivedAt: null, status: 'ACTIVE', autoReplyEnabled: true,
    featureFlags: { path: ['outsideHoursReceptionRevision'], equals: REVISION },
  }, include: { schedules: true, holidays: true } });
  if (!bot) return false;
  const bound = inboundAccount.config?.inboundBotId;
  const accounts = bot.featureFlags?.channelAccountIds;
  if ((bound && bound !== bot.id) || (Array.isArray(accounts) && !accounts.includes(inboundAccount.id))) return false;
  if (active && active.botId !== bot.id && active.botId !== bot.featureFlags.assistantBotId) return false;
  const resolved = await resolveCalendar(db, bot, now);
  if (!resolved?.availability.configured || resolved.availability.open) return false;
  if (await continueWithAssistant?.(bot)) return false;
  if (active?.status === 'RUNNING') return true; // owner finishes its turn; no parallel send
  const period = closedPeriod({ bot, ...resolved }, now);
  if (!period) return true; // no safe calendar: leave the inbound message for the team
  const id = claimId(conversation.companyId, conversation.id, period);
  const stamp = { privateCategoryId: await privateStamp(conversation) };
  let claimed = false;
  try {
    claimed = await db.$transaction(async tx => {
      const fresh = await tx.conversation.findUnique({ where: { id: conversation.id }, include: { botState: true, category: true, company: true } });
      if (!humanFree(fresh) || !fresh.company?.active || fresh.companyId !== bot.companyId || fresh.channelAccountId !== conversation.channelAccountId || fresh.categoryId !== conversation.categoryId) throw Object.assign(Error('Conversation changed'), { code: 'RECEPTION_SKIP' });
      // Updating the row serializes with human claims/transfers; the unique ID
      // serializes deliveries and different inbound messages in the same closure.
      const updated = await tx.conversation.updateMany({ where: { id: fresh.id, updatedAt: fresh.updatedAt, assignedUserId: null }, data: { status: fresh.status === 'BOT' ? 'HANDOFF_BOT' : fresh.status } });
      if (!updated.count) throw Object.assign(Error('Conversation changed'), { code: 'RECEPTION_SKIP' });
      if (active) {
        const cancelled = await tx.botFlowExecution.updateMany({ where: { id: active.id, step: active.step, status: { in: ['WAITING_CUSTOMER', 'WAITING_TIMER'] } }, data: { status: 'HANDED_OFF', step: { increment: 1 }, finishedAt: now, resumeAt: null, error: 'OUTSIDE_HOURS_QUEUED' } });
        if (!cancelled.count) throw Object.assign(Error('Execution changed'), { code: 'RECEPTION_SKIP' });
      }
      const marker = await tx.conversationActivity.createMany({ data: [{ id, conversationId: conversation.id, action: 'BOT_OUTSIDE_HOURS_RECEPTION', ...stamp, details: { revision: REVISION, botId: bot.id, period, state: 'CLAIMED', inboundId: message.id } }], skipDuplicates: true });
      return marker.count === 1;
    });
  } catch (error) {
    if (error.code === 'P2002' || error.code === 'RECEPTION_SKIP') return true;
    throw error;
  }
  if (!claimed) return true;
  let attempted = false;
  try {
    const fresh = await db.conversation.findUnique({ where: { id: conversation.id }, include: { botState: true, category: true, company: true } });
    const currentBot = await db.bot.findUnique({ where: { id: bot.id } });
    const account = await db.channelAccount.findUnique({ where: { id: inboundAccount.id } });
    if (fresh?.categoryId !== conversation.categoryId) throw Error('CATEGORY_CHANGED');
    if (!humanFree(fresh) || !fresh.company?.active || fresh.companyId !== bot.companyId || account?.companyId !== bot.companyId || !account.enabled || account.status !== 'CONNECTED' || account.channel !== 'META' || fresh.channelAccountId !== conversation.channelAccountId || currentBot?.status !== 'ACTIVE' || !currentBot.autoReplyEnabled || currentBot.featureFlags?.outsideHoursReceptionRevision !== REVISION || await isOptedOut(conversation.contact.phone, bot.companyId)) throw Error('REVALIDATION_BLOCKED');
    // A real human reply that raced with this inbound message always wins.
    const human = await db.message.findFirst({ where: { conversationId: fresh.id, direction: 'ENVIADA', sentByUserId: { not: null }, occurredAt: { gte: message.occurredAt || now } }, select: { id: true } });
    if (human) throw Error('HUMAN_REPLIED');
    if (!(await automationStillEnabled())) throw Error('AUTOMATION_DISABLED');
    await assertWindow(fresh.id, new Date(), inboundScope || null);
    attempted = true;
    const text = noticeText(bot, conversation, resolved.availability.holiday);
    const result = await boundedSend(() => send(account, conversation.contact.phone, text));
    const occurredAt = new Date();
    await db.$transaction(async tx => {
      await tx.message.create({ data: { conversationId: fresh.id, channelAccountId: inboundScope || null, channel: 'META', direction: 'ENVIADA', status: 'ENVIADA', type: 'text', text, occurredAt, ...stamp, externalId: result?.externalId ? (inboundScope ? `${inboundScope}:${result.externalId}` : result.externalId) : null, rawPayload: { system: 'outside_hours_reception', flowHandoff: true, botId: bot.id, period } } });
      await tx.conversation.updateMany({ where: { id: fresh.id, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: occurredAt } }] }, data: { lastMessageAt: occurredAt } });
      await tx.conversationActivity.update({ where: { id }, data: { details: { revision: REVISION, botId: bot.id, period, state: 'SENT' } } });
    });
  } catch (error) {
    await db.conversationActivity.update({ where: { id }, data: { details: { revision: REVISION, botId: bot.id, period, state: attempted ? 'UNKNOWN' : 'SKIPPED' } } });
    // No provider text/credentials in logs or activity. The message is queued.
  }
  return true;
}

module.exports = { receiveOutsideHours, claimId, humanFree, MESSAGE, boundedSend, noticeText };
