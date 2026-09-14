// Item de segurança (flood de mensagens por contato) — ver
// src/services/inbound-flood-guard-service.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  checkInboundFlood, resetForTests, MAX_EVENTS_PER_WINDOW, WINDOW_MS,
} = require("../src/services/inbound-flood-guard-service");

test.beforeEach(resetForTests);

test("permite até o limite de mensagens por contato dentro da janela", () => {
  const now = Date.now();
  let last;
  for (let i = 0; i < MAX_EVENTS_PER_WINDOW; i += 1) {
    last = checkInboundFlood("5511999990000", now + i);
  }
  assert.equal(last.throttled, false);
  assert.equal(last.count, MAX_EVENTS_PER_WINDOW);
});

test("throttla a partir da mensagem seguinte ao limite, na mesma janela", () => {
  const now = Date.now();
  for (let i = 0; i < MAX_EVENTS_PER_WINDOW; i += 1) checkInboundFlood("5511999990001", now + i);
  const result = checkInboundFlood("5511999990001", now + MAX_EVENTS_PER_WINDOW);
  assert.equal(result.throttled, true);
});

test("nunca mistura contadores de contatos diferentes", () => {
  const now = Date.now();
  for (let i = 0; i < MAX_EVENTS_PER_WINDOW + 5; i += 1) checkInboundFlood("contato-flood", now + i);
  const outro = checkInboundFlood("contato-normal", now);
  assert.equal(outro.throttled, false);
  assert.equal(outro.count, 1);
});

test("a janela desliza: mensagens antigas saem da contagem e o throttle é liberado de novo", () => {
  const now = Date.now();
  for (let i = 0; i < MAX_EVENTS_PER_WINDOW + 1; i += 1) checkInboundFlood("contato-janela", now + i);
  const aindaThrottled = checkInboundFlood("contato-janela", now + MAX_EVENTS_PER_WINDOW + 1);
  assert.equal(aindaThrottled.throttled, true);

  const depoisDaJanela = checkInboundFlood("contato-janela", now + WINDOW_MS + 1000);
  assert.equal(depoisDaJanela.throttled, false);
});

test("uma chave vazia/nula nunca é throttlada (nunca bloqueia por engano quando não há identidade de contato)", () => {
  const result = checkInboundFlood(null);
  assert.equal(result.throttled, false);
});
