const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync("public/js/app.js", "utf8");
const loader = source.match(/async function loadQuickRepliesCache\(conversationId\) \{[\s\S]*?\n\}/)[0];

test("falha da API de respostas rápidas chega ao handler de erro", async () => {
  const error = new Error("Não foi possível carregar as respostas rápidas.");
  const context = vm.createContext({ state: { selectedId: "a", quickReplies: [1] }, api: async () => { throw error; } });
  vm.runInContext(loader, context);
  await assert.rejects(context.loadQuickRepliesCache("a"), (actual) => actual === error);
  assert.equal(context.state.quickReplies.length, 0);
});

test("resposta atrasada de outra conversa não substitui o cache atual", async () => {
  const context = vm.createContext({ state: { selectedId: "b", quickReplies: ["empresa-b"] }, api: async () => ["empresa-a"] });
  vm.runInContext(loader, context);
  await context.loadQuickRepliesCache("a");
  assert.deepEqual(context.state.quickReplies, ["empresa-b"]);
});
