const test = require("node:test");
const assert = require("node:assert/strict");
const { STATUS, matchMenuOption, runTurn, renderTemplate, sanitizeForLog } = require("../src/services/bot-visual-flow-engine");
const { validateGraph } = require("../src/services/bot-visual-flow-graph");

// Adapter falso: registra tudo que o motor pediria para fazer.
function fakeAdapter({ ai } = {}) {
  const calls = { sent: [], transfers: [], handoffs: [], finished: [], aiCalls: [] };
  return {
    calls,
    skipDelays: false,
    async send(text) { if (text) calls.sent.push(text); },
    async sendAiAnswer(result) { calls.sent.push(`[AI] ${result.answer}`); return { simulated: true }; },
    async ai(input) { calls.aiCalls.push(input); return ai ? ai(input) : { ok: false, errorCode: "OFFLINE" }; },
    async searchKnowledge() { return { results: [] }; },
    async transferToCategory(payload) { calls.transfers.push(payload); return payload; },
    async handoff(payload) { calls.handoffs.push(payload); return {}; },
    async finish(payload) { calls.finished.push(payload); },
  };
}

const node = (key, type, config = {}, name) => ({ key, type, name: name || key, x: 0, y: 0, config });
const edge = (source, sourceHandle, target) => ({ id: `${source}:${sourceHandle}`, source, sourceHandle, target });

// START -> Mensagem -> Menu (3 opções) -> Suporte: IA -> Condição(intent) -> Transferir / Comercial: Mensagem -> Fim / Garantia: Pergunta -> Fim
function sampleGraph() {
  return {
    nodes: [
      node("start", "start"),
      node("welcome", "message", { text: "Olá {{contact.firstName}}, como podemos ajudar?" }),
      node("menu", "menu", { text: "Escolha:", options: [
        { id: "sup", label: "Suporte" }, { id: "com", label: "Comercial", keywords: ["comprar", "preço"] }, { id: "gar", label: "Garantia" },
      ] }),
      node("ai", "ai", { mode: "CLASSIFY" }),
      node("cond", "condition", { rules: [{ left: "intent", operator: "==", right: "wholesale" }] }),
      node("toSales", "transfer_category", { categoryId: "cat-comercial", message: "Vou te passar para o Comercial." }),
      node("toSupport", "transfer_category", { categoryId: "cat-suporte" }),
      node("comMsg", "message", { text: "Nosso time comercial responde em breve." }),
      node("ask", "question", { text: "Qual o número do pedido?", variable: "customer.orderNumber", answerType: "NUMBER" }),
      node("end", "end", { message: "Obrigado, {{contact.firstName}}!" }),
    ],
    edges: [
      edge("start", "next", "welcome"), edge("welcome", "next", "menu"),
      edge("menu", "opt:sup", "ai"), edge("menu", "opt:com", "comMsg"), edge("menu", "opt:gar", "ask"),
      edge("ai", "next", "cond"), edge("cond", "true", "toSales"), edge("cond", "false", "toSupport"),
      edge("comMsg", "next", "end"), edge("ask", "next", "end"),
    ],
  };
}

const seed = { contact: { name: "Maria Silva", firstName: "Maria", phone: "5511999990000" }, conversation: { id: "c1", channel: "META" } };

test("START → Mensagem → Menu: executa em sequência e pausa no Menu aguardando o cliente", async () => {
  const adapter = fakeAdapter();
  const turn = await runTurn({ graph: sampleGraph(), state: null, input: { type: "START", text: "oi" }, adapter, seed });
  assert.equal(turn.state.status, STATUS.WAITING_CUSTOMER);
  assert.equal(turn.state.currentNodeKey, "menu");
  assert.deepEqual(turn.trace.map((entry) => entry.nodeKey), ["start", "welcome", "menu"]);
  assert.equal(adapter.calls.sent[0], "Olá Maria, como podemos ajudar?");
  assert.match(adapter.calls.sent[1], /1 - Suporte\n2 - Comercial\n3 - Garantia/);
});

