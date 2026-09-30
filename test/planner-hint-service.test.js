const test = require("node:test");
const assert = require("node:assert/strict");
const { computePlannerHint, handoffHasEvidence, reasonFromSignals } = require("../src/services/ai/planner-hint-service");

function assertForced(hint, { action, reason, needsHuman }) {
  assert.equal(hint.forceAction, action);
  assert.equal(hint.forceReason, reason);
  assert.equal(hint.forceNeedsHuman, needsHuman);
  assert.ok(hint.forceAnswer && hint.forceAnswer.length > 0);
}

// --- A) pedido explícito de humano ---------------------------------------

test("HUMANO: 'quero falar com atendente' força HANDOFF/customer_requested_human", () => {
  const hint = computePlannerHint({ message: "quero falar com atendente", history: [] });
  assertForced(hint, { action: "HANDOFF", reason: "customer_requested_human", needsHuman: true });
});

test("HUMANO: 'me transfere' força HANDOFF/customer_requested_human", () => {
  const hint = computePlannerHint({ message: "me transfere", history: [] });
  assertForced(hint, { action: "HANDOFF", reason: "customer_requested_human", needsHuman: true });
});

test("HUMANO: 'quero falar com uma pessoa' força HANDOFF/customer_requested_human", () => {
  const hint = computePlannerHint({ message: "quero falar com uma pessoa", history: [] });
  assertForced(hint, { action: "HANDOFF", reason: "customer_requested_human", needsHuman: true });
});

// --- B) risco de segurança -------------------------------------------------

test("RISCO: 'meu relogio esta muito quente' força HANDOFF/safety_issue", () => {
  const hint = computePlannerHint({ message: "meu relogio esta muito quente", history: [] });
  assertForced(hint, { action: "HANDOFF", reason: "safety_issue", needsHuman: true });
});

test("RISCO: 'minha bateria esta estufada' força HANDOFF/safety_issue", () => {
  const hint = computePlannerHint({ message: "minha bateria esta estufada", history: [] });
  assertForced(hint, { action: "HANDOFF", reason: "safety_issue", needsHuman: true });
});

// --- C) confirmação de solução ---------------------------------------------

test("RESOLVE: 'funcionou' após turno de troubleshooting força RESOLVE", () => {
  const history = [
    { role: "customer", content: "meu GS Pro 2 nao carrega" },
    { role: "assistant", content: "Confira se os contatos do relogio e do carregador estao limpos e secos." },
  ];
  const hint = computePlannerHint({ message: "funcionou", history });
  assertForced(hint, { action: "RESOLVE", reason: "customer_confirmed_solution", needsHuman: false });
});

test("RESOLVE: 'funcionou' sem contexto de troubleshooting anterior NÃO é forçado", () => {
  const hint = computePlannerHint({ message: "funcionou", history: [] });
  assert.equal(hint.forceAction, null);
});

test("RESOLVE: 'funcionou' dentro de uma frase maior NÃO é forçado (outro sentido)", () => {
  const history = [{ role: "assistant", content: "Confira se o carregador esta encaixado." }];
  const hint = computePlannerHint({ message: "funcionou o pagamento mas quero outra coisa", history });
  assert.equal(hint.forceAction, null);
});

// --- D) status de pedido sem ferramenta -------------------------------------

test("PEDIDOS: 'onde esta meu pedido 1234' força HANDOFF/tool_failure (sem ferramenta real)", () => {
  const hint = computePlannerHint({ message: "onde esta meu pedido 1234", history: [] });
  assertForced(hint, { action: "HANDOFF", reason: "tool_failure", needsHuman: true });
});

test("PEDIDOS: 'como funciona o rastreamento?' é pergunta geral, NÃO é forçado", () => {
  const hint = computePlannerHint({ message: "como funciona o rastreamento?", history: [] });
  assert.equal(hint.forceAction, null);
  assert.equal(hint.detectedSignals.orderStatusRealCase, false);
});

// --- perguntas comuns nunca disparam force ----------------------------------

