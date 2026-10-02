const test = require("node:test");
const assert = require("node:assert/strict");
const { detectSocialBehavior } = require("../src/services/bot-social-behavior-service");

test("reconhece saudações comuns e ecoa o cumprimento equivalente", () => {
  assert.equal(detectSocialBehavior("bom dia").socialBehavior, "GREETING");
  assert.equal(detectSocialBehavior("bom dia").greetingReply, "Bom dia!");
  assert.equal(detectSocialBehavior("boa tarde, tudo bem?").socialBehavior, "GREETING");
  assert.equal(detectSocialBehavior("oi").socialBehavior, "GREETING");
  assert.equal(detectSocialBehavior("opa").socialBehavior, "GREETING");
  assert.equal(detectSocialBehavior("e ai").socialBehavior, "GREETING");
});

test("saudação combinada com intenção continua sendo GREETING (não descarta o resto da frase)", () => {
  const result = detectSocialBehavior("boa tarde, meu pedido não chegou");
  assert.equal(result.socialBehavior, "GREETING");
  assert.equal(result.greetingReply, "Boa tarde!");
});

test("reconhece agradecimento", () => {
  assert.equal(detectSocialBehavior("muito obrigado").socialBehavior, "THANKS");
  assert.equal(detectSocialBehavior("valeu!").socialBehavior, "THANKS");
  assert.equal(detectSocialBehavior("vlw").socialBehavior, "THANKS");
});

test("reconhece despedida", () => {
  assert.equal(detectSocialBehavior("tchau").socialBehavior, "GOODBYE");
  assert.equal(detectSocialBehavior("até mais").socialBehavior, "GOODBYE");
});

test("reconhece small talk sobre o próprio bot sem virar intenção de negócio", () => {
  assert.equal(detectSocialBehavior("quem é você?").socialBehavior, "SMALL_TALK");
  assert.equal(detectSocialBehavior("você é robô?").socialBehavior, "SMALL_TALK");
  assert.equal(detectSocialBehavior("o que você faz?").socialBehavior, "SMALL_TALK");
});

test("reconhece confirmação e negação isoladas", () => {
  assert.equal(detectSocialBehavior("sim").socialBehavior, "CONFIRMATION");
  assert.equal(detectSocialBehavior("ss").socialBehavior, "CONFIRMATION");
  assert.equal(detectSocialBehavior("isso mesmo").socialBehavior, "CONFIRMATION");
  assert.equal(detectSocialBehavior("não").socialBehavior, "NEGATION");
  assert.equal(detectSocialBehavior("n").socialBehavior, "NEGATION");
});

test("pedido de humano tem prioridade sobre qualquer outro comportamento social", () => {
  assert.equal(detectSocialBehavior("bom dia, quero falar com um atendente").socialBehavior, "HUMAN_REQUEST");
  assert.equal(detectSocialBehavior("chama um atendente por favor").socialBehavior, "HUMAN_REQUEST");
});

test("mensagem de negócio pura não recebe rótulo social", () => {
  assert.equal(detectSocialBehavior("meu pedido não chegou").socialBehavior, null);
  assert.equal(detectSocialBehavior("essa coisa não funciona").socialBehavior, null);
});

test("mensagem vazia não recebe rótulo social", () => {
  assert.equal(detectSocialBehavior("").socialBehavior, null);
  assert.equal(detectSocialBehavior("   ").socialBehavior, null);
});