test("Menu com 3 opções: cada opção segue um caminho diferente (número, nome e frase)", async () => {
  const start = await runTurn({ graph: sampleGraph(), state: null, input: { type: "START" }, adapter: fakeAdapter(), seed });

  const byNumber = fakeAdapter();
  const comercial = await runTurn({ graph: sampleGraph(), state: start.state, input: { type: "MESSAGE", text: "2" }, adapter: byNumber, seed });
  assert.equal(comercial.state.status, STATUS.COMPLETED);
  assert.deepEqual(comercial.trace.map((entry) => entry.nodeKey), ["menu", "comMsg", "end"]);
  assert.equal(comercial.trace[0].branch, "opt:com");
  assert.equal(comercial.state.context.flow.selectedOption, "Comercial");

  const byPhrase = await runTurn({ graph: sampleGraph(), state: start.state, input: { type: "MESSAGE", text: "quero garantia!" }, adapter: fakeAdapter(), seed });
  assert.equal(byPhrase.state.currentNodeKey, "ask");
  assert.equal(byPhrase.trace[0].branch, "opt:gar");

  const byKeyword = await runTurn({ graph: sampleGraph(), state: start.state, input: { type: "MESSAGE", text: "quero comprar" }, adapter: fakeAdapter(), seed });
  assert.equal(byKeyword.trace[0].branch, "opt:com");

  const invalid = fakeAdapter();
  const retry = await runTurn({ graph: sampleGraph(), state: start.state, input: { type: "MESSAGE", text: "banana" }, adapter: invalid, seed });
  assert.equal(retry.state.status, STATUS.WAITING_CUSTOMER);
  assert.equal(retry.state.currentNodeKey, "menu");
  assert.match(invalid.calls.sent[0], /Não reconheci/);
});

test("Pergunta pausa o fluxo e a nova mensagem retoma salvando a variável", async () => {
  const start = await runTurn({ graph: sampleGraph(), state: null, input: { type: "START" }, adapter: fakeAdapter(), seed });
  const paused = await runTurn({ graph: sampleGraph(), state: start.state, input: { type: "MESSAGE", text: "3" }, adapter: fakeAdapter(), seed });
  assert.equal(paused.state.status, STATUS.WAITING_CUSTOMER);
  assert.equal(paused.state.currentNodeKey, "ask");

  const invalid = fakeAdapter();
  const stillWaiting = await runTurn({ graph: sampleGraph(), state: paused.state, input: { type: "MESSAGE", text: "não sei" }, adapter: invalid, seed });
  assert.equal(stillWaiting.state.currentNodeKey, "ask");
  assert.equal(stillWaiting.state.status, STATUS.WAITING_CUSTOMER);

  const done = fakeAdapter();
  const resumed = await runTurn({ graph: sampleGraph(), state: stillWaiting.state, input: { type: "MESSAGE", text: "12345" }, adapter: done, seed });
  assert.equal(resumed.state.status, STATUS.COMPLETED);
  assert.equal(resumed.state.context.customer.orderNumber, 12345);
  assert.deepEqual(done.calls.finished, [{ finalizeConversation: true }]);
  assert.equal(done.calls.sent.at(-1), "Obrigado, Maria!");
});

test("Pergunta: esgota tentativas sem saída 'inválida' → entrega para humano (nunca prende o cliente)", async () => {
  const graph = { nodes: [node("start", "start"), node("q", "question", { text: "E-mail?", answerType: "EMAIL", maxAttempts: 2, variable: "customer.email" }), node("end", "end")],
    edges: [edge("start", "next", "q"), edge("q", "next", "end")] };
  const adapter = fakeAdapter();
  let turn = await runTurn({ graph, state: null, input: { type: "START" }, adapter, seed });
  turn = await runTurn({ graph, state: turn.state, input: { type: "MESSAGE", text: "x" }, adapter, seed });
  assert.equal(turn.state.status, STATUS.WAITING_CUSTOMER);
  turn = await runTurn({ graph, state: turn.state, input: { type: "MESSAGE", text: "y" }, adapter, seed });
  assert.equal(turn.state.status, STATUS.HANDED_OFF);
  assert.equal(adapter.calls.handoffs.length, 1);
});

