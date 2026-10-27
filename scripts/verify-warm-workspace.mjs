import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const base = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5201/';
const browser = await chromium.launch({ channel: process.env.SMOKE_CHANNEL ?? 'msedge' });
mkdirSync('test-results/warm-workspace', { recursive: true });
const theme = page => page.locator('html').getAttribute('data-theme');
const until = async (read, value) => { for (let i = 0; i < 80; i++) { if (await read() === value) return; await new Promise(r => setTimeout(r, 50)); } assert.equal(await read(), value); };

try {
  const boot = await browser.newContext({ colorScheme: 'light' });
  await boot.addInitScript(() => localStorage.setItem('doujin-pos:light-theme', 'warm'));
  const first = await boot.newPage();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await first.route('**/src/main.tsx', async route => { await gate; await route.continue(); });
  await first.goto(base, { waitUntil: 'commit' });
  await first.waitForFunction(() => document.documentElement.dataset.theme === 'warm');
  assert.equal(await first.locator('#root').evaluate(el => el.childElementCount), 0, 'warm applies before app rendering');
  assert.equal(await first.locator('meta[name="theme-color"]').getAttribute('content'), '#fffdf8');
  release(); await boot.close();

  const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, colorScheme: 'light' });
  context.on('dialog', dialog => dialog.accept());
  await context.addInitScript(() => { delete window.showSaveFilePicker; });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.getByRole('button', { name: '建立新的空数据库', exact: true }).click();
  await page.getByRole('heading', { name: '从一场展会开始' }).waitFor();
  await page.evaluate(async () => {
    const system = await import('/src/services/system.ts');
    const { useApp } = await import('/src/store.ts');
    await system.setPin('1234'); useApp.getState().unlockStaff();
  });
  const nav = async path => { await page.locator(`.sidebar a[href="${path}"]`).click(); };
  await nav('/settings');
  await page.getByRole('radio', { name: /暖纸/ }).check();
  assert.equal(await theme(page), 'warm');
  await page.emulateMedia({ colorScheme: 'dark' });
  await until(() => theme(page), 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await until(() => theme(page), 'warm');
  const peer = await context.newPage();
  await peer.goto(base);
  await until(() => theme(peer), 'warm');
  await page.getByRole('radio', { name: /清爽白/ }).check();
  await until(() => theme(peer), 'light');
  await page.getByRole('radio', { name: /暖纸/ }).check();
  await until(() => theme(peer), 'warm');
  await peer.close();
  await page.screenshot({ path: 'test-results/warm-workspace/settings.png', fullPage: true });

  const contrast = await page.evaluate(() => {
    const probe = document.createElement('span'); document.body.append(probe);
    const lum = token => {
      probe.style.color = token === 'white' ? '#fff' : `var(${token})`;
      const c = getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
      return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
    };
    const pairs = [['--ink', '--surface'], ['--ink-2', '--surface'], ['--ink-3', '--surface-2'], ['--accent', '--accent-soft'], ['white', '--accent-fill'], ['--warn', '--warn-soft'], ['--danger', '--danger-soft']];
    const result = pairs.map(([fg, bg]) => { const a = lum(fg), b = lum(bg); return { fg, bg, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }; });
    probe.remove(); return result;
  });
  assert.deepEqual(contrast.filter(pair => pair.ratio < 4.5), [], 'warm text contrast');

  const fixture = await page.evaluate(async () => {
    const events = await import('/src/services/events.ts');
    const catalog = await import('/src/services/catalog.ts');
    const system = await import('/src/services/system.ts');
    const { useApp } = await import('/src/store.ts');
    const id = await events.createEvent({ name: '秋日纸上展', currency: 'CNY' });
    const category = (await catalog.listCategories())[0];
    const products = [];
    for (const [i, name] of ['春日来信', '月光幻想', '午后茶话会', '远方的旅人', '星屑与月光', '春天的声音'].entries()) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="${['#d5dfed', '#f1d2dc', '#d8d4ed'][i % 3]}"/><circle cx="225" cy="110" r="75" fill="white" opacity=".5"/><text x="24" y="300" font-size="28" fill="#334155">VOL. ${i + 1}</text></svg>`;
      const cover = await catalog.createAsset('image/svg+xml', 300, 400, new TextEncoder().encode(svg), `warm-cover-${i}`);
      products.push(await catalog.createProduct({ name, type: 'non_stock', category_id: category.id, default_currency: 'CNY', default_price_minor: 2500, cover_asset_id: cover, sku: `BOOK-${i}` }));
    }
    await events.addVariantsToEvent(id, products.map(p => p.variantId));
    const cash = (await events.listPaymentMethods()).find(method => method.type === 'cash');
    await events.updatePaymentMethod(cash.id, { enabled: true });
    await events.setEventPaymentMethods(id, [cash.id]);
    await system.setCurrentEventId(id); useApp.getState().setCurrentEvent(id);
    return { id, products, cashId: cash.id };
  });
  await nav('/');
  await page.getByRole('region', { name: '开场准备' }).waitFor();
  assert.match(await page.getByRole('region', { name: '当前展会' }).innerText(), /日期：未设置/);
  await page.screenshot({ path: 'test-results/warm-workspace/home-draft.png', fullPage: true });
  const orders = await page.evaluate(async fixture => {
    const events = await import('/src/services/events.ts');
    const orders = await import('/src/services/orders.ts');
    const reports = await import('/src/services/reports.ts');
    await events.activateEvent(fixture.id);
    const paid = await orders.staffDirectSale({ eventId: fixture.id, lines: [{ variantId: fixture.products[0].variantId, quantity: 2 }], paymentMethodId: fixture.cashId, tenderedMinor: 5000 });
    const pending = await orders.createPendingOrder({ eventId: fixture.id, lines: [{ variantId: fixture.products[1].variantId, quantity: 1 }], plannedPaymentMethodId: fixture.cashId });
    const refunded = await orders.staffDirectSale({ eventId: fixture.id, lines: [{ variantId: fixture.products[2].variantId, quantity: 1 }], paymentMethodId: fixture.cashId, tenderedMinor: 2500 });
    await orders.recordRefund({ orderId: refunded.orderId, paymentMethodId: fixture.cashId, reason: '合成回归退款', returns: {} });
    return { paid, pending, dash: await reports.getDashboard(fixture.id) };
  }, fixture);
  // Remount Home to reread the event status after the synthetic transactions.
  await nav('/staff/inventory'); await nav('/');
  await page.getByRole('region', { name: '当前展会' }).getByRole('button', { name: '摊主收银', exact: true }).waitFor();
  assert.equal(await page.locator('.home-workspace').innerText().then(t => t.includes('¥')), false, 'home does not expose sales amounts');
  assert.equal(await page.locator('.backup-reminder').count(), 0);
  await page.screenshot({ path: 'test-results/warm-workspace/home-active.png', fullPage: true });
  await page.locator('.recent-orders button').filter({ hasText: '春日来信' }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索订单' }).fill('BOOK-1');
  await until(() => page.locator('.order-list-row').count(), 1);
  assert.match(await page.locator('.order-list-row').innerText(), /月光幻想 ×1/);
  await page.getByRole('group', { name: '订单状态' }).getByRole('button', { name: '已完成', exact: true }).click();
  await page.getByRole('heading', { name: '没有匹配的订单' }).waitFor();
  await page.getByRole('button', { name: '清空筛选', exact: true }).first().click();
  await until(() => page.locator('.order-list-row').count(), 3);
  await page.screenshot({ path: 'test-results/warm-workspace/orders.png', fullPage: true });
  await nav('/staff/reports');
  await page.getByRole('region', { name: '营业概览' }).waitFor();
  assert.match(await page.locator('.report-primary').innerText(), /50\.00 CNY/);
  assert.equal(orders.dash.netSalesMinor, 5000);
  assert.equal(await page.getByText('现金核对与收摊', { exact: true }).count(), 1);
  await page.screenshot({ path: 'test-results/warm-workspace/reports.png', fullPage: true });

  for (const path of ['/', '/staff/orders', '/staff/reports', '/staff/checkout', '/settings', '/preview']) {
    await nav(path);
    assert.equal(await page.locator('.backup-reminder,.backup-nudge').count(), 0, `${path}: no backup reminders`);
  }
  await nav('/staff/backup');
  await page.locator('.backup-reminder').waitFor();
  assert.ok((await page.locator('.backup-reminder').boundingBox()).height < 90, 'compact reminder');
  const before = await page.evaluate(async () => (await import('/src/services/system.ts')).getBackupState());
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出数据库', exact: true }).click();
  await download;
  await page.locator('.backup-reminder').filter({ hasText: '已生成导出，请在「文件」中核对后点击「我确认已保存」。' }).waitFor();
  const after = await page.evaluate(async () => (await import('/src/services/system.ts')).getBackupState());
  assert.ok(after.lastExportAt);
  assert.equal(after.lastConfirmedSavedAt, before.lastConfirmedSavedAt, 'export never auto-confirms save');
  await page.getByRole('button', { name: '我确认已保存', exact: true }).click();
  await until(() => page.locator('.backup-reminder').count(), 0);
  await page.screenshot({ path: 'test-results/warm-workspace/backup.png', fullPage: true });

  await nav('/staff/products');
  await page.locator('tr').filter({ hasText: '春日来信' }).getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('.editor-section-nav').getByRole('button', { name: '分类展示', exact: true }).click();
  await page.getByLabel('简称', { exact: true }).fill('春日');
  await page.locator('[data-error-field="price"]').fill('12.345');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('[data-error-field="price"][aria-invalid="true"]').waitFor();
  await until(() => page.locator('[data-error-field="price"]').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.evaluate(async id => (await import('/src/services/catalog.ts')).getProduct(id), fixture.products[0].productId).then(p => p.short_name), null, 'invalid price prevents writes');
  await page.screenshot({ path: 'test-results/warm-workspace/editor-validation.png' });
  await page.getByRole('button', { name: '取消', exact: true }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  // Client-side navigation preserves the staff session in the isolated test context.
  const mobileNav = async path => page.evaluate(path => { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
  for (const path of ['/', '/staff/orders', '/staff/reports', '/settings']) {
    await mobileNav(path); await page.waitForTimeout(180);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `mobile overflow ${path}`);
    await page.screenshot({ path: `test-results/warm-workspace/mobile-${path.split('/').pop() || 'home'}.png`, fullPage: true });
  }
  await mobileNav('/staff/products');
  await page.locator('tr').filter({ hasText: '春日来信' }).getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('.editor-section-nav').getByRole('button', { name: '规格 / SKU', exact: true }).click();
  const actions = await page.locator('.modal-actions').boundingBox();
  assert.ok(actions.y >= 0 && actions.y + actions.height <= 844, 'editor save actions stay visible');
  await page.screenshot({ path: 'test-results/warm-workspace/mobile-editor.png' });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.setViewportSize({ width: 1180, height: 820 });
  await mobileNav('/kiosk');
  await page.locator('.kiosk-menu .menu-card').first().waitFor();
  assert.equal(await page.locator('.menu-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 4, 'menu density unchanged');
  await page.screenshot({ path: 'test-results/warm-workspace/kiosk.png', fullPage: true });
  await context.setOffline(true);
  await page.evaluate(async () => (await import('/src/theme.ts')).useTheme.getState().setLightPalette('default'));
  assert.equal(await theme(page), 'light');
  await page.evaluate(async () => (await import('/src/theme.ts')).useTheme.getState().setLightPalette('warm'));
  assert.equal(await theme(page), 'warm');
  await context.setOffline(false);
  await page.reload();
  await until(() => theme(page), 'warm');
  await page.locator('.kiosk-menu .menu-card').first().waitFor();
  await page.evaluate(async ({ eventId, pendingId }) => {
    const orders = await import('/src/services/orders.ts');
    const events = await import('/src/services/events.ts');
    const { useApp } = await import('/src/store.ts');
    await orders.voidOrder(pendingId, '合成回归取消');
    await events.closeEvent(eventId);
    useApp.getState().unlockStaff();
  }, { eventId: fixture.id, pendingId: orders.pending.orderId });
  await mobileNav('/');
  await page.getByRole('region', { name: '当前展会' }).getByRole('button', { name: '查看本场报表', exact: true }).waitFor();
  assert.equal(await page.locator('.backup-reminder').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS warm palette: contrast, system day/night, offline preference and reload; stage home, snapshot order filters/deep link, report values, backup-only compact reminder/export confirmation, editor validation/focus, phone layout and unchanged menu density');
  await context.close();
} finally {
  await browser.close();
}
