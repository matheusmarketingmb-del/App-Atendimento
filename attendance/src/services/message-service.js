const prisma = require("../database/prisma");
const { recordAssignmentChange } = require("./assignment-period-service");
const { findOrCreateMetaConversation } = require("./conversation-service");
const whatsappAccounts = require("./whatsapp-account-service");
const { removeImage, storeAudio, storeDocument, storeImage, storeSticker, storeVideo } = require("./media-storage-service");
const { formatTeamMessage } = require("./team-message-formatter");
const { normalizeOutgoingAudio } = require("./audio-normalization-service");
const { getConversationSettings } = require("./conversation-settings-service");
const channelMessageService = require("./channels/channel-message-service");
const whatsappInbox = require("./whatsapp-inbox-service");
const { buildPublicMediaUrl } = require("./channels/social-media-link-service");
const statuses = { sent: "ENVIADA", delivered: "ENTREGUE", read: "LIDA", failed: "FALHOU" };
// Status de onde cada evento pode avançar (inclui o próprio: evento repetido é inócuo).
const STATUS_FROM = {
  ENVIADA: ["PENDENTE", "ENVIADA"],
  ENTREGUE: ["PENDENTE", "ENVIADA", "ENTREGUE", "FALHOU"],
  LIDA: ["PENDENTE", "ENVIADA", "ENTREGUE", "LIDA", "FALHOU"],
  FALHOU: ["PENDENTE", "ENVIADA", "FALHOU"],
};
const chatMessages = () => require("./chat-message-service");
const replyContext = (replyTo) => (replyTo ? { contextMessageId: replyTo.wamid } : {});
const closingMessage = "Agradecemos pelo seu contato. Se precisar de qualquer ajuda, estamos à disposição. Você pode voltar a falar conosco quando quiser.";

// `account` = ChannelAccount (número) que recebeu — define a empresa.
async function saveIncoming(event, account = null) {
  try {
    // Fora da transação: leitura de config só (cacheada), não precisa do
    // isolamento da transação abaixo.
    // Reabertura segue a configuração da empresa do número que recebeu.
    account = account || (event.channelAccountId ? await prisma.channelAccount.findUnique({ where: { id: event.channelAccountId } }) : await whatsappAccounts.getLegacyAccount());
    const companyId = account?.companyId || null;
    const settings = await getConversationSettings(prisma, companyId);
    const saved = await prisma.$transaction(async (tx) => {
      const existing = await tx.message.findUnique({ where: { externalId: event.externalId } });
      if (existing) return { message: existing, duplicate: true };
      const { contact, conversation } = await findOrCreateMetaConversation(event, tx, account);
      const mediaStore = ({ audio: storeAudio, video: storeVideo, sticker: storeSticker, document: storeDocument })[event.type] || storeImage;
      const media = event.mediaBuffer ? await mediaStore({
        buffer: event.mediaBuffer, mimeType: event.mediaMimeType,
        fileName: event.mediaFileName, stableId: event.externalId,
      }) : null;
      const replyFields = await chatMessages().inboundReplyFields(tx, { replyToExternalId: event.replyToExternalId, contactId: contact.id, channelAccountId: event.channelAccountId || null });
      const message = await tx.message.create({ data: {
        conversationId: conversation.id, externalId: event.externalId, channel: "META", channelAccountId: event.channelAccountId || null,
        direction: "RECEBIDA", status: "RECEBIDA", type: event.type, text: event.text, ...replyFields,
        mediaStorageKey: media?.storageKey, mediaMimeType: media?.mimeType,
        mediaFileName: media?.fileName, mediaSize: media?.size,
        occurredAt: event.occurredAt, rawPayload: event.rawPayload,
      } });
      if (event.type !== "reaction") {
        await tx.conversation.update({ where: { id: conversation.id }, data: {
          unreadCount: { increment: 1 }, lastMessageAt: event.occurredAt,
          ...(!conversation.categoryId && !conversation.assignedUserId ? { channelAccountId: event.channelAccountId || null } : {}),
        } });
        // Reabertura de conversa finalizada (itens 7 e 8): só reabre se a
        // conversa realmente estava FINALIZADO (evita gravar atividade em
        // toda mensagem) e se o toggle central estiver ligado. Se houver uma
        // janela configurada e a conversa tiver finalizado há mais tempo que
        // ela, não reabre — fica como está, sem criar conversa nova (fora de
        // escopo, ver plano item 8).
        if (!conversation.archivedAt && conversation.status === "FINALIZADO" && settings.reopenConversationOnCustomerMessage) {
          const withinWindow = !settings.reopenWindowMinutes || !conversation.finalizedAt
            || (event.occurredAt.getTime() - conversation.finalizedAt.getTime()) <= settings.reopenWindowMinutes * 60 * 1000;
          if (withinWindow) {
            const retainedCategoryId = await require('./preferred-category-service').retainedCategory(tx, { contact, conversation });
            const reopened = await tx.conversation.updateMany({
              where: { id: conversation.id, archivedAt:null, status: "FINALIZADO", categoryId: conversation.categoryId, assignedUserId: conversation.assignedUserId },
              data: { categoryId: retainedCategoryId, assignedUserId: null, status: "NOVO", finalizedAt: null,
                ...(retainedCategoryId ? {} : { whatsappSendAccountId: null, channelAccountId: event.channelAccountId || null }) },
            });
            if (reopened.count) {
              // Reabertura limpa o responsável: encerra o período em aberto.
              await recordAssignmentChange(tx, { conversationId: conversation.id, toUserId: null, at: event.occurredAt, reason: "REOPENED" });
              await tx.conversationActivity.create({ data: {
                conversationId: conversation.id, action: "REOPENED_BY_CUSTOMER_MESSAGE",
                details: { reopenWindowMinutes: settings.reopenWindowMinutes || null, retainedCategoryId },
              } });
            }
          }
        }
        // Item 8: nova mensagem do cliente em conversa ativa (já assumida,
        // aguardando o cliente, ou aguardando a equipe pegar um handoff do
        // Bot) sempre volta para AGUARDANDO_EQUIPE — nunca mexe em NOVO
        // (ainda não assumida) nem BOT (fluxo de triagem em andamento).
        await tx.conversation.updateMany({
          where: { id: conversation.id, archivedAt:null, status: { in: ["EM_ATENDIMENTO", "AGUARDANDO_EQUIPE", "AGUARDANDO_CLIENTE", "HANDOFF_BOT"] } },
          data: { status: "AGUARDANDO_EQUIPE" },
        });
      }
      return { message, duplicate: false, archived:Boolean(conversation.archivedAt) };
    });
    // Falha aqui não pode perder o evento: a mensagem bruta já está salva.
    if (!saved.duplicate && event.type === "reaction") {
      await chatMessages().applyInboundReaction({ event, conversationId: saved.message.conversationId })
        .catch((reactionError) => console.error("[REACTION] falha ao registrar reação recebida:", reactionError.message));
    }
    return saved;
  } catch (error) {
    if (error.code === "P2002" && event.externalId) {
      const message = await prisma.message.findUnique({ where: { externalId: event.externalId } });
      if (message) return { message, duplicate: true };
    }
    throw error;
  }
}

