/**
 * 生成 4 张竖版演示封面（1:1.4，书本比例）。
 *
 * 为什么要这个：本轮改动的关键是「裁切填满 + 重心上移」——
 * 但只有在真实竖版封面上才看得出效果，占位斜纹块什么都演示不了。
 * 每张封面把书名放在顶部，用来验证裁切后书名是否仍然完整。
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = 'scripts/fixtures';
await mkdir(OUT, { recursive: true });

const covers = [
  { file: 'cover-1.png', top: '#b3541e', art: '#e8d5c0', accent: '#8f3f14', title: '小护士立牌', sub: 'ACRYLIC STAND' },
  { file: 'cover-2.png', top: '#2f5d7d', art: '#cfe0ea', accent: '#1e3f57', title: 'vn恋恋高速路', sub: 'DOUJINSHI' },
  { file: 'cover-3.png', top: '#3f6b52', art: '#d3e4d8', accent: '#28483a', title: '亚克力钥匙扣', sub: 'KEYCHAIN' },
  { file: 'cover-4.png', top: '#6b3f6b', art: '#e2d3e2', accent: '#4a2a4a', title: '无料贴纸', sub: 'FREE STICKER' }
];

const browser = await chromium.launch({ channel: process.env.SMOKE_CHANNEL ?? 'msedge', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 600, height: 840 }, deviceScaleFactor: 1 });

for (const c of covers) {
  const html = `<!doctype html><html><body style="margin:0;width:600px;height:840px;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">
  <div style="width:600px;height:840px;background:${c.art};display:flex;flex-direction:column;position:relative;overflow:hidden">
    <div style="height:150px;background:${c.top};display:flex;flex-direction:column;justify-content:center;padding:0 44px;box-sizing:border-box">
      <div style="color:#fff;font-size:44px;font-weight:500;line-height:1.2">${c.title}</div>
      <div style="color:rgba(255,255,255,.72);font-size:17px;letter-spacing:.14em;margin-top:8px">${c.sub}</div>
    </div>
    <div style="flex:1;position:relative">
      <div style="position:absolute;left:70px;top:90px;width:300px;height:300px;border-radius:50%;background:${c.accent};opacity:.22"></div>
      <div style="position:absolute;left:190px;top:210px;width:260px;height:260px;background:${c.accent};opacity:.32;transform:rotate(18deg)"></div>
      <div style="position:absolute;left:60px;bottom:120px;right:60px;height:2px;background:${c.accent};opacity:.3"></div>
      <div style="position:absolute;left:60px;bottom:74px;color:${c.accent};font-size:15px;opacity:.75">标题在顶部 · 底部是装饰区</div>
    </div>
    <div style="height:96px;background:${c.accent};display:flex;align-items:center;padding:0 44px;box-sizing:border-box">
      <div style="color:rgba(255,255,255,.85);font-size:14px">底部说明区 · 裁掉不影响识别</div>
    </div>
  </div></body></html>`;
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: `${OUT}/${c.file}`, clip: { x: 0, y: 0, width: 600, height: 840 } });
  console.log('  生成', c.file);
}

await browser.close();
console.log('完成，输出目录：', OUT);
