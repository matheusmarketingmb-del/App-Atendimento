// Offline layout validation. No backend, account, real customer or message sends.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_RUNTIME || "playwright");
const root = path.resolve(__dirname, "..");
const output = path.resolve(root, "backups", "layout-qa-20261002");
const sizes = [[1920,1080],[1366,768],[1280,720],[1024,768],[960,768],[683,768],[375,667],[960,540]];
(async () => {
  fs.mkdirSync(output, { recursive:true });
  const browser = await chromium.launch({ channel:"msedge", headless:true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.abort());
    const html = fs.readFileSync(path.join(root,"public/index.html"),"utf8").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").replace(/<link\b[^>]*>/g, "");
    for (const [width,height] of sizes) {
      await page.setViewportSize({width,height});
      await page.setContent(html);
      for (const name of ["app.css","responsive.css","whatsapp-send.css","supervision.css","layout-fit.css"]) await page.addStyleTag({ content:fs.readFileSync(path.join(root,"public/css",name),"utf8") });
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "dark";
        window.setFiltersPanelCollapsed = () => document.querySelector(".workspace").classList.add("filters-collapsed");
        const chat = document.querySelector("#chat-panel"); chat.classList.add("open"); chat.classList.remove("empty");
        document.querySelector("#empty-state").hidden = true;
        document.querySelector("#chat-content").hidden = false;
        document.querySelector("#contact-name").textContent = "Circuito Led/Hub eletrônico — Nome comprido para conferir a tela";
        document.querySelector("#contact-phone").textContent = "+5511961699292";
        document.querySelector("#contact-avatar").textContent = "CL";
        document.querySelector("#conversation-sender").hidden = false;
        document.querySelector("#conversation-sender").textContent = "Número: WhatsApp principal";
        for (const id of ["merge-contact","assignment-timeline","subcategory-select","open-templates"]) document.getElementById(id).hidden = false;
        for (const id of ["category-select","subcategory-select","assignee-select","priority-select"]) document.getElementById(id).innerHTML = '<option>Comercial — Nome de categoria longo</option>';
        document.querySelector("#status-badge").textContent = "Aguardando equipe";
        document.querySelector("#list-summary").textContent = "135 atendimentos";
        document.querySelector("#workspace-channel-title").textContent = "WhatsApp";
        document.querySelector("#messages").innerHTML = Array.from({length:25},(_,i)=>`<div class="message-row ${i%2?'sent':'received'}"><div class="bubble"><p>${'Mensagem comprida para conferir o espaço na conversa. '.repeat(i%3+1)}</p><footer>Gabriela Meira 10:13 ✓✓</footer></div></div>`).join('');
      });
      await page.addScriptTag({ content:fs.readFileSync(path.join(root,"public/js/layout-fit.js"),"utf8") });
      await page.waitForTimeout(300);
      async function verify(mode) {
        const result = await page.evaluate(() => {
          const required = ['#chat-content','#messages','#composer','#send-button','#message-input','#chat-overflow-toggle','#category-select','#claim-conversation','#assignee-select','#priority-select','#command-palette-trigger','#faq-button','#theme-toggle','#user-button'];
          const failures = required.flatMap(selector => {
            if (selector === '#message-input' && document.querySelector('#composer').classList.contains('audio-mode')) return [];
            const el = document.querySelector(selector), r = el.getBoundingClientRect();
            return r.width<1 || r.height<1 || r.left<-.5 || r.right>innerWidth+.5 || r.bottom>innerHeight+.5 || r.top<-.5 ? [{selector,rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}] : [];
          });
          return {failures,chatWidth:document.querySelector('#chat-panel').clientWidth,scrollHeight:document.querySelector('#messages').clientHeight};
        });
        console.log(JSON.stringify({width,height,mode,...result}));
        assert.deepEqual(result.failures,[],`${width}x${height} ${mode}: controls must stay on screen`);
        assert.ok(result.scrollHeight>=60, "messages retain usable height");
      }
      await verify("normal");
      await page.screenshot({path:path.join(output,`${width}x${height}.png`)});
      await page.evaluate(() => { document.querySelector('#audio-composer').hidden=false; document.querySelector('[data-audio-recording]').hidden=true; document.querySelector('[data-audio-preview]').hidden=false; document.querySelector('#composer').classList.add('audio-mode'); });
      await verify("audio-preview");
      await page.evaluate(() => { document.querySelector('#audio-composer').hidden=true; document.querySelector('#composer').classList.remove('audio-mode'); });
      await page.evaluate(() => { document.querySelector('#service-window-notice').hidden=false; document.querySelector('#composer').classList.add('window-closed'); });
      await verify("template-notice");
      await page.evaluate(() => { document.querySelector('#service-window-notice').hidden=true; document.querySelector('#composer').classList.remove('window-closed'); document.querySelector('.chat-overflow').classList.add('open'); });
      const menu = await page.locator('.chat-overflow-panel').boundingBox();
      assert.ok(menu && menu.x>=0 && menu.x+menu.width<=width+.5 && menu.y+menu.height<=height+.5, 'more-actions menu must fit');
      await page.evaluate(() => { document.querySelector('.chat-overflow').classList.remove('open'); document.querySelector('.workspace').classList.add('context-open'); });
      await verify("details-overlay");
      if (width<=1000) {
        await page.evaluate(() => { document.querySelector('.workspace').classList.remove('context-open'); document.querySelector('#chat-panel').classList.remove('open'); });
        await page.waitForTimeout(300);
        const list = await page.locator('.conversation-list-panel').boundingBox();
        assert.ok(list.width>width-5, "small screens use a full-width conversation list");
      }
    }
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
