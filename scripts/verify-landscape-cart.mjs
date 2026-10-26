import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const browser = await chromium.launch({ channel: process.env.SMOKE_CHANNEL ?? 'msedge' });
const base = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5201/';
mkdirSync('test-results', { recursive: true });
try {
  for (const standalone of [false, true]) {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
    ctx.on('dialog', dialog => dialog.accept());
    if (standalone) await ctx.addInitScript(() => {
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (...args) => args[0] === '-webkit-touch-callout' ? true : supports(...args);
      Object.defineProperty(navigator, 'standalone', { value: true });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '建立新的空数据库', exact: true }).click();
    await page.locator('.sidebar').waitFor();
    const fixture = await page.evaluate(async () => {
      const events = await import('/src/services/events.ts');
      const catalog = await import('/src/services/catalog.ts');
      const { initializeStock } = await import('/src/services/inventory.ts');
      const { useApp } = await import('/src/store.ts');
      const system = await import('/src/services/system.ts');
      const id = await events.createEvent({ name: '横屏购物车验证', currency: 'CNY' });
      const category = (await catalog.listCategories())[0];
      const names = ['蓝色时光 · 插画集', '春日来信 / Spring Letters', '午后茶话会', '星屑与月光', '远方的旅人', '春天的声音'];
      const ids = [];
      for (let i = 0; i < 24; i++) {
        // Synthetic SVG covers keep the regression self-contained; no user database is used.
        const colors = ['#bed9eb', '#f4c7d5', '#dbcced', '#d8e5ce', '#e9d5b8', '#c9dce2'];
        const name = names[i % names.length] + (i >= 6 ? ` ${i + 1}` : '');
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="${colors[i % 6]}"/><circle cx="340" cy="150" r="100" fill="white" opacity=".45"/><path d="M0 350Q180 170 480 420V480H0" fill="white" opacity=".4"/><text x="35" y="340" font-family="sans-serif" font-size="42" fill="#324456">COLLECTION</text><text x="35" y="395" font-family="sans-serif" font-size="28" fill="#324456">VOL. ${String(i + 1).padStart(2, '0')}</text></svg>`;
        const cover = await catalog.createAsset('image/svg+xml', 480, 480, new TextEncoder().encode(svg), `side-cart-cover-${i}`);
        const product = await catalog.createProduct({ name, type: i === 0 ? 'normal' : 'non_stock', category_id: category.id,
          default_currency: 'CNY', default_price_minor: i === 0 ? 2500 : 5000, cover_asset_id: cover });
        ids.push(product.variantId);
      }
      await events.addVariantsToEvent(id, ids);
      await initializeStock(id, ids[0], 2);
      const cash = (await events.listPaymentMethods()).find(method => method.type === 'cash');
      await events.updatePaymentMethod(cash.id, { enabled: true });
      await events.setEventPaymentMethods(id, [cash.id]);
      await events.activateEvent(id);
      await system.setPin('1234'); await system.setCurrentEventId(id);
      useApp.getState().setCurrentEvent(id); useApp.getState().unlockStaff();
      return { id, ids };
    });

    // Preview shows the selected landscape layout without touching the real cart.
    await page.locator('.sidebar a[href="/preview"]').click();
    const preview = page.locator('.preview-frame');
    await preview.locator('.kiosk-side-cart').waitFor({ state: 'visible' });
    await preview.locator('.add-btn').first().click();
    assert.equal(await preview.locator('.side-cart-item').count(), 1);
    assert.equal(await preview.getByRole('button', { name: '去结算（预览）', exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(async () => (await import('/src/store.ts')).useApp.getState().cart.length), 0);
    await page.locator('select').first().selectOption('1');
    assert.equal(await preview.locator('.kiosk-side-cart').isVisible(), false);
    await page.locator('select').first().selectOption('2');
    assert.equal(await preview.locator('.menu-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2, 'phone preview keeps two columns');

    await page.getByRole('button', { name: '进入游客菜单', exact: true }).click();
    await page.locator('.kiosk-menu .menu-card').first().waitFor();
    const cart = page.locator('.kiosk-menu .kiosk-side-cart');
    const menu = page.locator('.kiosk-menu .menu-grid');
    const body = page.locator('.kiosk-menu-body');
    const line = () => cart.locator('.side-cart-item').first();
    assert.equal(await cart.isVisible(), true);
    assert.equal(await page.locator('.kiosk-menu > .cart-bar').isVisible(), false);
    let bounds = await cart.boundingBox();
    assert.ok(Math.abs(bounds.width / (await body.boundingBox()).width - .25) < .01);
    assert.equal(await cart.getByRole('button', { name: '去结算', exact: true }).isDisabled(), true);

    const first = menu.locator('.menu-card').first();
    await first.locator('.add-btn').click();
    assert.equal(await line().locator('.qty .value').innerText(), '1');
    await line().getByRole('button', { name: '+', exact: true }).tap();
    assert.equal(await first.locator('.qty .value').innerText(), '2');
    assert.equal(await line().getByRole('button', { name: '+', exact: true }).isDisabled(), true, 'stock upper bound');
    await line().getByRole('button', { name: '−', exact: true }).tap();
    assert.equal(await first.locator('.qty .value').innerText(), '1');
    assert.match(await cart.locator('.side-cart-total').innerText(), /25\.00/);

    await page.getByPlaceholder('搜索商品名 / 分类').fill('午后');
    assert.equal(await cart.locator('.side-cart-item').count(), 1, 'filter does not hide selected items');
    await page.getByPlaceholder('搜索商品名 / 分类').fill('');
    await line().getByRole('button', { name: '−', exact: true }).tap();
    assert.equal(await cart.locator('.side-cart-item').count(), 0, 'decrementing one to zero removes the line');
    assert.equal(await first.locator('.add-btn').count(), 1);
    await first.locator('.add-btn').tap();
    await menu.locator('.add-btn').first().tap();
    await cart.getByRole('button', { name: '清空', exact: true }).tap();
    await page.locator('.modal').getByRole('button', { name: '取消', exact: true }).tap();
    assert.equal(await cart.locator('.side-cart-item').count(), 2);
    await cart.getByRole('button', { name: '清空', exact: true }).tap();
    await page.getByRole('button', { name: '确认清空', exact: true }).tap();
    assert.equal(await cart.locator('.side-cart-item').count(), 0);

    // Many lines exercise independent scrolling with the total/checkout pinned.
    for (let i = 0; i < 13; i++) await menu.locator('.add-btn').first().click();
    const count = await cart.locator('.side-cart-count').innerText();
    const checkout = cart.getByRole('button', { name: '去结算', exact: true });
    const footerBefore = await checkout.boundingBox();
    await cart.locator('.side-cart-items').evaluate(el => { el.scrollTop = 400; });
    await menu.evaluate(el => { el.scrollTop = 450; });
    assert.ok(await menu.evaluate(el => el.scrollTop) > 0);
    assert.ok(await cart.locator('.side-cart-items').evaluate(el => el.scrollTop) > 0);
    assert.equal((await checkout.boundingBox()).y, footerBefore.y);
    assert.ok(footerBefore.y + footerBefore.height <= 820);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await menu.evaluate(el => { el.scrollTop = 0; });
    await cart.locator('.side-cart-items').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: `test-results/landscape-cart-${standalone ? 'standalone' : 'browser'}.png` });

    for (const size of [{ width: 820, height: 1180 }, { width: 390, height: 844 }, { width: 1024, height: 1366 }]) {
      await page.setViewportSize(size);
      assert.equal(await cart.isVisible(), false);
      assert.equal(await page.locator('.kiosk-menu > .cart-bar').isVisible(), true);
      assert.equal(await cart.locator('.side-cart-count').innerText(), count, 'rotation retains the cart');
      if (size.width === 390) {
        await page.locator('.cart-bar button').click();
        await page.locator('.kiosk-header .title').getByText('购物车', { exact: true }).waitFor();
        await page.getByRole('button', { name: '‹ 继续选购', exact: true }).click();
        await page.locator('.kiosk-menu .menu-card').first().waitFor();
      }
    }
    for (const size of [{ width: 1024, height: 768 }, { width: 1366, height: 1024 }]) {
      await page.setViewportSize(size);
      assert.equal(await cart.isVisible(), true);
      bounds = await checkout.boundingBox();
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= size.height);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.setViewportSize({ width: 1180, height: 820 });
    // Toggle the persisted layout through the staff UI, without replacing the cart.
    async function staffSettings() {
      await page.getByRole('button', { name: '摊主处理', exact: true }).click();
      await page.locator('.pin-keys').waitFor();
      for (const digit of '1234') await page.locator(`.pin-digit:text-is("${digit}")`).click();
      await page.locator('.pin-actions button.primary').click();
      await page.locator('.sidebar a').filter({ hasText: /^设置$/ }).click();
    }
    await staffSettings();
    const toggle = page.getByRole('switch', { name: 'iPad 横屏右侧购物车', exact: true });
    await toggle.waitFor();
    assert.equal(await toggle.isChecked(), true, 'old databases default to enabled');
    await ctx.setOffline(true);
    await toggle.uncheck();
    await page.getByText('横屏改用底部购物车入口', { exact: true }).waitFor();
    await ctx.setOffline(false);
    await page.getByRole('button', { name: '进入游客菜单', exact: true }).click();
    await menu.locator('.menu-card').first().waitFor();
    assert.equal(await cart.isVisible(), false);
    assert.equal(await cart.locator('.side-cart-count').innerText(), count, 'changing layout retains selected items');
    await staffSettings();
    await page.reload();
    await page.locator('.pin-keys').waitFor();
    for (const digit of '1234') await page.locator(`.pin-digit:text-is("${digit}")`).click();
    await page.locator('.pin-actions button.primary').click();
    assert.equal(await toggle.isChecked(), false, 'layout choice survives reload');
    await page.locator('.sidebar a[href="/preview"]').click();
    assert.equal(await preview.locator('.kiosk-side-cart').isVisible(), false);
    await page.getByRole('button', { name: '进入游客菜单', exact: true }).click();
    await menu.locator('.menu-card').first().waitFor();
    assert.equal(await cart.isVisible(), false);
    const bottom = page.locator('.kiosk-menu > .cart-bar');
    assert.equal(await bottom.isVisible(), true);
    const bottomBounds = await bottom.boundingBox();
    assert.ok(bottomBounds.y >= 0 && bottomBounds.y + bottomBounds.height <= 820);
    await menu.locator('.add-btn').first().click();
    await page.screenshot({ path: `test-results/landscape-cart-bottom-${standalone ? 'standalone' : 'browser'}.png` });
    await bottom.getByRole('button', { name: '查看购物车', exact: true }).click();
    await page.getByRole('button', { name: '去结算', exact: true }).waitFor();
    await page.getByRole('button', { name: '‹ 继续选购', exact: true }).click();
    await staffSettings();
    await toggle.check();
    await page.getByText('横屏改用右侧购物车', { exact: true }).waitFor();
    await page.getByRole('button', { name: '进入游客菜单', exact: true }).click();
    await cart.waitFor({ state: 'visible' });
    // Reload intentionally clears the in-memory cart; add one item for checkout.
    await menu.locator('.add-btn').first().click();
    await ctx.setOffline(true);
    await checkout.tap();
    await page.getByRole('heading', { name: '订单内容', exact: true }).waitFor();
    await page.getByRole('button', { name: '现金', exact: true }).click();
    await page.getByRole('button', { name: /^提交订单/ }).click();
    await page.locator('.order-no').waitFor();
    await ctx.setOffline(false);
    const order = await page.evaluate(async id => {
      const { db } = await import('/src/db/client.ts');
      return (await db.read('SELECT status FROM orders WHERE event_id=?', [id]))[0];
    }, fixture.id);
    assert.equal(order.status, 'pending_payment');
    assert.deepEqual(errors, []);
    console.log(`PASS ${standalone ? 'standalone layout simulation' : 'browser'}: preview, 25% cart, quantities, stock, remove/clear, independent scroll, rotate, phone and offline checkout`);
    await ctx.close();
  }
} finally { await browser.close(); }
