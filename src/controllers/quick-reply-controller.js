const quickReplies = require("../services/quick-reply-service");
const { resolveMedia } = require("../services/media-storage-service");

module.exports = {
  async list(req, res, next) {
    try { return res.json(await quickReplies.listQuickReplies(req.query, req.user)); }
    catch (error) { return next(error); }
  },

  async detail(req, res, next) {
    try { return res.json(await quickReplies.getQuickReply(req.params.id, req.user)); }
    catch (error) { return next(error); }
  },

  async create(req, res, next) {
    try { return res.status(201).json(await quickReplies.createQuickReply(req.body, req.user)); }
    catch (error) { return next(error); }
  },

  async update(req, res, next) {
    try { return res.json(await quickReplies.updateQuickReply(req.params.id, req.body, req.user)); }
    catch (error) { return next(error); }
  },

  async archive(req, res, next) {
    try { return res.json(await quickReplies.archiveQuickReply(req.params.id, req.user)); }
    catch (error) { return next(error); }
  },

  async preview(req, res, next) {
    try { return res.json(quickReplies.previewQuickReplyText(req.body.text || "", req.user)); }
    catch (error) { return next(error); }
  },

  async createPersonalAudio(req, res, next) {
    try { return res.status(201).json(await quickReplies.createPersonalAudio(req.body, req.file, req.user)); }
    catch (error) { return next(error); }
  },

  async updatePersonalAudio(req, res, next) {
    try { return res.json(await quickReplies.updatePersonalAudio(req.params.id, req.body, req.file, req.user)); }
    catch (error) { return next(error); }
  },

  async deletePersonalAudio(req, res, next) {
    try { return res.json(await quickReplies.deletePersonalAudio(req.params.id, req.user)); }
    catch (error) { return next(error); }
  },

  async audio(req, res, next) {
    try {
      const audio = await quickReplies.getQuickReplyAudio(req.params.id, req.user);
      res.set({
        "Content-Type": audio.mimeType,
        "Content-Disposition": `inline; filename="${encodeURIComponent(audio.fileName || "audio")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      return res.sendFile(resolveMedia(audio.storageKey));
    } catch (error) { return next(error); }
  },

  // Seletor do composer (item 7/10) — qualquer atendente autenticado.
  async listForComposer(req, res, next) {
    try { return res.json(await quickReplies.listForComposer(req.query, req.user)); }
    catch (error) { return next(error); }
  },

  async suggestions(req, res, next) {
    try { return res.json(await quickReplies.listSuggestions(req.query, req.user)); }
    catch (error) { return next(error); }
  },

  async setFavorite(req, res, next) {
    try {
      return res.json(await quickReplies.setFavorite(req.params.id, {
        conversationId: req.body.conversationId, favorite: req.body.favorite,
      }, req.user));
    } catch (error) { return next(error); }
  },

  // Nunca envia mensagem — só resolve variáveis e registra o uso (item 8/12/28).
  async use(req, res, next) {
    try {
      return res.json(await quickReplies.useQuickReply(
        req.params.id, { conversationId: req.body.conversationId }, req.user, { source: "AGENT" },
      ));
    } catch (error) { return next(error); }
  },
};
