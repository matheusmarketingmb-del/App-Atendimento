require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const prisma = require("../src/database/prisma");
const { MAX_DOCUMENT_SIZE, resolveImage, resolveMedia, validateDocument } = require("../src/services/media-storage-service");
const { closingMessage, finalizeConversation, saveIncoming, sendDocument, sendImage, sendText, sendVideo } = require("../src/services/message-service");
const { customerServiceWindowFrom, getCustomerServiceWindow, sendApprovedTemplate } = require("../src/services/meta-template-service");
const { createOutboundConversation, normalizeOutboundPhone } = require("../src/services/outbound-conversation-service");
const inbox = require("../src/services/inbox-service");
const mediaTestDir = path.join(os.tmpdir(), `app-whats-media-test-${process.pid}`);
process.env.MEDIA_STORAGE_DIR = mediaTestDir;
const masterViewer = { id: "master-test", role: "ADMIN" };

test.before(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.contact.deleteMany();
});
test.after(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.user.deleteMany({ where: { email: "teste@mibro.local" } });
  await prisma.category.deleteMany({ where: { OR: [
    { code: { startsWith: "FINANCEIRO_TESTE" } },
    { code: { startsWith: "SUPORTE_VIP_TESTE" } },
    { code: { startsWith: "SUPORTE_FILHO_RESPONSAVEL_TESTE" } },
    { code: { startsWith: "CASCATA_TESTE" } },
  ] } });
  await fs.rm(mediaTestDir, { recursive: true, force: true });
  await prisma.$disconnect();
});

test("persiste contato, conversa e mensagem sem duplicar wamid", async () => {
  const event = {
    externalId: "wamid.test.incoming", contactExternalId: "5511999999999",
    phone: "5511999999999", contactName: "Cliente Teste", type: "text", text: "Preciso de suporte",
    occurredAt: new Date(), rawPayload: { id: "wamid.test.incoming" },
  };
  const results = await Promise.all([saveIncoming(event), saveIncoming(event)]);
  assert.deepEqual(results.map((item) => item.duplicate).sort(), [false, true]);
  assert.equal(await prisma.contact.count(), 1);
  assert.equal(await prisma.conversation.count(), 1);
  assert.equal(await prisma.message.count(), 1);
  const conversation = await prisma.conversation.findFirst();
  assert.equal(conversation.unreadCount, 1);
  assert.equal(conversation.status, "NOVO");
});

test("registra mensagem enviada e o atendente autor", async () => {
  const user = await prisma.user.upsert({
    where: { email: "teste@mibro.local" }, update: { role: "ADMIN" },
    create: { name: "Atendente Teste", email: "teste@mibro.local", role: "ADMIN" },
  });
  masterViewer.id = user.id;
  const category = await prisma.category.findUnique({ where: { code: "SUPORTE" } });
  let conversation = await prisma.conversation.findFirst();
  conversation = await inbox.updateConversation(conversation.id, { categoryId: category.id }, masterViewer);
  assert.equal(conversation.status, "NOVO");
  let providerText;
  const channel = { sendText: async (_phone, text) => { providerText = text; return { externalId: "wamid.test.outgoing", data: { messages: [{ id: "wamid.test.outgoing" }] } }; } };
  const result = await sendText({ conversationId: conversation.id, text: "Qual é o modelo?", sentByUserId: user.id, channel });
  assert.equal(providerText, "[*Suporte*]\n\nQual é o modelo?");
  assert.equal(result.message.text, "Qual é o modelo?");
  assert.equal(result.message.direction, "ENVIADA");
  assert.equal(result.message.sentByUserId, user.id);
  assert.equal(await prisma.message.count(), 2);
  const updatedConversation = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  // Empresa acabou de responder: AGUARDANDO_CLIENTE (não mais o mesmo
  // EM_ATENDIMENTO usado só para "assumiu, ainda não respondeu").
  assert.equal(updatedConversation.status, "AGUARDANDO_CLIENTE");
  assert.equal(updatedConversation.assignedUserId, user.id);
  assert.equal(await prisma.conversationActivity.count({
    where: { conversationId: conversation.id, action: "CONVERSATION_CLAIMED", actorUserId: user.id },
  }), 1);
});

test("bloqueia mensagem livre fora da janela de 24h e permite template aprovado", async () => {
  const previousWabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "waba-window-test";
  const disabledWindow = customerServiceWindowFrom(
    new Date(Date.now() - (25 * 60 * 60 * 1000)),
    new Date(),
    false,
  );
  assert.equal(disabledWindow.configured, false);
  assert.equal(disabledWindow.requiresTemplate, false);
  const user = await prisma.user.findUnique({ where: { email: "teste@mibro.local" } });
  const contact = await prisma.contact.create({ data: { externalId: "template-window-test", phone: "5511999990011", name: "Cliente Template" } });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
  await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: "wamid.window.old", channel: "META",
    direction: "RECEBIDA", status: "RECEBIDA", type: "text", text: "Mensagem antiga",
    occurredAt: new Date(Date.now() - (25 * 60 * 60 * 1000)),
  } });
  await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: "lp-atacado:window-test", channel: "META",
    direction: "RECEBIDA", status: "RECEBIDA", type: "text", text: "Lead externo recente",
    occurredAt: new Date(), rawPayload: { source: "lp_atacado_mibro" },
  } });
  const window = await getCustomerServiceWindow(conversation.id);
  assert.equal(window.open, false);
  let freeFormCalled = false;
  await assert.rejects(
    sendText({ conversationId: conversation.id, text: "Mensagem livre", sentByUserId: user.id, channel: { sendText: async () => { freeFormCalled = true; } } }),
    (error) => error.code === "TEMPLATE_REQUIRED" && error.statusCode === 409,
  );
  assert.equal(freeFormCalled, false);
  const template = {
    id: "template-1", name: "retomar_atendimento", language: "pt_BR", category: "UTILITY", status: "APPROVED",
    components: [{ type: "BODY", text: "Olá, {{1}}. Podemos continuar seu atendimento?", example: { body_text: [["Matheus"]] } }],
  };
  let sentTemplate;
  const result = await sendApprovedTemplate({
    conversationId: conversation.id, name: template.name, language: template.language,
    values: { "BODY:1": "Cliente" }, sentByUserId: user.id,
    channel: {
      listMessageTemplates: async () => [template],
      sendTemplate: async (phone, payload) => { sentTemplate = { phone, payload }; return { externalId: "wamid.template.out", data: { messages: [{ id: "wamid.template.out" }] } }; },
    },
  });
  assert.equal(sentTemplate.phone, contact.phone);
  assert.equal(sentTemplate.payload.components[0].parameters[0].text, "Cliente");
  assert.equal(result.message.type, "template");
  assert.equal(result.message.text, "Olá, Cliente. Podemos continuar seu atendimento?");
  await prisma.conversation.delete({ where: { id: conversation.id } });
  await prisma.contact.delete({ where: { id: contact.id } });
  if (previousWabaId === undefined) delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  else process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = previousWabaId;
});

