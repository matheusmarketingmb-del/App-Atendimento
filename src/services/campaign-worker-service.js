// Fila de envio de Campanhas (itens 17/18/19/20/21/22) — worker em processo
// (mesmo padrão de conversation-inactivity-service.js: setInterval, sem fila
// externa nova). NUNCA dispara nada dentro de uma requisição HTTP: toda
// campanha "iniciada" só efetivamente envia quando este tick roda.
//
// Idempotência (item 21): cada CampaignContact só é reivindicado por um tick
// através de uma transição de status atômica (QUEUED -> SENDING, com a
// condição WHERE status = QUEUED); depois de enviado, o status nunca mais
// volta a QUEUED sozinho. Isso cobre tanto reentrância dentro do mesmo
// processo (guard `running`, igual ao monitor de inatividade) quanto um
// restart do servidor (linhas já SENT/FAILED/SKIPPED nunca são
// reprocessadas; linhas presas em SENDING por mais de STUCK_SENDING_MINUTES
// — processo derrubado no meio do envio — voltam a QUEUED só para tentar de
// novo, respeitando maxRetries).
const prisma = require("../database/prisma");
const { whatsappIdVariants } = require("./conversation-service");
const { getCampaignSettings } = require("./campaign-settings-service");
const { sendApprovedTemplate } = require("./meta-template-service");
const { isOptedOut } = require("./campaign-optout-service");
const channelMessageService = require("./channels/channel-message-service");
const { DEFAULT_BATCH_SIZE, DEFAULT_DELAY_BETWEEN_BATCHES_SECONDS, DEFAULT_MAX_RETRIES, STUCK_SENDING_MINUTES } = require("./campaign-constants");

// Mesma primitiva de "achar ou criar Contact+Conversation por telefone" que
// outbound-conversation-service.js usa para o botão "Nova conversa" do
// painel — aqui sem `user` (é o sistema enviando, não um atendente
// interativo): a conversa nasce sem responsável, pronta para um atendente
// assumir quando o cliente responder (item 15/16).
async function findOrCreateCampaignConversation({ phone, name, channelAccountId = null }, client = prisma) {
  // Cada número de atendimento tem a própria conversa (channelScope = id da
  // conta; LEGACY = número principal) — mesma regra do envio individual.
  const channelScope = channelAccountId || "LEGACY";
  for (const externalId of whatsappIdVariants(phone)) {
    const conversation = await client.conversation.findFirst({
      where: { channel: "META", contact: { is: { channel: "META", externalId } } },
      select: { id: true, contactId: true },
    });
    if (conversation) return await require("./whatsapp-inbox-service").findInbox(conversation.contactId, client) || conversation;
  }
  // Contato já existe com a outra grafia (com/sem 9º dígito): reaproveita.
  let knownContact = null;
  for (const externalId of whatsappIdVariants(phone)) {
    knownContact = await client.contact.findUnique({ where: { channel_externalId: { channel: "META", externalId } }, select: { id: true } });
    if (knownContact) break;
  }

  return client.$transaction(async (transaction) => {
    const contact = knownContact || await transaction.contact.upsert({
      where: { channel_externalId: { channel: "META", externalId: phone } },
      update: {},
      create: { channel: "META", externalId: phone, phone, name: name || phone },
    });
    const existing = await transaction.conversation.findUnique({
      where: { contactId_channel_channelScope: { contactId: contact.id, channel: "META", channelScope } },
      select: { id: true, contactId: true },
    });
    const root = await require("./whatsapp-inbox-service").findInbox(contact.id, transaction);
    if (root || existing) return root || await require("./whatsapp-inbox-service").attachInbox(contact.id, existing.id, transaction);
    const inserted = await transaction.conversation.create({
      data: { contactId: contact.id, channel: "META", channelScope, channelAccountId, status: "NOVO" },
      select: { id: true, contactId: true },
    });
    return require("./whatsapp-inbox-service").attachInbox(contact.id, inserted.id, transaction);
  });
}

function resolveTemplateValues(campaign, contact, template) {
  // Envio pelo painel: valores já resolvidos e validados por destinatário.
  if (contact.variableValues && typeof contact.variableValues === "object" && !Array.isArray(contact.variableValues)) {
    return Object.fromEntries(template.variables.map((variable) => [variable.key, String(contact.variableValues[variable.key] ?? "")]));
  }
  const mapping = campaign.variableMapping || {};
  const values = {};
  for (const variable of template.variables) {
    const field = mapping[variable.key];
    if (typeof field === "string" && field.startsWith("static:")) {
      values[variable.key] = field.slice(7);
    } else if (field && Object.prototype.hasOwnProperty.call(contact, field)) {
      // Item 4: nunca envia "undefined" — sempre cai no exemplo do template.
      values[variable.key] = contact[field] || variable.example || "";
    } else {
      values[variable.key] = variable.example || "";
    }
  }
  return values;
}

