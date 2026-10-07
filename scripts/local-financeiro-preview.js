// Prévia isolada: banco e credenciais fictícios, sem .env, workers ou envio real.
process.env.DATABASE_URL = 'postgresql://bot_qa:isolated-local-qa@127.0.0.1:25432/bot_qa?schema=financeiro_preview_20261007';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'isolated-financeiro-preview-only-20261007';
for (const name of ['WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'META_APP_SECRET', 'META_APP_ID', 'VAPID_PRIVATE_KEY']) process.env[name] = '';
const prisma = require('../src/database/prisma');
const bcrypt = require('bcryptjs');
const { createApp } = require('../src/app');
const preferred = require('../src/services/preferred-assignee-service');
async function prepare() {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: 'cmp_mibro' } });
  const passwordHash = await bcrypt.hash('teste-local-bots', 4);
  const users = {};
  for (const [key, name, role] of [['master', 'Master QA local', 'ADMIN'], ['ana', 'Ana — Financeiro QA', 'ATENDENTE'], ['carlos', 'Carlos — Atendimento QA', 'ATENDENTE']]) {
    const email = key === 'master' ? 'bot-qa@teste.local' : `${key}-qa@teste.local`;
    users[key] = await prisma.user.upsert({ where: { email }, update: { passwordHash }, create: { name, email, role, passwordHash, canViewPreviousMessages: true, canViewUncategorized: true } });
    await prisma.userCompanyAccess.upsert({ where: { userId_companyId: { userId: users[key].id, companyId: company.id } }, update: { active: true }, create: { userId: users[key].id, companyId: company.id } });
  }
  const finance = await prisma.category.upsert({ where: { companyId_code: { companyId: company.id, code: 'FINANCEIRO_PREVIEW' } }, update: { visibilityMode: 'SECTOR_PRIVATE' }, create: { companyId: company.id, code: 'FINANCEIRO_PREVIEW', name: 'Financeiro — demonstração', color: '#6d8ce8', visibilityMode: 'SECTOR_PRIVATE' } });
  const support = await prisma.category.findUniqueOrThrow({ where: { companyId_code: { companyId: company.id, code: 'SUPORTE' } } });
  for (const [user, category] of [[users.ana, finance], [users.carlos, support]]) await prisma.userCategoryAccess.upsert({ where: { userId_categoryId: { userId: user.id, categoryId: category.id } }, update: {}, create: { userId: user.id, categoryId: category.id } });
  const contact = await prisma.contact.upsert({ where: { id: 'financeiro-preview-contact' }, update: {}, create: { id: 'financeiro-preview-contact', companyId: company.id, externalId: 'financeiro-preview', phone: '5511000000000', name: 'Cliente fictício — histórico protegido' } });
  let conversation = await prisma.conversation.findUnique({ where: { id: 'financeiro-preview-conversation' } });
  if (!conversation) {
    conversation = await prisma.conversation.create({ data: { id: 'financeiro-preview-conversation', companyId: company.id, contactId: contact.id, categoryId: finance.id, assignedUserId: users.ana.id, status: 'EM_ATENDIMENTO' } });
    await prisma.message.create({ data: { conversationId: conversation.id, direction: 'RECEBIDA', status: 'RECEBIDA', type: 'text', text: 'DADO FICTÍCIO PRIVADO: negociação financeira demonstrativa, visível só ao Financeiro e ao Master.', occurredAt: new Date(Date.now() - 60000) } });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { categoryId: support.id, assignedUserId: users.carlos.id, lastMessageAt: new Date() } });
    await prisma.message.create({ data: { conversationId: conversation.id, direction: 'RECEBIDA', status: 'RECEBIDA', type: 'text', text: 'Agora estou no atendimento comum. Carlos é meu atendente fixo. Esta conversa é fictícia.', occurredAt: new Date() } });
  }
  await preferred.setPreferredAssignee(contact.id, { userId: users.carlos.id, enabled: true, reason: 'Demonstração local com dados fictícios' }, users.master);
  // Demonstração dos painéis novos: somente registros fictícios, sem tokens,
  // chamadas à Meta ou tarifas reais inventadas.
  const costs = require('../src/services/meta-cost-service');
  for (const [suffix, companyId, categoryId, status] of [
    ['mibro-pendente', 'cmp_mibro', support.id, 'AGUARDANDO_EQUIPE'],
    ['mibro-financeiro', 'cmp_mibro', finance.id, 'NOVO'],
    ['sincrofit-pendente', 'cmp_sincrofit', null, 'NOVO'],
  ]) {
    const accountId = `local-demo-number-${companyId}`;
    await prisma.channelAccount.upsert({ where: { id: accountId }, update: {}, create: {
      id: accountId, companyId, channel: 'META', name: `Número fictício — ${companyId} (local)`, externalAccountId: accountId,
      config: {},
    } });
    const demoContact = await prisma.contact.upsert({ where: { id: `local-demo-contact-${suffix}` }, update: {}, create: {
      id: `local-demo-contact-${suffix}`, companyId, externalId: `local-demo-${suffix}`, phone: '5511000000001', name: `Cliente fictício — ${suffix}`,
    } });
    const demo = await prisma.conversation.upsert({ where: { id: `local-demo-conversation-${suffix}` }, update: {}, create: {
      id: `local-demo-conversation-${suffix}`, companyId, contactId: demoContact.id, channelAccountId: accountId, categoryId, status,
      lastMessageAt: new Date(Date.now() - 40 * 60000),
    } });
    const message = await prisma.message.upsert({ where: { id: `local-demo-message-${suffix}` }, update: {}, create: {
      id: `local-demo-message-${suffix}`, conversationId: demo.id, channelAccountId: accountId, channel: 'META', direction: 'ENVIADA', status: 'ENVIADA',
      externalId: `local-demo-status-${suffix}`, privateCategoryId: categoryId === finance.id ? finance.id : null,
      type: 'text', text: 'DEMONSTRAÇÃO LOCAL: registro fictício, nenhuma mensagem enviada.', occurredAt: new Date(),
    } });
    await costs.recordStatusEvent({ kind: 'status', externalId: message.externalId, status: 'delivered', occurredAt: new Date(), rawPayload: {
      pricing: suffix === 'mibro-pendente' ? { category: 'service', billable: false, type: 'free_customer_service' } : { category: 'utility', billable: true, type: 'regular' },
    } });
  }
  // Qualquer tentativa de envio retorna erro local explícito; nada sai pela Meta.
  const blocked = async () => { throw new Error('Envio real bloqueado na prévia local.'); };
  const dispatcher = require('../src/services/channels/channel-message-service');
  dispatcher.send = blocked;
  dispatcher.adapterFor = blocked;
  const disabled = new Proxy({}, { get: () => blocked });
  createApp({ channel: disabled }).listen(3339, '127.0.0.1', () => console.log('Prévia Financeiro: http://127.0.0.1:3339 — dados fictícios, sem envio real.'));
}
prepare().catch(async error => { console.error(error.message); await prisma.$disconnect(); process.exitCode = 1; });