test("cria uma nova conversa pelo painel com nome, telefone e template inicial", async () => {
  assert.equal(normalizeOutboundPhone("(11) 98888-7766"), "5511988887766");
  assert.throws(() => normalizeOutboundPhone("123"), /telefone válido/);
  const previousWabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "waba-outbound-test";
  let createdContactId;
  const user = await prisma.user.findUnique({ where: { email: "teste@mibro.local" } });
  const template = {
    id: "template-outbound", name: "iniciar_atendimento", language: "pt_BR",
    category: "UTILITY", status: "APPROVED",
    components: [{ type: "BODY", text: "Olá, {{1}}! Podemos iniciar seu atendimento?", example: { body_text: [["Cliente"]] } }],
  };
  let sent;
  const channel = {
    listMessageTemplates: async () => [template],
    sendTemplate: async (phone, payload) => {
      sent = { phone, payload };
      return { externalId: "wamid.outbound.test", data: { messages: [{ id: "wamid.outbound.test" }] } };
    },
  };
  try {
    const result = await createOutboundConversation({
      phone: "(11) 98888-7766", customName: "Cliente Novo",
      template: { name: template.name, language: template.language, values: { "BODY:1": "Cliente Novo" } },
      user: { id: user.id, role: user.role }, channel,
    });
    assert.equal(result.created, true);
    assert.equal(sent.phone, "5511988887766");
    const conversation = await prisma.conversation.findUnique({
      where: { id: result.conversationId }, include: { contact: true, messages: true },
    });
    createdContactId = conversation.contactId;
    assert.equal(conversation.contact.customName, "Cliente Novo");
    assert.equal(conversation.assignedUserId, user.id);
    // O template inicial já foi enviado (updateConversationAfterSending) —
    // AGUARDANDO_CLIENTE, não mais o EM_ATENDIMENTO inicial da criação.
    assert.equal(conversation.status, "AGUARDANDO_CLIENTE");
    assert.equal(conversation.messages[0].type, "template");
    assert.equal(await prisma.conversationActivity.count({
      where: { conversationId: conversation.id, action: "CONVERSATION_CREATED" },
    }), 1);

    const reused = await createOutboundConversation({
      phone: "5511988887766", customName: "Cliente Renomeado",
      template: { name: template.name, language: template.language, values: { "BODY:1": "Cliente" } },
      user: { id: user.id, role: user.role },
      channel: { ...channel, sendTemplate: async () => ({ externalId: "wamid.outbound.test.2", data: { messages: [{ id: "wamid.outbound.test.2" }] } }) },
    });
    assert.equal(reused.created, false);
    assert.equal(reused.conversationId, result.conversationId);
    assert.equal((await prisma.contact.findUnique({ where: { id: conversation.contactId } })).customName, "Cliente Renomeado");
  } finally {
    if (createdContactId) await prisma.contact.delete({ where: { id: createdContactId } }).catch(() => {});
    if (previousWabaId === undefined) delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    else process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = previousWabaId;
  }
});

test("permite apagar conversa somente para Master e remove seus dados relacionados", async () => {
  const master = await prisma.user.findUnique({ where: { email: "teste@mibro.local" } });
  const contact = await prisma.contact.create({
    data: { externalId: "delete-conversation-test", phone: "5511999990000", name: "Contato para exclusão" },
  });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id } });
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: "RECEBIDA",
      status: "RECEBIDA",
      type: "text",
      text: "Mensagem que será apagada",
      occurredAt: new Date(),
    },
  });
  await prisma.conversationPin.create({ data: { conversationId: conversation.id, userId: master.id } });

  await assert.rejects(
    () => inbox.deleteConversation(conversation.id, { id: "atendente", role: "ATENDENTE" }),
    /Somente uma conta Master/,
  );
  assert.ok(await prisma.conversation.findUnique({ where: { id: conversation.id } }));

  assert.deepEqual(
    await inbox.deleteConversation(conversation.id, { id: master.id, role: "ADMIN" }),
    { deleted: true, id: conversation.id },
  );
  assert.equal(await prisma.conversation.findUnique({ where: { id: conversation.id } }), null);
  assert.equal(await prisma.message.findUnique({ where: { id: message.id } }), null);
  assert.equal(await prisma.conversationPin.count({ where: { conversationId: conversation.id } }), 0);
  assert.ok(await prisma.contact.findUnique({ where: { id: contact.id } }));
  const deletionAudit = await prisma.auditLog.findFirst({
    where: { action: "CONVERSATION_DELETED", entityId: conversation.id },
  });
  assert.ok(deletionAudit);
  assert.match(deletionAudit.summary, /Apagou a conversa/);
  await assert.rejects(
    () => require("../src/services/audit-service").listAuditLogs({}, { id: "atendente", role: "ATENDENTE" }),
    /Somente uma conta Master/,
  );
});

