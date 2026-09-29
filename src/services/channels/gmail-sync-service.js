// Sincronização incremental da caixa de entrada Gmail. Usa polling com
// sobreposição curta e a idempotência já existente por externalMessageId.
const axios = require("axios");
const prisma = require("../../database/prisma");
const inboxEvents = require("../../realtime/inbox-events");
const { createAdapter } = require("./channel-adapter-registry");
const { normalizeInboundMessage } = require("./channel-event-normalizer");
const { decryptSecrets } = require("./integration-secret-service");
const oauth = require("./integration-oauth-service");
const externalEvents = require("./external-event-service");
const messages = require("./omnichannel-message-service");
const { getGlobalSettings } = require("./integration-global-settings-service");

const DEFAULT_INTERVAL_MS = 30 * 1000;
const OVERLAP_MS = 2 * 60 * 1000;
const MAX_PAGES = 20;
// Forma de busca do marcador "Shopify (Site Mibro)" — é o que o Gmail mostra
// na barra de pesquisa ao clicar no marcador (espaços/parênteses viram hífen).
const DEFAULT_SYNC_LABEL = "shopify--site-mibro-";

function cursorDate(account) {
  const configured = account.config?.gmailAttachmentSyncVersion === 1 ? account.config?.gmailSyncCursorAt : null;
  const parsed = configured ? new Date(configured) : new Date(account.createdAt);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function collectAttachmentParts(payload, result = []) {
  if (!payload) return result;
  if (payload.filename && (payload.body?.attachmentId || payload.body?.data)) {
    result.push({ id: payload.body.attachmentId || payload.partId || String(result.length), filename: payload.filename, mimeType: payload.mimeType || "application/octet-stream", body: payload.body });
  }
  for (const part of payload.parts || []) collectAttachmentParts(part, result);
  return result;
}

async function downloadGmailAttachments(message, headers, http) {
  const attachments = [];
  for (const part of collectAttachmentParts(message.payload)) {
    let data = part.body.data;
    if (!data && part.body.attachmentId) {
      const response = await http.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`, { headers, timeout: 15000 });
      data = response.data?.data;
    }
    if (!data) continue;
    attachments.push({ id: part.id, filename: part.filename, mimeType: part.mimeType, buffer: Buffer.from(data, "base64url") });
  }
  return attachments;
}

// Marcador do Gmail que limita o que entra no app. Ordem: config da conta,
// GMAIL_SYNC_LABEL e, por fim, DEFAULT_SYNC_LABEL. String vazia desliga o filtro.
function labelQuery(label) {
  const clean = label.replace(/"/g, "");
  return /\s/.test(clean) ? `label:"${clean}"` : `label:${clean}`;
}

function syncLabel(account) {
  const configured = account.config?.gmailSyncLabel ?? process.env.GMAIL_SYNC_LABEL ?? DEFAULT_SYNC_LABEL;
  return String(configured).trim() || null;
}

async function fetchGmailInbox({ accessToken, since, label = null, http = axios }) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const after = Math.max(0, Math.floor((since.getTime() - OVERLAP_MS) / 1000));
  const ids = new Map();
  // Com marcador, a busca do Gmail (label:...) resolve o nome direto, sem
  // precisar descobrir o ID do marcador. Sem marcador, mantém INBOX + SPAM.
  const queries = label
    ? [{ sourceLabel: "INBOX", params: { q: `${labelQuery(label)} after:${after}` } }]
    : ["INBOX", "SPAM"].map((labelId) => ({ sourceLabel: labelId, params: { labelIds: labelId, q: `after:${after}` } }));
  for (const { sourceLabel, params } of queries) {
    let pageToken;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await http.get("https://gmail.googleapis.com/gmail/v1/users/me/messages", {
        headers, params: { ...params, maxResults: 100, ...(pageToken ? { pageToken } : {}) }, timeout: 10000,
      });
      for (const item of response.data?.messages || []) {
        if (item.id && !ids.has(item.id)) ids.set(item.id, sourceLabel);
      }
      pageToken = response.data?.nextPageToken;
      if (!pageToken) break;
    }
  }
  const full = [];
  for (const [id, sourceLabel] of ids) {
    const response = await http.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, {
      headers, params: { format: "full" }, timeout: 10000,
    });
    if (response.data) {
      if (!Array.isArray(response.data.labelIds)) response.data.labelIds = [sourceLabel];
      response.data.gmailAttachments = await downloadGmailAttachments(response.data, headers, http);
      full.push(response.data);
    }
  }
  return full.sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0));
}

async function loadAuthorizedAccount(account, force = false) {
  const refreshed = await oauth.refreshAccountIfNeeded(account, { force });
  if (refreshed.status === "RECONNECT_REQUIRED") {
    throw Object.assign(new Error("Reconecte a conta Google para sincronizar o Gmail."), { channelErrorCode: "TOKEN_EXPIRED" });
  }
  return refreshed;
}

async function syncGmailAccount(account, { http = axios } = {}) {
  const cycleStartedAt = new Date();
  let current = await loadAuthorizedAccount(account);
  let secrets = decryptSecrets(current);
  let inbox;
  try {
    inbox = await fetchGmailInbox({ accessToken: secrets.accessToken, since: cursorDate(current), label: syncLabel(current), http });
  } catch (error) {
    if (error.response?.status !== 401) throw error;
    current = await loadAuthorizedAccount(current, true);
    secrets = decryptSecrets(current);
    inbox = await fetchGmailInbox({ accessToken: secrets.accessToken, since: cursorDate(current), label: syncLabel(current), http });
  }

  const adapter = createAdapter("EMAIL", { ...current, secrets });
  let imported = 0;
  for (const raw of inbox) {
    const normalizedEvents = adapter.normalizeInboundEvent(raw) || [];
    for (const rawEvent of normalizedEvents) {
      const normalized = normalizeInboundMessage({ ...rawEvent, channelAccountId: current.id });
      const externalEventId = `${current.id}:${normalized.externalMessageId}`;
      const { event, isDuplicate } = await externalEvents.recordEvent({
        channel: "EMAIL", channelAccountId: current.id, externalEventId,
        eventType: normalized.type, payload: { id: raw.id, threadId: raw.threadId },
      });
      if (isDuplicate) continue;
      try {
        const result = await messages.persistInboundMessage(normalized);
        await externalEvents.markProcessed(event.id);
        if (!result.duplicate) imported += 1;
      } catch (error) {
        await externalEvents.markError(event.id, error.channelErrorCode || "PROVIDER_ERROR");
      }
    }
  }

  await prisma.channelAccount.update({
    where: { id: current.id },
    data: {
      config: { ...(current.config || {}), gmailSyncCursorAt: cycleStartedAt.toISOString(), gmailAttachmentSyncVersion: 1 },
      lastSyncAt: cycleStartedAt, lastErrorAt: null, lastErrorCode: null, lastErrorMessage: null,
    },
  });
  return imported;
}

async function syncGmailAccounts() {
  const settings = await getGlobalSettings();
  if (!settings.newChannelsEnabled) return 0;
  const accounts = await prisma.channelAccount.findMany({
    where: { channel: "EMAIL", enabled: true, status: "CONNECTED", oauthProvider: "GOOGLE" },
    orderBy: { createdAt: "asc" },
  });
  let imported = 0;
  for (const account of accounts.filter((item) => item.config?.provider === "GMAIL")) {
    try {
      imported += await syncGmailAccount(account);
    } catch (error) {
      const reconnect = [401, 403].includes(error.response?.status) || error.channelErrorCode === "TOKEN_EXPIRED";
      await prisma.channelAccount.update({
        where: { id: account.id },
        data: {
          status: reconnect ? "RECONNECT_REQUIRED" : account.status,
          lastErrorAt: new Date(), lastErrorCode: reconnect ? "TOKEN_EXPIRED" : "PROVIDER_ERROR",
          lastErrorMessage: reconnect ? "Reconecte a conta para continuar a sincronização." : "Falha temporária ao sincronizar a caixa de entrada.",
        },
      });
      console.error(`[GMAIL_SYNC] account=${account.id} status=error code=${reconnect ? "TOKEN_EXPIRED" : "PROVIDER_ERROR"}`);
    }
  }
  if (imported) inboxEvents.publish();
  return imported;
}

function startGmailSyncWorker({ intervalMs = Number(process.env.GMAIL_SYNC_INTERVAL_MS) || DEFAULT_INTERVAL_MS } = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await syncGmailAccounts(); }
    catch (error) { console.error("[GMAIL_SYNC] worker=error", error.message); }
    finally { running = false; }
  };
  run();
  const timer = setInterval(run, Math.max(10000, intervalMs));
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { fetchGmailInbox, syncLabel, startGmailSyncWorker, syncGmailAccount, syncGmailAccounts };
