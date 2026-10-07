const webpush = require("web-push");
const prisma = require("../database/prisma");
const authorization = require("./authorization-service");
const privateSegments = require("./private-segment-service");

let configured = false;
let warnedMissingKeys = false;

function ensureConfigured() {
  if (configured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    if (!warnedMissingKeys) {
      console.warn("[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY não configuradas — notificações Web Push desativadas.");
      warnedMissingKeys = true;
    }
    return false;
  }
  webpush.setVapidDetails(VAPID_SUBJECT || "mailto:suporte@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

function isEnabled() {
  return ensureConfigured();
}

function publicKey() {
  return ensureConfigured() ? process.env.VAPID_PUBLIC_KEY : null;
}

function deviceLabelFromUserAgent(userAgent = "") {
  const ua = String(userAgent);
  const browser = /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Navegador";
  const os = /Android/.test(ua) ? "Android"
    : /iPhone|iPad|iOS/.test(ua) ? "iOS"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : "Dispositivo";
  return `${browser} - ${os}`;
}

// Cadastra ou atualiza a subscription (a chave é o endpoint, único por navegador/dispositivo).
async function saveSubscription(user, subscription, { deviceLabel, userAgent } = {}) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw Object.assign(new Error("Subscription de push inválida."), { statusCode: 400 });
  }
  const label = (deviceLabel || "").trim() || deviceLabelFromUserAgent(userAgent);
  return prisma.pushSubscription.upsert({
    where: { endpoint: subscription.endpoint },
    create: {
      userId: user.id, endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh, auth: subscription.keys.auth,
      deviceLabel: label, userAgent: userAgent || null, enabled: true,
    },
    update: {
      userId: user.id, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth,
      deviceLabel: label, userAgent: userAgent || null, enabled: true, lastSeenAt: new Date(),
    },
    select: { id: true, deviceLabel: true, createdAt: true, lastSeenAt: true, enabled: true },
  });
}

async function listDevices(userId) {
  return prisma.pushSubscription.findMany({
    where: { userId },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, deviceLabel: true, userAgent: true, createdAt: true, lastSeenAt: true, enabled: true },
  });
}

// Remoção própria ou por Master (RBAC igual ao restante do painel — authorization-service).
async function removeDevice(deviceId, requestingUser) {
  const subscription = await prisma.pushSubscription.findUnique({ where: { id: deviceId }, select: { id: true, userId: true } });
  if (!subscription) throw Object.assign(new Error("Dispositivo não encontrado."), { statusCode: 404 });
  if (subscription.userId !== requestingUser.id && !authorization.isMaster(requestingUser)) {
    throw authorization.forbidden("Você não pode remover o dispositivo de outro usuário.");
  }
  await prisma.pushSubscription.delete({ where: { id: deviceId } });
  return { removed: true };
}

async function sendToSubscription(subscription, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      JSON.stringify(payload),
    );
    if (subscription.id) await prisma.pushSubscription.update({ where: { id: subscription.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  } catch (error) {
    // 404/410 = endpoint inválido ou expirado — remove para não tentar de novo.
    if (error?.statusCode === 404 || error?.statusCode === 410) {
      await prisma.pushSubscription.delete({ where: { id: subscription.id } }).catch(() => {});
    } else {
      console.warn("[push] falha ao enviar notificação:", error?.statusCode || error?.message);
    }
  }
}

async function notifyUser(userId, payload) {
  if (!ensureConfigured()) return;
  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId, enabled: true } });
  await Promise.all(subscriptions.map((subscription) => sendToSubscription(subscription, payload)));
}

// Notifica o atendente responsável quando chega mensagem nova do cliente (item 4 do PWA).
// Sem responsável definido: não dispara (evita ruído amplo — o painel já mostra na lista/alerts).
async function notifyIncomingMessage(message) {
  if (!ensureConfigured()) return;
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: message.conversationId },
      select: {
        assignedUserId: true, contact: { select: { customName: true, name: true, phone: true } },
        company: { select: { displayName: true, slug: true } },
      },
    });
    if (!conversation?.assignedUserId) return;
    const contactName = conversation.contact?.customName || conversation.contact?.name || conversation.contact?.phone || "Cliente";
    // Multiempresa (item 43): toda notificação de cliente diz a empresa.
    const companyLabel = conversation.company?.displayName ? `${conversation.company.displayName} · ` : "";
    // Setor privado (Financeiro): sem prévia para quem não lê o segmento —
    // a notificação aparece na tela bloqueada do aparelho.
    let restricted = false;
    if (message.privateCategoryId) {
      const recipient = await prisma.user.findUnique({ where: { id: conversation.assignedUserId }, select: { id: true, role: true } });
      restricted = !(await privateSegments.canReadRecord(recipient, message));
    }
    await notifyUser(conversation.assignedUserId, {
      title: `${companyLabel}${contactName}`,
      company: conversation.company?.slug || null,
      body: restricted ? "Conversa atualizada"
        : message.type === "text" ? (message.text || "Nova mensagem").slice(0, 140) : "Enviou uma nova mensagem",
      tag: `conversation-${message.conversationId}`,
      url: `/?conversation=${encodeURIComponent(message.conversationId)}`,
    });
  } catch (error) {
    console.warn("[push] falha ao notificar mensagem recebida:", error.message);
  }
}

module.exports = {
  isEnabled, publicKey, saveSubscription, listDevices, removeDevice, notifyUser, notifyIncomingMessage,
};
