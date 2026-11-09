const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const multer = require("multer");
const { rateLimit } = require("express-rate-limit");
const prisma = require("./database/prisma");
const MetaCloudChannel = require("./channels/meta-cloud-channel");
const { routeMetaWebhook } = require("./services/meta-webhook-routing-service");
const { saveIncoming, updateStatus, sendTextToPhone } = require("./services/message-service");
const { createInboxController } = require("./controllers/inbox-controller");
const { createChatController } = require("./controllers/chat-controller");
const { applyReactionStatus } = require("./services/chat-message-service");
const authController = require("./controllers/auth-controller");
const companyController = require("./controllers/company-controller");
const whatsappAccounts = require("./services/whatsapp-account-service");
const {
  authenticate, requireAfterHoursPage, requireCampaignAccess, requireCampaignsPage, requireConversationSettingsPage, requireMasterPage, requireOperationsPage, requirePageAuth,
  requireReportsPage,
} = require("./middleware/auth");
const operationsPanel = require("./services/operations-panel-service");
const metaCosts = require("./services/meta-cost-service");
const metaAds = require("./services/meta-ads-service");
const templatePerformance = require("./services/template-performance-service");
const conversationSettingsController = require("./controllers/conversation-settings-controller");
const afterHoursController = require("./controllers/after-hours-controller");
const afterHoursReminders = require("./services/after-hours-reminder-service");
const conversationReportController = require("./controllers/conversation-report-controller");
const verifyMetaSignature = require("./middleware/meta-signature");
const { createAccountWebhook } = require("./middleware/meta-account-webhook");
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
const { routeIncomingMessage: routeToPreferredAssignee } = require("./services/preferred-assignee-routing-service");
const preferredAssignees = require("./services/preferred-assignee-service");
const internalChatController = require("./controllers/internal-chat-controller");
const integrationsController = require("./controllers/integrations-controller");
const socialContentMappingController = require("./controllers/social-content-mapping-controller");
const quickReplyController = require("./controllers/quick-reply-controller");
const pushController = require("./controllers/push-controller");
const pushService = require("./services/push-service");
const campaignReplyService = require("./services/campaign-reply-service");
const { createCampaignController } = require("./controllers/campaign-controller");
const { createOutboundBulkController } = require("./controllers/outbound-bulk-controller");
const supervisionController = require("./controllers/supervision-controller");
const followUpController = require("./controllers/follow-up-controller");
const followUps = require("./services/follow-up-service");
const operationalHealth = require("./services/operational-health-service");
const { NEW_CHANNELS, SOCIAL_META_CHANNELS } = require("./services/channels/channel-constants");
const { createAdapter } = require("./services/channels/channel-adapter-registry");
const { decryptSecrets } = require("./services/channels/integration-secret-service");
const externalEventService = require("./services/channels/external-event-service");
const { normalizeInboundMessage } = require("./services/channels/channel-event-normalizer");
const omnichannelMessageService = require("./services/channels/omnichannel-message-service");
const { getGlobalSettings } = require("./services/channels/integration-global-settings-service");
const { checkInboundFlood, startPeriodicCleanup } = require("./services/inbound-flood-guard-service");
const { verifyMediaToken } = require("./services/channels/social-media-link-service");
const { resolveMedia, validateSticker } = require("./services/media-storage-service");

