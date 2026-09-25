const clients = new Set();

function handle(req, res) {
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(": connected\n\n");

  // userId permite eventos direcionados (chat interno): só quem é membro
  // recebe o aviso de um grupo/conversa direta.
  const client = { res, userId: req.user?.id || null };
  clients.add(client);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20000);
  heartbeat.unref();

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(client);
  };
  req.once("close", cleanup);
  res.once("error", cleanup);
}

function write(client, frame) {
  if (client.res.destroyed || client.res.writableEnded) {
    clients.delete(client);
    return;
  }
  client.res.write(frame);
}

// Aviso global SEM conteúdo (só o horário): cada tela recarrega pela API, que
// aplica a regra de acesso do usuário — nenhum texto/anexo/prévia de conversa
// trafega pelo SSE.
function publish() {
  const frame = `event: inbox.updated\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`;
  for (const client of clients) write(client, frame);
}

// Evento direcionado: entregue somente às conexões dos usuários informados.
// O payload deve carregar apenas identificadores (ex.: chatId + tipo do
// evento), nunca conteúdo de mensagem.
function publishToUsers(userIds, event, data = {}) {
  const targets = new Set((userIds || []).filter(Boolean));
  if (!targets.size) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify({ ...data, at: new Date().toISOString() })}\n\n`;
  for (const client of clients) {
    if (targets.has(client.userId)) write(client, frame);
  }
}

module.exports = { handle, publish, publishToUsers };
