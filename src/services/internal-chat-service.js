const { randomUUID } = require("node:crypto");
const prisma = require("../database/prisma");
const audit = require("./audit-service");
const {
  storeInternalFile,
  resolveMedia,
} = require("./media-storage-service");
function forbidden(message = "Você não possui acesso a este chat.") {
  return Object.assign(new Error(message), { statusCode: 403 });
}

function notFound(message = "Chat interno não encontrado.") {
  return Object.assign(new Error(message), { statusCode: 404 });
}

async function syncSystemChats() {
  const [users, categories] = await Promise.all([
    prisma.user.findMany({
      where: { active: true },
      select: {
        id: true,
        role: true,
        categoryAccess: {
          select: {
            categoryId: true,
            category: {
              select: {
                id: true,
                parentId: true,
              },
            },
          },
        },
      },
    }),

    prisma.category.findMany({
      where: {
        active: true,
        parentId: null,
      },
      orderBy: [
        { displayOrder: "asc" },
        { name: "asc" },
      ],
      select: {
        id: true,
        name: true,
      },
    }),
  ]);

  const general = await prisma.internalChat.upsert({
    where: { key: "general" },
    update: { name: "Geral" },
    create: {
      key: "general",
      type: "GENERAL",
      name: "Geral",
    },
  });

  const activeUserIds = users.map((user) => user.id);
  await prisma.$transaction([
    prisma.internalChatMember.deleteMany({
      where: {
        chatId: general.id,
        ...(activeUserIds.length
          ? { userId: { notIn: activeUserIds } }
          : {}),
      },
    }),
    prisma.internalChatMember.createMany({
      data: users.map((user) => ({
        chatId: general.id,
        userId: user.id,
      })),
      skipDuplicates: true,
    }),
  ]);

  for (const category of categories) {
    const chat = await prisma.internalChat.upsert({
      where: {
        key: `sector:${category.id}`,
      },
      update: {
        name: category.name,
        categoryId: category.id,
      },
      create: {
        key: `sector:${category.id}`,
        type: "SECTOR",
        name: category.name,
        categoryId: category.id,
      },
    });

    const members = users.filter((user) => {
      if (user.role === "ADMIN") return true;

      return user.categoryAccess.some((access) => {
        return (
          access.categoryId === category.id ||
          access.category.parentId === category.id
        );
      });
    });

    const memberIds = members.map((user) => user.id);
    const membershipChanges = [
      prisma.internalChatMember.deleteMany({
        where: {
          chatId: chat.id,
          ...(memberIds.length
            ? { userId: { notIn: memberIds } }
          : {}),
        },
      }),
    ];

    if (members.length) {
      membershipChanges.push(prisma.internalChatMember.createMany({
        data: members.map((user) => ({
          chatId: chat.id,
          userId: user.id,
        })),
        skipDuplicates: true,
      }));
    }

    await prisma.$transaction(membershipChanges);
  }
}

async function assertMember(chatId, viewer) {
  const membership = await prisma.internalChatMember.findUnique({
    where: {
      chatId_userId: {
        chatId,
        userId: viewer.id,
      },
    },
  });

  if (!membership) throw forbidden();

  return membership;
}

async function listChats(viewer) {
  await syncSystemChats();

  const chats = await prisma.internalChat.findMany({
    where: {
      members: {
        some: {
          userId: viewer.id,
        },
      },
    },

    include: {
      category: {
        select: {
          id: true,
          name: true,
          color: true,
        },
      },

      members: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
              active: true,
            },
          },
        },
      },

      messages: {
        orderBy: {
          createdAt: "desc",
        },
        take: 1,
        include: {
          senderUser: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },

    orderBy: [
      { type: "asc" },
      { name: "asc" },
    ],
  });

  return Promise.all(
    chats.map(async (chat) => {
      const membership = chat.members.find(
        (member) => member.userId === viewer.id
      );

      const unreadCount = await prisma.internalMessage.count({
        where: {
          chatId: chat.id,

          ...(membership?.lastReadAt
            ? {
                createdAt: {
                  gt: membership.lastReadAt,
                },
              }
            : {}),

          OR: [
            { senderUserId: null },
            { senderUserId: { not: viewer.id } },
          ],
        },
      });

      return {
        id: chat.id,
        key: chat.key,
        type: chat.type,
        name: chat.name,
        category: chat.category,
        members: chat.members.map((member) => ({ ...member.user, chatRole: member.role })),
        memberCount: chat.members.length,
        viewerRole: membership?.role || "MEMBER",
        createdByUserId: chat.createdByUserId || null,
        archivedAt: chat.archivedAt || null,
        lastMessage: chat.messages[0] || null,
        unreadCount,
      };
    })
  );
}

