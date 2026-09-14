// Relatório de Conversas — controller fino, todas as rotas só para Master
// (mesma régua do weekly-report anterior, agora abrangendo o dashboard
// completo). Nunca expõe nada por engano: cada handler confere
// authorization.isMaster antes de qualquer consulta.
const analytics = require("../services/conversation-analytics-service");
const authorization = require("../services/authorization-service");
const { STATUS_LABELS, CHANNEL_LABELS } = require("../services/conversation-report-constants");

function assertMaster(req) {
  if (!authorization.isMaster(req.user)) throw authorization.forbidden("Somente uma conta Master pode ver o Relatório de Conversas.");
}

function wrap(handler) {
  return async (req, res, next) => {
    try { assertMaster(req); return res.json(await handler(req)); }
    catch (error) { return next(error); }
  };
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

module.exports = {
  summary: wrap((req) => analytics.getSummary(req.query)),
  timeseries: wrap((req) => analytics.getTimeseries(req.query)),
  statusBreakdown: wrap((req) => analytics.getStatusBreakdown(req.query)),
  channelBreakdown: wrap((req) => analytics.getChannelBreakdown(req.query)),
  categoryBreakdown: wrap((req) => analytics.getCategoryBreakdown(req.query)),
  agentRanking: wrap((req) => analytics.getAgentRanking(req.query)),
  agentDetail: wrap(async (req) => {
    const detail = await analytics.getAgentDetail(req.params.userId, req.query);
    if (!detail) throw Object.assign(new Error("Vendedor não encontrado."), { statusCode: 404 });
    return detail;
  }),
  compareAgents: wrap((req) => {
    const ids = String(req.query.userIds || "").split(",").map((id) => id.trim()).filter(Boolean).slice(0, 3);
    if (!ids.length) throw Object.assign(new Error("Informe ao menos um vendedor para comparar."), { statusCode: 400 });
    return analytics.compareAgents(ids, req.query);
  }),
  heatmap: wrap((req) => analytics.getHeatmap(req.query)),
  waitTimeBuckets: wrap((req) => analytics.getWaitTimeBuckets(req.query)),
  alerts: wrap((req) => analytics.getAlerts(req.query)),
  listConversations: wrap((req) => analytics.listConversations(req.query)),
  conversationDetail: wrap(async (req) => {
    const detail = await analytics.getConversationDetail(req.params.conversationId);
    if (!detail) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
    return detail;
  }),

  // CSV respeitando os filtros ativos (item 27). XLSX fica para uma
  // próxima fase — exigiria uma dependência nova (ex.: exceljs) que não
  // decidi sozinho instalar.
  async exportCsv(req, res, next) {
    try {
      assertMaster(req);
      const { items } = await analytics.listConversations({ ...req.query, page: 1, pageSize: 100 });
      const header = ["Contato", "Telefone", "Canal", "Categoria", "Status", "Prioridade", "Vendedor", "Criada em", "Última atividade", "Finalizada em", "Última mensagem"];
      const lines = [header.map(csvEscape).join(",")];
      for (const item of items) {
        lines.push([
          item.contactName, item.contactPhone, item.channelLabel, item.categoryName, STATUS_LABELS[item.status] || item.status,
          item.priority, item.assignedUserName, item.createdAt?.toISOString(), item.lastMessageAt?.toISOString(),
          item.finalizedAt?.toISOString(), item.lastMessagePreview,
        ].map(csvEscape).join(","));
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="relatorio-conversas-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.send(`﻿${lines.join("\n")}`);
    } catch (error) { return next(error); }
  },

  async exportAgentsCsv(req, res, next) {
    try {
      assertMaster(req);
      const { agents } = await analytics.getAgentRanking(req.query);
      const header = ["Vendedor", "E-mail", "Atendidas", "Assumidas", "Resolvidas", "Finalizadas", "Mensagens enviadas", "Nunca respondidas", "1ª resposta média (s)", "Resposta média (s)", "Resolução média (s)", "Taxa de resolução (%)", "SLA cumprido (%)"];
      const lines = [header.map(csvEscape).join(",")];
      for (const agent of agents) {
        lines.push([
          agent.name, agent.email, agent.attended, agent.claimed, agent.resolved, agent.finalized, agent.messagesSent, agent.neverAnswered,
          agent.firstResponseAvgSeconds !== null ? Math.round(agent.firstResponseAvgSeconds) : "",
          agent.responseAvgSeconds !== null ? Math.round(agent.responseAvgSeconds) : "",
          agent.resolutionAvgSeconds !== null ? Math.round(agent.resolutionAvgSeconds) : "",
          agent.resolutionRate !== null ? agent.resolutionRate.toFixed(1) : "",
          agent.slaMetPercent !== null ? agent.slaMetPercent.toFixed(1) : "",
        ].map(csvEscape).join(","));
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="relatorio-vendedores-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.send(`﻿${lines.join("\n")}`);
    } catch (error) { return next(error); }
  },
};
