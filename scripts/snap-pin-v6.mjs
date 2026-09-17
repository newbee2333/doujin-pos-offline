// 本轮（PIN 键盘放大 + 问号放大）的验收脚本。
//
// 为什么要自己拉 vite：每次 Bash 工具调用拿到独立的网络命名空间，
// 在 A 调用里起的 server，B 调用里的浏览器连不上。所以 server 和检查
// 必须同属一个进程。另外这个沙箱的 `cd` 被 WorkBuddy shim 弄坏了，
// 只能靠 spawn 的 cwd 选项指定工作目录。
//
// 用法：node scripts/snap-pin-v6.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, 'scripts', 'ui6');
fs.mkdirSync(OUT, { recursive: true });

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

/* ---------------------------------------------------------------- 起服务 */
const vite = spawn(process.execPath, [VITE, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env }
});
vite.stdout.on('data', () => {});
vite.stderr.on('data', (d) => {
  const t = String(d);
  if (/error|Error/.test(t)) process.stderr.write('[vite] ' + t);
});

async function waitServer(timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(BASE, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

let browser;
try {
  if (!(await waitServer())) throw new Error('vite 在 60s 内没起来');
  console.log(`服务已就绪：${BASE}\n`);

  const devices = [
    { label: 'iPad-横-1024x768', width: 1024, height: 768, full: true },
    { label: 'iPad-横-1180x820', width: 1180, height: 820, full: false },
    { label: 'iPad-竖-820x1180', width: 820, height: 1180, full: false }
  ];

  browser = await chromium.launch({
    channel: 'msedge',
    executablePath: fs.existsSync(EDGE) ? EDGE : undefined
  });
  const consoleErrors = [];

  for (const d of devices) {
    const ctx = await browser.newContext({ viewport: { width: d.width, height: d.height } });
    // confirm 打桩：自动化环境默认返回 false，不桩会永远只量到「取消受限营业」那条分支
    await ctx.addInitScript(() => {
      window.confirm = () => true;
    });
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(`${d.label}: ${m.text()}`);
    });
    page.on('pageerror', (e) => consoleErrors.push(`${d.label}: ${e.message}`));

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.body.innerText.includes('正在准备离线数据库'), null, {
      timeout: 60000
    });

    // 全新档案会先落到首启引导页「准备本地数据库」，不点掉就永远到不了 PIN。
    await page.waitForTimeout(800);
    const setupBtn = page.locator('button:text-is("建立新的空数据库")');
    if (await setupBtn.count()) {
      await setupBtn.first().click();
      await page.waitForTimeout(2500);
    }

    await page.goto(`${BASE}/staff/checkout`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.pin-keys button', { timeout: 30000 });
    await page.waitForTimeout(300);

    const metrics = await page.evaluate(() => {
      const cs = (el) => (el ? getComputedStyle(el) : null);
      const r = (el) => (el ? el.getBoundingClientRect() : null);
      const digit = document.querySelector('.pin-keys .pin-digit');
      const fn = document.querySelector('.pin-keys .pin-fn');
      const dots = document.querySelector('.pin-dots');
      const keys = document.querySelector('.pin-keys');
      const dr = r(digit);
      const kr = r(keys);
      return {
        digitFont: cs(digit)?.fontSize,
        digitW: dr ? Math.round(dr.width) : null,
        digitH: dr ? Math.round(dr.height) : null,
        fnFont: cs(fn)?.fontSize,
        dotsFont: cs(dots)?.fontSize,
        keysW: kr ? Math.round(kr.width) : null,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        overflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight
      };
    });

    console.log(`\n── ${d.label} ──`);
    console.log(`   数字键 ${metrics.digitFont} / ${metrics.digitW}×${metrics.digitH}px`);
    console.log(`   功能键 ${metrics.fnFont} / 圆点 ${metrics.dotsFont} / 键盘宽 ${metrics.keysW}px`);
    console.log(`   溢出 横 ${metrics.overflowX}px / 纵 ${metrics.overflowY}px`);

    if (d.full) {
      check('数字键字号 ≥ 24px（改前 13px）', parseFloat(metrics.digitFont) >= 24, `实测 ${metrics.digitFont}`);
      check('数字键高度 ≥ 60px（改前 40px）', metrics.digitH >= 60, `实测 ${metrics.digitH}px`);
      check(
        '数字键近似正方（宽高差 ≤ 40px）',
        Math.abs(metrics.digitW - metrics.digitH) <= 40,
        `${metrics.digitW}×${metrics.digitH}`
      );
      check('圆点字号 ≥ 28px（改前 22.4px）', parseFloat(metrics.dotsFont) >= 28, `实测 ${metrics.dotsFont}`);
      check('键盘收窄 ≤ 380px（不该拉满卡宽）', metrics.keysW <= 380, `实测 ${metrics.keysW}px`);
      check('解锁页无横向溢出', metrics.overflowX === 0, `${metrics.overflowX}px`);
      check('解锁页无纵向溢出', metrics.overflowY <= 0, `${metrics.overflowY}px`);
    } else {
      check(
        `${d.label}：键盘可用（≥24px 且无横向溢出）`,
        parseFloat(metrics.digitFont) >= 24 && metrics.overflowX === 0,
        `${metrics.digitFont} / 溢出 ${metrics.overflowX}px`
      );
    }

    for (const k of ['1', '2', '3', '4']) {
      await page.click(`.pin-keys .pin-digit:text-is("${k}")`);
    }
    await page.waitForTimeout(150);
    const dotText = (await page.locator('.pin-dots').innerText()).replace(/\s/g, '');
    check(`${d.label}：输入 4 位后圆点数正确`, dotText === '●●●●', JSON.stringify(dotText));

    await page.screenshot({ path: path.join(OUT, `pin-${d.label}.png`) });

    if (!d.full) {
      await ctx.close();
      continue;
    }

    // 设 PIN 两遍 → 进后台 → 量问号
    await page.click('.pin-actions button.primary');
    await page.waitForTimeout(300);
    await page.waitForSelector('.pin-keys .pin-digit', { timeout: 10000 });
    for (const k of ['1', '2', '3', '4']) {
      await page.click(`.pin-keys .pin-digit:text-is("${k}")`);
    }
    await page.click('.pin-actions button.primary');
    await page.waitForTimeout(1200);
    // 注意：不能用 page.goto 跳后台页面。goto 是整页重载，store 里的
    // staffUnlocked 会跟着清空，于是又回到解锁页。必须走侧栏链接（SPA 内跳转）。
    await page.click('.sidebar a:text-is("展会配置")');
    await page.waitForTimeout(1500);
    // 没有展会时「参展商品」表根本不渲染，问号也就无从量起。先建一个展会。
    const newEvent = page.locator('button:text-is("新建展会")');
    if (await newEvent.count()) {
      await newEvent.first().click();
      await page.waitForSelector('input[placeholder^="例如"]', { timeout: 10000 });
      await page.fill('input[placeholder^="例如"]', '验收用展会');
      await page.click('.modal-actions button:text-is("创建")');
      await page.waitForTimeout(2000);
    }
    await page.waitForTimeout(1200);
    const info = await page.evaluate(() => {
      const el = document.querySelector('.info-dot');
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { font: cs.fontSize, w: Math.round(r.width), h: Math.round(r.height) };
    });
    if (info) {
      console.log(`   问号：字号 ${info.font} / ${info.w}×${info.h}px`);
      check('问号字号 ≥ 12px（改前 11px）', parseFloat(info.font) >= 12, `实测 ${info.font}`);
      check('问号尺寸 ≥ 18px（改前 16px）', info.w >= 18, `实测 ${info.w}px`);
    } else {
      const txt = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300);
      check('找到「精确库存」列头的问号', false, `未找到 .info-dot；页面文本：${txt}`);
    }
    await page.screenshot({ path: path.join(OUT, 'events-infodot.png') });

    await ctx.close();
  }

  await browser.close();

  console.log('\n── 控制台 ──');
  check('控制台零错误', consoleErrors.length === 0, consoleErrors.join(' | ') || '（无）');
} catch (e) {
  console.error('\n脚本自身出错：', e.message);
  results.push({ name: '脚本执行完成', ok: false, detail: e.message });
  if (browser) await browser.close();
} finally {
  vite.kill('SIGTERM');
}

const bad = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`);
process.exit(bad.length ? 1 : 0);
