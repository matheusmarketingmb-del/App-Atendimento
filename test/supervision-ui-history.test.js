const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("Ver atendimentos abre Histórico da pessoa, sem filtros antigos da caixa", async () => {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: "", textContent: "", open: false,
      showModal() { this.open = true; }, querySelector(selector) { return node(`${id}:${selector}`); } });
    return nodes.get(id);
  };
  const calls = [];
  const context = { window: {}, document: { getElementById: node }, URLSearchParams, Intl,
    state: { currentUser: { isMaster: true, role: "ADMIN" }, categories: [] },
    escapeHtml: String, toast: (message) => { throw new Error(message); },
    clearTimeout() {}, setTimeout(fn) { Promise.resolve().then(fn); return 1; },
    api: async (url) => {
      calls.push(url);
      if (url === "/api/supervision/teams") return [];
      if (url === "/api/supervision/overview") return { members: [{ id: "rafaela", name: "Rafaela", active: true }] };
      return { rows: [], total: 0, page: 1, pageSize: 30 };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/js/supervision.js"), "utf8"), context);
  await context.window.WaSupervision.open({ memberId: "rafaela", tab: "history" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.includes("/api/supervision/members/rafaela/conversations?tab=history&page=1"));
  assert.equal(node("supervision-dialog").open, true);
  const app = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
  assert.match(app, /WaSupervision\.open\(\{ memberId: view\.dataset\.viewUser, tab: "history" \}\)/);
});
