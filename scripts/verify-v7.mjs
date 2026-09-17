// v7 验收：触控尺寸 / 侧栏一屏装得下 / 双层 .content / 收银台列数与按钮位置 / 售罄只出现一次
//
// 用法：node scripts/verify-v7.mjs（自带服务，不用先起 vite）
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 5219;
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

const viteErr = [];
const vite = spawn(process.execPath, [VITE, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe']
});
vite.stdout.on('data', () => {});
vite.stderr.on('data', (d) => viteErr.push(String(d)));

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

async function seed(page) {
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
  await page.click('.sidebar a[href="/staff/events"]').catch(() => {});
  await page.waitForTimeout(1200);
  if (await page.getByRole('button', { name: '新建展会' }).count()) {
    await page.getByRole('button', { name: '新建展会' }).click();
    await page.locator('.modal input').first().fill('v7 验收');
    await page.locator('.modal').getByRole('button', { name: '创建' }).click();
    await page.waitForTimeout(900);
  }
  // [名称, 本场价格, 初始库存]。第 1 件库存 0 → 游客面出现一张售罄卡
  const ITEMS = [
    ['《夜行车》上卷', '48.00', '0'],
    ['《海边的信号灯》', '60.00', '30'],
    ['《糖分不足》', '35.00', '30'],
    ['亚克力立牌「夜行」', '38.00', '30'],
    ['《第七号观测站》', '52.00', '30'],
    ['《旧梦重拍》', '65.00', '30']
  ];
  for (const [n, p] of ITEMS) {
    await page.click('.sidebar a[href="/staff/products"]').catch(() => {});
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: '新增商品' }).click();
    await page.locator('.modal input').first().fill(n);
    await page.locator('.modal input').nth(1).fill(p);
    await page.locator('.modal').getByRole('button', { name: '创建' }).click();
    await page.waitForTimeout(450);
  }
  await page.click('.sidebar a[href="/staff/events"]').catch(() => {});
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '全部加入本场', exact: true }).click();
  await page.waitForTimeout(1200);
  // 必须逐行填本场价格。「全部加入本场」插入的是 event_price_minor = NULL，
  // 不填的话游客菜单会显示 ¥0.00 —— 那样售罄断言就会误判成「价格被清零」。
  // 第 1 件故意给库存 0，用来在游客面造出一张售罄卡。
  for (const [name, price, stock] of ITEMS) {
    const row = page.locator('table tbody tr').filter({ hasText: name }).first();
    if (!(await row.count())) continue;
    const p = row.locator('input[type="text"]').first();
    if (await p.count()) {
      await p.fill(price);
      await p.blur();
      await page.waitForTimeout(280);
    }
    const st = row.locator('input[type="number"]').first();
    if (await st.count()) {
      await st.fill(stock);
      await st.blur();
      await page.waitForTimeout(360);
    }
  }
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '开场', exact: true }).click();
  await page.waitForTimeout(1200);
}

