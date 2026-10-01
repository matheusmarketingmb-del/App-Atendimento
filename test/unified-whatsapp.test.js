// Persistence tests must only run in the isolated review container.
if (!process.env.DATABASE_URL?.includes("unified-review-db") || process.env.ALLOW_ISOLATED_UNIFIED_TEST !== "yes") throw new Error("Banco isolado obrigatório.");
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const unified = require("../src/services/whatsapp-inbox-service");
const inbox = require("../src/services/inbox-service");
const authorization = require("../src/services/authorization-service");
const { findOrCreateMetaConversation } = require("../src/services/conversation-service");
const { getCustomerServiceWindow, sendApprovedTemplate } = require("../src/services/meta-template-service");
const channelMessages = require("../src/services/channels/channel-message-service");
const { initialize } = require("../scripts/initialize-unified-whatsapp");
let master, agent, parent, child, other, a, b, root, old, contact;
test.before(async () => {
  master = await prisma.user.create({ data: { name: "Master teste", email: "master@unified.test", passwordHash: "fake", role: "ADMIN" } });
  agent = await prisma.user.create({ data: { name: "Atendente teste", email: "agent@unified.test", passwordHash: "fake", role: "ATENDENTE", canViewUncategorized: true, canViewPreviousMessages: true } });
  parent = await prisma.category.create({ data: { name: "Setor", code: "UNIFIED_PARENT" } });
  child = await prisma.category.create({ data: { name: "Subsetor", code: "UNIFIED_CHILD", parentId: parent.id } });
  other = await prisma.category.create({ data: { name: "Outro", code: "UNIFIED_OTHER" } });
  await prisma.userCategoryAccess.create({ data: { userId: agent.id, categoryId: parent.id } });
  a = await prisma.channelAccount.create({ data: { channel: "META", name: "A", enabled: true, status: "CONNECTED", config: { wabaId: "waba-a", outboundCategoryIds: [parent.id] } } });
  b = await prisma.channelAccount.create({ data: { channel: "META", name: "B", enabled: true, status: "CONNECTED", config: { wabaId: "waba-b", outboundCategoryIds: [child.id] } } });
  await prisma.channelAccountUserAccess.create({ data: { channelAccountId: a.id, userId: agent.id } });
  contact = await prisma.contact.create({ data: { channel: "META", externalId: "5511991111111", phone: "5511991111111", name: "Teste" } });
  old = await prisma.conversation.create({ data: { contactId: contact.id, channel: "META", channelScope: b.id, channelAccountId: b.id, status: "FINALIZADO" } });
  root = await prisma.conversation.create({ data: { contactId: contact.id, channel: "META", channelScope: a.id, channelAccountId: a.id, categoryId: parent.id, assignedUserId: agent.id, status: "EM_ATENDIMENTO" } });
  await unified.attachInbox(contact.id, root.id);
  await prisma.message.create({ data: { conversationId: old.id, channel: "META", channelAccountId: b.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text", text: "histórico B", externalId: "wamid.old-b", occurredAt: new Date() } });
  await prisma.message.create({ data: { conversationId: root.id, channel: "META", channelAccountId: a.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text", text: "mensagem A", externalId: "wamid.in-a", occurredAt: new Date() } });
});
test.after(() => prisma.$disconnect());

test("o mesmo cliente nos dois números usa o mesmo atendimento", async () => {
  for (const account of [a, b]) {
    const found = await findOrCreateMetaConversation({ contactExternalId: contact.externalId, phone: contact.phone, contactName: "Teste", channelAccountId: account.id });
    assert.equal(found.contact.id, contact.id);
    assert.equal(found.conversation.id, root.id);
  }
  assert.equal(await prisma.conversation.count({ where: { contactId: contact.id } }), 2);
});
test("ponteiro não muda numa segunda associação", async () => {
  assert.equal((await unified.attachInbox(contact.id, old.id)).id, root.id);
});
test("listagem e contadores escondem só o cartão redundante, não apagam história", async () => {
  const cards = await inbox.listConversations({ search: contact.phone }, master);
  assert.deepEqual(cards.map(c => c.id), [root.id]);
  assert.equal((await inbox.getConversationSummary(master)).total, 1);
  assert.equal(await prisma.message.count(), 2);
});
test("Master lê história de ambos os números", async () => {
  assert.equal((await inbox.getConversation(root.id, master)).messages.length, 2);
});
test("atendente não lê mensagens do número não liberado", async () => {
  const detail = await inbox.getConversation(root.id, agent);
  assert.deepEqual(detail.messages.map(m => m.text), ["mensagem A"]);
  await assert.rejects(inbox.assertCanViewMessage(agent, (await prisma.message.findFirst({ where: { conversationId: old.id } })).id));
});
test("ação pelo ID antigo é bloqueada", async () => {
  await assert.rejects(authorization.assertCanActOnConversation(master, old.id), e => e.code === "UNIFIED_INBOX_REQUIRED");
});
test("categoria pai roteia ao A, subcategoria explícita ao B", async () => {
  assert.equal((await unified.senderState(root, master)).selectedId, a.id);
  assert.equal((await unified.senderState({ ...root, categoryId: child.id }, master)).selectedId, b.id);
  assert.deepEqual(unified.routingCandidates({ id: "new-child", parentId: parent.id }, [a, b]).map(c => c.id), [a.id]);
});
test("número configurado mas não liberado não cai no principal", async () => {
  const state = await unified.senderState({ ...root, categoryId: child.id }, agent);
  assert.equal(state.selectedId, null);
  assert.equal(state.options.length, 0);
  await assert.rejects(unified.applySender({ ...root, categoryId: child.id }, agent.id), e => e.code === "WHATSAPP_SENDER_REQUIRED");
});
test("categoria sem configuração exige escolha", async () => {
  assert.equal((await unified.senderState({ ...root, categoryId: other.id }, master)).selectedId, null);
});
test("configuração ambígua exige escolha, nunca seleciona o primeiro", async () => {
  await prisma.channelAccount.update({ where: { id: b.id }, data: { config: { ...b.config, outboundCategoryIds: [parent.id, child.id] } } });
  const state = await unified.senderState(root, master);
  assert.equal(state.selectedId, null);
  assert.equal(state.options.length, 2);
  assert.equal((await unified.senderState({ ...root, whatsappSendAccountId: b.id }, master)).selectedId, null);
  assert.equal((await unified.senderState({ ...root, whatsappSendAccountId: b.id }, agent)).selectedId, null);
  await prisma.channelAccount.update({ where: { id: b.id }, data: { config: b.config } });
});
test("janela de 24h é por número, inclusive no histórico antigo", async () => {
  assert.equal((await getCustomerServiceWindow(root.id, new Date(), b.id)).open, true);
  await prisma.message.updateMany({ where: { channelAccountId: b.id }, data: { occurredAt: new Date(Date.now() - 25 * 3600000) } });
  assert.equal((await getCustomerServiceWindow(root.id, new Date(), a.id)).open, true);
  const closed = await getCustomerServiceWindow(root.id, new Date(), b.id);
  assert.equal(closed.open, false);
  assert.equal(closed.requiresTemplate, true);
  assert.equal(closed.state, "EXPIRED");
  assert.equal(closed.senderAccountId, b.id);
});
test("transferência para número sem recebimento pede iniciação, template não abre janela", async () => {
  const customer = await prisma.contact.create({ data: { channel: "META", externalId: "5511888888888", phone: "5511888888888" } });
  const conversation = await prisma.conversation.create({ data: { contactId: customer.id, channel: "META", channelAccountId: a.id, channelScope: a.id } });
  await unified.attachInbox(customer.id, conversation.id);
  await prisma.message.create({ data: { conversationId: conversation.id, channel: "META", channelAccountId: a.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text", externalId: "wamid.transfer-a", text: "Olá", occurredAt: new Date() } });
  assert.equal((await getCustomerServiceWindow(conversation.id, new Date(), b.id)).state, "NOT_STARTED");
  await prisma.message.create({ data: { conversationId: conversation.id, channel: "META", channelAccountId: b.id, direction: "ENVIADA", status: "ENVIADA", type: "template", text: "Iniciar", occurredAt: new Date() } });
  const waiting = await getCustomerServiceWindow(conversation.id, new Date(), b.id);
  assert.equal(waiting.state, "AWAITING_REPLY");
  assert.equal(waiting.requiresTemplate, true);
  assert.equal(waiting.open, false);
  await prisma.message.create({ data: { conversationId: conversation.id, channel: "META", channelAccountId: b.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text", externalId: "wamid.transfer-b", text: "Oi", occurredAt: new Date(Date.now() + 1) } });
  assert.equal((await getCustomerServiceWindow(conversation.id, new Date(), b.id)).state, "OPEN");
  // Retorno ao número original reutiliza a própria janela, não cria outra conversa.
  assert.equal((await getCustomerServiceWindow(conversation.id, new Date(), a.id)).state, "OPEN");
});
test("trocar categoria limpa escolha manual e muda conta operacional", async () => {
  await assert.rejects(inbox.updateConversation(root.id, { whatsappSendAccountId: a.id }, master), e => e.statusCode === 400);
  await prisma.conversation.update({ where: { id: root.id }, data: { whatsappSendAccountId: a.id } });
  const changed = await inbox.updateConversation(root.id, { categoryId: child.id }, master);
  assert.equal(changed.whatsappSendAccountId, null);
  assert.equal(changed.channelAccountId, b.id);
  await inbox.updateConversation(root.id, { categoryId: parent.id }, master);
});
test("template usa e registra o número da categoria, sem rede real", async () => {
  const original = channelMessages.adapterFor;
  let used;
  channelMessages.adapterFor = async (_channel, id) => { used = id; return { channel: {
    listMessageTemplates: async () => [{ name: "hello", language: "pt_BR", status: "APPROVED", components: [{ type: "BODY", text: "Olá" }] }],
    sendTemplate: async () => ({ externalId: "wamid.template-fake", data: {} }),
  } }; };
  try {
    const result = await sendApprovedTemplate({ conversationId: root.id, name: "hello", language: "pt_BR", sentByUserId: master.id, channel: {} });
    assert.equal(used, a.id);
    assert.equal(result.message.channelAccountId, a.id);
    assert.equal(result.message.conversationId, root.id);
  } finally { channelMessages.adapterFor = original; }
});
test("número desconectado mantém rota bloqueada, sem oferecer outro número", async () => {
  await prisma.channelAccount.update({ where: { id: a.id }, data: { status: "ERROR" } });
  const state = await unified.senderState(root, master);
  assert.equal(state.selectedId, null);
  assert.equal(state.options.length, 0);
  await prisma.channelAccount.update({ where: { id: a.id }, data: { status: "CONNECTED" } });
});
test("sem mensagem recebida, número do envio inicial continua selecionado", async () => {
  const blank = await prisma.contact.create({ data: { channel: "META", externalId: "5511992222222", phone: "5511992222222" } });
  const current = await prisma.conversation.create({ data: { contactId: blank.id, channel: "META", channelScope: b.id, channelAccountId: b.id } });
  await unified.attachInbox(blank.id, current.id);
  assert.equal((await unified.senderState(current, master)).selectedId, null);
  await prisma.message.create({ data: { conversationId: current.id, channel: "META", channelAccountId: b.id, direction: "ENVIADA", status: "ENVIADA", type: "template", externalId: "wamid.initial-b", occurredAt: new Date() } });
  assert.equal((await unified.senderState(current, master)).selectedId, b.id);
});
test("bot resolve o remetente do setor, não o canal que recebeu o evento", async () => {
  const original = channelMessages.adapterFor;
  const fake = { sendText: async () => { throw Error("não deve enviar no teste"); } };
  let used;
  channelMessages.adapterFor = async (_type, id) => { used = id; return { channel: fake }; };
  try {
    assert.equal(await unified.botChannel({ ...root }, { phoneNumberId: "another-number" }), fake);
    assert.equal(used, a.id);
  } finally { channelMessages.adapterFor = original; }
});
test("documento usa o número do setor e registra essa conta", async () => {
  const original = channelMessages.send;
  let used;
  channelMessages.send = async payload => { used = payload.channelAccountId; return { externalId: "wamid.document-fake", data: {} }; };
  try {
    const result = await require("../src/services/message-service").sendDocument({ conversationId: root.id, sentByUserId: master.id, buffer: Buffer.from("%PDF-1.4\nfake"), mimeType: "application/pdf", fileName: "teste.pdf", channel: {} });
    assert.equal(used, a.id);
    assert.equal(result.message.channelAccountId, a.id);
  } finally { channelMessages.send = original; }
});
test("transferência sem histórico não reabre mensagens antigas pelo ID anterior", async () => {
  const next = await prisma.user.create({ data: { name: "Novo atendente", email: "next@unified.test", role: "ATENDENTE", canViewUncategorized: true, canViewPreviousMessages: true } });
  await prisma.userCategoryAccess.create({ data: { userId: next.id, categoryId: parent.id } });
  await prisma.channelAccountUserAccess.createMany({ data: [a,b].map(account => ({ channelAccountId: account.id, userId: next.id })) });
  await inbox.updateConversation(root.id, { assignedUserId: next.id, shareHistory: false }, master);
  assert.equal((await inbox.getConversation(root.id, next)).messages.length, 0);
  assert.equal((await inbox.getConversation(old.id, next)).messages.length, 0);
  await assert.rejects(inbox.assertCanViewMessage(next, (await prisma.message.findFirst({ where: { conversationId: old.id } })).id));
  assert.ok((await inbox.getConversation(root.id, master)).messages.length >= 3);
});
test("inicializador preserva linhas e é idempotente", async () => {
  const before = { conversations: await prisma.conversation.count(), messages: await prisma.message.count(), contacts: await prisma.contact.count() };
  const env = { PHONE_NUMBER_ID: "fake-primary", WHATSAPP_TOKEN: "fake-token", WHATSAPP_BUSINESS_ACCOUNT_ID: "fake-waba", GRAPH_VERSION: "v24.0" };
  await initialize(prisma, { apply: false, env });
  await initialize(prisma, { apply: true, env });
  await initialize(prisma, { apply: true, env });
  assert.equal(await prisma.channelAccount.count({ where: { config: { path: ["isLegacyWhatsApp"], equals: true } } }), 1);
  assert.deepEqual({ conversations: await prisma.conversation.count(), messages: await prisma.message.count(), contacts: await prisma.contact.count() }, before);
});
