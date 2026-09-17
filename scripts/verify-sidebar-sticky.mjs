// 回归专项：确认 .app 改成 min-height 之后，
// 1) 短内容页不会被侧栏撑高（老 bug：侧栏内容 778px > 视口 768 → 整页滚）
// 2) 竖屏顶部横条导航也吸顶
// 3) 收银台/待付款这类「整页不滚」的页面仍然不滚（--panel-h 依赖视口高）
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 5209;
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

const vite = spawn(process.execPath, [VITE, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'ignore']
});
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
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

async function login(page) {
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
  await page.waitForTimeout(800);
}

let browser;
try {
  await waitServer();
  browser = await chromium.launch({ channel: 'msedge', executablePath: fs.existsSync(EDGE) ? EDGE : undefined });

  /* ---- A. 矮视口：侧栏自身内容超长时，不能把整页撑高 ---- */
  for (const vp of [
    { w: 1024, h: 768, label: 'iPad横 1024×768' },
    { w: 1180, h: 820, label: 'iPad横 1180×820' }
  ]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    await ctx.addInitScript(() => {
      window.confirm = () => true;
    });
    const page = await ctx.newPage();
    await login(page);

    await page.click('.sidebar a[href="/staff/backup"]');
    await page.waitForTimeout(1400);
    const m = await page.evaluate(() => {
      const sb = document.querySelector('.sidebar');
      const sc = document.querySelector('.sidebar .sidebar-scroll');
      return {
        docOverflow: document.documentElement.scrollHeight - window.innerHeight,
        sidebarH: Math.round(sb.getBoundingClientRect().height),
        sidebarScrollable: sc ? sc.scrollHeight > sc.clientHeight : null,
        winH: window.innerHeight
      };
    });
    console.log(`\n── ${vp.label} 备份恢复页 ──`);
    console.log(`   侧栏高 ${m.sidebarH} / 视口 ${m.winH}，内部可滚=${m.sidebarScrollable}，文档溢出 ${m.docOverflow}px`);
    check(
      `${vp.label}：侧栏高度等于视口（没被内容拉长）`,
      Math.abs(m.sidebarH - m.winH) <= 1,
      `${m.sidebarH} vs ${m.winH}`
    );

    // 滚到底后侧栏完整可见
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(400);
    const vis = await page.evaluate(() => {
      const r = document.querySelector('.sidebar').getBoundingClientRect();
      return Math.round(Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0)));
    });
    check(`${vp.label}：滚到底侧栏仍完整可见`, vis === m.winH, `${vis}/${m.winH}px`);
    await page.screenshot({ path: path.join(ROOT, 'scripts', 'ui6', `sidebar-fixed-${vp.w}x${vp.h}.png`) });
    await ctx.close();
  }

  /* ---- B. 竖屏：顶部横条导航吸顶 ---- */
  {
    const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 } });
    await ctx.addInitScript(() => {
      window.confirm = () => true;
    });
    const page = await ctx.newPage();
    await login(page);
    await page.click('.sidebar a[href="/staff/backup"]').catch(async () => {
      await page.goto(`${BASE}/staff/backup`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
    });
    await page.waitForTimeout(1400);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => {
      const sb = document.querySelector('.sidebar');
      const r = sb.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        h: Math.round(r.height),
        visible: Math.round(Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0)))
      };
    });
    console.log(`\n── 820×1180 竖屏 ──\n   顶部导航 top=${m.top} 高=${m.h} 可见=${m.visible}`);
    check('竖屏：顶部横条导航吸顶（不随内容滚走）', m.top === 0 && m.visible === m.h, `top=${m.top}, ${m.visible}/${m.h}`);
    check('竖屏：顶部导航没有被拉成通屏（高度合理）', m.h < 200, `${m.h}px`);
    await page.screenshot({ path: path.join(ROOT, 'scripts', 'ui6', 'sidebar-fixed-820.png') });
    await ctx.close();
  }

  /* ---- C. 收银台仍然「整页不滚」---- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    await ctx.addInitScript(() => {
      window.confirm = () => true;
    });
    const page = await ctx.newPage();
    await login(page);
    await page.click('.sidebar a[href="/staff/checkout"]').catch(() => {});
    await page.waitForTimeout(1500);
    const m = await page.evaluate(() => ({
      docOverflow: document.documentElement.scrollHeight - window.innerHeight,
      hasPosLayout: !!document.querySelector('.pos-layout'),
      panelH: getComputedStyle(document.documentElement).getPropertyValue('--panel-h').trim()
    }));
    console.log(`\n── 收银台 ──\n   .pos-layout=${m.hasPosLayout}，文档溢出 ${m.docOverflow}px，--panel-h=${m.panelH}`);
    check('收银台：整页仍然不滚动', m.docOverflow <= 0, `溢出 ${m.docOverflow}px`);
    await ctx.close();
  }

  await browser.close();
} catch (e) {
  console.error('出错：', e.message);
  if (browser) await browser.close();
} finally {
  vite.kill('SIGTERM');
}

const bad = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`);
if (bad.length) process.exitCode = 1;
