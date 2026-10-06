const bots = require("../services/bot-service");
const governance = require("../services/bot-governance-service");
const pause = require("../services/bot-pause-service");
const responses = require("../services/bot-response-library-service");
const webhooks = require("../services/bot-webhook-endpoint-service");

// Bots = Flow Builder. Toda regra de permissão (só Master) fica nos
// serviços — o controller só repassa. O controller do modelo antigo
// (intenções, IA, Knowledge, observação, aprendizado...) está em
// _archive/bot-legacy/code/src/controllers/bot-controller.js.
function handle(fn, status = 200) {
  return async (req, res, next) => {
    try { return res.status(status).json(await fn(req)); }
    catch (error) { return next(error); }
  };
}

module.exports = {
  observation: handle((req) => require("../services/bot-question-answer-observation").observation(req.params.botId, req.user)),
  list: handle((req) => bots.listBots(req.user, { company: req.query.company })),
  create: handle((req) => bots.createBot(req.body || {}, req.user), 201),
  detail: handle((req) => bots.getBot(req.params.botId, req.user)),
  update: handle((req) => bots.updateBot(req.params.botId, req.body || {}, req.user)),
  status: handle((req) => bots.setBotStatus(req.params.botId, req.body?.status, req.user)),
  autoReply: handle((req) => bots.setAutoReply(req.params.botId, req.body?.enabled, req.user)),
  archive: handle((req) => bots.archiveBot(req.params.botId, req.user)),
  schedules: handle((req) => bots.replaceSchedules(req.params.botId, req.body?.schedules, req.user)),
  holidays: handle((req) => bots.replaceHolidays(req.params.botId, req.body?.holidays, req.user)),
  legacyBots: handle((req) => bots.listLegacyBots(req.user)),

  globalSettings: handle((req) => governance.getGlobalSettingsForManager(req.user)),
  activateKillSwitch: handle((req) => governance.deactivateAutomation(req.user)),
  deactivateKillSwitch: handle((req) => governance.reactivateAutomation(req.user)),

  // "Cancelar Bot"/"Retomar Bot" da Central (qualquer atendente com acesso
  // à conversa — validado no serviço).
  pauseBot: handle((req) => pause.pauseBot(req.params.conversationId, req.user)),
  resumeBot: handle((req) => pause.resumeBot(req.params.conversationId, req.user)),

  listResponses: handle((req) => responses.listResponses(req.user, { company: req.query.company })),
  createResponse: handle((req) => responses.createResponse(req.body || {}, req.user), 201),
  updateResponse: handle((req) => responses.updateResponse(req.params.responseId, req.body || {}, req.user)),
  deleteResponse: handle((req) => responses.deleteResponse(req.params.responseId, req.user)),

  listWebhooks: handle((req) => webhooks.listEndpoints(req.user)),
  createWebhook: handle((req) => webhooks.createEndpoint(req.body || {}, req.user), 201),
  updateWebhook: handle((req) => webhooks.updateEndpoint(req.params.endpointId, req.body || {}, req.user)),
  deleteWebhook: handle((req) => webhooks.deleteEndpoint(req.params.endpointId, req.user)),
};