test("COMERCIAL: 'quanto custa o Lite 3 Pro?' nunca é forçado", () => {
  const hint = computePlannerHint({ message: "quanto custa o Lite 3 Pro?", history: [] });
  assert.equal(hint.forceAction, null);
});

test("SUPORTE: 'meu GS Pro 2 nao carrega' nunca é forçado (fica com RAG/Qwen)", () => {
  const hint = computePlannerHint({ message: "meu GS Pro 2 nao carrega", history: [] });
  assert.equal(hint.forceAction, null);
});

// --- sinais de evidência (usados pelo guard, não forçam sozinhos) ----------

test("GARANTIA: 'como funciona a garantia?' NÃO ativa warrantyRealCase (pergunta geral)", () => {
  const hint = computePlannerHint({ message: "como funciona a garantia?", history: [] });
  assert.equal(hint.detectedSignals.warrantyRealCase, false);
});

test("GARANTIA: 'quero acionar a garantia, meu produto esta com defeito' ativa warrantyRealCase", () => {
  const hint = computePlannerHint({ message: "quero acionar a garantia, meu produto esta com defeito", history: [] });
  assert.equal(hint.detectedSignals.warrantyRealCase, true);
});

test("REEMBOLSO: 'como funciona reembolso?' NÃO ativa refundRealCase (pergunta geral)", () => {
  const hint = computePlannerHint({ message: "como funciona reembolso?", history: [] });
  assert.equal(hint.detectedSignals.refundRealCase, false);
});

test("REEMBOLSO: 'quero meu dinheiro de volta' ativa refundRealCase", () => {
  const hint = computePlannerHint({ message: "quero meu dinheiro de volta", history: [] });
  assert.equal(hint.detectedSignals.refundRealCase, true);
});

test("ATACADO: 'quero negociar desconto para 100 unidades' ativa commercialNegotiation", () => {
  const hint = computePlannerHint({ message: "quero negociar desconto para 100 unidades", history: [] });
  assert.equal(hint.detectedSignals.commercialNegotiation, true);
});

test("ATACADO: 'quero comprar 20 relogios' NÃO ativa commercialNegotiation (não é negociação de desconto)", () => {
  const hint = computePlannerHint({ message: "quero comprar 20 relogios", history: [] });
  assert.equal(hint.detectedSignals.commercialNegotiation, false);
});

test("PEDIDOS: 'meu pedido aparece entregue mas nao recebi' ativa logisticsIssue", () => {
  const hint = computePlannerHint({ message: "meu pedido aparece entregue mas nao recebi", history: [] });
  assert.equal(hint.detectedSignals.logisticsIssue, true);
});

test("PEDIDOS: 'o produto chegou quebrado' ativa logisticsIssue", () => {
  const hint = computePlannerHint({ message: "o produto chegou quebrado", history: [] });
  assert.equal(hint.detectedSignals.logisticsIssue, true);
});

// --- handoffHasEvidence / reasonFromSignals --------------------------------

test("handoffHasEvidence: reason low_confidence/tool_failure é sempre evidência própria (vem do RAG Server)", () => {
  assert.equal(handoffHasEvidence({}, "low_confidence"), true);
  assert.equal(handoffHasEvidence({}, "tool_failure"), true);
});

test("handoffHasEvidence: sem nenhum sinal e reason genérico não sobra evidência", () => {
  assert.equal(handoffHasEvidence({}, "customer_requested_human"), false);
});

test("handoffHasEvidence: qualquer sinal verdadeiro já sustenta o HANDOFF", () => {
  assert.equal(handoffHasEvidence({ logisticsIssue: true }, "anything"), true);
});

test("reasonFromSignals: escolhe o reason mais específico entre os sinais verdadeiros", () => {
  const reason = reasonFromSignals({ safetyHazard: true, logisticsIssue: true }, ["safety_issue", "logistics_issue", "low_confidence"]);
  assert.equal(reason, "safety_issue");
});

test("reasonFromSignals: sem sinal compatível com a allowlist, retorna null (caller usa o default)", () => {
  const reason = reasonFromSignals({ commercialNegotiation: true }, ["safety_issue", "low_confidence"]);
  assert.equal(reason, null);
});
