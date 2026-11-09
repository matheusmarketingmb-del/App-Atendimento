const prisma = require("../database/prisma");
const { conversionFormat, convertOutgoingMedia } = require('../services/media-conversion-service');

const chatMessages = require('../services/chat-message-service');
const replyTarget = (req) => chatMessages.resolveReplyTarget(req.user, req.params.id, req.body?.replyToMessageId);

async function prepareTeamAttachment(req, kind) {
  await authorization.assertCanActOnConversation(req.user, req.params.id);
  const media = { buffer: req.file.buffer, mimeType: req.file.mimetype, fileName: req.file.originalname };
  if (!conversionFormat(media.buffer, kind)) return media;
  const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, select: { channel: true, channelAccountId: true } });
  if (conversation?.channel !== 'META') throw Object.assign(new Error('A conversão destes formatos está disponível apenas no WhatsApp.'), { statusCode: 400 });
  await require('../services/meta-template-service').assertFreeFormAllowed(req.params.id, new Date(), conversation.channelAccountId);
  const converted = await convertOutgoingMedia({ ...media, kind });
  // Uma transferência/revogação durante a conversão não autoriza o envio.
  await authorization.assertCanActOnConversation(req.user, req.params.id);
  return converted;
}
const inbox = require("../services/inbox-service");
const { resolveMedia } = require("../services/media-storage-service");
const { finalizeConversation, sendAudio, sendDocument, sendImage, sendText, sendVideo } = require("../services/message-service");
const inboxEvents = require("../realtime/inbox-events");
const authorization = require("../services/authorization-service");
const whatsappAccounts = require("../services/whatsapp-account-service");
const internalChat = require("../services/internal-chat-service");
const { customerServiceWindowFrom, getCustomerServiceWindow, listApprovedTemplates, sendApprovedTemplate, templatesConfigured } = require("../services/meta-template-service");
const { createOutboundConversation, createOutboundEmail, listOutboundChannels } = require("../services/outbound-conversation-service");
const { submitAgentFeedback } = require("../services/bot-agent-feedback-service");
const { Channel: ChannelEnum } = require("@prisma/client");
const contactMerge = require("../services/contact-merge-service");
const channelMessageService = require("../services/channels/channel-message-service");
const whatsappInbox = require("../services/whatsapp-inbox-service");
const preferredAssignees = require("../services/preferred-assignee-service");
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
    async workspaceUnread(req, res, next) {
      try { return res.json(await inbox.getWorkspaceUnread(req.user)); }
      catch (error) { return next(error); }
    },
    async search(req, res, next) {
      try { return res.json(await inbox.searchConversations(req.query.q, req.user, { company: req.query.company })); }
      catch (error) { return next(error); }
    },
    async detail(req, res, next) {
      try {
        const conversation = await inbox.getConversation(req.params.id, req.user,require("../services/inbox-pagination").historyOptions(req.query));
        if (!conversation) return res.status(404).json({ error: "Conversa não encontrada." });
        const sender = conversation.channel === "META" && conversation.contact.whatsappInboxId ? await whatsappInbox.senderState(conversation, req.user) : null;
        const customerServiceWindow = conversation.channel === "META"
          ? (sender && !sender.account ? customerServiceWindowFrom(null, new Date(), true) : await getCustomerServiceWindow(conversation.id, new Date(), sender ? (sender.account.config?.isLegacyWhatsApp ? null : sender.account.id) : undefined))
          : customerServiceWindowFrom(null, new Date(), false);
        const mergedDestinations = await contactMerge.getMergedDestinations(conversation.contact.id, req.user);
        const channelCaps = channelCapabilities(conversation.channel);
        // Item 10 do plano Social — comentário nunca chega "pelado": quando
        // há mapeamento manual cadastrado (Integrações > Publicações), o
        // painel de contexto mostra a publicação/produto relacionado.
        const postContext = SOCIAL_COMMENT_CHANNELS.has(conversation.channel) && conversation.externalConversationId
          ? await resolveForPost(conversation.channel, conversation.externalConversationId)
          : null;
        // Atendente fixo do cliente (somente leitura para quem não gerencia).
        const preferredAssignee = await preferredAssignees.getPreferredAssignee(conversation.contact.id, req.user).catch(() => null);

        const transferCategories = conversation.archivedAt || conversation.accessMode === "SUPERVISION"
          ? [] : await inbox.listTransferCategories(conversation.id, req.user);
        const whatsappSender = sender ? { selectedId: sender.selectedId, options: sender.options, reason: sender.reason } : null;
        if (sender && !sender.account) customerServiceWindow.state = "SENDER_UNAVAILABLE";
        customerServiceWindow.senderName = sender?.options.find(option => option.id === sender.selectedId)?.name || conversation.channelAccount?.name || "WhatsApp principal";
        const pinnedMessages = await chatMessages.pinsForConversation(conversation.id, req.user);
        return res.json({ ...conversation, whatsappSender, customerServiceWindow, mergedDestinations, channelCapabilities: channelCaps, postContext, transferCategories, preferredAssignee, pinnedMessages });
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
    // Multiempresa: templates da WABA do número da conversa (?conversationId)
    // ou do número escolhido (?channelAccountId) — nunca de outra empresa.
    async templates(req, res, next) {
      try {
        let providerChannel = channel;
        if (req.query.conversationId) {
          await authorization.assertCanActOnConversation(req.user, req.query.conversationId);
          const conversation = await prisma.conversation.findUnique({ where: { id: req.query.conversationId } });
          await require("../services/campaign-service").assertCampaignCompanyPermission(req.user, conversation.companyId);
          await whatsappInbox.applySender(conversation, req.user.id);
          if (conversation?.channelAccountId) providerChannel = (await channelMessageService.adapterFor("META", conversation.channelAccountId)).channel;
        } else if ((req.query.channelAccountId || req.query.accountId) && (req.query.channelAccountId || req.query.accountId) !== "legacy") {
          const accountId = req.query.channelAccountId || req.query.accountId;
          if (!(await authorization.canAccessChannelAccount(req.user, accountId))) throw authorization.forbidden("Você não tem acesso a este número.");
          const account = await whatsappAccounts.resolveAccountForUser(req.user, { channelAccountId: accountId });
          await require("../services/campaign-service").assertCampaignCompanyPermission(req.user, account.companyId);
          providerChannel = (await channelMessageService.adapterFor("META", accountId)).channel;
        } else {
          const account = await whatsappAccounts.getLegacyAccount();
          if (!account || !(await authorization.canAccessChannelAccount(req.user, account.id))) throw authorization.forbidden("Você não tem acesso a este número.");
          await require("../services/campaign-service").assertCampaignCompanyPermission(req.user, account.companyId);
        }
        return res.json(await listApprovedTemplates(providerChannel));
      } catch (error) { return next(error); }
    },
    async metaStatus(req, res, next) {
      try {
        const accounts = await whatsappAccounts.listAccountsForUser(req.user);
        return res.json({ templatesConfigured: accounts.some((account) => account.templatesConfigured) });
      } catch (error) { return next(error); }
    },
    // Números de WhatsApp (e empresa de cada um) acessíveis ao usuário.
    async whatsappAccounts(req, res, next) {
      try { return res.json(await whatsappAccounts.listAccountsForUser(req.user, { company: req.query.company || null })); }
      catch (error) { return next(error); }
    },
    async outboundChannels(req, res, next) {
      try { return res.json(await listOutboundChannels(req.user, { company: await require("../services/company-service").resolveWorkspace(req.user, req.query.company) })); }
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
        const company = await require("../services/company-service").resolveWorkspace(req.user, req.body.company);
        const result = await createOutboundConversation({ ...req.body, company, user: req.user, channel });
        inboxEvents.publish();
        return res.status(result.created ? 201 : 200).json(result);
      } catch (error) { return next(error); }
    },
    async replyTemplate(req, res, next) {
      try {
        await authorization.assertCanActOnConversation(req.user, req.params.id);
        const conversation = await prisma.conversation.findUnique({ where: { id: req.params.id }, select: { companyId: true } });
        await require("../services/campaign-service").assertCampaignCompanyPermission(req.user, conversation.companyId);
        const name = String(req.body.name || "").trim();
        const language = String(req.body.language || "").trim();
        if (!name || !language) return res.status(400).json({ error: "Selecione um template e seu idioma." });
        const result = await sendApprovedTemplate({
          conversationId: req.params.id, name, language,
          values: req.body.values && typeof req.body.values === "object" ? req.body.values : {},
          sentByUserId: req.user.id, channel,
        });
        inboxEvents.publishForConversation(req.params.id);
        return res.status(201).json(result.message);
      } catch (error) { return next(error); }
    },
    async summary(req, res, next) {
      try { return res.json(await (req.query.sidebar==='true'?inbox.getSidebarSummary:inbox.getConversationSummary)(req.user, { company: req.query.company,excludeMarketplaces:req.query.excludeMarketplaces })); }
      catch (error) { return next(error); }
    },
    async alerts(req, res, next) {
      try { return res.json(await inbox.getUserAlerts(req.query, req.user)); }
      catch (error) { return next(error); }
    },
    async update(req, res, next) {
      try {
        const conversation = await inbox.updateConversation(req.params.id, req.body, req.user);
        inboxEvents.publishForConversation(req.params.id);
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

    // Chat do setor (empresa da categoria): aviso direcionado com companyId.
    const audience = await internalChat.chatAudience(message.chatId);
    inboxEvents.publishToUsers(audience.userIds, "internal-chat.updated", { chatId: message.chatId, companyId: audience.companyId, kind: "message" });
    inboxEvents.publish();

    return res.status(201).json(message);
  } catch (error) {
    return next(error);
  }
},
    async deleteConversation(req, res, next) {
      try {
        const result = await inbox.deleteConversation(req.params.id, req.user);
        inboxEvents.publishForConversation(req.params.id);
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
        inboxEvents.publishForConversation(req.params.id);
        return res.json(conversation);
      } catch (error) { return next(error); }
    },
    async pinConversation(req, res, next) {
      try {
        const result = await inbox.setConversationPinned(req.params.id, req.body, req.user);
        inboxEvents.publishForConversation(req.params.id);
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
        const { changed, ...body } = result;
        if (changed !== false) inboxEvents.publishForConversation(req.params.id);
        return res.json(body);
      }
      catch (error) { return next(error); }
    },
    async reply(req, res, next) {
      const text = req.body.text?.trim();
      if (!text) return res.status(400).json({ error: "Mensagem é obrigatória." });
      try {
        await authorization.assertCanActOnConversation(req.user, req.params.id);
        const crmProposal=req.body.crmProposalDraft?await require('../services/crm-proposal-service').validateForMessage(req.user,req.body.crmProposalDraft,req.params.id):null;
        const replyTo = await replyTarget(req);
        const result = await require('../services/outbound-text-request-service').sendOnce({
          client: prisma, userId: req.user.id, conversationId: req.params.id,
          requestId: req.body.clientRequestId, text, crmProposal, replyToMessageId: replyTo?.id,
          send: beforeProviderSend => sendText({ conversationId: req.params.id, text, sentByUserId: req.user.id, channel, beforeProviderSend,replyTo,...(crmProposal?{crmProposal}:{}) }),
        });
        inboxEvents.publishForConversation(req.params.id);
        return res.status(201).json(result.message);
      } catch (error) { return next(error); }
    },
    async replyImage(req, res, next) {
      if (!req.file) return res.status(400).json({ error: "Selecione uma imagem JPG ou PNG." });
      try {
        const media = await prepareTeamAttachment(req, 'image');
        const replyTo = await replyTarget(req);
        const result = await (media.mimeType==='video/mp4'?sendVideo:sendImage)({
          conversationId: req.params.id, ...media, replyTo,
          caption: req.body.caption, sentByUserId: req.user.id, channel,
        });
        inboxEvents.publishForConversation(req.params.id);
        return res.status(201).json(result.message);
      } catch (error) { return next(error); }
    },
    async replyVideo(req, res, next) {
      if (!req.file) return res.status(400).json({ error: "Selecione um vídeo MP4 ou 3GP." });
      try {
        const media = await prepareTeamAttachment(req, 'video');
        const replyTo = await replyTarget(req);
        const result = await sendVideo({
          conversationId: req.params.id, ...media, replyTo,
          caption: req.body.caption, sentByUserId: req.user.id, channel,
        });
        inboxEvents.publishForConversation(req.params.id);
        return res.status(201).json(result.message);
      } catch (error) { return next(error); }
    },
    async replyAudio(req, res, next) {
      if (!req.file) return res.status(400).json({ error: "Selecione ou grave um áudio." });
      try {
        const media = await prepareTeamAttachment(req, 'audio');
        const replyTo = await replyTarget(req);
        const result = await sendAudio({
          conversationId: req.params.id, ...media, replyTo,
          durationMs: req.body.durationMs, sentByUserId: req.user.id, channel,
        });
        inboxEvents.publishForConversation(req.params.id);
        return res.status(201).json(result.message);
      } catch (error) { return next(error); }
    },
    async replyDocument(req, res, next) {
      if (!req.file) return res.status(400).json({ error: "Selecione um documento." });
      try {
        const media=await prepareTeamAttachment(req,'document');
        const replyTo = await replyTarget(req);
        const result = await sendDocument({
          conversationId: req.params.id, ...media, replyTo,
          caption: req.body.caption, sentByUserId: req.user.id, channel,
        });
        inboxEvents.publishForConversation(req.params.id);
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
        inboxEvents.publishForConversation(req.params.id);
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
      try { return res.json(await inbox.listCategories(req.user, { company: req.query.company })); }
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
