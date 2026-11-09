const chats = require("../services/internal-chat-service");
const inboxEvents = require("../realtime/inbox-events");

// Tempo real do chat interno: o aviso vai só para quem é membro do chat e
// ainda acessa a empresa dele (e, em remoção/saída, também para quem acabou
// de perder o acesso, para a tela dele fechar o grupo). O payload leva só
// identificadores (chatId, companyId) — o conteúdo é sempre buscado pela
// API, que confere participação e empresa.
function notifyChat(chatId, userIds, kind, extra = {}) {
  inboxEvents.publishToUsers(userIds, "internal-chat.updated", { chatId, kind, ...extra });
}

async function notifyMembers(chatId, kind) {
  const { companyId, userIds } = await chats.chatAudience(chatId);
  notifyChat(chatId, userIds, kind, { companyId });
}

// Workspace ativo da tela (slug). O servidor valida o acesso e se o chat é
// mesmo dessa empresa; sem ele, usa o workspace salvo do usuário.
function workspace(req) {
  return req.get("x-workspace") || req.query.company || req.body?.company || undefined;
}

module.exports = {
  async users(req, res, next) {
    try {
      return res.json(await chats.listAvailableUsers(req.user, { company: workspace(req) }));
    } catch (error) {
      return next(error);
    }
  },

  async list(req, res, next) {
    try {
      return res.json(await chats.listChats(req.user, { company: workspace(req) }));
    } catch (error) {
      return next(error);
    }
  },

  async unread(req, res, next) {
    try {
      return res.json(await chats.getUnreadByCompany(req.user));
    } catch (error) {
      return next(error);
    }
  },

  async search(req, res, next) {
    try {
      return res.json(await chats.searchMessages(req.user, { company: workspace(req), q: req.query.q }));
    } catch (error) {
      return next(error);
    }
  },

  async react(req, res, next) {
    try {
      const result = await chats.reactToMessage(req.params.messageId, req.body?.emoji, req.user, { company: workspace(req) });
      await notifyMembers(result.chatId, "reaction");
      return res.json(result);
    } catch (error) {
      return next(error);
    }
  },

  async messages(req, res, next) {
    try {
      return res.json(await chats.listMessages(req.params.id, req.user, { company: workspace(req),page:req.query.page,before:req.query.before,after:req.query.after,around:req.query.around,limit:req.query.limit }));
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

      const message = await chats.sendFile(req.params.id, req.file, req.body.caption, req.user, { company: workspace(req) });

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
      const message = await chats.sendMessage(req.params.id, req.body.text, req.user, { company: workspace(req) });

      await notifyMembers(req.params.id, "message");

      return res.status(201).json(message);
    } catch (error) {
      return next(error);
    }
  },

  async read(req, res, next) {
    try {
      await chats.markAsRead(req.params.id, req.user, { company: workspace(req) });
      // Outras sessões do mesmo usuário atualizam o contador.
      const { companyId } = await chats.chatAudience(req.params.id);
      notifyChat(req.params.id, [req.user.id], "read", { companyId });

      return res.json({
        success: true,
      });
    } catch (error) {
      return next(error);
    }
  },

  async direct(req, res, next) {
    try {
      const chat = await chats.openDirectChat(req.params.userId, req.user, { company: workspace(req) });

      await notifyMembers(chat.id, "chat");

      return res.json(chat);
    } catch (error) {
      return next(error);
    }
  },

  async createGroup(req, res, next) {
    try {
      const { chat, memberIds } = await chats.createGroup({ ...(req.body || {}), company: workspace(req) }, req.user);
      notifyChat(chat.id, memberIds, "group-created", { companyId: chat.companyId });
      return res.status(201).json(chat);
    } catch (error) {
      return next(error);
    }
  },

  async group(req, res, next) {
    try {
      return res.json(await chats.getGroup(req.params.id, req.user, { company: workspace(req) }));
    } catch (error) {
      return next(error);
    }
  },

  async renameGroup(req, res, next) {
    try {
      const { chat, memberIds } = await chats.renameGroup(req.params.id, req.body?.name, req.user, { description: req.body?.description, company: workspace(req) });
      notifyChat(chat.id, memberIds, "group-renamed", { companyId: chat.companyId });
      return res.json(await chats.getGroup(req.params.id, req.user));
    } catch (error) {
      return next(error);
    }
  },

  async addGroupMembers(req, res, next) {
    try {
      const { chat, memberIds } = await chats.addGroupMembers(req.params.id, req.body?.userIds, req.user, { company: workspace(req) });
      notifyChat(chat.id, memberIds, "members-added", { companyId: chat.companyId });
      return res.json(await chats.getGroup(req.params.id, req.user));
    } catch (error) {
      return next(error);
    }
  },

  async removeGroupMember(req, res, next) {
    try {
      const { chat, memberIds, removedUserId } = await chats.removeGroupMember(req.params.id, req.params.userId, req.user, { company: workspace(req) });
      notifyChat(chat.id, memberIds, "member-removed", { companyId: chat.companyId });
      notifyChat(chat.id, [removedUserId], "removed", { companyId: chat.companyId });
      return res.json(await chats.getGroup(req.params.id, req.user));
    } catch (error) {
      return next(error);
    }
  },

  async setGroupMemberRole(req, res, next) {
    try {
      const { chat, memberIds } = await chats.setGroupMemberRole(req.params.id, req.params.userId, req.body?.role, req.user, { company: workspace(req) });
      notifyChat(chat.id, memberIds, "member-role", { companyId: chat.companyId });
      return res.json(await chats.getGroup(req.params.id, req.user));
    } catch (error) {
      return next(error);
    }
  },

  async leaveGroup(req, res, next) {
    try {
      const { chat, memberIds, removedUserId } = await chats.leaveGroup(req.params.id, req.user, { company: workspace(req) });
      notifyChat(chat.id, memberIds, "member-left", { companyId: chat.companyId });
      notifyChat(chat.id, [removedUserId], "removed", { companyId: chat.companyId });
      return res.json({ left: true });
    } catch (error) {
      return next(error);
    }
  },

  async archiveGroup(req, res, next) {
    try {
      const { chat, memberIds } = await chats.archiveGroup(req.params.id, req.user, { company: workspace(req) });
      notifyChat(chat.id, memberIds, "group-archived", { companyId: chat.companyId });
      return res.json(await chats.getGroup(req.params.id, req.user));
    } catch (error) {
      return next(error);
    }
  },
};
