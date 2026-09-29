/**
 * 校验本轮四处修复。server 与脚本必须在同一条 shell 命令里起。
 *   npx vite --port 5199 --strictPort --host 127.0.0.1 &
 *   SMOKE_BASE=http://127.0.0.1:5199/ node scripts/verify-bundle-ux.mjs
 *
 * 1. 菜单预览的分类胶囊能点（原来是一排死的 <span>，「全部」永远高亮）
 * 2. 商品编辑里「菜单分类」和「库存类型」不会混（默认分类里就有一个叫「套装」的）
 * 3. 「新增商品」时就能配套装成分，且成分选择器复用游客菜单的商品卡 + 搜索
 * 4. 摊主收银台上，成分有货的套装不再显示售罄
 * 5. 移除一个还在被本场套装消耗的成分时，确认框会多说一句
 *
 * ⚠️ 第 4 项必须排在第 5 项前面：第 5 项会把套装和成分都从本场移除，
 * 之后收银台里就没有它们了，再验库存只会得到一堆「找不到卡片」。
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.SMOKE_BASE ?? process.env.BASE ?? 'http://127.0.0.1:5199/';
const OUT = 'scripts/ui10';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 1024 } });

// 确认框要抓文案（第 5 项就靠这个），所以不能像别的脚本那样无脑 accept
let dialogMsg = '';
ctx.on('dialog', async (d) => {
  dialogMsg = d.message();
  await d.accept();
});

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
  await page.waitForTimeout(800);
  const setup = await page.getByText('设置后台 PIN').count();
  const unlock = await page.getByText('请输入后台 PIN').count();
  if (!setup && !unlock) return;
  if (setup) await tapPin();
  await tapPin();
  await page.waitForTimeout(600);
}

/** 弹窗里按 label 找控件：Field 渲染成 <label class="field"><span>标签</span><控件/></label> */
const field = (label) => page.locator('.modal label.field').filter({ hasText: new RegExp(`^${label}`) });
const typeSelect = () => field('库存类型').locator('select');
const modalText = () => page.locator('.modal').innerText();

async function newProduct(name, categoryLabel) {
  await page.getByRole('button', { name: '新增商品' }).click();
  await page.waitForTimeout(500);
  await page.locator('.modal input').first().fill(name);
  // 默认价格留着空的话，进场后本场价格也是空，开场会被「未设置本场价格」挡住
  await field('默认价格').locator('input').fill('30.00');
  if (categoryLabel) await field('菜单分类').locator('select').selectOption({ label: categoryLabel });
  await page.waitForTimeout(300);
}

const gridCount = () => page.locator('.preview-frame .menu-card').count();
const pickerCards = () => page.locator('.vp-grid .menu-card-cover');

// ─────────────────────────────────────────── 准备：库 / 展会 / 三个普通商品
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
if (await page.getByRole('button', { name: '建立新的空数据库' }).count()) {
  await page.getByRole('button', { name: '建立新的空数据库' }).click();
  await page.waitForTimeout(1500);
}
await gotoStaff('staff/events');
await page.getByRole('button', { name: '新建展会' }).click();
await page.locator('.modal input').first().fill('CWT-10');
await page.locator('.modal').getByRole('button', { name: '创建' }).click();
await page.waitForTimeout(1000);

await gotoStaff('staff/products');
for (const [name, cat] of [['《夜行车》上卷', '新刊'], ['《旧梦重拍》', '新刊'], ['亚克力立牌', '既刊']]) {
  await newProduct(name, cat);
  await page.locator('.modal').getByRole('button', { name: '创建' }).click();
  await page.waitForTimeout(1200);
}

// 三个商品都要进场，否则预览里什么都没有
await gotoStaff('staff/events');
await page.getByRole('button', { name: '全部加入本场', exact: true }).click();
await page.waitForTimeout(1500);

