// Setor privado (Financeiro com histórico protegido) — cenários 1–10 do
// pedido (item 45). Nenhuma mensagem é apagada: o teste confere que o banco
// mantém tudo e só a leitura muda.
require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const webpush = require("web-push");
const prisma = require("../src/database/prisma");
const inbox = require("../src/services/inbox-service");
const privateSegments = require("../src/services/private-segment-service");
const pushService = require("../src/services/push-service");
const inboxEvents = require("../src/realtime/inbox-events");

const emailDomain = "@segmentos.test";
const contactPrefix = "segment-test-";
let seq = 0;
let financeiro;
let financeiroSub;
let support;
let commercial;

async function cleanup() {
  const contacts = await prisma.contact.findMany({ where: { externalId: { startsWith: contactPrefix } }, select: { id: true } });
  const conversations = await prisma.conversation.findMany({ where: { contactId: { in: contacts.map(({ id }) => id) } }, select: { id: true } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: [...conversations.map(({ id }) => id), ...contacts.map(({ id }) => id)] } } });
  await prisma.contact.deleteMany({ where: { id: { in: contacts.map(({ id }) => id) } } });
  await prisma.pushSubscription.deleteMany({ where: { user: { email: { endsWith: emailDomain } } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: emailDomain } } });
  await prisma.category.deleteMany({ where: { companyId: "cmp_mibro", code: { startsWith: "FIN_SEG_TEST" }, parentId: { not: null } } });
  await prisma.category.deleteMany({ where: { companyId: "cmp_mibro", code: { startsWith: "FIN_SEG_TEST" } } });
}

async function createUser(name, { role = "ATENDENTE", categories = [], ...flags } = {}) {
  seq += 1;
  return prisma.user.create({
    data: {
      companyAccess: { create: { companyId: "cmp_mibro" } },
      name, email: `seg${seq}-${Date.now()}${emailDomain}`, role, canViewPreviousMessages: false, ...flags,
      categoryAccess: { create: categories.map((category) => ({ categoryId: category.id })) },
    },
  });
}

async function createConversation(label, categoryId, assignedUserId = null) {
  const contact = await prisma.contact.create({
    data: { companyId: "cmp_mibro", externalId: `${contactPrefix}${label}-${Date.now()}`, phone: `55118${String(Date.now()).slice(-8)}`, name: `Cliente ${label}` },
  });
  return prisma.conversation.create({ data: { companyId: "cmp_mibro", contactId: contact.id, categoryId, assignedUserId, status: assignedUserId ? "EM_ATENDIMENTO" : "NOVO", lastMessageAt: new Date() } });
}

let clock = Date.now() - 60 * 60 * 1000;
const tick = () => new Date((clock += 1000));

function customer(conversationId, text, extra = {}) {
  return prisma.message.create({ data: { conversationId, direction: "RECEBIDA", status: "RECEBIDA", type: "text", text, occurredAt: tick(), ...extra } });
}
function agent(conversationId, user, text) {
  return prisma.message.create({ data: { conversationId, direction: "ENVIADA", status: "ENVIADA", type: "text", text, occurredAt: tick(), sentByUserId: user.id } });
}
function attachment(conversationId) {
  return prisma.message.create({ data: {
    conversationId, direction: "RECEBIDA", status: "RECEBIDA", type: "document", text: "boleto.pdf", occurredAt: tick(),
    mediaStorageKey: "segment-test/nao-existe.pdf", mediaMimeType: "application/pdf", mediaFileName: "boleto-financeiro.pdf",
  } });
}
const texts = (conversation) => conversation.messages.filter((message) => !message.restricted).map(({ text }) => text);