test("lista, pesquisa, classifica, lê, finaliza e reabre a conversa", async () => {
  const category = await prisma.category.findUnique({ where: { code: "SUPORTE" } });
  const user = await prisma.user.findUnique({ where: { email: "teste@mibro.local" } });
  let conversation = await prisma.conversation.findFirst();
  // Garante o estado inicial NOVO independente do que outro teste no mesmo
  // arquivo tenha deixado na "primeira conversa". Assumir mantém NOVO até
  // que o atendente envie a primeira resposta.
  await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "NOVO", assignedUserId: null } });
  conversation = await inbox.updateConversation(conversation.id, {
    categoryId: category.id, assignedUserId: user.id,
  }, masterViewer);
  assert.equal(conversation.category.code, "SUPORTE");
  assert.equal(conversation.status, "NOVO");
  assert.equal(conversation.assignedUser.id, user.id);

  const result = await inbox.listConversations({ search: "Cliente", category: "SUPORTE", status: "NOVO" }, masterViewer);
  assert.equal(result.length, 1);
  assert.equal(result[0].messages[0].text, "Qual é o modelo?");

  await saveIncoming({
    externalId: "wamid.test.customer.reply", contactExternalId: "5511999999999",
    phone: "5511999999999", contactName: "Cliente Teste", type: "text", text: "É o modelo X1",
    occurredAt: new Date(Date.now() + 1000), rawPayload: { id: "wamid.test.customer.reply" },
  });
  assert.equal((await inbox.getConversation(conversation.id, masterViewer)).status, "NOVO");

  let readMessageId;
  const readResult = await inbox.markAsRead(conversation.id, { channel: { markAsRead: async (messageId) => { readMessageId = messageId; } } });
  assert.equal(readMessageId, "wamid.test.customer.reply");
  assert.equal(readResult.readReceiptSent, true);
  assert.equal((await inbox.getConversation(conversation.id, masterViewer)).unreadCount, 0);

  await saveIncoming({
    externalId: "wamid.test.read.rejected", contactExternalId: "5511999999999",
    phone: "5511999999999", contactName: "Cliente Teste", type: "text", text: "Nova mensagem para leitura local",
    occurredAt: new Date(), rawPayload: { id: "wamid.test.read.rejected" },
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  let rejectedRead;
  try {
    rejectedRead = await inbox.markAsRead(conversation.id, { channel: { markAsRead: async () => { throw new Error("Meta recusou"); } } });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(rejectedRead.readReceiptSent, false);
  assert.equal((await prisma.message.findUnique({ where: { externalId: "wamid.test.read.rejected" } })).status, "LIDA");
  assert.equal((await inbox.getConversation(conversation.id, masterViewer)).unreadCount, 0);

  await inbox.updateConversation(conversation.id, { status: "FINALIZADO" }, masterViewer);
  assert.ok((await inbox.getConversation(conversation.id, masterViewer)).finalizedAt);
  await inbox.updateConversation(conversation.id, { status: "NOVO" }, masterViewer);
  assert.equal((await inbox.getConversation(conversation.id, masterViewer)).finalizedAt, null);
  const auditActions = (await prisma.auditLog.findMany({ where: { entityId: conversation.id } })).map(({ action }) => action);
  assert.ok(auditActions.includes("CONVERSATION_CATEGORY_CHANGED"));
  assert.ok(auditActions.includes("CONVERSATION_STATUS_CHANGED"));
});

test("envia mensagem neutra antes de finalizar o atendimento", async () => {
  const conversation = await prisma.conversation.findFirst();
  const user = await prisma.user.findUnique({ where: { email: "teste@mibro.local" } });
  let providerText;
  const channel = { sendText: async (_phone, text) => {
    providerText = text;
    return { externalId: "wamid.test.closing", data: { messages: [{ id: "wamid.test.closing" }] } };
  } };
  const result = await finalizeConversation({ conversationId: conversation.id, sentByUserId: user.id, channel });
  assert.equal(result.message.text, closingMessage);
  assert.equal(result.message.sentByUserId, user.id);
  assert.equal(providerText, `[*Suporte*]\n\n${closingMessage}`);
  const finalized = await inbox.getConversation(conversation.id, masterViewer);
  assert.equal(finalized.status, "FINALIZADO");
  assert.ok(finalized.finalizedAt);
});

test("cria e edita categorias com código único e cor validada", async () => {
  const first = await inbox.createCategory({ name: "Financeiro Teste", color: "#EF5B2A" }, masterViewer);
  const second = await inbox.createCategory({ name: "Financeiro Teste", color: "#112233" }, masterViewer);
  assert.equal(first.code, "FINANCEIRO_TESTE");
  assert.equal(second.code, "FINANCEIRO_TESTE_2");
  assert.equal(first.color, "#ef5b2a");
  const emoji = await inbox.createCategory({ name: "🛠️ Suporte VIP Teste", color: "#2563eb", parentId: first.id }, masterViewer);
  assert.equal(emoji.name, "🛠️ Suporte VIP Teste");
  assert.equal(emoji.code, "SUPORTE_VIP_TESTE");
  assert.equal(emoji.parentId, first.id);
  const listed = await inbox.listCategories(masterViewer);
  assert.equal(listed.find((category) => category.id === emoji.id).parent.name, "Financeiro Teste");
  const conversation = await prisma.conversation.findFirst();
  await inbox.updateConversation(conversation.id, { categoryId: emoji.id }, masterViewer);
  assert.equal((await inbox.listConversations({ category: first.code }, masterViewer)).length, 1);
  const support = await prisma.category.findUnique({ where: { code: "SUPORTE" } });
  await inbox.updateConversation(conversation.id, { categoryId: support.id }, masterViewer);
  const updated = await inbox.updateCategory(first.id, { name: "Financeiro", active: false }, masterViewer);
  assert.equal(updated.name, "Financeiro");
  assert.equal(updated.active, false);
  await assert.rejects(() => inbox.createCategory({ name: "Cor inválida", color: "laranja" }, masterViewer), /Cor da categoria inválida/);
});

test("categorias ocultas são preferências individuais e não alteram acesso nem alertas", async () => {
  const support = await prisma.category.findUnique({ where: { code: "SUPORTE" } });
  const commercial = await prisma.category.findUnique({ where: { code: "COMERCIAL" } });
  const user = await prisma.user.create({ data: {
    name: "Preferências visuais", email: "categorias-ocultas@mibro.local", role: "ATENDENTE",
    canViewUncategorized: true,
    categoryAccess: { create: [{ categoryId: support.id }] },
  } });
  const viewer = { id: user.id, role: "ATENDENTE", canViewUncategorized: true };
  const conversation = await prisma.conversation.findFirst();
  const original = {
    categoryId: conversation.categoryId, status: conversation.status,
    assignedUserId: conversation.assignedUserId, unreadCount: conversation.unreadCount,
  };
  const since = new Date(Date.now() - 1000).toISOString();
  let message;

  try {
    await inbox.updateConversation(conversation.id, {
      categoryId: support.id, status: "AGUARDANDO_EQUIPE", assignedUserId: null,
    }, masterViewer);
    message = await prisma.message.create({ data: {
      conversationId: conversation.id, externalId: "wamid.hidden-category-alert",
      direction: "RECEBIDA", status: "RECEBIDA", type: "text",
      text: "Mensagem em categoria oculta", occurredAt: new Date(),
    } });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { unreadCount: 1 } });

    const hidden = await inbox.setCategoryVisibility({ categoryId: support.id, hidden: true }, viewer);
    assert.ok(hidden.hiddenCategoryIds.includes(support.id));
    assert.equal((await inbox.listCategories(viewer)).find(({ id }) => id === support.id).hidden, true);
    assert.equal((await inbox.listCategories(masterViewer)).find(({ id }) => id === support.id).hidden, false);
    assert.ok((await inbox.listConversations({ category: "SUPORTE" }, viewer)).some(({ id }) => id === conversation.id));
    assert.ok((await inbox.getUserAlerts({ since }, viewer)).alerts.some(({ id }) => id === `message:${message.id}`));

    await inbox.setCategoryVisibility({ categoryId: "UNCATEGORIZED", hidden: true }, viewer);
    assert.equal((await inbox.getCategoryVisibility(viewer)).hideUncategorized, true);
    await assert.rejects(
      () => inbox.setCategoryVisibility({ categoryId: commercial.id, hidden: true }, viewer),
      /Categoria não encontrada/
    );

    await inbox.setCategoryVisibility({ categoryId: support.id, hidden: false }, viewer);
    await inbox.setCategoryVisibility({ categoryId: "UNCATEGORIZED", hidden: false }, viewer);
    assert.deepEqual(await inbox.getCategoryVisibility(viewer), {
      hideUncategorized: false,
      hiddenCategoryIds: [],
    });
  } finally {
    if (message) await prisma.message.delete({ where: { id: message.id } });
    await prisma.conversation.update({ where: { id: conversation.id }, data: original });
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test("ocultar categoria principal oculta automaticamente as subcategorias, sem forçar o inverso", async () => {
  const parent = await inbox.createCategory({ name: "Cascata Teste Principal", color: "#101010" }, masterViewer);
  const childA = await inbox.createCategory({ name: "Cascata Teste Filho A", color: "#202020", parentId: parent.id }, masterViewer);
  const childB = await inbox.createCategory({ name: "Cascata Teste Filho B", color: "#303030", parentId: parent.id }, masterViewer);
  const user = await prisma.user.create({ data: {
    name: "Cascata Visual", email: "cascata-oculta@mibro.local", role: "ATENDENTE",
    categoryAccess: { create: [{ categoryId: parent.id }, { categoryId: childA.id }, { categoryId: childB.id }] },
  } });
  const viewer = { id: user.id, role: "ATENDENTE" };

  try {
    const hidden = await inbox.setCategoryVisibility({ categoryId: parent.id, hidden: true }, viewer);
    assert.ok(hidden.hiddenCategoryIds.includes(parent.id));
    assert.ok(hidden.hiddenCategoryIds.includes(childA.id));
    assert.ok(hidden.hiddenCategoryIds.includes(childB.id));

    const afterChildRestore = await inbox.setCategoryVisibility({ categoryId: childA.id, hidden: false }, viewer);
    assert.ok(!afterChildRestore.hiddenCategoryIds.includes(childA.id));
    assert.ok(afterChildRestore.hiddenCategoryIds.includes(parent.id));
    assert.ok(afterChildRestore.hiddenCategoryIds.includes(childB.id));

    const afterParentRestore = await inbox.setCategoryVisibility({ categoryId: parent.id, hidden: false }, viewer);
    assert.ok(!afterParentRestore.hiddenCategoryIds.includes(parent.id));
    assert.ok(afterParentRestore.hiddenCategoryIds.includes(childB.id));

    const isolatedHide = await inbox.setCategoryVisibility({ categoryId: childA.id, hidden: true }, viewer);
    assert.ok(isolatedHide.hiddenCategoryIds.includes(childA.id));
    assert.ok(!isolatedHide.hiddenCategoryIds.includes(parent.id));
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test("salva notas no contato e mantém busca pelo nome", async () => {
  const conversation = await prisma.conversation.findFirst({ include: { contact: true } });
  const note = await inbox.addContactNote(conversation.contactId, { content: "Cliente prefere atendimento no período da tarde." }, masterViewer);
  assert.equal(note.content, "Cliente prefere atendimento no período da tarde.");
  const newerNote = await inbox.addContactNote(conversation.contactId, { content: "Nota criada depois." }, masterViewer);
  const pinned = await inbox.setContactNotePinned(conversation.contactId, note.id, { pinned: true }, masterViewer);
  assert.equal(pinned.pinned, true);
  const detail = await inbox.getConversation(conversation.id, masterViewer);
  assert.equal(detail.contact.notes.length, 2);
  assert.equal(detail.contact.notes[0].id, note.id);
  assert.equal(detail.contact.notes[0].pinned, true);
  assert.equal(detail.contact.notes[1].id, newerNote.id);
  const found = await inbox.listConversations({ search: "Cliente Teste" }, masterViewer);
  assert.equal(found.length, 1);
  assert.equal(found[0].contact.name, "Cliente Teste");
  assert.equal(found[0].contact.notes[0].content, "Cliente prefere atendimento no período da tarde.");
  assert.equal(found[0].contact._count.notes, 2);
});

test("fixa conversas por conta, restringe exclusão de notas e registra o histórico", async () => {
  const conversation = await prisma.conversation.findFirst({ include: { contact: true } });
  const master = await prisma.user.findUnique({ where: { email: "teste@mibro.local" } });
  const otherMaster = await prisma.user.create({
    data: { name: "Outro Master", email: "outro-master@mibro.local", role: "ADMIN" },
  });
  const attendantViewer = { id: "atendente-sem-permissao", role: "ATENDENTE" };

  await inbox.setConversationPinned(conversation.id, { pinned: true }, { id: master.id, role: "ADMIN" });
  const masterList = await inbox.listConversations({}, { id: master.id, role: "ADMIN" });
  const otherList = await inbox.listConversations({}, { id: otherMaster.id, role: "ADMIN" });
  assert.equal(masterList.find(({ id }) => id === conversation.id).isPinned, true);
  assert.equal(otherList.find(({ id }) => id === conversation.id).isPinned, false);

  await inbox.setConversationPinned(conversation.id, { pinned: false }, { id: master.id, role: "ADMIN" });
  const unpinnedList = await inbox.listConversations({}, { id: master.id, role: "ADMIN" });
  assert.equal(unpinnedList.find(({ id }) => id === conversation.id).isPinned, false);
  await inbox.setConversationPinned(conversation.id, { pinned: true }, { id: master.id, role: "ADMIN" });
  const repinnedList = await inbox.listConversations({}, { id: master.id, role: "ADMIN" });
  assert.equal(repinnedList.find(({ id }) => id === conversation.id).isPinned, true);
  const pinAudits = await prisma.auditLog.findMany({
    where: { entityId: conversation.id, action: { in: ["CONVERSATION_PINNED", "CONVERSATION_UNPINNED"] } },
  });
  assert.equal(pinAudits.filter(({ action }) => action === "CONVERSATION_PINNED").length, 2);
  assert.equal(pinAudits.filter(({ action }) => action === "CONVERSATION_UNPINNED").length, 1);

  const note = await inbox.addContactNote(conversation.contactId, {
    content: "Nota que será removida pelo Master.", authorId: master.id, conversationId: conversation.id,
  }, { id: master.id, role: "ADMIN" });
  await assert.rejects(
    () => inbox.deleteContactNote(conversation.contactId, note.id, { conversationId: conversation.id }, attendantViewer),
    /Somente uma conta Master/,
  );
  await inbox.deleteContactNote(conversation.contactId, note.id, { conversationId: conversation.id }, { id: master.id, role: "ADMIN" });
  assert.equal(await prisma.contactNote.count({ where: { id: note.id } }), 0);

  const detail = await inbox.getConversation(conversation.id, { id: master.id, role: "ADMIN" });
  assert.ok(detail.activities.some(({ action }) => action === "NOTE_ADDED"));
  assert.ok(detail.activities.some(({ action }) => action === "NOTE_DELETED"));
  assert.equal(detail.isPinned, true);

  const alertStart = new Date(Date.now() - 1000).toISOString();
  await inbox.updateConversation(conversation.id, { assignedUserId: otherMaster.id }, { id: master.id, role: "ADMIN" });
  const targetAlerts = await inbox.getUserAlerts({ since: alertStart }, { id: otherMaster.id, role: "ADMIN" });
  assert.ok(targetAlerts.alerts.some(({ title, conversationId }) => title === "Conversa transferida para você" && conversationId === conversation.id));

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { status: "AGUARDANDO_EQUIPE", assignedUserId: otherMaster.id },
  });
  const assignedAlertStart = new Date(Date.now() - 1000).toISOString();
  const assignedMessage = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: "wamid.alert.assigned", direction: "RECEBIDA",
    status: "RECEBIDA", type: "text", text: "Resposta para o responsável", occurredAt: new Date(),
  } });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { unreadCount: 1 } });
  const assignedAlerts = await inbox.getUserAlerts({ since: assignedAlertStart }, { id: otherMaster.id, role: "ADMIN" });
  const unrelatedAlerts = await inbox.getUserAlerts({ since: assignedAlertStart }, { id: master.id, role: "ADMIN" });
  assert.ok(assignedAlerts.alerts.some(({ id }) => id === `message:${assignedMessage.id}`));
  assert.ok(!unrelatedAlerts.alerts.some(({ id }) => id === `message:${assignedMessage.id}`));
  assert.equal((await inbox.getConversationSummary({ id: otherMaster.id, role: "ADMIN" })).attentionWaiting, 1);
  assert.equal((await inbox.getConversationSummary({ id: master.id, role: "ADMIN" })).attentionWaiting, 0);

  await inbox.markAsRead(conversation.id, { viewer: { id: otherMaster.id, role: "ADMIN" } });
  assert.equal((await inbox.getConversationSummary({ id: otherMaster.id, role: "ADMIN" })).attentionWaiting, 0);
  assert.equal((await inbox.getConversation(conversation.id, { id: otherMaster.id, role: "ADMIN" })).status, "AGUARDANDO_EQUIPE");

  await prisma.conversation.update({ where: { id: conversation.id }, data: { assignedUserId: null } });
  await prisma.conversationMasterRead.update({
    where: { userId_conversationId: { userId: otherMaster.id, conversationId: conversation.id } },
    data: { readAt: new Date(Date.now() - 1000) },
  });
  const openAlertStart = new Date(Date.now() - 1000).toISOString();
  const openMessage = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: "wamid.alert.unassigned", direction: "RECEBIDA",
    status: "RECEBIDA", type: "text", text: "Resposta sem responsável", occurredAt: new Date(),
  } });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { unreadCount: 1 } });
  const openAlertsForMaster = await inbox.getUserAlerts({ since: openAlertStart }, { id: master.id, role: "ADMIN" });
  const openAlertsForOther = await inbox.getUserAlerts({ since: openAlertStart }, { id: otherMaster.id, role: "ADMIN" });
  assert.ok(openAlertsForMaster.alerts.some(({ id }) => id === `message:${openMessage.id}`));
  assert.ok(openAlertsForOther.alerts.some(({ id }) => id === `message:${openMessage.id}`));
  assert.equal((await inbox.getConversationSummary({ id: master.id, role: "ADMIN" })).attentionWaiting, 1);
  assert.equal((await inbox.getConversationSummary({ id: otherMaster.id, role: "ADMIN" })).attentionWaiting, 1);

  const support = await prisma.category.findUnique({ where: { code: "SUPORTE" } });
  const handoffAgent = await prisma.user.create({
    data: {
      name: "Atendente Encaminhado", email: "encaminhado@mibro.local", role: "ATENDENTE",
      categoryAccess: { create: [{ categoryId: support.id }] },
    },
  });
  await inbox.updateConversation(conversation.id, { assignedUserId: handoffAgent.id }, { id: master.id, role: "ADMIN" });
  const afterTransferMessage = await prisma.message.create({ data: {
    conversationId: conversation.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text",
    text: "Mensagem posterior ao encaminhamento", occurredAt: new Date(Date.now() + 1000),
  } });
  const defaultDetail = await inbox.getConversation(conversation.id, {
    id: handoffAgent.id, role: "ATENDENTE", canViewPreviousMessages: false,
  });
  assert.equal(defaultDetail.messageHistoryLimited, false);
  assert.ok(defaultDetail.messages.some(({ id }) => id === afterTransferMessage.id));
  assert.ok(defaultDetail.messages.length > 1);
  const fullDetail = await inbox.getConversation(conversation.id, {
    id: handoffAgent.id, role: "ATENDENTE", canViewPreviousMessages: true,
  });
  assert.equal(fullDetail.messageHistoryLimited, false);
  assert.deepEqual(fullDetail.messages.map(({ id }) => id), defaultDetail.messages.map(({ id }) => id));

  await inbox.updateConversation(conversation.id, { status: "FINALIZADO" }, { id: master.id, role: "ADMIN" });
  const activeAssignments = await inbox.listConversations({ assignedUser: handoffAgent.id, activeOnly: "true" }, { id: master.id, role: "ADMIN" });
  assert.equal(activeAssignments.some(({ id }) => id === conversation.id), false);
  await inbox.updateConversation(conversation.id, { status: "NOVO", assignedUserId: master.id }, { id: master.id, role: "ADMIN" });
  const commercial = await prisma.category.findUnique({ where: { code: "COMERCIAL" } });
  const supportChild = await inbox.createCategory({
    name: "Suporte Filho Responsavel Teste", parentId: support.id,
  }, { id: master.id, role: "ADMIN" });
  const categoryActivitiesBefore = await prisma.conversationActivity.count({ where: { conversationId: conversation.id, action: "CATEGORY_CHANGED" } });
  await inbox.updateConversation(conversation.id, { categoryId: supportChild.id }, { id: master.id, role: "ADMIN" });
  assert.equal((await prisma.conversation.findUnique({ where: { id: conversation.id } })).assignedUserId, master.id);
  await inbox.updateConversation(conversation.id, { categoryId: commercial.id }, { id: master.id, role: "ADMIN" });
  assert.equal((await prisma.conversation.findUnique({ where: { id: conversation.id } })).assignedUserId, null);
  await inbox.updateConversation(conversation.id, { categoryId: support.id }, { id: master.id, role: "ADMIN" });
  const categoryActivitiesAfter = await prisma.conversationActivity.count({ where: { conversationId: conversation.id, action: "CATEGORY_CHANGED" } });
  assert.equal(categoryActivitiesAfter, categoryActivitiesBefore + 2);
  assert.ok((await inbox.getConversation(conversation.id, { id: master.id, role: "ADMIN" })).activities
    .some(({ action, details }) => action === "ASSIGNEE_REMOVED" && details.fromUserId === master.id));
  await prisma.user.delete({ where: { id: handoffAgent.id } });
  await prisma.user.delete({ where: { id: otherMaster.id } });
});

