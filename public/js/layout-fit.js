/* Move existing controls, not copies: permissions and click handlers stay intact. */
(() => {
  const chat = document.querySelector("#chat-panel");
  const actions = document.querySelector(".chat-actions");
  const secondary = document.querySelector("#chat-secondary-actions");
  const overflow = document.querySelector(".chat-overflow-panel");
  const tools = document.querySelector(".composer-tools");
  const attachments = document.querySelector("#attachment-menu");
  if (!chat || !actions || !secondary || !overflow || !tools || !attachments) return;
  const compactScreen = matchMedia("(max-width:1200px)");
  const closeFiltersOnCompact = () => {
    if (compactScreen.matches) setFiltersPanelCollapsed(true, false);
  };
  closeFiltersOnCompact();
  compactScreen.addEventListener("change", closeFiltersOnCompact);
  const templates = document.querySelector("#open-templates");
  const quick = document.querySelector("#open-quick-replies");
  const label = document.createElement("span");
  label.className = "composer-tools-label";
  label.textContent = "Respostas rápidas";
  quick.append(label);
  function fit() {
    const width = chat.clientWidth;
    const compact = width > 0 && width < 950;
    const parent = compact ? overflow : actions;
    if (secondary.parentElement !== parent) parent.prepend(secondary);
    const small = width > 0 && width < 460;
    for (const button of [templates, quick]) {
      const target = small ? attachments : tools;
      if (button.parentElement !== target) target.append(button);
    }
    label.hidden = !small;
  }
  new ResizeObserver(fit).observe(chat);
  fit();
})();
