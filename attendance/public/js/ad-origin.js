(function () {
  let conversationId = null;
  let scope = null;
  let resolved = false;
  let origin = null;
  let rendered = "";

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function image(url, className, alt) {
    const node = element("img", className);
    node.alt = alt;
    node.loading = "lazy";
    node.referrerPolicy = "no-referrer";
    node.addEventListener("error", () => { node.hidden = true; });
    node.src = url;
    return node;
  }

  function render() {
    const card = document.getElementById("chat-ad-origin");
    if (!card) return;
    const signature = origin ? JSON.stringify(origin) : "";
    card.hidden = !origin;
    card.closest(".chat-content")?.classList.toggle("has-ad-origin", Boolean(origin));
    if (signature === rendered) return;
    rendered = signature;
    card.replaceChildren();
    if (!origin) return;
    const ad = origin;
    const details = element("details");
    const summary = element("summary", "ad-origin-summary");
    const preview = ad.thumbnailUrl || ad.imageUrl;
    if (preview) summary.append(image(preview, "ad-origin-thumb", ""));
    const heading = element("span", "ad-origin-heading");
    heading.append(element("span", "ad-origin-label", "Anúncio de origem"), element("strong", null, ad.headline || "Anúncio na Meta"));
    if (ad.body) heading.append(element("span", "ad-origin-excerpt", ad.body));
    summary.append(heading, element("span", "ad-origin-action", "Ver anúncio"));
    details.append(summary);
    const content = element("div", "ad-origin-content");
    if (ad.body) content.append(element("p", null, ad.body));
    if (!ad.body && ad.adId) content.append(element("p", null, `ID do anúncio ${ad.adId}`));
    const media = element("div", "ad-origin-media");
    content.append(media);
    if (ad.url) {
      const link = element("a", "ad-origin-link", "Abrir anúncio na Meta");
      link.href = ad.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      content.append(link);
    }
    details.append(content);
    card.append(details);
    let mediaLoaded = false;
    details.addEventListener("toggle", () => {
      if (!details.open) {
        media.querySelector("video")?.pause();
        return;
      }
      if (mediaLoaded) return;
      mediaLoaded = true;
      if (ad.videoUrl) {
        const video = element("video");
        video.controls = true;
        video.playsInline = true;
        video.preload = "none";
        if (preview) video.poster = preview;
        video.addEventListener("error", () => {
          media.replaceChildren(element("p", "ad-origin-unavailable", "Vídeo indisponível nesta prévia."));
          if (preview) media.append(image(preview, "ad-origin-preview", "Miniatura do anúncio"));
        });
        video.src = ad.videoUrl;
        media.append(video);
      } else if (preview) {
        media.append(image(preview, "ad-origin-preview", "Prévia do anúncio"));
      }
    });
  }

  function clear() {
    conversationId = null;
    scope = null;
    resolved = false;
    origin = null;
    render();
  }

  window.AdOrigin = {
    clear,
    needsLookup: id => !resolved || conversationId !== id,
    update(conversation) {
      const currentScope = conversation.messagePage?.scope || null;
      if (conversationId !== conversation.id || scope !== currentScope) clear();
      conversationId = conversation.id;
      scope = currentScope;
      if (Object.hasOwn(conversation, "adOrigin")) {
        resolved = true;
        const candidate = conversation.adOrigin;
        if (!candidate || !origin || Date.parse(candidate.occurredAt) >= Date.parse(origin.occurredAt)) origin = candidate;
      }
      render();
    },
  };
})();
