// Flow Builder — motor determinístico (puro, adapter falso, sem banco/rede).
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MENU_REPLY_PREFIX, STATUS, evaluateCondition, matchMenuOption, runTurn, validateAnswer,
} = require("../src/services/bot-visual-flow-engine");

function node(key, type, config = {}) {
  return { key, type, name: key, x: 0, y: 0, config };
}
function edge(source, sourceHandle, target) {
  return { id: `${source}:${sourceHandle}->${target}`, source, sourceHandle, target };
}

function fakeAdapter({ flows = {}, webhook } = {}) {
  const log = [];
  return {
    log,
    skipDelays: false,
    async send(text) { log.push(["send", text]); },
    async sendMenu(menu) { log.push(["menu", menu.options.map((option) => option.label)]); },
    async sendMedia(media) { log.push(["media", media.kind, media.caption]); },
    async transferToCategory(payload) { log.push(["transfer", payload.categoryId, payload.message]); return { categoryId: payload.categoryId }; },
    async transferToUser(payload) { log.push(["transferUser", payload.userId, payload.categoryId]); return { userId: payload.userId }; },
    async handoff(payload) { log.push(["handoff", payload.reason]); return {}; },
    async finish(payload) { log.push(["finish", payload.finalizeConversation]); },
    async loadFlow(flowId) { log.push(["loadFlow", flowId]); return flows[flowId] || null; },
    async callWebhook(payload) { log.push(["webhook", payload.endpointKey, payload.fields]); return webhook(payload); },
  };
}

const seed = {
  contact: { name: "Maria Silva", firstName: "Maria", greeting: "Olá, Maria" },
  conversation: { id: "c1", channel: "META", withinBusinessHours: true },
  bot: { name: "Atendimento", businessHours: "seg a sex", withinBusinessHours: true },
};

// START -> Mensagem -> Menu -> (Suporte) Pergunta -> Condição -> Mensagem(biblioteca) -> Transferência
//                           -> (Comercial) Finalizar
const mainGraph = {
  nodes: [
    node("start", "start", { trigger: "NEW_CONVERSATION" }),
    node("hello", "message", { text: "{{contact.greeting}}! Bem-vindo ao {{bot.name}}." }),
    node("menu", "menu", {
      text: "Como podemos ajudar?", variable: "flow.selectedOption", maxAttempts: 2, display: "LIST",
      options: [
        { id: "sup", label: "Suporte", keywords: ["problema", "ajuda", "defeito", "não funciona"] },
        { id: "com", label: "Comercial", keywords: ["comprar", "preço"] },
      ],
    }),
    node("ask", "question", { text: "Qual o número do pedido?", variable: "customer.orderNumber", answerType: "NUMBER", maxAttempts: 3 }),
    node("cond", "condition", { match: "ALL", rules: [{ left: "customer.orderNumber", operator: ">", right: "1000" }] }),
    node("tip", "message", { source: "LIBRARY", responseKey: "SUPORTE_CARREGAMENTO" }),
    node("to-support", "transfer_category", { categoryId: "cat-suporte", message: "Pedido {{customer.orderNumber}} encaminhado." }),
    node("bye", "end", { message: "Até logo!", finalizeConversation: true }),
  ],
  edges: [
    edge("start", "next", "hello"), edge("hello", "next", "menu"),
    edge("menu", "opt:sup", "ask"), edge("menu", "opt:com", "bye"),
    edge("ask", "next", "cond"), edge("cond", "true", "tip"), edge("cond", "false", "bye"), edge("tip", "next", "to-support"),
  ],
};
const responses = new Map([["SUPORTE_CARREGAMENTO", "Verifique se os contatos do relógio e do carregador estão limpos e secos, {{contact.firstName}}."]]);

