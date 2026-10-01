const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const MetaCloudChannel = require("../src/channels/meta-cloud-channel");

test("interpreta todas as mensagens e status de um webhook", () => {
  const channel = new MetaCloudChannel();
  const events = channel.parseWebhook({ entry: [{ changes: [{ value: {
    metadata: { phone_number_id: "recipient-test" },
    contacts: [{ wa_id: "5511999999999", profile: { name: "Cliente" } }],
    messages: [
      { id: "wamid.1", from: "5511999999999", type: "text", text: { body: "Olá" }, timestamp: "1700000000" },
      { id: "wamid.2", from: "5511999999999", type: "image", image: { id: "media.2", mime_type: "image/jpeg", caption: "Foto do produto" }, timestamp: "1700000001" },
      { id: "wamid.4", from: "5511999999999", type: "audio", audio: { id: "media.4", mime_type: "audio/ogg; codecs=opus", voice: true }, timestamp: "1700000002" },
      { id: "wamid.5", from: "5511999999999", type: "video", video: { id: "media.5", mime_type: "video/mp4", caption: "Vídeo do produto" }, timestamp: "1700000003" },
      { id: "wamid.6", from: "5511999999999", type: "sticker", sticker: { id: "media.6", mime_type: "image/webp", animated: true }, timestamp: "1700000004" },
      { id: "wamid.7", from: "5511999999999", type: "reaction", reaction: { message_id: "wamid.1", emoji: "❤️" }, timestamp: "1700000005" },
      { id: "wamid.8", from: "5511999999999", type: "document", document: { id: "media.8", mime_type: "application/pdf", filename: "garantia.pdf", caption: "Nota fiscal" }, timestamp: "1700000006" },
    ],
    statuses: [{ id: "wamid.3", status: "delivered", timestamp: "1700000002" }],
  } }] }] });
  assert.equal(events.length, 8);
  assert.equal(events[0].contactName, "Cliente");
  assert.equal(events[0].text, "Olá");
  assert.equal(events[0].rawPayload.recipientPhoneNumberId, "recipient-test");
  assert.equal(events[1].text, "Foto do produto");
  assert.equal(events[1].mediaId, "media.2");
  assert.equal(events[1].mediaMimeType, "image/jpeg");
  assert.equal(events[2].text, "[audio]");
  assert.equal(events[2].mediaId, "media.4");
  assert.equal(events[2].mediaMimeType, "audio/ogg; codecs=opus");
  assert.equal(events[3].text, "Vídeo do produto");
  assert.equal(events[3].mediaId, "media.5");
  assert.equal(events[3].mediaMimeType, "video/mp4");
  assert.equal(events[4].type, "sticker");
  assert.equal(events[4].mediaId, "media.6");
  assert.equal(events[4].mediaMimeType, "image/webp");
  assert.equal(events[5].type, "reaction");
  assert.equal(events[5].text, "❤️");
  assert.equal(events[5].reactionToExternalId, "wamid.1");
  assert.equal(events[6].type, "document");
  assert.equal(events[6].text, "Nota fiscal");
  assert.equal(events[6].mediaId, "media.8");
  assert.equal(events[6].mediaMimeType, "application/pdf");
  assert.equal(events[6].mediaFileName, "garantia.pdf");
  assert.equal(events[7].kind, "status");
});

