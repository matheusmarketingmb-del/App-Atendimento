const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const multer = require("multer");
const { rateLimit } = require("express-rate-limit");
const prisma = require("./database/prisma");
const MetaCloudChannel = require("./channels/meta-cloud-channel");
const { saveIncoming, updateStatus, sendTextToPhone } = require("./services/message-service");
const { handleIncomingTriage } = require("./services/triage-bot-service");
const { observeIncomingMessage } = require("./services/bot-observation-service");
const { shadowIncomingMessage } = require("./services/bot-ai-shadow-service");
const localAiController = require("./controllers/local-ai-controller");
const { createInboxController } = require("./controllers/inbox-controller");
const authController = require("./controllers/auth-controller");
const {
  authenticate, requireCampaignAccess, requireCampaignsPage, requireConversationSettingsPage, requireMasterPage, requirePageAuth,
} = require("./middleware/auth");
const conversationSettingsController = require("./controllers/conversation-settings-controller");
const conversationReportController = require("./controllers/conversation-report-controller");
const verifyMetaSignature = require("./middleware/meta-signature");
const integrationAuth = require("./middleware/integration-auth");
const { registerExternalLead } = require("./services/external-lead-service");
const inboxEvents = require("./realtime/inbox-events");
const authorization = require("./services/authorization-service");
const userManagementController = require("./controllers/user-management-controller");
const auditController = require("./controllers/audit-controller");
const { documentMimeTypes } = require("./services/media-storage-service");
const botController = require("./controllers/bot-controller");
const visualFlowController = require("./controllers/bot-visual-flow-controller");
const { handleIncomingVisualFlow } = require("./services/bot-visual-flow-service");
const internalChatController = require("./controllers/internal-chat-controller");
const integrationsController = require("./controllers/integrations-controller");
const socialContentMappingController = require("./controllers/social-content-mapping-controller");
const quickReplyController = require("./controllers/quick-reply-controller");
const pushController = require("./controllers/push-controller");
const pushService = require("./services/push-service");
const campaignReplyService = require("./services/campaign-reply-service");
const { createCampaignController } = require("./controllers/campaign-controller");
const { createOutboundBulkController } = require("./controllers/outbound-bulk-controller");
const { NEW_CHANNELS, SOCIAL_META_CHANNELS } = require("./services/channels/channel-constants");
const { createAdapter } = require("./services/channels/channel-adapter-registry");
const { decryptSecrets } = require("./services/channels/integration-secret-service");
const externalEventService = require("./services/channels/external-event-service");
const { normalizeInboundMessage } = require("./services/channels/channel-event-normalizer");
const omnichannelMessageService = require("./services/channels/omnichannel-message-service");
const { getGlobalSettings } = require("./services/channels/integration-global-settings-service");
const { checkInboundFlood, startPeriodicCleanup } = require("./services/inbound-flood-guard-service");
const { verifyMediaToken } = require("./services/channels/social-media-link-service");
const { resolveMedia } = require("./services/media-storage-service");

function decryptAccountSecretsSafe(account) {
  try { return decryptSecrets(account); }
  catch (_error) { return {}; }
}
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, callback) {
    if (!["image/jpeg", "image/png"].includes(file.mimetype)) {
      return callback(Object.assign(new Error("Envie uma imagem JPG ou PNG."), { statusCode: 400 }));
    }
    return callback(null, true);
  },
}).single("image");
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, callback) {
    if (!["video/mp4", "video/3gpp", "video/3gp"].includes(file.mimetype)) {
      return callback(Object.assign(new Error("Envie um vídeo MP4 ou 3GP."), { statusCode: 400 }));
    }
    return callback(null, true);
  },
}).single("video");
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, callback) {
    if (!documentMimeTypes.has(file.mimetype)) {
      return callback(Object.assign(new Error("Envie um documento PDF, TXT, Word, Excel ou PowerPoint."), { statusCode: 400 }));
    }
    return callback(null, true);
  },
}).single("document");
const outboundDocumentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
  fileFilter(_req, file, callback) {
    if (!documentMimeTypes.has(file.mimetype)) {
      return callback(Object.assign(new Error("Envie documentos PDF, TXT, Word, Excel ou PowerPoint."), { statusCode: 400 }));
    }
    return callback(null, true);
  },
}).array("documents", 10);
const internalFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
}).single("file");
// Item 6/28 (Campanhas): upload de importação — CSV apenas, tamanho e MIME
// validados aqui (nunca soltos em outro arquivo — ver campaign-constants.js).
const { CSV_MAX_FILE_SIZE, CSV_ALLOWED_MIME } = require("./services/campaign-constants");
const campaignImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CSV_MAX_FILE_SIZE, files: 1 },
  fileFilter(_req, file, callback) {
    if (!CSV_ALLOWED_MIME.has(file.mimetype) && !/\.csv$/i.test(file.originalname || "")) {
      return callback(Object.assign(new Error("Envie um arquivo CSV."), { statusCode: 400 }));
    }
    return callback(null, true);
  },
}).single("file");