async function updateStatus(event) {
  if (!statuses[event.status]) return null;
  const externalIds = [event.externalId, ...(event.channelAccountId ? [`${event.channelAccountId}:${event.externalId}`] : [])];
  // Workspaces: o status só atualiza mensagens do MESMO número que o
  // reportou — um evento de entrega de uma empresa nunca toca a outra.
  let accountScope = { channelAccountId: event.channelAccountId };
  if (!event.channelAccountId) {
    // Número original (.env): mensagens sem conta ou da conta legada.
    const legacy = await require("./whatsapp-account-service").getLegacyAccount();
    accountScope = legacy ? { OR: [{ channelAccountId: null }, { channelAccountId: legacy.id }] } : { channelAccountId: null };
  }
  // Nunca regride: a Meta pode entregar "delivered" depois de "read" (ou
  // "sent" atrasado). Falha só vale antes da entrega confirmada.
  const target = statuses[event.status];
  const from = STATUS_FROM[target];
  return prisma.message.updateMany({ where: { externalId: { in: externalIds }, ...accountScope, status: { in: from } }, data: { status: target } });
}

// `keepAssignee`: a mensagem não muda o responsável (ex.: despedida enviada
// na finalização por um Supervisor — quem finaliza não "assume" a conversa,
// nem gera transferência automática que distorce a produtividade).
async function updateConversationAfterSending({ conversationId, sentByUserId, occurredAt, keepAssignee = false }) {
  // Fora do expediente: resposta de uma pessoa da equipe encerra o ciclo de
  // espera — lembrete pendente é cancelado (o worker também reconfere).
  if (sentByUserId) await require("./after-hours-reminder-service").cancelSafely(conversationId, "HUMAN_REPLIED");
  return prisma.$transaction(async (transaction) => {
    const current = await transaction.conversation.findUnique({
      where: { id: conversationId },
      select: {
        categoryId: true,
        archivedAt: true,
        status: true,
        assignedUserId: true,
        assignedUser: {
          select: {
            name: true,
          },
        },
      },
    });

    const updated = await transaction.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: occurredAt,
        // Item 8: a empresa/Bot acabou de responder — a última mensagem
        // válida agora é nossa, então a conversa vira AGUARDANDO_CLIENTE
        // (antes ficava em EM_ATENDIMENTO, mesmo valor usado só para "o
        // atendente assumiu, ainda não respondeu" — agora diferenciados).
        status: "AGUARDANDO_CLIENTE",
        finalizedAt: null,
        // SLA de primeira resposta (item 1) e de resposta durante
        // atendimento (item 2): a empresa acabou de responder, então nenhum
        // dos dois indicadores de atraso se aplica mais a esta conversa.
        firstResponseSlaBreached: false,
        responseSlaBreached: false,
        ...(sentByUserId && !keepAssignee ? { assignedUserId: sentByUserId } : {}),
      },
    });

    if (!sentByUserId || keepAssignee) return false;
    if (current) await require("./sincrofit-atacado-owner-service").setOwnerOnReply(transaction, {
      before: current, after: updated, actorId: sentByUserId,
    });

    // Período de responsabilidade de quem enviou (idempotente: se já está em
    // aberto, nada muda). Cobre também a conversa criada já atribuída
    // (Nova conversa por WhatsApp/e-mail) e envios do painel.
    await recordAssignmentChange(transaction, {
      conversationId, toUserId: sentByUserId, at: occurredAt || new Date(),
      reason: current?.assignedUserId && current.assignedUserId !== sentByUserId ? "TRANSFERRED" : current?.assignedUserId ? "ASSIGNED" : "REPLIED",
      endReason: "TRANSFERRED",
    });

    if (current?.assignedUserId === sentByUserId) {
      return false;
    }

    const sender = await transaction.user.findUnique({
      where: { id: sentByUserId },
      select: { name: true },
    });

    await transaction.conversationActivity.create({
      data: {
        conversationId,
        // Mesmo horário do período aberto acima (linha do tempo coerente).
        ...(occurredAt ? { createdAt: occurredAt } : {}),
        actorUserId: sentByUserId,
        action: current?.assignedUserId
          ? "CONVERSATION_TRANSFERRED"
          : "CONVERSATION_CLAIMED",
        details: {
          from: current?.assignedUser?.name || "Sem responsável",
          to: sender?.name || "Atendente",
          fromUserId: current?.assignedUserId || null,
          toUserId: sentByUserId,
          automatic: true,
        },
      },
    });

    return true;
  });
}

