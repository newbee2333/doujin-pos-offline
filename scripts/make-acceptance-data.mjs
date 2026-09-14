/**
 * 一键生成"像真的"验收数据，并导出成可导入的 SQLite 文件。
 *
 * 为什么需要它：真机验收（docs/M7-acceptance-checklist.md）拿空库测没意义——
 * 性能、导入导出、内存都要靠真实体量的数据才成立。手工录 30 件商品 + 封面上图
 * 至少半小时，这个脚本两分钟跑完。
 *
 * 做法：用真实浏览器驱动应用自己的界面来造数据，最后调用应用自己的导出。
 * 好处是**产物一定与当前 schema 一致**——直接拼 SQLite 文件会随 schema 漂移而失效。
 *
 * 用法：
 *   node scripts/make-acceptance-data.mjs                    # 默认 30 件商品
 *   node scripts/make-acceptance-data.mjs --products 60      # 60 件
 *   node scripts/make-acceptance-data.mjs --out ./验收数据.sqlite3
 *   SMOKE_BASE=http://127.0.0.1:5173/ node scripts/...        # 指向 dev server
 */
import { chromium } from 'playwright';
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const BASE = process.env.SMOKE_BASE ?? 'https://doujin-pos-offline.pages.dev/';
const COUNT = Number(argOf('products', '30'));
const OUT = resolve(argOf('out', './验收数据.sqlite3'));
const CHANNEL = process.env.SMOKE_CHANNEL ?? 'msedge';

/* ---------------------------------------------------------- 造封面图
   不引任何依赖：手写一个最小 PNG 编码器（纯色 + 一条斜带），
   够用来区分不同商品，也够触发应用的图片压缩与存储路径。 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
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
      // 三条不同位置的浅色斜带，让每张封面彼此可辨
      const inBand =
        (band === 0 && y > h * 0.15 && y < h * 0.45 && x > w * 0.15) ||
        (band === 1 && x > w * 0.2 && x < w * 0.8 && y > h * 0.5) ||
        (band === 2 && Math.abs(x - y * 0.5) < w * 0.12);
      const mix = inBand ? 24 : 0;
      raw[p] = Math.max(0, r - mix);
      raw[p + 1] = Math.max(0, g - mix);
      raw[p + 2] = Math.max(0, b - mix);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------------------------------------------------- 驱动的界面动作 */
const NAMES = ['图文本', '短篇漫画集', '亚克力挂件', '双闪徽章', '色纸', '明信片', '方卡套组', '摊位套装'];
const CIRCLES = ['星屑社', '海风社', '夜航社', '拾光社', '柚木社'];
const PRICES = ['25.00', '35.00', '45.00', '52.00', '68.00', '88.00', '120.00'];

const browser = await chromium.launch({ ...(CHANNEL ? { channel: CHANNEL } : {}), args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
ctx.on('dialog', (d) => d.accept());
/* 应用在支持 Web Share 的浏览器上走「系统分享」而不是下载（代码里有 navigator.canShare 判断），
   自动化里拿不到分享的文件。这里显式关掉分享通道，逼它走下载分支。 */
await ctx.addInitScript(() => {
  // ① 关闭系统分享
  try { Object.defineProperty(navigator, 'canShare', { value: () => false, configurable: true }); } catch {}
  try { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); } catch {}
  // ② 关闭「另存为」原生对话框（showSaveFilePicker）。
  //    Chromium 上它存在，导出会优先走它 → 自动化点不了那个对话框，流程会一直挂着。
  //    删掉它，应用就会落到 blob 下载的兜底分支，Playwright 才能拿到文件。
  try { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); } catch {}
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 100)));

const say = (m) => console.log('  ' + m);

async function unlock() {
  const digit = page.locator('button', { hasText: /^1$/ }).first();
  try {
    await digit.waitFor({ state: 'visible', timeout: 6000 });
  } catch {
    return false; // 已经解锁
  }
  for (const d of ['1', '2', '3', '4']) {
    await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
  }
  await page.getByRole('button', { name: '确认' }).first().click();
  await page.waitForTimeout(1200);
  return true;
}