// ──────────────────────────────── 1. 菜单预览：分类胶囊是真的能点的按钮
await gotoStaff('preview');
await page.waitForTimeout(1200);
const chipTags = await page.locator('.preview-frame .chip-row .chip').evaluateAll((els) =>
  els.map((e) => e.tagName)
);
check(
  '预览的分类胶囊是 button（不是死的 span）',
  chipTags.length > 0 && chipTags.every((t) => t === 'BUTTON'),
  chipTags.join('/')
);

const allCount = await gridCount();
check('预览「全部」显示 3 个商品', allCount === 3, `实得 ${allCount}`);

const chips = page.locator('.preview-frame .chip-row .chip');
await chips.filter({ hasText: /^新刊$/ }).click();
await page.waitForTimeout(400);
const xinkanCount = await gridCount();
const xinkanActive = await chips.filter({ hasText: /^新刊$/ }).evaluate((e) => e.className.includes('active'));
check('点「新刊」后只剩该分类的 2 个', xinkanCount === 2, `实得 ${xinkanCount}`);
check('「新刊」接过高亮', xinkanActive);

await chips.filter({ hasText: /^既刊$/ }).click();
await page.waitForTimeout(400);
const jikanCount = await gridCount();
check('点「既刊」后只剩 1 个', jikanCount === 1, `实得 ${jikanCount}`);

await chips.filter({ hasText: /^亚克力$/ }).click();
await page.waitForTimeout(400);
check('点空分类会真的清空，而不是没反应', (await gridCount()) === 0);
check('空分类给出提示文案', (await page.locator('.preview-frame').innerText()).includes('没有找到商品'));

await chips.filter({ hasText: /^全部$/ }).click();
await page.waitForTimeout(400);
check('点回「全部」恢复 3 个', (await gridCount()) === 3, `实得 ${await gridCount()}`);
await shot('ui10-1-preview-chips');

// ──────────────── 2. 「菜单分类=套装」但「库存类型」不是套装时要提醒
await gotoStaff('staff/products');
await newProduct('三件套', '套装');
check('类型说明会跟着选中项走（普通库存）', (await modalText()).includes('卖一件就扣自己一件'));
check(
  '分类选「套装」但库存类型不是时给出提示',
  (await modalText()).includes('「库存类型」改成「组合套装」'),
  (await modalText()).includes('组合套装') ? '' : '没找到提示'
);
check('且此时不显示「套装成分」', (await page.locator('.modal .bundle-comps').count()) === 0);
await shot('ui10-2-category-trap');

// ──────────────── 3. 「新增商品」时就能配套装成分 + 选择器复用菜单卡与搜索
await typeSelect().selectOption({ label: '组合套装' });
await page.waitForTimeout(600);
check('切成「组合套装」后出现「套装成分」', (await page.locator('.modal .bundle-comps').count()) === 1);
check('提示条随类型切换消失', !(await modalText()).includes('「库存类型」改成「组合套装」'));
check('类型说明换成了套装那句', (await modalText()).includes('自己没有库存'));

const comps = page.locator('.modal .bundle-comps');
check('没有成分时先只有「添加成分」', (await comps.locator('.bundle-comp').count()) === 0);
await comps.getByRole('button', { name: '添加成分' }).click();
await page.waitForTimeout(500);
check('点「添加成分」出现一条成分', (await comps.locator('.bundle-comp').count()) === 1);

// —— 选择器收起时只有一行摘要（新增的行会预选第一项，所以这里不该是占位文案）
const block = comps.locator('.bundle-comp').first();
check('收起状态是一行摘要，没有铺开网格', (await comps.locator('.vp-grid').count()) === 0);
check('摘要行给出了已选商品名', (await block.locator('.vp-name').innerText()).trim().length > 0);
check('摘要行给出了规格名', (await block.locator('.vp-sub').innerText()).includes('默认规格'));

