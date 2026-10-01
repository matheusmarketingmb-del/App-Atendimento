const test = require("node:test");
const assert = require("node:assert/strict");
const MetaCloudChannel = require("../src/channels/meta-cloud-channel");
const { routeMetaWebhook } = require("../src/services/meta-webhook-routing-service");
const change = (phone, id) => ({ value: { metadata: { phone_number_id: phone }, contacts: [{ wa_id: "5511999999999", profile: { name: "Cliente" } }], messages: [{ from: "5511999999999", id, timestamp: "1790859600", type: "text", text: { body: "Olá" } }] } });
const setup = () => ({ legacyPhoneNumberId: "principal", legacyChannel: new MetaCloudChannel({ phoneNumberId: "principal", accessToken: "fake" }), accounts: [{ id: "conta-comercial", config: { phoneNumberId: "comercial" }, externalAccountId: "antigo" }], createAccountChannel: () => new MetaCloudChannel({ phoneNumberId: "comercial", accessToken: "fake" }) });

test("lote com dois números mantém cada mensagem na conta e no emissor correto", async () => {
  const result = await routeMetaWebhook({ entry: [{ changes: [change("principal", "a"), change("comercial", "b")] }, { changes: [change("principal", "c")] }] }, setup());
  assert.deepEqual(result.map(({ event, eventChannel }) => [event.externalId, event.channelAccountId, eventChannel.phoneNumberId]), [["a", null, "principal"], ["b", "conta-comercial", "comercial"], ["c", null, "principal"]]);
});

test("ID externo antigo não captura eventos depois da mudança do número", async () => {
  await assert.rejects(() => routeMetaWebhook({ entry: [{ changes: [change("antigo", "x")] }] }, setup()), { statusCode: 404 });
});

test("número desconhecido não cai no principal", async () => {
  await assert.rejects(() => routeMetaWebhook({ entry: [{ changes: [change("desconhecido", "x")] }] }, setup()), { statusCode: 404 });
});

test("status de entrega também mantém a conta do número", async () => {
  const result = await routeMetaWebhook({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "comercial" }, statuses: [{ id: "wamid.x", status: "delivered", timestamp: "1790859600" }] } }] }] }, setup());
  assert.equal(result[0].event.channelAccountId, "conta-comercial");
  assert.equal(result[0].event.kind, "status");
});
