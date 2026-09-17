/**
 * 校验本轮的 5 项 UI 调整。server 与脚本必须在同一条 shell 命令里起。
 *   npx vite --port 5199 --strictPort --host 127.0.0.1 &
 *   node scripts/verify-product-ui.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

// 别的脚本都用 SMOKE_BASE 指向线上，只有这里写的是 BASE ——
// 结果「拿同一套断言打线上」时会静默地去连本地 5199，报 ERR_CONNECTION_REFUSED。
// 两个都认，SMOKE_BASE 优先。
const BASE = process.env.SMOKE_BASE ?? process.env.BASE ?? 'http://127.0.0.1:5199/';
const OUT = 'scripts/ui4';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
ctx.on('dialog', (d) => d.accept());
const page = await ctx.newPage();
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

async function tapPin() {
  for (const d of ['1', '2', '3', '4']) {
    await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
  }
  await page.getByRole('button', { name: '确认' }).first().click();
  await page.waitForTimeout(600);
}

async function gotoStaff(path) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const setup = await page.getByText('设置后台 PIN').count();
  const unlock = await page.getByText('请输入后台 PIN').count();
  if (!setup && !unlock) return;
  if (setup) await tapPin();
  await tapPin();
  await page.waitForTimeout(600);
}

/** 弹窗里所有 label 文本 */
const modalLabels = () =>
  page.locator('.modal label.field > span').evaluateAll((els) => els.map((e) => (e.textContent || '').trim()));

const EDITOR_LABELS = [
  '名称',
  '简称',
  '分类',
  '类型',
  '原作 / 圈子',
  '标签（逗号分隔）',
  '默认价格',
  '币种',
  '说明（纯文本展示）'
];

// ─────────────────────────────────────────── 准备：库 / 展会 / 一个商品
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
if (await page.getByRole('button', { name: '建立新的空数据库' }).count()) {
  await page.getByRole('button', { name: '建立新的空数据库' }).click();
  await page.waitForTimeout(1200);
}
await gotoStaff('staff/events');
await page.getByRole('button', { name: '新建展会' }).click();
await page.locator('.modal input').first().fill('CWT-08');
await page.locator('.modal').getByRole('button', { name: '创建' }).click();
await page.waitForTimeout(800);

// ─────────────────────────────────────── 1. 「新增商品」= 完整表单
await gotoStaff('staff/products');
await page.getByRole('button', { name: '新增商品' }).click();
await page.waitForTimeout(500);
const createLabels = await modalLabels();
const missingCreate = EDITOR_LABELS.filter((l) => !createLabels.includes(l));
check('新增商品弹窗字段与编辑一致', missingCreate.length === 0, missingCreate.length ? `缺 ${missingCreate}` : '');

// 规格区：规格名可编辑、默认带出「默认规格」、没有「新增规格名」/「添加规格」
const createVariantName = await page.locator('.modal input[aria-label="规格名"]').first().inputValue().catch(() => '');
check('新增商品：规格名带出「默认规格」且可编辑', createVariantName === '默认规格', `实得「${createVariantName}」`);
check(
  '新增商品：没有「新增规格名」输入框',
  (await page.locator('.modal input[placeholder="新增规格名"]').count()) === 0
);
check('新增商品：没有「添加规格」按钮', (await page.getByRole('button', { name: '添加规格' }).count()) === 0);
check(
  '新增商品：规格名是可编辑输入框（不是只读块）',
  (await page.locator('.modal input[aria-label="规格名"]').count()) === 1
);
await shot('ui4-1-create');

// 真的建一个，顺便验证封面/说明这些字段能落盘
await page.locator('.modal input').first().fill('《夜行车》上卷');
await page.locator('.modal textarea').first().fill('这是一条说明，测试用。');
await page.locator('.modal input[placeholder="SKU（全库唯一，可留空）"]').fill('YXC-01');
await page.locator('.modal').getByRole('button', { name: '创建' }).click();
await page.waitForTimeout(1500);
const createdText = await page.evaluate(() => document.body.innerText);
check('新增商品后列表里出现该商品', createdText.includes('《夜行车》上卷'));

// ─────────────────────────────────────── 2. 「编辑商品」= 同一套表单
await page.getByRole('button', { name: '编辑' }).first().click();
await page.waitForTimeout(600);
const editLabels = await modalLabels();
const missingEdit = EDITOR_LABELS.filter((l) => !editLabels.includes(l));
check('编辑商品弹窗字段与新增一致', missingEdit.length === 0, missingEdit.length ? `缺 ${missingEdit}` : '');
check(
  '编辑商品：说明字段带出了刚填的内容',
  (await page.locator('.modal textarea').first().inputValue()) === '这是一条说明，测试用。'
);
check(
  '编辑商品：SKU 带出了刚填的值',
  (await page.locator('.modal input[placeholder="SKU（全库唯一，可留空）"]').inputValue()) === 'YXC-01'
);
check('编辑商品：没有「添加规格」按钮', (await page.getByRole('button', { name: '添加规格' }).count()) === 0);
await shot('ui4-2-edit');
await page.locator('.modal').getByRole('button', { name: '取消' }).click();
await page.waitForTimeout(400);

// ────────────────────────────── 3. 参展商品里也能编辑 + 4. 精确库存问号
await gotoStaff('staff/events');
await page.getByRole('button', { name: '全部加入本场', exact: true }).click();
await page.waitForTimeout(1200);