test("IA retorna intent e a Condição usa o intent (TRUE e FALSE) até a transferência de setor", async () => {
  const start = await runTurn({ graph: sampleGraph(), state: null, input: { type: "START" }, adapter: fakeAdapter(), seed });

  const wholesale = fakeAdapter({ ai: async () => ({ ok: true, intent: "wholesale", product: "GS_PRO_2", confidence: "HIGH", needsHuman: false, action: "RESPOND", answer: "x", reason: "atacado" }) });
  const toSales = await runTurn({ graph: sampleGraph(), state: start.state, input: { type: "MESSAGE", text: "suporte" }, adapter: wholesale, seed });
  assert.deepEqual(toSales.trace.map((entry) => entry.nodeKey), ["menu", "ai", "cond", "toSales"]);
  assert.equal(toSales.state.context.bot.intent, "wholesale");
  assert.equal(toSales.state.context.bot.product, "GS_PRO_2");
  assert.equal(toSales.trace[2].branch, "true");
  assert.equal(toSales.state.status, STATUS.HANDED_OFF);
  assert.equal(wholesale.calls.transfers[0].categoryId, "cat-comercial");
  assert.equal(wholesale.calls.aiCalls[0].message, "suporte");

  const other = fakeAdapter({ ai: async () => ({ ok: true, intent: "support", confidence: "HIGH", needsHuman: false }) });
  const toSupport = await runTurn({ graph: sampleGraph(), state: start.state, input: { type: "MESSAGE", text: "1" }, adapter: other, seed });
  assert.equal(toSupport.trace[2].branch, "false");
  assert.equal(other.calls.transfers[0].categoryId, "cat-suporte");
});

test("Condição: operadores e atalhos", async () => {
  // Retoma um Intervalo com o contexto já preenchido, só para isolar a Condição.
  const graph = (rule) => ({
    nodes: [node("wait", "delay", { amount: 1, unit: "SECONDS" }), node("c", "condition", { rules: [rule] }), node("t", "end"), node("f", "end")],
    edges: [edge("wait", "next", "c"), edge("c", "true", "t"), edge("c", "false", "f")],
  });
  const cases = [
    [{ left: "customer.cnpj", operator: "!=", right: "null" }, { customer: { cnpj: "123" } }, true],
    [{ left: "customer.cnpj", operator: "exists", right: "" }, { customer: {} }, false],
    [{ left: "channel", operator: "==", right: "META" }, { conversation: { channel: "META" } }, true],
    [{ left: "bot.confidence", operator: "==", right: "high" }, { bot: { confidence: "HIGH" } }, true],
    [{ left: "vars.qty", operator: ">=", right: "10" }, { vars: { qty: "12" } }, true],
    [{ left: "vars.qty", operator: "<", right: "10" }, { vars: { qty: "12" } }, false],
    [{ left: "flow.lastMessage", operator: "contains", right: "pedido" }, { flow: { lastMessage: "Meu PEDIDO atrasou" } }, true],
    [{ left: "flow.lastMessage", operator: "not_contains", right: "pedido" }, { flow: { lastMessage: "oi" } }, true],
    [{ left: "contact.hasOrder", operator: "==", right: "true" }, { contact: { hasOrder: true } }, true],
    [{ left: "product", operator: "==", right: "GS_PRO_2" }, { bot: { product: "GS_PRO_2" } }, true],
  ];
  for (const [rule, ctx, expected] of cases) {
    const state = { currentNodeKey: "wait", status: STATUS.WAITING_TIMER, context: { ...ctx, _engine: { attempts: {}, visited: [] } } };
    const turn = await runTurn({ graph: graph(rule), state, input: { type: "TIMER" }, adapter: fakeAdapter() });
    assert.equal(turn.trace.find((entry) => entry.nodeKey === "c").branch, expected ? "true" : "false", JSON.stringify(rule));
  }
});

