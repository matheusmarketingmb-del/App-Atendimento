const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const base = 'http://127.0.0.1:3339';
    const context = await browser.newContext({ serviceWorkers: 'block' });
    assert.equal((await context.request.post(`${base}/api/auth/login`, { data: { email: 'bot-qa@teste.local', password: 'teste-local-bots' } })).status(), 200);
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.locator('#operations-button:not([hidden])').waitFor();
    assert.equal(await page.locator('#meta-costs-button').getAttribute('hidden'), null);
    for (const width of [1366, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [route, selector] of [['operacao', '#ops-cards .ops-card'], ['custos-meta', '#cost-total .ops-card']]) {
        const response = await page.goto(`${base}/${route}`);
        assert.equal(response.status(), 200);
        await page.locator(selector).first().waitFor();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${route} não deve ultrapassar a tela em ${width}px`);
        assert.equal(await page.locator('#toast.show.error').count(), 0);
        await page.screenshot({ path: `storage/local-${route}-${width}.png`, fullPage: true });
      }
    }
    const report = await (await context.request.get(`${base}/api/meta-costs/report?period=month`)).json();
    assert.ok(report.unpricedCount >= 2);
    assert.ok(report.total.serviceMessages >= 1);
    const agent = await browser.newContext({ serviceWorkers: 'block' });
    assert.equal((await agent.request.post(`${base}/api/auth/login`, { data: { email: 'carlos-qa@teste.local', password: 'teste-local-bots' } })).status(), 200);
    for (const route of ['/api/operations/overview', '/api/meta-costs/report', '/operacao', '/custos-meta']) {
      assert.equal((await agent.request.get(`${base}${route}`)).status(), 403, route);
    }
    assert.deepEqual(errors, []);
    console.log('Prévia dos 3 commits: telas 1366/390/320px, dados demonstrativos, menus Master e bloqueios de acesso OK.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
