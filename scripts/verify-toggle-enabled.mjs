/**
 * 参展商品「上架 / 下架」取证与回归。
 *
 * 用户报告：「批量上架 / 下架，或者说上架下架功能有 bug」。
 * 本脚本把三类状态分开量，因为「数据库写了但屏幕没变」和「根本写不进去」是两种病：
 *   A. 屏幕上的勾（点击后立刻读 DOM）
 *   B. 数据库真实值（换页重进后再读）
 *   C. 游客菜单实际看到的东西（开场后数卡片）
 *
 * 覆盖：批量上架 / 批量下架 / 表头全选（含半选）/ 单行上架 /
 *       游客可见 / 精确库存 / 本分类上架下架 / 限购
 *
 * 用法：node scripts/verify-toggle-enabled.mjs
 *       SMOKE_BASE=https://doujin-pos-offline.pages.dev/ node scripts/verify-toggle-enabled.mjs
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5226;
const EXTERNAL = process.env.SMOKE_BASE ? String(process.env.SMOKE_BASE).replace(/\/$/, '') : null;
const BASE = EXTERNAL ?? `http://127.0.0.1:${PORT}`;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
fs.mkdirSync(path.join(ROOT, 'scripts', 'ui10'), { recursive: true });

const results = [];
const check = (n, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`);
};
const note = (m) => console.log('  ' + m);

/* 商品：名字 / 分类。前两件进本场，第三件用来验「本分类下架」 */
const SEED = [
  ['测试1', '新刊'],
  ['测试2', '新刊'],
  ['测试3', '亚克力']
];

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
    window.prompt = (_m, d) => d ?? 'V';
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 160));
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 160)));

  async function unlockIfNeeded() {
    for (let i = 0; i < 2; i++) {
      if (!(await page.locator('.pin-keys .pin-digit').count())) break;
      for (const k of ['1', '2', '3', '4']) await page.click(`.pin-keys .pin-digit:text-is("${k}")`);
      await page.click('.pin-actions button.primary');
      await page.waitForTimeout(800);
    }
  }
  async function gotoEvents(expectRows = true) {
    await page.goto(`${BASE}/staff/events`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await unlockIfNeeded();
    if (expectRows) {
      await page.waitForSelector('table tbody tr', { timeout: 30000 });
      await page.waitForTimeout(700);
    } else {
      await page.waitForTimeout(700);
    }
  }
  /** 读参展商品表：每行的商品名 + 各开关 + 「库存 · 已售」格文本。
      按 aria-label 后缀找控件，不按列序号 —— 列增减过一次（「可用」并入「库存 · 已售」），
      写死序号的话每次改表都要回来改脚本。 */
  async function readRows() {
    return page.evaluate(() => {
      const rows = [...document.querySelectorAll('table tbody tr')];
      return rows
        .map((r) => {
          const tds = [...r.querySelectorAll('td')];
          const nameEl = tds[1]?.querySelector('.cell-name');
          const name = nameEl
            ? nameEl.innerText.trim()
            : ((tds[1]?.querySelector('.cell-body span')?.innerText ?? '').split('\n')[0] ?? '').trim();
          const byLabel = (suffix) => {
            const el = [...r.querySelectorAll('input[aria-label]')].find((x) =>
              (x.getAttribute('aria-label') || '').endsWith(suffix)
            );
            return el ?? null;
          };
          const stockCell = r.querySelector('.stock-cell');
          const limit = byLabel(' 限购');
          return {
            name,
            visible: byLabel(' 游客可见')?.checked ?? null,
            exact: byLabel(' 精确库存')?.checked ?? null,
            enabled: byLabel(' 上架')?.checked ?? null,
            limit: limit ? limit.value : null,
            selected: tds[0]?.querySelector('input[type="checkbox"]')?.checked ?? null,
            stock: stockCell ? stockCell.innerText.replace(/\s+/g, ' ').trim() : null
          };
        })
        .filter((r) => r.name);
    });
  }
  async function headBox() {
    return page.evaluate(() => {
      const h = document.querySelector('table thead input[type="checkbox"]');
      return { checked: h.checked, indeterminate: h.indeterminate };
    });
  }
  const rowByName = async (name) => (await readRows()).find((r) => r.name === name);
  const rowLoc = (name) => page.locator('table tbody tr').filter({ hasText: name }).first();
  const box = (name, suffix) => rowLoc(name).locator(`input[aria-label="${name} ${suffix}"]`);

  /* ---------------------------------------------- 种数据 */
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  const setup = page.locator('button:text-is("建立新的空数据库")');
  if (await setup.count()) {
    await setup.first().click();
    await page.waitForTimeout(2400);
  }
  await gotoEvents(false);
  if (await page.getByRole('button', { name: '新建展会' }).count()) {
    await page.getByRole('button', { name: '新建展会' }).click();
    await page.locator('.modal input').first().fill('上下架验收');
    await page.locator('.modal').getByRole('button', { name: '创建' }).click();
    await page.waitForTimeout(1400);
  }
  for (const [n, cat] of SEED) {
    await page.click('.sidebar a[href="/staff/products"]');
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: '新增商品' }).click();
    await page.waitForTimeout(400);
    const modal = page.locator('.modal');
    await modal.locator('input').first().fill(n);
    await modal.locator('select').first().selectOption({ label: cat });
    await modal.locator('input[placeholder="0.00"]').first().fill('20.00');
    await modal.getByRole('button', { name: '创建' }).click();
    await page.waitForTimeout(700);
  }
  await gotoEvents();
  await page.getByRole('button', { name: '全部加入本场', exact: true }).click();
  await page.waitForTimeout(1500);
  for (const [n] of SEED) {
    const si = rowLoc(n).locator('input[type="number"]').first();
    if (await si.count()) {
      await si.fill('10');
      await si.blur();
      await page.waitForTimeout(320);
    }
  }
  note(`已建 ${SEED.length} 件商品并全部加入本场（初始库存 10）`);

  /* ============================================ A. 批量下架 → 表头 / 屏幕 / 数据库 */
  const base = await readRows();
  note('基线上架列：' + base.map((r) => `${r.name}=${r.enabled}`).join(' | '));
  check('初始所有行都是「上架」', base.length > 0 && base.every((r) => r.enabled === true), `${base.filter((r) => r.enabled).length}/${base.length}`);

  await page.locator('table thead input[type="checkbox"]').check();
  await page.waitForTimeout(400);
  const headFull = await headBox();
  note(`全选后表头：checked=${headFull.checked} indeterminate=${headFull.indeterminate}`);
  check('表头全选后所有行都被勾上（选择列）', (await readRows()).every((r) => r.selected === true));

  // 取消一行 → 表头应变成半选；这是「批量操作到底作用于哪些行」的可信前提
  await rowLoc('测试2').locator('td').first().locator('input[type="checkbox"]').uncheck();
  await page.waitForTimeout(400);
  const headPartial = await headBox();
  note(`取消「测试2」后表头：checked=${headPartial.checked} indeterminate=${headPartial.indeterminate}`);
  check(
    '取消部分行后表头变「半选」（原来只会死板地停在已勾选）',
    headPartial.indeterminate === true && headPartial.checked === false,
    `checked=${headPartial.checked} indeterminate=${headPartial.indeterminate}`
  );

  // 重新全选再批量下架
  await page.locator('table thead input[type="checkbox"]').check();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '批量下架' }).click();
  await page.waitForTimeout(1600);
  const afterOff = await readRows();
  note('批量下架后（未刷新）上架列：' + afterOff.map((r) => `${r.name}=${r.enabled}`).join(' | '));
  await page.screenshot({ path: path.join(ROOT, 'scripts', 'ui10', 'bulk-off.png') });
  check('批量下架：屏幕立刻更新', afterOff.every((r) => r.enabled === false), `${afterOff.filter((r) => r.enabled).length} 行仍显示上架`);

  await gotoEvents();
  const truthOff = await readRows();
  note('重进页面（=数据库真实值）上架列：' + truthOff.map((r) => `${r.name}=${r.enabled}`).join(' | '));
  check('批量下架：确实写进数据库', truthOff.every((r) => r.enabled === false), `${truthOff.filter((r) => r.enabled).length} 行仍是上架`);

  /* ============================================ B. 批量上架 */
  await page.locator('table thead input[type="checkbox"]').check();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '批量上架' }).click();
  await page.waitForTimeout(1600);
  check('批量上架：屏幕立刻更新', (await readRows()).every((r) => r.enabled === true));
  await gotoEvents();
  check('批量上架：确实写进数据库', (await readRows()).every((r) => r.enabled === true));

  /* ============================================ C. 单行上架 / 游客可见 / 精确库存 / 限购 */
  const before = await rowByName('测试1');
  await box('测试1', '上架').setChecked(false);
  await page.waitForTimeout(1200);
  await gotoEvents();
  const afterSingle = await rowByName('测试1');
  check('单行「上架」能落盘', afterSingle.enabled === false, `→ ${afterSingle.enabled}`);
  await box('测试1', '上架').setChecked(before.enabled);
  await page.waitForTimeout(1200);

  await box('测试1', '游客可见').setChecked(false);
  await page.waitForTimeout(1200);
  await gotoEvents();
  const visAfter = await rowByName('测试1');
  check('「游客可见」能落盘', visAfter.visible === false, `→ ${visAfter.visible}`);
  await box('测试1', '游客可见').setChecked(true);
  await page.waitForTimeout(1200);

  await box('测试1', '精确库存').setChecked(true);
  await page.waitForTimeout(1200);
  await gotoEvents();
  const exactAfter = await rowByName('测试1');
  check('「精确库存」能落盘', exactAfter.exact === true, `→ ${exactAfter.exact}`);

  const limitInput = box('测试1', '限购');
  await limitInput.fill('2');
  await limitInput.blur();
  await page.waitForTimeout(1200);
  await gotoEvents();
  check('「限购」能落盘', (await rowByName('测试1')).limit === '2', `→ ${(await rowByName('测试1')).limit}`);

  /* ============================================ D. 本分类下架 */
  // 「全部分类」那个下拉：页头还有一个「选择展会」的下拉，不能按 first 取
  const catSelect = page.locator('select').filter({ has: page.locator('option:text-is("全部分类")') });
  await catSelect.first().selectOption({ label: '亚克力' });
  await page.waitForTimeout(700);
  const catBtn = page.getByRole('button', { name: '本分类下架' });
  check('按分类筛选后出现「本分类下架」', (await catBtn.count()) > 0);
  if (await catBtn.count()) {
    await catBtn.click();
    await page.waitForTimeout(1600);
    const catOff = await readRows();
    note('本分类下架后（未刷新）：' + catOff.map((r) => `${r.name}=${r.enabled}`).join(' | '));
    check(
      '「本分类下架」屏幕立刻更新（只有亚克力那件变 false）',
      catOff.find((r) => r.name === '测试3')?.enabled === false,
      JSON.stringify(catOff.map((r) => [r.name, r.enabled]))
    );
    await gotoEvents();
    const catTruth = await readRows();
    check(
      '「本分类下架」确实写进数据库',
      catTruth.find((r) => r.name === '测试3')?.enabled === false,
      JSON.stringify(catTruth.map((r) => [r.name, r.enabled]))
    );
    await catSelect.first().selectOption({ label: '亚克力' });
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: '本分类上架' }).click();
    await page.waitForTimeout(1600);
    await gotoEvents();
    check('「本分类上架」确实写进数据库', (await rowByName('测试3'))?.enabled === true);
  }

  /* ============================================ E. 下架后游客菜单里确实看不到 */
  {
    const payCard = page.locator('.card').filter({ hasText: '支付方式' }).first();
    const cashRow = payCard.locator('.row').filter({ hasText: '现金' }).first();
    if (await cashRow.count()) {
      for (const cb of await cashRow.locator('input[type="checkbox"]').all()) {
        if (!(await cb.isChecked())) await cb.check();
      }
      await page.waitForTimeout(900);
    }
    await page.getByRole('button', { name: '开场', exact: true }).click();
    await page.waitForTimeout(1600);
    const badge = await page.locator('.badge').first().innerText();
    check('展会已开场（否则游客菜单是空的，下一条测不了）', /进行中/.test(badge), badge.replace(/\s+/g, ' '));

    await page.goto(`${BASE}/kiosk`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);
    const before1 = await page.locator('.menu-card-cover').count();
    note(`开场后游客菜单卡片数：${before1}`);

    await gotoEvents();
    await box('测试1', '上架').setChecked(false);
    await page.waitForTimeout(1400);
    await page.goto(`${BASE}/kiosk`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);
    const after1 = await page.locator('.menu-card-cover').count();
    note(`把「测试1」下架后游客菜单卡片数：${after1}`);
    check('下架后游客菜单里确实少了一件', after1 === before1 - 1, `${before1} → ${after1}`);
  }

  /* ============================================ F. 卖出两件后「已售」要跟着动 */
  {
    // 上一段把「测试1」下架了，先放回来
    await gotoEvents();
    await box('测试1', '上架').setChecked(true);
    await page.waitForTimeout(1400);

    const beforeCell = (await rowByName('测试1'))?.stock ?? '';
    note(`收款前库存格：${beforeCell}`);

    await page.goto(`${BASE}/staff/checkout`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await unlockIfNeeded();
    await page.waitForSelector('.pos-card', { timeout: 30000 });
    const card = page.locator('.pos-card').filter({ hasText: '测试1' }).first();
    // 点封面加购：加过一件之后「+」会换成「×N」徽章，第二次点必须走封面
    await card.locator('.pos-cover').click();
    await page.waitForTimeout(500);
    await card.locator('.pos-cover').click();
    await page.waitForTimeout(500);
    const cashSeg = page.locator('.seg-item').filter({ hasText: '现金' }).first();
    if (await cashSeg.count()) await cashSeg.click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /确认收款/ }).click();
    await page.waitForTimeout(2000);
    note('摊主收银已成交 2 件');

    await gotoEvents();
    const afterCell = (await rowByName('测试1'))?.stock ?? '';
    note(`收款后库存格：${afterCell}`);
    check('「已售」跟着成交变化（2 件）', /已售\s*2/.test(afterCell), afterCell);
    check('「剩」跟着成交减少（10 → 8）', /剩\s*8/.test(afterCell), afterCell);
    check('同一格里仍然显示入场时的备货数（备 10）', /备\s*10/.test(afterCell), afterCell);
  }

  /* ============================================ G. 从本场移除（不是下架） */
  {
    await gotoEvents();
    await page.screenshot({ path: path.join(ROOT, 'scripts', 'ui10', 'remove-from-event.png') });
    const beforeNames = (await readRows()).map((r) => r.name);
    note(`移除前表里有：${beforeNames.join('、')}`);

    const target = beforeNames[beforeNames.length - 1];
    await rowLoc(target).getByRole('button', { name: '移除', exact: true }).click();
    await page.waitForTimeout(2000);
    const afterSingle = (await readRows()).map((r) => r.name);
    check('单行「移除」把这一行从参展商品表里去掉', !afterSingle.includes(target), `剩 ${afterSingle.join('、')}`);

    await gotoEvents();
    const persisted = (await readRows()).map((r) => r.name);
    check('移除是真的落库（换页重进仍然没有）', !persisted.includes(target), `剩 ${persisted.join('、')}`);

    // 移除 ≠ 删除商品：还能重新加回来，且库存流水保留
    await page.getByRole('button', { name: '全部加入本场', exact: true }).click();
    await page.waitForTimeout(2000);
    await gotoEvents();
    const readded = await readRows();
    check('被移除的规格可以重新加入本场', readded.some((r) => r.name === target), readded.map((r) => r.name).join('、'));
    const readdedStock = readded.find((r) => r.name === target)?.stock ?? '';
    note(`重新加入后的库存格：${readdedStock}`);
    check('重新加入后库存流水还在（仍然显示「备 N」而不是空输入框）', /备\s*\d+/.test(readdedStock), readdedStock);

    // 批量移除
    await page.locator('table thead input[type="checkbox"]').check();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: '批量移除本场' }).click();
    await page.waitForTimeout(2200);
    await gotoEvents();
    const left = await readRows();
    check('「批量移除本场」清空整张表', left.length === 0, `还剩 ${left.length} 行`);
    await page.screenshot({ path: path.join(ROOT, 'scripts', 'ui10', 'remove-all.png') });
  }

  console.log('\n控制台错误：' + (errors.length ? errors.join(' | ') : '（无）'));
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
