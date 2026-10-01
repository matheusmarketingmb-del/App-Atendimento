const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../public/js/app.js"), "utf8");
function harness() {
  const elements = new Map();
  const storage = new Map();
  const state = { selectedId: "conversation", currentUser: { id: "agent", canManageCampaigns: true }, customerServiceWindow: { configured: true, requiresTemplate: true, state: "NOT_STARTED", senderAccountId: "commercial", senderName: "Comercial" } };
  const context = vm.createContext({ state, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, escapeHtml: value => String(value).replaceAll("<", "&lt;"), $: selector => {
    if (!elements.has(selector)) elements.set(selector, { classList: { toggle() {} }, querySelectorAll: () => [] });
    return elements.get(selector);
  } });
  vm.runInContext(source.slice(source.indexOf("function syncCustomerServiceWindow()"), source.indexOf("function templateRateLabel(")), context);
  return { state, elements, storage, run: code => vm.runInContext(code, context) };
}
test("aviso distingue iniciação, expiração e espera sem habilitar envio", () => {
  const h = harness();
  h.run("syncCustomerServiceWindow()");
  assert.match(h.elements.get("#service-window-title").textContent, /Iniciar conversa/);
  assert.equal(h.elements.get("#send-button").disabled, true);
  h.state.customerServiceWindow.state = "AWAITING_REPLY";
  h.run("syncCustomerServiceWindow()");
  assert.match(h.elements.get("#service-window-title").textContent, /Aguardando resposta/);
  h.state.customerServiceWindow.state = "EXPIRED";
  h.run("syncCustomerServiceWindow()");
  assert.match(h.elements.get("#service-window-title").textContent, /encerrada/);
  h.state.currentUser.canManageCampaigns = false;
  h.run("syncCustomerServiceWindow()");
  assert.equal(h.elements.get("#service-window-notice").hidden, false);
  assert.equal(h.elements.get("#open-required-template").hidden, true);
  h.state.customerServiceWindow.requiresTemplate = false;
  h.run("syncCustomerServiceWindow()");
  assert.equal(h.elements.get("#send-button").disabled, false);
});
test("fixados isolam usuário e número e toleram armazenamento inválido", () => {
  const h = harness();
  h.run('localStorage.setItem(templatePinsKey(), JSON.stringify([{name:"hello",language:"pt_BR"}]))');
  assert.equal(h.run("templatePins().length"), 1);
  h.state.customerServiceWindow.senderAccountId = "principal";
  assert.equal(h.run("templatePins().length"), 0);
  h.state.customerServiceWindow.senderAccountId = "commercial";
  h.state.currentUser.id = "another";
  assert.equal(h.run("templatePins().length"), 0);
  h.run('localStorage.setItem(templatePinsKey(), "broken")');
  assert.equal(h.run("templatePins().length"), 0);
});
