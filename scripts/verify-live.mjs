/** 线上部署验证：响应头 + 新设计特征是否都在产物里。 */
const base = 'https://d0a4166b6973444faaf7e2ef6e9724cd.app.workbuddy.link';

(async () => {
  const r = await fetch(base + '/');
  console.log('首页', r.status, '| COOP:', r.headers.get('cross-origin-opener-policy'), '| COEP:', r.headers.get('cross-origin-embedder-policy'));
  const html = await r.text();
  const js = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1];
  const css = html.match(/assets\/(index-[A-Za-z0-9_-]+\.css)/)?.[1];
  console.log('入口 JS:', js, '| CSS:', css);
  const code = await (await fetch(base + '/assets/' + js)).text();
  const style = await (await fetch(base + '/assets/' + css)).text();

  const rows = [
    ['购物车缩略图 cart-thumb', code.includes('cart-thumb')],
    ['购物车带封面 coverAssetId', code.includes('coverAssetId')],
    ['新卡片作用域 menu-card-cover', code.includes('menu-card-cover')],
    ['封面窗口 6:5', /aspect-ratio:\s*6\s*\/\s*5/.test(style)],
    ['裁切重心上移 center top', /object-position:\s*center top/.test(style)],
    ['售罄覆盖层 sold-veil', code.includes('sold-veil') || style.includes('sold-veil')],
    ['减少动效 prefers-reduced-motion', style.includes('prefers-reduced-motion')]
  ];
  for (const [label, pass] of rows) {
    console.log('  ' + label.padEnd(30), pass ? '✅' : '❌');
  }
})();
