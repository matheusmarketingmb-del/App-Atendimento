const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = p => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const html = read("public/index.html"), css = read("public/css/layout-fit.css"), js = read("public/js/layout-fit.js"), app = read("public/js/app.js");
test("layout uses the available viewport and a shrinking, scrollable message area", () => {
  assert.match(css, /height:calc\(100dvh - 64px\)/);
  assert.match(css, /\.chat-content \{ display:flex; flex-direction:column/);
  assert.match(css, /\.messages \{ flex:1 1 0; min-height:0/);
  assert.match(css, /\.workspace > \.chat-panel \{ grid-column:4/);
});
test("small screens alternate between list and chat; navigation remains available", () => {
  assert.match(css, /@media \(max-width:1000px\)/);
  assert.match(css, /\.workspace:has\(\.chat-panel.open\)/);
  assert.match(css, /#sidebar-toggle,#toggle-filters-panel,#toggle-conversation-list \{ display:grid/);
  assert.match(app, /if \(innerWidth <= 1000\) \{\s*setConversationListCollapsed\(false\);\s*\$\("#chat-panel"\)\.classList.remove\("open"\)/);
});
test("controls keep their IDs and handlers when moved into compact menus", () => {
  for (const id of ["chat-secondary-actions","context-panel-toggle","notes-toggle","history-toggle","pin-conversation","assignment-timeline","open-templates","open-quick-replies"]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1);
  }
  assert.match(js, /new ResizeObserver\(fit\)/);
  assert.match(js, /parent.prepend\(secondary\)/);
  assert.match(js, /target.append\(button\)/);
  assert.doesNotMatch(js, /cloneNode|fetch\(|\/api\//);
  assert.match(css, /\.chat-secondary-actions button\[hidden\] \{ display:none/);
});
