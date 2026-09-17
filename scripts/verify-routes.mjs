// 路由表完整性自检。
//
// 起因：删 /recover 路由时，脚本里「向上吃注释」的循环用了 /\{/ 当条件，
// 任何含 `{` 的行都会被吃掉，结果连 <Route path="/help"> 一起删掉了。
// typecheck 抓不到（未使用的 import 不算错），构建也不报错 —— 只有真打开页面才发现。
//
// 用法：node scripts/verify-routes.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'App.tsx'), 'utf8');

const routes = [...src.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('路由表：', routes.join('  '));
console.log('');

// 每条路由都必须还在。少了任何一条，都是「改 A 误删 B」的信号。
const REQUIRED = [
  '/',
  '/kiosk',
  '/kiosk/cart',
  '/kiosk/checkout',
  '/kiosk/order/:id',
  '/staff/checkout',
  '/staff/pending',
  '/staff/products',
  '/staff/events',
  '/staff/inventory',
  '/staff/orders',
  '/staff/reports',
  '/staff/backup',
  '/settings',
  '/preview',
  '/help'
];
for (const r of REQUIRED) check(`路由存在 ${r}`, routes.includes(r));

// 兜底路由必须是最后一条
const star = routes.indexOf('*');
check('兜底路由 * 存在且是最后一条', star >= 0 && star === routes.length - 1, `位置 ${star}/${routes.length - 1}`);

// 自助重置已删
check('/recover 路由已移除', !routes.includes('/recover'));

// 说明书必须不经过 StaffGuard（锁着也要能看）。
// 先剥掉注释再判：说明性注释里本身就写了「不加 StaffGuard」这几个字，
// 不剥会把自己的注释当成违规代码。
{
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const i = codeOnly.indexOf('<Route path="/help"');
  const seg = codeOnly.slice(i, i + 120);
  check('说明书不加 StaffGuard', !/StaffGuard/.test(seg), seg.trim().slice(0, 60));
}

// 侧栏链接指向的路由必须都存在，否则点了会静默落到兜底路由
{
  const links = [...src.matchAll(/<NavLink\s+to="([^"]+)"/g)].map((m) => m[1]);
  const missing = [...new Set(links)].filter((l) => !routes.includes(l) && !l.startsWith('/kiosk/order'));
  check('侧栏链接都有对应路由', missing.length === 0, missing.length ? '缺：' + missing.join(', ') : `${new Set(links).size} 个链接`);
}

const bad = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`);
if (bad.length) process.exitCode = 1;
