const inbox = require("../services/inbox-service");
const { resolveMedia } = require("../services/media-storage-service");
const { finalizeConversation, sendDocument, sendImage, sendText, sendVideo } = require("../services/message-service");
const inboxEvents = require("../realtime/inbox-events");
const authorization = require("../services/authorization-service");
const internalChat = require("../services/internal-chat-service");
const { customerServiceWindowFrom, getCustomerServiceWindow, listApprovedTemplates, sendApprovedTemplate, templatesConfigured } = require("../services/meta-template-service");
const { createOutboundConversation, createOutboundEmail, listOutboundChannels } = require("../services/outbound-conversation-service");
const { analyzeConversation } = require("../services/bot-learning-service");
const { submitAgentFeedback } = require("../services/bot-agent-feedback-service");
const { Channel: ChannelEnum } = require("@prisma/client");
const contactMerge = require("../services/contact-merge-service");
const channelMessageService = require("../services/channels/channel-message-service");
const { createAdapter } = require("../services/channels/channel-adapter-registry");
const { resolveForPost } = require("../services/channels/social-content-mapping-service");
const { moderateMessage } = require("../services/channels/social-moderation-service");

const SOCIAL_COMMENT_CHANNELS = new Set(["INSTAGRAM_COMMENTS", "FACEBOOK_COMMENTS"]);

const knownChannels = new Set(Object.values(ChannelEnum));

// Capacidades reais do canal (item 6/23 do plano Social) — estático por
// classe de adapter, não depende de conta/segredo, então dá para calcular
// sem I/O extra a cada detalhe de conversa. A UI só pode mostrar um botão
// de ação (responder publicamente/no privado/moderar) quando o campo
// correspondente aqui for true; nunca assume suporte por omissão.
function channelCapabilities(channel) {
  const adapter = createAdapter(channel, null);
  return adapter ? adapter.capabilities() : null;
}

