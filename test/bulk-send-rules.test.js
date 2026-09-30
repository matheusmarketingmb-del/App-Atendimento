const test = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../src/services/bulk-send-rules");
const { detectCsvDelimiter, parseCsv } = require("../src/services/campaign-csv-service");

const named = {
  name: "contato_comercial_inicial", language: "pt_BR", category: "MARKETING", status: "APPROVED", supported: true,
  pricing: { rate: 0.3217 },
  variables: [
    { key: "BODY:customer_name", component: "BODY", placeholder: "customer_name", example: "Ana" },
    { key: "BODY:agent_name", component: "BODY", placeholder: "agent_name", example: "Matheus" },
  ],
};
const positional = {
  name: "cliente_inativo_retorno", language: "pt_BR", category: "UTILITY", status: "APPROVED", supported: true,
  pricing: { rate: 0.035 },
  variables: [{ key: "BODY:1", component: "BODY", placeholder: "1", example: "Maria" }],
};
const pending = { ...positional, name: "retorno_cotacao", status: "PENDING" };

test("valida telefone: DDD, país, celular com 9, internacional e zero de discagem", () => {
  assert.deepEqual(rules.normalizeRecipientPhone("(11) 99999-8888"), { phone: "5511999998888" });
  assert.deepEqual(rules.normalizeRecipientPhone("011 99999-8888"), { phone: "5511999998888" });
  assert.deepEqual(rules.normalizeRecipientPhone("+55 21 97777-7777"), { phone: "5521977777777" });
  assert.deepEqual(rules.normalizeRecipientPhone("(11) 3333-4444"), { phone: "551133334444" });
  assert.deepEqual(rules.normalizeRecipientPhone("+1 415 555 0100"), { phone: "14155550100" });
  assert.match(rules.normalizeRecipientPhone("1199999").error, /dígitos/);
  assert.match(rules.normalizeRecipientPhone("(11) 89999-8888").error, /9/);
  assert.match(rules.normalizeRecipientPhone("(10) 99999-8888").error, /DDD/);
  assert.match(rules.normalizeRecipientPhone("").error, /vazio/);
  assert.equal(rules.formatPhone("5511999998888"), "+55 (11) 99999-8888");
});

test("colar números: normaliza, separa inválidos e duplicados (com e sem 9º dígito) antes de adicionar", () => {
  const result = rules.parsePastedList([
    "11999999999", "Ana;11988888888", "(21) 97777-7777;Carlos", "11999999999", "5511 9 9999-9999",
    "1199999", "", "Joana|+55 11 96666-5555",
  ].join("\n"));
  assert.deepEqual(result.summary, { valid: 4, invalid: 1, duplicates: 2 });
  assert.deepEqual(result.valid.map((row) => row.phone), ["5511999999999", "5511988888888", "5521977777777", "5511966665555"]);
  assert.equal(result.valid[1].name, "Ana");
  assert.equal(result.valid[2].name, "Carlos");
  assert.equal(result.invalid[0].line, 6);
  // o mesmo celular com e sem o 9º dígito é a mesma pessoa
  assert.equal(rules.dedupeKey("5511999999999"), rules.dedupeKey("551199999999"));
});

test("colar números: vários telefones na mesma linha", () => {
  const result = rules.parsePastedList("11999990001, 11999990002; 11999990003");
  assert.equal(result.summary.valid, 3);
});

test("importar CSV: detecta ponto e vírgula (Excel pt-BR) e vírgula", () => {
  const text = "nome;telefone;template\nAna;11999990001;cliente_inativo_retorno\n\"Silva; Carlos\";11999990002;\n";
  assert.equal(detectCsvDelimiter(text), ";");
  assert.deepEqual(parseCsv(text, ";")[2], ["Silva; Carlos", "11999990002", ""]);
  assert.equal(detectCsvDelimiter("nome,telefone\nAna,1199"), ",");
});

test("variáveis automáticas: customer_name → nome do contato, agent_name → quem envia, {{1}} com exemplo de nome", () => {
  assert.equal(rules.suggestVariableSource({ placeholder: "customer_name", component: "BODY" }), "CONTACT_NAME");
  assert.equal(rules.suggestVariableSource({ placeholder: "nome", component: "BODY" }), "CONTACT_NAME");
  assert.equal(rules.suggestVariableSource({ placeholder: "agent_name", component: "BODY" }), "AGENT_NAME");
  assert.equal(rules.suggestVariableSource({ placeholder: "atendente", component: "BODY" }), "AGENT_NAME");
  assert.equal(rules.suggestVariableSource({ placeholder: "1", component: "BODY", example: "Maria" }), "FIRST_NAME");
  assert.equal(rules.suggestVariableSource({ placeholder: "1", component: "BODY", example: "12345" }), null);
  assert.equal(rules.suggestVariableSource({ placeholder: "order_number", component: "BODY" }), null);
});