test("executa nó a nó, pausa no Menu/Pergunta e retoma do ponto certo até a transferência", async () => {
  const adapter = fakeAdapter();
  const first = await runTurn({ graph: mainGraph, state: null, input: { type: "START", text: "oi" }, adapter, seed, responses });
  assert.equal(first.state.status, STATUS.WAITING_CUSTOMER);
  assert.equal(first.state.currentNodeKey, "menu");
  assert.deepEqual(adapter.log.slice(0, 2), [["send", "Olá, Maria! Bem-vindo ao Atendimento."], ["menu", ["Suporte", "Comercial"]]]);
  assert.deepEqual(first.trace.map((entry) => [entry.nodeKey, entry.result]), [["start", "OK"], ["hello", "OK"], ["menu", "WAITING"]]);

  // Sinônimo cadastrado ("não funciona") escolhe Suporte — sem IA.
  const second = await runTurn({ graph: mainGraph, state: first.state, input: { type: "MESSAGE", text: "meu relógio não funciona" }, adapter, seed, responses });
  assert.equal(second.state.currentNodeKey, "ask");
  assert.equal(second.state.context.flow.selectedOption, "Suporte");
  assert.equal(second.trace[0].branch, "opt:sup");

  // Resposta inválida (não é número): pede de novo, não avança.
  const third = await runTurn({ graph: mainGraph, state: second.state, input: { type: "MESSAGE", text: "não sei" }, adapter, seed, responses });
  assert.equal(third.state.currentNodeKey, "ask");
  assert.equal(third.state.status, STATUS.WAITING_CUSTOMER);

  const fourth = await runTurn({ graph: mainGraph, state: third.state, input: { type: "MESSAGE", text: "12345" }, adapter, seed, responses });
  assert.equal(fourth.state.status, STATUS.HANDED_OFF);
  assert.equal(fourth.state.context.customer.orderNumber, 12345);
  assert.deepEqual(fourth.trace.map((entry) => [entry.nodeKey, entry.branch]), [["ask", "next"], ["cond", "true"], ["tip", "next"], ["to-support", null]]);
  assert.ok(adapter.log.some(([kind, text]) => kind === "send" && text === "Verifique se os contatos do relógio e do carregador estão limpos e secos, Maria."));
  assert.deepEqual(adapter.log.at(-1), ["transfer", "cat-suporte", "Pedido 12345 encaminhado."]);
});

test("menu: número, nome, frase e clique na lista do WhatsApp (replyId); ambíguo não chuta", () => {
  const options = [{ id: "a", label: "Suporte", keywords: ["ajuda"] }, { id: "b", label: "Garantia", keywords: ["ajuda"] }, { id: "c", label: "Pedidos" }];
  assert.equal(matchMenuOption(options, "2")?.id, "b");
  assert.equal(matchMenuOption(options, "opção 3")?.id, "c");
  assert.equal(matchMenuOption(options, "SUPORTE")?.id, "a");
  assert.equal(matchMenuOption(options, "quero ver meus pedidos")?.id, "c");
  assert.equal(matchMenuOption(options, "preciso de ajuda"), null);
  assert.equal(matchMenuOption(options, "texto qualquer", `${MENU_REPLY_PREFIX}b`)?.id, "b");
});

test("menu esgota tentativas sem saída 'inválida' -> entrega para humano (nunca prende o cliente)", async () => {
  const adapter = fakeAdapter();
  const first = await runTurn({ graph: mainGraph, state: null, input: { type: "START" }, adapter, seed, responses });
  const second = await runTurn({ graph: mainGraph, state: first.state, input: { type: "MESSAGE", text: "xyz" }, adapter, seed, responses });
  assert.equal(second.state.status, STATUS.WAITING_CUSTOMER);
  const third = await runTurn({ graph: mainGraph, state: second.state, input: { type: "MESSAGE", text: "abc" }, adapter, seed, responses });
  assert.equal(third.state.status, STATUS.HANDED_OFF);
  assert.equal(adapter.log.at(-1)[0], "handoff");
});

test("perguntas: texto, número, telefone, e-mail, CPF/CNPJ e confirmação Sim/Não", () => {
  assert.equal(validateAnswer("TEXT", "  oi "), "oi");
  assert.equal(validateAnswer("NUMBER", "12,5"), 12.5);
  assert.equal(validateAnswer("PHONE", "(11) 99999-0000"), "11999990000");
  assert.equal(validateAnswer("EMAIL", "A@B.COM"), "a@b.com");
  assert.equal(validateAnswer("CPF_CNPJ", "123.456.789-09"), "12345678909");
  assert.equal(validateAnswer("CPF_CNPJ", "123"), null);
  assert.equal(validateAnswer("YES_NO", "Sim!"), true);
  assert.equal(validateAnswer("YES_NO", "não resolveu"), false);
  assert.equal(validateAnswer("YES_NO", "talvez"), null);
});

test("condições: ==, !=, contains, not_contains, exists, not_exists, >, <, >=, <= e booleanos", () => {
  const context = { customer: { hasOrder: true, total: 150, name: "José" }, flow: { selectedOption: "Suporte" }, conversation: { channel: "META" } };
  const check = (left, operator, right) => evaluateCondition({ rules: [{ left, operator, right }] }, context);
  assert.equal(check("customer.hasOrder", "==", "true"), true);
  assert.equal(check("flow.selectedOption", "==", "suporte"), true);
  assert.equal(check("flow.selectedOption", "!=", "Comercial"), true);
  assert.equal(check("customer.name", "contains", "jose"), true);
  assert.equal(check("customer.name", "not_contains", "maria"), true);
  assert.equal(check("customer.cnpj", "exists", ""), false);
  assert.equal(check("customer.cnpj", "not_exists", ""), true);
  assert.equal(check("customer.total", ">", "100"), true);
  assert.equal(check("customer.total", "<", "100"), false);
  assert.equal(check("customer.total", ">=", "150"), true);
  assert.equal(check("customer.total", "<=", "149"), false);
  assert.equal(check("channel", "==", "META"), true);
  assert.equal(evaluateCondition({ match: "ANY", rules: [{ left: "customer.total", operator: "<", right: "1" }, { left: "customer.hasOrder", operator: "==", right: "true" }] }, context), true);
});