test("qualquer atendente transfere para categoria pública sem ganhar visibilidade da fila", async () => {
  const conversation = await prisma.conversation.findFirst();
  await prisma.message.updateMany({
    where: { conversationId: conversation.id }, data: { occurredAt: new Date(Date.now() - 1000) },
  });
  const support = await prisma.category.findUnique({ where: { code: "SUPORTE" } });
  const commercial = await prisma.category.findUnique({ where: { code: "COMERCIAL" } });
  await inbox.updateConversation(conversation.id, { categoryId: support.id, assignedUserId: null }, masterViewer);
  const transferAgent = await prisma.user.create({
    data: {
      name: "Atendente Comercial", email: "transferencia-setor@mibro.local", role: "ATENDENTE",
      canTransferConversations: false, canViewPreviousMessages: false,
      categoryAccess: { create: [{ categoryId: commercial.id }] },
    },
  });
  const viewer = {
    id: transferAgent.id, role: "ATENDENTE", canTransferConversations: false,
    canViewPreviousMessages: false,
  };

  await inbox.updateConversation(conversation.id, { categoryId: commercial.id, limitHistory: true }, masterViewer);
  const strictTransfer = await prisma.conversationActivity.findFirst({
    where: { conversationId: conversation.id, action: "CATEGORY_CHANGED" }, orderBy: { createdAt: "desc" },
  });
  assert.equal(strictTransfer.details.historyLimited, true);
  const sectorLimited = await inbox.getConversation(conversation.id, viewer);
  assert.equal(sectorLimited.messageHistoryLimited, true);
  assert.equal(sectorLimited.messages.length, 0);

  await inbox.updateConversation(conversation.id, { assignedUserId: transferAgent.id }, masterViewer);
  const visibleMessage = await prisma.message.create({ data: {
    conversationId: conversation.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text",
    text: "Mensagem recebida depois do encaminhamento", occurredAt: new Date(Date.now() + 1000),
  } });
  const assignedLimited = await inbox.getConversation(conversation.id, viewer);
  assert.equal(assignedLimited.messageHistoryLimited, true);
  assert.deepEqual(assignedLimited.messages.map(({ id }) => id), [visibleMessage.id]);

  const categories = await inbox.listCategories(viewer);
  assert.equal(categories.find(({ id }) => id === support.id), undefined);
  const destinations = await inbox.listTransferCategories(conversation.id, viewer);
  assert.equal(destinations.find(({ id }) => id === support.id).selectable, true);
  const moved = await inbox.updateConversation(conversation.id, { categoryId: support.id }, viewer);
  assert.equal(moved.categoryId, support.id);
  assert.equal(moved.assignedUserId, null);
  assert.equal(await inbox.getConversation(conversation.id, viewer), null);
  await prisma.user.delete({ where: { id: transferAgent.id } });
});

