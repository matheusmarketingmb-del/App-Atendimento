const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const base = 'http://127.0.0.1:3339';
  const endpoint = '/api/contacts/financeiro-preview-contact/preferred-assignee';
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let original;
  try {
    assert.equal((await context.request.post(`${base}/api/auth/login`, { data: { email: 'bot-qa@teste.local', password: 'teste-local-bots' } })).status(), 200);
    original = await (await context.request.get(base + endpoint)).json();
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(base);
    await page.locator('.conversation-card[data-id="financeiro-preview-conversation"]').click();
    await page.locator('#context-panel-toggle').click();
    const data = await (await context.request.get(base + '/api/conversations/financeiro-preview-conversation')).json();
    assert.equal(await page.evaluate(data => {
      const before = document.querySelector('[data-preferred-assignee-action="edit"]');
      renderContextDetails(data); renderContextDetails(data);
      return before === document.querySelector('[data-preferred-assignee-action="edit"]');
    }, data), true, 'Atualizações idênticas devem preservar o botão');
    let reads = 0, writes = 0, deletes = 0;
    await page.route('**/api/contacts/financeiro-preview-contact/preferred-assignee**', async route => {
      const method = route.request().method();
      if (method === 'GET') reads++;
      if (method === 'PUT') writes++;
      if (method === 'DELETE') deletes++;
      await new Promise(resolve => setTimeout(resolve, 700));
      await route.continue();
    });
    await page.locator('[data-preferred-assignee-action="edit"]').click();
    assert.equal(await page.locator('#preferred-assignee-dialog').evaluate(el => el.open), true);
    assert.equal(await page.locator('#preferred-assignee-user').isDisabled(), true);
    assert.match(await page.locator('#preferred-assignee-feedback').textContent(), /Carregando/);
    await page.locator('#close-preferred-assignee').click();
    await page.waitForTimeout(1000);
    assert.equal(await page.locator('#preferred-assignee-dialog').evaluate(el => el.open), false, 'Resposta atrasada não pode reabrir diálogo cancelado');
    await page.locator('[data-preferred-assignee-action="edit"]').click();
    await page.waitForFunction(() => !document.querySelector('#preferred-assignee-user').disabled);
    await page.locator('#cancel-preferred-assignee').click();
    await page.locator('[data-preferred-assignee-action="remove"]').click();
    assert.match(await page.locator('[data-preferred-assignee-action="remove"]').textContent(), /Removendo/);
    await page.locator('[data-preferred-assignee-action="edit"]').filter({ hasText: 'Definir' }).waitFor();
    assert.equal(deletes, 1);
    await page.locator('[data-preferred-assignee-action="edit"]').click();
    assert.equal(await page.locator('#preferred-assignee-dialog').evaluate(el => el.open), true);
    await page.waitForFunction(() => !document.querySelector('#preferred-assignee-user').disabled);
    await page.locator('#preferred-assignee-user').selectOption(original.assignee.id);
    await page.evaluate(() => {
      const form = document.querySelector('#preferred-assignee-form');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.equal(await page.locator('#preferred-assignee-form button[type="submit"]').isDisabled(), true);
    await page.waitForFunction(() => !document.querySelector('#preferred-assignee-dialog').open);
    await page.locator('[data-preferred-assignee-action="edit"]').filter({ hasText: 'Alterar' }).waitFor();
    assert.equal(writes, 1, 'Salvar repetido não deve duplicar gravação');
    assert.equal(reads, 6, 'Uma consulta de dados e uma de candidatos por abertura');
    assert.deepEqual(errors, []);
    console.log('Cliques aprovados: abertura imediata, cancelamento seguro, remover/definir em um clique, gravação única e botões preservados.');
  } finally {
    if (original?.assignee) await context.request.put(base + endpoint, { data: { userId: original.assignee.id, enabled: original.autoRouteEnabled } });
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