function replySubject(value) {
  const subject = String(value || "Atendimento Mibro").trim();
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

async function emailReplyContext(conversation) {
  if (!conversation.channelAccountId || !conversation.contact?.email) {
    throw Object.assign(new Error("A conversa não possui conta ou destinatário de e-mail válido."), { statusCode: 400 });
  }
  const latest = await prisma.message.findFirst({
    where: { conversationId: conversation.id, direction: "RECEBIDA" },
    orderBy: { occurredAt: "desc" },
    select: { rawPayload: true },
  });
  const metadata = latest?.rawPayload && typeof latest.rawPayload === "object" ? latest.rawPayload : {};
  const inReplyTo = metadata.messageId || null;
  return {
    to: conversation.contact.email,
    subject: replySubject(metadata.subject),
    inReplyTo,
    references: [metadata.references, inReplyTo].filter(Boolean).join(" ") || null,
    threadId: conversation.externalConversationId || metadata.threadId || null,
  };
}

async function sendMetaForConversation(conversation, legacyChannel, method, payload, options) {
  if (!conversation.channelAccountId) return options ? legacyChannel[method](conversation.contact.phone, payload, options) : legacyChannel[method](conversation.contact.phone, payload);
  if (method === "sendText") {
    return channelMessageService.send({ channel: "META", channelAccountId: conversation.channelAccountId, kind: "text", to: conversation.contact.phone, text: payload, ...(options || {}) });
  }
  if (method === "sendSticker") {
    return channelMessageService.send({ channel: "META", channelAccountId: conversation.channelAccountId, kind: "sticker", to: conversation.contact.phone, ...payload });
  }
  const type = { sendImage: "image", sendVideo: "video", sendDocument: "document", sendAudio: "audio" }[method];
  return channelMessageService.send({ channel: "META", channelAccountId: conversation.channelAccountId, kind: "media", type, to: conversation.contact.phone, ...payload });

}

const SOCIAL_CHANNELS = Object.freeze(["INSTAGRAM_DIRECT", "INSTAGRAM_COMMENTS", "FACEBOOK_MESSENGER", "FACEBOOK_COMMENTS"]);
const SOCIAL_COMMENT_CHANNELS = Object.freeze(["INSTAGRAM_COMMENTS", "FACEBOOK_COMMENTS"]);

// Igual a emailReplyContext acima, mas para Instagram/Facebook (item 3/9 do
// plano Social): DM responde ao remetente (PSID/IGSID), comentário responde
// ao COMENTÁRIO ORIGINAL mais recente da thread (nunca ao post em si — a
// Graph API não permite "comentar no post" por aqui, só responder a um
// comentário existente). Os dois IDs vêm de rawPayload da última mensagem
// RECEBIDA (mesmo padrão do e-mail), nunca de Contact.externalId (que leva
// o prefixo channelScope: e não é o ID cru esperado pela Graph API).
async function socialReplyContext(conversation) {
  if (!conversation.channelAccountId) {
    throw Object.assign(new Error("A conversa não possui conta de canal social configurada."), { statusCode: 400 });
  }
  const latest = await prisma.message.findFirst({
    where: { conversationId: conversation.id, direction: "RECEBIDA" },
    orderBy: { occurredAt: "desc" },
    select: { rawPayload: true },
  });
  const metadata = latest?.rawPayload && typeof latest.rawPayload === "object" ? latest.rawPayload : {};
  if (SOCIAL_COMMENT_CHANNELS.includes(conversation.channel)) {
    if (!metadata.externalMessageId) {
      throw Object.assign(new Error("Não foi possível localizar o comentário original para responder publicamente."), { statusCode: 409 });
    }
    return { commentId: metadata.externalMessageId };
  }
  if (!metadata.senderExternalId) {
    throw Object.assign(new Error("Não foi possível localizar o destinatário da mensagem direta."), { statusCode: 409 });
  }
  return { to: metadata.senderExternalId };
}

// Graph API usa "image"/"video"/"file" no attachment (ver
// meta-graph-messaging.js) — nossos tipos internos usam "document" para
// arquivo genérico, daí o mapeamento explícito (nunca adivinhar).
const SOCIAL_MEDIA_GRAPH_TYPE = Object.freeze({ image: "image", video: "video", document: "file" });

// Item 46 do plano Social — Direct/Messenger não aceitam upload de buffer
// como o WhatsApp, só uma URL pública (ver social-media-link-service.js).
// Comentários (canSendMedia: false na capability matrix) são recusados pelo
// próprio channelMessageService.send antes de chegar aqui.
async function sendSocialMedia({ conversation, buffer, mimeType, fileName, caption, sentByUserId, type, store }) {
  const cleanCaption = caption?.trim() || null;
  const socialContext = await socialReplyContext(conversation);
  const media = await store({ buffer, mimeType, fileName });
  let result;
  try {
    const publicUrl = buildPublicMediaUrl(media.storageKey);
    result = await channelMessageService.send({
      channel: conversation.channel, channelAccountId: conversation.channelAccountId, kind: "media",
      ...socialContext, type: SOCIAL_MEDIA_GRAPH_TYPE[type] || "file", url: publicUrl,
    });
  } catch (error) {
    await removeImage(media.storageKey);
    throw error;
  }
  const occurredAt = new Date();
  const providerExternalId = result.externalId ? `${conversation.channelAccountId}:${result.externalId}` : null;
  const message = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId: providerExternalId, channel: conversation.channel,
    channelAccountId: conversation.channelAccountId, direction: "ENVIADA", status: "ENVIADA", type, text: cleanCaption,
    mediaStorageKey: media.storageKey, mediaMimeType: media.mimeType, mediaFileName: media.fileName, mediaSize: media.size,
    occurredAt, sentByUserId: sentByUserId || null, rawPayload: result.data || null,
  } });
  await updateConversationAfterSending({ conversationId: conversation.id, sentByUserId, occurredAt });
  return { message, providerData: result.data };
}

