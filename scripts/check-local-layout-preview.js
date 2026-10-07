const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.addInitScript(() => localStorage.setItem("mibro-theme", "dark"));
    assert.equal((await context.request.post("http://127.0.0.1:3339/api/auth/login", { data: { email: "bot-qa@teste.local", password: "teste-local-bots" } })).status(), 200);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:3339/");
    await page.locator("#manage-categories:not([hidden])").waitFor();
    await page.evaluate(() => document.documentElement.dataset.theme = "dark");
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const filter = page.locator(width === 390 ? "#company-filter-mobile" : "#company-filter");
      await filter.waitFor({ state: "visible" });
      const all = await filter.locator('[data-company-filter="ALL"]').boundingBox();
      const mibro = await filter.locator('[data-company-filter="mibro"]').boundingBox();
      const sincrofit = await filter.locator('[data-company-filter="sincrofit"]').boundingBox();
      assert.ok(all.y + all.height <= mibro.y);
      assert.equal(mibro.y, sincrofit.y);
      await filter.screenshot({ path: `storage/local-company-filter-${width}.png` });
      // On mobile, the category action sits in the collapsed sidebar.
      await page.evaluate(() => document.querySelector("#manage-categories").click());
      await page.locator("#category-dialog[open]").waitFor();
      const layout = await page.locator("#category-dialog").evaluate((dialog) => ({ width: dialog.clientWidth, content: dialog.scrollWidth }));
      assert.ok(layout.content <= layout.width + 1, `overflow categorias ${width}`);
      assert.equal(await page.locator('#category-parent').evaluate((el) => el.clientHeight), 38);
      await page.locator("#category-dialog").screenshot({ path: `storage/local-categories-${width}.png` });
      await page.locator("#close-categories").click();
    }
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.locator("#team-button").click();
    await page.locator("#team-dialog[open]").waitFor();
    const fields = await page.locator(".team-company-role").evaluateAll((els) => els.map((el) => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })));
    assert.equal(fields.length, 2);
    assert.deepEqual(fields[0], fields[1]);
    assert.equal(fields[0].height, 40);
    await page.locator(".team-companies").screenshot({ path: "storage/local-team-companies.png" });
    assert.deepEqual(errors, []);
    console.log("Layout aprovado: filtro em duas linhas, categorias sem overflow e cargos iguais; desktop 1366px e celular 390px.");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
