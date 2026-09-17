/**
 * 线上部署验证（UI v4）：产物内容 + 真实浏览器行为。
 *
 * 为什么不能只看 HTTP 200：
 *   这个应用缺 COOP/COEP 时不会降级，而是直接渲染「当前环境不能营业」。
 *   所以必须真的用浏览器打开一次，读 crossOriginIsolated，并确认渲染出的
 *   不是那张拒绝启动的卡片。
 *
 * 用法：node scripts/verify-live-v4.mjs [url]
 */
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'https://doujin-pos-offline.pages.dev';
const results = [];
const check = (label, pass, detail = '') => {
  results.push([label, !!pass, detail]);
  console.log('  ' + (pass ? '✅' : '❌') + ' ' + label + (detail ? ' — ' + detail : ''));
};

/* ── 1. 产物内容：新版本的字符串必须真的在 bundle 里 ── */
console.log('===== 1. 线上产物检查 =====');
const home = await fetch(base + '/');
check('首页 HTTP 200', home.status === 200, String(home.status));
check('COOP: same-origin', home.headers.get('cross-origin-opener-policy') === 'same-origin',
  home.headers.get('cross-origin-opener-policy') ?? '缺失');
check('COEP: require-corp', home.headers.get('cross-origin-embedder-policy') === 'require-corp',
  home.headers.get('cross-origin-embedder-policy') ?? '缺失');
check('CORP: same-origin', home.headers.get('cross-origin-resource-policy') === 'same-origin',
  home.headers.get('cross-origin-resource-policy') ?? '缺失');

const html = await home.text();
const jsFile = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1];
const cssFile = html.match(/assets\/(index-[A-Za-z0-9_-]+\.css)/)?.[1];
console.log(`  入口 JS: ${jsFile} | CSS: ${cssFile}`);

// 本地构建产物应与线上一字不差
const fs = await import('node:fs/promises');
// 发布目录是项目目录的兄弟目录，不是子目录
const localHtml = await fs.readFile(new URL('../../doujin-pos-live/index.html', import.meta.url), 'utf8');
const localJs = localHtml.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1];
check('线上 JS == 本地构建产物', jsFile === localJs, `线上 ${jsFile} / 本地 ${localJs}`);

const code = await (await fetch(base + '/assets/' + jsFile)).text();
const style = await (await fetch(base + '/assets/' + cssFile)).text();

const contentRows = [
  ['导航字号 --fs-nav（第 5 轮）', /--fs-nav:\s*15px/.test(style)],
  ['取单号 40px（校准后）', /--fs-order-no:\s*40px/.test(style)],
  // 规格名已经从「只读纯文本块」改成可编辑输入框（用户拍板，推翻第 4 轮的决定）。
  // 所以这里断言的是：旧的只读块类名已消失，且界面上真的写了「名字可以改」。
  ['规格名可改：旧只读块 variant-name 已移除', !code.includes('variant-name')],
  ['规格名可改：界面写明「名字可以改」', code.includes('名字可以改')],
  // ⚠️ 上面那行的逗号不能省：数组里两个相邻的字面量少了逗号会被解析成下标访问
  // （['a',b] ['c',d]），contentRows 变成 undefined，报错却在 for...of 那一行，
  // 排查起来很费劲。这个坑已经踩过两次了。
  ['已删除 新增规格名', !code.includes('新增规格名')],
  // 不能找 `ProductEditorModal` 或 `DEFAULT_VARIANT`：这两个都是局部标识符，
  // 打包时会被重命名。要认的是它渲染出的字面量。
  ['统一编辑商品（默认规格 字面量）', code.includes('默认规格')],
  ['信息气泡 InfoDot（精确库存问号）', code.includes('info-bubble') || style.includes('info-bubble')],
  // 自助重置整条删掉了（用户拍板）。断言方向因此反过来：
  // bundle 里不该再出现任何重置界面的文案。「后台 PIN」这几个字仍会合理地出现在
  // 设置页和手册里，那是正常的改 PIN 入口，不是这里的判据。
  ['自助重置已删：无「重置后台 PIN」文案', !code.includes('重置后台 PIN')],
  ['自助重置已删：无「开始重置」按钮', !code.includes('开始重置')],
  ['自助重置已删：无确认文字门槛', !code.includes('确认是你在操作')],
  ['PIN 仍可改（设置 → 安全与访问）', code.includes('修改后台 PIN')],
  // 说明书正文来自 README，而 README 必须解释「库存展示已经不在设置里了」，
  // 所以这个短语会合理地出现在手册正文中。要断言的是：
  //   ① 设置页不再有那张卡片 —— 用卡片标题的相邻文案判断；
  //   ② 手册里那块说明必须带「不在这里」的澄清。
  ['设置页已无 库存展示 卡片（无旧描述）',
    !code.includes('是否在游客菜单显示精确库存')],
  ['手册已澄清 库存展示 不在设置里', code.includes('库存展示') && code.includes('不在这里')],
  ['overflow-x: clip（粘性修复）', /overflow-x:\s*clip/.test(style)],
  ['容器查询 container-type', /container-type:\s*inline-size/.test(style)],
  ['避免 dvh 回退 vh', style.includes('100dvh')],
  ['新增：未进入营业模式 独立一屏', code.includes('未进入营业模式')],
  ['BlockedScreen 判据含跨源隔离', code.includes('当前环境不能营业')]
];
for (const [label, pass] of contentRows) check(label, pass);