test.before(async () => {
  await cleanup();
  support = await prisma.category.findUnique({ where: { companyId_code: { companyId: "cmp_mibro", code: "SUPORTE" } } });
  commercial = await prisma.category.findUnique({ where: { companyId_code: { companyId: "cmp_mibro", code: "COMERCIAL" } } });
  // A categoria Financeiro já existe em produção; aqui é criada só para o
  // teste e protegida pelo flag (nunca pelo nome).
  financeiro = await prisma.category.create({ data: { companyId: "cmp_mibro", code: `FIN_SEG_TEST_${Date.now()}`, name: "Financeiro", visibilityMode: "SECTOR_PRIVATE" } });
  financeiroSub = await prisma.category.create({ data: { companyId: "cmp_mibro", code: `FIN_SEG_TEST_SUB_${Date.now()}`, name: "Boletos", parentId: financeiro.id } });
});
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("Financeiro: membros (Ana/Emily) leem, Master vê tudo, Suporte recebe depois sem conteúdo, IDOR/anexo 403, volta ao Financeiro recupera o anterior", async () => {
  // Membro só de uma SUBCATEGORIA do Financeiro também lê o segmento.
  const subMember = await createUser("Bia Boletos", { categories: [financeiroSub] });
  const [carlos, ana, emily, suporte, master] = await Promise.all([
    createUser("Carlos Vendas", { categories: [commercial], canTransferConversations: true }),
    createUser("Ana Financeiro", { categories: [financeiro], canTransferConversations: true, canViewConversationHistory: true }),
    createUser("Emily Financeiro", { categories: [financeiro] }),
    createUser("Suporte Fora", { categories: [support], canTransferConversations: true, canViewPreviousMessages: true, canViewConversationHistory: true }),
    createUser("Master Segmentos", { role: "ADMIN" }),
  ]);
  const conversation = await createConversation("fluxo", commercial.id, carlos.id);
  const hello = await customer(conversation.id, "Quero comprar o relógio");
  await agent(conversation.id, carlos, "Claro! Vou te passar ao Financeiro para o pagamento.");

  // Vendedor → Financeiro (a partir daqui tudo nasce carimbado).
  await inbox.updateConversation(conversation.id, { categoryId: financeiro.id }, carlos);
  const boleto = await customer(conversation.id, "Meu boleto venceu ontem");
  const pdf = await attachment(conversation.id);
  await inbox.updateConversation(conversation.id, { assignedUserId: ana.id }, ana);
  await agent(conversation.id, ana, "Segue a segunda via do boleto.");
  await inbox.addContactNote(conversation.contactId, { content: "NOTA-SIGILOSA-FINANCEIRO parcelamento", authorId: ana.id, conversationId: conversation.id }, ana);

  const stored = await prisma.message.findMany({ where: { conversationId: conversation.id }, orderBy: { occurredAt: "asc" } });
  assert.equal(stored.find(({ id }) => id === hello.id).privateCategoryId, null);
  assert.equal(stored.find(({ id }) => id === boleto.id).privateCategoryId, financeiro.id);
  assert.equal(stored.find(({ id }) => id === pdf.id).privateCategoryId, financeiro.id);

  // 1. Ana (responsável e membro) vê o conteúdo Financeiro.
  const anaView = await inbox.getConversation(conversation.id, ana);
  assert.ok(texts(anaView).includes("Meu boleto venceu ontem"));
  assert.ok(anaView.activities.some(({ action }) => action === "PRIVATE_SEGMENT_STARTED"));
  // 2. Emily vê mesmo sem ser responsável (e a conversa aparece na lista dela).
  const emilyView = await inbox.getConversation(conversation.id, emily);
  assert.ok(texts(emilyView).includes("Meu boleto venceu ontem"));
  assert.ok((await inbox.listConversations({}, emily)).some(({ id }) => id === conversation.id));
  await inbox.assertCanViewMessage(emily, pdf.id);
  assert.ok(texts(await inbox.getConversation(conversation.id, subMember)).includes("Meu boleto venceu ontem"));
  // 3. Master vê tudo, sempre.
  const masterView = await inbox.getConversation(conversation.id, master);
  assert.equal(masterView.messages.some(({ restricted }) => restricted), false);
  assert.ok(texts(masterView).includes("Meu boleto venceu ontem"));
  await inbox.assertCanViewMessage(master, pdf.id);

  // Financeiro → Suporte (resumo de handoff é para quem recebe).
  await inbox.updateConversation(conversation.id, { categoryId: support.id, transferReason: "dúvida técnica" }, ana);
  await inbox.updateConversation(conversation.id, { assignedUserId: suporte.id }, suporte);
  const afterSupport = await customer(conversation.id, "Agora o relógio não liga");
  assert.equal(afterSupport.privateCategoryId, null);

  // 4. Suporte vê Comercial e o pós-transferência, nunca o Financeiro.
  const supportView = await inbox.getConversation(conversation.id, suporte);
  const serialized = JSON.stringify(supportView);
  for (const secret of ["boleto", "Boleto", "segunda via", "NOTA-SIGILOSA", "boleto-financeiro.pdf"]) {
    assert.equal(serialized.includes(secret), false, `vazou "${secret}" para o Suporte`);
  }
  assert.ok(texts(supportView).includes("Quero comprar o relógio"));
  assert.ok(texts(supportView).includes("Agora o relógio não liga"));
  const blocks = supportView.messages.filter(({ restricted }) => restricted);
  assert.equal(blocks.length, 1, "um bloco 🔒 por trecho contínuo");
  assert.equal(blocks[0].categoryName, "Financeiro");
  assert.equal(supportView.privateSegmentRestricted, true);
  assert.ok(supportView.activities.some(({ action }) => action === "PRIVATE_SEGMENT_ENDED"));
  // Nota do Financeiro não aparece no cadastro compartilhado do contato.
  assert.equal(supportView.contact.notes.some(({ content }) => content.includes("NOTA-SIGILOSA")), false);

  // 5/7. IDOR: mensagem e anexo do Financeiro por ID → 403.
  await assert.rejects(() => inbox.assertCanViewMessage(suporte, boleto.id), { statusCode: 403 });
  await assert.rejects(() => inbox.assertCanViewMessage(suporte, pdf.id), { statusCode: 403 });
  await inbox.assertCanViewMessage(suporte, hello.id);
  const privateNote = await prisma.contactNote.findFirst({ where: { contactId: conversation.contactId, privateCategoryId: financeiro.id } });
  await assert.rejects(() => inbox.setContactNotePinned(conversation.contactId, privateNote.id, { pinned: true }, suporte), { statusCode: 404 });

  // 6. Busca: o filtro central exclui texto do Financeiro para quem não é membro.
  const search = async (viewer) => prisma.message.findMany({
    where: { AND: [{ conversationId: conversation.id, text: { contains: "boleto", mode: "insensitive" } }, await privateSegments.readableWhereFor(viewer)] },
  });
  assert.equal((await search(suporte)).length, 0);
  assert.ok((await search(ana)).length >= 1);
  assert.ok((await search(master)).length >= 1);
  // Prévia e nota da lista também respeitam o segmento.
  const supportList = await inbox.listConversations({}, suporte);
  const card = supportList.find(({ id }) => id === conversation.id);
  assert.ok(card);
  assert.equal(JSON.stringify(card).includes("boleto"), false);
  assert.equal(JSON.stringify(card).includes("NOTA-SIGILOSA"), false);

  // 8. Suporte → Financeiro novamente: Ana/Emily recuperam o segmento anterior.
  await inbox.updateConversation(conversation.id, { categoryId: financeiro.id }, suporte);
  const second = await customer(conversation.id, "Paguei o boleto, segue comprovante");
  assert.equal(second.privateCategoryId, financeiro.id);
  await inbox.updateConversation(conversation.id, { assignedUserId: emily.id }, emily);
  for (const member of [ana, emily]) {
    const view = await inbox.getConversation(conversation.id, member);
    assert.ok(texts(view).includes("Meu boleto venceu ontem"), `${member.name} deve ver o Financeiro anterior`);
    assert.ok(texts(view).includes("Paguei o boleto, segue comprovante"));
  }
  // O Suporte saiu do caso e continua sem acesso ao conteúdo privado.
  await assert.rejects(() => inbox.assertCanViewMessage(suporte, second.id), (error) => [403, 404].includes(error.statusCode));

  // Nada foi apagado.
  assert.equal(await prisma.message.count({ where: { conversationId: conversation.id } }), stored.length + 2);
});