// —— 展开后是游客菜单那套卡片
await block.locator('.vp-toggle').click();
await page.waitForTimeout(500);
check('展开后有卡片网格', (await comps.locator('.vp-grid').count()) === 1);
const cardCount = await pickerCards().count();
check('网格里是菜单卡（.menu-card-cover）', cardCount === 3, `实得 ${cardCount}`);
check(
  '卡片复用了菜单的封面位（无图时是 thumb-placeholder）',
  (await comps.locator('.vp-grid .menu-card-cover .thumb-placeholder').count()) === 3
);
check('卡片上带「选择」按钮', (await comps.locator('.vp-grid .pick-btn').count()) === 3);
await shot('ui10-3-picker-cards');

// —— 搜索
const search = comps.locator('.vp-search');
check('展开后带搜索框', (await search.count()) === 1);
await search.fill('旧梦');
await page.waitForTimeout(400);
const dreamCount = await pickerCards().count();
check('搜索「旧梦」只剩 1 张卡', dreamCount === 1, `实得 ${dreamCount}`);
await search.fill('yxc');
await page.waitForTimeout(400);
// 这三个商品都没有 SKU，所以按 SKU 搜应该是空的 —— 顺便确认「搜不到就是空」而不是兜底全量
check('搜不存在的关键词时是真的空', (await pickerCards().count()) === 0);
check('空白时给出文案', (await comps.locator('.vp-empty').count()) === 1);
await search.fill('');
await page.waitForTimeout(400);
const backCount = await pickerCards().count();
check('清空搜索后恢复 3 张卡', backCount === 3, `实得 ${backCount}`);

// —— 点卡片选中
await pickerCards().filter({ hasText: '《夜行车》上卷' }).first().locator('.menu-card-info').click();
await page.waitForTimeout(500);
check('点卡片后面板收起', (await comps.locator('.vp-grid').count()) === 0);
check('摘要行显示被选中的商品', (await block.locator('.vp-name').innerText()) === '《夜行车》上卷');
check('摘要行显示规格', (await block.locator('.vp-sub').innerText()) === '默认规格');

// —— 再打开时选中态要能看出来
await block.locator('.vp-toggle').click();
await page.waitForTimeout(500);
const chosen = pickerCards().filter({ hasText: '《夜行车》上卷' }).first();
check('选中卡带 picked 高亮', (await chosen.getAttribute('class')).includes('picked'));
check('选中卡上的按钮变成「已选」', (await chosen.locator('.pick-btn').innerText()) === '已选');
check('只有一张卡是选中态', (await comps.locator('.vp-grid .menu-card-cover.picked').count()) === 1);
await shot('ui10-4-picker-selected');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check('Esc 能收起面板', (await comps.locator('.vp-grid').count()) === 0);

await block.locator('input[type="number"]').fill('2');
await page.waitForTimeout(300);

await page.locator('.modal').getByRole('button', { name: '创建' }).click();
await page.waitForTimeout(2000);
check('创建后回到列表且没有报错', (await page.locator('.modal').count()) === 0, errors[0] ?? '');

// 再打开编辑，确认成分真的落盘了 —— 这是「一次配齐」的关键证据
await page.locator('tr').filter({ hasText: '三件套' }).getByRole('button', { name: '编辑' }).click();
await page.waitForTimeout(1200);
const editBlock = page.locator('.modal .bundle-comps .bundle-comp').first();
check('重新打开编辑时成分还在', (await editBlock.locator('.vp-name').innerText()) === '《夜行车》上卷');
check('数量也带出来了', (await editBlock.locator('input[type="number"]').inputValue()) === '2');
await shot('ui10-5-persisted');
await page.locator('.modal').getByRole('button', { name: '取消' }).click();
await page.waitForTimeout(500);

// 套装是在「全部加入本场」之后才建的，得再补一次
await gotoStaff('staff/events');
await page.getByRole('button', { name: '全部加入本场', exact: true }).click();
await page.waitForTimeout(1500);

// 顺带确认新建的套装在预览里归到「套装」这一栏（分类是生效的）
await gotoStaff('preview');
await page.waitForTimeout(1200);
const previewChips = page.locator('.preview-frame .chip-row .chip');
await previewChips.filter({ hasText: /^套装$/ }).click();
await page.waitForTimeout(400);
const setCount = await gridCount();
check('预览里「套装」分类下有 1 件', setCount === 1, `实得 ${setCount}`);