// Multiempresa: o WhatsApp sempre responde pelo número da própria conversa
// (nunca pelo número "padrão" do .env quando a conversa é de outro número).
async function metaSender(channel, conversation) {
  return whatsappAccounts.senderFor(channel, await whatsappAccounts.accountForConversation(conversation));
}

async function sendText({ conversationId, text, sentByUserId, channel, keepAssignee = false, crmProposal = null, beforeProviderSend = async () => {}, replyTo = null, forwardedFromMessageId = null }) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { contact: true, channelAccount: true, category: { include: { parent: true } } } });
  if (!conversation) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
  if(conversation.archivedAt)throw Object.assign(new Error('Recupere a conversa arquivada antes de enviar mensagens.'),{statusCode:409,code:'CONVERSATION_ARCHIVED'});
  let result;
  let providerText = text;
  let emailContext = null;
  if (conversation.channel === "EMAIL") {
    emailContext = await emailReplyContext(conversation);
    await beforeProviderSend();
    result = await channelMessageService.send({
      channel: "EMAIL", channelAccountId: conversation.channelAccountId, kind: "text",
      ...emailContext, text,
    });
  } else if (conversation.channel === "META") {
    await whatsappInbox.applySender(conversation, sentByUserId);
    await chatMessages().assertReplySender(replyTo, conversation);
    if(crmProposal?.originConversationId && (crmProposal.originConversationId!==conversationId || crmProposal.originChannelAccountId!==(conversation.channelAccountId||null))) {
      throw Object.assign(new Error('O número de origem da proposta mudou. Volte ao CRM e prepare o envio novamente.'),{statusCode:409});
    }
    await require("./meta-template-service").assertFreeFormAllowed(conversationId, new Date(), conversation.channelAccountId);
    providerText = formatTeamMessage(conversation.category, text);
    if (providerText.length > 4096) {
      throw Object.assign(new Error("A mensagem ficou acima do limite após adicionar o nome da equipe."), { statusCode: 400 });
    }
    await beforeProviderSend();
    result = await sendMetaForConversation(conversation, channel, "sendText", providerText, replyTo ? replyContext(replyTo) : undefined);
  } else if (SOCIAL_CHANNELS.includes(conversation.channel)) {
    const socialContext = await socialReplyContext(conversation);
    await beforeProviderSend();
    result = await channelMessageService.send({
      channel: conversation.channel, channelAccountId: conversation.channelAccountId, kind: "text",
      ...socialContext, text,
    });
  } else {
    throw Object.assign(new Error("Este canal ainda não está liberado para respostas pela Central."), { statusCode: 409 });
  }
  const occurredAt = new Date();
  // WhatsApp grava o wamid cru (os status do webhook procuram por ele); só os
  // demais canais prefixam com a conta.
  const providerExternalId = result.externalId
    ? (conversation.channelAccountId && conversation.channel !== "META" ? `${conversation.channelAccountId}:${result.externalId}` : result.externalId)
    : null;
  const message = await prisma.message.create({ data: {
    conversationId, externalId: providerExternalId, channel: conversation.channel,
    channelAccountId: conversation.channelAccountId || null, direction: "ENVIADA",
    status: "ENVIADA", type: "text", text, occurredAt, sentByUserId: sentByUserId || null,
    ...chatMessages().replyFields(replyTo), ...(forwardedFromMessageId ? { forwardedFromMessageId } : {}),
    rawPayload: conversation.channel === "EMAIL"
      ? { providerMessage: result.data || null, subject: emailContext.subject, threadId: result.data?.threadId || emailContext.threadId }
      : crmProposal ? {providerMessage:result.data||null,crmProposal} : result.data,
  } });
  if (conversation.channel === "EMAIL" && result.data?.threadId && result.data.threadId !== conversation.externalConversationId) {
    await prisma.conversation.update({ where: { id: conversationId }, data: { externalConversationId: result.data.threadId } });
  }
  await updateConversationAfterSending({ conversationId, sentByUserId, occurredAt, keepAssignee });
  return { message, providerData: result.data };
}
async function sendEmailMedia({ conversation, buffer, mimeType, fileName, caption, sentByUserId, type, store }) {
  const cleanCaption = caption?.trim() || null;
  const media = await store({ buffer, mimeType, fileName });
  const emailContext = await emailReplyContext(conversation);
  let result;
  try {
    result = await channelMessageService.send({
      channel: "EMAIL", channelAccountId: conversation.channelAccountId, kind: "media",
      ...emailContext, text: cleanCaption || "", attachments: [{ buffer, mimeType: media.mimeType, filename: media.fileName }],
    });
  } catch (error) {
    await removeImage(media.storageKey);
    throw error;
  }
  const occurredAt = new Date();
  const externalId = result.externalId ? `${conversation.channelAccountId}:${result.externalId}` : null;
  const message = await prisma.message.create({ data: {
    conversationId: conversation.id, externalId, channel: "EMAIL", channelAccountId: conversation.channelAccountId,
    direction: "ENVIADA", status: "ENVIADA", type, text: cleanCaption,
    mediaStorageKey: media.storageKey, mediaMimeType: media.mimeType, mediaFileName: media.fileName, mediaSize: media.size,
    occurredAt, sentByUserId: sentByUserId || null,
    rawPayload: { providerMessage: result.data || null, subject: emailContext.subject, threadId: result.data?.threadId || emailContext.threadId },
  } });
  if (result.data?.threadId && result.data.threadId !== conversation.externalConversationId) {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { externalConversationId: result.data.threadId } });
  }
  await updateConversationAfterSending({ conversationId: conversation.id, sentByUserId, occurredAt });
  return { message, providerData: result.data };
}
async function sendImage({ conversationId, buffer, mimeType, fileName, caption, sentByUserId, channel, replyTo = null, storedMedia = null, forwardedFromMessageId = null }) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { contact: true, channelAccount: true, category: { include: { parent: true } } } });
  if (!conversation) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
  if(conversation.archivedAt)throw Object.assign(new Error('Recupere a conversa arquivada antes de enviar mensagens.'),{statusCode:409,code:'CONVERSATION_ARCHIVED'});
  if (conversation.channel === "EMAIL") {
    return sendEmailMedia({ conversation, buffer, mimeType, fileName, caption, sentByUserId, type: "image", store: storeImage });
  }
  if (SOCIAL_CHANNELS.includes(conversation.channel)) {
    return sendSocialMedia({ conversation, buffer, mimeType, fileName, caption, sentByUserId, type: "image", store: storeImage });
  }
  if (conversation.channel !== "META") throw Object.assign(new Error("Este canal ainda não está liberado para anexos pela Central."), { statusCode: 409 });
  await whatsappInbox.applySender(conversation, sentByUserId);
  await chatMessages().assertReplySender(replyTo, conversation);
  await require("./meta-template-service").assertFreeFormAllowed(conversationId, new Date(), conversation.channelAccountId);
  const cleanCaption = caption?.trim() || null;
  const providerCaption = formatTeamMessage(conversation.category, cleanCaption || "");
  if (providerCaption.length > 1024) {
    throw Object.assign(new Error("A legenda ficou acima do limite após adicionar o nome da equipe."), { statusCode: 400 });
  }
  const media = storedMedia || await storeImage({ buffer, mimeType, fileName });
  let result;
  try {
    result = await sendMetaForConversation(conversation, channel, "sendImage", {
      buffer, mimeType, fileName: media.fileName, caption: providerCaption || null, ...replyContext(replyTo),
    });
  } catch (error) {
    if (!storedMedia) await removeImage(media.storageKey);
    throw error;
  }
  const occurredAt = new Date();
  const message = await prisma.message.create({ data: {
    conversationId, externalId: conversation.channelAccountId && result.externalId ? `${conversation.channelAccountId}:${result.externalId}` : result.externalId, channel: conversation.channel, channelAccountId: conversation.channelAccountId || null, direction: "ENVIADA",
    status: "ENVIADA", type: "image", text: cleanCaption,
    mediaStorageKey: media.storageKey, mediaMimeType: media.mimeType,
    mediaFileName: media.fileName, mediaSize: media.size,
    occurredAt, sentByUserId: sentByUserId || null,
    rawPayload: { message: result.data, mediaId: result.mediaId },
    ...chatMessages().replyFields(replyTo), ...(forwardedFromMessageId ? { forwardedFromMessageId } : {}),
  } });
  await updateConversationAfterSending({ conversationId, sentByUserId, occurredAt });
  return { message, providerData: result.data };
}

