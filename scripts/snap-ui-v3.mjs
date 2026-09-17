/**
 * 截取本轮（UI v3）改动，供人工确认。
 *
 * 用法（server 与脚本必须在同一条 shell 命令里起，见文件末尾说明）：
 *   npx vite --port 5199 --strictPort --host 127.0.0.1 &
 *   node scripts/snap-ui-v3.mjs
 *
 * 覆盖：解锁页（PIN 唯一出路） / P2-3 侧栏分组 / P1-1 收银台 / P1-2 待付款 /
 *       P1-3 报表收摊 / P2-1 结算钉底条 / P2-2 取货码
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5199/';
const CHANNEL = process.env.SMOKE_CHANNEL ?? 'msedge';
const OUT = 'scripts/ui3';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  ...(CHANNEL ? { channel: CHANNEL } : {}),
  args: ['--no-sandbox']
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
ctx.on('dialog', (d) => d.accept());
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));

const shot = (name, opts = {}) => page.screenshot({ path: `${OUT}/${name}.png`, ...opts });

const PIN = ['1', '2', '3', '4'];

/** 打一遍 4 位 PIN 再确认 */
async function tapPin() {
  for (const d of PIN) {
    await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
  }
  await page.getByRole('button', { name: '确认' }).first().click();
  await page.waitForTimeout(600);
}

/** 进后台。首次是「设置后台 PIN」——现在要求连输两遍；之后是「请输入后台 PIN」一遍。 */
async function gotoStaff(path, { skipAuth = false } = {}) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  if (skipAuth) return;
  const needsSetup = await page.getByText('设置后台 PIN').count();
  const needsPin = await page.getByText('请输入后台 PIN').count();
  if (!needsSetup && !needsPin) return;
  if (needsSetup) await tapPin(); // 第一遍
  await tapPin(); // 设置时是第二遍确认，解锁时是唯一一遍
  await page.waitForTimeout(700);
}

// ─────────────────────────────────────────────── 准备：库 / 展会 / 商品 / 开场
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => /准备本地数据库|Doujin POS/.test(document.body.innerText || ''), {
  timeout: 45000
});
if (await page.getByRole('button', { name: '建立新的空数据库' }).count()) {
  await page.getByRole('button', { name: '建立新的空数据库' }).click();
  await page.waitForTimeout(600);
}

await gotoStaff('staff/events');
await page.getByRole('button', { name: '新建展会' }).click();
await page.locator('.modal input').first().fill('CWT-08');
await page.locator('.modal').getByRole('button', { name: '创建' }).click();
await page.waitForTimeout(700);

const ITEMS = [
  ['《夜行车》上卷', '48.00'],
  ['《海边的信号灯》', '60.00'],
  ['《糖分不足》', '35.00'],
  ['亚克力立牌「夜行」', '38.00'],
  ['《第七号观测站》', '52.00'],
  ['《旧梦重拍》', '65.00'],
  ['《无题短篇集》', '40.00'],
  ['亚克力挂件「信号灯」', '19.00']
];
for (const [name, price] of ITEMS) {
  await gotoStaff('staff/products');
  await page.getByRole('button', { name: '新增商品' }).click();
  await page.locator('.modal input').first().fill(name);
  await page.locator('.modal input').nth(1).fill(price);
  await page.locator('.modal').getByRole('button', { name: '创建' }).click();
  await page.waitForTimeout(500);
}

await gotoStaff('staff/events');
await page.getByRole('button', { name: '全部加入本场', exact: true }).click();
await page.waitForTimeout(900);

for (const [name, price, stock] of ITEMS.map(([n, p]) => [n, p, '30'])) {
  const row = page.locator('table tbody tr').filter({ hasText: name }).first();
  if (!(await row.count())) continue;
  const p = row.locator('input[type="text"]').first();
  if (await p.count()) {
    await p.fill(price);
    await p.blur();
    await page.waitForTimeout(250);
  }
  const st = row.locator('input[type="number"]').first();
  if (await st.count()) {
    await st.fill(stock);
    await st.blur();
    await page.waitForTimeout(350);
  }
}

// 支付方式：勾上现金（分段控件要有第二个选项才看得出来）
const payCard = page.locator('div.card').filter({ hasText: '支付方式' }).last();
const cashRow = payCard.locator('div.row').filter({ hasText: '现金' }).first();
const boxes = cashRow.locator('input[type="checkbox"]');
for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).check();
await page.waitForTimeout(600);
await page.getByRole('button', { name: '开场', exact: true }).click();
await page.waitForTimeout(1000);
console.log('展会已开场：', (await page.evaluate(() => document.body.innerText)).includes('进行中'));

