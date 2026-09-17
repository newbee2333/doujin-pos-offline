// styles.css 静态自检。
//
// 起因：两轮改动都出过「改 A 误伤 B」且**构建不报错**的问题：
//   1. 删 /recover 路由时向上扫描用了 /\{/，连带删掉了 /help 路由（→ verify-routes.mjs 已守住）
//   2. 删 .phrase-target 时 splice 区间没吃掉收尾的 `}`，留了一个多余的右括号。
//      CSS 里多一个 `}` 不会让构建失败，只会让它**后面**的第一条规则被吞掉 ——
//      当时是 .kv，而 .kv 用在设置页和订单详情，肉眼很难一眼看出。
//
// 所以这里做两件构建期不做的事：花括号配平、注释成对。
// 用法：node scripts/verify-css.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');

const results = [];
const check = (n, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`);
};

/* 逐字符走原文，自己维护「是否在注释内」。
   不要改用「先正则剥掉注释再数括号」—— 那会把多行注释的换行一起吃掉，
   报错行号对不上原文，排查时反而误导。 */
function scan(s) {
  let depth = 0;
  let inC = false;
  let line = 1;
  let firstNeg = null;
  let maxDepth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\n') {
      line++;
      continue;
    }
    if (!inC && c === '/' && s[i + 1] === '*') {
      inC = true;
      i++;
      continue;
    }
    if (inC && c === '*' && s[i + 1] === '/') {
      inC = false;
      i++;
      continue;
    }
    if (inC) continue;
    if (c === '{') {
      depth++;
      if (depth > maxDepth) maxDepth = depth;
    } else if (c === '}') {
      depth--;
      if (depth < 0 && firstNeg === null) firstNeg = line;
    }
  }
  return { depth, firstNeg, maxDepth, inC };
}

const r = scan(src);
check('花括号配平', r.depth === 0, `深度 ${r.depth}${r.firstNeg ? `，首个多余 } 在第 ${r.firstNeg} 行` : ''}，最大嵌套 ${r.maxDepth}`);
check('没有未闭合的 /* 注释', !r.inC);

// 剥掉成对注释后不应再有注释标记
const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '');
check('注释成对', !/\/\*|\*\//.test(stripped));

// 本轮引入 / 依赖的令牌必须存在
for (const t of ['--pin-key', '--tap-sm', '--fs-order-no', '--fs-nav', '--panel-h']) {
  check(`令牌存在 ${t}`, new RegExp(`${t}\\s*:`).test(stripped));
}
// 已删除的死令牌不该回来
for (const t of ['--row-h', '--radius-card', '--radius-ctl']) {
  check(`死令牌未复活 ${t}`, !new RegExp(`var\\(${t}\\)`).test(stripped));
}
// 关键判定：列数由 auto-fill 自己算，不要改回固定列数
// 列数交给 auto-fill 自己算，不要改回固定列数；最小宽是 140px（见 .pos-grid 上的注释）
check('.pos-grid 用 auto-fill + minmax(140px)', /\.pos-grid \{[\s\S]*?grid-template-columns: repeat\(auto-fill, minmax\(140px, 1fr\)\)/.test(stripped));
// 两栏块（收银台 / 待付款）的高度来源。
// 当前是 calc 预算 —— 这仍然是**有缺陷**的写法：它按「上方留白 250px」
// 硬估，而不是由布局算出来。2026-09-17 起备份提醒条那 74px 由
// .content:has(> .backup-nudge) 单独补了一条预算，溢出 19px 的现场症状没了，
// 但根因（定高估算）还在：改动上方任何一块留白，都要记得同步这几个数字。
// 所以这条断言的是「现状」，不是「理想」；哪天改成 flex / 定高方案时它会失败，
// 提醒你把 styles.css 里那份说明一起更新。
const block = stripped.match(/\.cols-side\.pos-layout,\r?\n\.cols-side\.queue-layout \{[^}]*\}/);
const blockText = block ? block[0].replace(/\s+/g, ' ') : '';
check('两栏块高度 = var(--panel-h)（calc 预算，根因未除）', /height: var\(--panel-h\)/.test(blockText), blockText.slice(0, 60));
check(
  '备份提醒条存在时另有高度预算（:has(> .backup-nudge)）',
  /:has\(> \.backup-nudge\) \.cols-side\.pos-layout/.test(stripped)
);
check('.content 的 overflow-x 是 clip（改回 hidden 会让所有 sticky 失效）', /\.content \{[\s\S]*?overflow-x: clip/.test(stripped));

const bad = results.filter((x) => !x).length;
console.log(`\n合计 ${results.length} 项，通过 ${results.length - bad}，失败 ${bad}`);
if (bad) process.exitCode = 1;
