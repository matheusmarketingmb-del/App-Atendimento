const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1366, height: 900 } });
    const base = 'http://127.0.0.1:3339';
    assert.equal((await context.request.post(`${base}/api/auth/login`, { data: { email: 'bot-qa@teste.local', password: 'teste-local-bots' } })).status(), 200);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('[data-company-border]').first().waitFor();
    const { companies } = await (await context.request.get(`${base}/api/companies`)).json();
    const inspect = async () => page.locator('[data-company-border]').evaluateAll(rows => rows.map(row => ({
      title: row.title,
      background: getComputedStyle(row, '::before').backgroundImage,
      width: getComputedStyle(row, '::before').width,
      overflow: row.scrollWidth > row.clientWidth + 1,
    })));
    const allRows = await inspect();
    assert.ok(allRows.every(row => row.width === '2px' && !row.overflow));
    assert.equal(await page.locator('[data-category="UNCATEGORIZED"]').evaluate(el => Boolean(el.closest('[data-company-border]'))), false);
    for (const company of companies) {
      await page.locator(`.filters-panel [data-company-filter="${company.slug}"]`).click();
      await page.waitForFunction(name => [...document.querySelectorAll('[data-company-border]')].every(row => row.title === name), company.name);
      const rows = await inspect();
      assert.ok(rows.length > 0);
      assert.ok(rows.every(row => row.title === company.name && !row.overflow));
      const filter = page.locator('[data-company-border] [data-category]').first();
      await filter.click();
      assert.ok(await filter.evaluate(el => el.classList.contains('active')));
    }
    await page.locator('.filters-panel [data-company-filter="ALL"]').click();
    await page.waitForTimeout(500);
    await page.locator('#category-filters').scrollIntoViewIfNeeded();
    await page.locator('.filters-panel').screenshot({ path: 'storage/local-category-borders.png' });
    assert.deepEqual(errors, []);
    console.log('Bordas locais validadas: 2px, empresas, filtro ativo e sem overflow/erros JS.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
