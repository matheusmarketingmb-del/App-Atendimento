const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ channel:'msedge', headless:true });
  try {
    const context = await browser.newContext({ serviceWorkers:'block', viewport:{ width:1366, height:900 } });
    const base = 'http://127.0.0.1:3339';
    assert.equal((await context.request.post(`${base}/api/auth/login`, { data:{ email:'bot-qa@teste.local', password:'teste-local-bots' } })).status(), 200);
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('mibro-theme', 'dark'));
    for (const route of ['campaigns.html', 'bots.html', 'quick-replies.html', 'integrations.html', 'operacao', 'custos-meta', '']) {
      await page.goto(`${base}/${route}`);
      await page.waitForTimeout(450);
      const controls = await page.locator('select:visible').evaluateAll(elements => elements.map(el => ({
        id:el.id, radius:getComputedStyle(el).borderRadius, scheme:getComputedStyle(el).colorScheme,
      })));
      assert.ok(controls.every(el => el.radius !== '0px' && el.scheme === 'dark'), `${route}: controles sem estilo: ${JSON.stringify(controls)}`);
    }
    await page.goto(`${base}/campaigns.html`);
    const select = page.locator('#campaign-status-filter');
    await select.click();
    await page.screenshot({ path:'storage/local-campaign-menu-open.png' });
    await page.keyboard.press('Escape');
    await select.selectOption('DRAFT');
    assert.equal(await select.inputValue(), 'DRAFT');
    for (const width of [1366,390,320]) {
      await page.setViewportSize({ width,height:900 });
      for (const selector of ['#campaign-status-filter','#campaign-settings-button','#campaign-optouts-button','#campaign-company-filter']) {
        const box = await page.locator(selector).boundingBox();
        const parent = await page.locator('.bots-sidebar').boundingBox();
        assert.ok(box.x >= parent.x && box.x + box.width <= parent.x + parent.width + 1, `${selector} fora da lateral em ${width}`);
      }
      await page.screenshot({ path:`storage/local-campaigns-menus-${width}.png`, fullPage:true });
    }
    assert.deepEqual(errors,[]);
    console.log('Seletores em 7 telas: tema escuro, bordas, filtro funcional; lateral de Campanhas alinhada em 1366/390/320px.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
