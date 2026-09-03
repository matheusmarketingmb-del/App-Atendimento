const bots = require("../services/bot-service");
const learning = require("../services/bot-learning-service");
const governance = require("../services/bot-governance-service");
const versions = require("../services/bot-version-service");
const ratings = require("../services/bot-rating-service");
const knowledge = require("../services/bot-knowledge-source-service");
const globalIntents = require("../services/global-intent-service");
const handoff = require("../services/bot-handoff-service");
const toolRegistry = require("../services/bot-tools/tool-registry");
const aiProvider = require("../services/ai/get-ai-provider");
const aiUsage = require("../services/bot-ai-usage-service");
const authorization = require("../services/authorization-service");
const suggestions = require("../services/bot-suggestion-service");
const quality = require("../services/bot-quality-service");
const aiCredentials = require("../services/ai/ai-credential-service");
const personality = require("../services/bot-personality-service");

module.exports = {
  async list(req, res, next) {
    try { return res.json(await bots.listBots(req.user)); }
    catch (error) { return next(error); }
  },

  async detail(req, res, next) {
    try { return res.json(await bots.getBot(req.params.botId, req.user)); }
    catch (error) { return next(error); }
  },

  async allIntents(req, res, next) {
    try { return res.json(await bots.listAllIntents(req.user)); }
    catch (error) { return next(error); }
  },

  async create(req, res, next) {
    try { return res.status(201).json(await bots.createBot(req.body, req.user)); }
    catch (error) { return next(error); }
  },

  async update(req, res, next) {
    try { return res.json(await bots.updateBot(req.params.botId, req.body, req.user)); }
    catch (error) { return next(error); }
  },

  async status(req, res, next) {
    try { return res.json(await bots.updateBotStatus(req.params.botId, req.body.status, req.user)); }
    catch (error) { return next(error); }
  },

  async archive(req, res, next) {
    try { return res.json(await bots.archiveBot(req.params.botId, req.user)); }
    catch (error) { return next(error); }
  },

  async schedules(req, res, next) {
    try {
      const schedules = Array.isArray(req.body) ? req.body : req.body.schedules;
      return res.json(await bots.replaceSchedules(req.params.botId, schedules, req.user));
    } catch (error) { return next(error); }
  },

  async holidays(req, res, next) {
    try {
      const holidays = Array.isArray(req.body) ? req.body : req.body.holidays;
      return res.json(await bots.replaceHolidays(req.params.botId, holidays, req.user));
    } catch (error) { return next(error); }
  },

  async createIntent(req, res, next) {
    try { return res.status(201).json(await bots.createIntent(req.params.botId, req.body, req.user)); }
    catch (error) { return next(error); }
  },

  async updateIntent(req, res, next) {
    try {
      return res.json(await bots.updateIntent(
        req.params.botId,
        req.params.intentId,
        req.body,
        req.user,
      ));
    } catch (error) { return next(error); }
  },

  async deleteIntent(req, res, next) {
    try {
      return res.json(await bots.deleteIntent(
        req.params.botId,
        req.params.intentId,
        req.user,
      ));
    } catch (error) { return next(error); }
  },

  // Fluxo de atendimento (Flow Engine) — etapas de uma intenção.
  async listFlowSteps(req, res, next) {
    try { return res.json(await bots.listFlowSteps(req.params.botId, req.params.intentId, req.user)); }
    catch (error) { return next(error); }
  },
  async createFlowStep(req, res, next) {
    try { return res.status(201).json(await bots.createFlowStep(req.params.botId, req.params.intentId, req.body, req.user)); }
    catch (error) { return next(error); }
  },
  async updateFlowStep(req, res, next) {
    try {
      return res.json(await bots.updateFlowStep(req.params.botId, req.params.intentId, req.params.stepId, req.body, req.user));
    } catch (error) { return next(error); }
  },
  async deleteFlowStep(req, res, next) {
    try {
      return res.json(await bots.deleteFlowStep(req.params.botId, req.params.intentId, req.params.stepId, req.user));
    } catch (error) { return next(error); }
  },
  async reorderFlowSteps(req, res, next) {
    try {
      return res.json(await bots.reorderFlowSteps(req.params.botId, req.params.intentId, req.body.stepIds, req.user));
    } catch (error) { return next(error); }
  },

  async simulate(req, res, next) {
    try {
      return res.json(await bots.simulate(req.params.botId, req.body.message, req.user, {
        state: req.body.state, history: req.body.history, replyId: req.body.replyId,
      }));
    } catch (error) { return next(error); }
  },

  async triageOptions(req, res, next) {
    try {
      const options = Array.isArray(req.body) ? req.body : req.body.options;
      return res.json(await bots.replaceTriageOptions(req.params.botId, options, req.user));
    } catch (error) { return next(error); }
  },

  async observations(req, res, next) {
    try { return res.json(await bots.listObservations(req.query, req.user)); }
    catch (error) { return next(error); }
  },

  async observationMetrics(req, res, next) {
    try { return res.json(await bots.observationMetrics(req.user)); }
    catch (error) { return next(error); }
  },

  async observationFeedback(req, res, next) {
    try { return res.json(await bots.recordObservationFeedback(req.params.observationId, req.body, req.user)); }
    catch (error) { return next(error); }
  },

  async learningSuggestions(req, res, next) {
    try { return res.json(await learning.listSuggestions(req.query, req.user)); }
    catch (error) { return next(error); }
  },

  async learningMetrics(req, res, next) {
    try { return res.json(await learning.learningMetrics(req.user)); }
    catch (error) { return next(error); }
  },

  async approveLearningSuggestion(req, res, next) {
    try { return res.json(await learning.approveSuggestion(req.params.suggestionId, req.body, req.user)); }
    catch (error) { return next(error); }
  },

  async rejectLearningSuggestion(req, res, next) {
    try { return res.json(await learning.rejectSuggestion(req.params.suggestionId, req.user)); }
    catch (error) { return next(error); }
  },

  async editLearningSuggestion(req, res, next) {
    try { return res.json(await learning.editSuggestion(req.params.suggestionId, req.body, req.user)); }
    catch (error) { return next(error); }
  },

  async analyzeConversationForLearning(req, res, next) {
    try { return res.json(await learning.analyzeConversationManually(req.params.conversationId, req.user)); }
    catch (error) { return next(error); }
  },

  async intentConflicts(req, res, next) {
    try { return res.json(await bots.listIntentConflicts(req.params.botId, req.user)); }
    catch (error) { return next(error); }
  },

  async intentMetrics(req, res, next) {
    try { return res.json(await bots.intentMetrics(req.params.botId, req.user)); }
    catch (error) { return next(error); }
  },

  // Governança / configuração global.
  async globalSettings(req, res, next) {
    try { return res.json(await governance.getGlobalSettingsForManager(req.user)); }
    catch (error) { return next(error); }
  },
  async updateGlobalSettings(req, res, next) {
    try { return res.json(await governance.updateGlobalSettings(req.body, req.user)); }
    catch (error) { return next(error); }
  },
  async activateKillSwitch(req, res, next) {
    try { return res.json(await governance.deactivateAutomation(req.user)); }
    catch (error) { return next(error); }
  },
  async deactivateKillSwitch(req, res, next) {
    try { return res.json(await governance.reactivateAutomation(req.user)); }
    catch (error) { return next(error); }
  },

  // Versionamento.
  async listVersions(req, res, next) {
    try { return res.json(await versions.listVersions(req.params.botId, req.user)); }
    catch (error) { return next(error); }
  },
  async createVersion(req, res, next) {
    try { return res.status(201).json(await versions.createVersion(req.params.botId, req.body, req.user)); }
    catch (error) { return next(error); }
  },
  async previewRestoreVersion(req, res, next) {
    try { return res.json(await versions.previewRestore(req.params.botId, req.params.version, req.user)); }
    catch (error) { return next(error); }
  },
  async restoreVersion(req, res, next) {
    try { return res.json(await versions.restoreVersion(req.params.botId, req.params.version, req.body, req.user)); }
    catch (error) { return next(error); }
  },

  // Avaliação (ratings) e ranking.
  async submitRating(req, res, next) {
    try { return res.status(201).json(await ratings.submitRating(req.body, req.user)); }
    catch (error) { return next(error); }
  },
  async listRatings(req, res, next) {
    try { return res.json(await ratings.listRatings(req.query, req.user)); }
    catch (error) { return next(error); }
  },
  async ratingMetrics(req, res, next) {
    try { return res.json(await ratings.ratingMetrics(req.params.botId, req.query, req.user)); }
    catch (error) { return next(error); }
  },
  async ratingTimeSeries(req, res, next) {
    try { return res.json(await ratings.ratingTimeSeries(req.params.botId, req.query, req.user)); }
    catch (error) { return next(error); }
  },
  async observationTimeSeries(req, res, next) {
    try { return res.json(await ratings.observationTimeSeries(req.params.botId, req.query, req.user)); }
    catch (error) { return next(error); }
  },
  async updateRatingConfig(req, res, next) {
    try { return res.json(await ratings.updateRatingConfig(req.params.botId, req.body, req.user)); }
    catch (error) { return next(error); }
  },
  async ranking(req, res, next) {
    try { return res.json(await ratings.getRanking(req.user)); }
    catch (error) { return next(error); }
  },

  // Base de conhecimento (arquitetura-base).
  async listKnowledgeSources(req, res, next) {
    try { return res.json(await knowledge.listKnowledgeSources(req.query, req.user)); }
    catch (error) { return next(error); }
  },
  async createKnowledgeSource(req, res, next) {
    try { return res.status(201).json(await knowledge.createKnowledgeSource(req.body, req.user)); }
    catch (error) { return next(error); }
  },
  async updateKnowledgeSource(req, res, next) {
    try { return res.json(await knowledge.updateKnowledgeSource(req.params.sourceId, req.body, req.user)); }
    catch (error) { return next(error); }
  },
  async deleteKnowledgeSource(req, res, next) {
    try { return res.json(await knowledge.deleteKnowledgeSource(req.params.sourceId, req.user)); }
    catch (error) { return next(error); }
  },

  // Biblioteca Global de Intenções (item 1).
  async listGlobalIntents(req, res, next) {
    try { return res.json(await globalIntents.listGlobalIntents(req.user)); }
    catch (error) { return next(error); }
  },
  async createGlobalIntent(req, res, next) {
    try { return res.status(201).json(await globalIntents.createGlobalIntent(req.body, req.user)); }
    catch (error) { return next(error); }
  },
  async updateGlobalIntent(req, res, next) {
    try { return res.json(await globalIntents.updateGlobalIntent(req.params.globalIntentId, req.body, req.user)); }
    catch (error) { return next(error); }
  },
  async associateGlobalIntent(req, res, next) {
    try {
      return res.status(201).json(await globalIntents.associateGlobalIntentToBot(
        req.params.botId, req.params.globalIntentId, req.body, req.user,
      ));
    } catch (error) { return next(error); }
  },
  async disassociateGlobalIntent(req, res, next) {
    try {
      return res.json(await globalIntents.disassociateBotIntent(req.params.botId, req.params.botIntentId, req.user));
    } catch (error) { return next(error); }
  },

  // Handoff humano (item 2).
  async listHandoffContexts(req, res, next) {
    try { return res.json(await handoff.listHandoffContexts(req.params.conversationId, req.user)); }
    catch (error) { return next(error); }
  },
  async resumeBot(req, res, next) {
    try { return res.json(await handoff.resumeBot(req.params.conversationId, req.user)); }
    catch (error) { return next(error); }
  },

  // Tools (itens 5-7) — listagem só de leitura, para a UI mostrar
  // riskLevel/enabled/entidades obrigatórias ao configurar permissões.
  async listTools(req, res, next) {
    try { return res.json(toolRegistry.listTools()); }
    catch (error) { return next(error); }
  },

  // Item 3: providers implementados (mostrados no select de configuração do
  // Bot) — LOCAL sempre disponível, os demais vêm de EXTERNAL_AI_PROVIDERS
  // (bot-constants.js), nunca uma lista solta duplicada na UI.
  async listAiProviders(req, res, next) {
    try {
      const { AI_PROVIDER_OPTIONS } = require("../services/bot-constants");
      return res.json(AI_PROVIDER_OPTIONS);
    } catch (error) { return next(error); }
  },

  // Item 5 (Motor de IA / Fallback externo): status nunca expõe a
  // credencial. "Testar conexão" é restrito a Master (chamada real à API).
  // `provider` vem do select da configuração do Bot (?provider=GEMINI).
  async aiProviderStatus(req, res, next) {
    try { return res.json(await aiProvider.getProviderStatus(req.query.provider)); }
    catch (error) { return next(error); }
  },
  async testAiProvider(req, res, next) {
    try {
      if (!authorization.isMaster(req.user)) throw authorization.forbidden("Somente uma conta Master pode testar o provider de IA.");
      if (req.body?.confirmRealCall !== true) {
        throw Object.assign(new Error("Confirme a chamada real ao provider de IA."), { statusCode: 400 });
      }
      return res.json(await aiProvider.testConnection(req.body?.provider));
    } catch (error) { return next(error); }
  },

  // Cofre de credenciais de IA (GEMINI/ANTHROPIC/OPENAI) — RBAC: somente
  // Admin (nunca Supervisor/Atendente). Nunca devolve a chave inteira, só
  // os últimos 4 caracteres.
  async listAiCredentials(req, res, next) {
    try { return res.json(await aiCredentials.listCredentialStatus(req.user)); }
    catch (error) { return next(error); }
  },
  async saveAiCredential(req, res, next) {
    try { return res.status(201).json(await aiCredentials.saveCredential(req.params.provider, req.body, req.user)); }
    catch (error) { return next(error); }
  },
  async removeAiCredential(req, res, next) {
    try { return res.json(await aiCredentials.removeCredential(req.params.provider, req.user)); }
    catch (error) { return next(error); }
  },

  // Item 15 (custo/uso de IA externa) — só leitura, sem dashboard complexo.
  async aiUsageSummary(req, res, next) {
    try {
      if (!authorization.isMaster(req.user)) throw authorization.forbidden("Somente uma conta Master pode ver o uso de IA.");
      return res.json(await aiUsage.usageSummary(req.query));
    } catch (error) { return next(error); }
  },

  // Item 7/8 (sugestão de resposta para o atendente + feedback).
  async latestSuggestion(req, res, next) {
    try { return res.json(await suggestions.getLatestSuggestion(req.params.conversationId, req.user)); }
    catch (error) { return next(error); }
  },
  async suggestionFeedback(req, res, next) {
    try { return res.status(201).json(await suggestions.recordSuggestionFeedback(req.body, req.user)); }
    catch (error) { return next(error); }
  },

  // Item 11/12 (métricas/alertas de qualidade).
  async qualityMetrics(req, res, next) {
    try { return res.json(await quality.qualityMetrics(req.params.botId, req.user)); }
    catch (error) { return next(error); }
  },
  async qualityAlerts(req, res, next) {
    try { return res.json(await quality.qualityAlerts(req.params.botId, req.user)); }
    catch (error) { return next(error); }
  },

  // Personalidade (Bot -> Personalidade, item deste plano). Preview/teste
  // reaproveita o simulador já existente (botController.simulate acima) —
  // o resultado já traz response/knowledgeSourceTitle/provider/intentName e,
  // adicionalmente, personalityApplied/personalityProvider/
  // personalitySystemPrompt.
  async getPersonality(req, res, next) {
    try { return res.json(await personality.getPersonality(req.params.botId, req.user)); }
    catch (error) { return next(error); }
  },
  async updatePersonality(req, res, next) {
    try { return res.json(await personality.upsertPersonality(req.params.botId, req.body, req.user)); }
    catch (error) { return next(error); }
  },
  async applyPersonalityPreset(req, res, next) {
    try { return res.json(await personality.applyPreset(req.params.botId, req.body.preset, req.user)); }
    catch (error) { return next(error); }
  },
  async copyPersonality(req, res, next) {
    try { return res.json(await personality.copyPersonality(req.body.sourceBotId, req.params.botId, req.user)); }
    catch (error) { return next(error); }
  },
  async listPersonalityPresets(req, res, next) {
    try {
      if (!authorization.isMaster(req.user)) throw authorization.forbidden("Somente uma conta Master pode gerenciar Bots.");
      return res.json(personality.listPresets());
    } catch (error) { return next(error); }
  },
};