async function listAvailableUsers(viewer) {
  return prisma.user.findMany({
    where: {
      active: true,
      id: { not: viewer.id },
      role: { not: "BOT" },
    },
    select: {
      id: true,
      name: true,
    },
    orderBy: {
      name: "asc",
    },
  });
}

async function listMessages(chatId, viewer) {
  await assertMember(chatId, viewer);

  return prisma.internalMessage.findMany({
    where: {
      chatId,
    },

    include: {
      senderUser: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },

    },

    orderBy: {
      createdAt: "asc",
    },

    take: 300,
  });
}

async function assertWritable(chatId) {
  const chat = await prisma.internalChat.findUnique({ where: { id: chatId }, select: { archivedAt: true } });
  if (chat?.archivedAt) throw forbidden("Este grupo foi encerrado e está somente para leitura.");
}

async function sendMessage(chatId, text, viewer) {
  await assertMember(chatId, viewer);
  await assertWritable(chatId);

  const content = String(text || "").trim();

  if (!content) {
    throw Object.assign(
      new Error("Digite uma mensagem."),
      { statusCode: 400 }
    );
  }

  if (content.length > 4000) {
    throw Object.assign(
      new Error("A mensagem deve ter no máximo 4.000 caracteres."),
      { statusCode: 400 }
    );
  }

  return prisma.internalMessage.create({
    data: {
      chatId,
      senderUserId: viewer.id,
      type: "USER",
      text: content,
    },

    include: {
      senderUser: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  });
}

async function markAsRead(chatId, viewer) {
  await assertMember(chatId, viewer);

  return prisma.internalChatMember.update({
    where: {
      chatId_userId: {
        chatId,
        userId: viewer.id,
      },
    },

    data: {
      lastReadAt: new Date(),
    },
  });
}

async function openDirectChat(targetUserId, viewer) {
  if (targetUserId === viewer.id) {
    throw Object.assign(
      new Error("Não é possível abrir uma conversa com você mesmo."),
      { statusCode: 400 }
    );
  }

  const target = await prisma.user.findFirst({
    where: {
      id: targetUserId,
      active: true,
    },
    select: {
      id: true,
      name: true,
    },
  });

  if (!target) {
    throw notFound("Usuário não encontrado ou inativo.");
  }

  const ids = [viewer.id, target.id].sort();
  const key = `direct:${ids[0]}:${ids[1]}`;

  const chat = await prisma.internalChat.upsert({
    where: { key },

    update: {},

    create: {
      key,
      type: "DIRECT",
      name: null,
    },
  });

  await prisma.internalChatMember.createMany({
    data: [
      {
        chatId: chat.id,
        userId: viewer.id,
      },
      {
        chatId: chat.id,
        userId: target.id,
      },
    ],
    skipDuplicates: true,
  });

  return chat;
}

async function createTransferNotice({
  conversationId,
  fromCategoryId,
  toCategoryId,
  actorUserId,
  note,
}) {
  if (!toCategoryId) return null;

  const destination = await prisma.category.findFirst({
    where: {
      id: toCategoryId,
      active: true,
    },

    include: {
      parent: true,
    },
  });

  if (!destination) return null;

  const root = destination.parent || destination;

  const chat = await prisma.internalChat.findUnique({
    where: {
      key: `sector:${root.id}`,
    },
  });

  if (!chat) return null;

  const conversation = await prisma.conversation.findUnique({
    where: {
      id: conversationId,
    },
    select: { id: true },
  });

  if (!conversation) return null;

  const actor = actorUserId
    ? await prisma.user.findUnique({
        where: {
          id: actorUserId,
        },
        select: {
          id: true,
          name: true,
        },
      })
    : null;

  const fromCategory = fromCategoryId
    ? await prisma.category.findUnique({
        where: {
          id: fromCategoryId,
        },
        include: {
          parent: true,
        },
      })
    : null;

  const fromName = fromCategory
    ? (
        fromCategory.parent
          ? `${fromCategory.parent.name}: ${fromCategory.name}`
          : fromCategory.name
      )
    : "Sem categoria";

  const toName = destination.parent
    ? `${destination.parent.name}: ${destination.name}`
    : destination.name;

  return prisma.internalMessage.create({
    data: {
      chatId: chat.id,
      senderUserId: actorUserId || null,
      type: "TRANSFER",
      text: String(note || "").trim() || null,
      conversationId,

      metadata: {
        fromCategoryId: fromCategoryId || null,
        toCategoryId,
        fromCategory: fromName,
        toCategory: toName,
        actorName: actor?.name || "Sistema",
      },
    },
  });
}

async function sendFile(chatId, file, caption, viewer) {
  await assertMember(chatId, viewer);
  await assertWritable(chatId);

  if (!file) {
    throw Object.assign(
      new Error("Selecione um arquivo."),
      { statusCode: 400 }
    );
  }

  const media = await storeInternalFile({
    buffer: file.buffer,
    mimeType: file.mimetype,
    fileName: file.originalname,
  });

  return prisma.internalMessage.create({
    data: {
      chatId,
      senderUserId: viewer.id,
      type: "USER",
      text: String(caption || "").trim() || null,

      metadata: {
        media: {
          storageKey: media.storageKey,
          mimeType: media.mimeType,
          fileName: media.fileName,
          size: media.size,
          safeImage: media.safeImage,
          // Item de segurança (file-risk-service.js): nunca bloqueia um
          // arquivo de negócio legítimo (JSON, planilha com macro, tipo não
          // identificado), só marca para quem for abrir saber que merece
          // atenção antes de confiar no conteúdo. Executáveis/scripts já
          // foram recusados antes de chegar aqui (storeInternalFile lança).
          suspicious: media.suspicious,
          suspiciousReason: media.suspiciousReason,
        },
      },
    },

    include: {
      senderUser: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  });
}

async function getMessageMedia(messageId, viewer) {
  const message = await prisma.internalMessage.findFirst({
    where: {
      id: messageId,

      chat: {
        members: {
          some: {
            userId: viewer.id,
          },
        },
      },
    },

    select: {
      id: true,
      metadata: true,
    },
  });

  if (!message) {
    throw notFound("Arquivo não encontrado.");
  }

  const media = message.metadata?.media;

  if (!media?.storageKey) {
    throw notFound("Esta mensagem não possui arquivo.");
  }

  return {
    path: resolveMedia(media.storageKey),
    mimeType: media.mimeType || "application/octet-stream",
    fileName: media.fileName || "arquivo",
    size: media.size || null,
    safeImage: media.safeImage === true || (
      media.safeImage !== false && /[.](jpg|png)$/.test(media.storageKey)
    ),
  };
}

// =============================================================================
// Grupos (type GROUP) — mesmo modelo/mensagens/lastReadAt/anexos dos demais
// chats internos; só acrescenta papel (ADMIN/MEMBER), criador e encerramento.
// Decisões desta primeira versão:
//   - novo membro vê o histórico completo do grupo (sem recorte);
//   - sair/ser removido apaga só o vínculo (InternalChatMember): a pessoa
//     deixa de ver o grupo, receber mensagens, não lidas e eventos; as
//     mensagens do grupo continuam intactas para os demais;
//   - Master NÃO entra automaticamente em grupos; acompanha criação e
//     mudanças de membros pela Auditoria (entityType INTERNAL_CHAT);
//   - "encerrar" não apaga nada: o grupo fica somente leitura.
// =============================================================================

const GROUP_NAME_MAX = 60;
const GROUP_MEMBERS_MAX = 100;

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function validateGroupName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw badRequest("Informe o nome do grupo.");
  if (name.length > GROUP_NAME_MAX) throw badRequest(`O nome do grupo deve ter no máximo ${GROUP_NAME_MAX} caracteres.`);
  return name;
}

function normalizeUserIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
}

