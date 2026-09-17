/**
 * 线上诊断：打开页面并 dump 拒绝启动卡片里的能力表格。
 * 目的：区分「应用真的启动不了」和「只是我的断言写得不对」。
 */
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'https://doujin-pos-offline.pages.dev';
const browser = await chromium.launch({ channel: 'msedge' });

for (const vp of [
  { width: 1024, height: 768, label: '横屏 iPad 1024×768' },
  { width: 390, height: 844, label: '手机 390×844' }
]) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  const probe = await page.evaluate(() => ({
    isolated: globalThis.crossOriginIsolated,
    secure: globalThis.isSecureContext,
    sab: typeof SharedArrayBuffer !== 'undefined',
    wasm: typeof WebAssembly !== 'undefined',
    opfs: !!(navigator.storage && navigator.storage.getDirectory)
  }));
  console.log(`\n===== ${vp.label} =====`);
  console.log('crossOriginIsolated:', probe.isolated);
  console.log('isSecureContext:    ', probe.secure);
  console.log('SharedArrayBuffer:  ', probe.sab);
  console.log('WebAssembly:        ', probe.wasm);
  console.log('OPFS api:           ', probe.opfs);

  const text = await page.locator('body').innerText();
  const refused = text.includes('当前环境不能营业');
  console.log('渲染的是拒绝启动卡片:', refused);
  if (refused) {
    console.log('--- 卡片内容 ---');
    console.log(text.trim().slice(0, 500));
  } else {
    console.log('--- 正常页面首行 ---');
    console.log(text.trim().split('\n').slice(0, 6).join(' / '));
  }
  await ctx.close();
}

// 原来的 /recover 探测段已删：自助重置整条功能被移除，那个路由不再存在。

await browser.close();
