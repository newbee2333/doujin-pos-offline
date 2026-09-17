/**
 * 第 10 轮改动的取证脚本（自带 vite，跑在一条命令里）。
 *
 * 覆盖用户提的 6 条：
 *   1 添加商品弹窗的一键全选 + 默认价格带入本场价格
 *   2 商品缩略图（弹窗 / 参展商品表）+ 副标题显示分类
 *   3 游客菜单分类 chip 的对比度
 *   4 搜索框并进分类行 + 列数横 6 竖 4
 *   5 摊主收银页显示异常
 *   6 分类新增 / 删除
 *
 * 用法：node scripts/snap-r10.mjs [输出目录]
 * 产物：<输出目录>/*.png + 控制台断言
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'scripts', 'r10'));
const PORT = 5220;
/** 给了 SMOKE_BASE 就打线上/别处，不再自己起 vite */
const EXTERNAL = process.env.SMOKE_BASE ? String(process.env.SMOKE_BASE).replace(/\/$/, '') : null;
const BASE = EXTERNAL ?? `http://127.0.0.1:${PORT}`;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
fs.mkdirSync(OUT, { recursive: true });

/* -------------------------------------------------- 最小 PNG 编码器（造封面） */
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
const PALETTE = [
  [253, 231, 238], [227, 240, 255], [232, 247, 236], [255, 243, 220],
  [240, 233, 252], [255, 235, 230], [229, 244, 246], [245, 240, 232]
];
function makeCover(seed, w = 400, h = 560) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const [r, g, b] = PALETTE[seed % PALETTE.length];
  const band = seed % 3;
  for (let y = 0; y < h; y += 1) {
    const off = y * (w * 3 + 1);
    raw[off] = 0;
    for (let x = 0; x < w; x += 1) {
      const p = off + 1 + x * 3;
      const inBand =
        (band === 0 && y > h * 0.15 && y < h * 0.45 && x > w * 0.15) ||
        (band === 1 && x > w * 0.2 && x < w * 0.8 && y > h * 0.5) ||
        (band === 2 && Math.abs(x - y * 0.5) < w * 0.12);
      const mix = inBand ? 30 : 0;
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

/* -------------------------------------------------- 起 vite（打线上时不起） */
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

const results = [];
const check = (n, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`);
};
const note = (m) => console.log('  ' + m);
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png') });

/* 商品种子：名字 / 分类 / 价格。前 6 件加进本场，后 2 件留着不进，
   这样「添加商品到本场」弹窗里始终有内容可看。 */
const SEED = [
  ['vn爱momo', '新刊', '35.00'],
  ['跳跳亚克力', '亚克力', '12.00'],
  ['《售罄本》', '新刊', '48.00'],
  ['星屑徽章套组', '徽章', '25.00'],
  ['色纸·夜航', '色纸', '18.00'],
  ['无料贴纸包', '无料', '0.00'],
  ['既刊·旧作合集', '既刊', '30.00'],
  ['摊位套装 A', '套装', '120.00']
];
const IN_EVENT = 6;

let browser;
try {
  if (!(await waitServer())) throw new Error('vite 没起来：' + viteErrs.join(''));
  browser = await chromium.launch({ channel: 'msedge', executablePath: fs.existsSync(EDGE) ? EDGE : undefined });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  await ctx.addInitScript(() => {
    window.confirm = () => true;
    window.prompt = (_m, d) => d ?? 'R10';
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160));
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message.slice(0, 160)));

  /* ------------------------------------------------ 建库 + 解锁 */
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  const setup = page.locator('button:text-is("建立新的空数据库")');
  if (await setup.count()) {
    await setup.first().click();
    await page.waitForTimeout(2500);
  }
  await page.goto(`${BASE}/staff/events`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.pin-keys .pin-digit', { timeout: 30000 });
  for (let i = 0; i < 2; i++) {
    for (const k of ['1', '2', '3', '4']) await page.click(`.pin-keys .pin-digit:text-is("${k}")`);
    await page.click('.pin-actions button.primary');
    await page.waitForTimeout(900);
  }
  note('已解锁后台');

  /* ------------------------------------------------ 展会 */
  await page.getByRole('button', { name: '新建展会' }).click();
  await page.locator('.modal input').first().fill('cp31');
  await page.locator('.modal').getByRole('button', { name: '创建' }).click();
  await page.waitForTimeout(1400);
  note('展会 cp31 已建');

  /* ------------------------------------------------ 商品（含封面、分类） */
  for (let i = 0; i < SEED.length; i += 1) {
    const [name, cat, price] = SEED[i];
    await page.click('.sidebar a[href="/staff/products"]');
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: '新增商品' }).click();
    await page.waitForTimeout(500);
    const modal = page.locator('.modal');
    await modal.locator('input').first().fill(name);
    await modal.locator('select').first().selectOption({ label: cat });
    await modal.locator('input[placeholder="0.00"]').first().fill(price);
    const sku = modal.locator('input[aria-label="默认规格 的 SKU"]');
    if (await sku.count()) await sku.first().fill(`SKU-${1000 + i}`);
    const file = modal.locator('input[type="file"]').first();
    if (await file.count()) {
      await file.setInputFiles({ name: `c${i}.png`, mimeType: 'image/png', buffer: makeCover(i) });
      await page.waitForTimeout(900);
    }
    await modal.getByRole('button', { name: '创建' }).click();
    await page.waitForTimeout(800);
  }
  note(`已建商品 ${SEED.length} 件`);

  /* ------------------------------------------------ 添加商品到本场：弹窗 */
  await page.click('.sidebar a[href="/staff/events"]');
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '+ 添加商品' }).first().click();
  await page.waitForTimeout(700);
  const addModal = page.locator('.modal');
  await shot(page, '01-添加商品弹窗-改前基线');

  // 一键全选 / 取消全选
  const allBtn = addModal.getByRole('button', { name: '全选', exact: true });
  const noneBtn = addModal.getByRole('button', { name: '取消全选' });
  const hasAll = (await allBtn.count()) > 0 && (await noneBtn.count()) > 0;
  let selectAllWorks = false;
  if (hasAll) {
    const boxes = addModal.locator('tbody input[type="checkbox"]');
    const total = await boxes.count();
    await allBtn.first().click();
    await page.waitForTimeout(300);
    let checked = 0;
    for (let i = 0; i < total; i += 1) if (await boxes.nth(i).isChecked()) checked += 1;
    note(`全选：勾中 ${checked}/${total}`);
    await noneBtn.first().click();
    await page.waitForTimeout(300);
    let after = 0;
    for (let i = 0; i < total; i += 1) if (await boxes.nth(i).isChecked()) after += 1;
    note(`取消全选：勾中 ${after}/${total}`);
    selectAllWorks = total > 0 && checked === total && after === 0;
    // 再全选一次，然后把后两件摘掉，只加入前 6 件
    await allBtn.first().click();
    await page.waitForTimeout(300);
    for (let i = IN_EVENT; i < total; i += 1) await boxes.nth(i).uncheck();
    await page.waitForTimeout(200);
  } else {
    // 改前基线：还没有全选按钮，手工勾前 6 件，让后面的断言仍可跑
    const boxes = addModal.locator('tbody input[type="checkbox"]');
    const total = await boxes.count();
    for (let i = 0; i < Math.min(IN_EVENT, total); i += 1) await boxes.nth(i).check();
    await page.waitForTimeout(200);
    note(`改前基线：没有全选入口，手工勾了 ${Math.min(IN_EVENT, total)} 件`);
  }
  check('弹窗提供一键全选 / 取消全选', hasAll);
  check('一键全选可用且可取消', selectAllWorks);
  await shot(page, '02-添加商品弹窗-全选后');
  await addModal.getByRole('button', { name: /加入所选/ }).click();
  await page.waitForTimeout(1800);
  note('已加入前 6 件到本场');

  /* ------------------------------------------------ 默认价格是否带入 */
  const priceCol = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('table tbody tr')];
    return rows.map((r) => {
      const cells = [...r.querySelectorAll('td')];
      const nameCell = cells[1];
      const price = cells[2]?.querySelector('input[type="text"]');
      return {
        name: (nameCell?.innerText || '').split('\n')[0].trim(),
        sub: (nameCell?.innerText || '').replace(/\s+/g, ' ').trim(),
        price: price ? price.value : '(非输入框)',
        hasThumb: !!nameCell?.querySelector('.thumb, .thumb-placeholder, img')
      };
    });
  });
  const filled = priceCol.filter((r) => r.price && r.price !== '');
  note('参展商品表价格列：' + priceCol.map((r) => `${r.name}=${r.price}`).join(' | '));
  note('参展商品表副标题：' + priceCol.map((r) => r.sub).join(' ／ '));
  check(
    '加入本场后本场价格自动沿用商品默认价格',
    filled.length === priceCol.length && priceCol.length > 0,
    `${filled.length}/${priceCol.length} 行有值`
  );
  check('参展商品表商品列有缩略图', priceCol.filter((r) => r.hasThumb).length === priceCol.length, `${priceCol.filter((r) => r.hasThumb).length}/${priceCol.length}`);
  check(
    '参展商品表副标题显示分类而不是 normal / 普通库存',
    priceCol.every((r) => !/\bnormal\b|普通库存/.test(r.sub)) &&
      priceCol.some((r) => /新刊|亚克力|徽章|色纸|无料|套装|既刊/.test(r.sub)),
    priceCol[0]?.sub
  );
  await shot(page, '03-参展商品表-缩略图与分类');

  /* 改前基线里价格是空的（这正是被修掉的缺陷），后面要开场就得先补上，
     否则整条流程会停在「N 个启用商品未设置本场价格」。 */
  {
    const rows0 = page.locator('table tbody tr');
    const n0 = await rows0.count();
    for (let i = 0; i < n0; i += 1) {
      const pi = rows0.nth(i).locator('input[type="text"]').first();
      if (!(await pi.count())) continue;
      if ((await pi.inputValue()) === '') {
        await pi.fill(SEED[i]?.[2] ?? '20.00');
        await pi.blur();
        await page.waitForTimeout(260);
      }
    }
  }

  /* ------------------------------------------------ 初始库存 + 开场 */
  const rows = page.locator('table tbody tr');
  const n = await rows.count();
  for (let i = 0; i < n; i += 1) {
    const r = rows.nth(i);
    const si = r.locator('input[type="number"]').first();
    if (await si.count()) {
      await si.fill(String(8 + i * 3));
      await si.blur();
      await page.waitForTimeout(320);
    }
  }
  // 开场条件里有一条「没有启用任何支付方式」，先把现金打开，
  // 否则整条流程会停在草稿状态（收银页也就是「不能开单」的样子）
  {
    const payCard = page.locator('.card').filter({ hasText: '支付方式' }).first();
    const cashRow = payCard.locator('.row').filter({ hasText: '现金' }).first();
    if (await cashRow.count()) {
      for (const cb of await cashRow.locator('input[type="checkbox"]').all()) {
        if (!(await cb.isChecked())) await cb.check();
      }
      await page.waitForTimeout(900);
      note('已启用现金收款');
    } else {
      note('⚠️ 没找到「现金」支付方式行，开场可能会被拦');
    }
  }
  await page.getByRole('button', { name: '开场', exact: true }).click();
  await page.waitForTimeout(1500);
  const statusAfter = await page.locator('.badge').first().innerText();
  note(`开场后状态徽章：${statusAfter.replace(/\s+/g, ' ')}`);
  check('展会已开场（不是仍停在草稿）', /进行中/.test(statusAfter), statusAfter);

  /* ------------------------------------------------ 游客菜单：布局 + chip */
  for (const vp of [
    { w: 1180, h: 820, tag: '横屏-1180', cols: 6 },
    { w: 1024, h: 768, tag: '横屏-1024', cols: 6 },
    { w: 820, h: 1180, tag: '竖屏-820', cols: 4 },
    { w: 390, h: 844, tag: '手机-390', cols: 2 }
  ]) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto(`${BASE}/kiosk`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);
    const m = await page.evaluate(() => {
      const rect = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height), cy: Math.round(b.top + b.height / 2) };
      };
      const grid = document.querySelector('.menu-grid');
      const cards = [...(grid?.children ?? [])].filter((c) => c.classList.contains('menu-card'));
      let cols = 0;
      if (cards.length) {
        const top0 = Math.round(cards[0].getBoundingClientRect().top);
        cols = cards.filter((c) => Math.abs(Math.round(c.getBoundingClientRect().top) - top0) <= 2).length;
      }
      // chip 对比度：取每个 chip 的前景色 / 背景色
      const chips = [...document.querySelectorAll('.chip')].map((c) => {
        const cs = getComputedStyle(c);
        return { text: c.textContent.trim(), color: cs.color, bg: cs.backgroundColor, active: c.classList.contains('active') };
      });
      const hero = document.querySelector('.kiosk-hero');
      return {
        win: { w: window.innerWidth, h: window.innerHeight },
        hero: rect('.kiosk-hero'),
        heroPad: hero ? parseFloat(getComputedStyle(hero).paddingTop) + parseFloat(getComputedStyle(hero).paddingBottom) : null,
        search: rect('.kiosk-search'),
        chipRow: rect('.chip-row'),
        grid: rect('.menu-grid'),
        cols,
        cardW: cards[0] ? Math.round(cards[0].getBoundingClientRect().width) : null,
        chips,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });
    console.log(`\n════ 游客菜单 ${vp.tag} ════`);
    note(`hero.y ${m.hero.top}..${m.hero.bottom}（高 ${m.hero.h}）  搜索 x ${m.search.left}..${m.search.right}（宽 ${m.search.w}）`);
    note(`chip-row y ${m.chipRow.top}..${m.chipRow.bottom}  列数 ${m.cols}  卡片宽 ${m.cardW}  网格 x ${m.grid.left}..${m.grid.right}`);
    const expectCols = vp.cols;
    check(`${vp.tag}：一行 ${expectCols} 个商品卡`, m.cols === expectCols, `实测 ${m.cols}`);
    // 金额与加购按钮必须在同一行：横屏 6 列时卡片只有 155px，
    // 20px 的「¥120.00 CNY」+ 46px 圆钮放不下，长价格会换行、按钮掉到第二行。
    const sameRow = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.menu-card-cover')];
      const bad = [];
      for (const c of cards) {
        const price = c.querySelector('.menu-card-action .price');
        const btn = c.querySelector('.menu-card-action .add-btn');
        if (!price || !btn) continue;
        const a = price.getBoundingClientRect();
        const b = btn.getBoundingClientRect();
        if (Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) > 3) {
          bad.push(`${c.querySelector('.caption .name')?.textContent ?? '?'}=${price.textContent}`);
        }
      }
      return { total: cards.length, bad };
    });
    note(`金额与加购按钮同行：${sameRow.total - sameRow.bad.length}/${sameRow.total} 张卡`);
    check(`${vp.tag}：每张卡的金额与加购按钮都在同一行`, sameRow.bad.length === 0, sameRow.bad.join(' | '));
    if (vp.w > 700) {
      check(`${vp.tag}：搜索框落在分类行（chip-row）纵向范围内`, Math.abs(m.search.cy - m.chipRow.cy) <= 24, `搜索 cy ${m.search.cy} / chip cy ${m.chipRow.cy}`);
    } else {
      // 手机宽度塞不下四项，分类整行换到第二行（@container max-width:700 那条）
      check(`${vp.tag}：分类整行换到第二行、搜索留在第一行`, m.chipRow.top > m.search.top, `chip top ${m.chipRow.top} > 搜索 top ${m.search.top}`);
    }
    check(`${vp.tag}：无横向溢出`, m.overflowX === 0, `${m.overflowX}px`);
    // 手机宽度下分类整行换到第二行，所以门槛放宽到 130
    check(
      `${vp.tag}：页头不超过 ${vp.w > 700 ? 100 : 130}px`,
      m.hero.h <= (vp.w > 700 ? 100 : 130),
      `${m.hero.h}px`
    );
    if (vp.w === 1180) {
      note('chip 配色：' + m.chips.map((c) => `${c.text}${c.active ? '(active)' : ''} ${c.color} on ${c.bg}`).join(' || '));
    }
    await shot(page, `04-游客菜单-${vp.tag}`);

    // 选中一个非「全部」分类，看 chip 的字还看得清吗。
    // 关键是把指针停在它上面再量一次：iPad 上点一下之后 :hover 会残留，
    // 而 button:hover:not(:disabled) 的特指性高于 .chip.active，
    // 于是选中项变成白字压浅底 —— 字还在，但看不见。
    const cat = page.locator('.chip').nth(1);
    if (await cat.count()) {
      await cat.click();
      await page.waitForTimeout(400);
      await cat.hover();
      await page.waitForTimeout(300);
      const chipState = await page.evaluate(() => {
        const el = document.querySelector('.chip.active');
        if (!el) return null;
        const cs = getComputedStyle(el);
        const parse = (s) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const lum = (rgb) => {
          const c = rgb.map((v) => {
            const x = v / 255;
            return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        };
        const fg = lum(parse(cs.color));
        const bg = lum(parse(cs.backgroundColor));
        const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        return {
          text: el.textContent.trim(),
          color: cs.color,
          bg: cs.backgroundColor,
          ratio: Math.round(ratio * 100) / 100
        };
      });
      note(`选中态 chip（指针停在它上面）：${JSON.stringify(chipState)}`);
      check(
        `${vp.tag}：选中的分类胶囊文字对比度 ≥4.5:1`,
        !!chipState && chipState.ratio >= 4.5,
        chipState ? `${chipState.ratio}:1（${chipState.color} on ${chipState.bg}）` : '没有 .chip.active'
      );
      await shot(page, `05-游客菜单-选中分类-${vp.tag}`);
    }
  }

  /* ------------------------------------------------ 摊主收银页 */
  async function reUnlock() {
    const pad = page.locator('.pin-keys .pin-digit');
    if (!(await pad.count())) return;
    for (const k of ['1', '2', '3', '4']) await page.click(`.pin-keys .pin-digit:text-is("${k}")`);
    await page.click('.pin-actions button.primary');
    await page.waitForTimeout(1000);
  }
  for (const vp of [
    { w: 1024, h: 768, tag: '横屏-1024' },
    { w: 1180, h: 820, tag: '横屏-1180' }
  ]) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto(`${BASE}/staff/checkout`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await reUnlock();
    await page.waitForTimeout(2200);
    const m = await page.evaluate(() => {
      const r = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) };
      };
      const grid = document.querySelector('.pos-grid');
      const first = grid?.querySelector('.pos-card');
      const cards = [...(grid?.children ?? [])].filter((c) => c.classList.contains('pos-card'));
      let cols = 0;
      if (cards.length) {
        const t0 = Math.round(cards[0].getBoundingClientRect().top);
        cols = cards.filter((c) => Math.abs(Math.round(c.getBoundingClientRect().top) - t0) <= 2).length;
      }
      const gs = grid ? getComputedStyle(grid) : null;
      return {
        win: { w: window.innerWidth, h: window.innerHeight },
        toolbar: r('.pos-toolbar'),
        chipRow: r('.pos-chips'),
        chipH: document.querySelector('.pos-chips .chip')?.getBoundingClientRect().height ?? null,
        nudge: r('.backup-nudge'),
        grid: r('.pos-grid'),
        gridScrollTop: grid?.scrollTop ?? null,
        gridPadTop: gs ? parseFloat(gs.paddingTop) : null,
        gridOverflowY: grid ? grid.scrollHeight - grid.clientHeight : null,
        first: first ? r('.pos-grid .pos-card') : null,
        cardCount: cards.length,
        cols,
        pageScrollH: document.documentElement.scrollHeight,
        bodyOverflow: document.documentElement.scrollHeight - document.documentElement.clientHeight
      };
    });
    console.log(`\n════ 摊主收银 ${vp.tag} ════`);
    note(`工具栏 y ${m.toolbar.top}..${m.toolbar.bottom}  分类行 y ${m.chipRow.top}..${m.chipRow.bottom}（高 ${m.chipRow.h}，胶囊 ${m.chipH}）`);
    note(`备份提醒条：${m.nudge ? `高 ${m.nudge.h}，y ${m.nudge.top}..${m.nudge.bottom}` : '未出现'}`);
    note(`网格 y ${m.grid.top}..${m.grid.bottom}（高 ${m.grid.h}）  padding-top ${m.gridPadTop}  scrollTop ${m.gridScrollTop}  溢出 ${m.gridOverflowY}`);
    note(`首个卡片 y ${m.first.top}..${m.first.bottom}（高 ${m.first.h}）  列数 ${m.cols}  卡片数 ${m.cardCount}`);
    note(`页面溢出 ${m.bodyOverflow}px`);
    check(`${vp.tag}：分类胶囊没有被压扁`, (m.chipH ?? 0) >= 38, `${m.chipH}px`);
    check(`${vp.tag}：分类行高度容得下胶囊`, m.chipRow.h >= (m.chipH ?? 0), `${m.chipRow.h} ≥ ${m.chipH}`);
    check(`${vp.tag}：首个卡片顶部不高于网格顶边`, m.first.top >= m.grid.top - 1, `${m.first.top} ≥ ${m.grid.top}`);
    check(`${vp.tag}：页面无溢出`, m.bodyOverflow <= 0, `${m.bodyOverflow}px`);
    await shot(page, `06-摊主收银-${vp.tag}`);
  }

  /* ------------------------------------------------ 分类管理（新增 / 删除） */
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.click('.sidebar a[href="/staff/products"]');
  await page.waitForTimeout(1200);
  const catEntry = page.getByRole('button', { name: /分类管理|管理分类/ });
  check('商品页有「分类管理」入口', (await catEntry.count()) > 0);
  if (await catEntry.count()) {
    await catEntry.first().click();
    await page.waitForTimeout(800);
    await shot(page, '07-分类管理');
    const catModal = page.locator('.modal');
    // 分类名是 <input defaultValue>，text= 选择器认不出来，只能读 value
    const catNames = () =>
      catModal
        .locator('tbody input[aria-label^="分类名称"]')
        .evaluateAll((els) => els.map((e) => e.value));
    const before = await catNames();
    note(`分类管理初始列表（${before.length} 个）：${before.join('、')}`);
    check('分类管理列出已有分类', before.length >= 8, `${before.length} 个`);

    // 还有商品在用的分类，「删除」应当置灰并写明原因
    const usedIdx = before.indexOf('新刊');
    if (usedIdx >= 0) {
      const del = catModal.locator('tbody tr').nth(usedIdx).getByRole('button', { name: '删除' });
      const disabled = await del.isDisabled();
      const tip = await del.getAttribute('title');
      check('分类下还有商品时删除按钮置灰并说明原因', disabled && /先改到别的分类/.test(tip ?? ''), tip ?? '');
    }

    await catModal.locator('input[aria-label="新分类名称"]').fill('新分类R10');
    await catModal.getByRole('button', { name: '新增分类' }).click();
    await page.waitForTimeout(1400);
    const after = await catNames();
    const added = after.includes('新分类R10');
    check('可以新增分类', added, after.join('、'));
    await shot(page, '08-分类管理-新增后');

    if (added) {
      const idx = after.indexOf('新分类R10');
      await catModal.locator('tbody tr').nth(idx).getByRole('button', { name: '删除' }).click();
      await page.waitForTimeout(1400);
      const last = await catNames();
      check('可以删除分类', !last.includes('新分类R10'), last.join('、'));
      await shot(page, '09-分类管理-删除后');
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.waitForTimeout(400);
  }

  console.log('\n控制台错误：' + (consoleErrors.length ? consoleErrors.join(' | ') : '（无）'));
  check('控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  await browser.close();
} catch (e) {
  console.error('出错：', e.message);
  if (browser) await browser.close();
} finally {
  vite.kill('SIGTERM');
}

const bad = results.filter((x) => !x).length;
console.log(`\n合计 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
console.log('截图目录：' + OUT);
if (bad) process.exitCode = 1;