async function sendVideo({ conversationId, buffer, mimeType, fileName, caption, sentByUserId, channel, replyTo = null, storedMedia = null, forwardedFromMessageId = null, beforeProviderSend }) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { contact: true, channelAccount: true, category: { include: { parent: true } } } });
  if (!conversation) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
  if(conversation.archivedAt)throw Object.assign(new Error('Recupere a conversa arquivada antes de enviar mensagens.'),{statusCode:409,code:'CONVERSATION_ARCHIVED'});
  if (conversation.channel === "EMAIL") {
    return sendEmailMedia({ conversation, buffer, mimeType, fileName, caption, sentByUserId, type: "video", store: storeVideo });
  }
  if (SOCIAL_CHANNELS.includes(conversation.channel)) {
    return sendSocialMedia({ conversation, buffer, mimeType, fileName, caption, sentByUserId, type: "video", store: storeVideo });
  }
  if (conversation.channel !== "META") throw Object.assign(new Error("Este canal ainda não está liberado para anexos pela Central."), { statusCode: 409 });
  await whatsappInbox.applySender(conversation, sentByUserId);
  await chatMessages().assertReplySender(replyTo, conversation);
  await require("./meta-template-service").assertFreeFormAllowed(conversationId, new Date(), conversation.channelAccountId);
  const cleanCaption = caption?.trim() || null;
  const providerCaption = formatTeamMessage(conversation.category, cleanCaption || "");
  if (providerCaption.length > 1024) {
    throw Object.assign(new Error("A legenda ficou acima do limite após adicionar o nome da equipe."), { statusCode: 400 });
  }
  const media = storedMedia || await storeVideo({ buffer, mimeType, fileName });
  let result;
  try {
    await beforeProviderSend?.();
    result = await sendMetaForConversation(conversation, channel, "sendVideo", {
      buffer, mimeType: media.mimeType, fileName: media.fileName, caption: providerCaption || null, ...replyContext(replyTo),
    });
  } catch (error) {
    if (!storedMedia) await removeImage(media.storageKey);
    throw error;
  }
  const occurredAt = new Date();
  const message = await prisma.message.create({ data: {
    conversationId, externalId: conversation.channelAccountId && result.externalId ? `${conversation.channelAccountId}:${result.externalId}` : result.externalId, channel: conversation.channel, channelAccountId: conversation.channelAccountId || null, direction: "ENVIADA",
    status: "ENVIADA", type: "video", text: cleanCaption,
    mediaStorageKey: media.storageKey, mediaMimeType: media.mimeType,
    mediaFileName: media.fileName, mediaSize: media.size,
    occurredAt, sentByUserId: sentByUserId || null,
    rawPayload: { message: result.data, mediaId: result.mediaId },
    ...chatMessages().replyFields(replyTo), ...(forwardedFromMessageId ? { forwardedFromMessageId } : {}),
  } });
  await updateConversationAfterSending({ conversationId, sentByUserId, occurredAt });
  return { message, providerData: result.data };
}