function decryptAccountSecretsSafe(account) {
  try { return decryptSecrets(account); }
  catch (_error) { return {}; }
}
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, callback) {
    if (!["image/jpeg", "image/png", "image/bmp", "image/x-ms-bmp", "image/webp"].includes(file.mimetype)) {
      return callback(Object.assign(new Error("Envie uma imagem JPG ou PNG."), { statusCode: 400 }));
    }
    return callback(null, true);
  },
}).single("image");
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, callback) {
    if (!["video/mp4", "video/3gpp", "video/3gp", "video/quicktime", "video/x-msvideo", "video/avi", "image/gif"].includes(file.mimetype)) {
      return callback(Object.assign(new Error("Envie um vídeo MP4 ou 3GP."), { statusCode: 400 }));
    }
    return callback(null, true);
  },
}).single("video");
// Áudio (gravação do navegador ou arquivo): o tipo declarado varia muito
// entre navegadores/SO (audio/webm;codecs=opus, audio/x-m4a, octet-stream
// para .opus/.amr...). O filtro aqui é só grosseiro — o tipo real é decidido
// pelo conteúdo em audio-normalization-service.js.
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, callback) {
    const mimeType = String(file.mimetype || "").toLowerCase();
    if (!mimeType.startsWith("audio/") && !["video/webm", "video/ogg", "application/ogg", "application/octet-stream"].includes(mimeType)) {
      return callback(Object.assign(new Error("Envie um arquivo de áudio (OGG, MP3, M4A, AAC ou AMR)."), { statusCode: 400 }));
    }
    return callback(null, true);
  },
}).single("audio");
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, callback) {
    if (!documentMimeTypes.has(file.mimetype)&&!['image/tiff','image/x-tiff','image/heic','image/heif','image/heic-sequence','image/heif-sequence'].includes(file.mimetype)) {
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
const botFlowMediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 1 } }).single("file");
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
  const chatApi = createChatController(channel);
  const libraryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024, files: 1 } }).single("file");
  const campaignController = createCampaignController(channel);
  const outboundBulkController = createOutboundBulkController(channel);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({
    limit: "1mb",
    verify(req, _res, buffer) {
      // Também captura o corpo bruto para o webhook genérico de canais
      // novos — necessário para validação HMAC (ex.: Instagram/Facebook
      // reaproveitando a mesma assinatura X-Hub-Signature-256 da Meta).
      if (req.path.startsWith("/identity/") || req.path === "/webhook/whatsapp" || req.path.startsWith("/webhook/whatsapp/") || req.originalUrl.startsWith("/webhooks/channels/")) {
        req.rawBody = Buffer.from(buffer);
      }
    },
  }));
  app.use(cookieParser());
  app.use('/identity', require('./routes/central-identity').createIdentityRouter({prisma,auth:require('./services/auth-service')}));
  // Public shell grants NO Atendimento session or API privileges. CRM retains
  // its own login/authorization, including for CRM-only representatives.
  app.get(['/crm','/crm.html'], (req,res)=>{
    if(process.env.CENTRAL_IDENTITY_ENABLED!=='true')return res.sendStatus(404);
    const origin=new URL(process.env.CRM_PUBLIC_URL).origin;
    const frameUrl=new URL(req.query.connect==='1'?'/api/central/start':'/dashboard',origin);
    if(req.query.connect==='1')frameUrl.searchParams.set('next','/central-resume');
    if(req.query.connect==='1' && /^[A-Za-z0-9_-]{1,128}$/.test(req.query.customer||''))frameUrl.searchParams.set('next',`/clientes/${req.query.customer}`);
    if(req.query.connect==='1' && /^[A-Za-z0-9_-]{1,64}$/.test(req.query.agenda||''))frameUrl.searchParams.set('next',`/agenda?open=${req.query.agenda}`);
    if(req.query.connect==='1' && req.query.followups==='1')frameUrl.searchParams.set('next','/follow-ups?tab=atrasados');
    if(req.query.connect==='1' && /^[A-Za-z0-9_-]{1,128}$/.test(req.query.lead||''))frameUrl.searchParams.set('next',`/clientes/novo?conversationId=${req.query.lead}`);
    if(req.query.connect==='1' && /^[A-Za-z0-9_-]{1,128}$/.test(req.query.proposalCustomer||'') && ['mibro','sincrofit'].includes(req.query.brand))frameUrl.searchParams.set('next',`/cotacoes/nova?cliente=${req.query.proposalCustomer}&marca=${req.query.brand}`);
    if(req.query.connect==='1' && /^[A-Za-z0-9_-]{1,128}$/.test(req.query.proposalCustomer||'') && /^[A-Za-z0-9_-]{1,128}$/.test(req.query.proposalConversation||''))frameUrl.searchParams.set('next',`/cotacoes/nova?cliente=${req.query.proposalCustomer}&atendimento=${req.query.proposalConversation}`);
    if(req.query.connect==='1' && /^[A-Za-z0-9_-]{1,128}$/.test(req.query.quote||''))frameUrl.searchParams.set('next',`/cotacoes/${req.query.quote}`);
    const frame=frameUrl.href.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':`default-src 'none'; frame-src 'self' ${origin}; style-src 'self'; script-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`});
    return res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CRM · Central</title><link rel="stylesheet" href="/css/crm-shell.css"></head><body><header><strong>CRM <span>Portal Comercial</span></strong><button id="reload-crm" type="button">Recarregar</button></header><p id="crm-offline" role="status" hidden>Sem conexão. Reconecte para acessar o CRM.</p><iframe id="crm-frame" title="CRM — Portal Comercial" src="${frame}" referrerpolicy="no-referrer"></iframe><script src="/js/crm-shell.js"></script></body></html>`);
  });

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

  // Preserve the deployed callback contract; workspaces do not change Meta URLs.
  app.get("/webhook/whatsapp", webhookLimiter, (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && process.env.VERIFY_TOKEN && req.query["hub.verify_token"] === process.env.VERIFY_TOKEN) {
      return res.status(200).send(req.query["hub.challenge"]);
    }
    return res.sendStatus(403);
  });

  const receiveWhatsAppWebhook = async (req, res) => {
    try {
      const metaAccounts = req.metaWebhookAccount ? [req.metaWebhookAccount]
        : (await prisma.channelAccount.findMany({ where: { channel: "META", enabled: true, status: "CONNECTED" } }))
          .filter((account) => !account.secretKeys?.includes("appSecret"));
      const events = await routeMetaWebhook(req.body, {
        legacyChannel: channel, legacyPhoneNumberId: req.metaWebhookAccount ? null : process.env.PHONE_NUMBER_ID, accounts: metaAccounts,
        createAccountChannel: (account) => createAdapter("META", { ...account, secrets: decryptAccountSecretsSafe(account) }).channel,
      });
      let changed = false;
      const changedCompanyIds = new Set();
      for (const { event, eventChannel } of events) {
        // Item de segurança (resiliência do lote): uma falha ao processar UM
        // evento (ex.: mídia deliberadamente malformada — ver
        // media-storage-service.js#validateDocument, que agora pode lançar
        // por conteúdo suspeito) nunca pode abortar o restante do lote nem
        // devolver 500 — um 500 aqui faz a Meta reentregar o webhook inteiro
        // repetidamente (retry automático), o que por si só já é um vetor de
        // negação de serviço amplificado por um único evento malicioso.
        try {
          if (event.kind === "message") {
            // Multiempresa: o número que recebeu define a empresa. Número sem
            // ChannelAccount cadastrada nunca é atribuído a uma empresa "por
            // padrão" — o evento é ignorado (sem 500, para a Meta não reenviar).
            const account = await whatsappAccounts.resolveInboundAccount(event.phoneNumberId);
            if (!account) {
              console.warn(`[WEBHOOK] phone_number_id sem ChannelAccount cadastrada — mensagem ignorada. phoneNumberId=${event.phoneNumberId}`);
              continue;
            }
            operationalHealth.recordWebhook("META", account.id);
            if (["image", "audio", "video", "sticker", "document"].includes(event.type) && event.mediaId) {
              const existing = await prisma.message.findUnique({ where: { externalId: event.externalId }, select: { id: true } });
              if (existing) continue;
              try {
                const media = await eventChannel.downloadMedia(event.mediaId, {
                  maxSize: event.type === "sticker" ? 500 * 1024
                    : (event.type === "image" ? 5 * 1024 * 1024
                      : (event.type === "document" ? 100 * 1024 * 1024 : 16 * 1024 * 1024)),
                });
                if (event.type === "sticker") validateSticker(media);
                event.mediaBuffer = media.buffer;
                event.mediaMimeType = media.mimeType;
                event.mediaFileName ||= media.fileName;
              } catch (mediaError) {
                // Figurinha com falha não some da conversa: fica "indisponível".
                if (event.type !== "sticker") throw mediaError;
                console.warn("[WEBHOOK] figurinha sem mídia válida; mensagem mantida:", mediaError.message);
              }
            }
            const result = await saveIncoming(event, account);
            if (!result.duplicate) {
              changedCompanyIds.add(account.companyId);
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
                } else if (!result.archived) {
                  // Flow Builder (Editor Visual): só age para Bot em modo
                  // FLOW_BUILDER + ativo + auto-resposta ligada. Qualquer
                  // outro caso (todos os Bots atuais) devolve false e a
                  // triagem legada segue exatamente como antes. Falha no
                  // Flow Builder nunca impede a triagem.
                  let routedToPreferred = false;
                  try {
                    routedToPreferred = await routeToPreferredAssignee(event, result.message, eventChannel);
                  } catch (routingError) {
                    console.error("[PREFERRED_ASSIGNEE] falha no roteamento (segue fluxo comum):", routingError.message);
                  }
                  let handledByVisualFlow = false;
                  try {
                    if (!routedToPreferred) handledByVisualFlow = await handleIncomingVisualFlow(event, result.message, eventChannel);
                  } catch (flowError) {
                    console.error("[BOT_FLOW] falha no Flow Builder (triagem legada segue):", flowError.message);
                  }
                }
                // Run after reception: pre-categorizing would prevent a new
                // visual flow (which intentionally starts only without a category).
                if (!result.archived && account.config?.inboundCategoryId) {
                  try {
                    await prisma.$transaction(tx => require("./services/inbound-category-service").applyInboundCategory(tx, { account, conversationId: result.message.conversationId }));
                  } catch (categoryError) {
                    console.error("[INBOUND_CATEGORY] falha na classificação automática:", categoryError.message);
                  }
                }
                // Notificação e opt-out são baratos e críticos: continuam
                // mesmo quando Bot/IA está temporariamente limitado.
                // Fora do expediente: agenda (ou move) o lembrete depois do
                // Bot/atendente fixo terem agido. Nunca derruba o webhook.
                try {
                  await afterHoursReminders.scheduleForInboundMessage(result.message);
                } catch (reminderError) {
                  console.error("[AFTER_HOURS] falha ao agendar lembrete (mensagem já salva):", reminderError.message);
                }
                if(!result.archived)pushService.notifyIncomingMessage(result.message).catch(() => {});
                // Agenda: cliente com retorno pendente voltou a escrever.
                if(!result.archived)followUps.notifyCustomerReturned(result.message).catch(() => {});
                if (event.type === "text" && event.text) {
                  campaignReplyService.handleInboundMessage({
                    phone: event.phone || event.contactExternalId, text: event.text,
                    conversationId: result.message.conversationId, companyId: account.companyId,
                  }).catch(() => {});
                }
              }
              changed = true;
            }
          }
          if (event.kind === "status") {
            const statusAccount = await whatsappAccounts.resolveInboundAccount(event.phoneNumberId);
            if (statusAccount) operationalHealth.recordWebhook("META", statusAccount.id);
            if (statusAccount) changedCompanyIds.add(statusAccount.companyId);
            const result = await updateStatus(event);
            if (result?.count) changed = true;
            if (await applyReactionStatus(event)) changed = true;
            // Custos Meta: estimativa a partir do `pricing` do status (nunca
            // bloqueia nem derruba o webhook).
            metaCosts.recordStatusEvent(event).catch(() => {});
            campaignReplyService.handleCampaignStatusEvent(event).catch(() => {});
          }
        } catch (eventError) {
          console.error("[WEBHOOK] falha ao processar um evento do lote (ignorado, lote continua):", eventError.message);
        }
      }
      if (changed) inboxEvents.publish(changedCompanyIds);
      return res.status(200).json({ received: true, processed: events.length });
    } catch (error) {
      if (error.statusCode === 404) return res.sendStatus(404);
      console.error("Erro ao processar webhook:", error);
      return res.sendStatus(500);
    }
  };
  app.post("/webhook/whatsapp", webhookLimiter, verifyMetaSignature, receiveWhatsAppWebhook);
  const accountWebhook = createAccountWebhook();
  app.get("/webhook/whatsapp/:accountId", webhookLimiter, accountWebhook.verify);
  app.post("/webhook/whatsapp/:accountId", webhookLimiter, accountWebhook.authenticate, receiveWhatsAppWebhook);

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
      const candidates = await prisma.channelAccount.findMany({ where: { channel, enabled: true, company: { active: true } }, orderBy: { createdAt: "asc" } });
      if (!candidates.length) return res.sendStatus(404);
      const routed=require('./services/channels/social-webhook-routing').planInboundRouting(channel,candidates,req,account=>createAdapter(channel,{...account,secrets:decryptAccountSecretsSafe(account)}));
      let processed=0;
      for(const {account,events:rawEvents} of routed) for (const raw of rawEvents) {
        processed++;
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
            pushService.notifyIncomingMessage(persisted.message).catch(() => {});
            followUps.notifyCustomerReturned(persisted.message).catch(() => {});
          }
          inboxEvents.publish();
        } catch (error) {
          await externalEventService.markError(event.id, error.channelErrorCode || "PROVIDER_ERROR");
        }
      }
      return res.status(200).json({ received: true, processed });
    } catch (error) {
      if([401,404].includes(error.statusCode))return res.sendStatus(error.statusCode);
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
    res.redirect("/templates")
  ));
  app.get(["/templates", "/templates.html"], requireCampaignsPage, (_req, res) => (
    res.sendFile(path.join(process.cwd(), "public", "campaigns.html"))
  ));
  app.get(["/campaigns", "/campaigns.html"], requireCampaignsPage, (_req, res) => (
    res.sendFile(path.join(process.cwd(), "public", "campaigns.html"))
  ));
  // Produtividade e Qualidade: Master, Supervisor ou Atendente com "Ver
  // minha produtividade" — o escopo de cada um é aplicado nas APIs.
  app.get(["/relatorio-conversas", "/relatorio-conversas.html", "/produtividade"], requireReportsPage, (_req, res) => (
    res.sendFile(path.join(process.cwd(), "public", "relatorio-conversas.html"))
  ));
  // Agenda e Follow-ups: qualquer usuário autenticado (cada um vê o próprio
  // escopo — regra aplicada nas APIs /api/follow-ups).
  app.get(["/agenda", "/agenda.html"], requirePageAuth, (_req, res) => (
    res.sendFile(path.join(process.cwd(), "public", "agenda.html"))
  ));
  app.get(["/operacao", "/operacao.html"], requireOperationsPage, (_req, res) => (
    res.sendFile(path.join(process.cwd(), "public", "operacao.html"))
  ));
  app.get(["/custos-meta", "/custos-meta.html"], requireMasterPage, (_req, res) => (
    res.sendFile(path.join(process.cwd(), "public", "custos-meta.html"))
  ));
  app.get(["/configuracoes", "/configuracoes.html"], requireConversationSettingsPage, (_req, res) => (
    res.sendFile(path.join(process.cwd(), "public", "configuracoes.html"))
  ));
  app.get(["/recursos-chat", "/recursos-chat.html"], requireMasterPage, (_req, res) => res.sendFile(path.join(process.cwd(), "public", "recursos-chat.html")));
  app.get(["/metricas", "/metricas.html"], requirePageAuth, (_req, res) => res.sendFile(path.join(process.cwd(), "public", "metricas.html")));
  app.get(["/fora-do-expediente", "/fora-do-expediente.html"], requireAfterHoursPage, (_req, res) => (
    res.sendFile(path.join(process.cwd(), "public", "fora-do-expediente.html"))
  ));
  app.get(["/arquivados", "/arquivados.html"], requirePageAuth, (_req,res)=>res.sendFile(path.join(process.cwd(),'public','arquivados.html')));
  app.get("/service-worker.js", (_req, res) => {
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.sendFile(path.join(process.cwd(), "public", "service-worker.js"));
  });
  app.use(require("./middleware/precompressed-static").precompressedStatic());
  app.get(['/anuncios-meta', '/anuncios-meta.html'], requireMasterPage, (_req, res) => res.sendFile(path.join(process.cwd(), 'public', 'anuncios-meta.html')));
  app.use(express.static("public", { index: false }));
  app.use("/api", authenticate);
  app.use(["/api/chat", "/api/messages", "/api/conversations", "/api/internal-chats"], require("./services/chat-feature-settings-service").middleware);
  app.get("/api/admin/chat-features", async (req, res, next) => {
    try { res.set("Cache-Control", "no-store"); res.json(await require("./services/chat-feature-settings-service").read(req.user)); } catch (error) { next(error); }
  });
  app.patch("/api/admin/chat-features", async (req, res, next) => {
    try { res.json(await require("./services/chat-feature-settings-service").save(req.user, req.body)); } catch (error) { next(error); }
  });
  app.get("/api/events", inboxEvents.handle);
  app.get("/api/push/public-key", pushController.publicKey);
  app.post("/api/push/subscriptions", pushController.subscribe);
  app.get("/api/push/devices", pushController.listDevices);
  app.delete("/api/push/devices/:id", pushController.removeDevice);
  app.get("/api/internal-chats", internalChatController.list);
  // Chat interno por empresa: não lidas por workspace e busca no workspace ativo.
  app.get("/api/internal-chats/unread", internalChatController.unread);
  app.get("/api/internal-chats/search", internalChatController.search);
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
  app.post("/api/internal-chats/messages/:messageId/reactions", internalChatController.react);
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

  // Multiempresa: empresas do usuário, preferência do filtro e cadastro de
  // empresas (Master Global).
  app.get("/api/companies", companyController.mine);
  app.put("/api/companies/preference", companyController.setPreference);
  app.get("/api/admin/companies", companyController.adminList);
  app.post("/api/admin/companies", companyController.create);
  app.patch("/api/admin/companies/:companyId", companyController.update);
  // Central de Operação (Supervisor/Master) — só agregações e metadados.
  app.get("/api/operations/overview", async (req, res, next) => {
    try { return res.json(await operationsPanel.getOverview(req.user, req.query)); }
    catch (error) { return next(error); }
  });
  app.get("/api/operations/options", async (req, res, next) => {
    try { return res.json(await operationsPanel.getFilterOptions(req.user)); }
    catch (error) { return next(error); }
  });
  // Canais e integrações (evidências) — mesmas empresas do painel.
  app.get("/api/operations/channels", async (req, res, next) => {
    try { return res.json(await operationsPanel.getChannels(req.user, req.query)); }
    catch (error) { return next(error); }
  });
  // Diagnóstico técnico — somente Master (validado no serviço).
  app.get("/api/operations/diagnostics", async (req, res, next) => {
    try { return res.json(await require("./services/operational-health-service").getDiagnostics(req.user)); }
    catch (error) { return next(error); }
  });
  app.get('/api/meta-ads/accounts', async (req,res,next) => { try { res.set('Cache-Control','no-store'); res.json(await metaAds.getAccounts(req.user,req.query)); } catch(error) { next(error); } });
  app.get('/api/meta-ads/report', async (req,res,next) => { try { res.set('Cache-Control','no-store'); res.json(await metaAds.getReport(req.user,req.query)); } catch(error) { next(error); } });
  // Custos Meta (Master): relatório estimado, preços versionados e orçamento.
  app.get("/api/meta-costs/report", async (req, res, next) => {
    try { return res.json(await metaCosts.getCostReport(req.user, req.query)); } catch (error) { return next(error); }
  });
  // Ranking de templates (Master), sempre de UM workspace — agregação no banco.
  app.get("/api/meta-costs/templates", async (req, res, next) => {
    try { return res.json(await templatePerformance.getTemplateRanking(req.user, req.query)); } catch (error) { return next(error); }
  });
  app.get("/api/meta-costs/templates/detail", async (req, res, next) => {
    try { return res.json(await templatePerformance.getTemplateDetail(req.user, req.query)); } catch (error) { return next(error); }
  });
  app.get("/api/meta-costs/pricing", async (req, res, next) => {
    try { return res.json(await metaCosts.listPricing(req.user)); } catch (error) { return next(error); }
  });
  app.post("/api/meta-costs/pricing", async (req, res, next) => {
    try { return res.status(201).json(await metaCosts.createPricing(req.body || {}, req.user)); } catch (error) { return next(error); }
  });
  app.put("/api/meta-costs/budget", async (req, res, next) => {
    try { return res.json(await metaCosts.setBudget(req.body || {}, req.user)); } catch (error) { return next(error); }
  });
  app.get("/api/conversations", inbox.list);
  app.get("/api/conversations/summary", inbox.summary);
  app.get("/api/conversations/search", inbox.search);
  app.get("/api/workspaces/unread", inbox.workspaceUnread);
  app.get("/api/alerts", inbox.alerts);
  app.get("/api/meta/status", inbox.metaStatus);
  app.get("/api/meta/templates", requireCampaignAccess, inbox.templates);
  app.get("/api/whatsapp-accounts", inbox.whatsappAccounts);
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
  app.patch('/api/conversations/:id/archive',async(req,res,next)=>{
    try{
      const result=await require('./services/conversation-archive-service').setArchived(require('./database/prisma'),require('./services/authorization-service'),req.user,req.params.id,req.body?.archived);
      require('./realtime/inbox-events').publishForConversation(req.params.id);
      res.json(result);
    }catch(error){next(error);}
  });
  app.post("/api/conversations/:id/read", inbox.read);
  app.post("/api/conversations/:id/messages", inbox.reply);
  app.post("/api/conversations/:id/templates", inbox.replyTemplate);
  app.post("/api/conversations/:id/images", imageUpload, inbox.replyImage);
  app.post("/api/conversations/:id/videos", videoUpload, inbox.replyVideo);
  app.post("/api/conversations/:id/documents", documentUpload, inbox.replyDocument);
  app.post("/api/conversations/:id/audios", audioUpload, inbox.replyAudio);
  app.post("/api/conversations/:id/finalize", inbox.finalize);
  app.get("/api/messages/:messageId/media", inbox.media);
  app.get("/api/chat/features", chatApi.features);
  app.post("/api/messages/:messageId/reactions", chatApi.react);
  app.put("/api/messages/:messageId/star", chatApi.star);
  app.put("/api/messages/:messageId/pin", chatApi.pin);
  app.post("/api/messages/:messageId/forward", chatApi.forward);
  app.post("/api/messages/:messageId/save-sticker", chatApi.saveSticker);
  app.get("/api/conversations/:id/stars", chatApi.stars);
  app.get("/api/conversations/:id/pins", chatApi.pins);
  app.get("/api/conversations/:id/message-search", chatApi.search);
  app.get("/api/conversations/:id/messages/:messageId/locate", chatApi.locate);
  app.get("/api/conversations/:id/messages/:messageId/context", chatApi.context);
  app.post("/api/conversations/:id/library-send", chatApi.sendAsset);
  app.get("/api/media-library", chatApi.libraryList);
  app.post("/api/media-library", libraryUpload, chatApi.libraryUpload);
  app.put("/api/media-library/:assetId/favorite", chatApi.libraryFavorite);
  app.delete("/api/media-library/:assetId", chatApi.libraryRemove);
  app.get("/api/media-library/:assetId/file", chatApi.libraryFile);
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
  // Atendente fixo por cliente (Supervisor da empresa do cliente / Master).
  app.get("/api/contacts/:contactId/preferred-assignee", async (req, res, next) => {
    try { return res.json(await preferredAssignees.getPreferredAssignee(req.params.contactId, req.user)); }
    catch (error) { return next(error); }
  });
  app.get("/api/contacts/:contactId/preferred-assignee/candidates", async (req, res, next) => {
    try { return res.json(await preferredAssignees.listCandidates(req.params.contactId, req.user)); }
    catch (error) { return next(error); }
  });
  app.get("/api/contacts/:contactId/preferred-assignee/history", async (req, res, next) => {
    try { return res.json(await preferredAssignees.listHistory(req.params.contactId, req.user)); }
    catch (error) { return next(error); }
  });
  app.put("/api/contacts/:contactId/preferred-assignee", async (req, res, next) => {
    try {
      const result = await preferredAssignees.setPreferredAssignee(req.params.contactId, req.body || {}, req.user);
      inboxEvents.publish([result.companyId]);
      return res.json(result);
    } catch (error) { return next(error); }
  });
  app.delete("/api/contacts/:contactId/preferred-assignee", async (req, res, next) => {
    try {
      const result = await preferredAssignees.removePreferredAssignee(req.params.contactId, req.body || {}, req.user);
      inboxEvents.publish([result.companyId]);
      return res.json(result);
    } catch (error) { return next(error); }
  });
  app.post("/api/contacts/:contactId/notes", inbox.addNote);
  app.patch("/api/contacts/:contactId/notes/:noteId", inbox.pinNote);
  app.delete("/api/contacts/:contactId/notes/:noteId", inbox.deleteNote);
  app.get("/api/admin/users", userManagementController.list);
  app.get("/api/admin/users/number-options", userManagementController.numbers);
  app.get("/api/admin/audit-logs", auditController.list);
  app.post("/api/admin/users", userManagementController.create);
  app.patch("/api/admin/users/:id", userManagementController.update);
  app.get("/api/team/users", userManagementController.activity);
  app.get("/api/bots", botController.list);
  app.post("/api/bots", botController.create);
  app.get("/api/bots-legacy", botController.legacyBots);
  app.get("/api/bots/:botId", botController.detail);
  app.get("/api/bots/:botId/observation", botController.observation);
  app.patch("/api/bots/:botId", botController.update);
  app.patch("/api/bots/:botId/status", botController.status);
  app.patch("/api/bots/:botId/auto-reply", botController.autoReply);
  app.delete("/api/bots/:botId", botController.archive);
  app.put("/api/bots/:botId/schedules", botController.schedules);
  app.put("/api/bots/:botId/holidays", botController.holidays);

  app.get("/api/bot-settings", botController.globalSettings);
  app.post("/api/bot-settings/kill-switch/activate", botController.activateKillSwitch);
  app.post("/api/bot-settings/kill-switch/deactivate", botController.deactivateKillSwitch);

  // "Cancelar Bot"/"Retomar Bot" na Central de Atendimento.
  app.post("/api/conversations/:conversationId/bot-handoff/pause", botController.pauseBot);
  app.post("/api/conversations/:conversationId/bot-handoff/resume", botController.resumeBot);

  // Biblioteca "Respostas do Bot" e endpoints do nó Webhook/API.
  app.get("/api/bot-responses", botController.listResponses);
  app.post("/api/bot-responses", botController.createResponse);
  app.patch("/api/bot-responses/:responseId", botController.updateResponse);
  app.delete("/api/bot-responses/:responseId", botController.deleteResponse);

  // Flow Builder (Editor Visual).
  app.get("/api/bots/:botId/visual-flows", visualFlowController.list);
  app.post("/api/bots/:botId/visual-flows", visualFlowController.create);
  app.get("/api/bots/:botId/visual-flow-options", visualFlowController.options);
  app.post("/api/bots/:botId/flow-media", botFlowMediaUpload, visualFlowController.uploadMedia);
  app.get("/api/bots/:botId/flow-media/:storageKey", visualFlowController.media);
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

  // Campanhas / envio em massa (WhatsApp).
  app.use(["/api/campaign-templates", "/api/campaign-settings", "/api/campaign-opt-outs", "/api/campaigns", "/api/template-routing"], requireCampaignAccess);
  app.get("/api/campaign-templates", campaignController.listTemplates);
  // Destino automático (categoria/subcategoria internas) por template da WABA.
  app.get("/api/template-routing/options", campaignController.templateRoutingOptions);
  app.get("/api/template-routing/history", campaignController.templateRoutingHistory);
  app.put("/api/template-routing", campaignController.saveTemplateRouting);
  app.get("/api/campaign-accounts", campaignController.listAccounts);
  app.post("/api/campaign-templates/preview", campaignController.previewTemplate);
  app.get("/api/campaign-settings", campaignController.getSettings);
  app.patch("/api/campaign-settings", campaignController.updateSettings);

  app.get("/api/conversation-settings", conversationSettingsController.getSettings);
  app.patch("/api/conversation-settings", conversationSettingsController.updateSettings);
  app.delete("/api/conversation-settings/company/:company", conversationSettingsController.resetCompany);
  // Atendimento fora do expediente (permissões checadas nos services).
  app.get("/api/after-hours/settings", afterHoursController.getSettings);
  app.patch("/api/after-hours/settings", afterHoursController.updateSettings);
  app.delete("/api/after-hours/settings/company/:company", afterHoursController.resetCompany);
  app.get("/api/after-hours/holidays", afterHoursController.listHolidays);
  app.post("/api/after-hours/holidays", afterHoursController.createHoliday);
  app.post("/api/after-hours/holidays/import-national", afterHoursController.importNationalHolidays);
  app.patch("/api/after-hours/holidays/:id", afterHoursController.updateHoliday);
  app.get("/api/after-hours/reminders", afterHoursController.monitor);
  app.post("/api/after-hours/reminders/:id/reprocess", afterHoursController.reprocess);
  app.post("/api/after-hours/reminders/:id/cancel", afterHoursController.cancel);

  // Relatório de Conversas (dashboard completo, só Master) — substitui o
  // antigo relatório semanal embutido em Configurações → Conversas.
  app.get("/api/reports/access", conversationReportController.access);
  app.get("/api/reports/productivity", conversationReportController.productivity);
  app.get("/api/reports/productivity/export", conversationReportController.exportAgentsCsv);
  app.get("/api/reports/productivity/agents/:userId", conversationReportController.productivityAgent);
  app.get("/api/reports/conversations/summary", conversationReportController.summary);
  app.get("/api/reports/conversations/timeseries", conversationReportController.timeseries);
  app.get("/api/reports/conversations/status-breakdown", conversationReportController.statusBreakdown);
  app.get("/api/reports/conversations/channel-breakdown", conversationReportController.channelBreakdown);
  app.get("/api/reports/conversations/category-breakdown", conversationReportController.categoryBreakdown);
  app.get("/api/reports/conversations/company-breakdown", conversationReportController.companyBreakdown);
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
  app.post("/api/outbound/contact-warning", outboundBulkController.contactWarning);
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
  // Supervisão de equipes: vínculo Supervisor → Atendentes (Master), "Minha
  // equipe"/"Equipes", atendimentos por atendente e histórico de atendimento.
  app.get("/api/follow-ups", followUpController.list);
  app.get("/api/follow-ups/summary", followUpController.summary);
  app.get("/api/follow-ups/options", followUpController.options);
  app.post("/api/follow-ups", followUpController.create);
  app.get("/api/follow-ups/:id", followUpController.get);
  app.patch("/api/follow-ups/:id", followUpController.update);
  app.post("/api/follow-ups/:id/complete", followUpController.complete);
  app.post("/api/follow-ups/:id/cancel", followUpController.cancel);
  app.get("/api/contacts/:contactId/follow-ups", followUpController.forContact);
  app.get("/api/contacts/:contactId/profile", followUpController.profile);
  app.get("/api/contacts/:contactId/timeline", followUpController.timeline);
  app.get("/api/supervision/teams", supervisionController.teams);
  app.get("/api/supervision/users", supervisionController.searchUsers);
  app.put("/api/supervision/teams/:supervisorId/members/:memberId", supervisionController.addMember);
  app.delete("/api/supervision/teams/:supervisorId/members/:memberId", supervisionController.removeMember);
  app.get("/api/supervision/overview", supervisionController.overview);
  app.get("/api/supervision/members/:userId/conversations", supervisionController.memberConversations);
  app.get("/api/conversations/:id/assignment-timeline", supervisionController.timeline);
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
  // Biblioteca pessoal de áudios (cada atendente só vê/edita os próprios).
  app.post("/api/quick-replies/personal-audio", audioUpload, quickReplyController.createPersonalAudio);
  app.post("/api/quick-replies/managed-audio", audioUpload, quickReplyController.createManagedAudio);
  app.patch("/api/quick-replies/personal-audio/:id", audioUpload, quickReplyController.updatePersonalAudio);
  app.delete("/api/quick-replies/personal-audio/:id", quickReplyController.deletePersonalAudio);
  app.get("/api/quick-replies/:id/audio", quickReplyController.audio);
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
