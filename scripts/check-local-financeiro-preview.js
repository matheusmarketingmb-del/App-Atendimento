const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const base = 'http://127.0.0.1:3339';
    const master = await browser.newContext({ serviceWorkers: 'block' });
    assert.equal((await master.request.post(`${base}/api/auth/login`, { data: { email: 'bot-qa@teste.local', password: 'teste-local-bots' } })).status(), 200);
    const detail = await master.request.get(`${base}/api/conversations/financeiro-preview-conversation`);
    assert.equal(detail.status(), 200);
    assert.match(JSON.stringify(await detail.json()), /DADO FICTÍCIO PRIVADO/);
    const page = await master.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => document.querySelector('#manage-categories').click());
      await page.locator('#category-dialog[open]').waitFor();
      const row = page.locator('.category-manager-row').filter({ has: page.locator('input.managed-name[value="Financeiro — demonstração"]') });
      await row.scrollIntoViewIfNeeded();
      const toggle = row.locator('.category-private-toggle');
      assert.equal(await row.locator('.managed-private').isChecked(), true);
      const a = await toggle.boundingBox();
      const b = await row.locator('button').boundingBox();
      assert.ok(a.y + a.height <= b.y || b.y + b.height <= a.y, 'Controle de proteção não deve sobrepor Salvar');
      assert.ok(await page.locator('#category-dialog').evaluate(el => el.scrollWidth <= el.clientWidth + 2), 'Diálogo sem overflow horizontal');
      await page.locator('#category-dialog').screenshot({ path: `storage/financeiro-categories-${width}.png` });
      await page.locator('#close-categories').click();
    }
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.locator('.conversation-card[data-id="financeiro-preview-conversation"]').click();
    await page.locator('#context-panel-toggle').click();
    await page.locator('.preferred-assignee-block').waitFor({ state: 'visible' });
    await page.locator('[data-preferred-assignee-action="edit"]').click();
    await page.locator('#preferred-assignee-dialog[open]').waitFor();
    await page.waitForFunction(() => !document.querySelector('#preferred-assignee-user').disabled);
    assert.ok((await page.locator('#preferred-assignee-user').inputValue()).length > 0);
    await page.screenshot({ path: 'storage/financeiro-preferred-assignee.png', fullPage: true });
    assert.deepEqual(errors, []);
    const carlos = await browser.newContext({ serviceWorkers: 'block' });
    assert.equal((await carlos.request.post(`${base}/api/auth/login`, { data: { email: 'carlos-qa@teste.local', password: 'teste-local-bots' } })).status(), 200);
    const restricted = await carlos.request.get(`${base}/api/conversations/financeiro-preview-conversation`);
    // A conversa de demonstração pode ter sido transferida/reclassificada
    // manualmente no teste do usuário. Nesse caso Carlos pode perder todo
    // o acesso (403/404), o que também deve preservar o conteúdo privado.
    assert.ok([200, 403, 404].includes(restricted.status()));
    const body = JSON.stringify(await restricted.json());
    assert.doesNotMatch(body, /DADO FICTÍCIO PRIVADO/);
    if (restricted.status() === 200) assert.match(body, /Agora estou no atendimento comum/);
    console.log('Prévia validada: proteção no backend, atendente fixo carregado e layout desktop/celular sem sobreposição.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
