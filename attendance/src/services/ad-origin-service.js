function belongsToDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function metaUrl(value, domains) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    return domains.some(domain => belongsToDomain(url.hostname, domain)) ? url.href : null;
  } catch {
    return null;
  }
}

const linkDomains = ["facebook.com", "fb.me", "instagram.com"];
const mediaDomains = ["fbcdn.net", "cdninstagram.com"];

function adOriginFromMessage(message) {
  if (message?.restricted || message?.channel !== "META" || message.direction !== "RECEBIDA") return null;
  const referral = message.rawPayload?.referral;
  if (referral?.source_type !== "ad") return null;
  const adId = typeof referral.source_id === "string" && /^\d{5,40}$/.test(referral.source_id) ? referral.source_id : null;
  const headline = typeof referral.headline === "string" ? referral.headline.trim().slice(0, 200) : "";
  const body = typeof referral.body === "string" ? referral.body.trim().slice(0, 4000) : "";
  const url = metaUrl(referral.source_url, linkDomains) || metaUrl(referral.video_url, linkDomains);
  const imageUrl = metaUrl(referral.image_url, mediaDomains);
  const thumbnailUrl = metaUrl(referral.thumbnail_url, mediaDomains);
  const videoUrl = metaUrl(referral.video_url, mediaDomains);
  if (!adId && !headline && !body && !url && !imageUrl && !thumbnailUrl && !videoUrl) return null;
  return { messageId: message.id, occurredAt: message.occurredAt, adId, headline, body, url, imageUrl, thumbnailUrl, videoUrl };
}

module.exports = { adOriginFromMessage };