test("a transferência sem limitação entrega o histórico completo ao novo atendente", async () => {
  const support = await prisma.category.findUnique({ where: { code: "SUPORTE" } });
  const commercial = await prisma.category.findUnique({ where: { code: "COMERCIAL" } });
  const [returningAgent, differentAgent] = await Promise.all([
    prisma.user.create({ data: {
      name: "Atendente que retorna", email: "historico-retorno@mibro.local", role: "ATENDENTE",
      canTransferConversations: true, canViewPreviousMessages: false,
      categoryAccess: { create: [{ categoryId: support.id }, { categoryId: commercial.id }] },
    } }),
    prisma.user.create({ data: {
      name: "Outro atendente", email: "historico-outro@mibro.local", role: "ATENDENTE",
      canTransferConversations: true, canViewPreviousMessages: false,
      categoryAccess: { create: [{ categoryId: support.id }, { categoryId: commercial.id }] },
    } }),
  ]);
  const contact = await prisma.contact.create({
    data: { externalId: "history-category-test", phone: "5511988887777", name: "Cliente histórico por categoria" },
  });
  const conversation = await prisma.conversation.create({
    data: { contactId: contact.id, categoryId: support.id, assignedUserId: returningAgent.id, status: "EM_ATENDIMENTO" },
  });
  const firstIncoming = await prisma.message.create({ data: {
    conversationId: conversation.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text",
    text: "Mensagem inicial em Suporte", occurredAt: new Date(Date.now() - 2000),
  } });
  const firstReply = await prisma.message.create({ data: {
    conversationId: conversation.id, direction: "ENVIADA", status: "ENVIADA", type: "text",
    text: "Resposta do atendente em Suporte", occurredAt: new Date(Date.now() - 1000), sentByUserId: returningAgent.id,
  } });

  await inbox.updateConversation(conversation.id, { categoryId: commercial.id }, masterViewer);
  const flexibleTransfer = await prisma.conversationActivity.findFirst({
    where: { conversationId: conversation.id, action: "CATEGORY_CHANGED" }, orderBy: { createdAt: "desc" },
  });
  assert.equal(flexibleTransfer.details.historyLimited, false);
  await inbox.updateConversation(conversation.id, { assignedUserId: returningAgent.id }, masterViewer);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const commercialIncoming = await prisma.message.create({ data: {
    conversationId: conversation.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text",
    text: "Mensagem atual em Comercial", occurredAt: new Date(),
  } });

  const flexibleViewer = {
    id: returningAgent.id, role: "ATENDENTE", canViewPreviousMessages: false,
    canViewUncategorized: false,
  };
  const recovered = await inbox.getConversation(conversation.id, flexibleViewer);
  assert.equal(recovered.messageHistoryLimited, false);
  assert.deepEqual(recovered.messages.map(({ id }) => id), [firstIncoming.id, firstReply.id, commercialIncoming.id]);

  const commercialReply = await prisma.message.create({ data: {
    conversationId: conversation.id, direction: "ENVIADA", status: "ENVIADA", type: "text",
    text: "Resposta do atendente em Comercial", occurredAt: new Date(), sentByUserId: returningAgent.id,
  } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await inbox.updateConversation(conversation.id, { categoryId: support.id, limitHistory: false }, masterViewer);
  await inbox.updateConversation(conversation.id, { assignedUserId: differentAgent.id }, masterViewer);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const finalIncoming = await prisma.message.create({ data: {
    conversationId: conversation.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text",
    text: "Mensagem para outro atendente", occurredAt: new Date(),
  } });
  const differentViewer = {
    id: differentAgent.id, role: "ATENDENTE", canViewPreviousMessages: false,
    canViewUncategorized: false,
  };
  const visibleToDifferentAgent = await inbox.getConversation(conversation.id, differentViewer);
  assert.equal(visibleToDifferentAgent.messageHistoryLimited, false);
  assert.deepEqual(visibleToDifferentAgent.messages.map(({ id }) => id), [
    firstIncoming.id, firstReply.id, commercialIncoming.id, commercialReply.id, finalIncoming.id,
  ]);

  const masterDetail = await inbox.getConversation(conversation.id, masterViewer);
  assert.deepEqual(masterDetail.messages.map(({ id }) => id), [
    firstIncoming.id, firstReply.id, commercialIncoming.id, commercialReply.id, finalIncoming.id,
  ]);
  await prisma.conversation.delete({ where: { id: conversation.id } });
  await prisma.contact.delete({ where: { id: contact.id } });
  await prisma.user.deleteMany({ where: { id: { in: [returningAgent.id, differentAgent.id] } } });
});

test("persiste imagens recebidas e enviadas com autoria", async () => {
  const conversation = await prisma.conversation.findFirst();
  const user = await prisma.user.findUnique({ where: { email: "teste@mibro.local" } });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { assignedUserId: null } });
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("imagem-recebida")]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("imagem-enviada")]);
  const incoming = await saveIncoming({
    externalId: "wamid.test.image.in", contactExternalId: "5511999999999", phone: "5511999999999",
    contactName: "Cliente Teste", type: "image", text: "Foto recebida", occurredAt: new Date(),
    rawPayload: { image: { id: "media.in" } }, mediaBuffer: jpeg,
    mediaMimeType: "image/jpeg", mediaFileName: "recebida.jpg",
  });
  assert.equal(incoming.message.type, "image");
  assert.deepEqual(await fs.readFile(resolveImage(incoming.message.mediaStorageKey)), jpeg);

  let providerCaption;
  const channel = { sendImage: async (_phone, data) => { providerCaption = data.caption; return { externalId: "wamid.test.image.out", mediaId: "media.out", data: { messages: [{ id: "wamid.test.image.out" }] } }; } };
  const outgoing = await sendImage({
    conversationId: conversation.id, buffer: png, mimeType: "image/png",
    fileName: "produto.png", caption: "Imagem enviada", sentByUserId: user.id, channel,
  });
  assert.equal(outgoing.message.direction, "ENVIADA");
  assert.equal(outgoing.message.sentByUserId, user.id);
  assert.equal(outgoing.message.mediaMimeType, "image/png");
  assert.equal(outgoing.message.text, "Imagem enviada");
  assert.equal((await prisma.conversation.findUnique({ where: { id: conversation.id } })).assignedUserId, user.id);
  assert.equal(providerCaption, "[*Suporte*]\n\nImagem enviada");
  assert.deepEqual(await fs.readFile(resolveImage(outgoing.message.mediaStorageKey)), png);
});

