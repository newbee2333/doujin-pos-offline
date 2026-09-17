// 前端审计取证：只量不改。把「看代码像有问题」的几条量成具体数字。
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 5213;
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

/** WCAG 相对亮度与对比度 */
function contrast(hex1, hex2) {
  const lum = (h) => {
    const c = [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16) / 255);
    const f = c.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  };
  const a = lum(hex1);
  const b = lum(hex2);
  return ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2);
}

let browser;
try {
  await waitServer();
  browser = await chromium.launch({ channel: 'msedge', executablePath: fs.existsSync(EDGE) ? EDGE : undefined });

  for (const vp of [
    { w: 1024, h: 768, label: 'iPad横' },
    { w: 820, h: 1180, label: 'iPad竖' }
  ]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    await ctx.addInitScript(() => {
      window.confirm = () => true;
    });
    const page = await ctx.newPage();

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

    console.log(`\n════════════ ${vp.label} ${vp.w}×${vp.h} ════════════`);

    /* ---- 1. 所有交互元素的实际点按尺寸 ---- */
    await page.click('.sidebar a[href="/staff/products"]').catch(() => {});
    await page.waitForTimeout(1500);
    const taps = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('button, a, input, select')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        out.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().split(' ')[0],
          text: (el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 14),
          w: Math.round(r.width),
          h: Math.round(r.height)
        });
      }
      return out;
    });
    const under44 = taps.filter((t) => t.h < 44);
    console.log(`\n[1] 点按高度 < 44px（iOS 建议最小）的元素：${under44.length} / ${taps.length}`);
    const byKey = {};
    for (const t of under44) {
      const k = `${t.tag}.${t.cls}`;
      byKey[k] = byKey[k] || { n: 0, h: t.h, sample: t.text };
      byKey[k].n++;
    }
    Object.entries(byKey)
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 12)
      .forEach(([k, v]) => console.log(`    ${String(v.n).padStart(3)}× ${k.padEnd(24)} 高 ${v.h}px  例：“${v.sample}”`));

    /* ---- 2. 双层 .content 的横向浪费 ---- */
    const pad = await page.evaluate(() => {
      const outer = document.querySelector('.main > .content');
      const inner = document.querySelector('.main > .content .content');
      const g = (el) => (el ? getComputedStyle(el) : null);
      return {
        outerPad: outer ? [g(outer).paddingLeft, g(outer).paddingRight] : null,
        innerPad: inner ? [g(inner).paddingLeft, g(inner).paddingRight] : null,
        innerExists: !!inner,
        contentW: outer ? Math.round(outer.getBoundingClientRect().width) : null
      };
    });
    console.log(`\n[2] 双层 .content：内层存在=${pad.innerExists}`);
    console.log(`    外层 padding ${pad.outerPad?.join(' / ')}，内层 ${pad.innerPad?.join(' / ')}`);
    if (pad.innerExists) {
      const wasted =
        parseFloat(pad.outerPad[0]) * 2 + parseFloat(pad.innerPad[0]) * 2;
      console.log(`    → 横向被 padding 吃掉 ${wasted}px，内容区实得 ${pad.contentW - wasted}px / 容器 ${pad.contentW}px`);
    }

    /* ---- 3. 对比度：把实际渲染出来的前景/背景色取出来算 ---- */
    const colors = await page.evaluate(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        const toHex = (c) => {
          const m = c.match(/\d+/g);
          if (!m) return c;
          return '#' + m.slice(0, 3).map((v) => (+v).toString(16).padStart(2, '0')).join('');
        };
        return { sel, fg: toHex(cs.color), bg: toHex(cs.backgroundColor), size: cs.fontSize };
      };
      return ['.muted', '.tiny.muted', '.badge', '.badge.ok', '.badge.warn', '.notice', 'th', '.side-note'].map(pick).filter(Boolean);
    });
    console.log('\n[3] 对比度（AA 正文需 ≥4.5，大字/次要信息 ≥3）');
    for (const c of colors) {
      if (!/^#/.test(c.fg) || !/^#/.test(c.bg) || c.bg === 'rgba(0,0,0,0)') {
        console.log(`    ${c.sel.padEnd(14)} 跳过（背景透明，需按父级算）`);
        continue;
      }
      const r = contrast(c.fg, c.bg);
      const flag = r < 3 ? '❌ 低于 3' : r < 4.5 ? '⚠️ 3–4.5' : '✅';
      console.log(`    ${c.sel.padEnd(14)} ${c.fg} on ${c.bg}  ${c.size.padStart(5)}  ${String(r).padStart(5)}:1  ${flag}`);
    }

    /* ---- 4. 横向溢出 ---- */
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(`\n[4] 横向溢出：${ov}px`);

    await page.screenshot({ path: path.join(ROOT, 'scripts', 'ui6', `audit-${vp.label}.png`) });
    await ctx.close();
  }

  await browser.close();
} catch (e) {
  console.error('出错：', e.message);
  if (browser) await browser.close();
} finally {
  vite.kill('SIGTERM');
}
