/**
 * 第 3 步（容器查询）的验证。
 *
 * 两个核心断言：
 *  A. 列数按「容器」宽度算，不按视口宽度算。
 *     预览功能把菜单渲染进 390 / 820 / 1180 的画框里，
 *     如果用的是视口媒体查询，画框里显示的就不是真机布局。
 *  B. `.kiosk` 加了 container-type 之后（会带来布局包含），
 *     里面那个 position:fixed 的购物车条滚动时仍然吸附在视口底部。
 *     这一条必须实测——contain: layout 有可能把它变成相对 .kiosk 定位。
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5178/';
const CHANNEL = process.env.SMOKE_CHANNEL ?? 'msedge';
const steps = [];
const ok = (n, d = '') => steps.push(`OK   ${n}${d ? ' — ' + d : ''}`);
const fail = (n, d) => steps.push(`FAIL ${n} — ${d}`);

const browser = await chromium.launch({ channel: CHANNEL, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1180, height: 600 } });
ctx.on('dialog', (d) => d.accept());
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const cols = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return -1;
    const t = getComputedStyle(el).gridTemplateColumns;
    return t ? t.split(' ').length : 0;
  }, sel);

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

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => /准备本地数据库|Doujin POS/.test(document.body.innerText || ''), {
    timeout: 45000
  });
  const create = page.getByRole('button', { name: '建立新的空数据库' });
  if (await create.count()) {
    await create.click();
    await page.waitForTimeout(700);
  }

  await gotoStaff('staff/events');
  await page.getByRole('button', { name: '新建展会' }).click();
  await page.locator('.modal input').first().fill('容器查询验证展');
  await page.locator('.modal').getByRole('button', { name: '创建' }).click();
  await page.waitForTimeout(800);

  const names = ['立牌A', '立牌B', '立牌C', '本子A', '本子B', '本子C', '挂件A', '挂件B'];
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
  }
  ok('准备 8 个商品（不依赖开场，菜单草稿也能渲染）');

  // ── A1. 真机游客菜单：列数应随视口（=容器）宽变化
  const widths = [
    { w: 1180, expect: 4, label: 'iPad 横屏' },
    { w: 820, expect: 3, label: 'iPad 竖屏' },
    { w: 390, expect: 2, label: '手机' }
  ];
  for (const { w, expect, label } of widths) {
    await page.setViewportSize({ width: w, height: 640 });
    await page.goto(BASE + 'kiosk', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    const n = await cols('.menu-grid');
    if (n === expect) ok(`${label} ${w}px → ${n} 列`);
    else fail(`${label} ${w}px`, `期望 ${expect} 列，实际 ${n} 列`);
  }

  // ── B. 购物车条滚动时仍吸附视口底部（container-type 的副作用实测）
  await page.setViewportSize({ width: 1180, height: 520 });
  await page.goto(BASE + 'kiosk', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const barBefore = await page.evaluate(() => {
    const r = document.querySelector('.cart-bar').getBoundingClientRect();
    return { bottom: Math.round(r.bottom), viewportH: window.innerHeight };
  });
  const scrollable = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 4);
  if (!scrollable) {
    fail('滚动吸附', '页面不够高，测不出滚动行为（需要构造溢出）');
  } else {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(400);
    const barAfter = await page.evaluate(() => {
      const r = document.querySelector('.cart-bar').getBoundingClientRect();
      return { bottom: Math.round(r.bottom), viewportH: window.innerHeight, scrollY: Math.round(window.scrollY) };
    });
    const pinned = Math.abs(barAfter.bottom - barAfter.viewportH) <= 2;
    if (pinned) {
      ok('滚动后购物车条仍吸附视口底部', `bottom=${barAfter.bottom} 视口高=${barAfter.viewportH} 已滚 ${barAfter.scrollY}px`);
    } else {
      fail('滚动后购物车条不再吸附', `bottom=${barAfter.bottom}，视口高=${barAfter.viewportH}（差 ${barAfter.viewportH - barAfter.bottom}px，已滚 ${barAfter.scrollY}px）`);
    }
    if (barBefore.bottom === barAfter.bottom) {
      // 只是提示，不判失败
      steps.push(`NOTE 滚动前后 bottom 相同（${barBefore.bottom}）`);
    }
  }

  // ── A2. 预览画框内：列数应按画框宽度，而非浏览器窗口（1180 宽）
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoStaff('preview');
  await page.waitForTimeout(1200);
  const frameExpect = [
    { idx: 0, w: 1180, expect: 4, label: '平板横屏画框' },
    { idx: 1, w: 820, expect: 3, label: '平板竖屏画框' },
    { idx: 2, w: 390, expect: 2, label: '手机画框' }
  ];
  const count = await page.getByRole('button', { name: /预览菜单效果/ }).count();
  void count;
  for (const { idx, expect, label } of frameExpect) {
    await page.locator('select').first().selectOption({ index: idx });
    await page.waitForTimeout(700);
    const n = await cols('.preview-frame .menu-grid');
    if (n === expect) ok(`${label} → ${n} 列（按画框宽度，未受 1280px 浏览器窗口影响）`);
    else fail(label, `期望 ${expect} 列，实际 ${n} 列`);
  }

  if (errors.length) fail('控制台错误', errors.join(' | '));
} catch (e) {
  fail('执行异常', e.message);
}

console.log(steps.join('\n'));
await browser.close();
process.exit(steps.some((s) => s.startsWith('FAIL')) ? 1 : 0);