test("persiste PDFs recebidos e enviados com autoria", async () => {
  assert.equal(MAX_DOCUMENT_SIZE, 100 * 1024 * 1024);
  const conversation = await prisma.conversation.findFirst();
  const user = await prisma.user.findUnique({ where: { email: "teste@mibro.local" } });
  const receivedPdf = Buffer.from("%PDF-1.7\nPDF recebido para teste");
  const sentPdf = Buffer.from("%PDF-1.7\nPDF enviado para teste");
  const incoming = await saveIncoming({
    externalId: "wamid.test.document.in", contactExternalId: "5511999999999", phone: "5511999999999",
    contactName: "Cliente Teste", type: "document", text: "Nota fiscal", occurredAt: new Date(),
    rawPayload: { document: { id: "media.document.in", mime_type: "application/pdf", filename: "nota-fiscal.pdf" } },
    mediaBuffer: receivedPdf, mediaMimeType: "application/pdf", mediaFileName: "nota-fiscal.pdf",
  });
  assert.equal(incoming.message.type, "document");
  assert.equal(incoming.message.mediaFileName, "nota-fiscal.pdf");
  assert.deepEqual(await fs.readFile(resolveMedia(incoming.message.mediaStorageKey)), receivedPdf);

  let providerDocument;
  const channel = { sendDocument: async (_phone, data) => {
    providerDocument = data;
    return { externalId: "wamid.test.document.out", mediaId: "media.document.out", data: { messages: [{ id: "wamid.test.document.out" }] } };
  } };
  const outgoing = await sendDocument({
    conversationId: conversation.id, buffer: sentPdf, mimeType: "application/pdf",
    fileName: "manual-mibro.pdf", caption: "Manual solicitado", sentByUserId: user.id, channel,
  });
  assert.equal(outgoing.message.type, "document");
  assert.equal(outgoing.message.direction, "ENVIADA");
  assert.equal(outgoing.message.sentByUserId, user.id);
  assert.equal(outgoing.message.mediaMimeType, "application/pdf");
  assert.equal(outgoing.message.mediaFileName, "manual-mibro.pdf");
  assert.equal(providerDocument.caption, "[*Suporte*]\n\nManual solicitado");
  assert.deepEqual(await fs.readFile(resolveMedia(outgoing.message.mediaStorageKey)), sentPdf);
});

