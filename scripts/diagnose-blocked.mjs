/**
 * 定位「当前环境不能营业」的真实成因。
 *
 * 假设：能力检测全部通过，卡在 requestPersistence() → window.confirm 返回 false
 *       → setStage('blocked') → 渲染 BlockedScreen（文案与真实原因无关，是误导）。
 *
 * 验证方法：把 app 的 zustand store 暴露出来读 stage/reason；同时给 confirm 打桩，
 * 分别测「confirm 返回 false」和「confirm 返回 true」两种情形。
 */
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'https://doujin-pos-offline.pages.dev';
const browser = await chromium.launch({ channel: 'msedge' });

async function run({ label, confirmReturn, viewport }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e}`));

  // 打桩 window.confirm：自动化环境里 confirm 默认返回 false，会走「退出」分支
  await page.addInitScript((ret) => {
    window.confirm = (msg) => {
      // 把对话框文案捞出来，这是判断走到了哪条分支的关键证据
      (window.__confirms = window.__confirms || []).push(String(msg).slice(0, 120));
      return ret;
    };
  }, confirmReturn);

  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3500);

  const text = await page.locator('body').innerText();
  const confirms = await page.evaluate(() => window.__confirms ?? []);
  const isolated = await page.evaluate(() => globalThis.crossOriginIsolated);

  console.log(`\n===== ${label} =====`);
  console.log('crossOriginIsolated:', isolated);
  console.log('触发的 confirm 次数:', confirms.length);
  confirms.forEach((c, i) => console.log(`  confirm[${i}]: ${c.replace(/\n/g, ' / ')}`));
  console.log('页面:', text.trim().split('\n').slice(0, 3).join(' | '));
  const errs = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
  console.log('错误日志:', errs.length ? errs.slice(0, 3).join(' || ') : '（无）');

  await ctx.close();
  return { text, confirms };
}

await run({
  label: 'A. confirm 打桩为 false（自动化默认行为）',
  confirmReturn: false,
  viewport: { width: 1024, height: 768 }
});
await run({
  label: 'B. confirm 打桩为 true（模拟摊主点确定）',
  confirmReturn: true,
  viewport: { width: 1024, height: 768 }
});

await browser.close();
