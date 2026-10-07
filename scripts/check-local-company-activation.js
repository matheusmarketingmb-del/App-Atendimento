const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const base='http://127.0.0.1:3339';
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1366,height:900}});
    assert.equal((await context.request.post(`${base}/api/auth/login`,{data:{email:'bot-qa@teste.local',password:'teste-local-bots'}})).status(),200);
    const page=await context.newPage();
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    const toggle='[data-company-activation="cmp_sincrofit"]';
    const state=await (await context.request.get(`${base}/api/admin/companies`)).json();
    if(!state.companies.find(c=>c.id==='cmp_sincrofit').active) await context.request.patch(`${base}/api/admin/companies/cmp_sincrofit`,{data:{active:true}});
    await page.goto(`${base}/configuracoes.html`);
    await page.locator(toggle).waitFor();
    assert.equal(await page.locator(toggle).getAttribute('aria-checked'),'true');
    await Promise.all([page.waitForEvent('load'),page.locator(toggle).click()]);
    await page.locator(`${toggle}[aria-checked="false"]`).waitFor();
    // Somente a tela Master de ativação continua mostrando a empresa oculta.
    assert.equal((await context.request.patch(`${base}/api/admin/companies/cmp_mibro`,{data:{active:false}})).status(),400);
    for(const route of ['', 'campaigns.html','bots.html','quick-replies.html','integrations.html','operacao','custos-meta']) {
      await page.goto(`${base}/${route}`);
      await page.waitForTimeout(450);
      assert.equal(await page.locator('[data-company-filter="sincrofit"]:visible').count(),0,route);
      const active=await (await context.request.get(`${base}/api/companies`)).json();
      assert.equal(active.companies.length,1);
      const labels=await page.locator('select option').allTextContents();
      assert.ok(labels.every(text=>!/sincrofit/i.test(text)),`${route}: opção da empresa oculta`);
      if(route==='') assert.equal(await page.locator('.conversation-card[data-company="sincrofit"]').count(),0);
    }
    const categories=await (await context.request.get(`${base}/api/categories`)).json();
    assert.ok(categories.every(c=>c.companyId!=='cmp_sincrofit'));
    await page.goto(`${base}/configuracoes.html`);
    await page.locator(`${toggle}[aria-checked="false"]`).waitFor();
    await Promise.all([page.waitForEvent('load'),page.locator(toggle).click()]);
    await page.locator(`${toggle}[aria-checked="true"]`).waitFor();
    await page.goto(base);
    await page.locator('.filters-panel [data-company-filter="sincrofit"]:visible').waitFor();
    assert.ok((await (await context.request.get(`${base}/api/categories`)).json()).some(c=>c.companyId==='cmp_sincrofit'));
    // Conforme solicitado, deixa a segunda empresa desativada na prévia local.
    await page.goto(`${base}/configuracoes.html`);
    await page.locator(toggle).waitFor();
    await Promise.all([page.waitForEvent('load'),page.locator(toggle).click()]);
    await page.locator(`${toggle}[aria-checked="false"]`).waitFor();
    await page.setViewportSize({width:390,height:900});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.locator('#company-activation-panel').screenshot({path:'storage/local-company-activation.png'});
    assert.deepEqual(errors,[]);
    console.log('Ativação/desativação local validada: 7 telas sem Sincrofit, reativação restaura, última empresa protegida; Sincrofit deixada desativada.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
