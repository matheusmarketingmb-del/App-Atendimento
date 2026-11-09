const { randomUUID } = require("node:crypto");
const { Prisma } = require("@prisma/client");
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

// =============================================================================
// Chat interno e empresas (workspaces MIBRO | SINCROFIT):
//   - Canais da empresa = chats de SETOR (categorias raiz), um por categoria,
//     com a empresa da categoria (InternalChat.companyId). Aparecem só no
//     workspace dessa empresa; quem acessa as duas troca pelo mesmo seletor
//     da Central. Não existe chat "Geral".
//   - Conversas diretas e grupos são da equipe (entre empresas): uma direta
//     por par de pessoas, grupos com participantes de qualquer empresa. Ficam
//     visíveis em qualquer workspace para os próprios membros.
//   - O Geral único antigo (anterior à separação) fica como histórico,
//     somente leitura, para os membros que já tinha. Nada é apagado.
// A empresa dos canais é sempre validada no servidor; a tela só informa o
// workspace ativo (X-Workspace) para impedir envio a um canal de outra
// empresa que tenha ficado aberto em segundo plano.
// =============================================================================
const LEGACY_READ_ONLY = "O chat Geral antigo (anterior à separação por empresa) fica disponível somente para leitura.";
const SHARED_TYPES = ["DIRECT", "GROUP"];

function companyService() {
  return require("./company-service");
}