test("Intervalo: não trava — devolve WAITING_TIMER com resumeAt e o TIMER retoma", async () => {
  const graph = { nodes: [node("start", "start"), node("wait", "delay", { amount: 5, unit: "SECONDS" }), node("msg", "message", { text: "pronto" }), node("end", "end")],
    edges: [edge("start", "next", "wait"), edge("wait", "next", "msg"), edge("msg", "next", "end")] };
  const now = new Date("2026-09-25T12:00:00.000Z");
  const adapter = fakeAdapter();
  const waiting = await runTurn({ graph, state: null, input: { type: "START" }, adapter, seed, now });
  assert.equal(waiting.state.status, STATUS.WAITING_TIMER);
  assert.equal(waiting.state.resumeAt, "2026-09-25T12:00:05.000Z");
  assert.equal(adapter.calls.sent.length, 0);

  const ignoredMessage = await runTurn({ graph, state: waiting.state, input: { type: "MESSAGE", text: "oi?" }, adapter, seed });
  assert.equal(ignoredMessage.ignored, true);

  const resumed = await runTurn({ graph, state: waiting.state, input: { type: "TIMER" }, adapter, seed });
  assert.equal(resumed.state.status, STATUS.COMPLETED);
  assert.deepEqual(adapter.calls.sent, ["pronto"]);
});

test("Falha num nó sem saída de erro vira FAILED + handoff (nunca fica preso em silêncio)", async () => {
  const graph = { nodes: [node("start", "start"), node("t", "transfer_category", { categoryId: "x" })], edges: [edge("start", "next", "t")] };
  const adapter = fakeAdapter();
  adapter.transferToCategory = async () => { throw new Error("setor sumiu"); };
  const turn = await runTurn({ graph, state: null, input: { type: "START" }, adapter, seed });
  assert.equal(turn.state.status, STATUS.FAILED);
  assert.equal(adapter.calls.handoffs.length, 1);
  assert.equal(turn.trace.at(-1).result, "ERROR");
});

test("Validação: fluxo inválido aponta os erros por nó", () => {
  const graph = {
    nodes: [node("start", "start"), node("start2", "start"), node("menu", "menu", { text: "", options: [{ id: "a", label: "A" }] }),
      node("c", "condition", { rules: [{ left: "intent", operator: "==", right: "x" }] }),
      node("loopA", "message", { text: "a" }), node("loopB", "message", { text: "b" }), node("orphan", "message", { text: "?" }),
      node("t", "transfer_category", { categoryId: "nao-existe" }), node("hook", "webhook", {})],
    edges: [edge("start", "next", "menu"), edge("menu", "opt:a", "c"), edge("c", "true", "loopA"), edge("loopA", "next", "loopB"), edge("loopB", "next", "loopA"), edge("start2", "next", "t"), edge("hook", "next", "t")],
  };
  const { valid, errors } = validateGraph(graph, { categoryIds: new Set(["real"]) });
  assert.equal(valid, false);
  const codes = (key) => errors.filter((error) => error.nodeKey === key).map((error) => error.code);
  assert.ok(codes("start2").includes("MULTIPLE_START"));
  assert.ok(codes("menu").includes("MENU_OPTIONS"));
  assert.ok(codes("menu").includes("MISSING_TEXT"));
  assert.ok(codes("c").includes("CONDITION_OUTPUT_MISSING"));
  assert.ok(codes("loopA").includes("INFINITE_LOOP"));
  assert.ok(codes("orphan").includes("UNREACHABLE"));
  assert.ok(codes("t").includes("CATEGORY_NOT_FOUND"));
  assert.ok(codes("hook").includes("NODE_NOT_AVAILABLE"));

  const ok = validateGraph(sampleGraph(), { categoryIds: new Set(["cat-comercial", "cat-suporte"]) });
  assert.deepEqual(ok.errors, []);
  assert.equal(validateGraph({ nodes: [], edges: [] }).errors[0].code, "NO_START");
});

test("Utilitários: template, menu e log sem segredos", () => {
  assert.equal(renderTemplate("Oi {{contact.firstName}} {{nada.aqui}}!", { contact: { firstName: "Ana" } }), "Oi Ana !");
  const options = [{ id: "a", label: "Suporte técnico", keywords: [] }, { id: "b", label: "Suporte comercial", keywords: [] }];
  assert.equal(matchMenuOption(options, "suporte"), null, "ambíguo nunca chuta");
  assert.equal(matchMenuOption(options, "opção 2").id, "b");
  assert.deepEqual(sanitizeForLog({ url: "x", headers: { Authorization: "Bearer y" }, apiKey: "z", _engine: {} }), { url: "x", headers: { Authorization: "[redacted]" }, apiKey: "[redacted]" });
});
