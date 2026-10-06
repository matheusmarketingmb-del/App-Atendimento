const clients = new Set();

// Multiempresa: cada conexão guarda as empresas que o usuário acessa, para
// que um usuário só-Mibro nem receba o aviso de atividade da Sincrofit.
function loadClientCompanies(client, user) {
  if (!user?.id) return;
  if (user.role === "ADMIN") { client.allCompanies = true; return; }
  require("../services/company-service").accessibleCompanyIds(user)
    .then((ids) => { client.companyIds = new Set(ids); })
    .catch(() => { client.companyIds = new Set(); });
}

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
  const client = { res, userId: req.user?.id || null, allCompanies: false, companyIds: null };
  loadClientCompanies(client, req.user);
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

// Aviso SEM conteúdo (só o horário): cada tela recarrega pela API, que
// aplica a regra de acesso do usuário — nenhum texto/anexo/prévia de conversa
// trafega pelo SSE. Com `companyIds`, só conexões com acesso a alguma dessas
// empresas recebem (Master Global sempre recebe); sem `companyIds`, vai para
// todos (eventos sem empresa definida, como antes).
function shouldReceive(client, targets) {
  if (!targets.length || client.allCompanies) return true;
  // Empresas da conexão ainda carregando: entrega (o aviso não tem conteúdo).
  if (!client.companyIds) return true;
  return targets.some((id) => client.companyIds.has(id));
}

function publish(companyIds) {
  const targets = companyIds ? [...companyIds].filter(Boolean) : [];
  const frame = `event: inbox.updated\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`;
  for (const client of clients) if (shouldReceive(client, targets)) write(client, frame);
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

// Aviso de mudança numa conversa: só para quem acessa a empresa dela.
function publishForConversation(conversationId) {
  if (!conversationId) return publish();
  return require("../database/prisma").conversation.findUnique({ where: { id: conversationId }, select: { companyId: true } })
    .then((conversation) => publish(conversation ? [conversation.companyId] : undefined))
    .catch(() => publish());
}

module.exports = { handle, publish, publishForConversation, publishToUsers, shouldReceive };
