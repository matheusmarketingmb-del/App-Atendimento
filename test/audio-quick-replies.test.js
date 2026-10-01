if (!process.env.DATABASE_URL?.includes("unified-review-db") || process.env.ALLOW_ISOLATED_UNIFIED_TEST !== "yes") throw new Error("Banco isolado obrigatório para testes de áudio.");
require("dotenv").config();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const bcrypt = require("bcryptjs");
const axios = require("axios");
const { createApp } = require("../src/app");
const prisma = require("../src/database/prisma");
const { resolveMedia } = require("../src/services/media-storage-service");
const MetaCloudChannel = require("../src/channels/meta-cloud-channel");

const PREFIX = "qr-audio-";
const EMAILS = { a: `${PREFIX}a@teste.local`, b: `${PREFIX}b@teste.local`, master: `${PREFIX}master@teste.local` };
const PASSWORD = "senha-segura-123";

// Ogg/Opus mínimo e válido (OpusHead + OpusTags + 50 pacotes de 20 ms ≈ 1 s),
// gerado pelo próprio remux a partir de um WebM no formato do Chrome.
function webmSample(packetCount = 50) {
  const vint = (n) => (n < 0x7f ? Buffer.from([0x80 | n]) : Buffer.from([0x40 | (n >> 8), n & 0xff]));
  const id = (value) => { const bytes = []; for (let v = value; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff); return Buffer.from(bytes); };
  const el = (i, data) => Buffer.concat([id(i), vint(data.length), data]);
  const unknown = (i) => Buffer.concat([id(i), Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])]);
  const head = Buffer.alloc(19); head.write("OpusHead"); head[8] = 1; head[9] = 1; head.writeUInt32LE(48000, 12);
  const track = el(0xae, Buffer.concat([el(0xd7, Buffer.from([1])), el(0x86, Buffer.from("A_OPUS")), el(0x63a2, head)]));
  const blocks = Array.from({ length: packetCount }, (_, i) => el(0xa3, Buffer.concat([Buffer.from([0x81, 0, i & 0xff, 0x80, 0xf8]), Buffer.alloc(30, i)])));
  return Buffer.concat([el(0x1a45dfa3, el(0x4282, Buffer.from("webm"))), unknown(0x18538067), el(0x1654ae6b, track), unknown(0x1f43b675), ...blocks]);
}