function createApp({ channel = new MetaCloudChannel() } = {}) {
  const app = express();
  if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);
  const inbox = createInboxController(channel);
  const campaignController = createCampaignController(channel);
  const outboundBulkController = createOutboundBulkController(channel);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({
    limit: "1mb",
    verify(req, _res, buffer) {
      // Também captura o corpo bruto para o webhook genérico de canais
      // novos — necessário para validação HMAC (ex.: Instagram/Facebook
      // reaproveitando a mesma assinatura X-Hub-Signature-256 da Meta).
      if (req.originalUrl === "/webhook/whatsapp" || req.originalUrl.startsWith("/webhooks/channels/")) {
        req.rawBody = Buffer.from(buffer);
      }
    },
  }));
  app.use(cookieParser());

  // Item de segurança (flood/DoS): limita por IP a taxa de requisições nas
  // rotas de webhook, públicas por natureza (recebem tráfego de fora sem
  // autenticação de sessão — só a assinatura HMAC/token as protege de
  // conteúdo forjado, nunca de VOLUME). Generoso o bastante para o tráfego
  // real da Meta (rajadas de eventos em lote continuam cabendo), baixo o
  // bastante para nunca deixar um flood de requisições consumir CPU/memória
  // do processo (JSON parsing + HMAC + banco por requisição) até derrubar o
  // serviço. Complementado por checkInboundFlood (por CONTATO, não por IP —
  // ver inbound-flood-guard-service.js) logo abaixo, porque o IP de origem
  // aqui é o da Meta/do provedor, compartilhado entre muitos remetentes.
  const webhookLimiter = rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false });
  startPeriodicCleanup();

  app.get("/webhook/whatsapp", webhookLimiter, (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === process.env.VERIFY_TOKEN) {
      return res.status(200).send(req.query["hub.challenge"]);
    }
    return res.sendStatus(403);
  });

  app.post("/webhook/whatsapp", webhookLimiter, verifyMetaSignature, async (req, res) => {
    try {
      const incomingPhoneNumberId = req.body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id || null;
      let eventChannel = channel;
      let channelAccountId = null;
      if (incomingPhoneNumberId && incomingPhoneNumberId !== process.env.PHONE_NUMBER_ID) {
        const metaAccounts = await prisma.channelAccount.findMany({ where: { channel: "META", enabled: true, status: "CONNECTED" } });
        const account = metaAccounts.find((item) => item.externalAccountId === incomingPhoneNumberId || item.config?.phoneNumberId === incomingPhoneNumberId);
        if (!account) return res.sendStatus(404);
        const adapter = createAdapter("META", { ...account, secrets: decryptAccountSecretsSafe(account) });
        eventChannel = adapter.channel;
        channelAccountId = account.id;
      }
      const events = eventChannel.parseWebhook(req.body).map((event) => ({ ...event, channelAccountId }));
      let changed = false;
      for (const event of events) {
        // Item de segurança (resiliência do lote): uma falha ao processar UM
        // evento (ex.: mídia deliberadamente malformada — ver
        // media-storage-service.js#validateDocument, que agora pode lançar
        // por conteúdo suspeito) nunca pode abortar o restante do lote nem
        // devolver 500 — um 500 aqui faz a Meta reentregar o webhook inteiro
        // repetidamente (retry automático), o que por si só já é um vetor de
        // negação de serviço amplificado por um único evento malicioso.
        try {
          if (event.kind === "message") {
            if (["image", "audio", "video", "sticker", "document"].includes(event.type) && event.mediaId) {
              const existing = await prisma.message.findUnique({ where: { externalId: event.externalId }, select: { id: true } });
              if (existing) continue;
              const media = await eventChannel.downloadMedia(event.mediaId, {
                maxSize: event.type === "sticker" ? 500 * 1024
                  : (event.type === "image" ? 5 * 1024 * 1024
                    : (event.type === "document" ? 100 * 1024 * 1024 : 16 * 1024 * 1024)),
              });
              event.mediaBuffer = media.buffer;
              event.mediaMimeType = media.mimeType;
              event.mediaFileName ||= media.fileName;
            }
            const result = await saveIncoming(event);
            if (!result.duplicate) {
              if (event.type !== "reaction") {
                // Item de segurança (flood por contato): processamento caro
                // (Bot/IA/Tools) é pulado além do limite por remetente — a
                // mensagem em si já foi salva acima, nunca perdida, só o
                // atendimento automático/observação é que espera a janela
                // passar (ver inbound-flood-guard-service.js).
                const floodKey = event.phone || event.contactExternalId || null;
                const flood = checkInboundFlood(floodKey);
                if (flood.throttled) {
                  console.warn(`[SECURITY] limite de mensagens por contato excedido (${flood.count} na janela) — processamento automático pulado para este turno. key=${floodKey}`);
                } else {
                  // Flow Builder (Editor Visual): só age para Bot em modo
                  // FLOW_BUILDER + ativo + auto-resposta ligada. Qualquer
                  // outro caso (todos os Bots atuais) devolve false e a
                  // triagem legada segue exatamente como antes. Falha no
                  // Flow Builder nunca impede a triagem.
                  let handledByVisualFlow = false;
                  try {
                    handledByVisualFlow = await handleIncomingVisualFlow(event, result.message, eventChannel);
                  } catch (flowError) {
                    console.error("[BOT_FLOW] falha no Flow Builder (triagem legada segue):", flowError.message);
                  }
                  if (!handledByVisualFlow) await handleIncomingTriage(event, result.message, eventChannel);
                  observeIncomingMessage(event, result.message).catch(() => {});
                  shadowIncomingMessage(event, result.message).catch(() => {});
                }
                // Notificação e opt-out são baratos e críticos: continuam
                // mesmo quando Bot/IA está temporariamente limitado.
                pushService.notifyIncomingMessage(result.message).catch(() => {});
                if (event.type === "text" && event.text) {
                  campaignReplyService.handleInboundMessage({
                    phone: event.phone || event.contactExternalId, text: event.text,
                    conversationId: result.message.conversationId,
                  }).catch(() => {});
                }
              }
              changed = true;
            }
          }
          if (event.kind === "status") {
            const result = await updateStatus(event);
            if (result?.count) changed = true;
            campaignReplyService.handleCampaignStatusEvent(event).catch(() => {});
          }
        } catch (eventError) {
          console.error("[WEBHOOK] falha ao processar um evento do lote (ignorado, lote continua):", eventError.message);
        }
      }
      if (changed) inboxEvents.publish();
      return res.status(200).json({ received: true, processed: events.length });
    } catch (error) {
      console.error("Erro ao processar webhook:", error);
      return res.sendStatus(500);
    }
  });

  // A Meta valida o endpoint com GET antes de entregar eventos por POST.
  // A verificação independe de já existir ChannelAccount, pois ela ocorre
  // justamente durante a configuração inicial do produto no painel Meta.
  app.get("/webhooks/channels/:channel", webhookLimiter, (req, res) => {
    if (!SOCIAL_META_CHANNELS.includes(req.params.channel)) return res.sendStatus(404);
    if (req.query["hub.mode"] === "subscribe"
      && req.query["hub.verify_token"] === process.env.VERIFY_TOKEN
      && typeof req.query["hub.challenge"] === "string") {
      return res.status(200).send(req.query["hub.challenge"]);
    }
    return res.sendStatus(403);
  });
  // Webhook genérico dos canais novos (item 8/16) — Meta continua com sua
  // rota própria acima, intocada. Só canais com supportsWebhook real
  // processam algo; os demais respondem 404 sem vazar detalhe interno.
  app.post("/webhooks/channels/:channel", webhookLimiter, async (req, res) => {
    const channel = req.params.channel;
    if (!NEW_CHANNELS.includes(channel)) return res.sendStatus(404);
    try {
      const settings = await getGlobalSettings();
      if (!settings.newChannelsEnabled) return res.sendStatus(404);
      const candidates = await prisma.channelAccount.findMany({ where: { channel, enabled: true }, orderBy: { createdAt: "asc" } });
      if (!candidates.length) return res.sendStatus(404);
      // Com mais de uma conta ativa no mesmo canal (ex.: duas Páginas do
      // Facebook), pergunta a cada adapter se o payload pertence à conta
      // dele (matchesWebhookPayload) em vez de assumir cegamente a
      // primeira — com só uma conta, mantém o caminho de sempre.
      let account = candidates[0];
      let adapter = createAdapter(channel, { ...account, secrets: decryptAccountSecretsSafe(account) });
      if (candidates.length > 1) {
        account = null;
        for (const candidate of candidates) {
          const candidateAdapter = createAdapter(channel, { ...candidate, secrets: decryptAccountSecretsSafe(candidate) });
          if (candidateAdapter?.matchesWebhookPayload(req.body)) { account = candidate; adapter = candidateAdapter; break; }
        }
        if (!account) return res.sendStatus(404);
      }
      if (!adapter || !adapter.capabilities().supportsWebhook) return res.sendStatus(404);
      if (!adapter.validateWebhook(req)) return res.sendStatus(401);

      const rawEvents = adapter.normalizeInboundEvent(req.body) || [];
      for (const raw of rawEvents) {
        const normalized = normalizeInboundMessage({ ...raw, channelAccountId: account?.id || null });
        const externalEventId = account.id + ":" + (normalized.externalMessageId || `${channel}:${Date.now()}:${Math.random()}`);
        const { event, isDuplicate } = await externalEventService.recordEvent({
          channel, channelAccountId: account?.id || null, externalEventId, eventType: normalized.type, payload: raw,
        });
        if (isDuplicate) continue;
        try {
          const persisted = await omnichannelMessageService.persistInboundMessage(normalized);
          await externalEventService.markProcessed(event.id);
          // Paridade com o WhatsApp (item 26/33 do plano Social): observação
          // do Bot (só sugestão, nunca envia nada sozinho) e push notification
          // para o atendente responsável. Nunca pode derrubar o webhook —
          // mesmo padrão de .catch silencioso usado no handler do WhatsApp.
          if (!persisted.duplicate && normalized.direction === "RECEBIDA") {
            observeIncomingMessage(normalized, persisted.message, { channel: normalized.channel }).catch(() => {});
            pushService.notifyIncomingMessage(persisted.message).catch(() => {});
          }
          inboxEvents.publish();
        } catch (error) {
          await externalEventService.markError(event.id, error.channelErrorCode || "PROVIDER_ERROR");
        }
      }
      return res.status(200).json({ received: true, processed: rawEvents.length });
    } catch (error) {
      console.error(`[CHANNEL] provider=${channel} event=webhook status=error`, error.message);
      return res.sendStatus(200);
    }
  });

  // Link público e temporário de mídia (item 46) — só assim o Instagram
  // Direct/Facebook Messenger conseguem enviar anexo (a Send API da Meta
  // busca a URL sozinha, sem sessão nossa). Token HMAC de curta duração
  // (social-media-link-service.js); nunca autenticado por cookie/JWT de
  // propósito — as próprias servidoras da Meta é quem busca este link.
  const publicMediaLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
  app.get("/public/media/:storageKey/:expiresAt/:token", publicMediaLimiter, (req, res) => {
    const { storageKey, expiresAt, token } = req.params;
    if (!verifyMediaToken(storageKey, expiresAt, token)) return res.sendStatus(404);
    try {
      return res.sendFile(resolveMedia(storageKey));
    } catch (_error) {
      return res.sendStatus(404);
    }
  });

  app.get("/health", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return res.json({ status: "ok", database: "connected" });
    } catch (_error) {
      return res.status(503).json({ status: "error", database: "unavailable" });
    }
  });

  const integrationLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
  app.post("/integrations/leads/atacado", integrationLimiter, integrationAuth, async (req, res, next) => {
    try {
      const result = await registerExternalLead(req.body);
      inboxEvents.publish();
      return res.status(result.duplicate ? 200 : 201).json({ success: true, ...result });
    } catch (error) {
      return next(error);
    }
  });

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
  app.get("/api/auth/status", authController.status);
  app.post("/api/auth/setup", loginLimiter, authController.setup);
  app.post("/api/auth/login", loginLimiter, authController.login);
  app.post("/api/auth/logout", authController.logout);

  app.get(["/", "/index.html"], requirePageAuth, (_req, res) => res.sendFile(path.join(process.cwd(), "public", "index.html")));
  app.get(["/bots", "/bots.html"], requireMasterPage, (_req, res) => (
    res.sendFile(path.join(process.cwd(), "public", "bots.html"))
  ));
  app.get(["/integrations", "/integrations.html"], requireMasterPage, (_req, res) => (
    res.sendFile(path.join(process.cwd(), "public", "integrations.html"))
  ));
  app.get(["/quick-replies", "/quick-replies.html"], requireMasterPage, (_req, res) => (
    res.sendFile(path.join(process.cwd(), "public", "quick-replies.html"))
  ));
  app.get(["/flow-builder", "/flow-builder.html"], requireMasterPage, (_req, res) => (
    res.sendFile(path.join(process.cwd(), "public", "flow-builder.html"))
  ));
  app.get(["/knowledge-base", "/knowledge-base.html"], requireMasterPage, (_req, res) => (
    res.sendFile(path.join(process.cwd(), "public", "knowledge-base.html"))
  ));
  app.get(["/campaigns", "/campaigns.html"], requireCampaignsPage, (_req, res) => (
    res.sendFile(path.join(process.cwd(), "public", "campaigns.html"))
  ));
  app.get(["/relatorio-conversas", "/relatorio-conversas.html"], requireMasterPage, (_req, res) => (
    res.sendFile(path.join(process.cwd(), "public", "relatorio-conversas.html"))
  ));
  app.get(["/configuracoes", "/configuracoes.html"], requireConversationSettingsPage, (_req, res) => (
    res.sendFile(path.join(process.cwd(), "public", "configuracoes.html"))
  ));
  app.get("/service-worker.js", (_req, res) => {
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.sendFile(path.join(process.cwd(), "public", "service-worker.js"));
  });
  app.use(express.static("public", { index: false }));
  app.use("/api", authenticate);
  app.get("/api/events", inboxEvents.handle);
  app.get("/api/push/public-key", pushController.publicKey);
  app.post("/api/push/subscriptions", pushController.subscribe);
  app.get("/api/push/devices", pushController.listDevices);
  app.delete("/api/push/devices/:id", pushController.removeDevice);
  app.get("/api/internal-chats", internalChatController.list);
  app.get("/api/internal-chat-users", internalChatController.users);