async function sendDocument({ conversationId, buffer, mimeType, fileName, caption, sentByUserId, channel, replyTo = null, storedMedia = null, forwardedFromMessageId = null }) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { contact: true, channelAccount: true, category: { include: { parent: true } } } });
  if (!conversation) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
  if(conversation.archivedAt)throw Object.assign(new Error('Recupere a conversa arquivada antes de enviar mensagens.'),{statusCode:409,code:'CONVERSATION_ARCHIVED'});
  if (conversation.channel === "EMAIL") {
    return sendEmailMedia({ conversation, buffer, mimeType, fileName, caption, sentByUserId, type: "document", store: storeDocument });
  }
  if (SOCIAL_CHANNELS.includes(conversation.channel)) {
    return sendSocialMedia({ conversation, buffer, mimeType, fileName, caption, sentByUserId, type: "document", store: storeDocument });
  }
  if (conversation.channel !== "META") throw Object.assign(new Error("Este canal ainda não está liberado para anexos pela Central."), { statusCode: 409 });
  await whatsappInbox.applySender(conversation, sentByUserId);
  await chatMessages().assertReplySender(replyTo, conversation);
  await require("./meta-template-service").assertFreeFormAllowed(conversationId, new Date(), conversation.channelAccountId);
  const cleanCaption = caption?.trim() || null;
  const providerCaption = formatTeamMessage(conversation.category, cleanCaption || "");
  if (providerCaption.length > 1024) {
    throw Object.assign(new Error("A legenda ficou acima do limite após adicionar o nome da equipe."), { statusCode: 400 });
  }
  const media = storedMedia || await storeDocument({ buffer, mimeType, fileName });
  let result;
  try {
    result = await sendMetaForConversation(conversation, channel, "sendDocument", {
      buffer, mimeType: media.mimeType, fileName: media.fileName, caption: providerCaption || null, ...replyContext(replyTo),
    });
  } catch (error) {
    if (!storedMedia) await removeImage(media.storageKey);
    throw error;
  }
  const occurredAt = new Date();
  const message = await prisma.message.create({ data: {
    conversationId, externalId: conversation.channelAccountId && result.externalId ? `${conversation.channelAccountId}:${result.externalId}` : result.externalId, channel: conversation.channel, channelAccountId: conversation.channelAccountId || null, direction: "ENVIADA",
    status: "ENVIADA", type: "document", text: cleanCaption,
    mediaStorageKey: media.storageKey, mediaMimeType: media.mimeType,
    mediaFileName: media.fileName, mediaSize: media.size,
    occurredAt, sentByUserId: sentByUserId || null,
    rawPayload: { message: result.data, mediaId: result.mediaId },
    ...chatMessages().replyFields(replyTo), ...(forwardedFromMessageId ? { forwardedFromMessageId } : {}),
  } });
  await updateConversationAfterSending({ conversationId, sentByUserId, occurredAt });
  return { message, providerData: result.data };
}

