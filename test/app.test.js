require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createApp } = require("../src/app");
const prisma = require("../src/database/prisma");
const inboxEvents = require("../src/realtime/inbox-events");

test.before(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.contactNote.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.user.deleteMany();
});

test("mantém a verificação GET do webhook da Meta", async () => {
  const previous = process.env.VERIFY_TOKEN;
  process.env.VERIFY_TOKEN = "token-de-teste";
  const server = createApp({ channel: {} }).listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=token-de-teste&hub.challenge=12345`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "12345");
  } finally {
    server.close();
    process.env.VERIFY_TOKEN = previous;
    await prisma.$disconnect();
  }
});

test("aceita somente webhooks POST com assinatura válida quando configurada", async () => {
  const previous = process.env.META_APP_SECRET;
  process.env.META_APP_SECRET = "app-secret-exclusivo-de-teste";
  const server = createApp({ channel: { parseWebhook: () => [] } }).listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/webhook/whatsapp`;
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const invalid = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": "sha256=incorreta" }, body });
    assert.equal(invalid.status, 401);
    const signature = `sha256=${crypto.createHmac("sha256", process.env.META_APP_SECRET).update(body).digest("hex")}`;
    const valid = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": signature }, body });
    assert.equal(valid.status, 200);
  } finally {
    server.close();
    if (previous === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = previous;
    await prisma.$disconnect();
  }
});

