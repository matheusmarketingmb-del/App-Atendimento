require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { finalizeInactiveConversations } = require("../src/services/conversation-inactivity-service");
const { saveIncoming } = require("../src/services/message-service");

const testContacts = ["inactive-outgoing-test", "inactive-incoming-test", "inactive-routing-test", "inactive-flow-handoff-test"];

const lastAgentEmail = "inactive-last-agent@mibro.test";

test.after(async () => {
  await prisma.contact.deleteMany({ where: { externalId: { in: testContacts } } });
  await prisma.user.deleteMany({ where: { email: lastAgentEmail } });
  await prisma.$disconnect();
});

test("finaliza após 24 horas somente quando a equipe aguarda o cliente", async () => {
  const now = new Date("2026-08-13T15:30:00.000Z");
  const old = new Date("2026-08-12T15:29:00.000Z");
  const support = await prisma.category.findUnique({ where: { companyId_code: { companyId: "cmp_mibro", code: "SUPORTE" } } });
  const outgoingContact = await prisma.contact.create({
    data: { companyId: "cmp_mibro", externalId: testContacts[0], phone: "5511977770001", name: "Cliente sem retorno" },
  });
  const incomingContact = await prisma.contact.create({
    data: { companyId: "cmp_mibro", externalId: testContacts[1], phone: "5511977770002", name: "Cliente aguardando equipe" },
  });
  const routingContact = await prisma.contact.create({
    data: { companyId: "cmp_mibro", externalId: testContacts[2], phone: "5511977770003", name: "Cliente recém-encaminhado" },
  });
  const flowContact = await prisma.contact.create({
    data: { companyId: "cmp_mibro", externalId: testContacts[3], phone: "5511977770004", name: "Cliente transferido pelo fluxo" },
  });
  await prisma.user.deleteMany({ where: { email: lastAgentEmail } });
  const lastAgent = await prisma.user.create({ data: { companyAccess: { create: { companyId: "cmp_mibro" } }, name: "Último atendente", email: lastAgentEmail, role: "ATENDENTE" } });
  const outgoingConversation = await prisma.conversation.create({
    data: { companyId: "cmp_mibro", contactId: outgoingContact.id, categoryId: support.id, assignedUserId: lastAgent.id, status: "EM_ATENDIMENTO", lastMessageAt: old },
  });
  const incomingConversation = await prisma.conversation.create({
    data: { companyId: "cmp_mibro", contactId: incomingContact.id, categoryId: support.id, status: "AGUARDANDO_EQUIPE", lastMessageAt: old },
  });
  const routingConversation = await prisma.conversation.create({
    data: { companyId: "cmp_mibro", contactId: routingContact.id, categoryId: support.id, status: "NOVO", lastMessageAt: old },
  });
  const flowConversation = await prisma.conversation.create({
    data: { companyId: "cmp_mibro", contactId: flowContact.id, categoryId: support.id, status: "NOVO", lastMessageAt: old },
  });
  await prisma.message.createMany({ data: [
    { conversationId: flowConversation.id, direction: "ENVIADA", status: "ENVIADA", type: "text", text: "Vou te passar para o Suporte", occurredAt: old, rawPayload: { system: "visual_flow", flowHandoff: true } },
    { conversationId: outgoingConversation.id, direction: "ENVIADA", status: "ENVIADA", type: "text", text: "Pode confirmar?", occurredAt: old },
    { conversationId: incomingConversation.id, direction: "RECEBIDA", status: "RECEBIDA", type: "text", text: "Preciso de ajuda", occurredAt: old },
    { conversationId: routingConversation.id, direction: "ENVIADA", status: "ENVIADA", type: "text", text: "Encaminhamos seu atendimento", occurredAt: old, rawPayload: { system: "triage_confirmation" } },
  ] });

  assert.equal(await finalizeInactiveConversations({ now }), 1);
  const finalized = await prisma.conversation.findUnique({ where: { id: outgoingConversation.id } });
  assert.equal(finalized.status, "FINALIZADO");
  // Continua na categoria e com o último atendente (privada para ele).
  assert.equal(finalized.categoryId, support.id);
  assert.equal(finalized.assignedUserId, lastAgent.id);
  assert.ok(finalized.finalizedAt);
  assert.equal((await prisma.conversation.findUnique({ where: { id: incomingConversation.id } })).status, "AGUARDANDO_EQUIPE");
  assert.equal((await prisma.conversation.findUnique({ where: { id: routingConversation.id } })).status, "NOVO");
  assert.equal((await prisma.conversation.findUnique({ where: { id: flowConversation.id } })).status, "NOVO");
  assert.equal(await prisma.conversationActivity.count({
    where: { conversationId: outgoingConversation.id, action: "AUTO_FINALIZED_INACTIVITY" },
  }), 1);

  // Sem IA/aprendizado: finalizar por inatividade nunca dispara análise.
  assert.equal(await prisma.conversationLearningState.count({ where: { conversationId: outgoingConversation.id } }), 0);
});

test("nova mensagem em conversa finalizada remove setor para reiniciar a triagem", async () => {
  const support = await prisma.category.findUnique({ where: { companyId_code: { companyId: "cmp_mibro", code: "SUPORTE" } } });
  const conversation = await prisma.conversation.findFirst({
    where: { contact: { externalId: testContacts[0] } },
  });
  await prisma.conversation.update({
    where: { id: conversation.id }, data: { status: "FINALIZADO", categoryId: support.id, finalizedAt: new Date() },
  });
  await saveIncoming({
    externalId: "wamid.inactive.reopened", contactExternalId: testContacts[0],
    phone: "5511977770001", contactName: "Cliente sem retorno", type: "text", text: "Olá novamente",
    occurredAt: new Date(), rawPayload: { id: "wamid.inactive.reopened" },
  });
  const reopened = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  assert.equal(reopened.status, "NOVO");
  assert.equal(reopened.categoryId, null);
  assert.equal(reopened.assignedUserId, null);
  assert.equal(reopened.finalizedAt, null);
});
