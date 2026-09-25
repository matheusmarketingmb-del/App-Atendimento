require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/database/prisma");
const chats = require("../src/services/internal-chat-service");

// Chat interno com grupos — cenários 1–10 da Parte 2.

const emailDomain = "@grupos-chat.test";

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { endsWith: emailDomain } }, select: { id: true } });
  const userIds = users.map(({ id }) => id);
  if (!userIds.length) return;
  const groups = await prisma.internalChat.findMany({
    where: { OR: [{ createdByUserId: { in: userIds } }, { type: "DIRECT", members: { some: { userId: { in: userIds } } } }] },
    select: { id: true },
  });
  await prisma.auditLog.deleteMany({ where: { entityType: "INTERNAL_CHAT", entityId: { in: groups.map(({ id }) => id) } } });
  await prisma.internalChat.deleteMany({ where: { id: { in: groups.map(({ id }) => id) } } });
  await prisma.internalMessage.deleteMany({ where: { senderUserId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

let seq = 0;
async function createUser(name, role = "ATENDENTE") {
  seq += 1;
  return prisma.user.create({ data: { name, email: `g${seq}-${Date.now()}${emailDomain}`, role } });
}

const unreadOf = async (chatId, viewer) => (await chats.listChats(viewer)).find(({ id }) => id === chatId)?.unreadCount;
const hasChat = async (chatId, viewer) => (await chats.listChats(viewer)).some(({ id }) => id === chatId);

test.before(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("grupos: criação, mensagens, acesso, membros, saída, nome, unread e conversa direta", async () => {
  const [userA, userB, userC, userD, master] = await Promise.all([
    createUser("Ana Grupo"), createUser("Bruno Grupo"), createUser("Carla Grupo"), createUser("Davi Grupo"),
    createUser("Master Grupo", "ADMIN"),
  ]);

  // Validações de criação.
  await assert.rejects(() => chats.createGroup({ name: "", memberIds: [userB.id] }, userA), { statusCode: 400 });
  await assert.rejects(() => chats.createGroup({ name: "Sozinho", memberIds: [userA.id] }, userA), { statusCode: 400 });
  await assert.rejects(() => chats.createGroup({ name: "Fantasma", memberIds: ["nao-existe"] }, userA), { statusCode: 400 });

  // 1. A cria grupo com B e C (A entra como admin).
  const { chat, memberIds } = await chats.createGroup({ name: "Lançamentos", memberIds: [userB.id, userC.id] }, userA);
  assert.equal(chat.type, "GROUP");
  assert.deepEqual(new Set(memberIds), new Set([userA.id, userB.id, userC.id]));
  const details = await chats.getGroup(chat.id, userA);
  assert.equal(details.memberCount, 3);
  assert.equal(details.viewerRole, "ADMIN");
  assert.equal(details.members.find(({ id }) => id === userB.id).chatRole, "MEMBER");
  assert.ok(await prisma.auditLog.findFirst({ where: { entityType: "INTERNAL_CHAT", entityId: chat.id, action: "INTERNAL_GROUP_CREATED" } }));

  // 2. A envia; B e C recebem (lista + não lidas + mensagens).
  const unreadBBefore = await unreadOf(chat.id, userB);
  const first = await chats.sendMessage(chat.id, "Reunião às 15h", userA);
  assert.equal(await unreadOf(chat.id, userB), unreadBBefore + 1);
  assert.ok((await unreadOf(chat.id, userC)) >= 1);
  assert.ok((await chats.listMessages(chat.id, userC)).some(({ id }) => id === first.id));
  // Realtime: destinatários são só os membros.
  assert.deepEqual(new Set(await chats.chatMemberIds(chat.id)), new Set([userA.id, userB.id, userC.id]));

  // 3. D não pertence: não lista, não lê, não envia, não vê detalhes.
  assert.equal(await hasChat(chat.id, userD), false);
  await assert.rejects(() => chats.listMessages(chat.id, userD), { statusCode: 403 });
  await assert.rejects(() => chats.sendMessage(chat.id, "invasão", userD), { statusCode: 403 });
  await assert.rejects(() => chats.getGroup(chat.id, userD), { statusCode: 404 });
  await assert.rejects(() => chats.addGroupMembers(chat.id, [userD.id], userD), { statusCode: 404 });
  // Master não entra automaticamente em grupos privados.
  assert.equal(await hasChat(chat.id, master), false);
  await assert.rejects(() => chats.listMessages(chat.id, master), { statusCode: 403 });

  // Membro comum não administra.
  await assert.rejects(() => chats.addGroupMembers(chat.id, [userD.id], userB), { statusCode: 403 });
  await assert.rejects(() => chats.renameGroup(chat.id, "Outro nome", userB), { statusCode: 403 });
  await assert.rejects(() => chats.removeGroupMember(chat.id, userC.id, userB), { statusCode: 403 });

  // 4. A adiciona D → D acessa.
  await chats.addGroupMembers(chat.id, [userD.id], userA);
  assert.equal(await hasChat(chat.id, userD), true);

  // 5. D vê o histórico anterior completo (regra escolhida).
  const messagesD = await chats.listMessages(chat.id, userD);
  assert.ok(messagesD.some(({ id }) => id === first.id));

  // 6. A remove C → C perde acesso e deixa de receber.
  await chats.removeGroupMember(chat.id, userC.id, userA);
  assert.equal(await hasChat(chat.id, userC), false);
  await assert.rejects(() => chats.listMessages(chat.id, userC), { statusCode: 403 });
  await assert.rejects(() => chats.sendMessage(chat.id, "ainda aqui?", userC), { statusCode: 403 });
  assert.equal((await chats.chatMemberIds(chat.id)).includes(userC.id), false);
  const removal = await prisma.auditLog.findFirst({ where: { entityId: chat.id, action: "INTERNAL_GROUP_MEMBER_REMOVED" } });
  assert.equal(removal.actorUserId, userA.id);
  assert.equal(removal.details.removedUserId, userC.id);
  assert.ok(removal.createdAt instanceof Date);
  // Mensagens antigas continuam no banco.
  assert.equal(await prisma.internalMessage.count({ where: { id: first.id } }), 1);

  // 7. B sai → não recebe realtime/unread nem envia.
  await chats.leaveGroup(chat.id, userB);
  assert.equal(await hasChat(chat.id, userB), false);
  assert.equal((await chats.chatMemberIds(chat.id)).includes(userB.id), false);
  await assert.rejects(() => chats.sendMessage(chat.id, "voltei", userB), { statusCode: 403 });

  // 8. Admin altera o nome → membros veem o novo nome + aviso no grupo.
  await chats.renameGroup(chat.id, "Lançamentos 2026", userA);
  const renamedForD = (await chats.listChats(userD)).find(({ id }) => id === chat.id);
  assert.equal(renamedForD.name, "Lançamentos 2026");
  assert.ok((await chats.listMessages(chat.id, userD)).some(({ type, metadata }) => type === "SYSTEM" && metadata?.event === "GROUP_RENAMED"));

  // Promover outro membro a admin (opcional simples) e não deixar o grupo sem admin.
  await chats.setGroupMemberRole(chat.id, userD.id, "ADMIN", userA);
  assert.equal((await chats.getGroup(chat.id, userD)).viewerRole, "ADMIN");
  await chats.setGroupMemberRole(chat.id, userD.id, "MEMBER", userA);
  await assert.rejects(() => chats.setGroupMemberRole(chat.id, userA.id, "MEMBER", userA), { statusCode: 400 });

  // 10. Unread do grupo: lê → 0; nova mensagem → 1.
  await chats.markAsRead(chat.id, userD);
  await chats.markAsRead(chat.id, userA);
  assert.equal(await unreadOf(chat.id, userD), 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await chats.sendMessage(chat.id, "Novidade", userA);
  assert.equal(await unreadOf(chat.id, userD), 1);
  assert.equal(await unreadOf(chat.id, userA), 0);

  // Último admin sai: o membro mais antigo restante vira admin.
  await chats.leaveGroup(chat.id, userA);
  assert.equal((await chats.getGroup(chat.id, userD)).viewerRole, "ADMIN");

  // Encerrar: somente leitura, histórico preservado.
  await chats.archiveGroup(chat.id, userD);
  await assert.rejects(() => chats.sendMessage(chat.id, "depois de encerrar", userD), { statusCode: 403 });
  assert.ok((await chats.listMessages(chat.id, userD)).length > 0);

  // 9. Conversa direta continua funcionando como antes.
  const direct = await chats.openDirectChat(userB.id, userA);
  assert.equal(direct.type, "DIRECT");
  await chats.sendMessage(direct.id, "Oi direto", userA);
  const directForB = (await chats.listChats(userB)).find(({ id }) => id === direct.id);
  assert.equal(directForB.unreadCount, 1);
  assert.equal(directForB.type, "DIRECT");
  await assert.rejects(() => chats.listMessages(direct.id, userC), { statusCode: 403 });
});
