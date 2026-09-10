/**
 * 「确认需输 PIN」开关的端到端验证。
 *
 * 覆盖两条路径：
 *  A. 关闭 PIN → 游客提交订单后，摊主直接看到处理界面（无「请摊主处理」、无 PIN 键盘）
 *  B. 打开 PIN → 与原来一致，先出「请摊主处理」，点进去才是 PIN 键盘
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5178/';
const CHANNEL = process.env.SMOKE_CHANNEL ?? 'msedge';
const steps = [];
const ok = (n, d = '') => steps.push(`OK   ${n}${d ? ' — ' + d : ''}`);
const fail = (n, d) => steps.push(`FAIL ${n} — ${d}`);
const errors = [];

const browser = await chromium.launch({ channel: CHANNEL, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
ctx.on('dialog', (d) => d.accept());
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

async function gotoStaff(path) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const needs =
    (await page.getByText('设置后台 PIN').count()) || (await page.getByText('请输入后台 PIN').count());
  if (needs) {
    for (const d of ['1', '2', '3', '4']) {
      await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
    }
    await page.getByRole('button', { name: '确认' }).first().click();
    await page.waitForTimeout(700);
  }
}

async function setPinRequired(required) {
  await gotoStaff('staff/events');
  const row = page
    .locator('div.row')
    .filter({ hasText: '现金' })
    .filter({ has: page.getByText('确认需输 PIN') })
    .first();
  const toggle = row.locator('label.check').filter({ hasText: '确认需输 PIN' }).locator('input');
  if (!(await toggle.count())) {
    fail('定位 PIN 开关', '在支付方式行里找不到「确认需输 PIN」复选框');
    return false;
  }
  const current = await toggle.isChecked();
  if (current !== required) {
    await toggle.click();
    await page.waitForTimeout(900);
  }
  const now = await page.evaluate(() => {
    const el = [...document.querySelectorAll('label.check')].find((l) =>
      l.textContent?.includes('确认需输 PIN')
    );
    const input = el ? el.querySelector('input') : null;
    return input ? input.checked : undefined;
  });
  if (now === required) ok(`PIN 开关已设为 ${required ? '需要' : '不需要'}`);
  else fail('PIN 开关状态', `期望 ${required}，实际 ${now}`);
  return now === required;
}

async function customerSubmitOrder() {
  await page.goto(BASE + 'kiosk', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const addBtn = page.locator('.add-btn').first();
  if (!(await addBtn.count())) {
    fail('游客下单', '菜单上没有加入按钮');
    return null;
  }
  await addBtn.click();
  await page.waitForTimeout(400);
  await page.locator('.cart-bar button').first().click();
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: '去结算' }).click();
  await page.waitForTimeout(900);
  const methodBtn = page.locator('.grid.cols-2 button').first();
  if (await methodBtn.count()) {
    await methodBtn.click();
    await page.waitForTimeout(400);
  }
  await page.getByRole('button', { name: '提交订单' }).click();
  await page.waitForTimeout(2200);

  const url = page.url();
  const text = await page.evaluate(() => (document.body.innerText || '').trim());
  return {
    url,
    hasVendorCard: text.includes('实际收款方式（可与游客选择不同）'),
    hasAskVendor: text.includes('请摊主处理'),
    hasPinPad: (await page.locator('input[type="password"], .pin-pad, .pinpad').count()) > 0
  };
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => /准备本地数据库|Doujin POS/.test(document.body.innerText || ''), {
    timeout: 45000
  });
  const createDb = page.getByRole('button', { name: '建立新的空数据库' });
  if (await createDb.count()) {
    await createDb.click();
    await page.waitForTimeout(700);
  }

  await gotoStaff('staff/events');
  await page.getByRole('button', { name: '新建展会' }).click();
  await page.locator('.modal input').first().fill('PIN 开关验证展');
  await page.locator('.modal').getByRole('button', { name: '创建' }).click();
  await page.waitForTimeout(800);

  await gotoStaff('staff/products');
  await page.getByRole('button', { name: '新增商品' }).click();
  await page.locator('.modal input').first().fill('立牌A');
  await page.locator('.modal input').nth(1).fill('20.00');
  await page.locator('.modal').getByRole('button', { name: '创建' }).click();
  await page.waitForTimeout(500);

  await gotoStaff('staff/events');
  await page.getByRole('button', { name: '全部加入本场', exact: true }).click();
  await page.waitForTimeout(900);
  const row = page.locator('table tbody tr').filter({ hasText: '立牌A' }).first();
  const p = row.locator('input[type="text"]').first();
  if (await p.count()) {
    await p.fill('20.00');
    await p.blur();
    await page.waitForTimeout(300);
  }
  const st = row.locator('input[type="number"]').first();
  if (await st.count()) {
    await st.fill('10');
    await st.blur();
    await page.waitForTimeout(400);
  }
  const payCard = page.locator('div.card').filter({ hasText: '支付方式' }).last();
  const cashRow = payCard.locator('div.row').filter({ hasText: '现金' }).first();
  const boxes = cashRow.locator('input[type="checkbox"]');
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: '开场', exact: true }).click();
  await page.waitForTimeout(1100);
  ok('场景就绪（展会进行中，现金可用）');

  // ── A. 关闭 PIN
  if (await setPinRequired(false)) {
    const r = await customerSubmitOrder();
    if (r) {
      if (r.hasVendorCard && !r.hasAskVendor) {
        ok('A. 关 PIN 后直接出现摊主处理界面', '无「请摊主处理」、无 PIN 键盘');
      } else {
        fail('A. 关 PIN 后仍要求摊主处理', JSON.stringify(r).slice(0, 200));
      }
    }
  }

  // ── B. 打开 PIN
  if (await setPinRequired(true)) {
    const r = await customerSubmitOrder();
    if (r) {
      if (r.hasAskVendor && !r.hasVendorCard) {
        ok('B. 开 PIN 后与原行为一致', '先出「请摊主处理」');
      } else {
        fail('B. 开 PIN 后未回到原行为', JSON.stringify(r).slice(0, 200));
      }
    }
  }

  if (errors.length) fail('控制台错误', errors.join(' | '));
} catch (e) {
  fail('执行异常', e.message);
}

console.log(steps.join('\n'));
await browser.close();
process.exit(steps.some((s) => s.startsWith('FAIL')) ? 1 : 0);
