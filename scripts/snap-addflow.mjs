import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5179/';
const browser = await chromium.launch({ channel: 'msedge', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1180, height: 1000 } });
ctx.on('dialog', (d) => d.accept());
const page = await ctx.newPage();

// 全新启动 → 建库 → 设 PIN
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(
  () => /准备本地数据库|当前环境不能营业|Doujin POS/.test(document.body.innerText || ''),
  { timeout: 45000 }
);
const createBtn = page.getByRole('button', { name: '建立新的空数据库' });
if (await createBtn.count()) await createBtn.click();
await page.waitForTimeout(700);

// 跳到展会配置
await page.goto(BASE + 'staff/events', { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
if (await page.getByText('设置后台 PIN').count()) {
  for (const d of ['1', '2', '3', '4']) {
    await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
  }
  await page.getByRole('button', { name: '确认' }).first().click();
  await page.waitForTimeout(500);
}

// 新建展会
await page.getByRole('button', { name: '新建展会' }).click();
await page.locator('.modal input').first().fill('展示用展');
await page.locator('.modal').getByRole('button', { name: '创建' }).click();
await page.waitForTimeout(800);

// 滚到 参展商品 区域并截屏
const card = page.locator('div.card').filter({ hasText: '参展商品' });
await card.scrollIntoViewIfNeeded();
await page.screenshot({ path: 'scripts/snap-empty.png', fullPage: false, clip: { x: 200, y: 0, width: 980, height: 700 } });

// 点开「+ 添加商品」弹层，切换到「现场新建一个」，填一下，截图
await page.getByRole('button', { name: '+ 添加商品' }).first().click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: /现场新建一个/ }).click();
await page.locator('.modal input').first().fill('新刊 01');
await page.locator('.modal input').nth(1).fill('25.00');
await page.screenshot({ path: 'scripts/snap-add.png', fullPage: false, clip: { x: 200, y: 0, width: 980, height: 800 } });

await browser.close();
console.log('snapshots saved: scripts/snap-empty.png, scripts/snap-add.png');