app.get(
  "/api/internal-chats/:id/messages",
  internalChatController.messages
);

app.post(
  "/api/internal-chats/:id/files",
  internalFileUpload,
  internalChatController.file
);


// Compatibilidade com versões antigas da PWA ainda armazenadas em cache.
app.post(
  "/api/internal-chats/:id/images",
  imageUpload,
  internalChatController.file
);

app.get(
  "/api/internal-messages/:messageId/media",
  internalChatController.media
);

app.post(
  "/api/internal-chats/:id/messages",
  internalChatController.send
);

app.post(
  "/api/internal-chats/:id/read",
  internalChatController.read
);

app.post(
  "/api/internal-chats/direct/:userId",
  internalChatController.direct
);
  // Grupos do chat interno (permissões de membro/admin validadas no serviço).
  app.post("/api/internal-chats/groups", internalChatController.createGroup);
  app.get("/api/internal-chats/:id/group", internalChatController.group);
  app.patch("/api/internal-chats/:id/group", internalChatController.renameGroup);
  app.post("/api/internal-chats/:id/members", internalChatController.addGroupMembers);
  app.patch("/api/internal-chats/:id/members/:userId", internalChatController.setGroupMemberRole);
  app.delete("/api/internal-chats/:id/members/:userId", internalChatController.removeGroupMember);
  app.post("/api/internal-chats/:id/leave", internalChatController.leaveGroup);
  app.post("/api/internal-chats/:id/archive", internalChatController.archiveGroup);
  app.get("/api/messages", async (req, res, next) => {
    try {
      // Endpoint legado (exportação bruta de várias conversas de uma vez):
      // não tem como aplicar o recorte de histórico por conversa, então fica
      // restrito ao Master. O painel não usa esta rota.
      if (!authorization.isMaster(req.user)) throw authorization.forbidden("Somente uma conta Master pode exportar mensagens em lote.");
      const scope = await authorization.conversationScope(req.user);
      const rows = await prisma.message.findMany({
        where: { conversation: { is: scope } },
        include: { conversation: { include: { contact: true } } }, orderBy: { occurredAt: "asc" }, take: 500,
      });
      return res.json(rows.map((item) => ({
        id: item.externalId || item.id, from: item.conversation.contact.email || item.conversation.contact.phone,
        to: item.direction === "ENVIADA" ? (item.conversation.contact.email || item.conversation.contact.phone) : undefined,
        name: item.conversation.contact.customName || item.conversation.contact.name || item.conversation.contact.email || item.conversation.contact.phone,
        type: item.type, text: item.text, timestamp: item.occurredAt.getTime(),
        direction: item.direction === "ENVIADA" ? "sent" : "received",
      })));
    } catch (error) { return next(error); }
  });

  app.post("/api/send", (_req, res) => {
    return res.status(409).json({ error: "O início de conversas pela Meta está temporariamente desativado." });
  });

  app.get("/api/conversations", inbox.list);
  app.get("/api/conversations/summary", inbox.summary);
  app.get("/api/alerts", inbox.alerts);
  app.get("/api/meta/status", inbox.metaStatus);
  app.get("/api/meta/templates", requireCampaignAccess, inbox.templates);
  app.get("/api/outbound/channels", inbox.outboundChannels);
  app.post("/api/conversations/outbound/email", outboundDocumentUpload, inbox.createOutboundEmail);
  app.post("/api/conversations/outbound", inbox.createOutbound);
  app.get("/api/conversations/:id", inbox.detail);
  app.patch("/api/conversations/:id", inbox.update);
  app.post(
    "/api/conversations/:id/signal-transfer",
    inbox.signalTransfer
  );
  app.delete("/api/conversations/:id", inbox.deleteConversation);
  app.patch("/api/conversations/:id/spam", inbox.setEmailSpamStatus);
  app.post("/api/conversations/:id/claim", inbox.claim);
  app.patch("/api/conversations/:id/pin", inbox.pinConversation);
  app.post("/api/conversations/:id/read", inbox.read);
  app.post("/api/conversations/:id/messages", inbox.reply);
  app.post("/api/conversations/:id/templates", inbox.replyTemplate);
  app.post("/api/conversations/:id/images", imageUpload, inbox.replyImage);
  app.post("/api/conversations/:id/videos", videoUpload, inbox.replyVideo);
  app.post("/api/conversations/:id/documents", documentUpload, inbox.replyDocument);
  app.post("/api/conversations/:id/finalize", inbox.finalize);
  app.post("/api/conversations/:id/bot-feedback", inbox.botFeedback);
  app.get("/api/messages/:messageId/media", inbox.media);
  app.post("/api/messages/:messageId/moderate", inbox.moderateComment);
  app.get("/api/categories", inbox.categories);
  app.get("/api/category-visibility", inbox.categoryVisibility);
  app.patch("/api/category-visibility", inbox.updateCategoryVisibility);
  app.post("/api/categories", inbox.createCategory);
  app.patch("/api/categories/:id", inbox.updateCategory);
  app.get("/api/users", inbox.users);
  app.get("/api/contacts/:contactId/merge-candidates", inbox.mergeCandidates);
  app.post("/api/contacts/:contactId/merge", inbox.mergeContacts);
  app.patch(
    "/api/contacts/:contactId/name",
    inbox.updateContactName
  );
  app.post("/api/contacts/:contactId/notes", inbox.addNote);
  app.patch("/api/contacts/:contactId/notes/:noteId", inbox.pinNote);
  app.delete("/api/contacts/:contactId/notes/:noteId", inbox.deleteNote);
  app.get("/api/admin/users", userManagementController.list);
  app.get("/api/admin/audit-logs", auditController.list);
  app.post("/api/admin/users", userManagementController.create);
  app.patch("/api/admin/users/:id", userManagementController.update);
  app.get("/api/team/users", userManagementController.activity);
  app.get("/api/bots", botController.list);
  app.get("/api/bots/intents", botController.allIntents);
  app.post("/api/bots", botController.create);
  app.get("/api/bots/:botId", botController.detail);
  app.patch("/api/bots/:botId", botController.update);
  app.patch("/api/bots/:botId/status", botController.status);
  app.delete("/api/bots/:botId", botController.archive);
  app.put("/api/bots/:botId/schedules", botController.schedules);
  app.put("/api/bots/:botId/holidays", botController.holidays);
  app.put("/api/bots/:botId/triage-options", botController.triageOptions);
  app.get("/api/local-ai/status", localAiController.getStatus);
  app.get("/api/local-ai/settings", localAiController.getSettings);
  app.put("/api/local-ai/settings", localAiController.updateSettings);
  app.post("/api/local-ai/check", localAiController.checkNow);
  app.post("/api/bots/:botId/intents", botController.createIntent);
  app.patch("/api/bots/:botId/intents/:intentId", botController.updateIntent);
  app.delete("/api/bots/:botId/intents/:intentId", botController.deleteIntent);
  app.get("/api/bots/:botId/intents/:intentId/flow-steps", botController.listFlowSteps);
  app.post("/api/bots/:botId/intents/:intentId/flow-steps", botController.createFlowStep);
  app.patch("/api/bots/:botId/intents/:intentId/flow-steps/:stepId", botController.updateFlowStep);
  app.delete("/api/bots/:botId/intents/:intentId/flow-steps/:stepId", botController.deleteFlowStep);
  app.put("/api/bots/:botId/intents/:intentId/flow-steps/reorder", botController.reorderFlowSteps);
  app.get("/api/bots/:botId/guided-config", botController.guidedConfig);
  app.post("/api/bots/:botId/response-blocks", botController.createResponseBlock);
  app.patch("/api/bots/:botId/response-blocks/:blockId", botController.updateResponseBlock);
  app.delete("/api/bots/:botId/response-blocks/:blockId", botController.deleteResponseBlock);
  app.post("/api/bots/:botId/synonyms", botController.createSynonym);
  app.patch("/api/bots/:botId/synonyms/:synonymId", botController.updateSynonym);
  app.delete("/api/bots/:botId/synonyms/:synonymId", botController.deleteSynonym);
  app.post("/api/bots/:botId/simulate", botController.simulate);
  app.get("/api/bot-observations", botController.observations);
  app.get("/api/bot-observations/metrics", botController.observationMetrics);
  app.post("/api/bot-observations/:observationId/feedback", botController.observationFeedback);
  app.get("/api/bot-learning/suggestions", botController.learningSuggestions);
  app.get("/api/bot-learning/metrics", botController.learningMetrics);
  app.post("/api/bot-learning/suggestions/:suggestionId/approve", botController.approveLearningSuggestion);
  app.post("/api/bot-learning/suggestions/:suggestionId/reject", botController.rejectLearningSuggestion);
  app.patch("/api/bot-learning/suggestions/:suggestionId", botController.editLearningSuggestion);
  app.post("/api/bot-learning/conversations/:conversationId/analyze", botController.analyzeConversationForLearning);
  app.get("/api/bots/:botId/intent-conflicts", botController.intentConflicts);
  app.get("/api/bots/:botId/intent-metrics", botController.intentMetrics);

  app.get("/api/bot-settings", botController.globalSettings);
  app.patch("/api/bot-settings", botController.updateGlobalSettings);
  app.post("/api/bot-settings/kill-switch/activate", botController.activateKillSwitch);
  app.post("/api/bot-settings/kill-switch/deactivate", botController.deactivateKillSwitch);

  app.get("/api/bots/:botId/versions", botController.listVersions);
  app.post("/api/bots/:botId/versions", botController.createVersion);
  app.get("/api/bots/:botId/versions/:version/preview-restore", botController.previewRestoreVersion);
  app.post("/api/bots/:botId/versions/:version/restore", botController.restoreVersion);

  app.post("/api/bot-ratings", botController.submitRating);
  app.get("/api/bot-ratings", botController.listRatings);
  app.get("/api/bots/:botId/rating-metrics", botController.ratingMetrics);
  app.get("/api/bots/:botId/rating-timeseries", botController.ratingTimeSeries);
  app.get("/api/bots/:botId/observation-timeseries", botController.observationTimeSeries);
  app.patch("/api/bots/:botId/rating-config", botController.updateRatingConfig);
  app.get("/api/bot-ranking", botController.ranking);

  app.get("/api/knowledge-sources", botController.listKnowledgeSources);
  app.post("/api/knowledge-sources", botController.createKnowledgeSource);
  app.patch("/api/knowledge-sources/:sourceId", botController.updateKnowledgeSource);
  app.delete("/api/knowledge-sources/:sourceId", botController.deleteKnowledgeSource);

  // Biblioteca Global de Intenções (item 1).
  app.get("/api/global-intents", botController.listGlobalIntents);
  app.post("/api/global-intents", botController.createGlobalIntent);
  app.patch("/api/global-intents/:globalIntentId", botController.updateGlobalIntent);
  app.post("/api/bots/:botId/global-intents/:globalIntentId", botController.associateGlobalIntent);
  app.delete("/api/bots/:botId/intent-associations/:botIntentId", botController.disassociateGlobalIntent);

  // Handoff humano (item 2).
  app.get("/api/conversations/:conversationId/bot-handoff", botController.listHandoffContexts);
  app.post("/api/conversations/:conversationId/bot-handoff/resume", botController.resumeBot);

  // Sugestão de resposta para o atendente + feedback (itens 7/8).
  app.get("/api/conversations/:conversationId/bot-suggestion", botController.latestSuggestion);
  app.post("/api/bot-suggestion-feedback", botController.suggestionFeedback);

  // Métricas/alertas de qualidade (itens 11/12).
  app.get("/api/bots/:botId/quality-metrics", botController.qualityMetrics);
  app.get("/api/bots/:botId/quality-alerts", botController.qualityAlerts);

  // Personalidade configurável por Bot ("Bot -> Personalidade"). Preview/
  // teste reaproveita POST /api/bots/:botId/simulate (já registrado acima).
  app.get("/api/bot-personality-presets", botController.listPersonalityPresets);
  app.get("/api/bots/:botId/personality", botController.getPersonality);
  app.put("/api/bots/:botId/personality", botController.updatePersonality);
  app.post("/api/bots/:botId/personality/preset", botController.applyPersonalityPreset);
  app.post("/api/bots/:botId/personality/copy", botController.copyPersonality);

  // Flow Builder (Editor Visual). Permissão (só Master) validada no serviço.
  app.get("/api/bots/:botId/visual-flows", visualFlowController.list);
  app.post("/api/bots/:botId/visual-flows", visualFlowController.create);
  app.get("/api/bots/:botId/visual-flow-options", visualFlowController.options);
  app.patch("/api/bots/:botId/execution-mode", visualFlowController.executionMode);
  app.get("/api/bots/:botId/visual-flows/:flowId", visualFlowController.detail);
  app.put("/api/bots/:botId/visual-flows/:flowId/draft", visualFlowController.saveDraft);
  app.post("/api/bots/:botId/visual-flows/:flowId/validate", visualFlowController.validate);
  app.post("/api/bots/:botId/visual-flows/:flowId/publish", visualFlowController.publish);
  app.patch("/api/bots/:botId/visual-flows/:flowId/status", visualFlowController.status);
  app.post("/api/bots/:botId/visual-flows/:flowId/default", visualFlowController.setDefault);
  app.delete("/api/bots/:botId/visual-flows/:flowId", visualFlowController.archive);
  app.get("/api/bots/:botId/visual-flows/:flowId/versions/:version", visualFlowController.version);
  app.post("/api/bots/:botId/visual-flows/:flowId/versions/:version/rollback", visualFlowController.rollback);
  app.post("/api/bots/:botId/visual-flows/:flowId/versions/:version/restore-draft", visualFlowController.restoreToDraft);
  app.post("/api/bots/:botId/visual-flows/:flowId/simulate", visualFlowController.simulate);
  app.get("/api/bots/:botId/visual-flows/:flowId/executions", visualFlowController.executions);
  app.get("/api/bots/:botId/visual-flows/:flowId/executions/:executionId/logs", visualFlowController.executionLogs);

  // Tools (itens 5-7): listagem só de leitura.
  app.get("/api/bot-tools", botController.listTools);

  // Motor de IA / Fallback externo (itens 12-15).
  app.get("/api/bot-ai-providers", botController.listAiProviders);
  app.get("/api/bot-ai-provider-status", botController.aiProviderStatus);
  app.post("/api/bot-ai-provider-status/test", botController.testAiProvider);
  app.get("/api/bot-ai-usage", botController.aiUsageSummary);

  // Cofre de credenciais de IA (GEMINI/ANTHROPIC/OPENAI) — RBAC Admin-only
  // dentro dos próprios services (ver ai-credential-service.js).
  app.get("/api/bot-ai-credentials", botController.listAiCredentials);
  app.put("/api/bot-ai-credentials/:provider", botController.saveAiCredential);
  app.delete("/api/bot-ai-credentials/:provider", botController.removeAiCredential);

  // Campanhas / envio em massa (WhatsApp).
  app.use(["/api/campaign-templates", "/api/campaign-settings", "/api/campaign-opt-outs", "/api/campaigns"], requireCampaignAccess);
  app.get("/api/campaign-templates", campaignController.listTemplates);
  app.post("/api/campaign-templates/preview", campaignController.previewTemplate);
  app.get("/api/campaign-settings", campaignController.getSettings);
  app.patch("/api/campaign-settings", campaignController.updateSettings);

  app.get("/api/conversation-settings", conversationSettingsController.getSettings);
  app.patch("/api/conversation-settings", conversationSettingsController.updateSettings);

  // Relatório de Conversas (dashboard completo, só Master) — substitui o
  // antigo relatório semanal embutido em Configurações → Conversas.
  app.get("/api/reports/conversations/summary", conversationReportController.summary);
  app.get("/api/reports/conversations/timeseries", conversationReportController.timeseries);
  app.get("/api/reports/conversations/status-breakdown", conversationReportController.statusBreakdown);
  app.get("/api/reports/conversations/channel-breakdown", conversationReportController.channelBreakdown);
  app.get("/api/reports/conversations/category-breakdown", conversationReportController.categoryBreakdown);
  app.get("/api/reports/conversations/agents", conversationReportController.agentRanking);
  app.get("/api/reports/conversations/agents/compare", conversationReportController.compareAgents);
  app.get("/api/reports/conversations/agents/export", conversationReportController.exportAgentsCsv);
  app.get("/api/reports/conversations/agents/:userId", conversationReportController.agentDetail);
  app.get("/api/reports/conversations/heatmap", conversationReportController.heatmap);
  app.get("/api/reports/conversations/wait-time-buckets", conversationReportController.waitTimeBuckets);
  app.get("/api/reports/conversations/alerts", conversationReportController.alerts);
  app.get("/api/reports/conversations/export", conversationReportController.exportCsv);
  app.get("/api/reports/conversations/:conversationId", conversationReportController.conversationDetail);
  app.get("/api/reports/conversations", conversationReportController.listConversations);
  app.get("/api/campaign-opt-outs", campaignController.listOptOuts);
  app.post("/api/campaign-opt-outs/:phone/remove", campaignController.removeOptOut);
  app.get("/api/campaigns", campaignController.list);
  app.post("/api/campaigns", campaignController.create);
  app.get("/api/campaigns/:id", campaignController.detail);
  app.patch("/api/campaigns/:id", campaignController.update);
  app.post("/api/campaigns/:id/estimate-audience", campaignController.estimateAudience);
  app.post("/api/campaigns/:id/schedule", campaignController.schedule);
  app.post("/api/campaigns/:id/queue-now", campaignController.queueNow);
  app.post("/api/campaigns/:id/pause", campaignController.pause);
  app.post("/api/campaigns/:id/resume", campaignController.resume);
  app.post("/api/campaigns/:id/cancel", campaignController.cancel);
  app.post("/api/campaigns/:id/send-test", campaignController.sendTest);
  app.post("/api/campaigns/:id/import/parse", campaignImportUpload, campaignController.parseImport);
  // Painel "Nova conversa" — envio individual e em massa (fila de Campanhas).
  app.get("/api/outbound/meta/numbers", outboundBulkController.numbers);
  app.get("/api/outbound/meta/templates", outboundBulkController.templates);
  app.get("/api/outbound/contacts", outboundBulkController.searchContacts);
  app.get("/api/outbound/contacts/filters", outboundBulkController.contactFilters);
  app.post("/api/outbound/contacts/select-all", outboundBulkController.selectAllContacts);
  app.post("/api/outbound/phones/parse", outboundBulkController.parsePhones);
  app.post("/api/outbound/import/csv", campaignImportUpload, outboundBulkController.parseCsvFile);
  app.post("/api/outbound/bulk/preview", outboundBulkController.preview);
  app.get("/api/outbound/bulk", outboundBulkController.listBatches);
  app.post("/api/outbound/bulk", outboundBulkController.create);
  app.get("/api/outbound/bulk/:id", outboundBulkController.batch);
  app.get("/api/contacts/:id/template-history", outboundBulkController.contactHistory);
  app.post("/api/campaigns/:id/import/validate", campaignController.validateImport);
  app.post("/api/campaigns/:id/import/commit", campaignController.commitImport);
  app.get("/api/campaigns/:id/export", campaignController.exportContacts);
  app.get("/api/campaigns/:id/contacts", campaignController.listContacts);
  app.get("/api/campaigns/:id/metrics", campaignController.metrics);

  app.get("/api/integrations/overview", integrationsController.overview);
  app.get("/api/integrations/settings", integrationsController.getGlobalSettings);
  app.patch("/api/integrations/settings", integrationsController.setGlobalSettings);
  app.patch("/api/integrations/settings/social-reply", integrationsController.setSocialReplyFlags);
  app.get("/api/integrations/accounts", integrationsController.list);
  app.post("/api/integrations/accounts", integrationsController.create);
  app.get("/api/integrations/accounts/:accountId", integrationsController.detail);
  app.patch("/api/integrations/accounts/:accountId", integrationsController.update);
  app.patch("/api/integrations/accounts/:accountId/enabled", integrationsController.setEnabled);
  app.patch("/api/integrations/accounts/:accountId/access", integrationsController.setAccess);
  app.delete("/api/integrations/accounts/:accountId", integrationsController.remove);
  app.post("/api/integrations/accounts/:accountId/test-connection", integrationsController.testConnection);
  app.post("/api/integrations/oauth/start", integrationsController.oauthStart);
  app.post("/api/integrations/oauth/callback", integrationsController.oauthCallback);
  app.post("/api/integrations/oauth/accounts/:accountId/select", integrationsController.oauthSelect);
  app.get("/api/social-content-mappings", socialContentMappingController.list);
  app.post("/api/social-content-mappings", socialContentMappingController.create);
  app.patch("/api/social-content-mappings/:id/active", socialContentMappingController.setActive);
  app.delete("/api/social-content-mappings/:id", socialContentMappingController.remove);

  app.get("/api/quick-replies/composer", quickReplyController.listForComposer);
  app.get("/api/quick-replies/suggestions", quickReplyController.suggestions);
  app.post("/api/quick-replies/preview", quickReplyController.preview);
  app.get("/api/quick-replies", quickReplyController.list);
  app.post("/api/quick-replies", quickReplyController.create);
  app.get("/api/quick-replies/:id", quickReplyController.detail);
  app.patch("/api/quick-replies/:id", quickReplyController.update);
  app.delete("/api/quick-replies/:id", quickReplyController.archive);
  app.post("/api/quick-replies/:id/favorite", quickReplyController.setFavorite);
  app.post("/api/quick-replies/:id/use", quickReplyController.use);
  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: error.field === "file" ? "O arquivo deve ter no máximo 100 MB."
          : error.field === "document" ? "O documento deve ter no máximo 100 MB."
          : (error.field === "video" ? "O vídeo deve ter no máximo 16 MB." : "A imagem deve ter no máximo 5 MB."),
      });
    }
    if (!error.statusCode) console.error("Erro interno:", {
      name: error.name,
      message: error.message,
      code: error.code,
    });
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Erro interno do servidor.",
      ...(error.code ? { code: error.code } : {}),
      ...(error.details ? error.details : {}),
    });
  });
  return app;
}

module.exports = { createApp };
