/**
 * 验证「进游客菜单需二次确认」+「菜单预览不锁后台」。
 *
 * 关键坑：page.goto 是整页重载，内存里的后台会话必然丢失、必然要求 PIN，
 * 所以用它测不出「会话是否保持」。必须用应用内点击或 page.goBack()（不重载）。
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE ?? 'http://127.0.0.1:5178/';
const steps = [];
const ok = (n, d = '') => steps.push(`OK   ${n}${d ? ' — ' + d : ''}`);
const fail = (n, d) => steps.push(`FAIL ${n} — ${d}`);

const browser = await chromium.launch({ channel: 'msedge', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
let dialogAction = 'accept';
const seenDialogs = [];
ctx.on('dialog', (d) => {
  seenDialogs.push(d.message());
  if (dialogAction === 'dismiss') void d.dismiss();
  else void d.accept();
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const path = () => page.evaluate(() => location.pathname);
/** 首次进后台是「设置后台 PIN」，之后是「请输入后台 PIN」，两种都算锁着。 */
const pinVisible = async () =>
  (await page.locator('text=请输入后台 PIN').count()) > 0 ||
  (await page.locator('text=设置后台 PIN').count()) > 0;

/** 侧边栏点击，不重载页面 */
async function clickNav(name) {
  await page.locator('.sidebar a', { hasText: new RegExp(`^${name}`) }).first().click();
  await page.waitForTimeout(1100);
}

try {
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
  await page.goto(BASE + 'staff/events', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  if (await pinVisible()) {
    for (const d of ['1', '2', '3', '4']) {
      await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
    }
    await page.getByRole('button', { name: '确认' }).first().click();
    await page.waitForTimeout(900);
  }
  ok('建库并解锁后台', `路径 ${await path()}`);

  // 先建一个展会：否则「展会配置」显示的是展会列表，看不到「参展商品」卡片
  await page.getByRole('button', { name: '新建展会' }).click();
  await page.locator('.modal input').first().fill('入口验证展');
  await page.locator('.modal').getByRole('button', { name: '创建' }).click();
  await page.waitForTimeout(900);
  ok('创建展会（供后续页面断言使用）');

  // ── A. 菜单预览不锁后台
  await clickNav('菜单预览');
  const previewText = await page.evaluate(() => document.body.innerText);
  // 标记取实际渲染出来的文本：尺寸标签在 <select><option> 里，innerText 取不到
  if (previewText.includes('商品目录（预览）')) ok('菜单预览打开');
  else fail('菜单预览', previewText.replace(/\n+/g, ' | ').slice(0, 200));

  await clickNav('展会配置');
  if (await pinVisible()) fail('看完预览后被要求输 PIN', '预览路由不该锁后台');
  else ok('看完菜单预览，会话保持（未要求 PIN）');

  // ── B. 点游客菜单 → 取消 → 会话必须保持
  dialogAction = 'dismiss';
  seenDialogs.length = 0;
  await clickNav('游客菜单');
  if (seenDialogs.some((m) => m.includes('重新输入 PIN'))) ok('点游客菜单弹出二次确认');
  else fail('二次确认', `未捕获到确认框（${seenDialogs.length} 个 dialog）`);

  if ((await path()).startsWith('/kiosk')) fail('取消后仍跳转', await path());
  else ok('取消后停留在后台，未跳转');

  await clickNav('展会配置');
  if (await pinVisible()) fail('取消后会话被清掉', '取消不该影响后台会话');
  else ok('取消后会话仍有效（不用重输 PIN）');

  // ── C. 确认进入 → 走 kiosk；再用 goBack 回来（不重载）应要求 PIN
  dialogAction = 'accept';
  seenDialogs.length = 0;
  await clickNav('游客菜单');
  if ((await path()).startsWith('/kiosk')) ok('确认后进入游客菜单');
  else fail('确认进入', `路径 ${await path()}`);

  await page.goBack();
  await page.waitForTimeout(1400);
  if (await pinVisible()) ok('从游客菜单返回后要求输 PIN（预期的安全行为）');
  else fail('返回未要求 PIN', `路径 ${await path()}，进入游客菜单时应清掉后台会话`);

  // ── D. 编辑页上的预览入口
  if (await pinVisible()) {
    for (const d of ['1', '2', '3', '4']) {
      await page.locator('button', { hasText: new RegExp(`^${d}$`) }).first().click();
    }
    await page.getByRole('button', { name: '确认' }).first().click();
    await page.waitForTimeout(900);
  }
  for (const [name, expectText] of [
    ['商品', '商品管理'],
    ['展会配置', '参展商品']
  ]) {
    await clickNav(name);
    const body = await page.evaluate(() => document.body.innerText);
    if (!body.includes(expectText)) {
      fail(`${name} 页未加载`, body.replace(/\n+/g, ' | ').slice(0, 160));
      continue;
    }
    const hits = await page.getByRole('button', { name: /预览菜单效果/ }).count();
    if (hits) ok(`${name}页有「预览菜单效果」入口`);
    else fail(`${name}页缺少预览入口`, '');
  }

  if (errors.length) fail('控制台错误', errors.join(' | '));
} catch (e) {
  fail('执行异常', e.message);
}

console.log(steps.join('\n'));
await browser.close();
process.exit(steps.some((s) => s.startsWith('FAIL')) ? 1 : 0);
