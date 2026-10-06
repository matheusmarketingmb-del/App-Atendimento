require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const contactMerge = require("../src/services/contact-merge-service");

const prefix = `contact-merge-${process.pid}`;
let allowed;
let denied;
let account;
let whatsapp;
let email;
let whatsappConversation;
let emailConversation;

test.before(async () => {
  allowed = await prisma.user.create({ data: { companyAccess: { create: { companyId: "cmp_mibro" } }, name:"Pode fundir", email:`${prefix}-allowed@example.com`, role:"ATENDENTE", canViewUncategorized:true, canMergeContacts:true } });
  denied = await prisma.user.create({ data: { companyAccess: { create: { companyId: "cmp_mibro" } }, name:"Não pode fundir", email:`${prefix}-denied@example.com`, role:"ATENDENTE", canViewUncategorized:true } });
  account = await prisma.channelAccount.create({ data: { companyId: "cmp_mibro", channel:"EMAIL", name:prefix, status:"CONNECTED", enabled:true, accessUsers:{ create:{ userId:allowed.id } } } });
  whatsapp = await prisma.contact.create({ data: { companyId: "cmp_mibro", channel:"META", externalId:`${prefix}-phone`, phone:"5511999999999", name:"Cliente WhatsApp" } });
  email = await prisma.contact.create({ data: { companyId: "cmp_mibro", channel:"EMAIL", externalId:`${prefix}-mail`, email:`${prefix}@example.com`, name:"Cliente E-mail" } });
  whatsappConversation = await prisma.conversation.create({ data: { companyId: "cmp_mibro", contactId:whatsapp.id, channel:"META", channelScope:prefix } });
  emailConversation = await prisma.conversation.create({ data: { companyId: "cmp_mibro", contactId:email.id, channel:"EMAIL", channelScope:prefix, channelAccountId:account.id } });
});

test.after(async () => {
  await prisma.contact.deleteMany({ where: { id:{ in:[whatsapp.id,email.id] } } });
  await prisma.channelAccount.delete({ where:{ id:account.id } });
  await prisma.contactIdentity.deleteMany({ where:{ displayName:{ contains:"Cliente" } } });
  await prisma.user.deleteMany({ where:{ id:{ in:[allowed.id,denied.id] } } });
  await prisma.$disconnect();
});

test("somente usuário liberado pode fundir dois contatos acessíveis", async () => {
  await assert.rejects(() => contactMerge.mergeContacts(whatsapp.id, email.id, denied), (error) => error.statusCode === 403);
  const candidates = await contactMerge.listMergeCandidates(whatsapp.id, prefix, allowed);
  assert.equal(candidates.some((item) => item.id === email.id), true);
  const result = await contactMerge.mergeContacts(whatsapp.id, email.id, allowed);
  const contacts = await prisma.contact.findMany({ where:{ id:{ in:[whatsapp.id,email.id] } }, select:{ identityId:true } });
  assert.ok(result.identityId);
  assert.equal(contacts[0].identityId, result.identityId);
  assert.equal(contacts[1].identityId, result.identityId);
});

test("contato fundido oferece apenas conversas/canais acessíveis", async () => {
  const destinations = await contactMerge.getMergedDestinations(whatsapp.id, allowed);
  assert.deepEqual(new Set(destinations.map((item) => item.id)), new Set([whatsappConversation.id,emailConversation.id]));
  assert.deepEqual(new Set(destinations.map((item) => item.channel)), new Set(["META","EMAIL"]));
  const deniedDestinations = await contactMerge.getMergedDestinations(whatsapp.id, denied);
  assert.deepEqual(deniedDestinations.map((item) => item.id), [whatsappConversation.id]);
});

test("UI inclui permissão, fusão e seletor de canal", async () => {
  const fs = require("node:fs/promises");
  const [html, js] = await Promise.all([fs.readFile("public/index.html","utf8"), fs.readFile("public/js/app.js","utf8")]);
  assert.match(html,/id="permission-merge-contacts"/);
  assert.match(html,/id="merge-contact"/);
  assert.match(html,/id="merged-channel-select"/);
  assert.match(js,/targetContactId/);
  assert.match(js,/openConversation\(conversationId\)/);
});
