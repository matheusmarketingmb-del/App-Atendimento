const test = require("node:test");
const assert = require("node:assert/strict");
const { checkResponseLoop, checkSwitchWindow } = require("../src/services/bot-loop-guard-service");

test("checkResponseLoop não aciona na primeira resposta", () => {
  const result = checkResponseLoop(null, "Olá, tudo bem?");
  assert.equal(result.looped, false);
  assert.equal(result.repeatCount, 0);
});

test("checkResponseLoop conta repetições da MESMA resposta e aciona no limite", () => {
  const first = checkResponseLoop(null, "Não entendi, pode repetir?");
  const state1 = { lastResponseHash: first.hash, lastResponseRepeatCount: first.repeatCount };
  const second = checkResponseLoop(state1, "Não entendi, pode repetir?");
  assert.equal(second.repeatCount, 1);
  assert.equal(second.looped, false);
  const state2 = { lastResponseHash: second.hash, lastResponseRepeatCount: second.repeatCount };
  const third = checkResponseLoop(state2, "Não entendi, pode repetir?");
  assert.equal(third.repeatCount, 2);
  assert.equal(third.looped, true);
});

test("checkResponseLoop reinicia contagem quando a resposta muda", () => {
  const state = { lastResponseHash: checkResponseLoop(null, "A").hash, lastResponseRepeatCount: 3 };
  const result = checkResponseLoop(state, "Uma resposta bem diferente");
  assert.equal(result.repeatCount, 0);
  assert.equal(result.looped, false);
});

test("checkSwitchWindow permite trocas dentro do limite e bloqueia acima", () => {
  const flags = { maxSwitchesPerWindow: 2, switchWindowMinutes: 10 };
  const now = new Date("2026-08-25T12:00:00.000Z");
  const first = checkSwitchWindow(null, flags, now);
  assert.equal(first.allowed, true);
  assert.equal(first.switchCount, 1);

  const second = checkSwitchWindow(
    { switchCount: first.switchCount, switchWindowStartedAt: first.switchWindowStartedAt }, flags,
    new Date(now.getTime() + 60 * 1000),
  );
  assert.equal(second.allowed, true);
  assert.equal(second.switchCount, 2);

  const third = checkSwitchWindow(
    { switchCount: second.switchCount, switchWindowStartedAt: second.switchWindowStartedAt }, flags,
    new Date(now.getTime() + 120 * 1000),
  );
  assert.equal(third.allowed, false, "proteção contra ping-pong deveria bloquear a 3ª troca na janela");
});

test("checkSwitchWindow reinicia a janela depois do tempo configurado", () => {
  const flags = { maxSwitchesPerWindow: 1, switchWindowMinutes: 10 };
  const now = new Date("2026-08-25T12:00:00.000Z");
  const first = checkSwitchWindow(null, flags, now);
  const later = new Date(now.getTime() + 11 * 60 * 1000);
  const second = checkSwitchWindow(
    { switchCount: first.switchCount, switchWindowStartedAt: first.switchWindowStartedAt }, flags, later,
  );
  assert.equal(second.allowed, true, "após a janela expirar, a contagem deve reiniciar");
  assert.equal(second.switchCount, 1);
});
