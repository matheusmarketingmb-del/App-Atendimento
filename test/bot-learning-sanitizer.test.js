const test = require("node:test");
const assert = require("node:assert/strict");
const { redactPersonalData, sanitizeAgentResponse, sanitizeForLearning } = require("../src/services/bot-learning-sanitizer");

test("remove CPF do texto", () => {
  const result = redactPersonalData("meu CPF é 111.222.333-44, pode conferir?");
  assert.doesNotMatch(result, /111\.222\.333-44/);
});

test("remove número de pedido e CNPJ mantendo o restante da frase", () => {
  const result = redactPersonalData("pedido 123456 da empresa CNPJ 12.345.678/0001-90 sumiu");
  assert.doesNotMatch(result, /123456/);
  assert.doesNotMatch(result, /12\.345\.678\/0001-90/);
  assert.match(result, /sumiu/);
});

test("remove e-mail e telefone", () => {
  const result = redactPersonalData("meu email é cliente@teste.com, telefone 11988887777");
  assert.doesNotMatch(result, /cliente@teste\.com/);
  assert.doesNotMatch(result, /11988887777/);
});

test("remove sequências longas de dígitos (possível token/senha)", () => {
  const result = redactPersonalData("meu token é 9988776655443322");
  assert.doesNotMatch(result, /9988776655443322/);
});

test("sanitizeForLearning retorna null quando não sobra conteúdo útil", () => {
  assert.equal(sanitizeForLearning("111.222.333-44"), null);
  assert.equal(sanitizeForLearning(""), null);
});

test("sanitizeForLearning mantém mensagens de negócio normais intactas", () => {
  assert.equal(sanitizeForLearning("meu relógio não conecta no bluetooth"), "meu relógio não conecta no bluetooth");
});

test("sanitizeForLearning trunca textos muito longos", () => {
  const longText = "preciso de ajuda ".repeat(100);
  const result = sanitizeForLearning(longText, { maxLength: 50 });
  assert.ok(result.length <= 50);
});

test("remove o nome do cliente de uma saudação", () => {
  assert.equal(sanitizeAgentResponse("Bom dia, Vinicius! Tudo bem?"), "Bom dia! Tudo bem?");
});

test("troca o nome do atendente pelo nome configurado do Bot", () => {
  assert.equal(
    sanitizeAgentResponse("Olá! Eu sou a Thalia, assistente virtual da Mibro."),
    "Olá! Eu sou a {{botName}}, assistente virtual da Mibro.",
  );
});

test("remove nome do cliente no início de uma resposta maior", () => {
  assert.equal(sanitizeAgentResponse("Olá Fabio! Tudo bem? Poderia enviar sua mídia kit?"), "Olá! Tudo bem? Poderia enviar sua mídia kit?");
});

test("remove nome do cliente usado como vocativo", () => {
  assert.equal(sanitizeAgentResponse("Pode sim, Vinicius! Você pode escolher os modelos."), "Pode sim! Você pode escolher os modelos.");
});

test("remove nome do cliente no início seguido de vírgula", () => {
  assert.equal(sanitizeAgentResponse("Vinicius, respondendo suas dúvidas:"), "respondendo suas dúvidas:");
});

test("remove apresentação pessoal completa do atendente", () => {
  const result = sanitizeAgentResponse(
    "Tudo bem? Meu nome é Mateus e atuo como Analista Sênior de Marketing aqui na Mibro Brasil. É um prazer falar com você!",
  );
  assert.doesNotMatch(result, /Mateus|Analista Sênior/);
  assert.equal(result, "Tudo bem? É um prazer falar com você!");
});

test("remove nome após saudação com tudo certo", () => {
  const result = sanitizeAgentResponse("Bom dia tudo certo Mateus? Conseguiu algum retorno sobre agenda?");
  assert.doesNotMatch(result, /Mateus/);
  assert.match(result, /Conseguiu algum retorno/);
});

test("remove nome mesmo com erro de digitação em bom dia", () => {
  const result = sanitizeAgentResponse("Bom doa Gustavo, tudo bem? Dia 01/09 ou 03/09?");
  assert.doesNotMatch(result, /Gustavo/);
});
