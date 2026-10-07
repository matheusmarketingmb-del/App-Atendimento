const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const context = await browser.newContext();
    const login = await context.request.post("http://127.0.0.1:3339/api/auth/login", { data: { email: "bot-qa@teste.local", password: "teste-local-bots" } });
    assert.equal(login.status(), 200);
    for (const company of ["mibro", "sincrofit"]) {
      const response = await context.request.get(`http://127.0.0.1:3339/api/quick-replies/composer?conversationId=preview-conversation-cmp_${company}`);
      assert.equal(response.status(), 200);
      const replies = await response.json();
      assert.equal(replies.length, 2);
      assert.ok(replies.every((reply) => !reply.companyId || reply.companyId === `cmp_${company}`));
    }
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:3339/");
    await page.locator("#quick-replies-admin-button:not([hidden])").waitFor();
    console.log("Login Master e respostas por empresa: OK.");
    console.log("Botão administrativo visível; erros JS:", JSON.stringify(errors));
    assert.equal(errors.length, 0);
    for (const company of ["mibro", "sincrofit"]) {
      await page.locator(`.conversation-card[data-id="preview-conversation-cmp_${company}"]`).click();
      await page.locator("#open-quick-replies").click();
      await page.locator("#quick-reply-dialog[open]").waitFor();
      assert.equal(await page.locator("#quick-reply-list .quick-reply-card").count(), 2);
      await page.locator('#quick-reply-list [data-quick-reply-id="preview-reply-global"]').click();
      await page.waitForFunction(() => document.querySelector("#message-input").value.includes("número do seu pedido"));
      await page.locator("#message-input").fill("");
    }
    await page.locator("#open-quick-replies").click();
    await page.locator("#quick-reply-dialog[open]").waitFor();
    await page.screenshot({ path: "storage/local-multiempresa-preview.png", fullPage: true });
    assert.equal(errors.length, 0);
    console.log("Diálogo nas duas empresas e inserção no campo de mensagem: OK.");
    console.log("Prévia validada.");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