test("Intervalo pausa em WAITING_TIMER e retoma só pelo timer", async () => {
  const graph = {
    nodes: [node("start", "start"), node("wait", "delay", { amount: 2, unit: "MINUTES" }), node("after", "message", { text: "Voltei" }), node("end", "end")],
    edges: [edge("start", "next", "wait"), edge("wait", "next", "after"), edge("after", "next", "end")],
  };
  const adapter = fakeAdapter();
  const now = new Date("2026-10-02T12:00:00.000Z");
  const first = await runTurn({ graph, state: null, input: { type: "START" }, adapter, seed, now });
  assert.equal(first.state.status, STATUS.WAITING_TIMER);
  assert.equal(first.state.resumeAt, "2026-10-02T12:02:00.000Z");
  const ignored = await runTurn({ graph, state: first.state, input: { type: "MESSAGE", text: "oi" }, adapter, seed });
  assert.equal(ignored.ignored, true);
  const resumed = await runTurn({ graph, state: first.state, input: { type: "TIMER" }, adapter, seed });
  assert.equal(resumed.state.status, STATUS.COMPLETED);
  assert.deepEqual(adapter.log.slice(-2), [["send", "Voltei"], ["finish", true]]);
});

test("variáveis: Variável grava em custom.*/vars.* e as mensagens usam {{...}}", async () => {
  const graph = {
    nodes: [
      node("start", "start"),
      node("set", "variable", { assignments: [{ key: "custom.origem", value: "site" }, { key: "vars.saudacao", value: "Oi {{contact.firstName}}" }] }),
      node("msg", "message", { text: "{{vars.saudacao}} ({{custom.origem}}, {{conversation.channel}})" }),
      node("end", "end", { finalizeConversation: false }),
    ],
    edges: [edge("start", "next", "set"), edge("set", "next", "msg"), edge("msg", "next", "end")],
  };
  const adapter = fakeAdapter();
  const result = await runTurn({ graph, state: null, input: { type: "START" }, adapter, seed });
  assert.equal(result.state.status, STATUS.COMPLETED);
  assert.deepEqual(adapter.log, [["send", "Oi Maria (site, META)"], ["finish", false]]);
});

test("Ir para fluxo: continua no Início do subfluxo no mesmo turno, com as mesmas variáveis", async () => {
  const triage = {
    nodes: [node("start", "start"), node("set", "variable", { assignments: [{ key: "customer.segment", value: "varejo" }] }), node("go", "goto_flow", { flowId: "flow-suporte" })],
    edges: [edge("start", "next", "set"), edge("set", "next", "go")],
  };
  const support = {
    nodes: [node("start", "start"), node("q", "question", { text: "Resolveu? ({{customer.segment}})", variable: "flow.solved", answerType: "YES_NO" }),
      node("c", "condition", { rules: [{ left: "flow.solved", operator: "==", right: "true" }] }), node("ok", "end"), node("human", "transfer_user", { userId: "user-ana" })],
    edges: [edge("start", "next", "q"), edge("q", "next", "c"), edge("c", "true", "ok"), edge("c", "false", "human")],
  };
  const adapter = fakeAdapter({ flows: { "flow-suporte": { flowId: "flow-suporte", versionId: "v-sup-3", version: 3, name: "Suporte", graph: support } } });
  const first = await runTurn({ graph: triage, flow: { flowId: "flow-triagem", versionId: "v-tri-1", version: 1, name: "Triagem" }, state: null, input: { type: "START" }, adapter, seed });
  assert.equal(first.state.status, STATUS.WAITING_CUSTOMER);
  assert.deepEqual(first.state.flow, { flowId: "flow-suporte", versionId: "v-sup-3", version: 3, name: "Suporte" });
  assert.deepEqual(adapter.log.find(([kind]) => kind === "send"), ["send", "Resolveu? (varejo)"]);
  assert.deepEqual([...new Set(first.trace.map((entry) => entry.flowId))], ["flow-triagem", "flow-suporte"]);

  // Retomada: o serviço passa o grafo do fluxo atual (Suporte).
  const second = await runTurn({ graph: support, flow: first.state.flow, state: first.state, input: { type: "MESSAGE", text: "não" }, adapter, seed });
  assert.equal(second.state.status, STATUS.HANDED_OFF);
  assert.deepEqual(adapter.log.at(-1), ["transferUser", "user-ana", null]);
});

