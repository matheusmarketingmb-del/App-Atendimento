require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const prisma = require("../src/database/prisma");
const internalChat = require("../src/services/internal-chat-service");
const inbox = require("../src/services/inbox-service");
const { resolveMedia } = require("../src/services/media-storage-service");

const testEmails = [
  "chat-interno-a@mibro.test",
  "chat-interno-b@mibro.test",
  "chat-interno-fora@mibro.test",
];
const testContactExternalId = "internal-chat-custom-name-test";

async function cleanup() {
  const users = await prisma.user.findMany({
    where: { email: { in: testEmails } },
    select: { id: true },
  });
  const userIds = users.map(({ id }) => id);

  if (userIds.length) {
    await prisma.internalMessage.deleteMany({
      where: { senderUserId: { in: userIds } },
    });
    await prisma.internalChat.deleteMany({
      where: {
        type: "DIRECT",
        members: { some: { userId: { in: userIds } } },
      },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  await prisma.contact.deleteMany({
    where: { externalId: testContactExternalId },
  });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await prisma.$disconnect();
});

test("chat interno atualiza não lidas e não expõe dados do contato na sinalização", async () => {
  const [sender, recipient] = await Promise.all([
    prisma.user.create({
      data: { companyAccess: { create: { companyId: "cmp_mibro" } },
        name: "Chat Interno A",
        email: testEmails[0],
        role: "ADMIN",
      },
    }),
    prisma.user.create({
      data: { companyAccess: { create: { companyId: "cmp_mibro" } },
        name: "Chat Interno B",
        email: testEmails[1],
        role: "ADMIN",
      },
    }),
  ]);

  const direct = await internalChat.openDirectChat(recipient.id, sender);
  const availableUsers = await internalChat.listAvailableUsers(sender);
  assert.equal(availableUsers.some(({ id }) => id === recipient.id), true);
  assert.equal(availableUsers.some(({ id }) => id === sender.id), false);
  assert.equal(availableUsers.every((user) => Object.keys(user).length === 2), true);
  const sent = await internalChat.sendMessage(direct.id, "Olá, equipe", sender);
  assert.equal(sent.text, "Olá, equipe");

  let recipientChats = await internalChat.listChats(recipient);
  let recipientDirect = recipientChats.find(({ id }) => id === direct.id);
  assert.equal(recipientDirect.unreadCount, 1);

  await internalChat.markAsRead(direct.id, recipient);
  recipientChats = await internalChat.listChats(recipient);
  recipientDirect = recipientChats.find(({ id }) => id === direct.id);
  assert.equal(recipientDirect.unreadCount, 0);

  const category = await prisma.category.findFirst({
    where: { active: true, parentId: null },
  });
  assert.ok(category);

  await internalChat.listChats(sender);
  const contact = await prisma.contact.create({
    data: { companyId: "cmp_mibro",
      externalId: testContactExternalId,
      phone: "5511999990000",
      name: "Nome Meta",
      customName: "Nome Interno",
    },
  });
  const conversation = await prisma.conversation.create({
    data: { companyId: "cmp_mibro",
      contactId: contact.id,
      categoryId: category.id,
      status: "EM_ATENDIMENTO",
    },
  });

  const transfer = await internalChat.createTransferNotice({
    conversationId: conversation.id,
    fromCategoryId: null,
    toCategoryId: category.id,
    actorUserId: sender.id,
  });

  assert.ok(transfer);
  assert.equal(transfer.type, "TRANSFER");
  assert.equal(transfer.metadata.toCategory, category.name);
  assert.equal("contactPhone" in transfer.metadata, false);
  assert.equal("contactName" in transfer.metadata, false);
});

test("busca de conversas encontra o nome personalizado do contato", async () => {
  const viewer = await prisma.user.create({
    data: { companyAccess: { create: { companyId: "cmp_mibro" } },
      name: "Busca Customizada",
      email: testEmails[0],
      role: "ADMIN",
    },
  });
  const contact = await prisma.contact.create({
    data: { companyId: "cmp_mibro",
      externalId: testContactExternalId,
      phone: "5511999990001",
      name: "Nome recebido pela Meta",
      customName: "Cliente Prioritário",
    },
  });
  const conversation = await prisma.conversation.create({
    data: { companyId: "cmp_mibro", contactId: contact.id, status: "NOVO" },
  });

  const results = await inbox.listConversations(
    { search: "prioritário" },
    viewer
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].id, conversation.id);
  assert.equal(results[0].contact.customName, "Cliente Prioritário");
});

test("arquivos internos aceitam formatos diversos com prévia e download restritos", async () => {
  const previousStorage = process.env.MEDIA_STORAGE_DIR;
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "app-whats-internal-files-"));
  process.env.MEDIA_STORAGE_DIR = storageDir;

  try {
    const [sender, recipient, outsider] = await Promise.all([
      prisma.user.create({ data: { companyAccess: { create: { companyId: "cmp_mibro" } }, name: "Remetente", email: testEmails[0], role: "ADMIN" } }),
      prisma.user.create({ data: { companyAccess: { create: { companyId: "cmp_mibro" } }, name: "Destinatário", email: testEmails[1], role: "ADMIN" } }),
      prisma.user.create({ data: { companyAccess: { create: { companyId: "cmp_mibro" } }, name: "Sem acesso", email: testEmails[2], role: "ADMIN" } }),
    ]);
    const direct = await internalChat.openDirectChat(recipient.id, sender);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("imagem-segura"),
    ]);
    const imageMessage = await internalChat.sendFile(direct.id, {
      buffer: png, mimetype: "application/octet-stream", originalname: "../../produto.png",
    }, "Prévia", sender);

    assert.equal(imageMessage.metadata.media.fileName, "produto.png");
    assert.equal(imageMessage.metadata.media.mimeType, "image/png");
    assert.equal(imageMessage.metadata.media.safeImage, true);
    assert.deepEqual(await fs.readFile(resolveMedia(imageMessage.metadata.media.storageKey)), png);

    const fakeImage = await internalChat.sendFile(direct.id, {
      buffer: Buffer.from("<script>alert('x')</script>"),
      mimetype: "image/png",
      originalname: "../../relatorio.html",
    }, "", sender);
    assert.equal(fakeImage.metadata.media.safeImage, false);
    assert.equal(fakeImage.metadata.media.fileName, "relatorio.html");

    const recipientMedia = await internalChat.getMessageMedia(fakeImage.id, recipient);
    assert.equal(recipientMedia.safeImage, false);
    assert.match(recipientMedia.path, new RegExp(`${path.sep}app-whats-internal-files-`));
    await assert.rejects(() => internalChat.getMessageMedia(fakeImage.id, outsider), /não encontrado/i);
    assert.throws(() => resolveMedia("../../segredo.env"), /Mídia inválida/);
  } finally {
    if (previousStorage === undefined) delete process.env.MEDIA_STORAGE_DIR;
    else process.env.MEDIA_STORAGE_DIR = previousStorage;
    await fs.rm(storageDir, { recursive: true, force: true });
  }
});