// Participantes convidáveis: os mesmos usuários que o chat interno já lista
// (ativos, exceto contas de Bot).
async function loadInvitableUsers(userIds) {
  if (!userIds.length) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, active: true, role: { not: "BOT" } },
    select: { id: true, name: true },
  });
  if (users.length !== userIds.length) throw badRequest("Um ou mais participantes não existem ou estão inativos.");
  return users;
}

async function loadGroup(chatId, viewer, { requireAdmin = false, requireActive = false } = {}) {
  const chat = await prisma.internalChat.findUnique({
    where: { id: chatId },
    include: { members: { select: { userId: true, role: true } } },
  });
  // Não membro recebe 404 (não revela nem que o grupo existe).
  const membership = chat?.members.find((member) => member.userId === viewer.id);
  if (!chat || chat.type !== "GROUP" || !membership) throw notFound("Grupo não encontrado.");
  if (requireAdmin && membership.role !== "ADMIN") throw forbidden("Somente administradores do grupo podem fazer isso.");
  if (requireActive && chat.archivedAt) throw forbidden("Este grupo foi encerrado e está somente para leitura.");
  return { chat, membership };
}

function systemMessage(transaction, chatId, actor, text, metadata) {
  return transaction.internalMessage.create({
    data: { chatId, senderUserId: actor.id, type: "SYSTEM", text, metadata: metadata || undefined },
  });
}

