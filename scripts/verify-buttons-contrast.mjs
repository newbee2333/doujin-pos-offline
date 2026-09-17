/**
 * 按钮对比度审计：找出「文字颜色 ≈ 自身底色」的按钮。
 *
 * 为什么单独写一个：audit-frontend.mjs 检查的是「文字元素的对比度」，
 * 它按元素自己的 color / background 算，而按钮的背景常常是透明的
 * （靠父级深色条给底），于是被跳过。真实发生过两次：
 *   - .cart-bar 上的按钮（已修，改成白底深字）
 *   - PWA 更新提示条 .toast 上的「稍后」（白底白字，看起来是一颗空胶囊）
 * 根因是 button 的默认样式：background: var(--surface)（白）+ color: inherit，
 * 一旦放进深色容器，继承来的白字就压在白底上。
 *
 * 做法：对每个可见按钮，向上找第一个非透明背景当作真实底色，再算对比度。
 * 阈值 3.0（大号/次要信息下限）。低于 3 才报，避免把刻意的弱对比全列出来。
 *
 * 用法：node scripts/verify-buttons-contrast.mjs
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5224;
/** 给了 SMOKE_BASE 就打线上/别处，不再自己起 vite */
const EXTERNAL = process.env.SMOKE_BASE ? String(process.env.SMOKE_BASE).replace(/\/$/, '') : null;
const BASE = EXTERNAL ?? `http://127.0.0.1:${PORT}`;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

