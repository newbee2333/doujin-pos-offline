/**
 * 游客菜单改版验证：截图（预览页多尺寸 + 真机竖屏）+ 加购功能是否仍然可用。
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5222/';
const CHANNEL = process.env.SMOKE_CHANNEL ?? 'msedge';
const steps = [];
const ok = (n, d = '') => steps.push(`OK   ${n}${d ? ' — ' + d : ''}`);
const fail = (n, d) => steps.push(`FAIL ${n} — ${d}`);

const browser = await chromium.launch({ ...(CHANNEL ? { channel: CHANNEL } : {}), args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
ctx.on('dialog', (d) => d.accept());
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));

async function ready() {
  await page.waitForFunction(() => /准备本地数据库|Doujin POS/.test(document.body.innerText || ''), null, {
    polling: 500,
    timeout: 45000
  });
}

async function gotoStaff(path) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const digit = page.locator('button', { hasText: /^1$/ }).first();
  try {
    await digit.waitFor({ state: 'visible', timeout: 12000 });
  } catch {
    return;
  }
  for (const d of ['1', '2', '3', '4']) {
    await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
  }
  await page.getByRole('button', { name: '确认' }).first().click();
  await page.waitForTimeout(1500);
}

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await ready();
  const create = page.getByRole('button', { name: '建立新的空数据库' });
  if (await create.count()) {
    await create.click();
    await page.waitForTimeout(1500);
  }

  // 建展会
  await gotoStaff('staff/events');
  await page.getByRole('button', { name: '新建展会' }).click();
  await page.locator('.modal input').first().fill('C107 改版验证');
  await page.locator('.modal').getByRole('button', { name: '创建' }).click();
  await page.waitForTimeout(1200);

  // 建 3 个商品
  for (const [name, price, stock] of [
    ['《夏夜放送》全彩图文本 32P', '45.00', '12'],
    ['亚克力挂件 · 双面', '28.00', '38'],
    ['摊位套装（本+挂件+色纸）', '88.00', '4']
  ]) {
    await gotoStaff('staff/products');
    await page.getByRole('button', { name: '新增商品' }).click();
    await page.locator('.modal input').first().fill(name);
    await page.locator('.modal input').nth(1).fill(price);
    await page.locator('.modal').getByRole('button', { name: '创建' }).click();
    await page.waitForTimeout(800);
  }

  // 全部加入本场 + 设价格
  await gotoStaff('staff/events');
  await page.getByRole('button', { name: '全部加入本场', exact: true }).click();
  await page.waitForTimeout(1500);
  // 按行序设置价格与初始库存（不靠猜文本，避免上次那种"三行都写成同一个价"）
  const prices = ['45.00', '28.00', '88.00'];
  const rows = page.locator('table tbody tr');
  const n = await rows.count();
  for (let i = 0; i < n; i += 1) {
    const r = rows.nth(i);
    const priceInput = r.locator('input[type="text"]').first();
    if (await priceInput.count()) {
      await priceInput.fill(prices[i] ?? '10.00');
      await priceInput.blur();
      await page.waitForTimeout(500);
    }
    // 设初始库存：不设的话卡片会正确地显示「售罄」，就没有加购按钮可点
    const stockInput = r.locator('input[type="number"]').first();
    if (await stockInput.count()) {
      await stockInput.fill(i === 2 ? '4' : '12');
      await stockInput.blur();
      await page.waitForTimeout(700);
    }
  }
  ok('准备数据：1 场展会 + 3 件商品');

  // 预览页（多尺寸画框，一次看到手机/iPad/桌面）
  await gotoStaff('preview');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'scripts/kiosk-preview.png', fullPage: true });
  const cardsInPreview = await page.locator('.menu-card-cover').count();
  if (cardsInPreview > 0) ok('预览页渲染新卡片', `${cardsInPreview} 张`);
  else fail('预览页渲染新卡片', '一张都没有');

  // 真机竖屏：进游客菜单
  await page.goto(BASE + 'kiosk', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'scripts/kiosk-phone.png' });

  const hero = await page.evaluate(() => {
    const h = document.querySelector('.kiosk-hero');
    const card = document.querySelector('.menu-card-cover');
    if (!h || !card) return { hero: !!h, card: !!card };
    const cs = getComputedStyle(card);
    const thumb = card.querySelector('.thumb, .thumb-placeholder');
    return {
      hero: true,
      card: true,
      cardRadius: cs.borderRadius,
      cardBg: cs.backgroundColor,
      thumbRatio: thumb ? (thumb.getBoundingClientRect().width / thumb.getBoundingClientRect().height).toFixed(2) : null,
      pageBg: getComputedStyle(document.querySelector('.kiosk')).backgroundColor,
      cols: getComputedStyle(document.querySelector('.menu-grid')).gridTemplateColumns.split(' ').length
    };
  });
  if (hero.hero && hero.card) {
    ok('游客页结构与样式', `底 ${hero.pageBg} · 卡 ${hero.cardBg} r${hero.cardRadius} · 图比例 ${hero.thumbRatio} · ${hero.cols} 列`);
  } else fail('游客页结构与样式', JSON.stringify(hero));

  // 加购功能
  const addBtn = page.locator('.menu-card-cover .add-btn').first();
  if (await addBtn.count()) {
    await addBtn.click();
    await page.waitForTimeout(900);
    const bar = await page.locator('.cart-bar').innerText();
    if (/\d/.test(bar) && !/^0/.test(bar.trim())) ok('加购后购物车条更新', bar.replace(/\s+/g, ' ').slice(0, 40));
    else fail('加购后购物车条更新', bar.replace(/\s+/g, ' ').slice(0, 60));
    await page.screenshot({ path: 'scripts/kiosk-phone-cart.png' });
  } else fail('卡片上有加购按钮', '找不到 .add-btn');

  if (errors.length) fail('控制台错误', errors.join(' | '));
} catch (e) {
  fail('执行异常', e.message.slice(0, 160));
}

console.log(steps.join('\n'));
await browser.close();
process.exit(steps.some((s) => s.startsWith('FAIL')) ? 1 : 0);
