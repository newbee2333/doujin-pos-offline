/**
 * 「新建空数据库」的实机校验。server 与脚本必须在同一条 shell 命令里起。
 *   npx vite --port 5199 --strictPort --host 127.0.0.1 &
 *   SMOKE_BASE=http://127.0.0.1:5199/ node scripts/verify-new-database.mjs
 *
 * 这个脚本验证的是 Worker 里那段「在非活动槽位建一个全新库、再切过去」——
 * 单测（src/services/__tests__/new-database.test.ts）只能覆盖主线程的现状预览，
 * OPFS + sqlite-wasm 建库这段没有别的办法证明。
 *
 * 1. 从未确认保存时是危险档，且「确认新建」要两道勾选才放行
 * 2. 真的新建：换成新库、旧数据一个不留
 * 3. 新库结构完好、带着默认菜单分类与支付方式，而且能继续写
 * 4. 确认保存过之后提醒降档，并只留一道勾选
 *
 * ⚠️ 顺序有约束：第 2 节会把库换掉，所以第 1 节必须在它前面，
 * 第 3/4 节又必须在第 2 节之后（要在新库上跑）。
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.SMOKE_BASE ?? process.env.BASE ?? 'http://127.0.0.1:5199/';
const OUT = 'scripts/ui11';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 1366, height: 1024 },
  acceptDownloads: true
});

// 和 verify-import*.mjs 一样：关掉原生「另存为」与系统分享面板，
// 强制导出走 blob 下载，否则无头环境里既没有 download 事件、Promise 也永不 settle。
await ctx.addInitScript(() => {
  delete window.showSaveFilePicker;
  try {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
  } catch {
    /* 忽略 */
  }
});

const page = await ctx.newPage();
// 启动时若拿不到持久化存储权限，应用会用 window.confirm 问「是否进入受限营业」。
// Playwright 默认会 dismiss 掉未注册处理器的对话框 —— 那等于选了「取消」，
// 应用直接停在「未进入营业模式」，后面每一个按钮都找不到。必须显式 accept。
ctx.on('dialog', async (d) => {
  await d.accept();
});

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
const bodyText = () => page.evaluate(() => document.body.innerText);

async function tapPin() {
  for (const d of ['1', '2', '3', '4']) {
    await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
  }
  await page.getByRole('button', { name: '确认' }).first().click();
  await page.waitForTimeout(600);
}

async function gotoStaff(path) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const setup = await page.getByText('设置后台 PIN').count();
  const unlock = await page.getByText('请输入后台 PIN').count();
  if (!setup && !unlock) return;
  if (setup) await tapPin();
  await tapPin();
  await page.waitForTimeout(600);
}

/** 弹窗里按 label 找控件：Field 渲染成 <label class="field"><span>标签</span><控件/></label> */
const field = (label) => page.locator('.modal label.field').filter({ hasText: new RegExp(`^${label}`) });

const newDbPanel = () => page.locator('.card').filter({ hasText: '确认新建' }).last();
const newDbButton = () => page.getByRole('button', { name: '新建空数据库', exact: true });
const confirmNewButton = () => page.getByRole('button', { name: '确认新建', exact: true });

const dbStatusCard = () => page.locator('.card').filter({ hasText: '数据库状态' }).first();
/** 数据集标识是 UUID，从整张卡的文本里捞出来。 */
async function datasetIdOnBackupPage() {
  const t = await dbStatusCard().innerText();
  return (t.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) ?? [''])[0];
}
async function schemaVersionOnBackupPage() {
  const t = await dbStatusCard().innerText();
  const m = t.match(/schema 版本\s*\n?\s*(\d+)/);
  return m ? Number(m[1]) : NaN;
}

// ────────────────────────── 准备：首次启动 → 建一个有数据的库
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
if (await page.getByRole('button', { name: '建立新的空数据库' }).count()) {
  await page.getByRole('button', { name: '建立新的空数据库' }).click();
  await page.waitForTimeout(1500);
}