test("aceita documentos Office e bloqueia arquivos renomeados", async () => {
  const conversation = await prisma.conversation.findFirst();
  const user = await prisma.user.findUnique({ where: { email: "teste@mibro.local" } });
  const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("documento Word de teste")]);
  const incoming = await saveIncoming({
    externalId: "wamid.test.docx.in", contactExternalId: "5511999999999", phone: "5511999999999",
    contactName: "Cliente Teste", type: "document", text: "Formulário", occurredAt: new Date(),
    rawPayload: { document: { id: "media.docx.in", mime_type: docxMime, filename: "garantia.docx" } },
    mediaBuffer: docx, mediaMimeType: docxMime, mediaFileName: "garantia.docx",
  });
  assert.equal(incoming.message.mediaMimeType, docxMime);
  assert.equal(incoming.message.mediaFileName, "garantia.docx");
  assert.deepEqual(await fs.readFile(resolveMedia(incoming.message.mediaStorageKey)), docx);

  let providerDocument;
  const channel = { sendDocument: async (_phone, data) => {
    providerDocument = data;
    return { externalId: "wamid.test.docx.out", mediaId: "media.docx.out", data: {} };
  } };
  const outgoing = await sendDocument({
    conversationId: conversation.id, buffer: docx, mimeType: docxMime,
    fileName: "formulario.docx", caption: "Formulário solicitado", sentByUserId: user.id, channel,
  });
  assert.equal(outgoing.message.mediaFileName, "formulario.docx");
  assert.equal(providerDocument.mimeType, docxMime);
  assert.throws(
    () => validateDocument({ buffer: Buffer.from("MZ executável renomeado"), mimeType: docxMime }),
    /não corresponde ao formato informado/,
  );
});

