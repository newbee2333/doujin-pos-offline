/**
 * 验证整库「导出 → 全新环境导入」在浏览器里的真实路径。
 *
 * 背景：iOS Safari 按系统 UTI 过滤 file input 的 accept，
 * .sqlite3 / .db / application/x-sqlite3 都没有对应 UTI，文件会被置灰选不中。
 * 所以这里做两件事：
 *   1. 断言导入用的文件输入上没有 accept 属性（回归防线，防止有人再加回去）
 *   2. 走通「导出 → 全新环境导入 → 数据核对」
 *
 * 注意：Playwright 的 setInputFiles 不校验 accept，所以第 1 条是必需的。
 */
import { chromium } from 'playwright';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5178/';
const steps = [];
const ok = (n, d = '') => steps.push(`OK   ${n}${d ? ' — ' + d : ''}`);
const fail = (n, d) => steps.push(`FAIL ${n} — ${d}`);

const browser = await chromium.launch({ channel: 'msedge', args: ['--no-sandbox'] });

function newCtx() {
  const ctx = browser.newContext();
  return ctx.then(async (c) => {
    c.on('dialog', (d) => d.accept());
    // 强制导出走 blob 下载回退，便于在无头环境捕获文件
    await c.addInitScript(() => {
      delete window.showSaveFilePicker;
      try {
        Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
      } catch {}
    });
    return c;
  });
}

async function boot(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => /准备本地数据库|当前环境不能营业|Doujin POS/.test(document.body.innerText || ''),
    { timeout: 45000 }
  );
  const create = page.getByRole('button', { name: '建立新的空数据库' });
  if (await create.count()) {
    await create.click();
    await page.waitForTimeout(700);
  }
}

/** 整页跳转会重置内存会话，每次进后台都要处理 PIN（首次是「设置」、之后是「请输入」）。 */
async function gotoStaff(page, path) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const needs = (await page.getByText('设置后台 PIN').count()) || (await page.getByText('请输入后台 PIN').count());
  if (needs) {
    for (const d of ['1', '2', '3', '4']) {
      await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
    }
    await page.getByRole('button', { name: '确认' }).first().click();
    await page.waitForTimeout(800);
  }
}

try {
  const tmp = await mkdtemp(join(tmpdir(), 'doujin-export-'));
  let exportedPath = null;

  // ── 源环境：建库 → 建展会 → 导出
  const ctxA = await newCtx();
  const pageA = await ctxA.newPage();
  await boot(pageA);
  await gotoStaff(pageA, 'staff/events');
  await pageA.getByRole('button', { name: '新建展会' }).click();
  await pageA.locator('.modal input').first().fill('导入验证展');
  await pageA.locator('.modal').getByRole('button', { name: '创建' }).click();
  await pageA.waitForTimeout(900);
  ok('源环境建库并创建展会');

  await gotoStaff(pageA, 'staff/backup');

  // 先点开恢复面板，才能看到导入用的 file input
  await pageA.getByRole('button', { name: /选择 SQLite 文件恢复/ }).click();
  await pageA.waitForTimeout(600);
  const inputs = await pageA.evaluate(() =>
    Array.from(document.querySelectorAll('input[type="file"]')).map((i) => ({
      accept: i.getAttribute('accept'),
      hasAccept: i.hasAttribute('accept')
    }))
  );
  const withAccept = inputs.filter((i) => i.hasAccept);
  if (!inputs.length) fail('accept 检查', '恢复面板里没有找到 file input');
  else if (withAccept.length) fail('accept 属性仍存在', JSON.stringify(withAccept));
  else ok('导入用的 file input 没有 accept 属性', `共 ${inputs.length} 个`);

  // 注意：点开恢复面板会替换整页内容，导出前要重新进入备份页
  await gotoStaff(pageA, 'staff/backup');

  const [download] = await Promise.all([
    pageA.waitForEvent('download', { timeout: 25000 }).catch(() => null),
    pageA.getByRole('button', { name: /导出 SQLite/ }).first().click()
  ]);
  if (download) {
    exportedPath = join(tmp, download.suggestedFilename() || 'export.sqlite3');
    await download.saveAs(exportedPath);
    const st = await stat(exportedPath);
    ok('导出文件', `${exportedPath.split(/[/\\]/).pop()} · ${(st.size / 1024).toFixed(0)} KB`);
  } else {
    fail('导出', '未捕获到下载事件');
  }

  // ── 目标环境：全新 context 导入
  if (exportedPath) {
    const ctxB = await newCtx();
    const pageB = await ctxB.newPage();
    await pageB.goto(BASE, { waitUntil: 'networkidle' });
    await pageB.waitForFunction(
      () => /准备本地数据库|当前环境不能营业|Doujin POS/.test(document.body.innerText || ''),
      { timeout: 45000 }
    );
    // 首次启动页上就是导入入口
    await pageB.locator('input[type="file"]').first().setInputFiles(exportedPath);
    await pageB.waitForTimeout(2600);
    const textB = await pageB.evaluate(() => document.body.innerText);
    if (textB.includes('导入验证展')) ok('全新环境导入成功，展会数据已恢复');
    else if (/这不是 Doujin POS|校验未通过|更高版本/.test(textB)) fail('导入被拒绝', textB.slice(0, 200));
    else fail('导入结果不明确', textB.replace(/\n+/g, ' | ').slice(0, 260));
    await ctxB.close();
  }

  await ctxA.close();
} catch (e) {
  fail('执行异常', e.message);
}

console.log(steps.join('\n'));
await browser.close();
process.exit(steps.some((s) => s.startsWith('FAIL')) ? 1 : 0);