await gotoStaff('staff/events');
await page.getByRole('button', { name: '新建展会' }).click();
await page.locator('.modal input').first().fill('C108');
await page.locator('.modal').getByRole('button', { name: '创建' }).click();
await page.waitForTimeout(1200);

await gotoStaff('staff/products');
await page.getByRole('button', { name: '新增商品' }).click();
await page.waitForTimeout(500);
await page.locator('.modal input').first().fill('《测试本》');
await field('默认价格').locator('input').fill('30.00');
await page.locator('.modal').getByRole('button', { name: '创建' }).click();
await page.waitForTimeout(1400);

await gotoStaff('staff/backup');
const beforeDatasetId = await datasetIdOnBackupPage();
check('准备：旧库里有一个数据集标识', !!beforeDatasetId, beforeDatasetId || '（空）');

// ───────────────── 1. 从未确认保存 → 危险档，且要两道勾选
const newDbCard = page.locator('.card').filter({ hasText: '新建空数据库' }).first();
check('备份页出现「新建空数据库」卡片', (await newDbCard.count()) > 0);

const cardText = await newDbCard.innerText();
check(
  '从未确认保存时按危险档提醒',
  cardText.includes('还没有确认保存过任何备份'),
  cardText.replace(/\s+/g, ' ').slice(0, 60) + '…'
);
check(
  '并说清唯一归路是导出的文件',
  cardText.includes('能把你带回来的只有你自己导出的那份文件')
);

await newDbButton().click();
await page.waitForTimeout(600);
check('点开后出现「确认新建」面板', (await newDbPanel().count()) > 0);

const panelText = await newDbPanel().innerText();
check('面板列出即将丢下的展会数', /展会\s*1\s*场/.test(panelText), panelText.replace(/\s+/g, ' ').slice(0, 80) + '…');
check('面板说明旧库没有入口能打开', panelText.includes('别把它当备份'));

const ackSaved = newDbPanel().locator('label.check').filter({ hasText: '保存到这台设备之外' }).locator('input');
const ackLost = newDbPanel().locator('label.check').filter({ hasText: '将无法找回' }).locator('input');
check('从未备份时给出两个勾选项', (await ackSaved.count()) === 1 && (await ackLost.count()) === 1);

check('没勾选时「确认新建」不可点', await confirmNewButton().isDisabled());
await ackSaved.check();
await page.waitForTimeout(250);
check(
  '只勾「已另存」还不够（从未备份过的库要多一道）',
  await confirmNewButton().isDisabled()
);
await ackLost.check();
await page.waitForTimeout(250);
check('两道勾选齐了才放行', !(await confirmNewButton().isDisabled()));
await shot('ui11-1-new-db-guard');

// ────────────────────────────── 2. 真的新建
await confirmNewButton().click();
await page.waitForTimeout(3500);
check('新建后离开备份页回到首页', new URL(page.url()).pathname === '/', page.url());
check('页面上没有报错框', !(await bodyText()).includes('数据库操作失败'), '');

// ───────────────── 3. 新库是空的，但结构完好、模板还在
await gotoStaff('staff/products');
check('新库里找不到旧商品', !(await bodyText()).includes('《测试本》'));

await gotoStaff('staff/events');
check('新库里找不到旧展会', !(await bodyText()).includes('C108'));

await gotoStaff('staff/backup');
const afterDatasetId = await datasetIdOnBackupPage();
check('数据集标识换成了新的', !!afterDatasetId && afterDatasetId !== beforeDatasetId, afterDatasetId);
check('新库的 schema 版本正常', (await schemaVersionOnBackupPage()) === 2, `实得 ${await schemaVersionOnBackupPage()}`);

