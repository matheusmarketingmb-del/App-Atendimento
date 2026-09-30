// Controller do painel "Nova conversa" (envio individual e em massa pelo
// WhatsApp). Toda regra de permissão/validação vive no serviço — aqui só
// traduz HTTP. `channel` (número principal) chega por closure, igual a
// campaign-controller.js.
const bulk = require("../services/outbound-bulk-service");
const authorization = require("../services/authorization-service");
const { parsePastedList } = require("../services/bulk-send-rules");
const { detectCsvDelimiter, parseCsv } = require("../services/campaign-csv-service");
const { CSV_MAX_ROWS } = require("../services/campaign-constants");
const inboxEvents = require("../realtime/inbox-events");

function assertCanBulk(user) {
  if (!authorization.canManageCampaigns(user)) throw authorization.forbidden("Você não tem permissão para envio em massa.");
}

function createOutboundBulkController(channel) {
  return {
    async numbers(req, res, next) {
      try { return res.json(await bulk.listSenderNumbers(req.user, channel)); } catch (error) { return next(error); }
    },
    async templates(req, res, next) {
      try { return res.json(await bulk.listSenderTemplates(req.user, req.query.accountId, channel)); } catch (error) { return next(error); }
    },
    async searchContacts(req, res, next) {
      try { return res.json(await bulk.searchCentralContacts(req.user, req.query)); } catch (error) { return next(error); }
    },
    async contactFilters(req, res, next) {
      try { return res.json(await bulk.centralFilterOptions(req.user)); } catch (error) { return next(error); }
    },
    async selectAllContacts(req, res, next) {
      try { return res.json(await bulk.selectAllCentralContacts(req.user, req.body || {})); } catch (error) { return next(error); }
    },
    // Lista colada: só normaliza/classifica — nada é salvo nem enviado.
    async parsePhones(req, res, next) {
      try {
        assertCanBulk(req.user);
        const text = String(req.body?.text || "");
        if (text.length > 1_000_000) throw Object.assign(new Error("Lista muito grande. Use a importação de arquivo."), { statusCode: 400 });
        return res.json(parsePastedList(text));
      } catch (error) { return next(error); }
    },
    // CSV: devolve cabeçalhos + linhas para o mapeamento de colunas na tela.
    // Nunca envia nada; os destinatários só entram após revisão.
    async parseCsvFile(req, res, next) {
      try {
        assertCanBulk(req.user);
        if (!req.file) throw Object.assign(new Error("Envie um arquivo CSV."), { statusCode: 400 });
        const text = req.file.buffer.toString("utf8").replace(/^﻿/, "");
        const rows = parseCsv(text, detectCsvDelimiter(text));
        if (!rows.length) throw Object.assign(new Error("O arquivo está vazio."), { statusCode: 400 });
        const [headers, ...data] = rows;
        if (data.length > CSV_MAX_ROWS) throw Object.assign(new Error(`O arquivo tem mais de ${CSV_MAX_ROWS} linhas.`), { statusCode: 400 });
        return res.json({ fileName: req.file.originalname, headers: headers.map((header) => String(header).trim()), rows: data });
      } catch (error) { return next(error); }
    },
    async preview(req, res, next) {
      try { return res.json(await bulk.previewBulkSend(req.user, req.body, channel)); } catch (error) { return next(error); }
    },
    async create(req, res, next) {
      try {
        const result = await bulk.createBulkSend(req.user, req.body, channel);
        inboxEvents.publish();
        return res.status(result.duplicateRequest ? 200 : 201).json(result);
      } catch (error) { return next(error); }
    },
    async listBatches(req, res, next) {
      try { return res.json(await bulk.listMyBulkSends(req.user)); } catch (error) { return next(error); }
    },
    async batch(req, res, next) {
      try { return res.json(await bulk.getBulkSend(req.user, req.params.id)); } catch (error) { return next(error); }
    },
    async contactHistory(req, res, next) {
      try { return res.json(await bulk.contactTemplateHistory(req.user, req.params.id)); } catch (error) { return next(error); }
    },
  };
}

module.exports = { createOutboundBulkController };
