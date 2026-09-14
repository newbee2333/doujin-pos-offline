/**
 * 回归防线：导入的文件缺少应用必需表时必须被拒绝。
 *
 * 背景（2026-09-14 审计问题 3）：导入校验里的业务检查一旦 SQL 出错就 catch 后跳过，
 * 理由是"旧 schema 可能没有对应表"。但迁移已经跑过，此时缺表说明文件结构不完整——
 * 结果是一个删掉 inventory_transactions 的文件也被 accepted=true 接受并切为活动库，
 * 之后查库存流水直接报 no such table。
 *
 * 本脚本用真实 Worker / OPFS 路径复现：删表 → 导出 → importStage → 必须被拒。
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5178/';
const CHANNEL = process.env.SMOKE_CHANNEL ?? 'msedge';
const steps = [];
const ok = (n, d = '') => steps.push(`OK   ${n}${d ? ' — ' + d : ''}`);
const fail = (n, d) => steps.push(`FAIL ${n} — ${d}`);

const browser = await chromium.launch({
  ...(CHANNEL ? { channel: CHANNEL } : {}),
  args: ['--no-sandbox']
});
const context = await browser.newContext();
context.on('dialog', (d) => d.accept());
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  // 等应用进入 ready（显式轮询，headless 下 raf 轮询不可靠）
  await page.waitForFunction(() => /准备本地数据库|Doujin POS/.test(document.body.innerText || ''), null, {
    polling: 500,
    timeout: 45000
  });
  const create = page.getByRole('button', { name: '建立新的空数据库' });
  if (await create.count()) {
    await create.click();
    await page.waitForTimeout(1500);
  }

  const result = await page.evaluate(async () => {
    const { db } = await import('/src/db/client.ts');
    await db.init('a');
    // 人工构造异常文件：删掉一张应用必需的表
    await db.read('DROP TABLE inventory_transactions');
    const { bytes } = await db.exportDb();
    let accepted = false;
    let stageError = null;
    try {
      await db.importStage(bytes);
      accepted = true;
    } catch (e) {
      stageError = e instanceof Error ? e.message : String(e);
    }
    return { accepted, stageError };
  });

  if (result.accepted) {
    fail('缺表文件必须被拒绝导入', '实际 accepted=true');
  } else if (result.stageError && /必需的表/.test(result.stageError)) {
    ok('缺表文件被拒绝', result.stageError.slice(0, 80));
  } else {
    fail('缺表文件被拒绝但原因不是缺表检查', String(result.stageError).slice(0, 120));
  }

  if (errors.length) fail('控制台错误', errors.join(' | ').slice(0, 150));
} catch (e) {
  fail('执行异常', e.message);
}

console.log(steps.join('\n'));
await browser.close();
process.exit(steps.some((s) => s.startsWith('FAIL')) ? 1 : 0);
