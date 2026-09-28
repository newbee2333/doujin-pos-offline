/** Layout regression only: simulated standalone mode cannot reproduce iPadOS blur. */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const server = spawn(process.execPath, ['scripts/serve-static.mjs', 'dist'], {
  env: { ...process.env, PORT: '5197', HOST: '127.0.0.1' }, stdio: 'ignore'
});
let browser;
try {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch('http://127.0.0.1:5197')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  browser = await chromium.launch({ channel: process.env.SMOKE_CHANNEL ?? 'msedge' });
  for (const standalone of [false, true]) {
    const context = await browser.newContext();
    context.on('dialog', d => d.accept());
    if (standalone) await context.addInitScript(() => {
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (...args) => args[0] === '-webkit-touch-callout' ? true : supports(...args);
      Object.defineProperty(navigator, 'standalone', { value: true });
    });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:5197');
    await page.getByRole('button', { name: '建立新的空数据库' }).click();
    await page.locator('.sidebar').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('standalone-safe-frame')), standalone);
    for (const [width, height] of [[1180, 820], [820, 1180], [390, 844]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.locator('#root').evaluate(e => e.getBoundingClientRect().top), 0);
      if (standalone) {
        const before = await page.locator('.topbar').boundingBox();
        await page.evaluate(() => {
          const marker = document.createElement('div'); marker.id = 'scroll-probe'; marker.style.height = '2000px';
          document.querySelector('.main > .content').append(marker);
          document.querySelector('.main > .content').scrollTop = 500;
        });
        assert.ok(await page.locator('.main > .content').evaluate(e => e.scrollTop > 0));
        assert.deepEqual(await page.locator('.topbar').boundingBox(), before);
        assert.equal(await page.evaluate(() => document.querySelector('#root').scrollTop + scrollY), 0);
        assert.ok(await page.locator('.sidebar').evaluate(e => e.getBoundingClientRect().bottom <= innerHeight + 1));
        await page.evaluate(() => { document.querySelector('#scroll-probe').remove(); document.querySelector('.main > .content').scrollTop = 0; });
      }
      console.log('PASS backend layout', { standalone, width, height });
    }
    if (standalone) {
      // Exercise the menu CSS with a long synthetic catalogue, no user database involved.
      await page.evaluate(() => {
        const app = document.querySelector('.app');
        app.className = 'app app-kiosk';
        app.innerHTML = `<div class="main"><div class="kiosk-route kiosk-menu-route"><div class="kiosk"><div class="kiosk-hero"><div class="kiosk-hero-top"><strong>商品目录</strong><input placeholder="搜索商品" /><button>摊主处理</button></div></div><div class="menu-grid">${Array.from({ length: 36 }, (_, i) => `<div class="card" style="height:220px">测试商品 ${i}</div>`).join('')}</div></div></div></div>`;
      });
      for (const width of [1180, 820, 390]) {
        await page.setViewportSize({ width, height: 820 });
        const header = await page.locator('.kiosk-hero').boundingBox();
        await page.locator('.menu-grid').evaluate(e => { e.scrollTop = 500; });
        assert.ok(await page.locator('.menu-grid').evaluate(e => e.scrollTop > 0));
        assert.deepEqual(await page.locator('.kiosk-hero').boundingBox(), header);
        assert.equal(await page.locator('.kiosk-route').evaluate(e => e.scrollTop), 0);
        assert.equal(header.y, 0);
        await page.getByPlaceholder('搜索商品').fill('输入正常');
        console.log('PASS menu independent scrolling', width);
      }
      await page.addStyleTag({ content: 'html.standalone-safe-frame { --app-chrome-clearance: 24px; }' });
      assert.equal(await page.locator('#root').evaluate(e => e.getBoundingClientRect().top), 24);
      await page.evaluate(() => {
        const modal = document.createElement('div'); modal.className = 'modal-backdrop';
        modal.innerHTML = '<div class="modal"><input placeholder="弹窗测试"></div>';
        document.querySelector('#root').append(modal);
      });
      assert.equal(await page.locator('.modal-backdrop').evaluate(e => Math.round(e.getBoundingClientRect().top)), 24);
      await page.getByPlaceholder('弹窗测试').fill('正常');
      console.log('PASS nonzero safe area and modal');
    }
    await context.close();
  }
} finally { await browser?.close(); server.kill(); }
