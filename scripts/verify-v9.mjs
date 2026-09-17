// 验收：游客菜单搜索框并进标题行。
// 断言：同一行（y 中心接近）、顶部高度变小、窄屏下「摊主处理」不被挤出可视区。
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5214;
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

const errs = [];
const vite = spawn(process.execPath, [VITE, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe']
});
vite.stdout.on('data', () => {});
vite.stderr.on('data', (d) => errs.push(String(d)));
async function waitServer(t = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    try {
      const r = await fetch(BASE, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const results = [];
const check = (n, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`);
};

let browser;
try {
  if (!(await waitServer())) throw new Error('vite 没起来：' + errs.join(''));
  browser = await chromium.launch({ channel: 'msedge', executablePath: fs.existsSync(EDGE) ? EDGE : undefined });

  for (const vp of [
    { w: 1024, h: 768 },
    { w: 820, h: 1180 },
    { w: 600, h: 900 }
  ]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    await ctx.addInitScript(() => {
      window.confirm = () => true;
    });
    const page = await ctx.newPage();
    // 建库 → 建展会/商品/开场，让游客菜单有内容
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const setup = page.locator('button:text-is("建立新的空数据库")');
    if (await setup.count()) {
      await setup.first().click();
      await page.waitForTimeout(2000);
    }
    await page.goto(`${BASE}/staff/checkout`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.pin-keys .pin-digit', { timeout: 30000 });
    for (let i = 0; i < 2; i++) {
      for (const k of ['1', '2', '3', '4']) await page.click(`.pin-keys .pin-digit:text-is("${k}")`);
      await page.click('.pin-actions button.primary');
      await page.waitForTimeout(900);
    }
    // 建展会 + 商品 + 开场，否则游客菜单不渲染 .kiosk-hero
    await page.click('.sidebar a[href="/staff/events"]').catch(() => {});
    await page.waitForTimeout(1200);
    if (await page.getByRole('button', { name: '新建展会' }).count()) {
      await page.getByRole('button', { name: '新建展会' }).click();
      await page.locator('.modal input').first().fill('搜索框验收');
      await page.locator('.modal').getByRole('button', { name: '创建' }).click();
      await page.waitForTimeout(900);
    }
    for (const [n, p] of [
      ['测试商品名称比较长', '35.00'],
      ['短名', '12.00']
    ]) {
      await page.click('.sidebar a[href="/staff/products"]').catch(() => {});
      await page.waitForTimeout(800);
      await page.getByRole('button', { name: '新增商品' }).click();
      await page.locator('.modal input').first().fill(n);
      await page.locator('.modal input').nth(1).fill(p);
      await page.locator('.modal').getByRole('button', { name: '创建' }).click();
      await page.waitForTimeout(500);
    }
    await page.click('.sidebar a[href="/staff/events"]').catch(() => {});
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: '全部加入本场', exact: true }).click();
    await page.waitForTimeout(1200);
    for (const [name, price] of [
      ['测试商品名称比较长', '35.00'],
      ['短名', '12.00']
    ]) {
      const row = page.locator('table tbody tr').filter({ hasText: name }).first();
      if (!(await row.count())) continue;
      const pi = row.locator('input[type="text"]').first();
      if (await pi.count()) {
        await pi.fill(price);
        await pi.blur();
        await page.waitForTimeout(280);
      }
      const si = row.locator('input[type="number"]').first();
      if (await si.count()) {
        await si.fill('20');
        await si.blur();
        await page.waitForTimeout(340);
      }
    }
    await page.getByRole('button', { name: '开场', exact: true }).click();
    await page.waitForTimeout(1200);
    await page.goto(`${BASE}/kiosk`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);

    const m = await page.evaluate(() => {
      const r = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height), cy: Math.round(b.top + b.height / 2) };
      };
      return {
        win: { w: window.innerWidth, h: window.innerHeight },
        hero: r('.kiosk-hero'),
        head: r('.kiosk-hero-head'),
        search: r('.kiosk-search'),
        btn: r('.kiosk-hero-top > button'),
        chips: r('.chip-row'),
        grid: r('.menu-grid'),
        chipsInRow: !!document.querySelector('.kiosk-hero-top > .kiosk-chips'),
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth, headH: r('.kiosk-hero-head').h, searchH: r('.kiosk-search').h, btnH: r('.kiosk-hero-top button').h, heroPadTop: parseFloat(getComputedStyle(document.querySelector('.kiosk-hero')).paddingTop), heroPadBottom: parseFloat(getComputedStyle(document.querySelector('.kiosk-hero')).paddingBottom)
      };
    });

    console.log(`\n════ 视口 ${vp.w}×${vp.h} ════`);
    console.log(`  hero 高 ${m.hero.h}（${m.hero.top}..${m.hero.bottom}）  标题块 cy=${m.head.cy}  搜索 cy=${m.search.cy}  按钮 cy=${m.btn.cy}  分类行 cy=${m.chips.cy}`);
    console.log(`  搜索 x: ${m.search.left}..${m.search.right}（宽 ${m.search.right - m.search.left}）  按钮 x: ${m.btn.left}..${m.btn.right}`);

    check(`${vp.w}：搜索框与标题块同一行（cy 差 ≤6px）`, Math.abs(m.search.cy - m.head.cy) <= 6, `${m.search.cy} vs ${m.head.cy}`);
    check(`${vp.w}：搜索框在「摊主处理」左侧`, m.search.right <= m.btn.left + 1, `${m.search.right} ≤ ${m.btn.left}`);
    check(`${vp.w}：摊主处理完整在可视区内`, m.btn.right <= m.win.w, `${m.btn.right} / ${m.win.w}`);
    check(`${vp.w}：无横向溢出`, m.overflowX === 0, `${m.overflowX}px`);
    if (vp.w > 700) {
      check(`${vp.w}：分类行与搜索框同一行（cy 差 ≤6px）`, Math.abs(m.chips.cy - m.search.cy) <= 6, `${m.chips.cy} vs ${m.search.cy}`);
      // 2026-09-17 起分类行并进页头，所以 150 收成 100
      check(`${vp.w}：页头（标题 + 分类 + 搜索 + 摊主处理）不超过 100px`, m.hero.h <= 100, `${m.hero.h}px`);
    } else {
      // 手机/窄画框塞不下四项：分类整行换到第二行（@container max-width:700）
      check(`${vp.w}：分类整行换到第二行`, m.chips.top > m.search.top, `chip top ${m.chips.top} > 搜索 top ${m.search.top}`);
      check(`${vp.w}：页头不超过 130px`, m.hero.h <= 130, `${m.hero.h}px`);
    }
    if (vp.w === 1024) {
      // 搜索框从「占满整行」收成 200px 左右，视口变窄时允许再收缩
      check('1024：搜索框已收窄（≤260px）', m.search.right - m.search.left <= 260, `${m.search.right - m.search.left}px`);
      check('1024：搜索框仍可点（≥140px）', m.search.right - m.search.left >= 140, `${m.search.right - m.search.left}px`);
    }
    void m.chipsInRow;
    await page.screenshot({ path: path.join(ROOT, 'scripts', 'ui6', `v9-kiosk-${vp.w}.png`) });
    await ctx.close();
  }

  await browser.close();
} catch (e) {
  console.error('出错：', e.message);
  if (browser) await browser.close();
} finally {
  vite.kill('SIGTERM');
}

const bad = results.filter((x) => !x).length;
console.log(`\n合计 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
if (bad) process.exitCode = 1;