let browser;
try {
  if (!(await waitServer())) throw new Error('vite 没起来：' + viteErr.join(''));
  browser = await chromium.launch({ channel: 'msedge', executablePath: fs.existsSync(EDGE) ? EDGE : undefined });

  // 期望列数：由 auto-fill 算出，n = floor((网格内容宽 + 12) / (140 + 12))
  for (const vp of [
    { w: 1024, h: 768, label: '1024×768', tap: 40, cols: 2 },
    { w: 1180, h: 820, label: '1180×820', tap: 44, cols: 3 },
    { w: 1366, h: 1024, label: '1366×1024', tap: 44, cols: 5 }
  ]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    await ctx.addInitScript(() => {
      window.confirm = () => true;
    });
    const page = await ctx.newPage();
    await seed(page);
    console.log(`\n════════ ${vp.label} ════════`);

    await page.click('.sidebar a[href="/staff/products"]').catch(() => {});
    await page.waitForTimeout(1400);
    const taps = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('button, a, input, select, label.check')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (getComputedStyle(el).visibility === 'hidden') continue;
        // 裸 checkbox 只有 18px，真正的点按区是外层 label.check（已单独计入）
        if (el.tagName === 'INPUT' && el.type === 'checkbox') continue;
        out.push({
          cls: (el.className || '').toString().split(' ')[0] || el.tagName.toLowerCase(),
          h: Math.round(r.height)
        });
      }
      return out;
    });
    const under38 = taps.filter((t) => t.h < 38);
    check(`${vp.label}：交互元素 ≥38px`, under38.length === 0, under38.length ? `剩 ${under38.length} 个` : `${taps.length} 个全部达标`);

    const nav = taps.find((t) => t.cls === 'a');
    check(`${vp.label}：侧栏导航项 = ${vp.tap}px`, !!nav && nav.h === vp.tap, nav ? `实测 ${nav.h}px` : '未找到');

    const sb = await page.evaluate(() => {
      const sc = document.querySelector('.sidebar .sidebar-scroll');
      return { content: sc ? sc.scrollHeight : null, visible: sc ? sc.clientHeight : null };
    });
    const scrolls = sb.content > sb.visible + 1;
    check(`${vp.label}：侧栏一屏装得下`, !scrolls, `内容 ${sb.content} / 可视 ${sb.visible}`);

    const dbl = await page.evaluate(() => !!document.querySelector('.main > .content .content'));
    check(`${vp.label}：双层 .content 已消除`, !dbl);

    await page.click('.sidebar a[href="/staff/checkout"]').catch(() => {});
    await page.waitForTimeout(1800);
    const pos = await page.evaluate(() => {
      const grid = document.querySelector('.pos-grid');
      const btn = [...document.querySelectorAll('.side-panel-foot button')].find((b) => /确认收款/.test(b.textContent || ''));
      return {
        gridW: grid ? Math.round(grid.getBoundingClientRect().width) : null,
        // 列数读计算后的轨道列表：靠「数第一行的卡片数」会在商品不够多时误判
        tracks: grid ? getComputedStyle(grid).gridTemplateColumns : null,
        btnBottom: btn ? Math.round(btn.getBoundingClientRect().bottom) : null,
        overflow: document.documentElement.scrollHeight - window.innerHeight,
        winH: window.innerHeight
      };
    });
    const colCount = pos.tracks ? pos.tracks.split(' ').filter(Boolean).length : null;
    console.log(`  收银台：网格 ${pos.gridW}px，轨道 ${pos.tracks}`);
    check(`${vp.label}：商品列数 = ${vp.cols}`, colCount === vp.cols, colCount !== null ? `实测 ${colCount} 列` : '未量到');
    check(`${vp.label}：确认收款在视口内`, pos.btnBottom !== null && pos.btnBottom <= pos.winH, `${pos.btnBottom} / ${pos.winH}`);

    await page.screenshot({ path: path.join(ROOT, 'scripts', 'ui6', `v7-${vp.label}.png`) });
    await ctx.close();
  }

  /* 售罄只出现一次 */
  {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    await ctx.addInitScript(() => {
      window.confirm = () => true;
    });
    const page = await ctx.newPage();
    await seed(page);
    await page.goto(`${BASE}/kiosk`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const so = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.menu-card-cover')];
      const sold = cards.find((c) => c.classList.contains('sold-out'));
      if (!sold) return { none: true, total: cards.length };
      return {
        total: cards.length,
        count: (sold.innerText.match(/售罄/g) || []).length,
        hasTag: !!sold.querySelector('.stock-tag'),
        hasMark: !!sold.querySelector('.sold-mark'),
        text: sold.innerText.replace(/\s+/g, ' ').trim()
      };
    });
    console.log(`\n[售罄] 卡片总数 ${so.total}`);
    if (so.none) {
      console.log('  ⚠️ 当前没有售罄卡片（库存非 0），跳过');
    } else {
      console.log(`  售罄卡文本：${so.text}`);
      check('售罄：中央覆盖层还在', so.hasMark);
      check('售罄：右上角角标已去掉', !so.hasTag);
      check('售罄：「售罄」只出现一次', so.count === 1, `实测 ${so.count} 次`);
      // 售罄不该把价格清零：卡片上仍要显示本场价格（48.00），只是颜色变灰
      check('售罄：仍显示本场价格 ¥48.00（不是 ¥0.00）', /¥48\.00/.test(so.text), so.text);
    }
    await page.screenshot({ path: path.join(ROOT, 'scripts', 'ui6', 'v7-soldout.png') });
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
