// Endpoints da IA local (LOCAL_QWEN): status em tempo real (para o badge na
// UI) e configuração global do provider (host/porta/modelo/timeout/
// concorrência). Nunca expõe nada além do necessário — baseUrl aparece
// porque não é segredo (endereço de rede privada), mas continua restrito a
// Master (ver local-ai-settings-service.js#assertMaster).
const localAiSettingsService = require("../services/local-ai-settings-service");
const localAiStatusService = require("../services/local-ai-status-service");
const localAiQueue = require("../services/local-ai-queue");

async function getStatus(req, res, next) {
  try {
    const state = localAiStatusService.getState();
    res.json({ ...state, queueDepth: localAiQueue.queueDepth(), running: localAiQueue.runningCount() });
  } catch (error) { next(error); }
}

async function getSettings(req, res, next) {
  try {
    const settings = await localAiSettingsService.getSettings();
    res.json(localAiSettingsService.toPublicView(settings));
  } catch (error) { next(error); }
}

async function updateSettings(req, res, next) {
  try {
    const updated = await localAiSettingsService.updateSettings(req.body || {}, req.user);
    res.json(localAiSettingsService.toPublicView(updated));
  } catch (error) { next(error); }
}

async function checkNow(req, res, next) {
  try {
    const state = await localAiStatusService.checkOnce();
    res.json(state);
  } catch (error) { next(error); }
}

module.exports = { getStatus, getSettings, updateSettings, checkNow };