// ──────────────── 4. 摊主收银台：成分有货的套装不能显示售罄
await gotoStaff('staff/events');
await page.waitForTimeout(1000);
for (const name of ['《夜行车》上卷', '《旧梦重拍》', '亚克力立牌']) {
  const inp = page.locator(`input[aria-label="${name} 初始库存"]`);
  if (await inp.count()) {
    await inp.fill('10');
    await inp.blur();
    await page.waitForTimeout(500);
  }
}
const payCard = page.locator('div.card').filter({ hasText: '支付方式' }).last();
const cashRow = payCard.locator('div.row').filter({ hasText: '现金' }).first();
const boxes = cashRow.locator('input[type="checkbox"]');
const boxCount = await boxes.count();
for (let i = 0; i < boxCount; i++) await boxes.nth(i).check();
await page.waitForTimeout(700);
await page.getByRole('button', { name: '检查开场条件' }).click();
await page.waitForTimeout(800);
const openBtn = page.getByRole('button', { name: '开场', exact: true });
if (await openBtn.count()) {
  await openBtn.click();
  await page.waitForTimeout(1500);
}
check('收银台前置：展会已开场', (await page.evaluate(() => document.body.innerText)).includes('进行中'));

await gotoStaff('staff/checkout');
await page.waitForTimeout(1800);
const bundleCard = page.locator('.pos-card').filter({ hasText: '三件套' }).first();
check('收银台里能找到套装卡片', (await bundleCard.count()) > 0);
const bundleTag = await bundleCard.locator('.stock-tag').innerText().catch(() => '');
// 三件套 = 1 个《夜行车》上卷 ×2，上卷库存 10 → 可卖 5 套。
// 修复前这里显示的是「售罄」（套装没有自己的库存行，兜底成了 0）。
check('套装显示的是成分算出来的可卖数，不是售罄', bundleTag.includes('余 5'), `实得「${bundleTag}」`);
check('套装卡片没有售罄遮罩', (await bundleCard.locator('.sold-veil').count()) === 0);
check('套装可以点得动（＋ 没被禁用）', !(await bundleCard.locator('.pos-add').isDisabled()));

const bookCard = page.locator('.pos-card').filter({ hasText: '《夜行车》上卷' }).first();
const bookTag = await bookCard.locator('.stock-tag').innerText();
check('普通商品仍按自己的库存显示', bookTag.includes('余 10'), `实得「${bookTag}」`);
await shot('ui10-7-checkout-bundle-stock');

// ──────── 4.5 报表：库存消耗明细要认得出是哪一件，并把来源拆开
// 卖一笔：1 套三件套（带出 2 个《夜行车》上卷）+ 单卖 2 个《夜行车》上卷
await page.locator('.pos-card').filter({ hasText: '三件套' }).first().locator('.pos-add').click();
await page.waitForTimeout(300);
// 商品一旦进了本单，「＋」就换成「×N」计数，所以两次都点封面 ——
// 封面同样走 addLine，且进单后仍可点（只有售罄才禁用）。bookCard 沿用上一节。
await bookCard.locator('.pos-cover').click();
await page.waitForTimeout(300);
await bookCard.locator('.pos-cover').click();
await page.waitForTimeout(400);
const bookLineSub = (await page
  .locator('.pos-line')
  .filter({ hasText: '《夜行车》上卷' })
  .first()
  .locator('.pos-line-sub')
  .innerText()).replace(/\s+/g, ' ');
// 套装那一行只记「三件套 ×1」，成分不在本单里展开 —— 所以这 2 件是实打实的单卖。
check('本单里《夜行车》上卷单卖 2 件', bookLineSub.startsWith('× 2'), bookLineSub);
const bundleLineSub = (await page
  .locator('.pos-line')
  .filter({ hasText: '三件套' })
  .first()
  .locator('.pos-line-sub')
  .innerText()).replace(/\s+/g, ' ');
