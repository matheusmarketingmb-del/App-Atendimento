const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const context = await browser.newContext();
    const login = await context.request.post("http://127.0.0.1:3339/api/auth/login", { data: { email: "bot-qa@teste.local", password: "teste-local-bots" } });
    assert.equal(login.status(), 200);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let checks = 0;
    for (const size of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 680, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      await page.goto("http://127.0.0.1:3339/bots.html");
      await page.locator("#editor:not([hidden])").waitFor();
      assert.deepEqual(await page.locator(".workspace-tabs button").allTextContents(), ["Geral", "Disponibilidade", "Qualidade", "Simulador", "Observação"]);
      for (const tab of ["bot", "availability", "quality", "simulator", "observation"]) {
        await page.locator(`[data-tab="${tab}"]`).click();
        assert.equal(await page.locator(`[data-config-panel="${tab}"]`).isVisible(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false, `overflow ${size.width} ${tab}`);
        checks++;
      }
    }
    await page.locator('.bot-card').filter({ hasText: 'Assistente Mibro Brasil' }).click();
    await page.waitForFunction(() => document.querySelector('#editor-title')?.textContent === 'Assistente Mibro Brasil');
    await page.locator('[data-tab="simulator"]').click();
    await page.locator('#simulation-message').fill('Olá');
    await page.locator('#simulation-form button').click();
    await page.locator('#simulation-history small').first().waitFor();
    assert.match(await page.locator('#simulation-history').textContent(), /WAITING_CUSTOMER/);
    await page.locator('.bot-card').filter({ hasText: 'Triagem Inicial' }).click();
    await page.waitForFunction(() => document.querySelector('#editor-title')?.textContent === 'Triagem Inicial');
    await page.locator('[data-tab="simulator"]').click();
    await page.locator('#simulation-time').fill('2026-10-05T11:00');
    const simulate = async (message) => {
      const turns = await page.locator('#simulation-history small').count();
      await page.locator('#simulation-message').fill(message);
      const [response] = await Promise.all([page.waitForResponse((response) => response.url().includes('/simulate') && response.request().method() === 'POST'), page.locator('#simulation-form button').click()]);
      assert.equal(response.status(), 200);
      const result = await response.json(); assert.equal(result.dryRun, true);
      await page.waitForFunction((count) => document.querySelectorAll('#simulation-history small').length === count, turns + 1);
      return result;
    };
    const menu = await simulate('Olá');
    const options = menu.outputs.find((output) => output.options)?.options || [];
    const commercialOption = options.findIndex((option) => option.label === 'Comercial') + 1;
    assert.ok(commercialOption > 0);
    const assistant = await simulate(String(commercialOption));
    assert.equal(assistant.botId, 'mibro-assistant-observer');
    assert.equal(assistant.state.context.conversation.categoryName, 'Comercial');
    assert.equal(assistant.state.currentNodeKey, 'problem');
    const warranty = await simulate('Qual é a garantia?');
    assert.ok(warranty.outputs.some((output) => output.text?.includes('12 meses')));
    assert.equal(warranty.state.currentNodeKey, 'helped');
    const done = await simulate('sim');
    assert.equal(done.status, 'COMPLETED');
    await page.locator('.bot-card').filter({ hasText: 'Assistente Mibro Brasil' }).click();
    await page.waitForFunction(() => document.querySelector('#editor-title')?.textContent === 'Assistente Mibro Brasil');
    await page.locator('#simulation-reset').click();
    await simulate('Olá');
    await simulate('Quero comprar um produto');
    const product = await simulate('Lite 3 Pro');
    assert.ok(product.outputs.some((output) => output.text?.includes('https://mibrobrasil.com.br/products/mibro-lite-3-pro') && output.text.includes('•')));
    assert.ok(product.outputs.some((output) => output.options?.some((option) => option.label === 'Voltar')));
    const previous = await simulate('Voltar');
    assert.equal(previous.state.currentNodeKey, 'answer_products');
    await simulate('Lite 3');
    const seller = await simulate('quero falar com um vendedor');
    assert.equal(seller.status, 'HANDED_OFF');
    console.log('Ficha + link + Voltar + vendedor aprovados na interface, sem envio real.');
    console.log('Sequência Triagem → Comercial → Assistente → garantia → conclusão aprovada na interface.');
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.locator('[data-tab="bot"]').click();
    await page.screenshot({ path: 'C:/App Whats/.tmp-bot-qa-ui.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`${checks} verificações de interface aprovadas, sem erros JS.`);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