function createInboxController(channel) {
  return {
    async list(req, res, next) {
      try {
        // Filtros combináveis (item 11): status/priority aceitam lista
        // separada por vírgula — valida cada valor individualmente.
        if (req.query.status && !String(req.query.status).split(",").every((value) => inbox.conversationStatuses.has(value.trim()))) {
          return res.status(400).json({ error: "Status inválido." });
        }
        if (req.query.priority && !String(req.query.priority).split(",").every((value) => inbox.conversationPriorities.has(value.trim()))) {
          return res.status(400).json({ error: "Prioridade inválida." });
        }
        if (req.query.channel && !String(req.query.channel).split(",").every((value) => knownChannels.has(value))) {
          return res.status(400).json({ error: "Canal inválido." });        }
        return res.json(await inbox.listConversations(req.query, req.user));
      } catch (error) { return next(error); }
    },
    async detail(req, res, next) {
      try {
        const conversation = await inbox.getConversation(req.params.id, req.user);
        if (!conversation) return res.status(404).json({ error: "Conversa não encontrada." });
        const customerServiceWindow = conversation.channel === "META"
          ? await getCustomerServiceWindow(conversation.id)
          : customerServiceWindowFrom(null, new Date(), false);
        const mergedDestinations = await contactMerge.getMergedDestinations(conversation.contact.id, req.user);
        const channelCaps = channelCapabilities(conversation.channel);
        // Item 10 do plano Social — comentário nunca chega "pelado": quando
        // há mapeamento manual cadastrado (Integrações > Publicações), o
        // painel de contexto mostra a publicação/produto relacionado.
        const postContext = SOCIAL_COMMENT_CHANNELS.has(conversation.channel) && conversation.externalConversationId
          ? await resolveForPost(conversation.channel, conversation.externalConversationId)
          : null;
        const transferCategories = conversation.accessMode === "SUPERVISION"
          ? [] : await inbox.listTransferCategories(conversation.id, req.user);
        return res.json({ ...conversation, customerServiceWindow, mergedDestinations, channelCapabilities: channelCaps, postContext, transferCategories });
      } catch (error) { return next(error); }
    },
    async mergeCandidates(req, res, next) {
      try { return res.json(await contactMerge.listMergeCandidates(req.params.contactId, req.query.search, req.user)); }
      catch (error) { return next(error); }
    },
    async mergeContacts(req, res, next) {
      try {
        const result = await contactMerge.mergeContacts(req.params.contactId, req.body.targetContactId, req.user);
        inboxEvents.publish();
        return res.json(result);
      } catch (error) { return next(error); }
    },
    async templates(req, res, next) {
      try {
        let providerChannel = channel;
        if (req.query.conversationId) {
          await authorization.assertCanActOnConversation(req.user, req.query.conversationId);
          const conversation = await prisma.conversation.findUnique({ where: { id: req.query.conversationId }, select: { channelAccountId: true } });
          if (conversation?.channelAccountId) providerChannel = (await channelMessageService.adapterFor("META", conversation.channelAccountId)).channel;
        } else if (req.query.accountId && req.query.accountId !== "legacy") {
          if (!(await authorization.canAccessChannelAccount(req.user, req.query.accountId))) throw authorization.forbidden("Você não tem acesso a este número.");
          providerChannel = (await channelMessageService.adapterFor("META", req.query.accountId)).channel;
        }
        return res.json(await listApprovedTemplates(providerChannel));
      } catch (error) { return next(error); }
    },
    async metaStatus(_req, res) {
      return res.json({ templatesConfigured: templatesConfigured() });
    },
    async outboundChannels(req, res, next) {
      try { return res.json(await listOutboundChannels(req.user)); }
      catch (error) { return next(error); }
    },
    async createOutboundEmail(req, res, next) {
      try {
        const attachments = (req.files || []).map((file) => ({
          buffer: file.buffer, mimeType: file.mimetype, fileName: file.originalname,
        }));
        const result = await createOutboundEmail({ ...req.body, attachments, user: req.user });
        inboxEvents.publish();
        return res.status(result.created ? 201 : 200).json(result);
      } catch (error) { return next(error); }
    },
    async createOutbound(req, res, next) {
      try {
        const result = await createOutboundConversation({ ...req.body, user: req.user, channel });
        inboxEvents.publish();
        return res.status(result.created ? 201 : 200).json(result);
      } catch (error) { return next(error); }
    },
    async replyTemplate(req, res, next) {
      try {
        authorization.assertCanManageCampaigns(req.user);
        await authorization.assertCanActOnConversation(req.user, req.params.id);
        const name = String(req.body.name || "").trim();
        const language = String(req.body.language || "").trim();
        if (!name || !language) return res.status(400).json({ error: "Selecione um template e seu idioma." });
        const result = await sendApprovedTemplate({
          conversationId: req.params.id, name, language,
          values: req.body.values && typeof req.body.values === "object" ? req.body.values : {},
          sentByUserId: req.user.id, channel,
        });
        inboxEvents.publish();
        return res.status(201).json(result.message);
      } catch (error) { return next(error); }
    },
    async summary(req, res, next) {
      try { return res.json(await inbox.getConversationSummary(req.user)); }
      catch (error) { return next(error); }
    },
    async alerts(req, res, next) {
      try { return res.json(await inbox.getUserAlerts(req.query, req.user)); }
      catch (error) { return next(error); }
    },
    async update(req, res, next) {
      try {
        const conversation = await inbox.updateConversation(req.params.id, req.body, req.user);
        inboxEvents.publish();
        return res.json(conversation);
      }
      catch (error) { return next(error); }
    },
async signalTransfer(req, res, next) {
  try {
    const conversation = await authorization.assertCanActOnConversation(
      req.user,
      req.params.id
    );

    const toCategoryId = String(
      req.body.toCategoryId || ""
    ).trim();

    if (!toCategoryId) {
      return res.status(400).json({
        error: "Selecione o setor que deseja sinalizar.",
      });
    }

    const destinations = await inbox.listTransferCategories(req.params.id, req.user);
    if (!destinations.some((category) => category.id === toCategoryId && category.selectable !== false)) {
      throw authorization.forbidden(
        "O setor selecionado não está disponível para esta conversa."
      );
    }

    const message = await internalChat.createTransferNotice({
      conversationId: req.params.id,
      fromCategoryId: conversation.categoryId,
      toCategoryId,
      actorUserId: req.user.id,
      note: null,
    });

    if (!message) {
      return res.status(404).json({
        error: "Não foi possível localizar o chat interno desse setor.",
      });
    }

    inboxEvents.publish();

    return res.status(201).json(message);
  } catch (error) {
    return next(error);
  }
},
    async deleteConversation(req, res, next) {
      try {
        const result = await inbox.deleteConversation(req.params.id, req.user);
        inboxEvents.publish();
        return res.json(result);
      } catch (error) { return next(error); }
    },
    async setEmailSpamStatus(req, res, next) {
      try {
        const result = await inbox.setEmailSpamStatus(req.params.id, req.body || {}, req.user);
        inboxEvents.publish();
        return res.json(result);
      } catch (error) { return next(error); }
    },
    async claim(req, res, next) {
      try {
        const conversation = await inbox.updateConversation(req.params.id, {
          assignedUserId: req.user.id,
        }, req.user);
        inboxEvents.publish();
        return res.json(conversation);
      } catch (error) { return next(error); }
    },
    async pinConversation(req, res, next) {
      try {
        const result = await inbox.setConversationPinned(req.params.id, req.body, req.user);
        inboxEvents.publish();
        return res.json(result);
      } catch (error) { return next(error); }
    },
    async read(req, res, next) {
      try {
        await authorization.assertCanViewConversation(req.user, req.params.id);
        const result = await inbox.markAsRead(req.params.id, {
  channel,
  viewer: req.user,
});
        inboxEvents.publish();
        return res.json(result);
      }
      catch (error) { return next(error); }
    },
    async reply(req, res, next) {
      const text = req.body.text?.trim();
      if (!text) return res.status(400).json({ error: "Mensagem é obrigatória." });
      try {
        await authorization.assertCanActOnConversation(req.user, req.params.id);
        const result = await sendText({ conversationId: req.params.id, text, sentByUserId: req.user.id, channel });
        inboxEvents.publish();
        return res.status(201).json(result.message);
      } catch (error) { return next(error); }
    },
    async replyImage(req, res, next) {
      if (!req.file) return res.status(400).json({ error: "Selecione uma imagem JPG ou PNG." });
      try {
        await authorization.assertCanActOnConversation(req.user, req.params.id);
        const result = await sendImage({
          conversationId: req.params.id, buffer: req.file.buffer,
          mimeType: req.file.mimetype, fileName: req.file.originalname,
          caption: req.body.caption, sentByUserId: req.user.id, channel,
        });
        inboxEvents.publish();
        return res.status(201).json(result.message);
      } catch (error) { return next(error); }
    },
    async replyVideo(req, res, next) {
      if (!req.file) return res.status(400).json({ error: "Selecione um vídeo MP4 ou 3GP." });
      try {
        await authorization.assertCanActOnConversation(req.user, req.params.id);
        const result = await sendVideo({
          conversationId: req.params.id, buffer: req.file.buffer,
          mimeType: req.file.mimetype, fileName: req.file.originalname,
          caption: req.body.caption, sentByUserId: req.user.id, channel,
        });
        inboxEvents.publish();
        return res.status(201).json(result.message);
      } catch (error) { return next(error); }
    },
    async replyDocument(req, res, next) {
      if (!req.file) return res.status(400).json({ error: "Selecione um documento." });
      try {
        await authorization.assertCanActOnConversation(req.user, req.params.id);
        const result = await sendDocument({
          conversationId: req.params.id, buffer: req.file.buffer,
          mimeType: req.file.mimetype, fileName: req.file.originalname,
          caption: req.body.caption, sentByUserId: req.user.id, channel,
        });
        inboxEvents.publish();
        return res.status(201).json(result.message);
      } catch (error) { return next(error); }
    },
    async finalize(req, res, next) {
      try {
        await authorization.assertCanActOnConversation(req.user, req.params.id);
        const result = await finalizeConversation({
          conversationId: req.params.id, sentByUserId: req.user.id, channel,
        });
        if (!result.alreadyFinalized) await inbox.recordConversationActivity({
          conversationId: req.params.id, actorUserId: req.user.id,
          action: "STATUS_CHANGED", details: { from: result.previousStatus, to: "FINALIZADO" },
        });
        inboxEvents.publish();
        if (!result.alreadyFinalized) analyzeConversation(req.params.id).catch(() => {});
        return res.json(result);
      } catch (error) { return next(error); }
    },
    async moderateComment(req, res, next) {
      try {
        const result = await moderateMessage({ messageId: req.params.messageId, action: req.body.action, actor: req.user });
        inboxEvents.publish();
        return res.json(result);
      } catch (error) { return next(error); }
    },
    async botFeedback(req, res, next) {
      try {
        await authorization.assertCanActOnConversation(req.user, req.params.id);
        return res.status(201).json(await submitAgentFeedback(req.params.id, req.body, req.user));
      } catch (error) { return next(error); }
    },
    async media(req, res, next) {
      try {
        // Acesso à conversa + mensagem dentro do histórico visível do usuário
        // (anexo de etapa oculta não é servido nem para quem sabe o ID).
        const message = await inbox.assertCanViewMessage(req.user, req.params.messageId);
        if (!message.mediaStorageKey) return res.status(404).json({ error: "Mídia não encontrada." });
        res.set({
          "Content-Type": message.mediaMimeType,
          "Content-Disposition": `inline; filename="${encodeURIComponent(message.mediaFileName || "midia")}"`,
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        });
        return res.sendFile(resolveMedia(message.mediaStorageKey));
      } catch (error) { return next(error); }
    },
    async categories(req, res, next) {
      try { return res.json(await inbox.listCategories(req.user)); }
      catch (error) { return next(error); }
    },
    async categoryVisibility(req, res, next) {
      try { return res.json(await inbox.getCategoryVisibility(req.user)); }
      catch (error) { return next(error); }
    },
    async updateCategoryVisibility(req, res, next) {
      try { return res.json(await inbox.setCategoryVisibility(req.body, req.user)); }
      catch (error) { return next(error); }
    },
    async createCategory(req, res, next) {
      try {
        const category = await inbox.createCategory(req.body, req.user);
        inboxEvents.publish();
        return res.status(201).json(category);
      } catch (error) { return next(error); }
    },
    async updateCategory(req, res, next) {
      try {
        const category = await inbox.updateCategory(req.params.id, req.body, req.user);
        inboxEvents.publish();
        return res.json(category);
      }
      catch (error) { return next(error); }
    },
    async addNote(req, res, next) {
      try {
        const note = await inbox.addContactNote(req.params.contactId, { ...req.body, authorId: req.user.id }, req.user);
        inboxEvents.publish();
        return res.status(201).json(note);
      } catch (error) { return next(error); }
    },
    async pinNote(req, res, next) {
      try {
        const note = await inbox.setContactNotePinned(req.params.contactId, req.params.noteId, req.body, req.user);
        inboxEvents.publish();
        return res.json(note);
      } catch (error) { return next(error); }
    },
    async deleteNote(req, res, next) {
      try {
        const result = await inbox.deleteContactNote(req.params.contactId, req.params.noteId, req.body, req.user);
        inboxEvents.publish();
        return res.json(result);
      } catch (error) { return next(error); }
    },
async updateContactName(req, res, next) {
  try {
    const contact = await inbox.updateContactCustomName(
      req.params.contactId,
      req.body.customName,
      req.user
    );

    inboxEvents.publish();

    return res.json(contact);
  } catch (error) {
    return next(error);
  }
    },
    async users(req, res, next) {
      try { return res.json(await inbox.listUsers(req.user)); }
      catch (error) { return next(error); }
    },
  };
}

module.exports = { createInboxController };
