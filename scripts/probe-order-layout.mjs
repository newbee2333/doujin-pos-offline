/**
 * 「请付款」页（/kiosk/order/:id）的空间取证。
 *
 * 用户反馈：这一页左边右边都是空白，为什么不能一页显示完、非要滚一下。
 * 本脚本量的是真实几何：每个块占多宽多高、整页有多高、可视区有多高、到底滚不滚。
 *
 * 用法：node scripts/probe-order-layout.mjs
 *       SMOKE_BASE=https://doujin-pos-offline.pages.dev/ node scripts/probe-order-layout.mjs
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5228;
const EXTERNAL = process.env.SMOKE_BASE ? String(process.env.SMOKE_BASE).replace(/\/$/, '') : null;
const BASE = EXTERNAL ?? `http://127.0.0.1:${PORT}`;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
fs.mkdirSync(path.join(ROOT, 'scripts', 'ui11'), { recursive: true });

/* ---------------- 最小 PNG 编码器（造封面 / 收款码） ---------------- */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(seed, w = 400, h = 560) {
  const PAL = [
    [253, 231, 238], [227, 240, 255], [232, 247, 236], [255, 243, 220],
    [240, 233, 252], [255, 235, 230], [229, 244, 246], [245, 240, 232]
  ];
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const [r, g, b] = PAL[seed % PAL.length];
  for (let y = 0; y < h; y += 1) {
    const off = y * (w * 3 + 1);
    raw[off] = 0;
    for (let x = 0; x < w; x += 1) {
      const p = off + 1 + x * 3;
      const inBand = Math.abs(x - y * 0.5) < w * 0.12;
      const mix = inBand ? 34 : 0;
      raw[p] = Math.max(0, r - mix);
      raw[p + 1] = Math.max(0, g - mix);
      raw[p + 2] = Math.max(0, b - mix);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const viteErrs = [];
const results = [];
const check = (n, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`);
};
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
    window.prompt = (_m, d) => d ?? 'V';
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));

  async function unlockIfNeeded() {
    // 先等到「PIN 键盘」或「后台侧栏」之一出现 —— 线上首访要加载 wasm、建库，
    // 只 sleep 固定毫秒数会在还没渲染完时就去数 .pin-digit，数到 0 就以为不需要解锁。
    await page
      .waitForSelector('.pin-keys .pin-digit, .sidebar a[href="/staff/products"]', { timeout: 40000 })
      .catch(() => {});
    for (let i = 0; i < 2; i++) {
      if (!(await page.locator('.pin-keys .pin-digit').count())) break;
      for (const k of ['1', '2', '3', '4']) await page.click(`.pin-keys .pin-digit:text-is("${k}")`);
      await page.click('.pin-actions button.primary');
      await page.waitForTimeout(900);
    }
  }

  /* ---------------- 种数据 ---------------- */
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  const setup = page.locator('button:text-is("建立新的空数据库")');
  if (await setup.count()) {
    await setup.first().click();
    await page.waitForTimeout(2400);
  }
  await page.goto(`${BASE}/staff/events`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await unlockIfNeeded();
  if (await page.getByRole('button', { name: '新建展会' }).count()) {
    await page.getByRole('button', { name: '新建展会' }).click();
    await page.locator('.modal input').first().fill('付款页取证');
    await page.locator('.modal').getByRole('button', { name: '创建' }).click();
    await page.waitForTimeout(1400);
  }
  // 两件商品：一件有封面，一件没有（对照用）
  for (const [i, n] of ['测试2', '测试5'].entries()) {
    await page.click('.sidebar a[href="/staff/products"]');
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: '新增商品' }).click();
    await page.waitForTimeout(400);
    const modal = page.locator('.modal');
    await modal.locator('input').first().fill(n);
    await modal.locator('input[placeholder="0.00"]').first().fill('25.00');
    const file = modal.locator('input[type="file"]').first();
    if (await file.count()) {
      await file.setInputFiles({ name: `c${i}.png`, mimeType: 'image/png', buffer: makePng(i) });
      await page.waitForTimeout(900);
    }
    await modal.getByRole('button', { name: '创建' }).click();
    await page.waitForTimeout(700);
  }
  await page.goto(`${BASE}/staff/events`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await unlockIfNeeded();
  await page.getByRole('button', { name: '全部加入本场', exact: true }).click();
  await page.waitForTimeout(1600);
  {
    const rows = page.locator('table tbody tr');
    for (let i = 0; i < (await rows.count()); i += 1) {
      const si = rows.nth(i).locator('input[type="number"]').first();
      if (await si.count()) {
        await si.fill('20');
        await si.blur();
        await page.waitForTimeout(320);
      }
    }
  }
  // 支付方式：现金 + 微信支付（带收款码）
  {
    const payCard = page.locator('.card').filter({ hasText: '支付方式' }).first();
    for (const label of ['现金', '微信支付']) {
      const row = payCard.locator('.row').filter({ hasText: label }).first();
      if (!(await row.count())) continue;
      for (const cb of await row.locator('input[type="checkbox"]').all()) {
        if (!(await cb.isChecked())) await cb.check();
      }
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(600);
    // 微信支付要传收款码才能用于游客结算
    const qrRow = payCard.locator('.row').filter({ hasText: '微信支付' }).first();
    const file = qrRow.locator('input[type="file"]').first();
    if (await file.count()) {
      await file.setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: makePng(3, 420, 520) });
      await page.waitForTimeout(1600);
      console.log('  已上传收款码');
    } else {
      console.log('  ⚠️ 没找到收款码的 file input');
    }
  }
  await page.getByRole('button', { name: '开场', exact: true }).click();
  await page.waitForTimeout(1800);
  const badge = await page.locator('.badge').first().innerText();
  console.log('  开场状态：' + badge.replace(/\s+/g, ' '));

  /* ---------------- 走一遍游客下单 ---------------- */
  await page.goto(`${BASE}/kiosk`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2400);
  await page.locator('.menu-card-cover .add-btn').first().click();
  await page.waitForTimeout(600);
  await page.locator('.cart-bar button').click(); // 查看购物车
  await page.waitForTimeout(1200);
  const toCheckout = page.getByRole('button', { name: /去结算|结算/ }).first();
  if (await toCheckout.count()) await toCheckout.click();
  await page.waitForTimeout(1400);
  // 结算页也用 .narrow，顺手拍一张看它变宽之后什么样
  for (const vp of [
    { w: 1024, h: 768, tag: 'checkout-1024' },
    { w: 390, h: 844, tag: 'checkout-390' }
  ]) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(ROOT, 'scripts', 'ui11', `${vp.tag}.png`) });
  }
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.waitForTimeout(500);
  // 结算页：选微信支付然后提交
  const wx = page.getByRole('button', { name: '微信支付' }).first();
  if (await wx.count()) await wx.click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /提交订单/ }).click();
  await page.waitForTimeout(2200);
  console.log('  当前 URL：' + page.url());

  /* ---------------- 逐档量「请付款」页 ---------------- */
  for (const vp of [
    { w: 1180, h: 820, tag: 'iPad横-1180' },
    { w: 1024, h: 768, tag: 'iPad横-1024' },
    { w: 820, h: 1180, tag: 'iPad竖-820' },
    { w: 390, h: 844, tag: '手机-390' }
  ]) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.waitForTimeout(900);
    const m = await page.evaluate(() => {
      const rect = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
      };
      const cs = (sel, prop) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el)[prop] : null;
      };
      const cards = [...document.querySelectorAll('.kiosk-order-page > *')]
        .map((c) => {
          const b = c.getBoundingClientRect();
          return { cls: c.className.slice(0, 24), x: Math.round(b.left), y: Math.round(b.top), h: Math.round(b.height), w: Math.round(b.width) };
        })
        // display:none 的（例如空的错误条）不算「在场」，否则下面按名字查会查到空气
        .filter((c) => c.w > 0 || c.h > 0);
      return {
        win: { w: window.innerWidth, h: window.innerHeight },
        kiosk: rect('.kiosk'),
        page: rect('.kiosk-order-page'),
        pageMaxW: cs('.kiosk-order-page', 'maxWidth'),
        galleryMaxW: cs('.narrow', 'maxWidth'),
        cards,
        qrImg: rect('.qr-box img'),
        scrollH: document.documentElement.scrollHeight,
        clientH: document.documentElement.clientHeight,
        bodyScrollH: document.body.scrollHeight
      };
    });
    console.log(`\n════ ${vp.tag} ════`);
    console.log(`  视口 ${m.win.w}×${m.win.h}  整页高 ${m.scrollH}（可视 ${m.clientH}，溢出 ${m.scrollH - m.clientH}px）`);
    console.log(`  .kiosk ${JSON.stringify(m.kiosk)}`);
    console.log(`  .kiosk-order-page ${JSON.stringify(m.page)}  max-width=${m.pageMaxW} / .narrow max-width=${m.galleryMaxW}`);
    for (const c of m.cards) console.log(`    · ${c.cls.padEnd(24)} y=${String(c.y).padStart(4)} h=${String(c.h).padStart(4)} w=${c.w}`);
    console.log(`  .qr-box img ${JSON.stringify(m.qrImg)}`);

    const wide = vp.w >= 760;
    const byNum = Object.fromEntries(m.cards.map((c) => [c.cls.split(' ').pop(), c]));
    if (wide) {
      check(`${vp.tag}：整页不溢出（用户要的「一页全部显示」）`, m.scrollH - m.clientH <= 0, `溢出 ${m.scrollH - m.clientH}px`);
    } else {
      // 手机窄屏不指望一屏放下（收款码本身就 392 高），只要求单列 + 取货号在最上面
      check(`${vp.tag}：窄屏允许滚动`, m.scrollH - m.clientH > 0, `溢出 ${m.scrollH - m.clientH}px`);
    }
    check(
      `${vp.tag}：内容列不再退化成 shrink-to-fit 的 390px`,
      m.page.w >= Math.min(900, vp.w - 36),
      `列宽 ${m.page.w} / 视口 ${vp.w}`
    );
    if (wide) {
      const qr = byNum['ord-qr'];
      const no = byNum['ord-no'];
      const items = byNum['ord-items'];
      const staff = byNum['ord-staff'];
      check(
        `${vp.tag}：两栏（收款码在左，取货号/明细/处理在右）`,
        !!qr && !!no && no.x > qr.x + qr.w - 2 && items.x === no.x && (!staff || staff.x === no.x),
        `qr x=${qr?.x} w=${qr?.w} · no x=${no?.x} · items x=${items?.x} · staff x=${staff?.x}`
      );
      check(`${vp.tag}：收款码与取货号同排（顶部齐）`, Math.abs(qr.y - no.y) <= 24, `qr y=${qr.y} no y=${no.y}`);
    } else {
      const no = byNum['ord-no'];
      const qr = byNum['ord-qr'];
      check(`${vp.tag}：窄屏回到单列，且取货号仍在最上面`, no.y < qr.y, `no y=${no.y} qr y=${qr.y}`);
      check(`${vp.tag}：空的错误条不占位`, !byNum['ord-err'], byNum['ord-err'] ? `仍有 ${byNum['ord-err'].w}px 宽的一格` : '已收掉');
    }
    await page.screenshot({ path: path.join(ROOT, 'scripts', 'ui11', `order-${vp.w}.png`) });
  }
  console.log('\n控制台/页面错误：' + (errors.length ? errors.join(' | ') : '（无）'));
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
