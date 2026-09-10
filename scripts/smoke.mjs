import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5178/';
const errors = [];

const browser = await chromium.launch({
  channel: 'msedge',
  args: ['--no-sandbox']
});
const ctx = await browser.newContext();
// 持久化未获批时应用会弹确认：headless 下会自动 dismiss，这里显式接受以进入受限营业模式
ctx.on('dialog', (d) => d.accept());
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(BASE, { waitUntil: 'networkidle' });

// 等待启动流程结束（出现首次设置页或主界面）
try {
  await page.waitForFunction(
    () => {
      const t = document.body.innerText || '';
      return t.includes('准备本地数据库') || t.includes('当前环境不能营业') || t.includes('Doujin POS');
    },
    { timeout: 45000 }
  );
} catch {
  console.log('=== 启动超时，当前页面 ===');
  console.log(await page.evaluate(() => document.body.innerText.slice(0, 800)));
  console.log('=== 错误 ===');
  console.log(errors.join('\n') || '(无)');
  await browser.close();
  process.exit(3);
}

const bootText = await page.evaluate(() => document.body.innerText.slice(0, 400));
console.log('=== 启动后页面文本 ===');
console.log(bootText);

if (bootText.includes('当前环境不能营业')) {
  const table = await page.evaluate(() => document.querySelector('table')?.innerText ?? '');
  console.log('=== 能力检查 ===');
  console.log(table);
  await browser.close();
  process.exit(2);
}

// 首次启动：建立空数据库
const createBtn = page.getByRole('button', { name: '建立新的空数据库' });
if (await createBtn.count()) {
  await createBtn.click();
}
await page.waitForTimeout(1500);

// 进入展会配置，创建展会
await page.goto(`${BASE}staff/events`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const pinPad = await page.locator('.modal, .card').first().innerText();
console.log('=== 展会配置页（可能先要 PIN） ===');
console.log(pinPad.slice(0, 200));

// 若出现 PIN 设置，设置一个
const pinButtons = page.locator('button', { hasText: /^[0-9]$/ });
if (await page.getByText('设置后台 PIN').count()) {
  for (const d of ['1', '2', '3', '4']) {
    await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
  }
  await page.getByRole('button', { name: '确认' }).first().click();
  await page.waitForTimeout(500);
}

const afterPin = await page.evaluate(() => document.body.innerText.slice(0, 300));
console.log('=== 解锁后 ===');
console.log(afterPin);

console.log('=== 控制台错误 ===');
console.log(errors.length ? errors.join('\n') : '（无）');

await browser.close();
process.exit(errors.length ? 1 : 0);