// ─────────────────────────────────────────────── 游客下单 ×3，给待付款攒队列
async function kioskOrder(count) {
  await page.goto(BASE + 'kiosk', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  for (let i = 0; i < count; i++) {
    await page.locator('.add-btn').nth(i % 4).click();
    await page.waitForTimeout(250);
  }
  await page.getByRole('button', { name: '查看购物车' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: '去结算' }).click();
  await page.waitForTimeout(700);
  const pm = page.locator('.card').filter({ hasText: '选择支付方式' }).getByRole('button').first();
  if (await pm.count()) await pm.click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /^提交订单/ }).click();
  await page.waitForTimeout(1300);
  return page.url();
}

for (let i = 0; i < 3; i++) {
  const url = await kioskOrder(i === 1 ? 2 : i + 1);
  console.log(`第 ${i + 1} 笔待付款已建：`, url.split('/').pop());
}

// ─────────────────────────────── 1. 解锁页：PIN 是唯一出路
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await gotoStaff('staff/checkout', { skipAuth: true });
const locked = await page.getByText('请输入后台 PIN').count();
if (locked) {
  await shot('ui3-1-pin-unlock');

  // 硬断言：解锁页上不能出现任何「不输 PIN 也能进去」的东西。
  // 自助重置（原 /recover 流程）已按用户要求整条删掉，这一页的出路只剩输对 PIN。
  // 只看 PIN 卡片内部：侧栏的「备份恢复」是受保护路由、点了还是回这一页，
  // 不算旁路，扫全页会把它误报成泄漏。
  const leaks = await page
    .locator('.center-page button, .center-page a')
    .evaluateAll((els) => els.map((e) => e.textContent || '').filter((t) => /重置|恢复|忘记|无法/.test(t)));
  console.log(`解锁页重置入口泄漏检查：${leaks.length === 0 ? '✅ 卡片内无' : '❌ ' + JSON.stringify(leaks)}`);

  // 说明书里也不该再有恢复入口
  await page.goto(BASE + 'help', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await shot('ui3-1-help');
  const helpEntry = await page.getByRole('button', { name: '重置后台 PIN' }).count();
  console.log(`说明书中的恢复入口：${helpEntry === 0 ? '✅ 已移除' : '❌ 仍在'}`);

  // /recover 路由已删：应当落到兜底路由，而不是任何重置界面
  await page.goto(BASE + 'recover', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await shot('ui3-1a-recover-removed');
  const recText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  const stillReset = /重置后台 PIN|开始重置|确认是你在操作/.test(recText);
  console.log(
    `/recover 已删除检查：${stillReset ? '❌ 仍能进重置流程' : '✅ 无重置界面'}（落到：${recText.slice(0, 30)}…）`
  );

  // 回到解锁页，用正常 PIN 进后台
  await gotoStaff('staff/checkout', { skipAuth: true });
  await tapPin();
  await page.waitForTimeout(1000);
  const landedInBackend = (await page.locator('.pos-layout').count()) > 0;
  console.log(`解锁：输对 PIN 后进入后台=${landedInBackend ? '✅' : '❌'}`);
} else {
  console.log('P0-1：没有落在解锁页，跳过');
}

// 设置页的「安全与访问」
await gotoStaff('settings');
await page.waitForTimeout(800);
await shot('ui3-1d-settings-security');
await page.getByRole('button', { name: '修改后台 PIN' }).click();
await page.waitForTimeout(400);
await shot('ui3-1e-settings-setpin');
await page.getByRole('button', { name: '返回' }).first().click();
await page.waitForTimeout(300);
console.log('设置页「安全与访问」：已截');

// ─────────────────────────────────────────────── 2. 侧栏分组（P2-3）
await gotoStaff('staff/checkout');
await page.waitForTimeout(500);
await shot('ui3-2-sidebar-1280');
console.log('侧栏分组：已截');

// ─────────────────────────────────────────────── 3. 摊主收银台（P1-1）
for (let i = 0; i < 3; i++) {
  await page.locator('.pos-add').first().click();
  await page.waitForTimeout(250);
}
await page.locator('.pos-add').nth(2).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: '现金', exact: true }).click();
await page.waitForTimeout(400);
await shot('ui3-3-pos-1280');