test("persiste e exibe figurinha WebP recebida", async () => {
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
  const incoming = await saveIncoming({
    externalId: "wamid.test.sticker.in", contactExternalId: "5511999999999", phone: "5511999999999",
    contactName: "Cliente Teste", type: "sticker", text: "[sticker]", occurredAt: new Date(),
    rawPayload: { sticker: { id: "media.sticker", mime_type: "image/webp", animated: true } },
    mediaBuffer: webp, mediaMimeType: "image/webp", mediaFileName: "figurinha.webp",
  });
  assert.equal(incoming.message.type, "sticker");
  assert.equal(incoming.message.mediaMimeType, "image/webp");
  assert.equal(incoming.message.mediaFileName, "figurinha.webp");
  assert.deepEqual(await fs.readFile(resolveMedia(incoming.message.mediaStorageKey)), webp);
});

test("persiste reação sem transformar em nova mensagem aguardando resposta", async () => {
  const conversation = await prisma.conversation.findFirst();
  const target = await prisma.message.findFirst({
    where: { conversationId: conversation.id, externalId: { not: null }, type: { not: "reaction" } },
    orderBy: { occurredAt: "asc" },
  });
  await prisma.conversation.update({
    where: { id: conversation.id }, data: { status: "EM_ATENDIMENTO", unreadCount: 0 },
  });
  const incoming = await saveIncoming({
    externalId: "wamid.test.reaction.in", contactExternalId: "5511999999999", phone: "5511999999999",
    contactName: "Cliente Teste", type: "reaction", text: "👍", occurredAt: new Date(),
    reactionToExternalId: target.externalId, reactionEmoji: "👍",
    rawPayload: { reaction: { message_id: target.externalId, emoji: "👍" } },
  });
  assert.equal(incoming.message.type, "reaction");
  assert.equal(incoming.message.text, "👍");
  assert.deepEqual(incoming.message.rawPayload.reaction, { message_id: target.externalId, emoji: "👍" });
  const updated = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(updated.status, "EM_ATENDIMENTO");
  assert.equal(updated.unreadCount, 0);
});

test("persiste áudio recebido para reprodução no histórico", async () => {
  const audio = Buffer.from("OggS-audio-opus-de-teste");
  const incoming = await saveIncoming({
    externalId: "wamid.test.audio.in", contactExternalId: "5511999999999", phone: "5511999999999",
    contactName: "Cliente Teste", type: "audio", text: "[audio]", occurredAt: new Date(),
    rawPayload: { audio: { id: "media.audio", voice: true } }, mediaBuffer: audio,
    mediaMimeType: "audio/ogg; codecs=opus", mediaFileName: "audio-media.ogg",
  });
  assert.equal(incoming.message.type, "audio");
  assert.equal(incoming.message.mediaMimeType, "audio/ogg");
  assert.equal(incoming.message.mediaFileName, "audio-media.ogg");
  assert.deepEqual(await fs.readFile(resolveMedia(incoming.message.mediaStorageKey)), audio);
});

test("persiste vídeo recebido para reprodução no histórico", async () => {
  const video = Buffer.from("0000ftyp-video-mp4-de-teste");
  const incoming = await saveIncoming({
    externalId: "wamid.test.video.in", contactExternalId: "5511999999999", phone: "5511999999999",
    contactName: "Cliente Teste", type: "video", text: "Vídeo recebido", occurredAt: new Date(),
    rawPayload: { video: { id: "media.video" } }, mediaBuffer: video,
    mediaMimeType: "video/mp4", mediaFileName: "produto.mp4",
  });
  assert.equal(incoming.message.type, "video");
  assert.equal(incoming.message.mediaMimeType, "video/mp4");
  assert.equal(incoming.message.mediaFileName, "produto.mp4");
  assert.deepEqual(await fs.readFile(resolveMedia(incoming.message.mediaStorageKey)), video);

  const conversation = await prisma.conversation.findFirst();
  const user = await prisma.user.findUnique({ where: { email: "teste@mibro.local" } });
  let providerVideo;
  const channel = { sendVideo: async (_phone, data) => {
    providerVideo = data;
    return { externalId: "wamid.test.video.out", mediaId: "media.video.out", data: { messages: [{ id: "wamid.test.video.out" }] } };
  } };
  const outgoing = await sendVideo({
    conversationId: conversation.id, buffer: video, mimeType: "video/mp4",
    fileName: "demonstracao.mp4", caption: "Vídeo enviado", sentByUserId: user.id, channel,
  });
  assert.equal(outgoing.message.type, "video");
  assert.equal(outgoing.message.direction, "ENVIADA");
  assert.equal(outgoing.message.sentByUserId, user.id);
  assert.equal(outgoing.message.mediaMimeType, "video/mp4");
  assert.equal(outgoing.message.mediaFileName, "demonstracao.mp4");
  assert.equal(providerVideo.caption, "[*Suporte*]\n\nVídeo enviado");
  assert.deepEqual(await fs.readFile(resolveMedia(outgoing.message.mediaStorageKey)), video);
});