const results = [];
const check = (n, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`);
};

/* 在页面里跑：把每个可见按钮的「真实底色 + 对比度」算出来 */
const SCAN = () => {
  const parse = (s) => {
    const m = (s || '').match(/[\d.]+/g);
    return m ? m.slice(0, 3).map(Number).concat(m[3] === undefined ? 1 : Number(m[3])) : null;
  };
  const lum = (rgb) => {
    const c = rgb.slice(0, 3).map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const over = (fg, bg) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
  const effectiveBg = (el) => {
    let cur = el;
    let acc = null;
    while (cur && cur !== document.documentElement) {
      const c = parse(getComputedStyle(cur).backgroundColor);
      if (c && c[3] > 0) {
        acc = acc ? over(acc, c) : c.slice(0, 3).concat(1);
        if (acc[3] === undefined || c[3] >= 1) {
          // 已经拿到不透明底，可以停
          if (c[3] >= 1) return acc.slice(0, 3);
        }
      }
      cur = cur.parentElement;
    }
    return acc ? acc.slice(0, 3) : [255, 255, 255];
  };
  const out = [];
  for (const el of document.querySelectorAll('button, .btn')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (getComputedStyle(el).visibility === 'hidden') continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = effectiveBg(el);
    const lf = lum(fg);
    const lb = lum(bg);
    const ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
    out.push({
      text: (el.textContent || '').trim().slice(0, 18) || '(无文字)',
      cls: el.className || '(无类)',
      color: cs.color,
      bg: `rgb(${bg.map(Math.round).join(', ')})`,
      ratio: Math.round(ratio * 100) / 100,
      h: Math.round(r.height),
      w: Math.round(r.width)
    });
  }
  return out;
};

const viteErrs = [];
const vite = EXTERNAL
  ? { kill: () => {}, stdout: { on: () => {} }, stderr: { on: () => {} } }
  : spawn(process.execPath, [VITE, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
vite.stdout.on('data', () => {});
vite.stderr.on('data', (d) => viteErrs.push(String(d)));
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

let browser;
try {
  if (!(await waitServer())) throw new Error('vite 没起来：' + viteErrs.join(''));
  browser = await chromium.launch({ channel: 'msedge', executablePath: fs.existsSync(EDGE) ? EDGE : undefined });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  ctx.on('dialog', (d) => d.accept());
  await ctx.addInitScript(() => {
    window.confirm = () => true;
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));

  /* 建库 + 解锁，让后台页面能打开 */
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  const setup = page.locator('button:text-is("建立新的空数据库")');
  if (await setup.count()) {
    await setup.first().click();
    await page.waitForTimeout(2200);
  }
  await page.goto(`${BASE}/staff/events`, { waitUntil: 'domcontentloaded' });
  if (await page.locator('.pin-keys .pin-digit').count()) {
    for (let i = 0; i < 2; i++) {
      for (const k of ['1', '2', '3', '4']) await page.click(`.pin-keys .pin-digit:text-is("${k}")`);
      await page.click('.pin-actions button.primary');
      await page.waitForTimeout(900);
    }
  }

  const pages = [
    ['展会主页', '/'],
    ['展会配置', '/staff/events'],
    ['一键造数据', '/staff/backup'],
    ['游客菜单', '/kiosk']
  ];

  /* ① PWA 更新提示条：按 main.tsx 里的结构原样注入 */
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const toast = await page.evaluate(() => {
    document.querySelectorAll('.toast').forEach((n) => n.remove());
    const el = document.createElement('div');
    el.className = 'toast';
    el.id = 'probe-toast';
    el.style.bottom = '76px';
    el.textContent = '发现新版本，建议营业结束后更新';
    const b1 = document.createElement('button');
    b1.className = 'small primary';
    b1.style.marginLeft = '12px';
    b1.textContent = '立即更新';
    const b2 = document.createElement('button');
    b2.className = 'small';
    b2.style.marginLeft = '6px';
    b2.textContent = '稍后';
    el.appendChild(b1);
    el.appendChild(b2);
    document.body.appendChild(el);
    const pick = (sel) => {
      const n = el.querySelector(sel);
      const cs = getComputedStyle(n);
      const parse = (s) => {
        const m = (s.match(/[\d.]+/g) || []).map(Number);
        return { rgb: m.slice(0, 3), a: m.length > 3 ? m[3] : 1 };
      };
      const lum = (rgb) => {
        const c = rgb.map((v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      };
      const fg = parse(cs.color);
      const own = parse(cs.backgroundColor);
      // 半透明底要先压到提示条自身的底色上再算对比度。
      // 直接拿 rgba(255,255,255,.16) 当底色算会得出 1:1 的假失败。
      const base = parse(getComputedStyle(el).backgroundColor);
      const bg = own.a >= 1 ? own.rgb : own.rgb.map((v, i) => v * own.a + base.rgb[i] * (1 - own.a));
      const lf = lum(fg.rgb);
      const lb = lum(bg);
      return {
        text: n.textContent,
        color: cs.color,
        bg: cs.backgroundColor,
        effectiveBg: `rgb(${bg.map(Math.round).join(', ')})`,
        ratio: Math.round(((Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05)) * 100) / 100
      };
    };
    return { primary: pick('button.primary'), plain: pick('button:not(.primary)'), toastBg: getComputedStyle(el).backgroundColor };
  });
  console.log('\n════ PWA 更新提示条 ════');
  console.log(`  条底色 ${toast.toastBg}（半透明按钮底已压到它上面再算对比度）`);
  console.log(`  「${toast.primary.text}」${toast.primary.color} on ${toast.primary.effectiveBg} → ${toast.primary.ratio}:1`);
  console.log(`  「${toast.plain.text}」${toast.plain.color} on ${toast.plain.effectiveBg} → ${toast.plain.ratio}:1`);
  check('提示条上的主按钮文字可读（≥3:1）', toast.primary.ratio >= 3, `${toast.primary.ratio}:1`);
  check('提示条上的次按钮文字可读（≥3:1）', toast.plain.ratio >= 3, `${toast.plain.ratio}:1`);
  check(
    '次按钮的实测底色不是白的（曾白底白字）',
    toast.plain.effectiveBg !== 'rgb(255, 255, 255)',
    `${toast.plain.color} on ${toast.plain.effectiveBg}`
  );
  await page.screenshot({ path: path.join(ROOT, 'scripts', 'ui10', 'toast.png') });

  /* ② 全站扫一遍 */
  const bad = [];
  for (const [label, p] of pages) {
    await page.goto(BASE + p, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    if (await page.locator('.pin-keys .pin-digit').count()) {
      for (const k of ['1', '2', '3', '4']) await page.click(`.pin-keys .pin-digit:text-is("${k}")`);
      await page.click('.pin-actions button.primary');
      await page.waitForTimeout(900);
    }
    const rows = await page.evaluate(SCAN);
    const low = rows.filter((r) => r.ratio < 3);
    console.log(`\n════ ${label} ════  按钮 ${rows.length} 个，对比度 <3 的 ${low.length} 个`);
    for (const r of low) {
      console.log(`  ⚠️  ${r.ratio}:1  「${r.text}」 ${r.color} on ${r.bg}  .${String(r.cls).split(' ').filter(Boolean).join('.')}`);
      bad.push(`${label} / ${r.text}`);
    }
  }
  check('全站没有「文字与自身底色撞色」的按钮（≥3:1）', bad.length === 0, bad.join(' | '));

  check('控制台无错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  await browser.close();
} catch (e) {
  console.error('出错：', e.message);
  if (browser) await browser.close();
} finally {
  vite.kill('SIGTERM');
}

const failed = results.filter((x) => !x).length;
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed}，失败 ${failed}`);
if (failed) process.exitCode = 1;
