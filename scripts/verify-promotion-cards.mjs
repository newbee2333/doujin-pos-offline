/** Visual promotion configuration against disposable real SQLite/WASM data. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const base = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5203/';
const browser = await chromium.launch({ channel: process.env.SMOKE_CHANNEL ?? 'msedge' });
const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, hasTouch: true });
context.on('dialog', d => d.accept());
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
mkdirSync('test-results/promotion-cards', { recursive: true });
async function until(read, expected) {
  for (let i = 0; i < 100; i++) { if (await read() === expected) return; await new Promise(r => setTimeout(r, 60)); }
  assert.equal(await read(), expected);
}
const stored = () => page.evaluate(async () => {
  const { getPromotions } = await import('/src/services/promotions.ts');
  const { useApp } = await import('/src/store.ts');
  return getPromotions(useApp.getState().currentEventId);
});
const card = name => page.getByRole('article', { name, exact: true });
async function save() {
  await page.getByRole('button', { name: '保存本场优惠', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '本场优惠已保存' }).waitFor();
}
async function draftPrice(name, value) {
  await card(name).getByRole('button', { name: /^设置 / }).click();
  const dialog = page.getByRole('dialog');
  assert.equal(await page.getByRole('button', { name: '优惠单价', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByLabel('活动优惠值', { exact: true }).inputValue(), '');
  assert.equal(await dialog.locator('.notice.danger').count(), 0, '未输入时不应显示错误');
  assert.equal(await page.getByRole('button', { name: '应用优惠', exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole('button', { name: /^(7|8|9|9\.5) 折$/ }).count(), 0, '不再展示固定折扣档位');
  await page.screenshot({ path: 'test-results/promotion-cards/empty-dialog.png' });
  await page.getByRole('button', { name: '优惠单价', exact: true }).click();
  await page.getByLabel('活动优惠值', { exact: true }).fill(value);
  await page.getByRole('button', { name: '打几折', exact: true }).click();
  assert.equal(await page.getByLabel('活动优惠值', { exact: true }).inputValue(), '', '切换模式不预填八折');
  await page.getByLabel('活动优惠值', { exact: true }).fill('9.2');
  await page.getByRole('button', { name: '优惠单价', exact: true }).click();
  assert.equal(await page.getByLabel('活动优惠值', { exact: true }).inputValue(), value, '保留用户在另一模式已输入的值');
  await page.getByLabel('活动优惠值', { exact: true }).press('Enter');
}
try {
  await page.goto(base);
  await page.getByRole('button', { name: '建立新的空数据库', exact: true }).click();
  await page.getByRole('heading', { name: '从一场展会开始' }).waitFor();
  const fixture = await page.evaluate(async () => {
    const catalog = await import('/src/services/catalog.ts');
    const events = await import('/src/services/events.ts');
    const system = await import('/src/services/system.ts');
    const { useApp } = await import('/src/store.ts');
    await system.setPin('1234'); useApp.getState().unlockStaff();
    const eventId = await events.createEvent({ name: '卡片优惠测试展', currency: 'CNY' });
    const nextEventId = await events.createEvent({ name: '另一个展会', currency: 'CNY' });
    const categories = await catalog.listCategories();
    const bookCategory = categories.find(c => c.name === '新刊').id;
    const badgeCategory = categories.find(c => c.name === '徽章').id;
    const entries = [
      ['春日画集', 12000, bookCategory, '#ead5c6'], ['月色画集', 6000, bookCategory, '#c7cfe8'],
      ['星光徽章', 3500, badgeCategory, '#e2c9ce'], ['夏日徽章', 1500, badgeCategory, '#ccd8bf'],
      ['纪念套页', 10000, bookCategory, '#dbcee4'], ['晚霞明信片', 2000, badgeCategory, '#eed5ba']
    ];
    const ids = [];
    for (const [index, [name, price, category, color]] of entries.entries()) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="${color}"/><circle cx="280" cy="100" r="65" fill="#fff" opacity=".5"/><path d="M0 300Q100 170 230 290T430 190V400H0Z" fill="#fff" opacity=".4"/><text x="32" y="70" font-size="24" fill="#454048">DOUJIN / ${index + 1}</text><text x="32" y="345" font-size="32" fill="#454048">${name}</text></svg>`;
      const assetId = await catalog.createAsset('image/svg+xml', 400, 400, new TextEncoder().encode(svg), `fixture-${index}`);
      const item = await catalog.createProduct({ name, type: 'normal', category_id: category, default_currency: 'CNY', default_price_minor: price, cover_asset_id: assetId });
      await events.addVariantsToEvent(eventId, [item.variantId]); ids.push(item.variantId);
    }
    const alternate = await catalog.createVariant((await catalog.listProducts({ search: '春日画集' }))[0].id, '限定版');
    await events.addVariantsToEvent(eventId, [alternate]); await events.updateConfig(eventId, alternate, { event_price_minor: 15000 });
    const unpriced = await catalog.createProduct({ name: '日元限定刊', type: 'normal', default_currency: 'JPY', default_price_minor: 500 });
    await events.addVariantsToEvent(eventId, [unpriced.variantId]);
    const gift = await catalog.createProduct({ name: '无料赠品', type: 'gift', default_currency: 'CNY', default_price_minor: 0 });
    await events.addVariantsToEvent(eventId, [gift.variantId]);
    await system.setCurrentEventId(eventId); useApp.getState().setCurrentEvent(eventId);
    return { eventId, nextEventId, ids, alternate };
  });
  await page.locator('.sidebar a[href="/staff/events"]').click();
  await page.getByRole('link', { name: '设置优惠活动', exact: true }).click();
  await page.locator('.promotion-card').first().waitFor();
  assert.equal(await page.locator('.promotion-card').count(), 8);
  assert.equal(await page.getByRole('article', { name: '无料赠品 · 默认规格' }).count(), 0);
  assert.equal(await card('日元限定刊 · 默认规格').getByRole('checkbox').isDisabled(), true);
  assert.equal(await page.locator('.promotion-card img').count(), 7);

  await draftPrice('春日画集 · 默认规格', '88');
  assert.match(await card('春日画集 · 默认规格').innerText(), /88.00/);
  assert.equal(Object.keys((await stored()).prices).length, 0, '草稿不能提前改变已保存活动');
  await page.getByRole('link', { name: '返回展会配置', exact: true }).click();
  await page.getByRole('dialog', { name: '还有未保存的优惠' }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await save();
  assert.equal((await stored()).prices[fixture.ids[0]].value, 8800);
  assert.equal((await stored()).prices[fixture.alternate], undefined, '单规格改价不能影响同商品其他规格');

  await card('夏日徽章 · 默认规格').getByRole('checkbox').check();
  await page.getByRole('button', { name: '批量设置优惠', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '打几折', exact: true }).getAttribute('aria-pressed'), 'true', '只选一件的批量操作也默认按折扣输入');
  assert.equal(await page.getByLabel('活动优惠值', { exact: true }).inputValue(), '');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '清除选择', exact: true }).click();

  // Whole-category action deliberately includes the category's filtered-out products.
  await page.getByRole('button', { name: /^新刊 / }).click();
  await page.getByLabel('搜索活动商品').fill('月色');
  await page.getByRole('button', { name: '整类优惠', exact: true }).click();
  assert.equal(await page.getByRole('dialog').getByText('新刊 · 共 4 个规格', { exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '打几折', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByLabel('活动优惠值', { exact: true }).inputValue(), '');
  await page.getByLabel('活动优惠值', { exact: true }).fill('8.8');
  assert.match(await page.getByLabel('优惠价格预览').innerText(), /105.60/);
  assert.equal(await page.getByRole('button', { name: '应用优惠', exact: true }).isEnabled(), true);
  await page.screenshot({ path: 'test-results/promotion-cards/category-dialog.png' });
  await page.getByRole('button', { name: '应用优惠', exact: true }).click();
  await save();
  const categoryRules = await stored();
  for (const id of [fixture.ids[0], fixture.ids[1], fixture.ids[4], fixture.alternate]) assert.deepEqual(categoryRules.prices[id], { kind: 'rate', value: 8800 });
  assert.equal(categoryRules.prices[fixture.ids[2]], undefined);
  await page.getByRole('button', { name: '整类优惠', exact: true }).click();
  assert.equal(await page.getByLabel('活动优惠值', { exact: true }).inputValue(), '8.8', '整类已有一致优惠时回填原值');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByLabel('搜索活动商品').fill('');
  await card('春日画集 · 默认规格').getByRole('checkbox').check();
  await page.getByRole('button', { name: /^徽章 / }).click();
  await card('星光徽章 · 默认规格').getByRole('checkbox').check();
  await page.getByText('含筛选外 1 项', { exact: true }).waitFor();
  await page.getByRole('button', { name: '批量设置优惠', exact: true }).click();
  assert.equal(await page.getByLabel('活动优惠值', { exact: true }).inputValue(), '', '所选商品优惠不一致时应留空');
  await page.getByRole('dialog').getByText('勾选商品 · 共 2 个规格（含筛选外 1 项）', { exact: true }).waitFor();
  await page.getByRole('button', { name: '优惠单价', exact: true }).click();
  await page.getByLabel('活动优惠值', { exact: true }).fill('50');
  assert.equal(await page.getByRole('button', { name: '应用优惠', exact: true }).isDisabled(), true, '固定价高于任一商品原价时整批拒绝');
  await page.getByRole('button', { name: '打几折', exact: true }).click();
  assert.equal(await page.getByLabel('活动优惠值', { exact: true }).inputValue(), '');
  await page.getByLabel('活动优惠值', { exact: true }).fill('9.5');
  await page.getByRole('button', { name: '应用优惠', exact: true }).click();
  await page.getByLabel('全部非赠品商品参与', { exact: true }).uncheck();
  await page.getByRole('button', { name: '使用当前勾选商品', exact: true }).click();
  await page.getByRole('button', { name: /添加满减档位/ }).click();
  await page.getByLabel('满减门槛1').fill('100'); await page.getByLabel('满减金额1').fill('10');
  await save();
  const finalRules = await stored();
  assert.deepEqual([...finalRules.eligible].sort(), [fixture.ids[0], fixture.ids[2]].sort());
  assert.equal(finalRules.prices[fixture.ids[0]].value, 9500);
  assert.equal(finalRules.prices[fixture.ids[2]].value, 9500);
  assert.equal(finalRules.prices[fixture.ids[1]].value, 8800);
  await page.getByRole('button', { name: '清除选择', exact: true }).click();
  await page.getByRole('button', { name: /^全部 / }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'test-results/promotion-cards/light.png', fullPage: true });
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.evaluate(() => scrollTo(0, 0));
  const landscapeSave = await page.getByRole('button', { name: '保存本场优惠', exact: true }).boundingBox();
  assert.ok(landscapeSave.y >= 0 && landscapeSave.y + landscapeSave.height <= 820, '横屏保存按钮应在视口内');
  await page.screenshot({ path: 'test-results/promotion-cards/ipad-landscape.png' });

  for (const theme of ['warm', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: `test-results/promotion-cards/${theme}.png`, fullPage: true });
  }
  await page.evaluate(() => document.documentElement.dataset.theme = 'warm');
  await card('春日画集 · 默认规格').getByRole('button', { name: /^设置 / }).click();
  assert.equal(await page.getByLabel('活动优惠值', { exact: true }).inputValue(), '9.5');
  await page.screenshot({ path: 'test-results/promotion-cards/single-dialog.png', fullPage: true });
  await page.getByRole('button', { name: '恢复本商品的本场原价', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await page.getByRole('dialog', { name: '放弃本次修改？' }).getByRole('button', { name: '放弃修改', exact: true }).click();
  assert.match(await card('春日画集 · 默认规格').innerText(), /9.5 折/);
  await page.reload();
  await page.evaluate(async () => { const { useApp } = await import('/src/store.ts'); useApp.getState().unlockStaff(); });
  await card('春日画集 · 默认规格').waitFor();
  assert.match(await card('春日画集 · 默认规格').innerText(), /114.00/);
  assert.deepEqual(await stored(), finalRules);

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(() => scrollTo(0, 0));
  const phoneSave = await page.getByRole('button', { name: '保存本场优惠', exact: true }).boundingBox();
  assert.ok(phoneSave.y >= 0 && phoneSave.y + phoneSave.height <= 844, '手机保存按钮应在视口内');
  await card('星光徽章 · 默认规格').getByRole('button', { name: /^设置 / }).click();
  await page.getByRole('button', { name: '优惠单价', exact: true }).click();
  await page.getByLabel('活动优惠值', { exact: true }).fill('0');
  await page.screenshot({ path: 'test-results/promotion-cards/phone-dialog.png', fullPage: true });
  await page.getByRole('button', { name: '应用优惠', exact: true }).click();
  await save();
  assert.equal((await stored()).prices[fixture.ids[2]].value, 0);
  await page.screenshot({ path: 'test-results/promotion-cards/phone.png', fullPage: true });

  if (process.env.PROMOTION_PRODUCTION_BASE) {
    const bytes = await page.evaluate(async () => { const { db } = await import('/src/db/client.ts'); return Array.from((await db.exportDb()).bytes); });
    const production = process.env.PROMOTION_PRODUCTION_BASE;
    const previewContext = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
    previewContext.on('dialog', d => d.accept());
    const preview = await previewContext.newPage();
    preview.on('pageerror', e => errors.push(e.message));
    await preview.goto(production);
    assert.equal(await preview.evaluate(() => crossOriginIsolated), true);
    await preview.locator('input[type="file"]').first().setInputFiles({ name: 'promotion-cards-fixture.sqlite3', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
    await preview.getByRole('button', { name: '确认替换', exact: true }).click();
    await preview.getByRole('button', { name: '确认替换', exact: true }).waitFor({ state: 'hidden' });
    async function unlockPreview() {
      await preview.locator('.pin-keys').waitFor();
      for (const digit of ['1','2','3','4']) await preview.locator('.pin-keys .pin-digit').filter({ hasText: new RegExp(`^${digit}$`) }).click();
      await preview.locator('.pin-actions button.primary').click();
      await preview.getByRole('article', { name: '春日画集 · 默认规格', exact: true }).waitFor();
    }
    await preview.goto(production + 'staff/promotions?event=' + fixture.eventId);
    await unlockPreview();
    assert.equal(await preview.locator('.promotion-card').count(), 8);
    const previewCard = preview.getByRole('article', { name: '春日画集 · 默认规格', exact: true });
    await previewCard.getByRole('button', { name: /^设置 / }).click();
    await preview.getByRole('button', { name: '优惠单价', exact: true }).click();
    await preview.getByLabel('活动优惠值', { exact: true }).fill('88');
    await preview.getByRole('button', { name: '应用优惠', exact: true }).click();
    await preview.getByRole('button', { name: '保存本场优惠', exact: true }).click();
    await preview.getByRole('status').filter({ hasText: '本场优惠已保存' }).waitFor();
    await preview.reload(); await unlockPreview();
    assert.match(await previewCard.innerText(), /88.00/);
    await preview.screenshot({ path: 'test-results/promotion-cards/production.png' });
    await previewContext.close();
    console.log('PASS 生产构建：导入测试副本、封面卡片、直接优惠价、保存并刷新保留');
  }
  await page.goto(base + 'staff/promotions?event=' + fixture.nextEventId);
  await page.evaluate(async () => { const { useApp } = await import('/src/store.ts'); useApp.getState().unlockStaff(); });
  await page.getByText('还没有可设置优惠的商品', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '保存本场优惠', exact: true }).isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log('PASS 商品卡片：封面/规格、单件改价、整类折扣、跨类多选、价格校验、满减范围、草稿保存/放弃/重开、零元、浅色/暖纸/深色和手机布局');
} catch (e) {
  await page.screenshot({ path: 'test-results/promotion-cards/failure.png', fullPage: true });
  console.error(await page.locator('body').innerText()); throw e;
} finally { await context.close(); await browser.close(); }
