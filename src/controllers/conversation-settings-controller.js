// Configurações → Conversas — controller fino, mirror de integrations-controller.js.
// O relatório semanal que vivia aqui (weeklyReport) foi substituído pelo
// Relatório de Conversas completo — ver conversation-report-controller.js e
// public/relatorio-conversas.html.
const settingsService = require("../services/conversation-settings-service");

module.exports = {
  async getSettings(req, res, next) {
    try { return res.json(await settingsService.getConversationSettingsForViewer(req.user)); }
    catch (error) { return next(error); }
  },

  async updateSettings(req, res, next) {
    try { return res.json(await settingsService.updateConversationSettings(req.body, req.user)); }
    catch (error) { return next(error); }
  },
};
