/** 截取新入口：侧边栏布局（菜单预览并入上方）+ 顶栏按钮 + 展会配置/商品页的预览入口。 */
import { chromium } from 'playwright';
const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5178/';
// 本地默认用系统 Edge（本项目的 Playwright 跳过了浏览器下载）；
// CI 上传 SMOKE_CHANNEL=chromium 走 Playwright 自带浏览器。
const CHANNEL = process.env.SMOKE_CHANNEL ?? 'msedge';
const browser = await chromium.launch({
  ...(CHANNEL ? { channel: CHANNEL } : {}),
  args: ['--no-sandbox']
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
ctx.on('dialog', (d) => d.accept());
const page = await ctx.newPage();

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => /准备本地数据库|Doujin POS/.test(document.body.innerText || ''), { timeout: 45000 });
const c = page.getByRole('button', { name: '建立新的空数据库' });
if (await c.count()) { await c.click(); await page.waitForTimeout(700); }
await page.goto(BASE + 'staff/events', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
if (await page.getByText('设置后台 PIN').count()) {
  for (const d of ['1', '2', '3', '4']) await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
  await page.getByRole('button', { name: '确认' }).first().click();
  await page.waitForTimeout(900);
}
await page.getByRole('button', { name: '新建展会' }).click();
await page.locator('.modal input').first().fill('示例展');
await page.locator('.modal').getByRole('button', { name: '创建' }).click();
await page.waitForTimeout(900);

// 展会配置页：侧边栏布局 + 顶栏 + 参展商品卡片上的预览入口
await page.screenshot({ path: 'scripts/entry-events.png', clip: { x: 0, y: 0, width: 1280, height: 620 } });

// 商品页的预览入口
await page.locator('.sidebar a', { hasText: /^商品/ }).first().click();
await page.waitForTimeout(1000);
await page.screenshot({ path: 'scripts/entry-products.png', clip: { x: 0, y: 0, width: 1280, height: 460 } });

// 预览页本身
await page.locator('.sidebar a', { hasText: /^菜单预览/ }).first().click();
await page.waitForTimeout(1400);
await page.screenshot({ path: 'scripts/entry-preview.png', clip: { x: 0, y: 0, width: 1280, height: 700 } });

console.log('截图完成');
await browser.close();
