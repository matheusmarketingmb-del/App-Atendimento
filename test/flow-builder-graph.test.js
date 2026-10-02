// Flow Builder — catálogo de nós e validação de publicação (puro, sem banco).
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  defaultGraph, nodeTypeCatalog, normalizeGraph, validateGraph,
} = require("../src/services/bot-visual-flow-graph");

const refs = {
  currentFlowId: "flow-main",
  categoryIds: new Set(["cat-suporte"]),
  userIds: new Set(["user-ana"]),
  flowIds: new Set(["flow-main", "flow-suporte"]),
  responseKeys: new Set(["SUPORTE_CARREGAMENTO"]),
  webhookKeys: new Set(["consulta_pedido"]),
  mediaKeys: new Set(["a".repeat(32) + ".png"]),
};

function node(key, type, config = {}, extra = {}) {
  return { key, type, name: key, x: 0, y: 0, config, ...extra };
}
function edge(source, sourceHandle, target) {
  return { id: `${source}:${sourceHandle}->${target}`, source, sourceHandle, target };
}
const codes = (result) => result.errors.map((error) => error.code);

test("catálogo: 14 tipos de nó, agrupados nas 6 categorias da biblioteca e nenhum de IA", () => {
  const catalog = nodeTypeCatalog();
  const types = catalog.map((item) => item.type).sort();
  assert.deepEqual(types, [
    "condition", "delay", "end", "goto_flow", "human_handoff", "media", "menu", "message", "question", "start",
    "transfer_category", "transfer_user", "variable", "webhook",
  ]);
  assert.deepEqual([...new Set(catalog.map((item) => item.group))], ["FLUXO", "MENSAGENS", "CONTROLE", "DADOS", "ATENDIMENTO", "INTEGRAÇÕES"]);
  assert.ok(catalog.every((item) => item.available === true));
  for (const aiType of ["ai", "knowledge", "classify_intent"]) assert.ok(!types.includes(aiType));
});

