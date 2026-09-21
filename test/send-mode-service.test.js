const test = require("node:test");
const assert = require("node:assert/strict");
const { SEND_MODES, getSendMode, resolveSender, blockedRealSender } = require("../src/services/ai/send-mode-service");

test("modo ativo do sistema é sempre DRY_RUN", () => {
  assert.equal(getSendMode(), SEND_MODES.DRY_RUN);
});

test("resolveSender em SHADOW/DRY_RUN devolve o sender falso passado", () => {
  const fakeDryRun = () => "chamado";
  assert.equal(resolveSender(SEND_MODES.SHADOW, { dryRunSender: fakeDryRun }), fakeDryRun);
  assert.equal(resolveSender(SEND_MODES.DRY_RUN, { dryRunSender: fakeDryRun }), fakeDryRun);
});

test("resolveSender em LIVE nunca devolve o sender falso — devolve algo que sempre lança", () => {
  const fakeDryRun = () => "chamado";
  const sender = resolveSender(SEND_MODES.LIVE, { dryRunSender: fakeDryRun });
  assert.notEqual(sender, fakeDryRun);
  assert.throws(() => sender(), /Sender real não está implementado/);
});

test("blockedRealSender sempre lança, chamado diretamente", () => {
  assert.throws(() => blockedRealSender(), /nenhuma chamada real é permitida/);
});

test("item de segurança: mesmo se getSendMode() um dia devolver LIVE, o sender resolvido nunca envia de verdade", () => {
  const sender = resolveSender("LIVE", { dryRunSender: () => ({ sent: true }) });
  assert.throws(() => sender({ text: "qualquer coisa" }));
});
