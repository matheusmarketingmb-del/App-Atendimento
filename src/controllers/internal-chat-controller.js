const chats = require("../services/internal-chat-service");
const inboxEvents = require("../realtime/inbox-events");

// Tempo real do chat interno: o aviso vai só para quem é membro do chat
// (e, em remoção/saída, também para quem acabou de perder o acesso, para a
// tela dele fechar o grupo). O payload leva só identificadores — o conteúdo
// é sempre buscado pela API, que confere a participação.
function notifyChat(chatId, userIds, kind, extra = {}) {
  inboxEvents.publishToUsers(userIds, "internal-chat.updated", { chatId, kind, ...extra });
}

async function notifyMembers(chatId, kind) {
  notifyChat(chatId, await chats.chatMemberIds(chatId), kind);
}

module.exports = {
  async users(req, res, next) {
    try {
      return res.json(
        await chats.listAvailableUsers(req.user)
      );
    } catch (error) {
      return next(error);
    }
  },

  async list(req, res, next) {
    try {
      return res.json(
        await chats.listChats(req.user)
      );
    } catch (error) {
      return next(error);
    }
  },

  async messages(req, res, next) {
    try {
      return res.json(
        await chats.listMessages(
          req.params.id,
          req.user
        )
      );
    } catch (error) {
      return next(error);
    }
  },

  async file(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "Selecione um arquivo de até 100 MB.",
      });
    }

    const message = await chats.sendFile(
      req.params.id,
      req.file,
      req.body.caption,
      req.user
    );

    await notifyMembers(req.params.id, "message");

    return res.status(201).json(message);
  } catch (error) {
    return next(error);
  }
},

async media(req, res, next) {
  try {
    const media = await chats.getMessageMedia(
      req.params.messageId,
      req.user
    );

    res.type(media.mimeType || "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `${media.safeImage ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(media.fileName)}`);

    res.setHeader(
      "Cache-Control",
      "private, max-age=86400"
    );

    return res.sendFile(media.path);
  } catch (error) {
    return next(error);
  }
},

  async send(req, res, next) {
    try {
      const message = await chats.sendMessage(
        req.params.id,
        req.body.text,
        req.user
      );

      await notifyMembers(req.params.id, "message");

      return res.status(201).json(message);
    } catch (error) {
      return next(error);
    }
  },

  async read(req, res, next) {
    try {
      await chats.markAsRead(
        req.params.id,
        req.user
      );

      return res.json({
        success: true,
      });
    } catch (error) {
      return next(error);
    }
  },

  async direct(req, res, next) {
    try {
      const chat = await chats.openDirectChat(
        req.params.userId,
        req.user
      );

      await notifyMembers(chat.id, "chat");

      return res.json(chat);
    } catch (error) {
      return next(error);
    }
  },

  async createGroup(req, res, next) {
    try {
      const { chat, memberIds } = await chats.createGroup(req.body || {}, req.user);
      notifyChat(chat.id, memberIds, "group-created");
      return res.status(201).json(chat);
    } catch (error) {
      return next(error);
    }
  },

  async group(req, res, next) {
    try {
      return res.json(await chats.getGroup(req.params.id, req.user));
    } catch (error) {
      return next(error);
    }
  },

  async renameGroup(req, res, next) {
    try {
      const { chat, memberIds } = await chats.renameGroup(req.params.id, req.body?.name, req.user);
      notifyChat(chat.id, memberIds, "group-renamed");
      return res.json(await chats.getGroup(req.params.id, req.user));
    } catch (error) {
      return next(error);
    }
  },

  async addGroupMembers(req, res, next) {
    try {
      const { chat, memberIds } = await chats.addGroupMembers(req.params.id, req.body?.userIds, req.user);
      notifyChat(chat.id, memberIds, "members-added");
      return res.json(await chats.getGroup(req.params.id, req.user));
    } catch (error) {
      return next(error);
    }
  },

  async removeGroupMember(req, res, next) {
    try {
      const { chat, memberIds, removedUserId } = await chats.removeGroupMember(req.params.id, req.params.userId, req.user);
      notifyChat(chat.id, memberIds, "member-removed");
      notifyChat(chat.id, [removedUserId], "removed");
      return res.json(await chats.getGroup(req.params.id, req.user));
    } catch (error) {
      return next(error);
    }
  },

  async setGroupMemberRole(req, res, next) {
    try {
      const { chat, memberIds } = await chats.setGroupMemberRole(req.params.id, req.params.userId, req.body?.role, req.user);
      notifyChat(chat.id, memberIds, "member-role");
      return res.json(await chats.getGroup(req.params.id, req.user));
    } catch (error) {
      return next(error);
    }
  },

  async leaveGroup(req, res, next) {
    try {
      const { chat, memberIds, removedUserId } = await chats.leaveGroup(req.params.id, req.user);
      notifyChat(chat.id, memberIds, "member-left");
      notifyChat(chat.id, [removedUserId], "removed");
      return res.json({ left: true });
    } catch (error) {
      return next(error);
    }
  },

  async archiveGroup(req, res, next) {
    try {
      const { chat, memberIds } = await chats.archiveGroup(req.params.id, req.user);
      notifyChat(chat.id, memberIds, "group-archived");
      return res.json(await chats.getGroup(req.params.id, req.user));
    } catch (error) {
      return next(error);
    }
  },
};