check('本单里套装 1 套', bundleLineSub.startsWith('× 1'), bundleLineSub);
await page.locator('.seg-item').filter({ hasText: '现金' }).first().click();
await page.waitForTimeout(300);
await page.locator('input[placeholder="0.00"]').last().fill('200.00');
await page.waitForTimeout(300);
await page.getByRole('button', { name: /确认收款/ }).click();
await page.waitForTimeout(1500);
check('报表前置：收银成功', (await page.evaluate(() => document.body.innerText)).includes('已成交'));

await gotoStaff('staff/reports');
await page.waitForTimeout(1500);
const consumptionCard = page.locator('.card').filter({ hasText: '库存消耗明细' }).first();
check('报表里有「库存消耗明细」卡片', (await consumptionCard.count()) > 0);
const headers = await consumptionCard.locator('thead th').allInnerTexts();
check(
  '表头含 套装带出 / 单卖 / 净消耗',
  ['套装带出', '单卖', '净消耗'].every((h) => headers.includes(h)),
  headers.join('|')
);
const bookRow = consumptionCard.locator('tbody tr').filter({ hasText: '《夜行车》上卷' }).first();
check('行上写的是商品名', (await bookRow.count()) > 0);
const cells = await bookRow.locator('td').allInnerTexts();
// 单元格顺序：商品 / 套装带出 / 单卖 / 合计售出 / 返库 / 净消耗
check('套装带出 = 2（1 套 × 2）', cells[1].trim() === '2', `实得「${cells[1]}」`);
check('单卖 = 2', cells[2].trim() === '2', `实得「${cells[2]}」`);
check('合计售出 = 4', cells[3].trim() === '4', `实得「${cells[3]}」`);
check('净消耗 = 4', cells[5].trim() === '4', `实得「${cells[5]}」`);
check(
  '同一格能看出商品名与规格',
  cells[0].includes('《夜行车》上卷') && cells[0].includes('默认规格'),
  cells[0].replace(/\s+/g, ' ')
);
// 这张表以前整列都是快照里的规格名，于是每一行都写「默认规格」
const firstCells = await consumptionCard.locator('tbody tr td:first-child').allInnerTexts();
check(
  '没有一行是光秃秃的「默认规格」',
  firstCells.length > 0 && firstCells.every((t) => t.trim() !== '默认规格'),
  firstCells.map((t) => t.split('\n')[0]).join('|')
);
await shot('ui10-8-consumption');

// ──────────────── 5. 移除「还在被本场套装消耗」的成分时会多提醒一句
await gotoStaff('staff/events');
await page.waitForTimeout(1200);
const row = page.locator('tr').filter({ hasText: '《夜行车》上卷' }).first();
check('参展商品表里能找到成分那一行', (await row.count()) > 0);

dialogMsg = '';
await row.locator('button[title^="从本场移除"]').click();
await page.waitForTimeout(800);
check('移除成分时确认框里提到了本场套装', dialogMsg.includes('还是本场套装'), `文案：${dialogMsg.slice(0, 50)}…`);
// 基础文案里本来就有「上下架状态」，只断言「下架」两个字会永远为真 —— 要断整句
check('并指向「下架」这个不丢行的替代做法', dialogMsg.includes('用「下架」代替「移除」'));
await page.waitForTimeout(600);
await shot('ui10-6-remove-warning');

// 反向：把套装自己移除时不该提套装的事
dialogMsg = '';
const bundleRow = page.locator('tr').filter({ hasText: '三件套' }).first();
await bundleRow.locator('button[title^="从本场移除"]').click();
await page.waitForTimeout(800);
check('移除套装自己时不提「还是本场套装的成分」', !dialogMsg.includes('还是本场套装'), `文案：${dialogMsg.slice(0, 50)}…`);

console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
console.log('控制台错误：', errors.length ? '\n  ' + errors.join('\n  ') : '（无）');
await browser.close();
process.exitCode = fail || errors.length ? 1 : 0;