/* ── 2. 真实浏览器：应用必须真的启动 ── */
console.log('\n===== 2. 浏览器实跑 =====');
// 沙箱里出网必须走代理：node 的 fetch 会自动读 HTTP_PROXY 环境变量，
// 但 Playwright 起的浏览器不会 —— 不显式给 proxy 就会 ERR_CONNECTION_CLOSED。
const proxyServer = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || undefined;
const browser = await chromium.launch({
  channel: 'msedge',
  ...(proxyServer ? { proxy: { server: proxyServer } } : {})
});
if (proxyServer) console.log(`（浏览器走代理 ${proxyServer}）`);

/** 打开一个干净的 context 并等启动完成。
 *  confirm 必须打桩：自动化环境里 window.confirm 默认返回 false，会走进「取消受限营业」
 *  分支——那是真实用户不一定会做的选择，不打桩的话量到的是假象。 */
async function openApp(path, { confirmReturn = true, viewport = { width: 1024, height: 768 } } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript((ret) => {
    window.confirm = () => ret;
  }, confirmReturn);
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  const isolated = await page.evaluate(() => globalThis.crossOriginIsolated);
  const text = await page.locator('body').innerText();
  return { ctx, page, errors, isolated, text };
}

// 横屏 iPad：摊主的主力设备
const main = await openApp('/', { confirmReturn: true });
check('crossOriginIsolated === true', main.isolated === true, String(main.isolated));
check('未出现「当前环境不能营业」', !main.text.includes('当前环境不能营业'));
check('应用越过启动屏（非 BootScreen）', !main.text.includes('正在准备离线数据库'),
  main.text.trim().split('\n')[0]);
check('首页无 console error', main.errors.length === 0, main.errors.slice(0, 2).join(' | '));
console.log('     首行: ' + main.text.trim().split('\n').slice(0, 3).join(' / '));
await main.ctx.close();

// 点取消受限营业 → 必须是「未进入营业模式」，不能是「环境不能营业」
const declined = await openApp('/', { confirmReturn: false });
check('取消受限营业 落到独立一屏', declined.text.includes('未进入营业模式'),
  declined.text.trim().split('\n')[0]);
check('取消受限营业 不再误报环境问题', !declined.text.includes('当前环境不能营业'));
await declined.ctx.close();

// /recover 路由已删除（用户拍板）。这里要验证的不是「它还能开」，
// 而是「它确实不再提供任何重置界面」—— 忘了 PIN 就没救了，这个状态必须被确认。
// 单实例锁会让第二个标签页被拦，所以用独立 context 且先关掉上一个。
const rec = await openApp('/recover', { confirmReturn: true });
check('/recover 不再提供重置界面', !/重置后台 PIN|开始重置|确认是你在操作/.test(rec.text),
  rec.text.trim().split('\n')[0]);
check('/recover 无 JS 报错', rec.errors.length === 0, rec.errors.slice(0, 2).join(' | '));
await rec.ctx.close();

await browser.close();

/* ── 汇总 ── */
const failed = results.filter(([, ok]) => !ok);
console.log('\n===== 汇总 =====');
console.log(`合计 ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) {
  console.log('失败项：');
  for (const [label, , detail] of failed) console.log('  - ' + label + (detail ? ' (' + detail + ')' : ''));
  process.exitCode = 1;
}