// 攒几笔成交：报表页要有数据才看得出斑马纹，也才验得了排行/支付方式两张表。
// 点 .pos-add 的 first() 会一轮一个商品（进了单据的卡片不再有 .pos-add），
// 所以「点 N 次」正好等于「加 N 个不同商品」。
async function quickSale(n) {
  const clear = page.getByRole('button', { name: '清空' });
  if (await clear.count()) {
    await clear.click();
    await page.waitForTimeout(300);
  }
  for (let k = 0; k < n; k++) {
    await page.locator('.pos-add').first().click();
    await page.waitForTimeout(200);
  }
  await page.getByRole('button', { name: '现金', exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /^确认收款/ }).click();
  await page.waitForTimeout(1200);
}
for (const n of [2, 3, 4, 5, 6]) await quickSale(n);
console.log('已成交 5 单，用于报表数据');

// 断言：实收金额要跟着应付金额走（修复「预填值过期」的回归点）
{
  const clear = page.getByRole('button', { name: '清空' });
  if (await clear.count()) {
    await clear.click();
    await page.waitForTimeout(300);
  }
  await page.locator('.pos-add').first().click();
  await page.getByRole('button', { name: '现金', exact: true }).click();
  await page.waitForTimeout(400);
  const afterOne = await page.locator('input[aria-label="实收金额"]').inputValue();
  await page.locator('.pos-add').first().click();
  await page.locator('.pos-add').first().click();
  await page.waitForTimeout(500);
  const total = await page.locator('.total-price').innerText();
  const afterThree = await page.locator('input[aria-label="实收金额"]').inputValue();
  console.log(
    `实收预填跟随检查：1 件=${afterOne} → 3 件=${afterThree}（合计 ${total.replace(/\s+/g, ' ')}）` +
      (afterOne === afterThree ? '  ❌ 没跟着走' : '  ✅')
  );
}

// 上面那段留下了 3 件，滚动态截图就用这一单

// 商品区内部滚动是否生效（页面本身不该滚）
await page.evaluate(() => window.scrollTo(0, 0));
await page.mouse.move(400, 600);
await page.mouse.wheel(0, 900);
await page.waitForTimeout(500);
const pageScrolled = await page.evaluate(() => window.scrollY);
const gridScrolled = await page.evaluate(() => {
  const g = document.querySelector('.pos-grid');
  return g ? g.scrollTop : -1;
});
console.log(`滚动检查：页面 scrollY=${pageScrolled}（应为 0），商品区 scrollTop=${gridScrolled}（应 >0）`);
await shot('ui3-3b-pos-scrolled');

// ─────────────────────────────────────────────── 4. 待付款（P1-2）
await gotoStaff('staff/pending');
await page.waitForTimeout(1200);
await shot('ui3-4-pending-1280');
console.log('待付款：已截');

// 选队列第二笔，验证右侧联动
const q2 = page.locator('.queue-item').nth(1);
if (await q2.count()) {
  await q2.click();
  await page.waitForTimeout(800);
  await shot('ui3-4b-pending-second');
  console.log('待付款：第二笔选中态已截');
}

// ─────────────────────────────────────────────── 5. 报表收摊（P1-3）
await gotoStaff('staff/reports');
await page.waitForTimeout(1500);
await shot('ui3-5-reports-1280');
await page.mouse.wheel(0, 900);
await page.waitForTimeout(600);
await shot('ui3-5b-reports-scrolled');
const repScroll = await page.evaluate(() => window.scrollY);
console.log(`报表：已截（滚动贴边验证，scrollY=${repScroll}，应 >0）`);

// ─────────────────────────────────────────────── 6. 取货码 + 结算（P2-1 / P2-2）
await page.setViewportSize({ width: 820, height: 1180 });
await page.waitForTimeout(400);
const orderUrl = await kioskOrder(3); // 第 4 笔，留在订单页
await page.waitForTimeout(900);
await shot('ui3-6-order-820');
console.log('取货码：已截');

