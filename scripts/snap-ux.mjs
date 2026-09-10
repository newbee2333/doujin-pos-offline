/**
 * 截取本轮 5 处 UX 改动，供人工确认。
 * 前提：dev server 已启动在 5180。
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5180/';
const browser = await chromium.launch({ channel: 'msedge', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
ctx.on('dialog', (d) => d.accept());
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

async function gotoStaff(path) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  // 首次进入后台是「设置后台 PIN」，之后是「请输入后台 PIN」，两种都要处理
  const needsPin = (await page.getByText('设置后台 PIN').count()) || (await page.getByText('请输入后台 PIN').count());
  if (needsPin) {
    for (const d of ['1', '2', '3', '4']) {
      await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
    }
    await page.getByRole('button', { name: '确认' }).first().click();
    await page.waitForTimeout(800);
  }
}

// ── 准备：建库 → 建展会 → 建商品 → 开场
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => /准备本地数据库|Doujin POS/.test(document.body.innerText || ''), {
  timeout: 45000
});
if (await page.getByRole('button', { name: '建立新的空数据库' }).count()) {
  await page.getByRole('button', { name: '建立新的空数据库' }).click();
  await page.waitForTimeout(600);
}
await gotoStaff('staff/events');
await page.getByRole('button', { name: '新建展会' }).click();
await page.locator('.modal input').first().fill('示例展');
await page.locator('.modal').getByRole('button', { name: '创建' }).click();
await page.waitForTimeout(700);

for (const [name, price] of [
  ['小护士立牌', '15.00'],
  ['本子《vn恋恋高速路》', '50.00'],
  ['亚克力钥匙扣', '25.00'],
  ['无料贴纸', '0']
]) {
  await gotoStaff('staff/products');
  await page.getByRole('button', { name: '新增商品' }).click();
  await page.locator('.modal input').first().fill(name);
  await page.locator('.modal input').nth(1).fill(price);
  await page.locator('.modal').getByRole('button', { name: '创建' }).click();
  await page.waitForTimeout(600);
}

await gotoStaff('staff/events');
await page.getByRole('button', { name: '全部加入本场', exact: true }).click();
await page.waitForTimeout(900);

// 按行定位填写，避免依赖行的排列顺序
const rows = [
  { name: '小护士立牌', price: '15.00', stock: '50' },
  { name: '本子《vn恋恋高速路》', price: '50.00', stock: '20' },
  { name: '亚克力钥匙扣', price: '25.00', stock: '30' },
  { name: '无料贴纸', price: '0', stock: '100' }
];
for (const r of rows) {
  const row = page.locator('table tbody tr').filter({ hasText: r.name }).first();
  if (!(await row.count())) {
    console.log('未找到行：', r.name);
    continue;
  }
  const p = row.locator('input[type="text"]').first();
  if (await p.count()) {
    await p.fill(r.price);
    await p.blur();
    await page.waitForTimeout(350);
  }
  const st = row.locator('input[type="number"]').first();
  if (await st.count()) {
    await st.fill(r.stock);
    await st.blur();
    await page.waitForTimeout(450);
  }
}

const payCard = page.locator('div.card').filter({ hasText: '支付方式' }).last();
const cashRow = payCard.locator('div.row').filter({ hasText: '现金' }).first();
const boxes = cashRow.locator('input[type="checkbox"]');
for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check();
await page.waitForTimeout(600);
await page.getByRole('button', { name: '开场', exact: true }).click();
await page.waitForTimeout(1000);
const opened = (await page.evaluate(() => document.body.innerText)).includes('进行中');
console.log('展会已开场：', opened);

// ── 1. 游客菜单：卡片直接加入
await page.goto(BASE + 'kiosk', { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await page.screenshot({ path: 'scripts/ux-1-kiosk.png', clip: { x: 0, y: 0, width: 1280, height: 760 } });

// ── 2. 摊主收银：卡片网格 + 现金默认实收
await gotoStaff('staff/checkout');
await page.waitForTimeout(600);
await page.getByRole('button', { name: /\+ 加入/ }).first().click();
await page.waitForTimeout(300);
await page.locator('select').last().selectOption({ label: '现金' });
await page.waitForTimeout(500);
await page.screenshot({ path: 'scripts/ux-2-staff-checkout.png', clip: { x: 0, y: 0, width: 1280, height: 860 } });

// 下单，供订单详情截图
await page.getByRole('button', { name: /确认收款并完成/ }).click();
await page.waitForTimeout(1400);
const afterSale = await page.evaluate(() => document.body.innerText);
console.log('收银结果：', afterSale.match(/订单 #\d+ 已成交[^\n]*/)?.[0] ?? '（未看到成交提示）');

// ── 3. 订单详情：两种处理的说明
await gotoStaff('staff/orders');
await page.waitForTimeout(1400);
const detailBtn = page.getByRole('button', { name: '详情' });
if (await detailBtn.count()) {
  await detailBtn.first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'scripts/ux-3-order-detail.png' });
  await page.getByRole('button', { name: '关闭' }).first().click();
  await page.waitForTimeout(400);
} else {
  await page.screenshot({ path: 'scripts/ux-3-DEBUG-orders.png' });
  console.log('未找到「详情」按钮，已存调试截图 scripts/ux-3-DEBUG-orders.png');
}

// ── 4. 库存页：快捷 +1 / −1
await gotoStaff('staff/inventory');
await page.waitForTimeout(800);
await page.screenshot({ path: 'scripts/ux-4-inventory.png', clip: { x: 0, y: 0, width: 1280, height: 560 } });

// ── 5. 库存调整弹层
await page.getByRole('button', { name: '+1' }).first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: 'scripts/ux-5-adjust-modal.png' });

console.log('控制台错误：', errors.length ? errors.join('\n') : '（无）');
await browser.close();
