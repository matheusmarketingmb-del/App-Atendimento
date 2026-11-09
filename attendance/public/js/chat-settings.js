(() => {
  const groups = [
    ["Conversa e organização", [["reply", "Responder mensagens", "Citar uma mensagem no WhatsApp."], ["emoji", "Emojis", "Seletor de emojis no campo de mensagem."], ["stars", "Favoritos", "Cada pessoa pode guardar suas mensagens favoritas."], ["pins", "Mensagens fixadas", "Fixar mensagens importantes na conversa."], ["search", "Pesquisa na conversa", "Encontrar mensagens sem percorrer todo o histórico."], ["media", "Imagens e áudios", "Zoom, velocidade do áudio e navegação até o fim da conversa."]]],
    ["Envios pelo WhatsApp", [["reactions", "Reações", "Reagir às mensagens recebidas dos clientes."], ["forward", "Encaminhamento", "Encaminhar mensagens entre conversas da mesma empresa."], ["stickers", "Figurinhas", "Biblioteca e envio de figurinhas."], ["gifs", "GIFs como vídeo", "Envio de animações em formato MP4."], ["catalog", "Catálogo de produtos", "Requer catálogo e acesso da conta configurados na Meta."]]],
    ["Equipe", [["internalReactions", "Reações no chat interno", "Reagir às mensagens entre pessoas da equipe."]]],
  ];
  const form = document.querySelector("#chat-settings-form"), list = document.querySelector("#chat-settings-list"), status = document.querySelector("#chat-settings-status"), button = form.querySelector("button");
  let revision;
  async function request(method = "GET", body) {
    const response = await fetch("/api/admin/chat-features", { method, credentials: "same-origin", cache: "no-store", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    if (response.status === 401) { location.replace("/login.html"); throw Error("Entre novamente."); }
    const data = await response.json(); if (!response.ok) throw Error(data.error || "Não foi possível salvar os recursos."); return data;
  }
  function render(data) {
    revision = data.revision;
    list.innerHTML = groups.map(([title, rows]) => `<section class="chat-setting-group"><h2>${title}</h2>${rows.filter(([key]) => Object.hasOwn(data.values, key)).map(([key, name, detail]) => `<label class="chat-setting-row"><span><strong>${name}</strong><small>${detail}</small></span><input type="checkbox" name="${key}" ${data.values[key] ? "checked" : ""}></label>`).join("")}</section>`).join("");
    list.setAttribute("aria-busy", "false"); button.disabled = false;
  }
  form.addEventListener("submit", async event => {
    event.preventDefault(); button.disabled = true; status.textContent = "Salvando…";
    try { render(await request("PATCH", { revision, values: Object.fromEntries([...list.querySelectorAll("input")].map(input => [input.name, input.checked])) })); status.textContent = "Recursos salvos. Recarregue a Central para atualizar as ferramentas."; }
    catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
  request().then(data => { render(data); status.textContent = "Somente o Master pode alterar estes recursos."; }).catch(error => { status.textContent = error.message; list.setAttribute("aria-busy", "false"); });
})();
