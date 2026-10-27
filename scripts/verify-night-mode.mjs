import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const base = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5201/';
const browser = await chromium.launch({ channel: process.env.SMOKE_CHANNEL ?? 'msedge' });
mkdirSync('test-results', { recursive: true });
const theme = page => page.locator('html').getAttribute('data-theme');
const color = (locator, property = 'backgroundColor') => locator.evaluate((el, key) => getComputedStyle(el)[key], property);
const screenshot = (page, path) => page.screenshot({ path, animations: 'disabled' });

// Measure computed colors, not the contrast numbers claimed by the supplied spec.
async function assertContrast(page, label) {
  const failures = await page.evaluate(() => {
    const rgb = value => value.match(/[\d.]+/g).map(Number);
    const luminance = value => {
      const channels = value.slice(0, 3).map(n => { const c = n / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
      return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    };
    const pairs = [
      ['--ink', '--surface'], ['--ink-2', '--surface'], ['--ink-3', '--surface-2'],
      ['--accent', '--surface'], ['--accent', '--accent-soft'],
      ['--warn', '--warn-soft'], ['--danger', '--danger-soft'], ['--ok', '--ok-soft'],
      ['#fff', '--accent-fill'], ['#fff', '--accent-fill-hover'],
      ['#fff', '--danger-fill'], ['#fff', '--danger-fill-hover']
    ];
    const probe = document.createElement('span'); document.body.append(probe);
    const resolved = value => { probe.style.color = value.startsWith('--') ? `var(${value})` : value; return rgb(getComputedStyle(probe).color); };
    const bad = pairs.map(([fg, bg]) => {
      const a = luminance(resolved(fg)), b = luminance(resolved(bg));
      return { fg, bg, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
    }).filter(pair => pair.contrast < 4.5);
    // Check actual selected/hovered buttons as well as tokens: selectors can
    // accidentally replace a filled button's background while keeping white text.
    for (const el of document.querySelectorAll('button.primary, .chip.active, .add-btn, .pos-add, .seg-item.active, .pick-btn.on, .cart-bar button, .toast button')) {
      if (el.disabled || !el.getClientRects().length || !el.textContent.trim()) continue;
      const fg = rgb(getComputedStyle(el).color);
      let ancestor = el, bg;
      while (ancestor) {
        const candidate = rgb(getComputedStyle(ancestor).backgroundColor);
        if (candidate.length < 4 || candidate[3] === 1) { bg = candidate; break; }
        ancestor = ancestor.parentElement;
      }
      if (!bg) continue;
      const a = luminance(fg), b = luminance(bg);
      const contrast = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      if (contrast < 4.5) bad.push({ button: el.textContent.trim(), contrast });
    }
    probe.remove();
    return bad;
  });
  assert.deepEqual(failures, [], `${label}: text contrast must reach 4.5:1`);
}

try {
  // Stored override takes effect even while the application bundle is delayed.
  const boot = await browser.newContext({ colorScheme: 'light' });
  boot.on('dialog', dialog => dialog.accept());
  await boot.addInitScript(() => localStorage.setItem('doujin-pos:theme', 'dark'));
  const first = await boot.newPage();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await first.route('**/src/main.tsx', async route => { await gate; await route.continue(); });
  await first.goto(base, { waitUntil: 'commit' });
  await first.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await first.locator('#root').evaluate(el => el.childElementCount), 0, 'theme applies before app rendering');
  assert.equal(await color(first.locator('html')), 'rgb(20, 22, 28)');
  assert.equal(await first.locator('meta[name="theme-color"]').getAttribute('content'), '#1b1e26');
  release();
  await first.getByRole('button', { name: '建立新的空数据库', exact: true }).waitFor();
  await boot.close();

  for (const standalone of [false, true]) {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, colorScheme: 'dark' });
    ctx.on('dialog', dialog => dialog.accept());
    if (standalone) await ctx.addInitScript(() => {
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (...args) => args[0] === '-webkit-touch-callout' ? true : supports(...args);
      Object.defineProperty(navigator, 'standalone', { value: true });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    assert.equal(await theme(page), 'dark', 'new device follows the system before setup');
    await page.getByRole('button', { name: '建立新的空数据库', exact: true }).click();
    await page.locator('.sidebar').waitFor();
    await page.evaluate(async () => {
      const events = await import('/src/services/events.ts');
      const catalog = await import('/src/services/catalog.ts');
      const system = await import('/src/services/system.ts');
      const { useApp } = await import('/src/store.ts');
      const id = await events.createEvent({ name: '夜间模式验证展', currency: 'CNY' });
      const category = (await catalog.listCategories())[0];
      const ids = [];
      for (let i = 0; i < 9; i++) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="${['#bed9eb', '#f4c7d5', '#dbcced'][i % 3]}"/><circle cx="290" cy="120" r="90" fill="white" opacity=".4"/><text x="24" y="300" font-size="30" fill="#334155">COLLECTION ${i + 1}</text></svg>`;
        const asset = i === 2 ? null : await catalog.createAsset('image/svg+xml', 400, 400, new TextEncoder().encode(svg), `night-cover-${i}`);
        const product = await catalog.createProduct({ name: ['春日来信 · 插画集', '星屑与月光', '尚未上传封面的新刊'][i % 3] + (i > 2 ? ` ${i + 1}` : ''),
          type: 'non_stock', category_id: category.id, default_currency: 'CNY', default_price_minor: 2500 + i * 500, cover_asset_id: asset });
        ids.push(product.variantId);
      }
      await events.addVariantsToEvent(id, ids);
      // Synthetic QR-like image tests image treatment only, not payment/scanner recognition.
      const qrSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><path fill="black" d="M20 20h60v60H20zM120 20h60v60h-60zM20 120h60v60H20zM120 120h30v30h-30z"/></svg>';
      const qr = await catalog.createAsset('image/svg+xml', 200, 200, new TextEncoder().encode(qrSvg), 'night-qr-test');
      const method = await events.createPaymentMethod({ name: '扫码测试', type: 'qr_payment', qr_asset_id: qr });
      const cash = (await events.listPaymentMethods()).find(m => m.type === 'cash');
      await events.updatePaymentMethod(cash.id, { enabled: true });
      await events.setEventPaymentMethods(id, [cash.id, method]);
      await events.activateEvent(id);
      await system.setPin('1234'); await system.setCurrentEventId(id);
      useApp.getState().setCurrentEvent(id); useApp.getState().unlockStaff();
    });
    const suffix = standalone ? 'standalone' : 'browser';
    const settings = () => page.locator('.sidebar a').filter({ hasText: /^设置$/ }).click();
    await settings();
    const choices = page.getByRole('radiogroup', { name: '外观模式' });
    assert.equal(await choices.getByRole('radio', { name: /跟随系统/ }).isChecked(), true);
    await assertContrast(page, 'dark tokens');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await assertContrast(page, 'light tokens');
    await choices.getByRole('radio', { name: /^深色/ }).check();
    assert.equal(await theme(page), 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    assert.equal(await theme(page), 'dark', 'explicit dark overrides system light');
    await screenshot(page, `test-results/night-settings-${suffix}.png`);

    // Same-device refresh/offline choice changes do not write business data.
    await ctx.setOffline(true);
    await choices.getByRole('radio', { name: /^浅色/ }).check();
    assert.equal(await theme(page), 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    assert.equal(await theme(page), 'light', 'explicit light overrides system dark');
    await choices.getByRole('radio', { name: /跟随系统/ }).check();
    assert.equal(await theme(page), 'dark', 'switching back to system resumes following it');
    await choices.getByRole('radio', { name: /^深色/ }).check();
    await ctx.setOffline(false);
    await page.reload();
    await page.locator('.pin-keys').waitFor();
    assert.equal(await theme(page), 'dark', 'stored choice survives reopening');
    for (const digit of '1234') await page.locator(`.pin-digit:text-is("${digit}")`).click();
    await page.locator('.pin-actions button.primary').click();
    await choices.waitFor();
    assert.equal(await choices.getByRole('radio', { name: /^深色/ }).isChecked(), true);
    const otherTab = await ctx.newPage();
    await otherTab.goto(new URL('favicon.svg', base).href);
    await otherTab.evaluate(() => localStorage.setItem('doujin-pos:theme', 'light'));
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.equal(await choices.getByRole('radio', { name: /^浅色/ }).isChecked(), true, 'same-browser tabs synchronize the preference');
    await otherTab.evaluate(() => localStorage.setItem('doujin-pos:theme', 'dark'));
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await otherTab.close();

    // Shared modal: only form contents scroll, actions remain visible.
    await page.locator('.sidebar a[href="/staff/products"]').click();
    await page.getByRole('button', { name: '新增商品', exact: true }).click();
    const modal = page.locator('.modal');
    await modal.waitFor();
    for (const size of [{ width: 1180, height: 820 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      const actions = await modal.locator('.modal-actions').boundingBox();
      assert.ok(actions.y >= 0 && actions.y + actions.height <= size.height, 'modal actions stay in view');
      const before = actions.y;
      await modal.locator('.modal-content').evaluate(el => { el.scrollTop = el.scrollHeight; });
      assert.equal((await modal.locator('.modal-actions').boundingBox()).y, before, 'scrolling the editor keeps actions stationary');
    }
    await screenshot(page, `test-results/night-modal-phone-${suffix}.png`);
    await modal.getByRole('button', { name: '取消', exact: true }).click();
    await page.setViewportSize({ width: 1180, height: 820 });
    for (const path of ['/staff/checkout', '/staff/reports', '/staff/orders', '/staff/backup']) {
      await page.locator(`.sidebar a[href="${path}"]`).click();
      await page.locator('.content h1, .content h2').first().waitFor();
      assert.equal(await color(page.locator('.sidebar')), 'rgb(27, 30, 38)');
      await screenshot(page, `test-results/night-${path.split('/').pop()}-${suffix}.png`);
    }

    await page.getByRole('button', { name: '进入游客菜单', exact: true }).click();
    const menu = page.locator('.kiosk-menu');
    await menu.locator('.menu-card').first().waitFor();
    assert.equal(await color(menu.locator('.kiosk-hero')), 'rgb(27, 30, 38)');
    assert.equal(await color(menu.locator('.menu-card-cover').first()), 'rgb(27, 30, 38)');
    assert.equal(await menu.locator('.menu-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 4);
    assert.equal(await menu.locator('.thumb').first().evaluate(el => getComputedStyle(el).filter), 'none', 'cover art is not inverted');
    await menu.locator('.add-btn').first().tap();
    await menu.locator('.add-btn').first().tap();
    const cart = menu.locator('.kiosk-side-cart');
    assert.equal(await color(cart.locator('.side-cart-footer')), 'rgb(27, 30, 38)');
    await cart.getByRole('button', { name: '+', exact: true }).first().tap();
    assert.equal(await cart.locator('.side-cart-count').innerText(), '3 件');
    await screenshot(page, `test-results/night-menu-${suffix}.png`);
    for (const size of [{ width: 1024, height: 768 }, { width: 820, height: 1180 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await screenshot(page, `test-results/night-menu-${size.width}-${suffix}.png`);
    }
    await page.setViewportSize({ width: 1180, height: 820 });
    await cart.getByRole('button', { name: '去结算', exact: true }).tap();
    const submit = page.getByRole('button', { name: /^提交订单/ });
    assert.equal(await submit.isDisabled(), true);
    assert.equal(await color(submit), 'rgb(35, 40, 51)');
    assert.equal(await color(submit, 'opacity'), '1');
    await page.getByRole('button', { name: '扫码测试', exact: true }).tap();
    assert.equal(await submit.isEnabled(), true);
    await submit.hover();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.kiosk-action-bar .primary')).backgroundColor === 'rgb(179, 42, 80)');
    await assertContrast(page, 'checkout palette');
    await screenshot(page, `test-results/night-checkout-${suffix}.png`);
    await ctx.setOffline(true);
    await submit.tap();
    await page.locator('.order-no').waitFor();
    const qr = page.locator('.qr-box img');
    await qr.waitFor();
    assert.equal(await color(qr), 'rgb(255, 255, 255)');
    assert.equal(await color(qr, 'filter'), 'none');
    assert.ok(await qr.evaluate(el => el.complete && el.naturalWidth > 0));
    await screenshot(page, `test-results/night-payment-${suffix}.png`);
    await ctx.setOffline(false);
    assert.deepEqual(errors, []);
    console.log(`PASS ${suffix}: system/explicit/offline/persisted themes, contrast, modal actions, tablet/phone layouts, checkout and white QR background`);
    await ctx.close();
  }

  // Storage denial must not prevent startup or using the current page theme.
  const denied = await browser.newContext({ colorScheme: 'dark' });
  denied.on('dialog', dialog => dialog.accept());
  await denied.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException('blocked', 'SecurityError'); };
    Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError'); };
  });
  const blockedPage = await denied.newPage();
  const deniedErrors = [];
  blockedPage.on('pageerror', error => deniedErrors.push(error.message));
  await blockedPage.goto(base);
  await blockedPage.getByRole('button', { name: '建立新的空数据库', exact: true }).waitFor();
  assert.equal(await theme(blockedPage), 'dark');
  await blockedPage.evaluate(async () => (await import('/src/theme.ts')).useTheme.getState().setPreference('light'));
  assert.equal(await theme(blockedPage), 'light');
  assert.equal(await blockedPage.evaluate(async () => (await import('/src/theme.ts')).useTheme.getState().storageError), true);
  assert.deepEqual(deniedErrors, []);
  await denied.close();
  console.log('PASS theme applies before app rendering; storage denial degrades without crashing');
} finally {
  await browser.close();
}
