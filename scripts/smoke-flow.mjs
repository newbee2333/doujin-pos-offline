/**
 * 端到端冒烟：建库 → 建展会 → 建商品 → 配价格库存 → 开场 → 摊主收银 → 核对库存。
 * 用 playwright 驱动系统 Edge，验证浏览器内 SQLite WASM / OPFS 路径与业务链路。
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5178/';
const errors = [];
const steps = [];
function ok(name, detail = '') {
  steps.push(`OK   ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name, detail) {
  steps.push(`FAIL ${name} — ${detail}`);
}

const browser = await chromium.launch({ channel: 'msedge', args: ['--no-sandbox'] });
const ctx = await browser.newContext();
ctx.on('dialog', (d) => d.accept());
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

async function boot() {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => /准备本地数据库|当前环境不能营业|Doujin POS/.test(document.body.innerText || ''),
    { timeout: 45000 }
  );
  if (await page.getByRole('button', { name: '建立新的空数据库' }).count()) {
    await page.getByRole('button', { name: '建立新的空数据库' }).click();
    await page.waitForTimeout(600);
  }
  // 首次进后台需要设置 PIN
  await page.goto(`${BASE}staff/events`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  if (await page.getByText('设置后台 PIN').count()) {
    for (const d of ['1', '2', '3', '4']) {
      await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
    }
    await page.getByRole('button', { name: '确认' }).first().click();
    await page.waitForTimeout(600);
  }
}

/** 整页跳转会重置内存会话，需要重新解锁后台。 */
async function gotoStaff(path) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  if (await page.getByText('请输入后台 PIN').count()) {
    for (const d of ['1', '2', '3', '4']) {
      await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
    }
    await page.getByRole('button', { name: '确认' }).first().click();
    await page.waitForTimeout(700);
  }
}

try {
  await boot();
  ok('建库并进入后台');

  // 新建展会
  await page.getByRole('button', { name: '新建展会' }).click();
  await page.locator('.modal input').first().fill('冒烟测试展');
  await page.locator('.modal').getByRole('button', { name: '创建' }).click();
  await page.waitForTimeout(800);
  if (await page.getByText('冒烟测试展').count()) ok('创建展会');
  else fail('创建展会', await page.evaluate(() => document.body.innerText.slice(0, 200)));

  // 新建商品
  await gotoStaff('staff/products');
  await page.getByRole('button', { name: '新增商品' }).click();
  await page.locator('.modal input').first().fill('冒烟本');
  await page.locator('.modal input').nth(1).fill('25.00');
  await page.locator('.modal').getByRole('button', { name: '创建' }).click();
  await page.waitForTimeout(800);
  if (await page.getByText('冒烟本').count()) ok('创建商品');
  else fail('创建商品', await page.evaluate(() => document.body.innerText.slice(0, 200)));

  // 展会配置：加入本场、设价格、设初始库存
  await gotoStaff('staff/events');
  await page.getByRole('button', { name: '全部加入本场', exact: true }).click();
  await page.waitForTimeout(900);

  const priceInput = page.locator('table input[type="text"]').first();
  await priceInput.fill('25.00');
  await priceInput.blur();
  await page.waitForTimeout(400);

  const stockInput = page.locator('table input[type="number"]').first();
  await stockInput.fill('10');
  await stockInput.blur();
  await page.waitForTimeout(700);

  // 启用现金支付：本场启用 + 模板启用（模板默认不启用）
  const payCard = page.locator('div.card').filter({ hasText: '支付方式' }).last();
  const cashRow = payCard.locator('div.row').filter({ hasText: '现金' }).first();
  const boxes = cashRow.locator('input[type="checkbox"]');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) await boxes.nth(i).check();
  await page.waitForTimeout(700);

  await page.getByRole('button', { name: '检查开场条件' }).click();
  await page.waitForTimeout(700);
  const readyText = await page.evaluate(() => document.body.innerText);
  if (readyText.includes('满足开场条件')) ok('开场条件满足');
  else fail('开场条件', readyText.match(/.{0,80}不满足|未设置|没有.{0,20}/)?.[0] ?? '未知');

  const openBtn = page.getByRole('button', { name: '开场', exact: true });
  if (await openBtn.count()) {
    await openBtn.click();
    await page.waitForTimeout(900);
  }
  if ((await page.evaluate(() => document.body.innerText)).includes('进行中')) ok('展会开场');
  else fail('展会开场', '状态未变为进行中');

  // 摊主收银
  await gotoStaff('staff/checkout');
  await page.locator('input[type="search"]').first().fill('冒烟本');
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /\+ 加入/ }).first().click();
  await page.waitForTimeout(300);
  const payable = await page.locator('.big-price').first().innerText();
  ok('加入商品', `应付 ${payable}`);

  await page.locator('select').last().selectOption({ label: '现金' });
  await page.waitForTimeout(300);
  const cashInput = page.locator('input[placeholder="0.00"]').last();
  await cashInput.fill('30.00');
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /确认收款并完成/ }).click();
  await page.waitForTimeout(1200);

  const afterSale = await page.evaluate(() => document.body.innerText);
  if (afterSale.includes('已成交')) ok('摊主收银完成', afterSale.match(/订单 #\d+ 已成交[^\n]*/)?.[0] ?? '');
  else fail('摊主收银', afterSale.slice(-300));

  // 核对库存
  await gotoStaff('staff/inventory');
  const invText = await page.evaluate(() => document.body.innerText);
  const m = invText.match(/冒烟本[\s\S]{0,120}?(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
  if (m) {
    const [, initial, physical, reserved, available] = m;
    if (physical === '9' && reserved === '0' && available === '9') ok('库存扣减正确', `初始 ${initial} 实际 ${physical} 预留 ${reserved} 可用 ${available}`);
    else fail('库存扣减', `初始 ${initial} 实际 ${physical} 预留 ${reserved} 可用 ${available}`);
  } else {
    fail('库存扣减', invText.slice(0, 300));
  }

  // 收摊 → 首页应出现明显的「立即导出」提示
  await gotoStaff('staff/events');
  const closeBtn = page.getByRole('button', { name: '收摊', exact: true });
  if (await closeBtn.count()) {
    await closeBtn.click();
    await page.waitForTimeout(1000);
  }
  if ((await page.evaluate(() => document.body.innerText)).includes('已收摊')) ok('收摊成功');
  else fail('收摊', '状态未变为已收摊');

  await gotoStaff('');
  const homeText = await page.evaluate(() => document.body.innerText);
  if (homeText.includes('立即导出') && homeText.includes('只存在这台设备上')) ok('收摊后导出提示出现');
  else fail('收摊后导出提示', homeText.slice(0, 200));

  // 回到库存页再验证刷新（首页不列商品名）
  await gotoStaff('staff/inventory');

  // 刷新后数据仍在（持久化）
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  if (await page.getByText('请输入后台 PIN').count()) {
    for (const d of ['1', '2', '3', '4']) {
      await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
    }
    await page.getByRole('button', { name: '确认' }).first().click();
    await page.waitForTimeout(900);
  }
  const reloaded = await page.evaluate(() => document.body.innerText);
  if (reloaded.includes('冒烟本')) ok('刷新后数据保留');
  else fail('刷新后数据保留', reloaded.slice(0, 200));
} catch (e) {
  fail('执行异常', e.message);
}

console.log(steps.join('\n'));
console.log('\n=== 控制台错误 ===');
console.log(errors.length ? errors.join('\n') : '（无）');

await browser.close();
process.exit(steps.some((s) => s.startsWith('FAIL')) || errors.length ? 1 : 0);