const goodsCard = page.locator('.card').filter({ hasText: '参展商品' }).first();
const rowEdit = goodsCard.getByRole('button', { name: '编辑' });
check('参展商品表格里有行内「编辑」', (await rowEdit.count()) > 0, `count=${await rowEdit.count()}`);
await rowEdit.first().click();
await page.waitForTimeout(700);
const fromEventLabels = await modalLabels();
const missingFromEvent = EDITOR_LABELS.filter((l) => !fromEventLabels.includes(l));
const title = await page.locator('.modal h2').first().innerText();
check('参展商品的「编辑」打开的是同一个编辑器', missingFromEvent.length === 0 && title.startsWith('编辑：'), title);
await shot('ui4-3-event-edit');
await page.locator('.modal').getByRole('button', { name: '取消' }).click();
await page.waitForTimeout(400);

// 精确库存列头的问号。
// 注意要按列头定位：参展商品表现在有两个问号（「库存 · 已售」和「精确库存」），
// 直接数 goodsCard 里的 .info-dot 会命中两个 → strict mode violation。
const exactTh = goodsCard.locator('th').filter({ hasText: '精确库存' });
const stockTh = goodsCard.locator('th').filter({ hasText: '库存 · 已售' });
check('「精确库存」列头有问号', (await exactTh.locator('.info-dot').count()) === 1);
check('「库存 · 已售」列头有问号（本轮新增）', (await stockTh.locator('.info-dot').count()) === 1);
const bubbleBefore = await exactTh.locator('.info-bubble').isVisible();
await exactTh.locator('.info-dot').click();
await page.waitForTimeout(400);
const bubbleAfter = await exactTh.locator('.info-bubble').isVisible();
const bubbleText = await exactTh.locator('.info-bubble').innerText().catch(() => '');
check('问号点击后弹出说明', !bubbleBefore && bubbleAfter, bubbleText.slice(0, 40) + '…');
check('说明里写了「剩 N」与「有货 / 少量 / 售罄」', /剩 N/.test(bubbleText) && /有货/.test(bubbleText));
// 新问号的文案要解释清「剩 / 已售 / 备」三个字，否则摊主看不懂这一格
await exactTh.locator('.info-dot').click();
await stockTh.locator('.info-dot').click();
await page.waitForTimeout(400);
const stockTip = await stockTh.locator('.info-bubble').innerText().catch(() => '');
check('「库存 · 已售」的说明解释了 剩 / 已售 / 备', /剩/.test(stockTip) && /已售/.test(stockTip) && /备/.test(stockTip), stockTip.slice(0, 50) + '…');

/* ---------------- 触屏上怎么把气泡关掉（2026-09-17 用户反馈）
   注意：桌面自动化里「鼠标停在问号上」会命中 CSS 的 :hover，
   所以每次判断「是否关掉」之前都要把指针移开，否则量到的是 hover 态。
   iPad 上没有 hover，这一层在真机上不存在。 */
const bubbleShown = () => stockTh.locator('.info-bubble').isVisible();
const away = async () => {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(250);
};
check('气泡里有明确的关闭按钮（×）', (await stockTh.locator('.info-bubble-close').count()) === 1);

// 先归零到「都没开」：上面那几条断言留下了一个开着的气泡，
// 不归零的话下面第一次点问号会把「已经开着的」关掉，测的就不是打开行为。
await page.locator('h1').first().click();
await away();
check('（前置）点外面把所有气泡关掉', !(await bubbleShown()));

// 点问号 → 指针移开 → 仍然可见（说明是「点开的」，不是靠 hover）
await stockTh.locator('.info-dot').click();
await away();
check('点问号打开后，指针移开仍然保持打开', await bubbleShown());
// 再点一次问号 → 关掉（原来被 :focus-within 卡住，点它根本没反应）
await stockTh.locator('.info-dot').click();
await away();
check('再点一次问号能关掉（不再被 focus-within 卡住）', !(await bubbleShown()));

// 点气泡里的 × → 关掉
await stockTh.locator('.info-dot').click();
await away();
check('（× 前置）气泡已打开', await bubbleShown());
await stockTh.locator('.info-bubble-close').click();
await away();
check('点气泡右上角的 × 能关掉', !(await bubbleShown()));

// 点气泡外面 → 关掉
await stockTh.locator('.info-dot').click();
await away();
check('（外面点击前置）气泡已打开', await bubbleShown());
await page.locator('h1').first().click();
await away();
check('点气泡外面能关掉', !(await bubbleShown()));

// 同时只挂一个气泡
await stockTh.locator('.info-dot').click();
await away();
await exactTh.locator('.info-dot').click();
await away();
const openBubbles = await page.evaluate(
  () => [...document.querySelectorAll('.info-bubble')].filter((el) => getComputedStyle(el).display !== 'none').length
);
check('同时只有一个气泡是打开的', openBubbles === 1, `${openBubbles} 个可见`);
await page.locator('h1').first().click();
await away();
await shot('ui4-4-info-dot');

// ─────────────────────────────────────── 5. 设置里没有「库存展示」
await gotoStaff('settings');
await page.waitForTimeout(1000);
const settingsText = await page.evaluate(() => document.body.innerText);
check('设置页已无「库存展示」卡片', !settingsText.includes('库存展示'));
check('设置页仍有「安全与访问」', settingsText.includes('安全与访问'));
await shot('ui4-5-settings');

// ─────────────────────────────────────── 6. 说明书里没有恢复入口
await page.goto(BASE + 'help', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const helpText = await page.evaluate(() => document.body.innerText);
check('说明书顶部已无「忘记后台 PIN」', !helpText.includes('忘记后台 PIN'));
check('说明书正文仍有 9.2 忘了后台 PIN 一节', helpText.includes('忘了后台 PIN'));
await shot('ui4-6-help');

console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
console.log('控制台错误：', errors.length ? '\n  ' + errors.join('\n  ') : '（无）');
await browser.close();
process.exitCode = fail ? 1 : 0;