test("9. realtime (SSE) nunca leva conteúdo; 10. push sem prévia para quem não lê o segmento", async () => {
  const [ana, outsider] = await Promise.all([
    createUser("Ana Push", { categories: [financeiro] }),
    createUser("Fora Push", { categories: [support] }),
  ]);
  const conversation = await createConversation("push", financeiro.id, ana.id);
  const secret = await customer(conversation.id, "Boleto 1234 vencido — sigiloso");
  assert.equal(secret.privateCategoryId, financeiro.id);

  // 9. SSE: aviso sem conteúdo, mesmo para conexões de fora do setor.
  const frames = [];
  const res = { destroyed: false, writableEnded: false, status() { return this; }, set() {}, flushHeaders() {}, write(chunk) { frames.push(chunk); }, once() {} };
  inboxEvents.handle({ user: { id: outsider.id, role: "ATENDENTE" }, once() {} }, res);
  await inboxEvents.publishForConversation(conversation.id);
  inboxEvents.publish();
  assert.ok(frames.join("").includes("inbox.updated"));
  assert.equal(frames.join("").includes("Boleto"), false);

  // 10. Push: autorizada recebe a prévia; quem não lê recebe só "Conversa atualizada".
  const sent = [];
  const original = webpush.sendNotification;
  webpush.sendNotification = async (subscription, payload) => { sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) }); };
  try {
    for (const user of [ana, outsider]) {
      await prisma.pushSubscription.create({ data: { userId: user.id, endpoint: `https://push.example.com/seg-${user.id}`, p256dh: "p", auth: "a" } });
    }
    await pushService.notifyIncomingMessage(secret);
    const toAna = sent.find(({ endpoint }) => endpoint.endsWith(ana.id));
    if (pushService.isEnabled()) {
      assert.match(toAna.payload.body, /Boleto 1234/);
      // Mesma mensagem, conversa reatribuída a quem NÃO é do setor (acesso revogado/erro de config).
      await prisma.conversation.update({ where: { id: conversation.id }, data: { assignedUserId: outsider.id } });
      sent.length = 0;
      await pushService.notifyIncomingMessage(secret);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].payload.body, "Conversa atualizada");
      assert.equal(JSON.stringify(sent[0].payload).includes("Boleto"), false);
    }
  } finally {
    webpush.sendNotification = original;
  }
});

