/**
 * 回归防线：整库「导出 → 全新环境导入 → 重开」后数据必须还在。
 *
 * 背景（2026-09-14 审计问题 1）：commitImport 只写了数据库里的 db.active_slot，
 * 而启动读的是 localStorage 的启动指针。两者不是同一记录，
 * 于是导入后当次会话正常、重开却回到旧库，表现为"导入成功、重启数据消失"。
 *
 * 本脚本走真实 UI：源环境导出 → 全新 context 导入并确认替换 →
 * 断言重开后导入的展会仍在（导入后的会话状态也应被重置）。
 */
import { chromium } from 'playwright';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5178/';
const CHANNEL = process.env.SMOKE_CHANNEL ?? 'msedge';
const EVENT_NAME = '导入验证展';
const steps = [];
const ok = (n, d = '') => steps.push(`OK   ${n}${d ? ' — ' + d : ''}`);
const fail = (n, d) => steps.push(`FAIL ${n} — ${d}`);

const browser = await chromium.launch({
  ...(CHANNEL ? { channel: CHANNEL } : {}),
  args: ['--no-sandbox']
});

async function newCtx() {
  const c = await browser.newContext();
  c.on('dialog', (d) => d.accept());
  // 强制走 blob 下载回退，便于在无头环境捕获导出文件
  await c.addInitScript(() => {
    delete window.showSaveFilePicker;
    try {
      Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    } catch {
      /* 忽略 */
    }
  });
  return c;
}

async function waitReady(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => /准备本地数据库|当前环境不能营业|Doujin POS/.test(document.body.innerText || ''),
    null,
    { polling: 500, timeout: 45000 }
  );
}

async function bootFresh(page) {
  await waitReady(page);
  const create = page.getByRole('button', { name: '建立新的空数据库' });
  if (await create.count()) {
    await create.click();
    await page.waitForTimeout(1500);
  }
}

/**
 * 进后台。整页跳转会重置内存会话，所以要处理 PIN（设置或输入，都是一次）。
 * 页面状态存在竞态，所以等键盘真正出现再输，不按时间点数文本。
 */
async function gotoStaff(page, path) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const digit = page.locator('button', { hasText: /^1$/ }).first();
  try {
    await digit.waitFor({ state: 'visible', timeout: 12000 });
  } catch {
    return; // 没有 PIN 界面（已解锁）
  }
  // 设置与解锁都是一次 PIN（StaffGuard 里 onSubmit 直接 setPin/verifyPin 并解锁）
  for (const d of ['1', '2', '3', '4']) {
    await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click({ timeout: 8000 });
  }
  await page.getByRole('button', { name: '确认' }).first().click({ timeout: 8000 });
  await page.waitForTimeout(1500);
}

try {
  const tmp = await mkdtemp(join(tmpdir(), 'doujin-export-'));
  const bodyText = (page) => page.locator('body').innerText();

  // ── 源环境：建库 → 建展会 → 导出
  const ctxA = await newCtx();
  const pageA = await ctxA.newPage();
  await bootFresh(pageA);
  await gotoStaff(pageA, 'staff/events');
  await pageA.getByRole('button', { name: '新建展会' }).click();
  await pageA.locator('.modal input').first().fill(EVENT_NAME);
  await pageA.locator('.modal').getByRole('button', { name: '创建' }).click();
  await pageA.waitForTimeout(1200);
  ok('源环境建库并创建展会');

  await gotoStaff(pageA, 'staff/backup');
  const [download] = await Promise.all([
    pageA.waitForEvent('download', { timeout: 30000 }).catch(() => null),
    pageA.getByRole('button', { name: /导出 SQLite/ }).first().click()
  ]);

  let exportedPath = null;
  if (download) {
    exportedPath = join(tmp, download.suggestedFilename() || 'export.sqlite3');
    await download.saveAs(exportedPath);
    const st = await stat(exportedPath);
    ok('导出备份', `${(st.size / 1024).toFixed(0)} KB`);
  } else {
    fail('导出备份', '未捕获到下载事件');
  }

  if (exportedPath) {
    // ── 目标环境：全新 context 导入并确认替换
    const ctxB = await newCtx();
    const pageB = await ctxB.newPage();
    await waitReady(pageB);

    await pageB.locator('input[type="file"]').first().setInputFiles(exportedPath);
    await pageB.waitForTimeout(3000);
    const confirm = pageB.getByRole('button', { name: '确认替换', exact: true });
    if (!(await confirm.count())) {
      fail('导入', '没有出现「确认替换」按钮（暂存校验可能失败）');
    } else {
      await confirm.click();
      await pageB.waitForTimeout(2000);
      ok('导入并确认替换');

      await gotoStaff(pageB, 'staff/events');
      const afterImport = await bodyText(pageB);
      if (afterImport.includes(EVENT_NAME)) ok('导入后当次会话可见导入的展会');
      else fail('导入后当次会话', `看不到「${EVENT_NAME}」`);

      // 关键断言：重开后导入的数据必须还在（启动指针已跟随切槽）
      await gotoStaff(pageB, 'staff/events');
      const afterReload = await bodyText(pageB);
      if (afterReload.includes(EVENT_NAME)) {
        ok('重开后导入的数据仍在', '启动指针跟随切槽');
      } else {
        fail(
          '重开后导入的数据仍在',
          '重开回到旧库——启动指针没跟随切槽。正文片段：' +
            afterReload.replace(/\s+/g, ' ').slice(0, 160)
        );
      }
    }
    await ctxB.close();
  }

  await ctxA.close();
} catch (e) {
  fail('执行异常', e.message);
}

console.log(steps.join('\n'));
await browser.close();
process.exit(steps.some((s) => s.startsWith('FAIL')) ? 1 : 0);