test("Ir para fluxo inexistente/sem versão falha e entrega para humano", async () => {
  const graph = { nodes: [node("start", "start"), node("go", "goto_flow", { flowId: "nao-existe" })], edges: [edge("start", "next", "go")] };
  const adapter = fakeAdapter();
  const result = await runTurn({ graph, state: null, input: { type: "START" }, adapter, seed });
  assert.equal(result.state.status, STATUS.FAILED);
  assert.equal(adapter.log.at(-1)[0], "handoff");
});

test("Webhook: sucesso grava o resultado; falha segue pela saída Erro", async () => {
  const graph = {
    nodes: [
      node("start", "start"), node("ask", "question", { text: "Pedido?", variable: "customer.orderNumber", answerType: "TEXT" }),
      node("api", "webhook", { endpointKey: "consulta_pedido", fields: [{ key: "pedido", value: "{{customer.orderNumber}}" }], resultVariable: "vars.pedido" }),
      node("ok", "message", { text: "Status: {{vars.pedido.data.status}}" }), node("fail", "message", { text: "Sistema indisponível" }), node("end", "end"),
    ],
    edges: [edge("start", "next", "ask"), edge("ask", "next", "api"), edge("api", "next", "ok"), edge("api", "error", "fail"), edge("ok", "next", "end"), edge("fail", "next", "end")],
  };
  const success = fakeAdapter({ webhook: async () => ({ ok: true, status: 200, data: { status: "Enviado" } }) });
  const waiting = await runTurn({ graph, state: null, input: { type: "START" }, adapter: success, seed });
  await runTurn({ graph, state: waiting.state, input: { type: "MESSAGE", text: "A1" }, adapter: success, seed });
  assert.deepEqual(success.log.find(([kind]) => kind === "webhook"), ["webhook", "consulta_pedido", { pedido: "A1" }]);
  assert.ok(success.log.some(([kind, text]) => kind === "send" && text === "Status: Enviado"));

  const failure = fakeAdapter({ webhook: async () => ({ ok: false, status: 500, data: null, errorCode: "HTTP_500" }) });
  const waitingFail = await runTurn({ graph, state: null, input: { type: "START" }, adapter: failure, seed });
  const failed = await runTurn({ graph, state: waitingFail.state, input: { type: "MESSAGE", text: "A1" }, adapter: failure, seed });
  assert.equal(failed.state.status, STATUS.COMPLETED);
  assert.ok(failure.log.some(([kind, text]) => kind === "send" && text === "Sistema indisponível"));
});

test("Mídia é enviada pelo adapter com legenda renderizada", async () => {
  const graph = {
    nodes: [node("start", "start"), node("img", "media", { kind: "IMAGE", storageKey: `${"c".repeat(32)}.png`, caption: "Manual para {{contact.firstName}}" }), node("end", "end")],
    edges: [edge("start", "next", "img"), edge("img", "next", "end")],
  };
  const adapter = fakeAdapter();
  await runTurn({ graph, state: null, input: { type: "START" }, adapter, seed });
  assert.deepEqual(adapter.log[0], ["media", "IMAGE", "Manual para Maria"]);
});

test("resposta da biblioteca inexistente falha (nunca envia texto vazio) e entrega para humano", async () => {
  const graph = { nodes: [node("start", "start"), node("m", "message", { source: "LIBRARY", responseKey: "SUMIU" }), node("end", "end")], edges: [edge("start", "next", "m"), edge("m", "next", "end")] };
  const adapter = fakeAdapter();
  const result = await runTurn({ graph, state: null, input: { type: "START" }, adapter, seed, responses: new Map() });
  assert.equal(result.state.status, STATUS.FAILED);
  assert.ok(!adapter.log.some(([kind]) => kind === "send"));
});

test("nó de IA antigo publicado nunca executa: falha controlada + handoff, sem chamar nada externo", async () => {
  const graph = { nodes: [node("start", "start"), node("ia", "ai", { mode: "RESPOND" })], edges: [edge("start", "next", "ia")] };
  const adapter = fakeAdapter();
  const result = await runTurn({ graph, state: null, input: { type: "START" }, adapter, seed });
  assert.equal(result.state.status, STATUS.FAILED);
  assert.deepEqual(adapter.log.map(([kind]) => kind), ["handoff"]);
});
