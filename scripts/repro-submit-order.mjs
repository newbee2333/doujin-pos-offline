/** 复现「提交订单后跳到空白页」：抓控制台错误、最终 URL 和页面文本。 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5178/';
const CHANNEL = process.env.SMOKE_CHANNEL ?? 'msedge';
const errors = [];

const browser = await chromium.launch({ channel: CHANNEL, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
ctx.on('dialog', (d) => d.accept());
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text());
});

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
await page.locator('.modal input').first().fill('复现展');
await page.locator('.modal').getByRole('button', { name: '创建' }).click();
await page.waitForTimeout(800);

const names = ['立牌A', '本子A', '挂件A'];
for (const n of names) {
  await gotoStaff('staff/products');
  await page.getByRole('button', { name: '新增商品' }).click();
  await page.locator('.modal input').first().fill(n);
  await page.locator('.modal input').nth(1).fill('20.00');
  await page.locator('.modal').getByRole('button', { name: '创建' }).click();
  await page.waitForTimeout(500);
}
await gotoStaff('staff/events');
await page.getByRole('button', { name: '全部加入本场', exact: true }).click();
await page.waitForTimeout(900);
for (const n of names) {
  const row = page.locator('table tbody tr').filter({ hasText: n }).first();
  if (!(await row.count())) continue;
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
}
const payCard = page.locator('div.card').filter({ hasText: '支付方式' }).last();
const cashRow = payCard.locator('div.row').filter({ hasText: '现金' }).first();
const boxes = cashRow.locator('input[type="checkbox"]');
for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check();
await page.waitForTimeout(500);
await page.getByRole('button', { name: '开场', exact: true }).click();
await page.waitForTimeout(1100);
console.log('展会已开场');

// 游客下单：加购 2 件 → 购物车 → 结算 → 提交
await page.goto(BASE + 'kiosk', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const addBtns = page.locator('.add-btn');
const n = Math.min(2, await addBtns.count());
for (let i = 0; i < n; i++) {
  await addBtns.nth(i).click();
  await page.waitForTimeout(250);
}
await page.locator('.cart-bar button').first().click();
await page.waitForTimeout(1000);
console.log('购物车页 URL:', page.url());
await page.getByRole('button', { name: '去结算' }).click();
await page.waitForTimeout(1000);
console.log('结算页 URL:', page.url());
console.log('结算页有提交按钮:', await page.getByRole('button', { name: '提交订单' }).count());

// 先选支付方式（不选的话提交按钮是禁用的）
const methodBtn = page.locator('.grid.cols-2 button').first();
if (await methodBtn.count()) {
  await methodBtn.click();
  await page.waitForTimeout(500);
  console.log('已选支付方式：', await methodBtn.innerText());
}

await page.getByRole('button', { name: '提交订单' }).click();
await page.waitForTimeout(2500);

console.log('提交后 URL:', page.url());
const body = await page.evaluate(() => (document.body.innerText || '').trim());
console.log('提交后页面文本（前 120 字）:', JSON.stringify(body.slice(0, 120)));
console.log('页面根节点子元素数:', await page.evaluate(() => document.getElementById('root')?.children.length ?? -1));

if (errors.length) {
  console.log('\n=== 捕获到', errors.length, '条错误 ===');
  for (const e of errors.slice(0, 6)) console.log('  ' + e.slice(0, 220));
} else {
  console.log('\n（未捕获到控制台错误）');
}

await page.screenshot({ path: 'scripts/repro-submit-order.png' });
await browser.close();
