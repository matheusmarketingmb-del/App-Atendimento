// Deterministic assistant; no external model, shared knowledge or product promises.
const BOT_ID = 'sincrofit-assistant';
const COMPANY_ID = 'cmp_sincrofit';
const TRIAGE_ID = 'sincrofit-system-triage-20261022';

function belongsToAssistantAccount(bot, conversation) {
  return bot?.id === BOT_ID && bot.companyId === COMPANY_ID
    && conversation.companyId === COMPANY_ID
    && bot.featureFlags?.assistantAfterTriage === true
    && bot.featureFlags?.scheduleSourceBotId === TRIAGE_ID
    && conversation.channel === 'META'
    && conversation.channelAccount?.config?.inboundBotId === TRIAGE_ID
    && Array.isArray(bot.featureFlags.channelAccountIds)
    && bot.featureFlags.channelAccountIds.includes(conversation.channelAccountId);
}

function buildGraph() {
  const nodes = [], edges = [];
  const node = (key, type, config) => nodes.push({ key, type, name: key, x: 80 + nodes.length % 4 * 300, y: 80 + Math.floor(nodes.length / 4) * 190, config });
  const edge = (source, sourceHandle, target) => edges.push({ id: `${source}:${sourceHandle}:${target}`, source, sourceHandle, target });
  const ask = (key, text) => node(key, 'question', { text, variable: `flow.${key}`, answerType: 'TEXT', maxAttempts: 2 });
  const route = (key, code, yes, no) => {
    node(key, 'condition', { rules: [{ left: 'conversation.categoryCode', operator: '==', right: code }] });
    edge(key, 'true', yes); edge(key, 'false', no);
  };
  node('start', 'start', { trigger: 'AFTER_TRIAGE', channels: ['META'], initialMessage: '' });
  edge('start', 'next', 'technical');
  route('technical', 'ASSISTENCIA_TECNICA', 'product', 'warranty');
  route('warranty', 'GARANTIA', 'product', 'support');
  route('support', 'SUPORTE', 'product', 'retail');
  route('retail', 'VAREJO', 'interest', 'service');
  route('service', 'ATENDIMENTO', 'order', 'partnership');
  route('partnership', 'PARCERIAS', 'social', 'handoff');
  ask('product', 'Olá! Sou o assistente da Sincrofit. Qual é a marca e o modelo do produto? Se não souber, descreva o produto.');
  node('known_problem', 'condition', { rules: [{ left: 'flow.initialNeed', operator: 'exists', right: '' }] });
  node('reuse_problem', 'variable', { assignments: [{ key: 'flow.problem', value: '{{flow.initialNeed}}' }] });
  ask('problem', 'O que aconteceu com o produto e há quanto tempo?');
  ask('attempts', 'O que você já tentou fazer e qual foi o resultado? Se ainda não tentou nada, pode informar.');
  ask('purchase', 'Onde e aproximadamente quando foi comprado? Se tiver, envie também a nota fiscal e uma foto ou vídeo do problema para a equipe analisar. Você pode continuar mesmo sem esses documentos.');
  edge('product', 'next', 'known_problem'); edge('known_problem', 'true', 'reuse_problem'); edge('known_problem', 'false', 'problem');
  edge('reuse_problem', 'next', 'attempts'); edge('problem', 'next', 'attempts'); edge('attempts', 'next', 'purchase'); edge('purchase', 'next', 'handoff');
  ask('interest', 'Qual produto você procura e o que gostaria de saber sobre ele?');
  node('site', 'message', { source: 'TEXT', text: 'Você também pode conhecer nossos produtos no site: https://sincrofit.com.br/\nNossa equipe pode confirmar as informações do produto e as condições de compra.' });
  edge('interest', 'next', 'site'); edge('site', 'next', 'handoff');
  ask('order', 'Como podemos ajudar com seu atendimento? Se for sobre uma compra, informe o número do pedido e o local da compra, se tiver.');
  ask('social', 'Conte sua proposta de parceria e envie o link do seu perfil ou site, se tiver.');
  edge('order', 'next', 'handoff'); edge('social', 'next', 'handoff');
  node('handoff', 'human_handoff', { message: 'Entendido! Vou encaminhar as informações para nossa equipe continuar seu atendimento por aqui.', reason: 'Assistente Sincrofit: informações coletadas no fluxo, disponíveis no histórico da conversa.' });
  return { nodes, edges, viewport: { x: 0, y: 0, zoom: 0.7 } };
}

// Explicit provisioning only: never called by startup, never overwrites an existing bot.
async function provision(client) {
  const { validateGraph } = require('./bot-visual-flow-graph');
  const graph = validateGraph(buildGraph());
  if (!graph.valid) throw new Error(JSON.stringify(graph.errors));
  return client.$transaction(async tx => {
    if (await tx.bot.findUnique({ where: { id: BOT_ID } })) return { created: false, botId: BOT_ID };
    const triage = await tx.bot.findFirst({ where: { id: TRIAGE_ID, companyId: COMPANY_ID, type: 'SYSTEM_TRIAGE', archivedAt: null } });
    if (!triage) throw new Error('Triagem Sincrofit não encontrada; nenhuma configuração criada.');
    const accounts = await tx.channelAccount.findMany({ where: { companyId: COMPANY_ID, channel: 'META' }, select: { id: true, config: true } });
    const channelAccountIds = accounts.filter(a => a.config?.inboundBotId === TRIAGE_ID).map(a => a.id);
    if (!channelAccountIds.length) throw new Error('Nenhum número vinculado à Triagem Sincrofit.');
    await tx.bot.create({ data: {
      id: BOT_ID, companyId: COMPANY_ID, name: 'Assistente Sincrofit', channel: 'META',
      status: 'PAUSED', autoReplyEnabled: false, executionMode: 'FLOW_BUILDER',
      runOnNewConversation: false, runAfterReopen: true, toolsEnabled: false, ratingEnabled: false,
      initialMessage: '', outsideHoursMessage: triage.outsideHoursMessage,
      holidayMessage: triage.holidayMessage, timezone: triage.timezone,
      fallbackMessage: 'Vou chamar nossa equipe para continuar seu atendimento.',
      handoffMessage: 'Nossa equipe continuará o atendimento por aqui.',
      description: 'Assistência após triagem da Sincrofit. Atacado segue com a equipe; sem IA externa.',
      featureFlags: { assistantAfterTriage: true, availabilityManaged: true, assistantCalendarRevision: 'assistant-20261027', scheduleSourceBotId: TRIAGE_ID, channelAccountIds },
    } });
    const flow = await tx.botFlow.create({ data: { botId: BOT_ID, name: 'Assistência Sincrofit após Triagem', draftGraph: graph.graph, isDefault: true } });
    const version = await tx.botFlowVersion.create({ data: { flowId: flow.id, version: 1, graph: graph.graph, label: 'Preparação local — pausado' } });
    await tx.botFlow.update({ where: { id: flow.id }, data: { activeVersionId: version.id, status: 'ACTIVE' } });
    return { created: true, botId: BOT_ID, flowId: flow.id, status: 'PAUSED', autoReplyEnabled: false };
  });
}

module.exports = { BOT_ID, COMPANY_ID, TRIAGE_ID, belongsToAssistantAccount, buildGraph, provision };