// Recupera linhas presas em SENDING (processo derrubado no meio do envio) —
// item 20/21.
async function recoverStuckContacts(now) {
  const cutoff = new Date(now.getTime() - STUCK_SENDING_MINUTES * 60 * 1000);
  await prisma.campaignContact.updateMany({
    where: { status: "SENDING", updatedAt: { lte: cutoff } },
    data: {
      status: "FAILED", failedAt: now,
      failureReason: "Envio interrompido com resultado externo incerto; revise antes de tentar novamente.",
    },
  });
}

async function promoteQueuedCampaigns(now) {
  await prisma.campaign.updateMany({
    where: { status: "QUEUED", OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }] },
    data: { status: "RUNNING", startedAt: now },
  });
  await prisma.campaign.updateMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: now } },
    data: { status: "RUNNING", startedAt: now },
  });
}

async function maybeCompleteCampaign(campaignId, now) {
  const pending = await prisma.campaignContact.count({
    where: { campaignId, status: { in: ["PENDING", "QUEUED", "SENDING"] } },
  });
  if (pending) return;
  await prisma.campaign.updateMany({
    where: { id: campaignId, status: "RUNNING" }, data: { status: "COMPLETED", completedAt: now },
  });
}

// Item 17: um "tick" processa até `batchSize` destinatários POR CAMPANHA em
// RUNNING — nunca todos de uma vez, nunca fora deste worker.
function retryIsReady(contact, now, baseDelaySeconds) {
  if (!contact.retryCount) return true;
  const backoffSeconds = baseDelaySeconds * (2 ** Math.min(contact.retryCount - 1, 8));
  return contact.updatedAt.getTime() <= now.getTime() - backoffSeconds * 1000;
}

