const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
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
        members: chat.members.map((member) => member.user),
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

async function sendMessage(chatId, text, viewer) {
  await assertMember(chatId, viewer);

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

module.exports = {
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