async function cleanup() {
  await prisma.quickReply.deleteMany({ where: { owner: { is: { email: { startsWith: PREFIX } } } } });
  await prisma.message.deleteMany({ where: { conversation: { is: { contact: { is: { externalId: { startsWith: PREFIX } } } } } } });
  await prisma.conversation.deleteMany({ where: { contact: { is: { externalId: { startsWith: PREFIX } } } } });
  await prisma.contact.deleteMany({ where: { externalId: { startsWith: PREFIX } } });
  await prisma.auditLog.deleteMany({ where: { actorEmail: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
}

test.before(async () => {
  await cleanup();
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  await prisma.user.createMany({ data: [
    { name: "Atendente A Áudio", email: EMAILS.a, passwordHash, role: "ATENDENTE" },
    { name: "Atendente B Áudio", email: EMAILS.b, passwordHash, role: "ATENDENTE" },
    { name: "Master Áudio", email: EMAILS.master, passwordHash, role: "ADMIN" },
  ] });
});
test.after(async () => { await cleanup(); await prisma.$disconnect(); });

async function startServer(channel) {
  const server = createApp({ channel }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function login(base, email) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}

// Conversa WhatsApp com mensagem recebida recente (janela de 24 h aberta).
async function conversationFor(email, { channel = "META", suffix }) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const contact = await prisma.contact.create({ data: { externalId: `${PREFIX}${suffix}`, phone: `55119${String(Date.now()).slice(-8)}`, channel } });
  const conversation = await prisma.conversation.create({ data: { contactId: contact.id, channel, assignedUserId: user.id } });
  await prisma.message.create({ data: {
    conversationId: conversation.id, channel, direction: "RECEBIDA", status: "RECEBIDA", type: "text",
    externalId: `wamid.${PREFIX}${suffix}`,
    text: "Olá", occurredAt: new Date(),
  } });
  return conversation;
}

function audioForm(fields, buffer = webmSample(), { type = "audio/webm;codecs=opus", name = "gravacao.webm" } = {}) {
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => form.append(key, value));
  if (buffer) form.append("audio", new Blob([buffer], { type }), name);
  return form;
}

test("WhatsApp: adapter envia áudio via upload de mídia + mensagem type=audio (sem legenda)", async () => {
  const previous = { post: axios.post, GRAPH_VERSION: process.env.GRAPH_VERSION, PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID, WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN };
  Object.assign(process.env, { GRAPH_VERSION: "v-test", PHONE_NUMBER_ID: "phone-test", WHATSAPP_TOKEN: "token-test" });
  const posts = [];
  axios.post = async (url, body) => {
    posts.push({ url, body });
    return url.endsWith("/media") ? { data: { id: "media.audio.up" } } : { data: { messages: [{ id: "wamid.audio.sent" }] } };
  };
  try {
    const sent = await new MetaCloudChannel().sendAudio("5511999999999", { buffer: Buffer.from("OggS"), mimeType: "audio/ogg", fileName: "a.ogg" });
    assert.equal(sent.externalId, "wamid.audio.sent");
    assert.equal(sent.mediaId, "media.audio.up");
    assert.match(posts[0].url, /phone-test\/media$/);
    assert.equal(posts[1].body.type, "audio");
    assert.deepEqual(posts[1].body.audio, { id: "media.audio.up" });
    posts.length = 0;
    const scoped = new MetaCloudChannel({ accountScoped: true, graphVersion: "v-test", phoneNumberId: "commercial-test", accessToken: "fake-commercial" });
    await scoped.sendAudio("5511999999999", { buffer: Buffer.from("OggS"), mimeType: "audio/ogg", fileName: "a.ogg" });
    assert.match(posts[0].url, /commercial-test\/media$/);
    assert.match(posts[1].url, /commercial-test\/messages$/);
  } finally {
    axios.post = previous.post;
    for (const key of ["GRAPH_VERSION", "PHONE_NUMBER_ID", "WHATSAPP_TOKEN"]) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

test("envio de áudio: normaliza WebM → OGG, chama o adapter, persiste a mensagem e atualiza status pelo webhook", async () => {
  const sentToProvider = [];
  const channel = { sendAudio: async (phone, data) => { sentToProvider.push({ phone, ...data }); return { externalId: `wamid.${PREFIX}${Date.now()}`, mediaId: "media.x", data: { ok: true } }; } };
  const { server, base } = await startServer(channel);
  try {
    const cookie = await login(base, EMAILS.a);
    const conversation = await conversationFor(EMAILS.a, { suffix: "send" });
    const response = await fetch(`${base}/api/conversations/${conversation.id}/audios`, {
      method: "POST", headers: { Cookie: cookie }, body: audioForm({ durationMs: "1000" }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    const message = await response.json();
    assert.equal(message.type, "audio");
    assert.equal(message.direction, "ENVIADA");
    assert.equal(message.status, "ENVIADA");
    assert.equal(message.mediaMimeType, "audio/ogg");
    assert.equal(message.mediaFileName, "gravacao.ogg");
    assert.ok(message.mediaDurationMs > 900 && message.mediaDurationMs < 1100);
    assert.equal(sentToProvider.length, 1);
    assert.equal(sentToProvider[0].mimeType, "audio/ogg");
    const stored = await fs.readFile(resolveMedia(message.mediaStorageKey));
    assert.equal(stored.subarray(0, 4).toString(), "OggS");

    // Status do webhook usa o mesmo caminho das demais mensagens (por externalId).
    const { updateStatus } = require("../src/services/message-service");
    await updateStatus({ externalId: message.externalId, status: "delivered", occurredAt: new Date() });
    assert.equal((await prisma.message.findUnique({ where: { id: message.id } })).status, "ENTREGUE");

    // Player na conversa: o arquivo é servido só com autenticação.
    const media = await fetch(`${base}/api/messages/${message.id}/media`, { headers: { Cookie: cookie } });
    assert.equal(media.status, 200);
    assert.equal(media.headers.get("content-type"), "audio/ogg");
    assert.equal((await fetch(`${base}/api/messages/${message.id}/media`)).status, 401);
  } finally { server.close(); }
});

test("envio de áudio: arquivo inválido, tamanho excessivo e canal sem suporte são recusados", async () => {
  const channel = { sendAudio: async () => { throw new Error("não deveria chamar o provedor"); } };
  const { server, base } = await startServer(channel);
  try {
    const cookie = await login(base, EMAILS.a);
    const conversation = await conversationFor(EMAILS.a, { suffix: "invalid" });
    const fakeMp3 = await fetch(`${base}/api/conversations/${conversation.id}/audios`, {
      method: "POST", headers: { Cookie: cookie },
      body: audioForm({}, Buffer.from("%PDF-1.7 disfarçado"), { type: "audio/mpeg", name: "nota.mp3" }),
    });
    assert.equal(fakeMp3.status, 400);
    assert.match((await fakeMp3.json()).error, /Formato de áudio não suportado/);

    const notAudio = await fetch(`${base}/api/conversations/${conversation.id}/audios`, {
      method: "POST", headers: { Cookie: cookie },
      body: audioForm({}, Buffer.from("%PDF-1.7"), { type: "application/pdf", name: "nota.pdf" }),
    });
    assert.equal(notAudio.status, 400);

    const huge = await fetch(`${base}/api/conversations/${conversation.id}/audios`, {
      method: "POST", headers: { Cookie: cookie },
      body: audioForm({}, Buffer.concat([Buffer.from("OggS"), Buffer.alloc(16 * 1024 * 1024 + 10)]), { type: "audio/ogg", name: "grande.ogg" }),
    });
    assert.equal(huge.status, 413);

    const email = await conversationFor(EMAILS.a, { channel: "INSTAGRAM_DIRECT", suffix: "insta" });
    const unsupported = await fetch(`${base}/api/conversations/${email.id}/audios`, {
      method: "POST", headers: { Cookie: cookie }, body: audioForm({}),
    });
    assert.equal(unsupported.status, 409);
    assert.match((await unsupported.json()).error, /não suporta envio de áudio/);
  } finally { server.close(); }
});

test("respostas rápidas pessoais de áudio: criar, usar sem enviar, isolamento entre atendentes, editar e excluir", async () => {
  const providerCalls = [];
  const channel = { sendAudio: async (...args) => { providerCalls.push(args); return { externalId: null, data: {} }; } };
  const { server, base } = await startServer(channel);
  try {
    const cookieA = await login(base, EMAILS.a);
    const cookieB = await login(base, EMAILS.b);
    const cookieMaster = await login(base, EMAILS.master);
    const conversationA = await conversationFor(EMAILS.a, { suffix: "qr-a" });
    const conversationB = await conversationFor(EMAILS.b, { suffix: "qr-b" });
    const category = await prisma.category.findFirst({ where: { active: true } });

    // Texto global continua funcionando ao lado do áudio pessoal.
    const textGlobal = await prisma.quickReply.create({ data: { name: `${PREFIX}texto`, shortcut: "/qraudiotexto", text: "Olá {{nome_cliente}}" } });

    const created = await fetch(`${base}/api/quick-replies/personal-audio`, {
      method: "POST", headers: { Cookie: cookieA },
      body: audioForm({ name: "Saudação", shortcut: "/saudacao_audio", categoryId: category?.id || "", durationMs: "1000" }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const audioReply = await created.json();
    assert.equal(audioReply.scope, "PERSONAL");
    assert.equal(audioReply.contentType, "AUDIO");
    assert.equal(audioReply.audio.mimeType, "audio/ogg");
    assert.ok(audioReply.audio.durationMs > 0);
    assert.equal(audioReply.mediaStorageKey, undefined, "storageKey interno nunca é exposto");

    const duplicate = await fetch(`${base}/api/quick-replies/personal-audio`, {
      method: "POST", headers: { Cookie: cookieA }, body: audioForm({ name: "Outra", shortcut: "/saudacao_audio" }),
    });
    assert.equal(duplicate.status, 400);
    const otherOwner = await fetch(`${base}/api/quick-replies/personal-audio`, {
      method: "POST", headers: { Cookie: cookieB }, body: audioForm({ name: "Áudio de B", shortcut: "/saudacao_audio" }),
    });
    assert.equal(otherOwner.status, 201, "atalhos pessoais são separados por dono");

    // A vê o próprio áudio + o texto global; B não vê o áudio de A.
    const listA = await (await fetch(`${base}/api/quick-replies/composer?conversationId=${conversationA.id}`, { headers: { Cookie: cookieA } })).json();
    assert.ok(listA.some((item) => item.id === audioReply.id && item.availableInConversation));
    assert.ok(listA.some((item) => item.id === textGlobal.id));
    const listB = await (await fetch(`${base}/api/quick-replies/composer?conversationId=${conversationB.id}`, { headers: { Cookie: cookieB } })).json();
    assert.ok(!listB.some((item) => item.id === audioReply.id));
    assert.ok(listB.some((item) => item.id === textGlobal.id));

    // Busca por tipo/nome/comando.
    const searchAudio = await (await fetch(`${base}/api/quick-replies/composer?conversationId=${conversationA.id}&search=%C3%A1udio`, { headers: { Cookie: cookieA } })).json();
    assert.ok(searchAudio.some((item) => item.id === audioReply.id));
    const searchCommand = await (await fetch(`${base}/api/quick-replies/composer?conversationId=${conversationA.id}&search=saudacao_audio`, { headers: { Cookie: cookieA } })).json();
    assert.ok(searchCommand.some((item) => item.id === audioReply.id));

    // Usar devolve a referência do áudio e NÃO envia nada ao cliente.
    const used = await fetch(`${base}/api/quick-replies/${audioReply.id}/use`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookieA }, body: JSON.stringify({ conversationId: conversationA.id }),
    });
    assert.equal(used.status, 200);
    const usedBody = await used.json();
    assert.equal(usedBody.audio.url, `/api/quick-replies/${audioReply.id}/audio`);
    assert.equal(providerCalls.length, 0, "selecionar resposta rápida nunca envia");
    assert.equal(await prisma.message.count({ where: { conversationId: conversationA.id, direction: "ENVIADA" } }), 0);

    const audioFile = await fetch(`${base}${usedBody.audio.url}`, { headers: { Cookie: cookieA } });
    assert.equal(audioFile.status, 200);
    assert.equal(audioFile.headers.get("content-type"), "audio/ogg");

    // B não consegue usar, ouvir, editar nem excluir (404 — nem confirma que existe).
    for (const [method, path, body] of [
      ["POST", `/api/quick-replies/${audioReply.id}/use`, JSON.stringify({ conversationId: conversationB.id })],
      ["GET", `/api/quick-replies/${audioReply.id}/audio`],
      ["PATCH", `/api/quick-replies/personal-audio/${audioReply.id}`, JSON.stringify({ name: "Invasão" })],
      ["DELETE", `/api/quick-replies/personal-audio/${audioReply.id}`],
    ]) {
      const response = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", Cookie: cookieB }, body });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
    // Tela administrativa de globais não lista pessoais.
    const adminList = await (await fetch(`${base}/api/quick-replies`, { headers: { Cookie: cookieMaster } })).json();
    assert.ok(!adminList.some((item) => item.id === audioReply.id));

    // Conversa do Instagram: áudio aparece marcado como indisponível e /use recusa.
    const emailConversation = await conversationFor(EMAILS.a, { channel: "INSTAGRAM_DIRECT", suffix: "qr-insta" });
    const emailList = await (await fetch(`${base}/api/quick-replies/composer?conversationId=${emailConversation.id}`, { headers: { Cookie: cookieA } })).json();
    assert.equal(emailList.find((item) => item.id === audioReply.id)?.availableInConversation, false);
    const emailUse = await fetch(`${base}/api/quick-replies/${audioReply.id}/use`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookieA }, body: JSON.stringify({ conversationId: emailConversation.id }),
    });
    assert.equal(emailUse.status, 400);

    // Editar: renomear, trocar comando/categoria e substituir o áudio.
    const oldKey = (await prisma.quickReply.findUnique({ where: { id: audioReply.id } })).mediaStorageKey;
    const edited = await fetch(`${base}/api/quick-replies/personal-audio/${audioReply.id}`, {
      method: "PATCH", headers: { Cookie: cookieA },
      body: audioForm({ name: "Saudação inicial", shortcut: "/ola_audio", categoryId: "" }, webmSample(100)),
    });
    assert.equal(edited.status, 200, await edited.clone().text());
    const editedBody = await edited.json();
    assert.equal(editedBody.name, "Saudação inicial");
    assert.equal(editedBody.shortcut, "/ola_audio");
    assert.equal(editedBody.categoryId, null);
    assert.ok(editedBody.audio.durationMs > audioReply.audio.durationMs);
    await assert.rejects(fs.access(resolveMedia(oldKey)), "áudio antigo removido do storage");

    // Auditoria sem conteúdo binário.
    const audits = await prisma.auditLog.findMany({ where: { entityId: audioReply.id } });
    assert.ok(audits.some((row) => row.action === "QUICK_REPLY_CREATED"));
    assert.ok(audits.some((row) => row.action === "QUICK_REPLY_UPDATED"));
    assert.ok(audits.every((row) => !JSON.stringify(row.details || {}).includes("OggS")));

    // Excluir: some do banco e do storage.
    const newKey = (await prisma.quickReply.findUnique({ where: { id: audioReply.id } })).mediaStorageKey;
    const removed = await fetch(`${base}/api/quick-replies/personal-audio/${audioReply.id}`, { method: "DELETE", headers: { Cookie: cookieA } });
    assert.equal(removed.status, 200);
    assert.equal(await prisma.quickReply.findUnique({ where: { id: audioReply.id } }), null);
    await assert.rejects(fs.access(resolveMedia(newKey)));
    assert.ok(await prisma.auditLog.findFirst({ where: { entityId: audioReply.id, action: "QUICK_REPLY_DELETED" } }));

    // Texto continua usando o fluxo original (variáveis resolvidas).
    const textUse = await (await fetch(`${base}/api/quick-replies/${textGlobal.id}/use`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookieA }, body: JSON.stringify({ conversationId: conversationA.id }),
    })).json();
    assert.equal(textUse.audio, undefined);
    assert.match(textUse.text, /^Olá/);
    await prisma.quickReply.delete({ where: { id: textGlobal.id } });
  } finally { server.close(); }
});

test("Master pode administrar a resposta pessoal de outro atendente (exclusão)", async () => {
  const { server, base } = await startServer({});
  try {
    const cookieA = await login(base, EMAILS.a);
    const cookieMaster = await login(base, EMAILS.master);
    const created = await (await fetch(`${base}/api/quick-replies/personal-audio`, {
      method: "POST", headers: { Cookie: cookieA }, body: audioForm({ name: "Aguarde", shortcut: "/aguarde_audio" }),
    })).json();
    const removed = await fetch(`${base}/api/quick-replies/personal-audio/${created.id}`, { method: "DELETE", headers: { Cookie: cookieMaster } });
    assert.equal(removed.status, 200);
  } finally { server.close(); }
});