// Item 17: um "tick" processa até `batchSize` destinatários POR CAMPANHA.
// Cada linha é reivindicada individualmente logo antes do envio: dois
// processos podem enxergar o mesmo candidato, mas só um consegue mudar seu
// status para SENDING. O master switch e o status da campanha são revistos
// antes de cada destinatário, permitindo pausar/cancelar sem continuar o lote.
async function processCampaign(campaign, channel, now) {
  const settings = await getCampaignSettings();
  const batchSize = campaign.batchSize || settings.defaultBatchSize || DEFAULT_BATCH_SIZE;
  const delaySeconds = campaign.delayBetweenBatchesSeconds || settings.defaultDelayBetweenBatchesSeconds || DEFAULT_DELAY_BETWEEN_BATCHES_SECONDS;
  const maxRetries = campaign.maxRetries ?? settings.defaultMaxRetries ?? DEFAULT_MAX_RETRIES;

  if (campaign.lastBatchAt && now.getTime() - campaign.lastBatchAt.getTime() < delaySeconds * 1000) return;

  const available = await prisma.campaignContact.findMany({
    where: { campaignId: campaign.id, status: { in: ["PENDING", "QUEUED"] }, isTest: false },
    orderBy: { createdAt: "asc" }, take: Math.min(batchSize * 4, 2000),
  });
  const candidates = available.filter((contact) => retryIsReady(contact, now, delaySeconds)).slice(0, batchSize);
  if (!candidates.length) { await maybeCompleteCampaign(campaign.id, now); return; }

  // Número remetente do lote (multi-número). Antes o worker sempre usava o
  // número principal, mesmo com a campanha apontando para outra conta.
  let senderChannel = channel;
  if (campaign.channelAccountId) {
    try {
      senderChannel = (await channelMessageService.adapterFor("META", campaign.channelAccountId)).channel;
    } catch (error) {
      console.error(`[CAMPAIGN_WORKER] número remetente indisponível para a campanha ${campaign.id} (tenta no próximo tick)`, error.message);
      return;
    }
  }

  let templates = [];
  let template = null;
  try {
    const { listApprovedTemplates } = require("./meta-template-service");
    templates = await listApprovedTemplates(senderChannel);
    template = templates.find((item) => item.name === campaign.templateName && item.language === campaign.templateLanguage);
  } catch (error) {
    console.error("[CAMPAIGN_WORKER] falha ao consultar templates da Meta (nenhum contato reivindicado)", error.message);
    return;
  }
  const perContactTemplates = campaign.origin === "PANEL";
  const approvedTemplate = (name, language) => {
    const found = templates.find((item) => item.name === name && item.language === language);
    return found && found.status === "APPROVED" && found.supported !== false ? found : null;
  };
  if (!perContactTemplates && (!template || template.status !== "APPROVED")) {
    await prisma.campaignContact.updateMany({
      where: { campaignId: campaign.id, status: { in: ["PENDING", "QUEUED"] } },
      data: { status: "FAILED", failedAt: now, failureReason: "Template não está mais aprovado na Meta." },
    });
    await prisma.campaign.updateMany({ where: { id: campaign.id, status: "RUNNING" }, data: { status: "FAILED", failedAt: now } });
    return;
  }

  let claimedAny = false;
  for (const contact of candidates) {
    const [currentSettings, currentCampaign] = await Promise.all([
      getCampaignSettings(),
      prisma.campaign.findUnique({ where: { id: campaign.id }, select: { status: true } }),
    ]);
    if (!currentSettings.massMessagingEnabled || currentCampaign?.status !== "RUNNING") break;

    const claim = await prisma.campaignContact.updateMany({
      where: { id: contact.id, status: { in: ["PENDING", "QUEUED"] } }, data: { status: "SENDING" },
    });
    if (claim.count !== 1) continue;
    claimedAny = true;

    try {
      if (contact.optOut || await isOptedOut(contact.phone)) {
        await prisma.campaignContact.updateMany({ where: { id: contact.id, status: "SENDING" }, data: { status: "OPTED_OUT" } });
        continue;
      }
      const stillRunning = await prisma.campaign.findFirst({ where: { id: campaign.id, status: "RUNNING" }, select: { id: true } });
      const switchStillOn = (await getCampaignSettings()).massMessagingEnabled;
      if (!stillRunning || !switchStillOn) {
        await prisma.campaignContact.updateMany({ where: { id: contact.id, status: "SENDING" }, data: { status: "PENDING" } });
        break;
      }

      // Template por destinatário (envio pelo painel); senão, o da campanha.
      const templateName = contact.templateName || campaign.templateName;
      const templateLanguage = contact.templateLanguage || campaign.templateLanguage;
      const contactTemplate = perContactTemplates ? approvedTemplate(templateName, templateLanguage) : template;
      if (!contactTemplate) {
        // Só este destinatário falha — o restante do lote continua.
        await prisma.campaignContact.updateMany({
          where: { id: contact.id, status: "SENDING" },
          data: { status: "FAILED", failedAt: now, failureReason: `Template "${templateName}" não está mais aprovado na Meta.` },
        });
        continue;
      }
      const conversation = await findOrCreateCampaignConversation({
        phone: contact.phone, name: contact.fullName || contact.firstName, channelAccountId: campaign.channelAccountId || null,
      });
      const values = resolveTemplateValues(campaign, contact, contactTemplate);
      const result = await sendApprovedTemplate({
        conversationId: conversation.id, name: templateName, language: templateLanguage,
        values, sentByUserId: campaign.origin === "PANEL" ? campaign.createdByUserId : null, channel: senderChannel, requestedAccountId: campaign.channelAccountId || "legacy",
      });
      await prisma.campaignContact.updateMany({
        where: { id: contact.id, status: "SENDING" },
        data: {
          status: "SENT", sentAt: now, externalMessageId: result.message.externalId,
          contactId: conversation.contactId, prospectStatus: contact.prospectStatus === "NEW" ? "CONTACTED" : contact.prospectStatus,
        },
      });
      await prisma.conversation.updateMany({
        where: { id: conversation.id, originCampaignId: null },
        data: { originSource: "OUTBOUND_CAMPAIGN", originCampaignId: campaign.id, originCampaignContactId: contact.id },
      });
    } catch (error) {
      const retryCount = contact.retryCount + 1;
      const willRetry = retryCount <= maxRetries;
      await prisma.campaignContact.updateMany({
        where: { id: contact.id, status: "SENDING" },
        data: willRetry
          ? { status: "QUEUED", retryCount, failureReason: error.message }
          : { status: "FAILED", failedAt: now, failureReason: error.message, retryCount },
      });
    }
  }

  if (claimedAny) {
    await prisma.campaign.updateMany({ where: { id: campaign.id, status: "RUNNING" }, data: { lastBatchAt: now } });
  }
  await maybeCompleteCampaign(campaign.id, now);
}
async function runCampaignSendTick(channel, now = new Date()) {
  const settings = await getCampaignSettings();
  // Item 31/32: master switch OFF -> nenhum envio real acontece, mesmo com
  // campanhas RUNNING/QUEUED/agendadas.
  if (!settings.massMessagingEnabled) return { processed: 0, blocked: true };

  await recoverStuckContacts(now);
  await promoteQueuedCampaigns(now);

  const running = await prisma.campaign.findMany({ where: { status: "RUNNING" }, orderBy: { startedAt: "asc" } });
  for (const campaign of running) {
    try {
      await processCampaign(campaign, channel, now);
    } catch (error) {
      console.error(`[CAMPAIGN_WORKER] falha ao processar campanha ${campaign.id} (ignorada, tenta de novo no próximo tick)`, error.message);
    }
  }
  return { processed: running.length, blocked: false };
}

function startCampaignWorker({ channel, intervalMs, onChange }) {
  const settingsPromise = getCampaignSettings();
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await settingsPromise;
      const result = await runCampaignSendTick(channel);
      if (result.processed) onChange?.(result.processed);
    } catch (error) {
      console.error("[CAMPAIGN_WORKER] erro no tick (ignorado)", error.message);
    } finally {
      running = false;
    }
  };
  run();
  const timer = setInterval(run, intervalMs || DEFAULT_DELAY_BETWEEN_BATCHES_SECONDS * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  findOrCreateCampaignConversation, processCampaign, runCampaignSendTick, startCampaignWorker,
};
