// Resolve cada change separadamente: um lote da Meta pode conter vários números.
async function routeMetaWebhook(payload, { legacyChannel, legacyPhoneNumberId, accounts, createAccountChannel }) {
  const routed = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      const phoneId = change.value?.metadata?.phone_number_id;
      let eventChannel = legacyChannel;
      let channelAccountId = null;
      if (phoneId && phoneId !== legacyPhoneNumberId) {
        const matches = accounts.filter((account) => String(account.config?.phoneNumberId || account.externalAccountId) === String(phoneId));
        if (matches.length !== 1) throw Object.assign(new Error("Número WhatsApp não configurado ou ambíguo."), { statusCode: 404 });
        channelAccountId = matches[0].id;
        eventChannel = createAccountChannel(matches[0]);
      }
      const partial = { ...payload, entry: [{ ...entry, changes: [change] }] };
      for (const event of eventChannel.parseWebhook(partial)) {
        routed.push({ event: { ...event, channelAccountId }, eventChannel });
      }
    }
  }
  return routed;
}

module.exports = { routeMetaWebhook };
