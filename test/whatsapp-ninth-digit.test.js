require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const { findOrCreateMetaConversation, whatsappIdVariants } = require("../src/services/conversation-service");

// Celular BR com e sem o 9º dígito deve cair no MESMO contato/conversa.
// Só apaga os contatos criados aqui (números únicos por execução).
const suffix = String(Date.now()).slice(-7);
const withNine = `55999${"8"}${suffix}`;
const withoutNine = `5599${"8"}${suffix}`;
const exactPairWithNine = `55999${"7"}${suffix}`;
const exactPairWithoutNine = `5599${"7"}${suffix}`;
const createdIds = [withNine, withoutNine, exactPairWithNine, exactPairWithoutNine];

async function cleanup() {
  await prisma.contact.deleteMany({ where: { channel: "META", externalId: { in: createdIds } } });
}

test.before(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("gera as duas grafias só para celular brasileiro com DDD", () => {
  assert.deepEqual(whatsappIdVariants("5511987791678"), ["5511987791678", "551187791678"]);
  assert.deepEqual(whatsappIdVariants("551187791678"), ["551187791678", "5511987791678"]);
  assert.deepEqual(whatsappIdVariants("+55 (11) 98779-1678"), ["5511987791678", "551187791678"]);
  assert.deepEqual(whatsappIdVariants("551133334444"), ["551133334444"]);
  assert.deepEqual(whatsappIdVariants("14155550123"), ["14155550123"]);
  assert.deepEqual(whatsappIdVariants(""), []);
});

test("resposta sem o 9 cai na conversa iniciada com o 9 (e vice-versa)", async () => {
  const first = await findOrCreateMetaConversation({ contactExternalId: withNine, phone: withNine, contactName: "Cliente Nono Dígito" });
  const reply = await findOrCreateMetaConversation({ contactExternalId: withoutNine, phone: withoutNine, contactName: "Cliente Nono Dígito" });
  assert.equal(reply.contact.id, first.contact.id);
  assert.equal(reply.conversation.id, first.conversation.id);
  assert.equal(await prisma.contact.count({ where: { channel: "META", externalId: { in: [withNine, withoutNine] } } }), 1);
  // O contato mantém o ID/telefone originais.
  assert.equal(reply.contact.externalId, withNine);
  assert.equal(reply.contact.phone, withNine);
});

test("quando os dois contatos já existem, cada ID continua no próprio contato", async () => {
  const a = await prisma.contact.create({ data: { channel: "META", externalId: exactPairWithNine, phone: exactPairWithNine, name: "Par A" } });
  const b = await prisma.contact.create({ data: { channel: "META", externalId: exactPairWithoutNine, phone: exactPairWithoutNine, name: "Par B" } });
  const resultA = await findOrCreateMetaConversation({ contactExternalId: exactPairWithNine, phone: exactPairWithNine });
  const resultB = await findOrCreateMetaConversation({ contactExternalId: exactPairWithoutNine, phone: exactPairWithoutNine });
  assert.equal(resultA.contact.id, a.id);
  assert.equal(resultB.contact.id, b.id);
});