test("envia PDF como documento nativo do WhatsApp", async () => {
  const previousEnv = {
    GRAPH_VERSION: process.env.GRAPH_VERSION,
    PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
    WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  };
  const previousPost = axios.post;
  process.env.GRAPH_VERSION = "v-test";
  process.env.PHONE_NUMBER_ID = "phone-test";
  process.env.WHATSAPP_TOKEN = "token-test";
  const posts = [];
  axios.post = async (url, body) => {
    posts.push({ url, body });
    return url.endsWith("/media")
      ? { data: { id: "media.document.uploaded" } }
      : { data: { messages: [{ id: "wamid.document.sent" }] } };
  };
  try {
    const sent = await new MetaCloudChannel().sendDocument("5511999999999", {
      buffer: Buffer.from("%PDF-1.7\ndocumento"), mimeType: "application/pdf",
      fileName: "manual-mibro.pdf", caption: "Manual solicitado",
    });
    assert.equal(sent.externalId, "wamid.document.sent");
    assert.equal(sent.mediaId, "media.document.uploaded");
    assert.equal(posts.length, 2);
    assert.match(posts[0].url, /phone-test\/media$/);
    assert.equal(posts[1].body.type, "document");
    assert.deepEqual(posts[1].body.document, {
      id: "media.document.uploaded", filename: "manual-mibro.pdf", caption: "Manual solicitado",
    });
  } finally {
    axios.post = previousPost;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("envia vídeo como mídia nativa do WhatsApp", async () => {
  const previousEnv = {
    GRAPH_VERSION: process.env.GRAPH_VERSION,
    PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
    WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  };
  const previousPost = axios.post;
  process.env.GRAPH_VERSION = "v-test";
  process.env.PHONE_NUMBER_ID = "phone-test";
  process.env.WHATSAPP_TOKEN = "token-test";
  const posts = [];
  axios.post = async (url, body) => {
    posts.push({ url, body });
    return url.endsWith("/media")
      ? { data: { id: "media.video.uploaded" } }
      : { data: { messages: [{ id: "wamid.video.sent" }] } };
  };
  try {
    const sent = await new MetaCloudChannel().sendVideo("5511999999999", {
      buffer: Buffer.from("0000ftyp-video"), mimeType: "video/mp4",
      fileName: "produto.mp4", caption: "Demonstração do produto",
    });
    assert.equal(sent.externalId, "wamid.video.sent");
    assert.equal(sent.mediaId, "media.video.uploaded");
    assert.equal(posts.length, 2);
    assert.match(posts[0].url, /phone-test\/media$/);
    assert.equal(posts[1].body.type, "video");
    assert.deepEqual(posts[1].body.video, {
      id: "media.video.uploaded", caption: "Demonstração do produto",
    });
  } finally {
    axios.post = previousPost;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("baixa figurinha WebP recebida", async () => {
  const previousEnv = {
    GRAPH_VERSION: process.env.GRAPH_VERSION,
    PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
    WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  };
  const previousGet = axios.get;
  process.env.GRAPH_VERSION = "v-test";
  process.env.PHONE_NUMBER_ID = "phone-test";
  process.env.WHATSAPP_TOKEN = "token-test";
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
  axios.get = async (url) => url.includes("graph.facebook.com")
    ? { data: { url: "https://lookaside.fbsbx.com/media/sticker", mime_type: "image/webp" } }
    : { data: webp, headers: { "content-type": "image/webp" } };
  try {
    const downloaded = await new MetaCloudChannel().downloadMedia("media.sticker");
    assert.equal(downloaded.mimeType, "image/webp");
    assert.equal(downloaded.fileName, "figurinha-media.sticker.webp");
    assert.deepEqual(downloaded.buffer, webp);
  } finally {
    axios.get = previousGet;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("interpreta a escolha de uma lista interativa", () => {
  const channel = new MetaCloudChannel();
  const [event] = channel.parseWebhook({ entry: [{ changes: [{ value: {
    messages: [{ id: "wamid.list", from: "5511999999999", type: "interactive", timestamp: "1700000000",
      interactive: { type: "list_reply", list_reply: { id: "triage_category:cat-1", title: "Suporte" } } }],
  } }] }] });
  assert.equal(event.text, "Suporte");
  assert.equal(event.interactiveReplyId, "triage_category:cat-1");
  const [buttonEvent] = channel.parseWebhook({ entry: [{ changes: [{ value: {
    messages: [{ id: "wamid.button", from: "5511999999999", type: "interactive", timestamp: "1700000001",
      interactive: { type: "button_reply", button_reply: { id: "triage_category:cat-2", title: "Comercial" } } }],
  } }] }] });
  assert.equal(buttonEvent.text, "Comercial");
  assert.equal(buttonEvent.interactiveReplyId, "triage_category:cat-2");
});

test("baixa e envia imagens usando os endpoints de mídia da Meta", async () => {
  const previousEnv = {
    GRAPH_VERSION: process.env.GRAPH_VERSION,
    PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
    WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  };
  const previousGet = axios.get;
  const previousPost = axios.post;
  const previousPut = axios.put;
  process.env.GRAPH_VERSION = "v-test";
  process.env.PHONE_NUMBER_ID = "phone-test";
  process.env.WHATSAPP_TOKEN = "token-test";
  const posts = [];
  axios.get = async (url) => url.includes("graph.facebook.com")
    ? { data: { url: "https://lookaside.fbsbx.com/media/test", mime_type: "image/jpeg" } }
    : { data: Buffer.from([0xff, 0xd8, 0xff, 0x00]), headers: { "content-type": "image/jpeg" } };
  axios.post = async (url, body) => {
    posts.push({ url, body });
    return url.endsWith("/media")
      ? { data: { id: "media.uploaded" } }
      : { data: { messages: [{ id: "wamid.image.sent" }] } };
  };
  let readBody;
  axios.put = async (_url, body) => { readBody = body; return { data: { success: true } }; };
  try {
    const channel = new MetaCloudChannel();
    const downloaded = await channel.downloadMedia("media.received");
    assert.equal(downloaded.mimeType, "image/jpeg");
    assert.equal(downloaded.buffer.length, 4);
    const sent = await channel.sendImage("5511999999999", {
      buffer: downloaded.buffer, mimeType: downloaded.mimeType, fileName: "foto.jpg", caption: "Legenda",
    });
    assert.equal(sent.externalId, "wamid.image.sent");
    assert.equal(sent.mediaId, "media.uploaded");
    assert.equal(posts.length, 2);
    assert.match(posts[0].url, /phone-test\/media$/);
    assert.match(posts[1].url, /phone-test\/messages$/);
    assert.equal(posts[1].body.image.caption, "Legenda");
    await channel.markAsRead("wamid.received");
    assert.deepEqual(readBody, { messaging_product: "whatsapp", status: "read", message_id: "wamid.received" });
  } finally {
    axios.get = previousGet;
    axios.post = previousPost;
    axios.put = previousPut;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("envia lista interativa de setores", async () => {
  const previousEnv = {
    GRAPH_VERSION: process.env.GRAPH_VERSION,
    PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
    WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  };
  const previousPost = axios.post;
  process.env.GRAPH_VERSION = "v-test";
  process.env.PHONE_NUMBER_ID = "phone-test";
  process.env.WHATSAPP_TOKEN = "token-test";
  let sentBody;
  axios.post = async (_url, body) => {
    sentBody = body;
    return { data: { messages: [{ id: "wamid.list.sent" }] } };
  };
  try {
    const result = await new MetaCloudChannel().sendList("5511999999999", {
      body: "Escolha o setor", button: "Ver setores",
      rows: [{ id: "triage_category:cat-1", title: "Suporte" }],
    });
    assert.equal(result.externalId, "wamid.list.sent");
    assert.equal(sentBody.type, "interactive");
    assert.equal(sentBody.interactive.action.sections[0].rows[0].title, "Suporte");
  } finally {
    axios.post = previousPost;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("lista somente templates aprovados com paginação da Meta", async () => {
  const previousEnv = {
    GRAPH_VERSION: process.env.GRAPH_VERSION,
    PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
    WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
    WHATSAPP_BUSINESS_ACCOUNT_ID: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
  };
  const previousGet = axios.get;
  process.env.GRAPH_VERSION = "v-test";
  process.env.PHONE_NUMBER_ID = "phone-test";
  process.env.WHATSAPP_TOKEN = "token-test";
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "waba-test";
  const requests = [];
  axios.get = async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1
      ? { data: { data: [{ id: "1", name: "aprovado", status: "APPROVED" }, { id: "2", name: "rejeitado", status: "REJECTED" }], paging: { next: "next", cursors: { after: "cursor-2" } } } }
      : { data: { data: [{ id: "3", name: "segundo", status: "APPROVED" }] } };
  };
  try {
    const templates = await new MetaCloudChannel().listMessageTemplates();
    assert.deepEqual(templates.map(({ name }) => name), ["aprovado", "segundo"]);
    assert.match(requests[0].url, /waba-test\/message_templates$/);
    assert.equal(requests[1].options.params.after, "cursor-2");
  } finally {
    axios.get = previousGet;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("envia template aprovado com idioma e variáveis", async () => {
  const previousEnv = {
    GRAPH_VERSION: process.env.GRAPH_VERSION,
    PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
    WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  };
  const previousPost = axios.post;
  process.env.GRAPH_VERSION = "v-test";
  process.env.PHONE_NUMBER_ID = "phone-test";
  process.env.WHATSAPP_TOKEN = "token-test";
  let sentBody;
  axios.post = async (_url, body) => { sentBody = body; return { data: { messages: [{ id: "wamid.template.sent" }] } }; };
  try {
    const result = await new MetaCloudChannel().sendTemplate("5511999999999", {
      name: "retomar_atendimento", language: "pt_BR",
      components: [{ type: "body", parameters: [{ type: "text", text: "Matheus" }] }],
    });
    assert.equal(result.externalId, "wamid.template.sent");
    assert.equal(sentBody.type, "template");
    assert.equal(sentBody.template.name, "retomar_atendimento");
    assert.equal(sentBody.template.language.code, "pt_BR");
  } finally {
    axios.post = previousPost;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