async function go(path) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  await unlock();
}

try {
  say(`目标环境：${BASE}`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /准备本地数据库|Doujin POS/.test(document.body.innerText || ''), null, {
    polling: 500,
    timeout: 60000
  });
  const create = page.getByRole('button', { name: '建立新的空数据库' });
  if (await create.count()) {
    await create.click();
    await page.waitForTimeout(1800);
    say('已建立空数据库');
  }
  await unlock();

  // 展会
  await go('staff/events');
  await page.getByRole('button', { name: '新建展会' }).click();
  await page.locator('.modal input').first().fill('验收数据展');
  const dates = page.locator('.modal input[type="date"]');
  if (await dates.count()) {
    await dates.nth(0).fill('2026-09-20');
    await dates.nth(1).fill('2026-09-21');
  }
  await page.locator('.modal').getByRole('button', { name: '创建' }).click();
  await page.waitForTimeout(1400);
  say('展会已建（2026-09-20 ~ 09-21）');

  // 商品（含封面）
  for (let i = 0; i < COUNT; i += 1) {
    await go('staff/products');
    await page.getByRole('button', { name: '新增商品' }).click();
    await page.waitForTimeout(400);
    const name = `${CIRCLES[i % CIRCLES.length]}·${NAMES[i % NAMES.length]} ${String(i + 1).padStart(2, '0')}`;
    await page.locator('.modal input').first().fill(name);
    const inputs = page.locator('.modal input');
    // 默认价格：找 placeholder 为 0.00 的那个
    const priceInput = page.locator('.modal input[placeholder="0.00"]').first();
    if (await priceInput.count()) await priceInput.fill(PRICES[i % PRICES.length]);
    // 封面：隐藏的 file input，setInputFiles 不受 display:none 影响
    const fileInput = page.locator('.modal input[type="file"]').first();
    if (await fileInput.count()) {
      await fileInput.setInputFiles({
        name: `cover-${i + 1}.png`,
        mimeType: 'image/png',
        buffer: makeCover(i)
      });
      await page.waitForTimeout(900); // 等压缩落库
    }
    await page.locator('.modal').getByRole('button', { name: '创建' }).click();
    await page.waitForTimeout(700);
    if ((i + 1) % 10 === 0 || i === COUNT - 1) say(`已建商品 ${i + 1}/${COUNT}`);
    void inputs;
  }

  // 全部加入本场 + 设价格与库存
  await go('staff/events');
  const addAll = page.getByRole('button', { name: '全部加入本场', exact: true });
  if (await addAll.count()) {
    await addAll.click();
    await page.waitForTimeout(2500);
  }
  const rows = page.locator('table tbody tr');
  const n = await rows.count();
  for (let i = 0; i < n; i += 1) {
    const r = rows.nth(i);
    const price = r.locator('input[type="text"]').first();
    if (await price.count()) {
      await price.fill(PRICES[i % PRICES.length]);
      await price.blur();
      await page.waitForTimeout(300);
    }
    const stock = r.locator('input[type="number"]').first();
    if (await stock.count()) {
      await stock.fill(String(6 + ((i * 7) % 40)));
      await stock.blur();
      await page.waitForTimeout(400);
    }
  }
  say(`本场配置完成：${n} 行（价格 + 初始库存）`);

  // 导出
  await go('staff/backup');
  const dl = page.waitForEvent('download', { timeout: 180000 });
  await page.getByRole('button', { name: '导出 SQLite' }).first().click();
  const download = await dl;
  mkdirSync(dirname(OUT), { recursive: true });
  const tmp = await download.path();
  const { readFileSync } = await import('node:fs');
  writeFileSync(OUT, readFileSync(tmp));
  const size = (readFileSync(OUT).length / 1024 / 1024).toFixed(2);
  say(`已导出：${OUT}（${size} MB）`);

  if (errors.length) say('控制台错误：' + errors.join(' | '));
  say('完成。把这个文件导入到 iPad 上即可开始验收。');
} catch (e) {
  say('失败：' + e.message.slice(0, 200));
  process.exitCode = 1;
} finally {
  await browser.close();
}