await page.goto(BASE + 'kiosk', { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
for (let i = 0; i < 3; i++) {
  await page.locator('.add-btn').nth(i).click();
  await page.waitForTimeout(250);
}
await page.getByRole('button', { name: '查看购物车' }).click();
await page.waitForTimeout(500);
await page.getByRole('button', { name: '去结算' }).click();
await page.waitForTimeout(800);
await shot('ui3-7-checkout-820');
// 底部操作条单独裁一张：这是 P2-1 的核心，不能被 1180 的全图缩略图糊掉
await shot('ui3-7b-checkout-bar', { clip: { x: 0, y: 1180 - 300, width: 820, height: 300 } });
console.log('结算页：已截（含底部操作条特写）');

// ───────────────────────── 8. 现场设备矩阵：横屏 iPad 四档 + 竖屏
// 硬断言：两栏成不成立、页面滚不滚、以及「确认收款」的底边是否落在视口里。
// 这一条是本轮唯一的验收标准 —— 收银时看不到按钮，其他都白搭。
async function stockCart(n) {
  const clear = page.getByRole('button', { name: '清空' });
  if (await clear.count()) {
    await clear.click();
    await page.waitForTimeout(250);
  }
  for (let k = 0; k < n; k++) {
    await page.locator('.pos-add').first().click();
    await page.waitForTimeout(180);
  }
  const cashBtn = page.getByRole('button', { name: '现金', exact: true });
  if (await cashBtn.count()) await cashBtn.click();
  await page.waitForTimeout(350);
}

const SIZES = [
  [1024, 768, 'ipad-9.7横'],
  [1180, 820, 'ipad-air横'],
  [1194, 834, 'ipad-pro11横'],
  [1366, 1024, 'ipad-pro12横'],
  [820, 1180, 'ipad竖']
];
let fitFail = 0;
for (const [w, h, name] of SIZES) {
  await page.setViewportSize({ width: w, height: h });
  await gotoStaff('staff/checkout');
  await page.waitForTimeout(600);
  await stockCart(3);
  const m = await page.evaluate(() => {
    const panel = document.querySelector('.side-panel');
    const btn = document.querySelector('.side-panel-foot .primary');
    const side = document.querySelector('.cols-side');
    const grid = document.querySelector('.pos-grid');
    const body = document.querySelector('.side-panel-body');
    const cols = side ? getComputedStyle(side).gridTemplateColumns.split(' ').length : 0;
    const bx = (s) => {
      const e = document.querySelector(s);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { top: Math.round(r.top), h: Math.round(r.height), bottom: Math.round(r.bottom) };
    };
    const stack = document.querySelector('.stack');
    return {
      cols,
      boxes: {
        html: bx('html'),
        root: bx('#root'),
        app: bx('.app'),
        sidebar: bx('.sidebar'),
        main: bx('.main'),
        outerContent: bx('.main > .content'),
        topbar: bx('.topbar'),
        nudge: bx('.content > .card, .content > .notice, .content > div:not([class])'),
        pageHead: bx('.page-head'),
        colsSide: bx('.cols-side'),
        stack: bx('.stack'),
        grid: bx('.pos-grid'),
        panel: bx('.side-panel')
      },
      stackOver: stack ? stack.scrollHeight - stack.clientHeight : null,
      // 右栏顶边 = 页面留白，用来校准 --panel-h 里减掉的那个数
      panelTop: panel ? Math.round(panel.getBoundingClientRect().top) : null,
      pageOverflow: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
      btnBottom: btn ? Math.round(btn.getBoundingClientRect().bottom) : null,
      gridH: grid ? Math.round(grid.getBoundingClientRect().height) : null,
      bodyH: body ? body.clientHeight : null
    };
  });
  const twoCol = m.cols === 2;
  const btnVisible = m.btnBottom !== null && m.btnBottom <= h;
  const noPageScroll = m.pageOverflow === 0;
  const ok = twoCol && btnVisible;
  if (!ok) fitFail++;
  console.log(
    `${name} ${w}×${h}：${twoCol ? '两栏' : '单栏'}，右栏顶 ${m.panelTop}px` +
      `（商品区 ${m.gridH}px / 明细区 ${m.bodyH}px）` +
      `，确认收款底边 ${m.btnBottom} / 视口 ${h} ${btnVisible ? '✅' : '❌'}` +
      `，页面溢出 ${m.pageOverflow}px ${noPageScroll ? '✅' : '⚠️'}`
  );
  if (m.pageOverflow > 0) {
    console.log('   高度分布：', JSON.stringify(m.boxes), `stackOver=${m.stackOver}`);
  }
  await shot(`ui3-9-pos-${w}x${h}`);
}

await page.setViewportSize({ width: 820, height: 1180 });
await gotoStaff('staff/pending');
await page.waitForTimeout(1200);
await shot('ui3-8b-pending-820');
console.log(`\n设备矩阵：${fitFail === 0 ? '全部通过 ✅' : `${fitFail} 档不达标 ❌`}`);

console.log('\n控制台错误：', errors.length ? '\n  ' + errors.join('\n  ') : '（无）');
await browser.close();
