/** 「新建展会」日期校验的端到端验证：六位数年份 / 超范围 / 先后倒置 / 正常创建。 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:4182/';
const steps = [];
const ok = (n, d = '') => steps.push(`OK   ${n}${d ? ' — ' + d : ''}`);
const fail = (n, d) => steps.push(`FAIL ${n} — ${d}`);

const browser = await chromium.launch({ channel: process.env.SMOKE_CHANNEL ?? 'msedge', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
ctx.on('dialog', (d) => d.accept());
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// 建库 + PIN
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
// 显式等应用就绪（最长 30s），比固定 sleep 稳
await page.waitForFunction(
  () => /建立新的空数据库|请输入后台 PIN|设置后台 PIN/.test(document.body.innerText || ''),
  null,
  { polling: 500, timeout: 30000 }
);
await page.waitForTimeout(1200);
const createDb = page.getByRole('button', { name: '建立新的空数据库' });
if (await createDb.count()) {
  await createDb.click();
  await page.waitForTimeout(1500);
}
// PIN 的设置/输入发生在首次进后台时，不在首页
await page.goto(BASE + 'staff/events', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
// 等 PIN 键盘出现再输（页面状态会竞态变化，不能按时间点数文本）
const digit = page.locator('button', { hasText: /^1$/ }).first();
let padShown = true;
try {
  await digit.waitFor({ state: 'visible', timeout: 12000 });
} catch {
  padShown = false; // 没出现 PIN 键盘 = 已解锁或无需设置，直接继续
}
if (padShown) {
  const rounds = (await page.getByText('设置后台 PIN').count()) ? 2 : 1;
  for (let r = 0; r < rounds; r += 1) {
    for (const d of ['1', '2', '3', '4']) {
      await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
    }
    await page.getByRole('button', { name: '确认' }).first().click();
    await page.waitForTimeout(1000);
  }
}
ok('场景就绪' + (padShown ? '（完成 PIN 设置）' : '（无需 PIN）'));

const openModal = async () => {
  await page.goto(BASE + 'staff/events', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: '新建展会' }).click();
  await page.waitForTimeout(500);
  await page.locator('.modal input').first().fill('日期校验测试展');
};
const submitAndRead = async () => {
  await page.locator('.modal').getByRole('button', { name: '创建' }).click();
  await page.waitForTimeout(600);
  return page.evaluate(() => document.querySelector('.modal')?.innerText || '');
};
// 用原生 setter 模拟用户在年份段手键 6 位数（React 受控输入需要原生 setter 才能触发 onChange）
const setDateViaNative = async (idx, value) => {
  await page.evaluate(
    ([i, v]) => {
      const input = document.querySelectorAll('.modal input[type=date]')[i];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    [idx, value]
  );
};

// ① 六位数年份
await openModal();
await setDateViaNative(0, '222222-02-22');
await setDateViaNative(1, '222222-02-22');
let t = await submitAndRead();
if (t.includes('日期格式不正确') || t.includes('日期需要在')) {
  const msg = (t.match(/日期格式不正确|日期需要在[^\n]*/) || [''])[0];
  ok('① 六位数年份被拦截', msg);
} else fail('① 六位数年份', t.slice(0, 80));

// ② 超出范围
await openModal();
await page.locator('.modal input[type=date]').nth(0).fill('2020-01-01');
await page.locator('.modal input[type=date]').nth(1).fill('2036-03-01');
t = await submitAndRead();
if (t.includes('日期需要在')) ok('② 超出范围被拦截', '2036 > 2035-12-31');
else fail('② 超出范围', t.slice(0, 80));

// ③ 先后倒置
await openModal();
await page.locator('.modal input[type=date]').nth(0).fill('2035-01-01');
await page.locator('.modal input[type=date]').nth(1).fill('2030-01-01');
t = await submitAndRead();
if (t.includes('开始日期不能晚于结束日期')) ok('③ 先后倒置被拦截');
else fail('③ 先后倒置', t.slice(0, 80));

// ④ 正常日期应能创建成功
await openModal();
await page.locator('.modal input[type=date]').nth(0).fill('2026-10-01');
await page.locator('.modal input[type=date]').nth(1).fill('2026-10-07');
t = await submitAndRead();
if (t.includes('日期校验测试展')) ok('④ 正常日期创建成功');
else fail('④ 正常日期', t.slice(0, 80));

if (errors.length) fail('控制台错误', errors.join(' | ').slice(0, 150));

console.log(steps.join('\n'));
await browser.close();
process.exit(steps.some((s) => s.startsWith('FAIL')) ? 1 : 0);
