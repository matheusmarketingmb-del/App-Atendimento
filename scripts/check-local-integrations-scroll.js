const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    assert.equal((await context.request.post("http://127.0.0.1:3339/api/auth/login", { data: { email: "bot-qa@teste.local", password: "teste-local-bots" } })).status(), 200);
    const page = await context.newPage();
    for (const width of [1670, 1366, 390]) {
      await page.setViewportSize({ width, height: 768 });
      await page.goto("http://127.0.0.1:3339/integrations.html");
      await page.locator(".channel-card").first().waitFor();
      assert.equal(await page.locator("body").evaluate((el) => getComputedStyle(el).overflowY), "auto");
      await page.mouse.move(width / 2, 500);
      await page.mouse.wheel(0, 15000);
      await page.waitForFunction(() => window.scrollY > 0);
      await page.locator("#social-mapping-form button").scrollIntoViewIfNeeded();
      assert.ok(await page.locator("#social-mapping-form button").isVisible());
      const scroll = await page.evaluate(() => ({ y: scrollY, height: document.scrollingElement.scrollHeight, viewport: innerHeight }));
      assert.ok(scroll.y > 0);
      console.log(`Rolagem OK ${width}px: ${scroll.y}px; conteúdo final acessível.`);
    }
    await page.goto("http://127.0.0.1:3339/bots.html");
    await page.setViewportSize({ width: 1366, height: 768 });
    assert.equal(await page.locator("body").evaluate((el) => getComputedStyle(el).overflowY), "hidden");
    console.log("Layout de Bots preservado.");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