test("fluxo padrão (Início -> Finalizar) é válido", () => {
  const result = validateGraph(defaultGraph(), refs);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("nó de IA/Conhecimento de rascunho antigo vira 'removed' e bloqueia a publicação", () => {
  const graph = {
    nodes: [node("start", "start"), node("ia", "ai", { mode: "RESPOND" }), node("kb", "knowledge"), node("img", "image", { caption: "oi" })],
    edges: [edge("start", "next", "ia")],
  };
  const normalized = normalizeGraph(graph);
  assert.deepEqual(normalized.nodes.map((item) => item.type), ["start", "removed", "removed", "media"]);
  assert.equal(normalized.nodes[1].config.originalType, "ai");
  assert.equal(normalized.nodes[3].config.kind, "IMAGE");
  const result = validateGraph(graph, refs);
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes("NODE_REMOVED"));
});

test("validação: sem Início, nós desconectados, menu sem saída e condição incompleta", () => {
  assert.ok(codes(validateGraph({ nodes: [node("end", "end")], edges: [] }, refs)).includes("NO_START"));

  const graph = {
    nodes: [
      node("start", "start"),
      node("menu", "menu", { text: "Escolha", options: [{ id: "a", label: "Suporte" }, { id: "b", label: "Comercial" }] }),
      node("cond", "condition", { rules: [{ left: "flow.selectedOption", operator: "contains", right: "" }] }),
      node("solto", "message", { text: "ninguém chega aqui" }),
      node("end", "end"),
    ],
    edges: [edge("start", "next", "menu"), edge("menu", "opt:a", "cond"), edge("cond", "true", "end")],
  };
  const result = validateGraph(graph, refs);
  assert.ok(codes(result).includes("MENU_OUTPUT_MISSING"));
  assert.ok(codes(result).includes("CONDITION_OUTPUT_MISSING"));
  assert.ok(codes(result).includes("CONDITION_RIGHT"));
  assert.ok(result.errors.some((error) => error.code === "UNREACHABLE" && error.nodeKey === "solto"));
});

test("validação: variável inexistente, setor/usuário/fluxo/resposta/endpoint/mídia inexistentes", () => {
  const graph = {
    nodes: [
      node("start", "start"),
      node("m1", "message", { text: "Olá {{contact.cpfInexistente}} {{pedido.numero}}" }),
      node("m2", "message", { source: "LIBRARY", responseKey: "NAO_EXISTE" }),
      node("c1", "condition", { rules: [{ left: "bot.intent", operator: "==", right: "x" }] }),
      node("t1", "transfer_category", { categoryId: "cat-x" }),
      node("u1", "transfer_user", { userId: "user-x" }),
      node("g1", "goto_flow", { flowId: "flow-x" }),
      node("w1", "webhook", { endpointKey: "nao_cadastrado" }),
      node("md", "media", { kind: "IMAGE", storageKey: "b".repeat(32) + ".png" }),
    ],
    edges: [
      edge("start", "next", "m1"), edge("m1", "next", "m2"), edge("m2", "next", "c1"), edge("c1", "true", "t1"), edge("c1", "false", "w1"),
      edge("w1", "next", "md"), edge("md", "next", "u1"), edge("w1", "error", "g1"),
    ],
  };
  const result = validateGraph(graph, refs);
  const found = codes(result);
  for (const code of ["VARIABLE_NOT_FOUND", "RESPONSE_NOT_FOUND", "CATEGORY_NOT_FOUND", "USER_NOT_FOUND", "FLOW_NOT_FOUND", "ENDPOINT_NOT_FOUND", "MEDIA_NOT_FOUND"]) {
    assert.ok(found.includes(code), `esperava ${code} em ${found.join(",")}`);
  }
  // "bot.intent" (variável da IA antiga) não existe mais.
  assert.ok(result.errors.some((error) => error.nodeKey === "c1" && error.code === "VARIABLE_NOT_FOUND"));
});

test("validação: loop óbvio sem pausa é bloqueado; ciclo com Pergunta é permitido", () => {
  const loop = {
    nodes: [node("start", "start"), node("a", "message", { text: "a" }), node("b", "message", { text: "b" })],
    edges: [edge("start", "next", "a"), edge("a", "next", "b"), edge("b", "next", "a")],
  };
  assert.ok(codes(validateGraph(loop, refs)).includes("INFINITE_LOOP"));

  const retry = {
    nodes: [node("start", "start"), node("q", "question", { text: "CPF?", variable: "customer.cpf", answerType: "CPF_CNPJ" }), node("c", "condition", { rules: [{ left: "customer.cpf", operator: "exists", right: "" }] }), node("end", "end")],
    edges: [edge("start", "next", "q"), edge("q", "next", "c"), edge("c", "true", "end"), edge("c", "false", "q")],
  };
  assert.equal(validateGraph(retry, refs).valid, true);
});

test("Ir para fluxo não pode apontar para o próprio fluxo", () => {
  const graph = { nodes: [node("start", "start"), node("g", "goto_flow", { flowId: "flow-main" })], edges: [edge("start", "next", "g")] };
  assert.ok(codes(validateGraph(graph, refs)).includes("GOTO_SELF"));
});

test("variável gravável lida sem ninguém gravar vira aviso (não erro); custom.* é gravável", () => {
  const graph = {
    nodes: [
      node("start", "start"),
      node("v", "variable", { assignments: [{ key: "custom.origem", value: "site" }] }),
      node("m", "message", { text: "Pedido {{customer.orderNumber}} via {{custom.origem}}" }),
      node("end", "end"),
    ],
    edges: [edge("start", "next", "v"), edge("v", "next", "m"), edge("m", "next", "end")],
  };
  const result = validateGraph(graph, refs);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.warnings.map((warning) => warning.code), ["VARIABLE_NEVER_SET"]);
  assert.match(result.warnings[0].message, /customer\.orderNumber/);
});

test("menu aceita muitas opções (até 50) e normaliza sinônimos", () => {
  const options = Array.from({ length: 60 }, (_item, index) => ({ id: `o${index}`, label: `Opção ${index}`, keywords: "a, b ,c" }));
  const normalized = normalizeGraph({ nodes: [node("menu", "menu", { text: "x", options })], edges: [] });
  assert.equal(normalized.nodes[0].config.options.length, 50);
  assert.deepEqual(normalized.nodes[0].config.options[0].keywords, ["a", "b", "c"]);
});
