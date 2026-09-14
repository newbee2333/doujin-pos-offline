/**
 * 验证两件事（2026-09-14 用户反馈）：
 *   1. 展会配置表在手机竖屏下可读（列不再被压成碎片，改为横向滚动）
 *   2. 库存设过之后仍能修改——走「调整」（需选原因、记入流水）
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5218/';
const CHANNEL = process.env.SMOKE_CHANNEL ?? 'msedge';
const steps = [];
const ok = (n, d = '') => steps.push(`OK   ${n}${d ? ' — ' + d : ''}`);
const fail = (n, d) => steps.push(`FAIL ${n} — ${d}`);

const browser = await chromium.launch({ ...(CHANNEL ? { channel: CHANNEL } : {}), args: ['--no-sandbox'] });
// 手机竖屏视口，贴近用户截图（480 宽）
const ctx = await browser.newContext({ viewport: { width: 480, height: 900 }, deviceScaleFactor: 1 });
ctx.on('dialog', (d) => d.accept());
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));

const ready = () =>
  page.waitForFunction(() => /准备本地数据库|Doujin POS/.test(document.body.innerText || ''), null, {
    polling: 500,
    timeout: 45000
  });

async function gotoStaff(path) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const digit = page.locator('button', { hasText: /^1$/ }).first();
  try {
    await digit.waitFor({ state: 'visible', timeout: 12000 });
  } catch {
    return;
  }
  for (const d of ['1', '2', '3', '4']) {
    await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
  }
  await page.getByRole('button', { name: '确认' }).first().click();
  await page.waitForTimeout(1500);
}

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await ready();
  const create = page.getByRole('button', { name: '建立新的空数据库' });
  if (await create.count()) {
    await create.click();
    await page.waitForTimeout(1500);
  }

  // 建展会 + 商品
  await gotoStaff('staff/events');
  await page.getByRole('button', { name: '新建展会' }).click();
  await page.locator('.modal input').first().fill('库存调整验证展');
  await page.locator('.modal').getByRole('button', { name: '创建' }).click();
  await page.waitForTimeout(1200);

  await gotoStaff('staff/products');
  await page.getByRole('button', { name: '新增商品' }).click();
  await page.locator('.modal input').first().fill('库存测试本');
  await page.locator('.modal input').nth(1).fill('20.00');
  await page.locator('.modal').getByRole('button', { name: '创建' }).click();
  await page.waitForTimeout(900);

  await gotoStaff('staff/events');
  await page.getByRole('button', { name: '全部加入本场', exact: true }).click();
  await page.waitForTimeout(1200);

  const row = page.locator('table tbody tr').filter({ hasText: '库存测试本' }).first();
  if (!(await row.count())) throw new Error('表格里找不到刚加入的商品');

  // 设本场价格 + 初始库存
  const price = row.locator('input[type="text"]').first();
  await price.fill('20.00');
  await price.blur();
  await page.waitForTimeout(700);
  const stockInput = row.locator('input[type="number"]').first();
  if (!(await stockInput.count())) throw new Error('找不到初始库存输入框（应可初始化）');
  await stockInput.fill('10');
  await stockInput.blur();
  await page.waitForTimeout(1200);
  ok('设初始库存 10');

  // 关键：设过之后还能不能改
  const row2 = page.locator('table tbody tr').filter({ hasText: '库存测试本' }).first();
  const adjustBtn = row2.getByRole('button', { name: '调整' });
  if (!(await adjustBtn.count())) {
    fail('库存已设后仍有「调整」入口', '找不到「调整」按钮——库存一旦设置就无法修改');
  } else {
    ok('库存已设后出现「调整」入口');
    await adjustBtn.click();
    await page.waitForTimeout(900);
    const modal = page.locator('.modal');
    if (!(await modal.count())) {
      fail('打开库存调整弹窗', '弹窗没出现');
    } else {
      // 选类型「补货」+ 数量 +5 + 备注
      await modal.getByRole('button', { name: '补货' }).first().click();
      await modal.locator('input[type="number"]').first().fill('5');
      // 备注框没有 type 属性（[type="text"] 匹配不到），按 placeholder 定位
      await modal.locator('input[placeholder^="例如：补货"]').fill('自动化测试补货');
      await page.waitForTimeout(400);
      await modal.getByRole('button', { name: '确认调整' }).click();
      await page.waitForTimeout(1600);

      const after = await page
        .locator('table tbody tr')
        .filter({ hasText: '库存测试本' })
        .first()
        .innerText();
      if (after.includes('15')) ok('库存调整生效', '10 → 15');
      else fail('库存调整生效', '调整后行内文本：' + after.replace(/\s+/g, ' ').slice(0, 80));
    }
  }

  // 排版：表格是否可横向滚动、列头是否不再竖排
  await page.waitForTimeout(500);
  const layout = await page.evaluate(() => {
    const wrap = document.querySelector('.table-wrap');
    if (!wrap) return { found: false };
    const table = wrap.querySelector('table');
    const th = wrap.querySelector('th');
    return {
      found: true,
      scrollable: wrap.scrollWidth > wrap.clientWidth,
      tableWidth: table ? Math.round(table.getBoundingClientRect().width) : 0,
      wrapWidth: Math.round(wrap.getBoundingClientRect().width),
      headerHeight: th ? Math.round(th.getBoundingClientRect().height) : 0
    };
  });
  if (!layout.found) fail('表格排版', '找不到 .table-wrap');
  else if (layout.scrollable) {
    ok('窄屏表格可横向滚动', `表格 ${layout.tableWidth}px / 容器 ${layout.wrapWidth}px`);
  } else fail('窄屏表格可横向滚动', `表宽 ${layout.tableWidth} 未超出容器 ${layout.wrapWidth}`);
  if (layout.headerHeight && layout.headerHeight < 40) {
    ok('列头不再竖排', `表头高度 ${layout.headerHeight}px`);
  } else if (layout.headerHeight) {
    fail('列头不再竖排', `表头高度 ${layout.headerHeight}px（疑似仍在竖排换行）`);
  }

  await page.screenshot({ path: 'scripts/ui-events-phone.png', fullPage: false });
  if (errors.length) fail('控制台错误', errors.join(' | '));
} catch (e) {
  fail('执行异常', e.message);
}

console.log(steps.join('\n'));
await browser.close();
process.exit(steps.some((s) => s.startsWith('FAIL')) ? 1 : 0);
