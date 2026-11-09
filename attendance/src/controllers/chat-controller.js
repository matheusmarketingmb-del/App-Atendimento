const chat = require("../services/chat-message-service");
const features = require("../services/chat-features");
const library = require("../services/media-library-service");
const inboxEvents = require("../realtime/inbox-events");
const authorization = require("../services/authorization-service");
const { resolveMedia } = require("../services/media-storage-service");
const prisma = require("../database/prisma");

async function publishForMessage(messageId) {
  const message = await prisma.message.findUnique({ where: { id: messageId }, select: { conversationId: true } });
  if (message) inboxEvents.publishForConversation(message.conversationId);
}

const handle = (action) => async (req, res, next) => {
  try { return await action(req, res); } catch (error) { return next(error); }
};

function createChatController(channel) {
  return {
    features: handle((_req, res) => res.json(features.publicFeatures())),

    react: handle(async (req, res) => {
      const result = await chat.reactToMessage({ messageId: req.params.messageId, emoji: req.body?.emoji, viewer: req.user, channel });
      await publishForMessage(req.params.messageId);
      return res.json({ status: result.status || "ACCEPTED", emoji: result.emoji ?? "" });
    }),

    star: handle(async (req, res) => res.json(await chat.setStar({ messageId: req.params.messageId, starred: req.body?.starred === true, viewer: req.user }))),
    stars: handle(async (req, res) => res.json(await chat.listStars({ conversationId: req.params.id, viewer: req.user }))),

    pin: handle(async (req, res) => {
      const result = await chat.setPin({ messageId: req.params.messageId, pinned: req.body?.pinned === true, viewer: req.user });
      await publishForMessage(req.params.messageId);
      return res.json(result);
    }),
    pins: handle(async (req, res) => res.json(await chat.listPins({ conversationId: req.params.id, viewer: req.user }))),

    search: handle(async (req, res) => res.json(await chat.searchMessages({ conversationId: req.params.id, viewer: req.user, ...req.query }))),
    locate: handle(async (req, res) => res.json(await chat.locateMessage({ conversationId: req.params.id, messageId: req.params.messageId, viewer: req.user }))),
    context: handle(async (req, res) => res.json(await chat.messageContext({ conversationId: req.params.id, messageId: req.params.messageId, viewer: req.user }))),

    forward: handle(async (req, res) => {
      const result = await chat.forwardMessage({
        messageId: req.params.messageId, targetConversationId: req.body?.targetConversationId, confirmed: req.body?.confirmed,
        requestId: req.body?.clientRequestId, viewer: req.user, channel,
      });
      inboxEvents.publishForConversation(req.body.targetConversationId);
      return res.status(201).json(result.message);
    }),

    libraryList: handle(async (req, res) => res.json(await library.listAssets(req.user, req.query))),
    libraryUpload: handle(async (req, res) => {
      const asset = await library.uploadAsset(req.user, { ...req.body, file: req.file });
      return res.status(201).json({ id: asset.id, converted: Boolean(asset.converted) });
    }),
    libraryFavorite: handle(async (req, res) => res.json(await library.setFavorite(req.user, req.params.assetId, req.body?.favorite === true))),
    libraryRemove: handle(async (req, res) => res.json(await library.removeAsset(req.user, req.params.assetId))),
    libraryFile: handle(async (req, res) => {
      const asset = await library.loadVisibleAsset(req.user, req.params.assetId);
      res.set({ "Content-Type": asset.mimeType, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" });
      return res.sendFile(resolveMedia(asset.storageKey));
    }),
    saveSticker: handle(async (req, res) => {
      const asset = await library.saveStickerFromMessage(req.user, { ...req.body, messageId: req.params.messageId });
      return res.status(201).json({ id: asset.id });
    }),
    sendAsset: handle(async (req, res) => {
      if (typeof req.body?.clientRequestId !== "string") throw Object.assign(new Error("Atualize a Central antes de enviar pela biblioteca."), { statusCode: 400 });
      await authorization.assertCanActOnConversation(req.user, req.params.id);
      const replyTo = await chat.resolveReplyTarget(req.user, req.params.id, req.body?.replyToMessageId);
      const result = await require("../services/outbound-text-request-service").sendOnce({
        client: prisma, userId: req.user.id, conversationId: req.params.id, requestId: req.body.clientRequestId,
        text: JSON.stringify(["library", req.body?.assetId, Boolean(req.body?.confirmedVideo)]), replyToMessageId: req.body?.replyToMessageId,
        send: beforeProviderSend => library.sendAsset({
          user: req.user, conversationId: req.params.id, assetId: req.body?.assetId, replyTo, channel, confirmedVideo: req.body?.confirmedVideo, beforeProviderSend,
        }),
      });
      inboxEvents.publishForConversation(req.params.id);
      return res.status(201).json(result.message);
    }),
  };
}

module.exports = { createChatController };