function groupAudit(transaction, actor, action, chat, summary, details) {
  return audit.recordAudit({
    actor, action, entityType: "INTERNAL_CHAT", entityId: chat.id,
    summary, details: { groupName: chat.name, ...details },
  }, transaction);
}

async function getGroup(chatId, viewer) {
  await loadGroup(chatId, viewer);
  const chat = await prisma.internalChat.findUnique({
    where: { id: chatId },
    include: {
      createdBy: { select: { id: true, name: true } },
      members: {
        include: { user: { select: { id: true, name: true, email: true, role: true, active: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  const viewerRole = chat.members.find((member) => member.userId === viewer.id)?.role || "MEMBER";
  return {
    id: chat.id, type: chat.type, name: chat.name, archivedAt: chat.archivedAt,
    createdAt: chat.createdAt, createdBy: chat.createdBy, viewerRole,
    memberCount: chat.members.length,
    members: chat.members.map((member) => ({ ...member.user, chatRole: member.role, joinedAt: member.createdAt })),
  };
}

async function createGroup({ name, memberIds }, viewer) {
  const groupName = validateGroupName(name);
  const invitedIds = normalizeUserIds(memberIds).filter((id) => id !== viewer.id);
  if (!invitedIds.length) throw badRequest("Adicione pelo menos um participante além de você.");
  if (invitedIds.length + 1 > GROUP_MEMBERS_MAX) throw badRequest(`Um grupo pode ter no máximo ${GROUP_MEMBERS_MAX} participantes.`);
  const invited = await loadInvitableUsers(invitedIds);
  const chat = await prisma.$transaction(async (transaction) => {
    const created = await transaction.internalChat.create({
      data: {
        key: `group:${randomUUID()}`, type: "GROUP", name: groupName, createdByUserId: viewer.id,
        members: {
          create: [
            { userId: viewer.id, role: "ADMIN", lastReadAt: new Date() },
            ...invited.map((user) => ({ userId: user.id, role: "MEMBER" })),
          ],
        },
      },
    });
    await systemMessage(transaction, created.id, viewer, `${viewer.name || "Alguém"} criou o grupo "${groupName}".`, { event: "GROUP_CREATED" });
    await groupAudit(transaction, viewer, "INTERNAL_GROUP_CREATED", created, `Criou o grupo interno ${groupName}`, {
      memberIds: [viewer.id, ...invited.map(({ id }) => id)],
      memberNames: invited.map(({ name: memberName }) => memberName),
    });
    return created;
  });
  return { chat, memberIds: [viewer.id, ...invited.map(({ id }) => id)] };
}

async function renameGroup(chatId, name, viewer) {
  const { chat } = await loadGroup(chatId, viewer, { requireAdmin: true, requireActive: true });
  const groupName = validateGroupName(name);
  const memberIds = chat.members.map(({ userId }) => userId);
  if (groupName === chat.name) return { chat, memberIds };
  const updated = await prisma.$transaction(async (transaction) => {
    const renamed = await transaction.internalChat.update({ where: { id: chatId }, data: { name: groupName } });
    await systemMessage(transaction, chatId, viewer, `${viewer.name || "Alguém"} alterou o nome do grupo para "${groupName}".`, {
      event: "GROUP_RENAMED", from: chat.name, to: groupName,
    });
    await groupAudit(transaction, viewer, "INTERNAL_GROUP_RENAMED", renamed, `Renomeou o grupo interno ${chat.name} para ${groupName}`, {
      from: chat.name, to: groupName,
    });
    return renamed;
  });
  return { chat: updated, memberIds };
}

async function addGroupMembers(chatId, userIds, viewer) {
  const { chat } = await loadGroup(chatId, viewer, { requireAdmin: true, requireActive: true });
  const currentIds = new Set(chat.members.map(({ userId }) => userId));
  const newIds = normalizeUserIds(userIds).filter((id) => !currentIds.has(id));
  if (!newIds.length) throw badRequest("Selecione pelo menos um novo participante.");
  if (currentIds.size + newIds.length > GROUP_MEMBERS_MAX) throw badRequest(`Um grupo pode ter no máximo ${GROUP_MEMBERS_MAX} participantes.`);
  const users = await loadInvitableUsers(newIds);
  const addedUserIds = users.map(({ id }) => id);
  await prisma.$transaction(async (transaction) => {
    await transaction.internalChatMember.createMany({
      data: users.map((user) => ({ chatId, userId: user.id, role: "MEMBER" })),
      skipDuplicates: true,
    });
    const names = users.map(({ name }) => name).join(", ");
    await systemMessage(transaction, chatId, viewer, `${viewer.name || "Alguém"} adicionou ${names}.`, {
      event: "MEMBERS_ADDED", userIds: addedUserIds,
    });
    await groupAudit(transaction, viewer, "INTERNAL_GROUP_MEMBERS_ADDED", chat, `Adicionou ${names} ao grupo interno ${chat.name}`, {
      addedUserIds, addedNames: users.map(({ name }) => name),
    });
  });
  return { chat, memberIds: [...currentIds, ...addedUserIds], addedUserIds };
}

// Garante que um grupo com membros nunca fica sem administrador: se o
// último admin sair/for removido, o membro mais antigo vira admin.
async function ensureGroupAdmin(transaction, chatId) {
  const members = await transaction.internalChatMember.findMany({
    where: { chatId }, orderBy: { createdAt: "asc" }, select: { userId: true, role: true },
  });
  if (!members.length || members.some(({ role }) => role === "ADMIN")) return;
  await transaction.internalChatMember.update({
    where: { chatId_userId: { chatId, userId: members[0].userId } }, data: { role: "ADMIN" },
  });
}

async function removeGroupMember(chatId, userId, viewer) {
  if (userId === viewer.id) throw badRequest("Para sair do grupo, use a opção Sair do grupo.");
  const { chat } = await loadGroup(chatId, viewer, { requireAdmin: true });
  if (!chat.members.some((member) => member.userId === userId)) throw notFound("Participante não encontrado neste grupo.");
  const removed = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true } });
  await prisma.$transaction(async (transaction) => {
    await transaction.internalChatMember.delete({ where: { chatId_userId: { chatId, userId } } });
    await ensureGroupAdmin(transaction, chatId);
    await systemMessage(transaction, chatId, viewer, `${viewer.name || "Alguém"} removeu ${removed?.name || "um participante"}.`, {
      event: "MEMBER_REMOVED", userId,
    });
    await groupAudit(transaction, viewer, "INTERNAL_GROUP_MEMBER_REMOVED", chat, `Removeu ${removed?.name || "um participante"} do grupo interno ${chat.name}`, {
      removedUserId: userId, removedName: removed?.name || null, removedAt: new Date().toISOString(),
    });
  });
  return { chat, memberIds: chat.members.map((member) => member.userId).filter((id) => id !== userId), removedUserId: userId };
}

async function leaveGroup(chatId, viewer) {
  const { chat } = await loadGroup(chatId, viewer);
  const remainingIds = chat.members.map((member) => member.userId).filter((id) => id !== viewer.id);
  await prisma.$transaction(async (transaction) => {
    await transaction.internalChatMember.delete({ where: { chatId_userId: { chatId, userId: viewer.id } } });
    if (remainingIds.length) {
      await ensureGroupAdmin(transaction, chatId);
      await systemMessage(transaction, chatId, viewer, `${viewer.name || "Alguém"} saiu do grupo.`, { event: "MEMBER_LEFT", userId: viewer.id });
    } else if (!chat.archivedAt) {
      // Último participante saiu: encerra (histórico preservado no banco).
      await transaction.internalChat.update({ where: { id: chatId }, data: { archivedAt: new Date() } });
    }
    await groupAudit(transaction, viewer, "INTERNAL_GROUP_MEMBER_LEFT", chat, `Saiu do grupo interno ${chat.name}`, {
      userId: viewer.id, leftAt: new Date().toISOString(),
    });
  });
  return { chat, memberIds: remainingIds, removedUserId: viewer.id };
}

async function setGroupMemberRole(chatId, userId, role, viewer) {
  if (!["ADMIN", "MEMBER"].includes(role)) throw badRequest("Papel inválido.");
  const { chat } = await loadGroup(chatId, viewer, { requireAdmin: true, requireActive: true });
  const memberIds = chat.members.map((member) => member.userId);
  const target = chat.members.find((member) => member.userId === userId);
  if (!target) throw notFound("Participante não encontrado neste grupo.");
  if (target.role === role) return { chat, memberIds };
  if (role === "MEMBER" && chat.members.filter((member) => member.role === "ADMIN").length <= 1) {
    throw badRequest("O grupo precisa de pelo menos um administrador.");
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  await prisma.$transaction(async (transaction) => {
    await transaction.internalChatMember.update({ where: { chatId_userId: { chatId, userId } }, data: { role } });
    await systemMessage(transaction, chatId, viewer, role === "ADMIN"
      ? `${viewer.name || "Alguém"} tornou ${user?.name || "um participante"} administrador.`
      : `${viewer.name || "Alguém"} removeu ${user?.name || "um participante"} da administração.`, {
      event: "MEMBER_ROLE_CHANGED", userId, role,
    });
    await groupAudit(transaction, viewer, "INTERNAL_GROUP_ROLE_CHANGED", chat, `Alterou o papel de ${user?.name || "um participante"} no grupo interno ${chat.name}`, {
      userId, from: target.role, to: role,
    });
  });
  return { chat, memberIds };
}

async function archiveGroup(chatId, viewer) {
  const { chat } = await loadGroup(chatId, viewer, { requireAdmin: true, requireActive: true });
  await prisma.$transaction(async (transaction) => {
    await transaction.internalChat.update({ where: { id: chatId }, data: { archivedAt: new Date() } });
    await systemMessage(transaction, chatId, viewer, `${viewer.name || "Alguém"} encerrou o grupo. O histórico continua disponível para leitura.`, {
      event: "GROUP_ARCHIVED",
    });
    await groupAudit(transaction, viewer, "INTERNAL_GROUP_ARCHIVED", chat, `Encerrou o grupo interno ${chat.name}`, {});
  });
  return { chat, memberIds: chat.members.map((member) => member.userId) };
}

// Destinatários de eventos em tempo real de um chat: somente membros atuais.
async function chatMemberIds(chatId) {
  const members = await prisma.internalChatMember.findMany({ where: { chatId }, select: { userId: true } });
  return members.map(({ userId }) => userId);
}

module.exports = {
  addGroupMembers,
  archiveGroup,
  chatMemberIds,
  createGroup,
  getGroup,
  leaveGroup,
  removeGroupMember,
  renameGroup,
  setGroupMemberRole,
  createTransferNotice,
  getMessageMedia,
  listAvailableUsers,
  listChats,
  listMessages,
  markAsRead,
  openDirectChat,
  sendFile,
  sendMessage,
  syncSystemChats,
};
