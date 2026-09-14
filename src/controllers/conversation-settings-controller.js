// Configurações → Conversas — controller fino, mirror de integrations-controller.js.
const settingsService = require("../services/conversation-settings-service");
const reportService = require("../services/conversation-report-service");
const authorization = require("../services/authorization-service");

module.exports = {
  async getSettings(req, res, next) {
    try { return res.json(await settingsService.getConversationSettingsForViewer(req.user)); }
    catch (error) { return next(error); }
  },

  async updateSettings(req, res, next) {
    try { return res.json(await settingsService.updateConversationSettings(req.body, req.user)); }
    catch (error) { return next(error); }
  },

  // Relatório semanal (nova seção, só Master) — nunca visível/consultável
  // por Supervisor/Atendente, mesmo tendo acesso à tela de Configurações →
  // Conversas (essa tela hoje é Admin+Supervisor; este relatório é mais
  // restrito de propósito, expõe produtividade por pessoa).
  async weeklyReport(req, res, next) {
    try {
      if (!authorization.isMaster(req.user)) throw authorization.forbidden("Somente uma conta Master pode ver o relatório semanal de conversas.");
      const weekOffset = Number.parseInt(req.query.weekOffset, 10) || 0;
      return res.json(await reportService.buildConversationReport({ weekOffset }));
    } catch (error) { return next(error); }
  },
};