test("variáveis em massa: customer_name individual, agent_name igual para todos", () => {
  const mapping = rules.defaultMapping(named.variables);
  const agent = { name: "Matheus Lima" };
  const rows = ["Ana", "Carlos", "João"].map((name) => rules.resolveRecipientValues(named.variables, mapping, { name }, agent).values);
  assert.deepEqual(rows.map((values) => `${values["BODY:customer_name"]} / ${values["BODY:agent_name"]}`), [
    "Ana / Matheus Lima", "Carlos / Matheus Lima", "João / Matheus Lima",
  ]);
});

test("nome ausente nunca vira “Olá, !”: bloqueia ou usa o fallback configurado", () => {
  const mapping = { "BODY:customer_name": { source: "CONTACT_NAME", fallback: "cliente" }, "BODY:agent_name": { source: "AGENT_NAME" } };
  const missing = rules.resolveRecipientValues(named.variables, mapping, { name: "" }, { name: "Matheus" });
  assert.equal(missing.nameMissing, true);
  assert.deepEqual(missing.missing, []);
  const fallback = rules.resolveRecipientValues(named.variables, mapping, { name: "", useNameFallback: true }, { name: "Matheus" });
  assert.equal(fallback.nameMissing, false);
  assert.equal(fallback.values["BODY:customer_name"], "cliente");
});

test("validação por destinatário: inválido, duplicado, opt-out, template não aprovado, variável faltando — sem derrubar os demais", () => {
  const recipients = [
    { key: "a", name: "Ana", phone: "11999990001" },
    { key: "b", name: "Ana de novo", phone: "1199990001" }, // mesmo celular sem o 9
    { key: "c", name: "Bruno", phone: "123" },
    { key: "d", name: "Carla", phone: "11999990004" },
    { key: "e", name: "", phone: "11999990005" },
    { key: "f", name: "Dani", phone: "11999990006", templateName: "retorno_cotacao", templateLanguage: "pt_BR" },
    { key: "g", name: "Edu", phone: "11999990007", templateName: "cliente_inativo_retorno", templateLanguage: "pt_BR" },
    { key: "h", name: "Fê", phone: "11999990008", contactId: "proibido" },
  ];
  const validated = rules.validateRecipients(recipients, {
    templates: [named, positional, pending], defaultTemplate: { name: named.name, language: "pt_BR" }, agent: { name: "Matheus" },
    optedOut: new Set(["5511999990004"]), forbiddenContactIds: new Set(["proibido"]),
    mappings: { "cliente_inativo_retorno|pt_BR": { "BODY:1": { source: "MANUAL" } } },
  });
  const issues = Object.fromEntries(validated.map((row) => [row.key, row.issues]));
  assert.deepEqual(issues.a, []);
  assert.deepEqual(issues.b, ["DUPLICATE"]);
  assert.deepEqual(issues.c, ["INVALID_PHONE"]);
  assert.deepEqual(issues.d, ["OPTED_OUT"]);
  assert.deepEqual(issues.e, ["NAME_MISSING"]);
  assert.deepEqual(issues.f, ["TEMPLATE_NOT_APPROVED"]);
  assert.deepEqual(issues.g, ["MISSING_VARIABLE"]);
  assert.deepEqual(issues.h, ["CONTACT_NOT_ALLOWED"]);
  assert.equal(validated.filter((row) => row.ok).length, 1);
});

test("template global, por contato e por grupo + custo estimado por categoria", () => {
  const recipients = [
    { key: "1", name: "Ana", phone: "11999990001" },
    { key: "2", name: "Carlos", phone: "11999990002" },
    { key: "3", name: "João", phone: "11999990003", templateName: "cliente_inativo_retorno", templateLanguage: "pt_BR" },
  ];
  const validated = rules.validateRecipients(recipients, {
    templates: [named, positional], defaultTemplate: { name: named.name, language: "pt_BR" }, agent: { name: "Matheus" }, mappings: {},
  });
  assert.deepEqual(validated.map((row) => row.template.name), ["contato_comercial_inicial", "contato_comercial_inicial", "cliente_inativo_retorno"]);
  assert.equal(validated[2].values["BODY:1"], "João"); // {{1}} com exemplo de nome → primeiro nome
  const summary = rules.summarize(validated, [named, positional]);
  assert.equal(summary.ready, 3);
  assert.equal(summary.templates, 2);
  assert.deepEqual(summary.cost.byCategory, { MARKETING: { count: 2, cost: 0.6434 }, UTILITY: { count: 1, cost: 0.035 } });
  assert.equal(summary.cost.total, 0.6784);
  assert.match(summary.cost.disclaimer, /estimado/);
});