test("finalizar no Financeiro encerra o segmento: mensagem nova do cliente (novo atendimento) não é privada", async () => {
  const ana = await createUser("Ana Final", { categories: [financeiro] });
  const conversation = await createConversation("final", financeiro.id, ana.id);
  const during = await customer(conversation.id, "pagamento em atraso");
  assert.equal(during.privateCategoryId, financeiro.id);
  await inbox.updateConversation(conversation.id, { status: "FINALIZADO" }, ana);
  const updated = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(updated.status, "FINALIZADO");
  const after = await customer(conversation.id, "oi, voltei com outra dúvida");
  assert.equal(after.privateCategoryId, null);
});

test("só Master liga o histórico protegido, e só no setor principal", async () => {
  const [master, supervisor] = await Promise.all([
    createUser("Master Flag", { role: "ADMIN" }),
    createUser("Supervisor Flag", { role: "SUPERVISOR", canManageCategories: true }),
  ]);
  await assert.rejects(() => inbox.updateCategory(financeiro.id, { visibilityMode: "NORMAL" }, supervisor), { statusCode: 403 });
  await assert.rejects(() => inbox.updateCategory(financeiroSub.id, { visibilityMode: "SECTOR_PRIVATE" }, master), { statusCode: 400 });
  const off = await inbox.updateCategory(financeiro.id, { visibilityMode: "NORMAL" }, master);
  assert.equal(off.visibilityMode, "NORMAL");
  const on = await inbox.updateCategory(financeiro.id, { visibilityMode: "SECTOR_PRIVATE" }, master);
  assert.equal(on.visibilityMode, "SECTOR_PRIVATE");
});
