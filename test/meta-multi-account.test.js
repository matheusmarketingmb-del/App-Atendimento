const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const fs = require("node:fs");
const path = require("node:path");
const MetaCloudChannel = require("../src/channels/meta-cloud-channel");
const { MetaAdapter } = require("../src/services/channels/meta-adapter");

test("cliente Meta usa credenciais isoladas da ChannelAccount", async () => {
  const previousPost = axios.post;
  let request;
  axios.post = async (url, body, options) => {
    request = { url, body, options };
    return { data: { messages: [{ id: "wamid.second" }] } };
  };
  try {
    const channel = new MetaCloudChannel({ graphVersion:"v99.0", phoneNumberId:"phone-second", accessToken:"token-second", wabaId:"waba-second" });
    const result = await channel.sendText("5511999999999", "Olá");
    assert.equal(result.externalId, "wamid.second");
    assert.match(request.url, /v99\.0\/phone-second\/messages$/);
    assert.equal(request.options.headers.Authorization, "Bearer token-second");
  } finally { axios.post = previousPost; }
});

test("MetaAdapter deriva número, WABA e token da conta", () => {
  const adapter = new MetaAdapter({
    name:"Comercial", externalAccountId:"phone-commercial",
    config:{ wabaId:"waba-commercial", displayPhoneNumber:"+55 11 99999-9999" },
    secrets:{ accessToken:"secret-commercial" },
  });
  assert.equal(adapter.channel.phoneNumberId, "phone-commercial");
  assert.equal(adapter.channel.wabaId, "waba-commercial");
  assert.equal(adapter.channel.accessToken, "secret-commercial");
  assert.equal(adapter.channel.tokenSource, "CHANNEL_ACCOUNT");
});

test("MetaAdapter testa o número e o vínculo com o WABA na Graph API", async () => {
  const channel = {
    phoneNumberId: "phone-commercial", wabaId: "waba-commercial",
    assertConfigured() {},
    async getPhoneNumberProfile() {
      return { id: "phone-commercial", display_phone_number: "+55 11 99999-9999", verified_name: "Mibro Comercial", quality_rating: "GREEN" };
    },
    async listWabaPhoneNumbers() { return [{ id: "phone-commercial" }]; },
  };
  const result = await new MetaAdapter({ name: "Comercial", config: {} }, channel).testConnection();
  assert.equal(result.status, "CONNECTED");
  assert.equal(result.externalAccountId, "phone-commercial");
  assert.equal(result.providerMetadata.username, "+55 11 99999-9999");
  assert.equal(result.providerMetadata.qualityRating, "GREEN");
});

test("MetaAdapter rejeita número fora do WABA configurado", async () => {
  const channel = {
    phoneNumberId: "phone-wrong", wabaId: "waba-commercial",
    assertConfigured() {},
    async getPhoneNumberProfile() { return { id: "phone-wrong" }; },
    async listWabaPhoneNumbers() { return [{ id: "phone-other" }]; },
  };
  await assert.rejects(
    () => new MetaAdapter({ name: "Comercial", config: {} }, channel).testConnection(),
    (error) => error.channelErrorCode === "ACCOUNT_MISMATCH",
  );
});

test("painel e backend preparam atendentes, áreas e escolha do número", () => {
  const integrations = fs.readFileSync(path.join(__dirname, "../public/js/integrations.js"), "utf8");
  const integrationsCss = fs.readFileSync(path.join(__dirname, "../public/css/integrations.css"), "utf8");
  const inbox = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
  const authorization = fs.readFileSync(path.join(__dirname, "../src/services/authorization-service.js"), "utf8");
  const webhook = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
  assert.match(integrations, /Phone Number ID/);
  assert.match(integrations, /allowedCategoryIds/);
  assert.match(inbox, /outbound-meta-account/);
  assert.match(authorization, /channelAccountScope/);
  assert.match(webhook, /metadata\?\.phone_number_id/);
  assert.match(integrations, /Master, acesso permanente/);
  assert.doesNotMatch(integrations, /state\.users\.filter\(\(user\) => user\.role !== "ADMIN"\)/);
  assert.match(integrationsCss, /\.account-dialog\{[^}]*background:var\(--surface\)/);
});
