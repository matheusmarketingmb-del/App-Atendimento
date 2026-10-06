require("dotenv").config();
const { validateEnvironment } = require("./src/config/validate-environment");
validateEnvironment();
const { createApp } = require("./src/app");
const prisma = require("./src/database/prisma");
const MetaCloudChannel = require("./src/channels/meta-cloud-channel");
const { startInactivityMonitor } = require("./src/services/conversation-inactivity-service");
const { startSlaMonitor } = require("./src/services/conversation-sla-service");
const { startCampaignWorker } = require("./src/services/campaign-worker-service");
const { startGmailSyncWorker } = require("./src/services/channels/gmail-sync-service");
const { startVisualFlowWorker } = require("./src/services/bot-visual-flow-service");
const { ensureTriageFlow } = require("./src/services/flow-builder-migration-service");
const inboxEvents = require("./src/realtime/inbox-events");

(async () => {
await ensureTriageFlow();
const PORT = process.env.PORT || 3000;
const channel = new MetaCloudChannel();
const server = createApp({ channel }).listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
const stopInactivityMonitor = startInactivityMonitor({ onChange: () => inboxEvents.publish() });
// Configurações → Conversas: SLAs/alertas (itens 1-4) rodam no mesmo padrão
// de monitor em processo, nunca finalizam nem enviam mensagem ao cliente.
const stopSlaMonitor = startSlaMonitor({ onChange: () => inboxEvents.publish() });
// Item 17: fila de envio de Campanhas — mesmo padrão de monitor em processo
// do startInactivityMonitor acima; nunca dispara nada fora deste tick, e o
// master switch (CampaignGlobalSettings.massMessagingEnabled) é reconferido
// a cada tick dentro do próprio worker.
const stopCampaignWorker = startCampaignWorker({ channel, onChange: () => inboxEvents.publish() });
const stopGmailSyncWorker = startGmailSyncWorker();
// Flow Builder: retoma execuções em WAITING_TIMER (nó Intervalo) — mesmo
// padrão de monitor em processo; só age em Bot ativo com auto-resposta.
const stopVisualFlowWorker = startVisualFlowWorker({ channel, onChange: () => inboxEvents.publish() });
// Migração única e idempotente: converte o antigo Bot de Triagem em fluxo
// visual (publicado, resposta automática DESLIGADA). Nunca bloqueia o boot.

async function shutdown(signal) {
  console.log(`${signal} recebido. Encerrando servidor...`);
  stopInactivityMonitor();
  stopSlaMonitor();
  stopCampaignWorker();
  stopGmailSyncWorker();
  stopVisualFlowWorker();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
})().catch(async (error) => { console.error("[BOT_FLOW] inicialização bloqueada:", error.message); await prisma.$disconnect(); process.exitCode = 1; });
