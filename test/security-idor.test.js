// Item 54 (IDOR): usuário sem acesso à empresa não abre recurso alterando o ID
// — campanha, contato (atendente fixo), conversa, mensagem/anexo. Complementa
// test/multiempresa.test.js (conversas, busca, categorias, realtime).
require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const campaigns = require("../src/services/campaign-service");
const inbox = require("../src/services/inbox-service");
const preferred = require("../src/services/preferred-assignee-service");
const authorization = require("../src/services/authorization-service");

const emailDomain = "@idor.test";
const prefix = "idor-test-";

async function cleanup() {
  await prisma.campaign.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: prefix } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: emailDomain } } });
}

test.before(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("Supervisor só da Mibro: recursos da Sincrofit por ID → 404/403, nunca o conteúdo", async () => {
  const mibroOnly = await prisma.user.create({ data: {
    name: "Supervisor só Mibro", email: `sup${Date.now()}${emailDomain}`, role: "SUPERVISOR", canViewUncategorized: true,
    companyAccess: { create: { companyId: "cmp_mibro" } },
  } });
  const campaign = await prisma.campaign.create({ data: { companyId: "cmp_sincrofit", name: `${prefix}sincro`, templateName: "boas_vindas", templateLanguage: "pt_BR" } });
  const contact = await prisma.contact.create({ data: { companyId: "cmp_sincrofit", externalId: `${prefix}${Date.now()}`, phone: "5511944440000", name: "Cliente Sincrofit" } });
  const conversation = await prisma.conversation.create({ data: { companyId: "cmp_sincrofit", contactId: contact.id, status: "NOVO" } });
  const message = await prisma.message.create({ data: {
    conversationId: conversation.id, direction: "RECEBIDA", status: "RECEBIDA", type: "image", occurredAt: new Date(),
    mediaStorageKey: "idor/nao-existe.jpg", mediaMimeType: "image/jpeg", mediaFileName: "foto.jpg",
  } });

  await assert.rejects(() => campaigns.getCampaign(campaign.id, mibroOnly), { statusCode: 404 });
  await assert.rejects(() => authorization.assertCanViewConversation(mibroOnly, conversation.id), { statusCode: 404 });
  assert.equal(await inbox.getConversation(conversation.id, mibroOnly), null);
  await assert.rejects(() => inbox.assertCanViewMessage(mibroOnly, message.id), (error) => [403, 404].includes(error.statusCode));
  await assert.rejects(() => preferred.getPreferredAssignee(contact.id, mibroOnly), { statusCode: 403 });
  await assert.rejects(() => preferred.setPreferredAssignee(contact.id, { userId: mibroOnly.id }, mibroOnly), { statusCode: 403 });
  await assert.rejects(() => inbox.addContactNote(contact.id, { content: "x", authorId: mibroOnly.id }, mibroOnly), { statusCode: 403 });
  assert.equal((await inbox.listConversations({}, mibroOnly)).some(({ id }) => id === conversation.id), false);
});
