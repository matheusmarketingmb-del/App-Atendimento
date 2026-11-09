fetch("/api/auth/status", { credentials: "same-origin" }).then(response => response.ok ? response.json() : null).then(data => {
  document.querySelectorAll("[data-master-chat-tab]").forEach(link => { link.hidden = !data?.user?.isMaster; link.style.display = data?.user?.isMaster ? "" : "none"; });
}).catch(() => {});