// 默认分类还在（建库时种入的模板）
await gotoStaff('staff/products');
await page.getByRole('button', { name: '新增商品' }).click();
await page.waitForTimeout(600);
const categoryOptions = await field('菜单分类').locator('select option').allInnerTexts();
check(
  '新库带着默认菜单分类',
  ['新刊', '既刊', '套装'].every((n) => categoryOptions.includes(n)),
  categoryOptions.join('/')
);
await page.locator('.modal').getByRole('button', { name: '取消' }).click().catch(() => {});
await page.waitForTimeout(400);

// 新库真的能写：建一个展会 + 一件商品 + 进场
await gotoStaff('staff/events');
await page.getByRole('button', { name: '新建展会' }).click();
await page.locator('.modal input').first().fill('C109');
await page.locator('.modal').getByRole('button', { name: '创建' }).click();
await page.waitForTimeout(1200);
check('新库里能建展会', (await bodyText()).includes('C109'));

const pmCard = page.locator('.card').filter({ hasText: '支付方式' }).first();
const pmText = await pmCard.innerText();
check(
  '新库带着默认支付方式（现金等）',
  pmText.includes('现金'),
  pmText.replace(/\s+/g, ' ').slice(0, 60) + '…'
);

await gotoStaff('staff/products');
await page.getByRole('button', { name: '新增商品' }).click();
await page.waitForTimeout(500);
await page.locator('.modal input').first().fill('《新库测试本》');
await field('默认价格').locator('input').fill('20.00');
await page.locator('.modal').getByRole('button', { name: '创建' }).click();
await page.waitForTimeout(1400);
check('新库里能建商品', (await bodyText()).includes('《新库测试本》'));

await gotoStaff('staff/events');
await page.getByRole('button', { name: '全部加入本场', exact: true }).click();
await page.waitForTimeout(1600);
check('新库里能商品进场', (await bodyText()).includes('《新库测试本》'));

// ───────────────── 4. 确认保存过之后提醒降档
await gotoStaff('staff/backup');
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 20000 }).catch(() => null),
  page.getByRole('button', { name: '导出 SQLite' }).click()
]);
check('新库里能正常导出 SQLite', !!download, download ? download.suggestedFilename() : '没触发下载');

// download 事件在 a.click() 那一刻就触发，而「我确认已保存」要等 exportDatabase
// 整个 await 链（含写 backup.last_export_at）走完才渲染出来 —— 这里必须等它出现，
// 直接 count() 会拿到 0，然后整段静默跳过。
const confirmSavedBtn = page.getByRole('button', { name: '我确认已保存' });
await confirmSavedBtn.waitFor({ timeout: 15000 }).catch(() => null);
check('导出走完后出现「我确认已保存」', (await confirmSavedBtn.count()) > 0);
await confirmSavedBtn.click();
await page.waitForTimeout(1800);

const cardText2 = await newDbCard.innerText();
const noticeText2 = (await newDbCard.locator('.notice').first().innerText()).replace(/\s+/g, ' ');
check(
  '确认保存后提醒降为普通档',
  cardText2.includes('最近一次确认保存') && !cardText2.includes('还没有确认保存过任何备份'),
  noticeText2.slice(0, 44) + '…'
);

await newDbButton().click();
await page.waitForTimeout(600);
const panel2 = newDbPanel();
check(
  '已备份过就不再要求「无法找回」那道勾选',
  (await panel2.locator('label.check').filter({ hasText: '将无法找回' }).count()) === 0
);
await panel2.locator('label.check').filter({ hasText: '保存到这台设备之外' }).locator('input').check();
await page.waitForTimeout(250);
check('勾一个就能点「确认新建」', !(await confirmNewButton().isDisabled()));
await shot('ui11-2-new-db-after-backup');

// 只验可点，不真的再建一次：上面那一节已经把新库用起来了
await page.getByRole('button', { name: '取消' }).click();
await page.waitForTimeout(400);
check('取消后面板收起', (await newDbPanel().count()) === 0);

console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
console.log('控制台错误：', errors.length ? '\n  ' + errors.join('\n  ') : '（无）');
await browser.close();
process.exitCode = fail || errors.length ? 1 : 0;