function conflict(message) {
  return Object.assign(new Error(message), { statusCode: 409, code: "WORKSPACE_MISMATCH" });
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

// Quem participa dos canais da empresa: ativo, não Bot e com acesso a ela
// (Master acessa todas as empresas, como em company-service).
function companyUserWhere(companyId) {
  return {
    active: true,
    role: { not: "BOT" },
    OR: [{ role: "ADMIN" }, { companyAccess: { some: { companyId, active: true, company: { is: { active: true } } } } }],
  };
}

const teamUserWhere = { active: true, role: { not: "BOT" } };

// Escopo do chat: canal de uma empresa, conversa da equipe ou histórico.
function chatScope(chat) {
  if (chat.type === "SECTOR") return "COMPANY";
  if (SHARED_TYPES.includes(chat.type)) return "SHARED";
  return "LEGACY";
}

async function workspaceOf(viewer, requested) {
  return companyService().resolveWorkspace(viewer, requested);
}

// Empresa informada pela tela (slug ou id). Ausente = sem verificação
// (chamadas internas); presente = precisa ser a empresa do canal.
async function requestedCompanyId(viewer, requested) {
  const value = String(requested || "").trim();
  if (!value) return null;
  const ids = await companyService().resolveCompanyFilter(viewer, value);
  if (ids.length !== 1) throw badRequest("Selecione uma única empresa.");
  return ids[0];
}

async function syncSystemChats() {
  const [users, categories] = await Promise.all([
    prisma.user.findMany({
      where: { active: true },
      select: {
        id: true,
        role: true,
        companyAccess: { where: { active: true, company: { active: true } }, select: { companyId: true } },
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
        companyId: true,
      },
    }),
  ]);

  const inCompany = (user, companyId) => user.role === "ADMIN" || user.companyAccess.some((access) => access.companyId === companyId);

  for (const category of categories) {
    const chat = await prisma.internalChat.upsert({
      where: {
        key: `sector:${category.id}`,
      },
      update: {
        name: category.name,
        categoryId: category.id,
        companyId: category.companyId,
      },
      create: {
        key: `sector:${category.id}`,
        type: "SECTOR",
        name: category.name,
        categoryId: category.id,
        companyId: category.companyId,
      },
    });

    const members = users.filter((user) => {
      if (user.role === "ADMIN") return true;
      if (!inCompany(user, category.companyId)) return false;

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

// Membro + (canal) acesso atual à empresa do canal — a revogação vale antes
// da próxima sincronização — e workspace da tela igual ao do canal.
async function assertMember(chatId, viewer, { company } = {}) {
  const membership = await prisma.internalChatMember.findUnique({
    where: {
      chatId_userId: {
        chatId,
        userId: viewer.id,
      },
    },
    include: { chat: { select: { id: true, type: true, name: true, companyId: true, archivedAt: true } } },
  });

  if (!membership) throw forbidden();
  const { chat } = membership;
  if (chat.type === "SECTOR" && chat.companyId) {
    await companyService().assertCompanyAccess(viewer, chat.companyId, "Chat interno não encontrado.");
    const expected = await requestedCompanyId(viewer, company);
    if (expected && chat.companyId !== expected) throw conflict("Este canal pertence a outra empresa. Abra-o na área de trabalho correta.");
  }

  return membership;
}

const memberUserSelect = { id: true, name: true, email: true, role: true, active: true };

async function unreadByChat(chatIds, viewer) {
  if (!chatIds.length) return new Map();
  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT member."chatId", count(message.id)::int AS unread
    FROM "InternalChatMember" member
    JOIN "InternalMessage" message ON message."chatId" = member."chatId"
      AND (member."lastReadAt" IS NULL OR message."createdAt" > member."lastReadAt")
      AND (message."senderUserId" IS NULL OR message."senderUserId" <> ${viewer.id})
    WHERE member."userId" = ${viewer.id} AND member."chatId" IN (${Prisma.join(chatIds)})
    GROUP BY member."chatId"`);
  return new Map(rows.map((row) => [row.chatId, Number(row.unread) || 0]));
}

// Canais da empresa ativa + conversas da equipe (diretas e grupos) + o
// Geral antigo como histórico. Cada item traz `scope` para a tela separar.
async function listChats(viewer, { company } = {}) {
  await syncSystemChats();
  // Sem nenhuma empresa acessível (acesso revogado): só diretas, grupos e histórico.
  const hasCompany = (await companyService().accessibleCompanyIds(viewer)).length > 0;
  const companyId = hasCompany ? await workspaceOf(viewer, company) : null;

  const chats = await prisma.internalChat.findMany({
    where: {
      members: { some: { userId: viewer.id } },
      OR: [
        ...(companyId ? [{ type: "SECTOR", companyId }] : []),
        { type: { in: SHARED_TYPES } },
        { type: "GENERAL", companyId: null },
      ],
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
            select: memberUserSelect,
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

  const unread = await unreadByChat(chats.map((chat) => chat.id), viewer);
  return chats.map((chat) => {
    const membership = chat.members.find((member) => member.userId === viewer.id);
    const scope = chatScope(chat);
    return {
      id: chat.id,
      key: chat.key,
      type: chat.type,
      name: chat.name,
      description: chat.description || null,
      scope,
      companyId: scope === "COMPANY" ? chat.companyId : null,
      legacy: scope === "LEGACY",
      category: chat.category,
      members: chat.members.map((member) => ({ ...member.user, chatRole: member.role })),
      memberCount: chat.members.length,
      viewerRole: membership?.role || "MEMBER",
      createdByUserId: chat.createdByUserId || null,
      archivedAt: chat.archivedAt || null,
      lastMessage: chat.messages[0] || null,
      unreadCount: unread.get(chat.id) || 0,
    };
  });
}

// Não lidas: por empresa (canais) e da equipe (diretas e grupos, valem em
// qualquer workspace). Somente contagens e ids — nunca conteúdo.
async function getUnreadByCompany(viewer) {
  const access = await companyService().companyAccess(viewer);
  const companyIds = access.map(({ companyId }) => companyId);
  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT CASE WHEN chat.type = 'SECTOR' THEN chat."companyId" WHEN chat.type IN ('DIRECT', 'GROUP') THEN 'SHARED' ELSE 'LEGACY' END AS bucket,
      count(message.id)::int AS "unreadMessages",
      count(DISTINCT chat.id)::int AS "unreadChats",
      (array_agg(message.id ORDER BY message."createdAt" DESC))[1] AS "latestUnreadId",
      (array_agg(chat.id ORDER BY message."createdAt" DESC))[1] AS "latestChatId"
    FROM "InternalChatMember" member
    JOIN "InternalChat" chat ON chat.id = member."chatId"
    JOIN "InternalMessage" message ON message."chatId" = chat.id
      AND (member."lastReadAt" IS NULL OR message."createdAt" > member."lastReadAt")
      AND (message."senderUserId" IS NULL OR message."senderUserId" <> ${viewer.id})
    WHERE member."userId" = ${viewer.id}
      AND (
        chat.type IN ('DIRECT', 'GROUP')
        OR (chat.type = 'GENERAL' AND chat."companyId" IS NULL)
        ${companyIds.length ? Prisma.sql`OR (chat.type = 'SECTOR' AND chat."companyId" IN (${Prisma.join(companyIds)}))` : Prisma.empty}
      )
    GROUP BY bucket`);
  const byBucket = new Map(rows.map((row) => [row.bucket, row]));
  const counts = (row = {}) => ({
    unreadMessages: Number(row.unreadMessages) || 0, unreadChats: Number(row.unreadChats) || 0,
    latestUnreadId: row.latestUnreadId || null, latestChatId: row.latestChatId || null,
  });
  return {
    workspaces: access.map(({ companyId, company }) => ({ companyId, slug: company?.slug || null, ...counts(byBucket.get(companyId)) })),
    shared: counts(byBucket.get("SHARED")),
    legacy: counts(byBucket.get("LEGACY")),
    checkedAt: new Date().toISOString(),
  };
}

// Busca nos canais da empresa ativa e nas conversas da equipe da pessoa.
async function searchMessages(viewer, { company, q } = {}) {
  const term = String(q || "").trim();
  if (term.length < 2) throw badRequest("Digite pelo menos 2 caracteres.");
  if (term.length > 100) throw badRequest("Busca muito longa.");
  const companyId = await workspaceOf(viewer, company);
  const messages = await prisma.internalMessage.findMany({
    where: {
      text: { contains: term, mode: "insensitive" },
      chat: {
        members: { some: { userId: viewer.id } },
        OR: [{ type: "SECTOR", companyId }, { type: { in: SHARED_TYPES } }, { type: "GENERAL", companyId: null }],
      },
    },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      id: true, chatId: true, text: true, type: true, createdAt: true,
      senderUser: { select: { id: true, name: true } },
      chat: { select: { id: true, type: true, name: true, members: { select: { user: { select: { id: true, name: true } } } } } },
    },
  });
  return messages.map(({ chat, ...message }) => ({
    ...message,
    chat: {
      id: chat.id, type: chat.type,
      name: chat.type === "DIRECT" ? chat.members.map(({ user }) => user).find((user) => user.id !== viewer.id)?.name || "Conversa direta" : chat.name,
    },
  }));
}

// Pessoas para conversas e grupos: toda a equipe ativa, com as empresas de
// cada uma (a tela separa por empresa; quem está nas duas aparece uma vez).
async function listAvailableUsers(viewer) {
  const [users, companies] = await Promise.all([
    prisma.user.findMany({
      where: { ...teamUserWhere, id: { not: viewer.id } },
      select: {
        id: true, name: true, role: true,
        companyAccess: { where: { active: true, company: { is: { active: true } } }, select: { companyId: true } },
      },
      orderBy: { name: "asc" },
    }),
    prisma.company.findMany({ where: { active: true }, select: { id: true } }),
  ]);
  const allCompanyIds = companies.map(({ id }) => id);
  return users.map((user) => ({
    id: user.id,
    name: user.name,
    companyIds: user.role === "ADMIN" ? allCompanyIds : user.companyAccess.map(({ companyId }) => companyId),
  }));
}

async function listMessages(chatId, viewer, { company, page, before, after, around, limit } = {}) {
  await assertMember(chatId, viewer, { company });

  if(page==='1')return require('./internal-message-page-service').listPage(prisma,chatId,{before,after,around,limit});

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

    orderBy: [{createdAt:"desc"},{id:"desc"}],

    take: 300,
  }).then(messages=>messages.reverse());
}

// Reação local: nunca passa pela Meta nem pelas tabelas do WhatsApp.
async function reactToMessage(messageId, emoji, viewer, { company } = {}) {
  const features = require("./chat-features");
  features.assertEnabled("internalReactions");
  const normalized = features.normalizeEmoji(emoji);
  const message = await prisma.internalMessage.findUnique({ where: { id: String(messageId) }, select: { id: true, chatId: true, type: true } });
  if (!message) throw notFound("Mensagem não encontrada.");
  const { chat } = await assertMember(message.chatId, viewer, { company });
  assertWritable(chat);
  if (message.type !== "USER") throw badRequest("Esta mensagem não aceita reações.");
  const key = { messageId_userId: { messageId: message.id, userId: viewer.id } };
  if (normalized) await prisma.internalMessageReaction.upsert({ where: key, update: { emoji: normalized }, create: { messageId: message.id, userId: viewer.id, emoji: normalized } });
  else await prisma.internalMessageReaction.deleteMany({ where: { messageId: message.id, userId: viewer.id } });
  return { chatId: message.chatId, messageId: message.id, emoji: normalized };
}

function assertWritable(chat) {
  if (chatScope(chat) === "LEGACY") throw forbidden(LEGACY_READ_ONLY);
  if (chat.archivedAt) throw forbidden("Este grupo foi encerrado e está somente para leitura.");
}

async function sendMessage(chatId, text, viewer, { company } = {}) {
  const { chat } = await assertMember(chatId, viewer, { company });
  assertWritable(chat);

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

// Só abrir a conversa marca como lida — trocar de empresa nunca marca nada.
async function markAsRead(chatId, viewer, { company } = {}) {
  await assertMember(chatId, viewer, { company });

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

// Conversa direta com qualquer pessoa da equipe: uma por par, a mesma em
// qualquer workspace (reaproveita as conversas diretas já existentes).
async function openDirectChat(targetUserId, viewer) {
  if (targetUserId === viewer.id) {
    throw Object.assign(
      new Error("Não é possível abrir uma conversa com você mesmo."),
      { statusCode: 400 }
    );
  }

  const target = await prisma.user.findFirst({
    where: {
      ...teamUserWhere,
      id: targetUserId,
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

async function sendFile(chatId, file, caption, viewer, { company } = {}) {
  const { chat } = await assertMember(chatId, viewer, { company });
  assertWritable(chat);

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
      chat: { select: { type: true, companyId: true } },
    },
  });

  if (!message) {
    throw notFound("Arquivo não encontrado.");
  }
  // Anexo de canal da empresa: acesso à empresa conferido agora (revogação
  // imediata). <img> não envia o workspace, por isso não exige a aba ativa.
  if (message.chat.type === "SECTOR" && message.chat.companyId) {
    await companyService().assertCompanyAccess(viewer, message.chat.companyId, "Arquivo não encontrado.");
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
const GROUP_DESCRIPTION_MAX = 280;

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

// Participantes convidáveis: qualquer pessoa ativa da equipe (exceto Bot),
// de uma ou das duas empresas — a tela só filtra por empresa para escolher.
async function loadInvitableUsers(userIds) {
  if (!userIds.length) return [];
  const users = await prisma.user.findMany({
    where: { ...teamUserWhere, id: { in: userIds } },
    select: { id: true, name: true },
  });
  if (users.length !== userIds.length) throw badRequest("Um ou mais participantes não existem ou estão inativos.");
  return users;
}

// Grupos são da equipe (entre empresas): acesso = ser membro.
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
    actor, action, entityType: "INTERNAL_CHAT", entityId: chat.id, companyId: chat.companyId || undefined,
    summary, details: { groupName: chat.name, ...details },
  }, transaction);
}

async function getGroup(chatId, viewer, { company } = {}) {
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
    id: chat.id, type: chat.type, name: chat.name, description: chat.description || null, companyId: chat.companyId || null, archivedAt: chat.archivedAt,
    createdAt: chat.createdAt, createdBy: chat.createdBy, viewerRole,
    memberCount: chat.members.length,
    members: chat.members.map((member) => ({ ...member.user, chatRole: member.role, joinedAt: member.createdAt })),
  };
}

function validateDescription(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > GROUP_DESCRIPTION_MAX) throw badRequest(`A descrição deve ter no máximo ${GROUP_DESCRIPTION_MAX} caracteres.`);
  return text || null;
}

async function createGroup({ name, description, memberIds }, viewer) {
  const groupName = validateGroupName(name);
  const groupDescription = validateDescription(description);
  const invitedIds = normalizeUserIds(memberIds).filter((id) => id !== viewer.id);
  if (!invitedIds.length) throw badRequest("Adicione pelo menos um participante além de você.");
  if (invitedIds.length + 1 > GROUP_MEMBERS_MAX) throw badRequest(`Um grupo pode ter no máximo ${GROUP_MEMBERS_MAX} participantes.`);
  const invited = await loadInvitableUsers(invitedIds);
  const chat = await prisma.$transaction(async (transaction) => {
    const created = await transaction.internalChat.create({
      data: {
        key: `group:${randomUUID()}`, type: "GROUP", name: groupName, description: groupDescription, createdByUserId: viewer.id,
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

// Nome e/ou descrição (descrição ausente = mantém a atual).
async function renameGroup(chatId, name, viewer, { description, company } = {}) {
  const { chat } = await loadGroup(chatId, viewer, { requireAdmin: true, requireActive: true });
  const groupName = validateGroupName(name);
  const groupDescription = description === undefined ? chat.description || null : validateDescription(description);
  const memberIds = chat.members.map(({ userId }) => userId);
  const nameChanged = groupName !== chat.name;
  const descriptionChanged = groupDescription !== (chat.description || null);
  if (!nameChanged && !descriptionChanged) return { chat, memberIds };
  const updated = await prisma.$transaction(async (transaction) => {
    const renamed = await transaction.internalChat.update({ where: { id: chatId }, data: { name: groupName, description: groupDescription } });
    if (nameChanged) {
      await systemMessage(transaction, chatId, viewer, `${viewer.name || "Alguém"} alterou o nome do grupo para "${groupName}".`, {
        event: "GROUP_RENAMED", from: chat.name, to: groupName,
      });
      await groupAudit(transaction, viewer, "INTERNAL_GROUP_RENAMED", renamed, `Renomeou o grupo interno ${chat.name} para ${groupName}`, {
        from: chat.name, to: groupName,
      });
    }
    if (descriptionChanged) {
      await systemMessage(transaction, chatId, viewer, `${viewer.name || "Alguém"} alterou a descrição do grupo.`, { event: "GROUP_DESCRIPTION_CHANGED" });
      await groupAudit(transaction, viewer, "INTERNAL_GROUP_DESCRIPTION_CHANGED", renamed, `Alterou a descrição do grupo interno ${groupName}`, {
        from: chat.description || null, to: groupDescription,
      });
    }
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

async function removeGroupMember(chatId, userId, viewer, { company } = {}) {
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

async function leaveGroup(chatId, viewer, { company } = {}) {
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

async function setGroupMemberRole(chatId, userId, role, viewer, { company } = {}) {
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

// Destinatários de eventos em tempo real de um chat: membros atuais que
// ainda acessam a empresa do chat (revogação vale também para o SSE).
async function chatAudience(chatId) {
  const chat = await prisma.internalChat.findUnique({ where: { id: chatId }, select: { type: true, companyId: true } });
  if (!chat) return { companyId: null, userIds: [] };
  const companyId = chat.type === "SECTOR" ? chat.companyId || null : null;
  const members = await prisma.internalChatMember.findMany({
    where: { chatId, ...(companyId ? { user: companyUserWhere(companyId) } : {}) },
    select: { userId: true },
  });
  // companyId nulo no evento = conversa da equipe (vale em qualquer workspace).
  return { companyId, userIds: members.map(({ userId }) => userId) };
}

async function chatMemberIds(chatId) {
  return (await chatAudience(chatId)).userIds;
}

module.exports = {
  reactToMessage,
  addGroupMembers,
  archiveGroup,
  chatAudience,
  chatMemberIds,
  companyUserWhere,
  getUnreadByCompany,
  searchMessages,
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
