/** 后台换皮后的逐页截图与自检（颜色令牌是否生效、有无渲染错误）。 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5230/';
const browser = await chromium.launch({ channel: process.env.SMOKE_CHANNEL ?? 'msedge', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
ctx.on('dialog', (d) => d.accept());
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 100)));

async function goto(path) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  const digit = page.locator('button', { hasText: /^1$/ }).first();
  try {
    await digit.waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    return;
  }
  for (const d of ['1', '2', '3', '4']) {
    await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
  }
  await page.getByRole('button', { name: '确认' }).first().click();
  await page.waitForTimeout(1400);
}

// 造一点数据，否则报表/订单页是空态，看不出换皮
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /准备本地数据库|Doujin POS/.test(document.body.innerText || ''), null, { polling: 500, timeout: 45000 });
const create = page.getByRole('button', { name: '建立新的空数据库' });
if (await create.count()) {
  await create.click();
  await page.waitForTimeout(1500);
}
await goto('staff/events');
await page.getByRole('button', { name: '新建展会' }).click();
await page.locator('.modal input').first().fill('换皮核对展');
await page.locator('.modal').getByRole('button', { name: '创建' }).click();
await page.waitForTimeout(1200);
await goto('staff/products');
await page.getByRole('button', { name: '新增商品' }).click();
await page.locator('.modal input').first().fill('换皮核对本');
await page.locator('.modal input').nth(1).fill('45.00');
await page.locator('.modal').getByRole('button', { name: '创建' }).click();
await page.waitForTimeout(900);
await goto('staff/events');
await page.getByRole('button', { name: '全部加入本场', exact: true }).click();
await page.waitForTimeout(1500);

const pages = [
  ['staff', '后台首页'],
  ['staff/events', '展会配置'],
  ['staff/products', '商品管理'],
  ['staff/checkout', '摊主收银'],
  ['staff/inventory', '库存'],
  ['staff/orders', '订单'],
  ['staff/reports', '报表'],
  ['staff/settings', '设置']
];

for (const [path, label] of pages) {
  // 必须走 goto()——直接 page.goto 会重新触发 PIN 锁，截到的只是锁屏页
  await goto(path);
  await page.waitForTimeout(800);
  const info = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const card = document.querySelector('.card');
    const btn = document.querySelector('button');
    return {
      bg: body.backgroundColor,
      ink: body.color,
      cardRadius: card ? getComputedStyle(card).borderRadius : null,
      btnRadius: btn ? getComputedStyle(btn).borderRadius : null,
      text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 40)
    };
  });
  const file = `scripts/skin-${path.replace(/\//g, '-')}.png`;
  await page.screenshot({ path: file, fullPage: false });
  const locked = (info.text || '').includes('请输入后台 PIN') || (info.text || '').includes('设置后台 PIN');
  console.log(`  ${label.padEnd(6)} bg=${info.bg} ink=${info.ink} card=${info.cardRadius} ${locked ? '❌ 仍在锁屏' : '✓ 已进页面'} | ${info.text}`);
}

console.log('  控制台错误:', errors.length ? errors.join(' | ') : '无');
await browser.close();