// Áudio: nesta versão só WhatsApp (META). O conteúdo é normalizado antes
// (WebM do Chrome vira Ogg/Opus; tipo real decidido pela assinatura binária)
// e salvo no storage de mídia existente — no banco só referência/metadados.
async function sendAudio({ conversationId, buffer, fileName, durationMs, sentByUserId, channel, replyTo = null, storedMedia = null, forwardedFromMessageId = null }) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { contact: true, channelAccount: true } });
  if (!conversation) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
  if(conversation.archivedAt)throw Object.assign(new Error('Recupere a conversa arquivada antes de enviar mensagens.'),{statusCode:409,code:'CONVERSATION_ARCHIVED'});
  if (conversation.channel !== "META") {
    throw Object.assign(new Error("Este canal ainda não suporta envio de áudio pela Central."), { statusCode: 409 });
  }
  await whatsappInbox.applySender(conversation, sentByUserId);
  await chatMessages().assertReplySender(replyTo, conversation);
  await require("./meta-template-service").assertFreeFormAllowed(conversationId, new Date(), conversation.channelAccountId);
  const audio = normalizeOutgoingAudio({ buffer, fileName, declaredDurationMs: durationMs });
  const media = storedMedia || await storeAudio({ buffer: audio.buffer, mimeType: audio.mimeType, fileName: audio.fileName });
  let result;
  try {
    result = await sendMetaForConversation(conversation, channel, "sendAudio", {
      buffer: audio.buffer, mimeType: media.mimeType, fileName: media.fileName, ...replyContext(replyTo),
    });
  } catch (error) {
    if (!storedMedia) await removeImage(media.storageKey);
    throw error;
  }
  const occurredAt = new Date();
  const message = await prisma.message.create({ data: {
    conversationId, externalId: result.externalId && conversation.channelAccountId ? `${conversation.channelAccountId}:${result.externalId}` : result.externalId,
    channel: conversation.channel, channelAccountId: conversation.channelAccountId || null, direction: "ENVIADA",
    status: "ENVIADA", type: "audio", text: null,
    mediaStorageKey: media.storageKey, mediaMimeType: media.mimeType,
    mediaFileName: media.fileName, mediaSize: media.size, mediaDurationMs: audio.durationMs,
    occurredAt, sentByUserId: sentByUserId || null,
    rawPayload: { message: result.data, mediaId: result.mediaId },
    ...chatMessages().replyFields(replyTo), ...(forwardedFromMessageId ? { forwardedFromMessageId } : {}),
  } });
  await updateConversationAfterSending({ conversationId, sentByUserId, occurredAt });
  return { message, providerData: result.data };
}

