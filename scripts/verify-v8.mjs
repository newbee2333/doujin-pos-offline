// v8 验收：
//   A. 规格名可改：新增时能填自定义名、改名后能存下来、留空回退「默认规格」
//   B. 展会主页在宽屏上居中（不再右侧大片空白）
//   C. 侧栏提示不再出现末尾孤字
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
}

let browser;
try {
  if (!(await waitServer())) throw new Error('vite 没起来：' + errs.join(''));
  browser = await chromium.launch({ channel: 'msedge', executablePath: fs.existsSync(EDGE) ? EDGE : undefined });

  /* ================= A. 规格名可改 ================= */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(() => {
      window.confirm = () => true;
    });
    const page = await ctx.newPage();
    await login(page);
    console.log('\n════════ A. 规格名可改 ════════');

    // 新建：规格名输入框带出「默认规格」
    await page.click('.sidebar a[href="/staff/products"]').catch(() => {});
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: '新增商品' }).click();
    await page.waitForTimeout(500);
    const nameInput = page.locator('.modal input[aria-label="规格名"]');
    check('新增：有「规格名」输入框', (await nameInput.count()) === 1, `找到 ${await nameInput.count()} 个`);
    check('新增：默认带出「默认规格」', (await nameInput.inputValue()) === '默认规格', `实得「${await nameInput.inputValue()}」`);

    // 改成自定义名字并保存
    await page.locator('.modal input').first().fill('《上册》');
    await page.locator('.modal input').nth(1).fill('30.00');
    await nameInput.fill('上册');
    await page.locator('.modal').getByRole('button', { name: '创建' }).click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(ROOT, 'scripts', 'ui6', 'v8-create-variant.png') });

    // 重新打开编辑，名字应是「上册」
    const row = page.locator('table tbody tr').filter({ hasText: '《上册》' }).first();
    await row.getByRole('button', { name: '编辑' }).click().catch(async () => {
      await row.click();
    });
    await page.waitForTimeout(900);
    const again = page.locator('.modal input[aria-label="规格名"]');
    if (await again.count()) {
      check('改名后保存成功（重开带出「上册」）', (await again.inputValue()) === '上册', `实得「${await again.inputValue()}」`);

      // 改名 → 再存一次，确认编辑分支的 updateVariant 也生效
      await again.fill('上册（首刷）');
      await page.locator('.modal').getByRole('button', { name: '保存' }).click();
      await page.waitForTimeout(900);
      const row2 = page.locator('table tbody tr').filter({ hasText: '《上册》' }).first();
      await row2.getByRole('button', { name: '编辑' }).click().catch(() => {});
      await page.waitForTimeout(900);
      const third = page.locator('.modal input[aria-label="规格名"]');
      check('编辑分支改名也能存（「上册（首刷）」）', (await third.inputValue()) === '上册（首刷）', `实得「${await third.inputValue()}」`);

      // 清空 → 保存 → 回退「默认规格」
      await third.fill('');
      await page.locator('.modal').getByRole('button', { name: '保存' }).click();
      await page.waitForTimeout(900);
      const row3 = page.locator('table tbody tr').filter({ hasText: '《上册》' }).first();
      await row3.getByRole('button', { name: '编辑' }).click().catch(() => {});
      await page.waitForTimeout(900);
      const back = page.locator('.modal input[aria-label="规格名"]');
      check('留空回退成「默认规格」', (await back.inputValue()) === '默认规格', `实得「${await back.inputValue()}」`);
      await page.keyboard.press('Escape').catch(() => {});
    } else {
      check('改名后能重新打开编辑弹窗', false, '没找到规格名输入框');
    }
    await ctx.close();
  }

  /* ================= B. 展会主页居中 ================= */
  for (const vp of [
    { w: 1920, h: 1080 },
    { w: 1440, h: 900 },
    { w: 1024, h: 768 }
  ]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    await ctx.addInitScript(() => {
      window.confirm = () => true;
    });
    const page = await ctx.newPage();
    await login(page);
    await page.click('.sidebar a[href="/"]').catch(async () => {
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
    });
    await page.waitForTimeout(1400);
    const m = await page.evaluate(() => {
      const c = document.querySelector('.card');
      const b = c ? c.getBoundingClientRect() : null;
      // 基准是 **.content 的内容盒**，不是视口：视口左侧 210px 是侧栏，
      // 把它算进「左侧留白」会得出「右边空得多」的错觉
      const ct = document.querySelector('.main > .content');
      const ccs = ct ? getComputedStyle(ct) : null;
      const cb = ct ? ct.getBoundingClientRect() : null;
      const innerL = cb ? cb.left + parseFloat(ccs.paddingLeft) : null;
      const innerR = cb ? cb.right - parseFloat(ccs.paddingRight) : null;
      return {
        win: window.innerWidth,
        left: b ? Math.round(b.left) : null,
        right: b ? Math.round(b.right) : null,
        w: b ? Math.round(b.width) : null,
        gapL: b ? Math.round(b.left - innerL) : null,
        gapR: b ? Math.round(innerR - b.right) : null,
        innerW: Math.round(innerR - innerL)
      };
    });
    console.log(
      `\n[${vp.w}] 内容区宽 ${m.innerW}，卡片 ${m.left}..${m.right}（宽 ${m.w}）  ` +
        `左留白 ${m.gapL} / 右留白 ${m.gapR}`
    );
    check(`${vp.w}：内容区内左右留白对称（差值 ≤2px）`, m.gapL !== null && Math.abs(m.gapL - m.gapR) <= 2, `左 ${m.gapL} vs 右 ${m.gapR}`);
    check(`${vp.w}：卡片不超过 960px 上限`, (m.w ?? 0) <= 960, `实测 ${m.w}px`);
    await page.screenshot({ path: path.join(ROOT, 'scripts', 'ui6', `v8-home-${vp.w}.png`) });
    await ctx.close();
  }

  /* ================= C. 侧栏提示不再孤字 ================= */
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(() => {
      window.confirm = () => true;
    });
    const page = await ctx.newPage();
    await login(page);
    const note = await page.evaluate(() => {
      const el = document.querySelector('.sidebar .side-note');
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        text: el.textContent,
        w: Math.round(r.width),
        h: Math.round(r.height),
        lh: parseFloat(cs.lineHeight),
        wrap: cs.textWrap || cs.textWrapStyle,
        lines: Math.round(r.height / parseFloat(cs.lineHeight))
      };
    });
    console.log('\n[侧栏提示]', JSON.stringify(note));
    if (note) {
      check('text-wrap: balance 已生效', note.wrap === 'balance', `computed = ${note.wrap}`);
      // 孤字的判据：如果两行里有一行只有 1 个字，就是孤字。
      // 用 Range 量第一行的字符数。
      const firstLineChars = await page.evaluate(() => {
        const el = document.querySelector('.sidebar .side-note');
        if (!el) return null;
        const node = el.firstChild;
        if (!node || node.nodeType !== 3) return null;
        const range = document.createRange();
        const text = node.textContent;
        // 二分找出第一行能放下的最大字符数
        const lh = parseFloat(getComputedStyle(el).lineHeight);
        let lo = 0;
        let hi = text.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          range.setStart(node, 0);
          range.setEnd(node, mid);
          const rects = range.getClientRects();
          if (rects.length > 1) hi = mid - 1;
          else lo = mid;
        }
        return { chars: lo, total: text.length, lineH: lh };
      });
      console.log('  第一行字符数：', JSON.stringify(firstLineChars));
      if (firstLineChars) {
        const second = firstLineChars.total - firstLineChars.chars;
        check('没有孤字（第二行 ≥2 字）', second !== 1, `第一行 ${firstLineChars.chars} 字 / 第二行 ${second} 字`);
      }
    }
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
