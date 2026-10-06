// Controller de Campanhas — reaproveita meta-template-service.js para
// listar templates aprovados (mesma integração usada pelo painel para
// iniciar conversas avulsas). `channel` chega por closure, igual a
// inbox-controller.js.
const { listApprovedTemplates, templatesConfigured } = require("../services/meta-template-service");
const campaigns = require("../services/campaign-service");
const importService = require("../services/campaign-import-service");
const exportService = require("../services/campaign-export-service");
const metricsService = require("../services/campaign-metrics-service");
const settingsService = require("../services/campaign-settings-service");
const optOutService = require("../services/campaign-optout-service");
const authorization = require("../services/authorization-service");
const whatsappAccounts = require("../services/whatsapp-account-service");

function createCampaignController(channel) {
  return {
    // Item 3: listagem de templates aprovados — nunca inventa nada; se a
    // integração Meta estiver indisponível, o erro sobe claro para a UI.
    // Multiempresa: templates do número escolhido (?channelAccountId) ou do
    // único número da empresa (?company) — nunca mistura WABAs.
    async listTemplates(req, res, next) {
      try {
        const account = await whatsappAccounts.resolveAccountForUser(req.user, {
          channelAccountId: req.query.channelAccountId || null, company: req.query.company || null,
        });
        await campaigns.assertCampaignCompanyPermission(req.user, account.companyId);
        if (!templatesConfigured(account)) {
          return res.status(503).json({ error: "Templates da Meta ainda não configurados para este número (WABA ID ausente)." });
        }
        return res.json(await listApprovedTemplates(channel, account));
      } catch (error) { return next(error); }
    },
    async previewTemplate(req, res, next) {
      try {
        return res.json(await campaigns.previewTemplate(channel, req.body, req.user));
      } catch (error) { return next(error); }
    },
    // Números de WhatsApp disponíveis para campanhas (seletor da criação).
    async listAccounts(req, res, next) {
      try {
        const companyIds = await campaigns.manageableCompanyIds(req.user);
        const accounts = await whatsappAccounts.listAccountsForUser(req.user, { company: req.query.company || null });
        return res.json(accounts.filter((account) => companyIds.includes(account.companyId)));
      } catch (error) { return next(error); }
    },

    async list(req, res, next) {
      try { return res.json(await campaigns.listCampaigns(req.query, req.user)); }
      catch (error) { return next(error); }
    },
    async detail(req, res, next) {
      try { return res.json(await campaigns.getCampaign(req.params.id, req.user)); }
      catch (error) { return next(error); }
    },
    async create(req, res, next) {
      try { return res.status(201).json(await campaigns.createCampaign(req.body, req.user, channel)); }
      catch (error) { return next(error); }
    },
    async update(req, res, next) {
      try { return res.json(await campaigns.updateCampaign(req.params.id, req.body, req.user, channel)); }
      catch (error) { return next(error); }
    },
    async estimateAudience(req, res, next) {
      try { return res.json(await campaigns.estimateAudience(req.params.id, req.body, req.user)); }
      catch (error) { return next(error); }
    },
    async schedule(req, res, next) {
      try { return res.json(await campaigns.scheduleCampaign(req.params.id, req.body, req.user)); }
      catch (error) { return next(error); }
    },
    async queueNow(req, res, next) {
      try { return res.json(await campaigns.queueCampaignNow(req.params.id, req.user)); }
      catch (error) { return next(error); }
    },
    async pause(req, res, next) {
      try { return res.json(await campaigns.pauseCampaign(req.params.id, req.user)); }
      catch (error) { return next(error); }
    },
    async resume(req, res, next) {
      try { return res.json(await campaigns.resumeCampaign(req.params.id, req.user)); }
      catch (error) { return next(error); }
    },
    async cancel(req, res, next) {
      try { return res.json(await campaigns.cancelCampaign(req.params.id, req.user)); }
      catch (error) { return next(error); }
    },
    async sendTest(req, res, next) {
      try { return res.json(await campaigns.sendTestMessage(req.params.id, req.user, channel)); }
      catch (error) { return next(error); }
    },

    // Importação (itens 6/7/28) — o arquivo já chegou validado por MIME/
    // tamanho pelo multer (ver app.js); aqui só interpreta o texto.
    async parseImport(req, res, next) {
      try {
        if (!req.file) throw Object.assign(new Error("Envie um arquivo CSV."), { statusCode: 400 });
        return res.json(importService.parseImportPreview(req.file.buffer.toString("utf-8")));
      } catch (error) { return next(error); }
    },
    // Item 6/7: validate/commit recebem JSON normal (csvText + mapping como
    // objeto) — só o primeiro passo (parseImport) usa multipart/arquivo.
    async validateImport(req, res, next) {
      try {
        return res.json(await importService.validateImport({
          campaignId: req.params.id, csvText: req.body.csvText, mapping: req.body.mapping || {},
        }, req.user));
      } catch (error) { return next(error); }
    },
    async commitImport(req, res, next) {
      try {
        return res.status(201).json(await importService.commitImport({
          campaignId: req.params.id, csvText: req.body.csvText, mapping: req.body.mapping || {}, fileName: req.body.fileName,
        }, req.user));
      } catch (error) { return next(error); }
    },

    async exportContacts(req, res, next) {
      try {
        const { csv, fileName } = await exportService.exportCampaignContacts(req.params.id, req.query, req.user);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        return res.send(csv);
      } catch (error) { return next(error); }
    },

    async listContacts(req, res, next) {
      try {
        authorization.assertCanManageCampaigns(req.user);
        const prisma = require("../database/prisma");
        const where = { campaignId: req.params.id };
        if (req.query.status) where.status = req.query.status;
        const take = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
        const skip = Math.max(Number(req.query.offset) || 0, 0);
        const [rows, total] = await Promise.all([
          prisma.campaignContact.findMany({ where, orderBy: { createdAt: "asc" }, take, skip }),
          prisma.campaignContact.count({ where }),
        ]);
        return res.json({ rows, total });
      } catch (error) { return next(error); }
    },

    async metrics(req, res, next) {
      try { return res.json(await metricsService.campaignMetrics(req.params.id, req.user)); }
      catch (error) { return next(error); }
    },

    async getSettings(req, res, next) {
      try { return res.json(await settingsService.getCampaignSettingsForManager(req.user)); }
      catch (error) { return next(error); }
    },
    async updateSettings(req, res, next) {
      try { return res.json(await settingsService.updateCampaignSettings(req.body, req.user)); }
      catch (error) { return next(error); }
    },

    async listOptOuts(req, res, next) {
      try { return res.json(await optOutService.listOptOuts(req.query, req.user)); }
      catch (error) { return next(error); }
    },
    async removeOptOut(req, res, next) {
      try { return res.json(await optOutService.removeOptOut(req.params.phone, req.body, req.user)); }
      catch (error) { return next(error); }
    },
  };
}

module.exports = { createCampaignController };