// Figurinha: só WhatsApp, pelo tipo oficial `sticker`. Nunca vira imagem nem
// documento. Da biblioteca, reaproveita o arquivo já guardado.
async function sendSticker({ conversationId, buffer, mimeType, fileName, sentByUserId, channel, replyTo = null, storedMedia = null, forwardedFromMessageId = null, beforeProviderSend }) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { contact: true, channelAccount: true } });
  if (!conversation) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
  if (conversation.archivedAt) throw Object.assign(new Error("Recupere a conversa arquivada antes de enviar mensagens."), { statusCode: 409, code: "CONVERSATION_ARCHIVED" });
  if (conversation.channel !== "META") throw Object.assign(new Error("Figurinhas estão disponíveis apenas no WhatsApp."), { statusCode: 409 });
  await whatsappInbox.applySender(conversation, sentByUserId);
  await chatMessages().assertReplySender(replyTo, conversation);
  await require("./meta-template-service").assertFreeFormAllowed(conversationId, new Date(), conversation.channelAccountId);
  const media = storedMedia || await storeSticker({ buffer, mimeType, fileName });
  let result;
  try {
    await beforeProviderSend?.();
    result = await sendMetaForConversation(conversation, channel, "sendSticker", { buffer, mimeType: media.mimeType, fileName: media.fileName, ...replyContext(replyTo) });
  } catch (error) {
    if (!storedMedia) await removeImage(media.storageKey);
    throw error;
  }
  const occurredAt = new Date();
  const message = await prisma.message.create({ data: {
    conversationId, externalId: result.externalId, channel: conversation.channel, channelAccountId: conversation.channelAccountId || null,
    direction: "ENVIADA", status: "ENVIADA", type: "sticker", text: null,
    mediaStorageKey: media.storageKey, mediaMimeType: media.mimeType, mediaFileName: media.fileName, mediaSize: media.size,
    occurredAt, sentByUserId: sentByUserId || null, rawPayload: { message: result.data, mediaId: result.mediaId },
    ...chatMessages().replyFields(replyTo), ...(forwardedFromMessageId ? { forwardedFromMessageId } : {}),
  } });
  await updateConversationAfterSending({ conversationId, sentByUserId, occurredAt });
  return { message, providerData: result.data };
}

async function finalizeConversation({ conversationId, sentByUserId, channel }) {
  const current = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!current) throw Object.assign(new Error("Conversa não encontrada."), { statusCode: 404 });
  if (current.status === "FINALIZADO") {
    return { conversation: current, message: null, alreadyFinalized: true };
  }
  const serviceWindow = await require("./meta-template-service").getCustomerServiceWindow(conversationId);
  // Setor privado: a mensagem de encerramento ainda é do segmento (vai antes
  // do status); a finalização encerra o segmento — o próximo atendimento
  // segue as regras normais. preferredAssignee do contato não muda.
  const privateCategoryId = await require("./private-segment-service").stampForConversation(conversationId, prisma);
  const result = serviceWindow.open
    ? await sendText({ conversationId, text: closingMessage, sentByUserId, channel, keepAssignee: true })
    : { message: null, providerData: null };
  const conversation = await prisma.conversation.update({ where: { id: conversationId }, data: {
    status: "FINALIZADO", finalizedAt: new Date(),
  } });
  await require("./after-hours-reminder-service").cancelSafely(conversationId, "CONVERSATION_FINALIZED");
  if (privateCategoryId) {
    await prisma.conversationActivity.create({ data: {
      conversationId, actorUserId: sentByUserId || null, action: "PRIVATE_SEGMENT_ENDED",
      details: { categoryId: privateCategoryId, finalized: true }, privateCategoryId: null,
    } });
  }
  return { conversation, message: result.message, providerData: result.providerData, alreadyFinalized: false, previousStatus: current.status };
}

async function sendTextToPhone({ phone, text, channel, account = null }) {
  const { conversation } = await findOrCreateMetaConversation({ contactExternalId: phone, phone, contactName: phone }, undefined, account);
  return sendText({ conversationId: conversation.id, text, channel });
}

module.exports = { closingMessage, finalizeConversation, saveIncoming, sendAudio, sendDocument, sendImage, sendSticker, sendVideo, updateConversationAfterSending, updateStatus, sendText, sendTextToPhone };