test("protege a integração de leads com segredo próprio", async () => {
  const previous = process.env.INTEGRATION_API_SECRET;
  process.env.INTEGRATION_API_SECRET = "segredo-de-integracao-com-32-caracteres";
  const server = createApp({ channel: {} }).listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/integrations/leads/atacado`;
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: { Authorization: "Bearer incorreto" } })).status, 401);
  } finally {
    server.close();
    if (previous === undefined) delete process.env.INTEGRATION_API_SECRET;
    else process.env.INTEGRATION_API_SECRET = previous;
    await prisma.$disconnect();
  }
});

test("entrega o painel e as APIs básicas da caixa de entrada", async () => {
  const server = createApp({ channel: {} }).listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const protectedPage = await fetch(base, { redirect: "manual" });
    assert.equal(protectedPage.status, 302);
    assert.equal(protectedPage.headers.get("location"), "/login.html");
    const manifestResponse = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.display, "standalone");
    assert.deepEqual(manifest.icons.map(({ sizes }) => sizes), ["192x192", "512x512"]);
    const serviceWorker = await fetch(`${base}/service-worker.js`);
    assert.equal(serviceWorker.status, 200);
    assert.match(serviceWorker.headers.get("cache-control"), /no-cache/);
    assert.doesNotMatch(await serviceWorker.text(), /"\/api\//);
    assert.equal((await fetch(`${base}/assets/app-icon-192.png`)).status, 200);
    assert.equal((await fetch(`${base}/api/conversations`)).status, 401);
    const setup = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Administrador Teste", email: "admin@teste.local", password: "senha-segura-123" }) });
    assert.equal(setup.status, 201);
    const storedUser = await prisma.user.findUnique({ where: { email: "admin@teste.local" } });
    assert.notEqual(storedUser.passwordHash, "senha-segura-123");
    const cookie = setup.headers.get("set-cookie").split(";")[0];
    const page = await fetch(base, { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /Central de Atendimento/);
    assert.match(pageHtml, /manifest\.webmanifest/);
    assert.match(pageHtml, /CONTEÚDO COMPARTILHADO/);
    assert.match(pageHtml, /Imagens e vídeos/);
    assert.match(pageHtml, /Documentos/);
    assert.match(pageHtml, /Atualizar agora/);
    assert.match(pageHtml, /Ocultar histórico anterior para o novo setor/);
    assert.match(pageHtml, /Templates aprovados/);
    assert.match(pageHtml, /pode gerar cobrança pela Meta/);
    assert.match(pageHtml, /id="new-conversation"/);
    assert.match(pageHtml, /Iniciar conversa/);
    assert.match(pageHtml, /Enviar e-mail/);
    assert.match(pageHtml, /Escolher canal/);
    assert.match(pageHtml, /id="open-templates"[^>]*hidden/);
    assert.doesNotMatch(pageHtml, /id="transfer-limit-history"[^>]*checked/);
    const metaStatus = await fetch(`${base}/api/meta/status`, { headers: { Cookie: cookie } });
    assert.equal(metaStatus.status, 200);
    assert.equal(typeof (await metaStatus.json()).templatesConfigured, "boolean");
    const categories = await fetch(`${base}/api/categories`, { headers: { Cookie: cookie } });
    assert.equal(categories.status, 200);
    assert.equal((await categories.json()).length, 9);
    const users = await fetch(`${base}/api/users`, { headers: { Cookie: cookie } });
    assert.equal(users.status, 200);
    assert.equal((await users.json())[0].email, "admin@teste.local");
    const createdCategory = await fetch(`${base}/api/categories`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Categoria API Teste", color: "#ef5b2a" }) });
    assert.equal(createdCategory.status, 201);
    assert.equal((await createdCategory.json()).name, "Categoria API Teste");
    const support = await prisma.category.findUnique({ where: { code: "SUPORTE" } });
    const commercial = await prisma.category.findUnique({ where: { code: "COMERCIAL" } });
    const supportChild = await prisma.category.create({ data: {
      code: "SUPORTE_PERMISSAO_TESTE", name: "Suporte permissão teste", color: "#ef5b2a",
      displayOrder: 999, parentId: support.id,
    } });
    const createAgent = await fetch(`${base}/api/admin/users`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({
      name: "Agente Restrito", email: "agente@teste.local", password: "senha-agente-123", role: "ATENDENTE",
      categoryIds: [support.id], canViewUncategorized: false,
    }) });
    assert.equal(createAgent.status, 201);
    const createdAgent = await createAgent.json();
    assert.equal(createdAgent.passwordHash, undefined);
    const supportContact = await prisma.contact.create({ data: { externalId: "app-support", phone: "551100000001", name: "Cliente Suporte" } });
    const commercialContact = await prisma.contact.create({ data: { externalId: "app-commercial", phone: "551100000002", name: "Cliente Comercial" } });
    const supportChildContact = await prisma.contact.create({ data: { externalId: "app-support-child", phone: "551100000003", name: "Cliente Subcategoria" } });
    const supportConversation = await prisma.conversation.create({ data: { contactId: supportContact.id, categoryId: support.id, assignedUserId: createdAgent.id } });
    const commercialConversation = await prisma.conversation.create({ data: { contactId: commercialContact.id, categoryId: commercial.id } });
    const supportChildConversation = await prisma.conversation.create({ data: { contactId: supportChildContact.id, categoryId: supportChild.id } });
    const agentLogin = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "agente@teste.local", password: "senha-agente-123" }) });
    assert.equal(agentLogin.status, 200);
    const agentCookie = agentLogin.headers.get("set-cookie").split(";")[0];
    const agentConversations = await fetch(`${base}/api/conversations`, { headers: { Cookie: agentCookie } });
    assert.deepEqual((await agentConversations.json()).map(({ id }) => id), [supportConversation.id]);
    const restrictedDetail = await fetch(`${base}/api/conversations/${supportConversation.id}`, { headers: { Cookie: agentCookie } });
    const restrictedConversation = await restrictedDetail.json();
    assert.equal(restrictedConversation.canViewHistory, false);
    assert.equal(restrictedConversation.activities, undefined);
    assert.equal((await fetch(`${base}/api/conversations/${commercialConversation.id}`, { headers: { Cookie: agentCookie } })).status, 404);
    assert.equal((await fetch(`${base}/api/conversations/${supportChildConversation.id}`, { headers: { Cookie: agentCookie } })).status, 404);
    assert.equal((await fetch(`${base}/api/admin/users`, { headers: { Cookie: agentCookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/admin/audit-logs`, { headers: { Cookie: agentCookie } })).status, 403);
    const auditResponse = await fetch(`${base}/api/admin/audit-logs?entityType=USER`, { headers: { Cookie: cookie } });
    assert.equal(auditResponse.status, 200);
    assert.ok((await auditResponse.json()).some(({ action, entityId }) => action === "USER_CREATED" && entityId === createdAgent.id));
    assert.equal((await fetch(`${base}/api/team/users`, { headers: { Cookie: agentCookie } })).status, 403);
    const allowTeamActivity = await fetch(`${base}/api/admin/users/${createdAgent.id}`, { method: "PATCH", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ canViewTeamActivity: true, canViewConversationHistory: true }) });
    assert.equal(allowTeamActivity.status, 200);
    // Visão de equipe é só do Master: o flag antigo não libera mais nada.
    assert.equal((await fetch(`${base}/api/team/users`, { headers: { Cookie: agentCookie } })).status, 403);
    const masterTeam = await fetch(`${base}/api/team/users`, { headers: { Cookie: cookie } });
    assert.equal(masterTeam.status, 200);
    assert.equal((await masterTeam.json()).find(({ id }) => id === createdAgent.id)._count.assignedConversations, 1);
    const authorizedHistory = await fetch(`${base}/api/conversations/${supportConversation.id}`, { headers: { Cookie: agentCookie } });
    const authorizedConversation = await authorizedHistory.json();
    assert.equal(authorizedConversation.canViewHistory, true);
    assert.ok(Array.isArray(authorizedConversation.activities));
    assert.equal((await fetch(`${base}/api/categories`, { method: "POST", headers: { Cookie: agentCookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Sem permissão" }) })).status, 403);
    const imageForm = new FormData();
    imageForm.append("image", new Blob([Buffer.from([0xff, 0xd8, 0xff, 0x00])], { type: "image/jpeg" }), "teste.jpg");
    const missingConversationImage = await fetch(`${base}/api/conversations/inexistente/images`, { method: "POST", headers: { Cookie: cookie }, body: imageForm });
    assert.equal(missingConversationImage.status, 404);
    const documentForm = new FormData();
    documentForm.append("document", new Blob([Buffer.from("%PDF-1.7\nPDF de teste")], { type: "application/pdf" }), "manual.pdf");
    const missingConversationDocument = await fetch(`${base}/api/conversations/inexistente/documents`, { method: "POST", headers: { Cookie: cookie }, body: documentForm });
    assert.equal(missingConversationDocument.status, 404);
    const docxForm = new FormData();
    docxForm.append("document", new Blob([Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("DOCX de teste")])], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "garantia.docx");
    const missingConversationDocx = await fetch(`${base}/api/conversations/inexistente/documents`, { method: "POST", headers: { Cookie: cookie }, body: docxForm });
    assert.equal(missingConversationDocx.status, 404);
    const videoForm = new FormData();
    videoForm.append("video", new Blob([Buffer.from("0000ftyp-video")], { type: "video/mp4" }), "produto.mp4");
    const missingConversationVideo = await fetch(`${base}/api/conversations/inexistente/videos`, { method: "POST", headers: { Cookie: cookie }, body: videoForm });
    assert.equal(missingConversationVideo.status, 404);
    assert.equal((await fetch(`${base}/api/messages/inexistente/media`, { headers: { Cookie: cookie } })).status, 404);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const conversations = await fetch(`${base}/api/conversations`, { headers: { Cookie: cookie } });
    assert.equal(conversations.status, 200);
    assert.ok(Array.isArray(await conversations.json()));

    const summary = await fetch(`${base}/api/conversations/summary`, { headers: { Cookie: cookie } });
    assert.equal(summary.status, 200);
    assert.equal(typeof (await summary.json()).total, "number");
    const alerts = await fetch(`${base}/api/alerts?since=${encodeURIComponent(new Date().toISOString())}`, { headers: { Cookie: cookie } });
    assert.equal(alerts.status, 200);
    assert.ok(Array.isArray((await alerts.json()).alerts));
    assert.equal((await fetch(`${base}/api/events`)).status, 401);
    const eventAbort = new AbortController();
    const eventStream = await fetch(`${base}/api/events`, { headers: { Cookie: cookie }, signal: eventAbort.signal });
    assert.equal(eventStream.status, 200);
    assert.match(eventStream.headers.get("content-type"), /text\/event-stream/);
    const eventReader = eventStream.body.getReader();
    const firstEventChunk = await eventReader.read();
    assert.match(new TextDecoder().decode(firstEventChunk.value), /connected/);
    inboxEvents.publish();
    const publishedEventChunk = await eventReader.read();
    assert.match(new TextDecoder().decode(publishedEventChunk.value), /event: inbox\.updated/);
    eventAbort.abort();
    const logout = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie } });
    assert.equal(logout.status, 204);
    assert.equal((await fetch(`${base}/api/conversations`, { headers: { Cookie: cookie } })).status, 401);
    const badLogin = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@teste.local", password: "senha-errada" }) });
    assert.equal(badLogin.status, 401);
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@teste.local", password: "senha-segura-123" }) });
    assert.equal(login.status, 200);
  } finally {
    server.close();
    await prisma.auditLog.deleteMany();
    await prisma.message.deleteMany();
    await prisma.conversation.deleteMany();
    await prisma.contact.deleteMany();
    await prisma.category.deleteMany({ where: { code: { in: ["CATEGORIA_API_TESTE", "SUPORTE_PERMISSAO_TESTE"] } } });
    await prisma.user.deleteMany({ where: { email: { in: ["admin@teste.local", "agente@teste.local"] } } });
    await prisma.$disconnect();
  }
});
