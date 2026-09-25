const flows = require("../services/bot-visual-flow-service");

// Toda regra de permissão (só Master) fica no serviço — o controller só
// repassa, igual a bot-controller.js.
function handle(fn) {
  return async (req, res, next) => {
    try { return res.json(await fn(req)); }
    catch (error) { return next(error); }
  };
}

module.exports = {
  list: handle((req) => flows.listFlows(req.params.botId, req.user)),
  options: handle((req) => flows.getEditorOptions(req.params.botId, req.user)),
  detail: handle((req) => flows.getFlow(req.params.botId, req.params.flowId, req.user)),
  async create(req, res, next) {
    try { return res.status(201).json(await flows.createFlow(req.params.botId, req.body || {}, req.user)); }
    catch (error) { return next(error); }
  },
  saveDraft: handle((req) => flows.saveDraft(req.params.botId, req.params.flowId, req.body || {}, req.user)),
  validate: handle((req) => flows.validateFlow(req.params.botId, req.params.flowId, req.body || {}, req.user)),
  publish: handle((req) => flows.publishFlow(req.params.botId, req.params.flowId, req.body || {}, req.user)),
  status: handle((req) => flows.setFlowStatus(req.params.botId, req.params.flowId, req.body?.status, req.user)),
  setDefault: handle((req) => flows.setDefaultFlow(req.params.botId, req.params.flowId, req.user)),
  archive: handle((req) => flows.archiveFlow(req.params.botId, req.params.flowId, req.user)),
  version: handle((req) => flows.getFlowVersion(req.params.botId, req.params.flowId, req.params.version, req.user)),
  rollback: handle((req) => flows.rollbackFlow(req.params.botId, req.params.flowId, req.params.version, req.user)),
  restoreToDraft: handle((req) => flows.restoreVersionToDraft(req.params.botId, req.params.flowId, req.params.version, req.user)),
  simulate: handle((req) => flows.simulateFlow(req.params.botId, req.params.flowId, req.body || {}, req.user)),
  executions: handle((req) => flows.listExecutions(req.params.botId, req.params.flowId, req.user)),
  executionLogs: handle((req) => flows.getExecutionLogs(req.params.botId, req.params.flowId, req.params.executionId, req.user)),
  executionMode: handle((req) => flows.setExecutionMode(req.params.botId, req.body?.executionMode, req.user)),
};
