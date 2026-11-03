/** Real browser + SQLite/WASM integration. Use a Vite development server for fixture seeding. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const base = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5203/';
const browser = await chromium.launch({ channel: process.env.SMOKE_CHANNEL ?? 'msedge' });
const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
context.on('dialog', dialog => dialog.accept());
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
mkdirSync('test-results/promotions', { recursive: true });
async function until(read, expected) {
  for (let i = 0; i < 100; i++) {
    if (await read() === expected) return;
    await new Promise(r => setTimeout(r, 75));
  }
  assert.equal(await read(), expected);
}
async function staff(path) {
  await page.goto(base + path);
  await page.waitForFunction(() => document.body.innerText.includes('Doujin POS') || !!document.querySelector('.pin-keys'));
  await page.evaluate(async () => { const { useApp } = await import('/src/store.ts'); useApp.getState().unlockStaff(); });
  await page.locator('.sidebar').waitFor();
}
try {
  await page.goto(base);
  await page.getByRole('button', { name: '建立新的空数据库', exact: true }).click();
  await page.getByRole('heading', { name: '从一场展会开始' }).waitFor();
  const fixture = await page.evaluate(async () => {
    const events = await import('/src/services/events.ts');
    const catalog = await import('/src/services/catalog.ts');
    const system = await import('/src/services/system.ts');
    const inventory = await import('/src/services/inventory.ts');
    const { useApp } = await import('/src/store.ts');
    await system.setPin('1234'); useApp.getState().unlockStaff();
    const eventId = await events.createEvent({ name: '优惠验收展', currency: 'CNY' });
    const { variantId } = await catalog.createProduct({ name: '春日画集', type: 'normal', category_id: (await catalog.listCategories())[0].id, default_currency: 'CNY', default_price_minor: 5000 });
    await events.addVariantsToEvent(eventId, [variantId]);
    await events.updateConfig(eventId, variantId, { event_price_minor: 5000 });
    await inventory.initializeStock(eventId, variantId, 30);
    const cash = (await events.listPaymentMethods()).find(m => m.type === 'cash');
    await events.updatePaymentMethod(cash.id, { enabled: true }); await events.setEventPaymentMethods(eventId, [cash.id]);
    await events.activateEvent(eventId); await system.setCurrentEventId(eventId); useApp.getState().setCurrentEvent(eventId);
    return { eventId, variantId, cashId: cash.id };
  });
  await page.locator('.sidebar a[href="/staff/events"]').click();
  await page.locator('.promotion-settings > summary').click();
  await page.getByRole('button', { name: '选择当前结果' }).click();
  await page.getByLabel('活动优惠值', { exact: true }).fill('8');
  await page.getByRole('button', { name: '应用到所选商品' }).click();
  await page.getByRole('button', { name: '添加满减档位' }).click();
  await page.getByLabel('满减门槛1').fill('150'); await page.getByLabel('满减金额1').fill('20');
  await page.getByRole('button', { name: '保存本场优惠' }).click();
  await until(() => page.evaluate(async id => { const { getPromotions } = await import('/src/services/promotions.ts'); return (await getPromotions(id)).tiers.length; }, fixture.eventId), 1);
  console.log('OK 活动价、满减配置保存');
  await page.locator('.sidebar a[href="/staff/checkout"]').click();
  for (let i = 0; i < 3; i++) await page.locator('.pos-cover').first().click();
  await until(() => page.locator('.total-price').last().innerText(), '¥100.00 CNY');
  await page.getByRole('button', { name: '人工优惠 / 调整应收' }).click();
  await page.getByLabel('单品优惠值').fill('30');
  await page.getByRole('button', { name: '应用单品优惠' }).click();
  await page.getByLabel('整单优惠值').fill('75');
  await page.locator('.pricing-inputs').last().getByRole('button', { name: '应用', exact: true }).click();
  await page.getByPlaceholder('例如：瑕疵品优惠、摊主特批').fill('展会现场优惠');
  await page.getByLabel('调价确认密码').fill('1234');
  await page.getByRole('button', { name: '保存优惠' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await until(() => page.locator('.total-price').last().innerText(), '¥75.00 CNY');
  await page.screenshot({ path: 'test-results/promotions/staff-landscape.png', fullPage: true });
  await page.getByRole('button', { name: '现金', exact: true }).click();
  await page.getByRole('button', { name: /确认收款/ }).click();
  await page.getByText('订单 #1 已成交').waitFor();
  console.log('OK 单品拆行、整单优惠、PIN 和实际收款75元');

  await page.locator('.sidebar a[href="/kiosk"]').click();
  await page.locator('.add-btn').first().click();
  for (let i = 0; i < 2; i++) await page.locator('.menu-card .qty button').last().click();
  await until(() => page.locator('.side-cart-total strong').innerText(), '¥100.00 CNY');
  await page.screenshot({ path: 'test-results/promotions/kiosk-landscape.png', fullPage: true });
  await page.locator('.kiosk-side-cart').getByRole('button', { name: '去结算', exact: true }).click();
  await page.getByRole('button', { name: '现金', exact: true }).click();
  await page.getByRole('button', { name: /提交订单/ }).click();
  await page.waitForURL('**/kiosk/order/*');
  const orderId = page.url().split('/').pop();
  await staff('staff/pending');
  await page.getByRole('button', { name: '人工优惠 / 调整应收' }).click();
  await page.getByRole('checkbox', { name: /已核实顾客尚未付款/ }).check();
  await page.getByRole('button', { name: '开始调价' }).click();
  await page.getByLabel('整单优惠值').fill('0');
  await page.locator('.pricing-inputs').last().getByRole('button', { name: '应用', exact: true }).click();
  await page.getByPlaceholder('例如：瑕疵品优惠、摊主特批').fill('零元赠送');
  await page.getByLabel('调价确认密码').fill('1234');
  await page.getByRole('button', { name: '保存优惠' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '确认发放', exact: true }).isDisabled(), true);
  await page.goto(base + 'kiosk/order/' + orderId);
  await page.getByRole('heading', { name: '金额已调整，请重新核对' }).waitFor();
  assert.equal(await page.locator('.ord-qr').count(), 0);
  await page.getByRole('button', { name: /已核对 ¥0.00 CNY/ }).click();
  await page.getByRole('heading', { name: '金额已调整，请重新核对' }).waitFor({ state: 'hidden' });
  await page.screenshot({ path: 'test-results/promotions/kiosk-zero.png', fullPage: true });
  await staff('staff/pending');
  await page.getByRole('button', { name: '确认发放', exact: true }).click();
  await page.getByText('当前没有待付款订单。', { exact: true }).waitFor();
  console.log('OK 待付款调价、顾客重新确认、零元发放');

  const checks = await page.evaluate(async () => {
    const { ex } = await import('/src/services/context.ts');
    const { INVARIANT_CHECKS } = await import('/src/db/invariants.ts');
    const result = [];
    for (const check of INVARIANT_CHECKS) { const row = await ex().readOne(check.sql); if (Object.values(row)[0]) result.push(check.name); }
    return result;
  });
  assert.deepEqual(checks, []);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.sidebar a[href="/kiosk"]').click();
  await page.locator('.add-btn').first().click();
  await page.getByRole('button', { name: '查看购物车', exact: true }).click();
  await page.getByRole('button', { name: '去结算', exact: true }).click();
  await page.getByRole('button', { name: /提交订单/ }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/promotions/phone-checkout.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('OK 手机结算布局、SQLite业务一致性及无页面异常');

  // Copy only a disposable fixture into the production build, then cold-open offline.
  // Never imports development modules into the production page.
  if (process.env.PROMOTION_PRODUCTION_BASE) {
    const bytes = await page.evaluate(async () => {
      const { db } = await import('/src/db/client.ts');
      return Array.from((await db.exportDb()).bytes);
    });
    const production = process.env.PROMOTION_PRODUCTION_BASE;
    const offlineContext = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
    offlineContext.on('dialog', d => d.accept());
    let offline = await offlineContext.newPage();
    await offline.goto(production);
    await offline.locator('input[type="file"]').first().setInputFiles({ name: 'promotions-fixture.sqlite3', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
    await offline.getByRole('button', { name: '确认替换', exact: true }).click();
    await offline.getByRole('button', { name: '确认替换', exact: true }).waitFor({ state: 'hidden' });
    await offline.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await offline.goto(production + 'kiosk');
    await offline.locator('.menu-card').first().waitFor();
    await offline.waitForFunction(() => !!navigator.serviceWorker.controller);
    await offline.close();
    await offlineContext.setOffline(true);
    offline = await offlineContext.newPage();
    await offline.goto(production + 'kiosk');
    await offline.locator('.add-btn').first().click();
    for (let i = 0; i < 2; i++) await offline.locator('.menu-card .qty button').last().click();
    await until(() => offline.locator('.side-cart-total strong').innerText(), '¥100.00 CNY');
    await offline.locator('.kiosk-side-cart').getByRole('button', { name: '去结算', exact: true }).click();
    await offline.getByRole('button', { name: '现金', exact: true }).click();
    await offline.getByRole('button', { name: /提交订单/ }).click();
    await offline.waitForURL('**/kiosk/order/*');
    await offline.goto(production + 'staff/checkout');
    await offline.locator('.pin-keys').waitFor();
    for (const digit of ['1', '2', '3', '4']) await offline.locator('.pin-keys .pin-digit').filter({ hasText: new RegExp(`^${digit}$`) }).click();
    await offline.locator('.pin-actions button.primary').click();
    await offline.locator('.pos-cover').first().click();
    await until(() => offline.locator('.total-price').last().innerText(), '¥40.00 CNY');
    await offline.getByRole('button', { name: '人工优惠 / 调整应收' }).click();
    await offline.getByLabel('整单优惠值').fill('35');
    await offline.locator('.pricing-inputs').last().getByRole('button', { name: '应用', exact: true }).click();
    await offline.getByPlaceholder('例如：瑕疵品优惠、摊主特批').fill('离线现场优惠');
    await offline.getByLabel('调价确认密码').fill('1234');
    await offline.getByRole('button', { name: '保存优惠' }).click();
    await offline.getByRole('dialog').waitFor({ state: 'hidden' });
    await until(() => offline.locator('.total-price').last().innerText(), '¥35.00 CNY');
    await offline.getByRole('button', { name: '现金', exact: true }).click();
    await offline.getByRole('button', { name: /确认收款/ }).click();
    await offline.getByText('订单 #4 已成交').waitFor();
    await offlineContext.close();
    console.log('OK 生产构建：备份恢复、离线冷启动、活动满减下单、PIN人工调价收款');
  }

  // Cancel on the payment page, then return without a reload or staff privileges.
  await page.getByRole('button', { name: '现金', exact: true }).click();
  await page.getByRole('button', { name: /提交订单/ }).click();
  await page.waitForURL('**/kiosk/order/*');
  const canceledOrderId = page.url().split('/').pop();
  await page.evaluate(async orderId => {
    const { useApp } = await import('/src/store.ts');
    useApp.getState().unlockStaff();
    useApp.getState().setCurrentOrder(orderId);
  }, canceledOrderId);
  await page.getByRole('button', { name: '取消订单', exact: true }).click();
  await page.getByText('该订单已取消', { exact: true }).waitFor();
  const returnButton = page.getByRole('button', { name: '返回游客菜单', exact: true });
  assert.equal(await returnButton.count(), 1, '取消后应有返回游客菜单按钮');
  assert.equal(await page.getByRole('button', { name: '确认已收款', exact: true }).count(), 0);
  await returnButton.click();
  await page.waitForURL(base + 'kiosk');
  const canceled = await page.evaluate(async orderId => {
    const { useApp } = await import('/src/store.ts');
    const { ex } = await import('/src/services/context.ts');
    return { locked: !useApp.getState().staffUnlocked, currentOrder: useApp.getState().currentOrderId,
      cart: useApp.getState().cart.length,
      status: (await ex().readOne('SELECT status FROM orders WHERE id=?', [orderId])).status,
      reserved: (await ex().readOne('SELECT SUM(reserved_stock) AS n FROM inventory')).n,
      payments: (await ex().readOne('SELECT COUNT(*) AS n FROM payments WHERE order_id=?', [orderId])).n };
  }, canceledOrderId);
  assert.deepEqual(canceled, { locked: true, currentOrder: null, cart: 0, status: 'voided', reserved: 0, payments: 0 });

  // A cancellation from another staff screen is picked up by polling; returning is public.
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.locator('.add-btn').first().click();
  await page.locator('.kiosk-side-cart').getByRole('button', { name: '去结算', exact: true }).click();
  await page.getByRole('button', { name: '现金', exact: true }).click();
  await page.getByRole('button', { name: /提交订单/ }).click();
  await page.waitForURL('**/kiosk/order/*');
  const remoteCanceledId = page.url().split('/').pop();
  await page.evaluate(async orderId => {
    const { voidOrder } = await import('/src/services/orders.ts');
    await voidOrder(orderId, '后台核实未收款');
  }, remoteCanceledId);
  await page.getByText('该订单已取消', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回游客菜单', exact: true }).click();
  await page.waitForURL(base + 'kiosk');
  await page.locator('.menu-card').first().waitFor();
  await page.locator('.add-btn').first().click();
  await until(() => page.locator('.side-cart-total strong').innerText(), '¥40.00 CNY');
  assert.deepEqual(errors, []);
  console.log('OK 手机与横屏：支付中取消、后台取消后轮询更新、返回菜单、会话复位及再次加购');
} catch (e) {
  await page.screenshot({ path: 'test-results/promotions/failure.png', fullPage: true });
  console.error(await page.locator('body').innerText());
  throw e;
} finally { await context.close(); await browser.close(); }
