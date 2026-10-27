import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const base = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5201/';
const browser = await chromium.launch({ channel: process.env.SMOKE_CHANNEL ?? 'msedge' });
mkdirSync('test-results', { recursive: true });
try {
  for (const mode of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, colorScheme: mode });
    ctx.on('dialog', dialog => dialog.accept());
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.getByRole('button', { name: '建立新的空数据库', exact: true }).click();
    await page.locator('.sidebar').waitFor();
    const fixture = await page.evaluate(async () => {
      const catalog = await import('/src/services/catalog.ts');
      const system = await import('/src/services/system.ts');
      const { useApp } = await import('/src/store.ts');
      const categories = await catalog.listCategories();
      const ids = [];
      const names = ['春日来信 上册', '春日来信 下册', '月光徽章'];
      const covers = [];
      for (let i = 0; i < 3; i++) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="${['#d5dfed', '#f1d2dc', '#d8d4ed'][i]}"/><circle cx="225" cy="110" r="75" fill="white" opacity=".5"/><text x="24" y="300" font-size="28" fill="#334155">VOL. ${i + 1}</text></svg>`;
        covers.push(await catalog.createAsset('image/svg+xml', 300, 400, new TextEncoder().encode(svg), `bundle-cover-${i}`));
      }
      for (let i = 0; i < 30; i++) {
        const created = await catalog.createProduct({ name: names[i] ?? `展会商品 ${String(i).padStart(2, '0')}`, type: 'normal',
          category_id: categories[i % 2].id, default_currency: 'CNY', default_price_minor: 2500,
          sku: ['BOOK-UP', 'BOOK-DOWN', 'BADGE-MOON'][i] ?? `SKU-${i}`, cover_asset_id: i === 3 ? null : covers[i % 3], fandom: i === 2 ? '月光幻想' : null });
        ids.push(created);
        if (i === 26 || i === 27) await catalog.setProductArchived(created.productId, true);
      }
      const bundle = await catalog.createProduct({ name: '春日全套', type: 'bundle', default_currency: 'CNY', default_price_minor: 8000, category_id: categories[0].id });
      await catalog.setBundleComponents(bundle.variantId, [
        { component_variant_id: ids[0].variantId, quantity: 2 }, { component_variant_id: ids[27].variantId, quantity: 1 }
      ]);
      await catalog.createProduct({ name: '非库存宣传品', type: 'non_stock', default_currency: 'CNY', default_price_minor: 0 });
      await catalog.createProduct({ name: '赠品贴纸', type: 'gift', default_currency: 'CNY', default_price_minor: 0 });
      await system.setPin('1234'); useApp.getState().unlockStaff();
      return { ids, bundle, category: categories[0].id };
    });
    await page.locator('.sidebar a[href="/staff/products"]').click();
    const picker = () => page.locator('.bundle-picker-modal');
    const member = name => picker().getByRole('region', { name: '已选成分' }).getByRole('article', { name, exact: true });
    const readComponents = () => page.evaluate(async id => (await import('/src/services/catalog.ts')).getBundleComponents(id), fixture.bundle.variantId);
    const original = await readComponents();
    const editBundle = () => page.locator('tr').filter({ hasText: '春日全套' }).getByRole('button', { name: '编辑', exact: true }).click();
    const choose = () => page.locator('.bundle-comps').getByRole('button', { name: /选择.*商品/ }).click();

    // A delayed read must not expose an editable empty list or overwrite changes.
    await page.evaluate(async () => {
      const { db } = await import('/src/db/client.ts');
      const originalRead = db.read.bind(db);
      db.read = async (...args) => {
        if (args[0].includes('SELECT * FROM bundle_components WHERE bundle_variant_id')) {
          db.read = originalRead;
          await new Promise(resolve => { window.releaseBundleRead = resolve; });
        }
        return originalRead(...args);
      };
    });
    await editBundle();
    await page.getByText('正在读取套装商品…', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isDisabled(), true);
    await page.waitForFunction(() => !!window.releaseBundleRead);
    await page.evaluate(() => window.releaseBundleRead());
    await page.locator('.bundle-comps .bundle-member').first().waitFor();
    await page.getByLabel('名称', { exact: true }).fill('春日全套（尚未保存）');
    await choose();
    await picker().waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await picker().getByRole('searchbox', { name: '搜索套装成分' }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await picker().getByRole('button', { name: /确认选择/ }).evaluate(el => el === document.activeElement), true, 'keyboard focus stays in the picker');
    assert.equal(await picker().getByRole('region', { name: '已选成分' }).locator('.bundle-member').count(), 2);
    assert.equal(await picker().getByRole('checkbox', { name: /选择 春日全套/ }).count(), 0, 'bundles are excluded');
    assert.equal(await picker().getByRole('checkbox', { name: /选择 非库存宣传品|选择 赠品贴纸/ }).count(), 0);
    assert.equal(await picker().getByRole('checkbox', { name: /选择 展会商品 26/ }).count(), 0, 'unselected archived items are hidden by default');
    assert.equal(await picker().getByRole('checkbox', { name: /选择 展会商品 27/ }).isChecked(), true, 'existing archived component remains selected');

    const search = picker().getByRole('searchbox', { name: '搜索套装成分' });
    await search.fill('book down');
    assert.equal(await picker().locator('.bundle-candidate').count(), 1);
    await picker().getByRole('checkbox', { name: /选择 春日来信 下册/ }).check();
    await member('春日来信 下册').getByRole('spinbutton').fill('2.5');
    assert.equal(await picker().getByRole('button', { name: /确认选择/ }).isDisabled(), true);
    await member('春日来信 下册').getByRole('spinbutton').fill('3');
    await search.fill('月光幻想');
    assert.equal(await picker().locator('.bundle-candidate').count(), 1, 'fandom is searchable');
    assert.equal(await picker().getByRole('region', { name: '已选成分' }).locator('.bundle-member').count(), 3, 'search preserves the draft');
    await search.fill('');
    await picker().getByRole('combobox', { name: '成分分类' }).selectOption(fixture.category);
    assert.equal(await picker().getByRole('checkbox', { name: /选择 春日来信 下册/ }).count(), 0);
    assert.equal(await member('春日来信 下册').getByRole('spinbutton').inputValue(), '3', 'category switch retains quantities');
    await picker().getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.getByLabel('名称', { exact: true }).inputValue(), '春日全套（尚未保存）', 'picker cancellation preserves the product draft');
    assert.equal(await page.locator('.bundle-comps .bundle-member').count(), 2);
    assert.deepEqual(await readComponents(), original, 'picker cancellation never writes the database');

    // Confirm is still a draft; cancelling the outer editor discards it too.
    await choose();
    await picker().getByRole('checkbox', { name: /选择 春日来信 下册/ }).check();
    await picker().getByRole('button', { name: /确认选择/ }).click();
    assert.equal(await page.locator('.bundle-comps .bundle-member').count(), 3);
    assert.deepEqual(await readComponents(), original);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await editBundle();
    await page.locator('.bundle-comps .bundle-member').first().waitFor();
    assert.equal(await page.getByLabel('名称', { exact: true }).inputValue(), '春日全套');
    assert.equal(await page.locator('.bundle-comps .bundle-member').count(), 2);
    await choose();
    await picker().getByRole('checkbox', { name: /选择 春日来信 下册/ }).check();
    await member('春日来信 下册').getByRole('spinbutton').fill('3');
    await page.screenshot({ path: `test-results/bundle-picker-${mode}.png`, animations: 'disabled' });
    for (const size of [{ width: 1024, height: 768 }, { width: 820, height: 1180 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(size);
      const actions = await picker().locator('.modal-actions').boundingBox();
      assert.ok(actions.y >= 0 && actions.y + actions.height <= size.height, 'picker actions stay visible');
      assert.ok(await picker().evaluate(el => el.scrollWidth <= el.clientWidth), 'picker has no horizontal overflow');
      if (size.width === 390) {
        await picker().getByRole('button', { name: /已选商品（/ }).click();
        assert.equal(await member('春日来信 下册').getByRole('spinbutton').inputValue(), '3');
        await page.screenshot({ path: `test-results/bundle-picker-phone-${mode}.png`, animations: 'disabled' });
        await member('春日来信 下册').getByRole('button', { name: /移除/ }).click();
        await picker().getByRole('button', { name: /商品库（/ }).click();
        assert.equal(await picker().getByRole('checkbox', { name: /选择 春日来信 下册/ }).isChecked(), false);
        await picker().getByRole('checkbox', { name: /选择 春日来信 下册/ }).check();
      }
    }
    await page.setViewportSize({ width: 1180, height: 820 });
    await member('春日来信 下册').getByRole('spinbutton').fill('3');
    await picker().getByRole('button', { name: /确认选择/ }).click();
    // Reject invalid quantities before changing any product fields.
    const summary = page.locator('.bundle-comps');
    await summary.getByRole('article', { name: '春日来信 下册', exact: true }).getByRole('spinbutton').fill('0.5');
    await page.getByLabel('名称', { exact: true }).fill('不应写入的改名');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('每项成分的用量必须为正整数', { exact: true }).waitFor();
    assert.equal(await page.evaluate(async id => (await (await import('/src/services/catalog.ts')).getProduct(id)).name, fixture.bundle.productId), '春日全套');
    await page.getByLabel('名称', { exact: true }).fill('春日全套');
    await summary.getByRole('article', { name: '春日来信 下册', exact: true }).getByRole('spinbutton').fill('3');
    await ctx.setOffline(true);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.modal').waitFor({ state: 'hidden' });
    const saved = await readComponents();
    assert.equal(saved.length, 3);
    assert.equal(saved.find(row => row.component_variant_id === fixture.ids[1].variantId).quantity, 3);
    assert.equal(saved.find(row => row.component_variant_id === fixture.ids[0].variantId).quantity, 2);
    await ctx.setOffline(false);

    // Read errors are visible and retryable, with no empty-list save allowed.
    await page.evaluate(async () => {
      const { db } = await import('/src/db/client.ts');
      const originalRead = db.read.bind(db);
      db.read = async (...args) => {
        if (args[0].includes('SELECT * FROM bundle_components WHERE bundle_variant_id')) {
          db.read = originalRead; throw new Error('模拟成分读取失败');
        }
        return originalRead(...args);
      };
    });
    await editBundle();
    await page.getByText('模拟成分读取失败', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await page.locator('.bundle-comps .bundle-member').first().waitFor();
    assert.equal(await page.locator('.bundle-comps .bundle-member').count(), 3);
    await choose();
    await page.keyboard.press('Escape');
    assert.equal(await picker().count(), 0);
    await page.getByRole('button', { name: '取消', exact: true }).click();

    // New bundles can be configured in one visit, without defaulting to item #1.
    await page.getByRole('button', { name: '新增商品', exact: true }).click();
    await page.getByLabel('名称', { exact: true }).fill('批量新套装');
    await page.getByLabel('默认价格', { exact: true }).fill('50');
    await page.locator('.modal label.field').filter({ hasText: /^库存类型/ }).locator('select').selectOption('bundle');
    await choose();
    assert.equal(await picker().getByRole('region', { name: '已选成分' }).locator('.bundle-member').count(), 0);
    await picker().getByRole('checkbox', { name: /选择 春日来信 上册/ }).check();
    await picker().getByRole('checkbox', { name: /选择 月光徽章/ }).check();
    await member('月光徽章').getByRole('spinbutton').fill('2');
    await picker().getByRole('button', { name: /确认选择/ }).click();
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await page.locator('.modal').waitFor({ state: 'hidden' });
    const newProduct = await page.evaluate(async () => (await (await import('/src/services/catalog.ts')).listProducts()).find(p => p.name === '批量新套装'));
    assert.ok(newProduct);
    const stock = await page.evaluate(async ({ ids, newVariantId }) => {
      const events = await import('/src/services/events.ts');
      const inventory = await import('/src/services/inventory.ts');
      const orders = await import('/src/services/orders.ts');
      const { db } = await import('/src/db/client.ts');
      const id = await events.createEvent({ name: '套装用量验证展', currency: 'CNY' });
      await events.addVariantsToEvent(id, [ids[0].variantId, ids[2].variantId, newVariantId]);
      await inventory.initializeStock(id, ids[0].variantId, 20);
      await inventory.initializeStock(id, ids[2].variantId, 20);
      const cash = (await events.listPaymentMethods()).find(m => m.type === 'cash');
      await events.updatePaymentMethod(cash.id, { enabled: true });
      await events.setEventPaymentMethods(id, [cash.id]);
      await events.activateEvent(id);
      await orders.createPendingOrder({ eventId: id, lines: [{ variantId: newVariantId, quantity: 1 }], plannedPaymentMethodId: cash.id, operationId: crypto.randomUUID() });
      return db.read('SELECT variant_id,reserved_stock FROM inventory WHERE event_id=?', [id]);
    }, { ids: fixture.ids, newVariantId: newProduct.variants[0].id });
    assert.equal(stock.find(row => row.variant_id === fixture.ids[0].variantId).reserved_stock, 1);
    assert.equal(stock.find(row => row.variant_id === fixture.ids[2].variantId).reserved_stock, 2);
    assert.deepEqual(errors, []);
    console.log(`PASS ${mode}: multi-select, search/category, archive preservation, drafts/cancel, quantities, responsive picker, loading/retry, offline save and bundle stock reservation`);
    await ctx.close();
  }
} finally { await browser.close(); }
