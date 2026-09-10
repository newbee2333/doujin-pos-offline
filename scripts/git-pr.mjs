#!/usr/bin/env node
/**
 * 把当前改动发成一个 Pull Request。
 *
 *   node scripts/git-pr.mjs --branch fix-ios-file-input \
 *        --title "fix: 修复 iOS 上 SQLite 文件无法选择" \
 *        --body "..." [--base main] [--draft]
 *
 * 流程：同步 base → 创建分支 → 提交全部改动 → 推送 → 用 gh 建 PR。
 * 前置：工作区有未提交改动，且当前在 base 分支上。
 *
 * 本机环境的三个坑，代码里都做了规避（别改回去）：
 *
 *  1. 分支名不能带斜杠。.git/refs/heads/ 下的子目录留不住，
 *     `git checkout -b feat/x` 会「报告成功」但引用没写出来，HEAD 变成 unborn，
 *     紧接着的 commit 会变成没有父提交的根提交，跟 base 断了血缘。
 *     所以下面统一把 `/` 换成 `-`。
 *
 *  2. 不能用 origin/<branch> 这种远端跟踪引用。它需要
 *     .git/refs/remotes/origin/ 子目录，同样留不住，`origin/main` 解析不了。
 *     改用 `git fetch origin <base>` + FETCH_HEAD（FETCH_HEAD 是文件，没问题）。
 *
 *  3. gh 不一定在 PATH 里（winget 装完已开的终端不会刷新 PATH）。
 *     所以会去常见安装位置找一遍。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const branchRaw = arg('branch');
const title = arg('title');
const body = arg('body', '');
const base = arg('base', 'main');

if (!branchRaw || !title) {
  console.error('用法：node scripts/git-pr.mjs --branch <名> --title <标题> [--body <说明>] [--base main] [--draft]');
  process.exit(2);
}

const branch = branchRaw.replace(/\//g, '-');
if (branch !== branchRaw) {
  console.log(`注意：分支名 ${branchRaw} 中的斜杠已替换为连字符 → ${branch}`);
}

/* ---------------------------------------------------------------- git */

function git(...a) {
  return execFileSync('git', a, { encoding: 'utf8' }).trim();
}

function gitErr(e) {
  const raw = e && e.stderr ? String(e.stderr) : String((e && e.message) || e);
  return raw.trim().split('\n').slice(-3).join('\n');
}

/* ----------------------------------------------------------------- gh */

const GH_CANDIDATES = [
  process.env.GH_BIN,
  'gh',
  'C:\\Program Files\\GitHub CLI\\gh.exe',
  'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe') : null,
  '/usr/local/bin/gh',
  '/opt/homebrew/bin/gh'
].filter(Boolean);

function resolveGh() {
  for (const c of GH_CANDIDATES) {
    if (c !== 'gh' && !existsSync(c)) continue;
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {
      // 继续试下一个
    }
  }
  return null;
}

const GH_BIN = resolveGh();
if (!GH_BIN) {
  console.error('找不到 gh（GitHub CLI）。');
  console.error('请安装：winget install --id GitHub.cli');
  console.error('若已安装，可用环境变量指定：GH_BIN="C:\\Program Files\\GitHub CLI\\gh.exe"');
  process.exit(3);
}
if (GH_BIN !== 'gh') console.log(`（gh 不在 PATH，已定位到 ${GH_BIN}）`);

/**
 * 拿到可用的 gh 凭据。
 *
 * 本机实测：gh 把 token 存在 Windows 凭据管理器里，`gh auth status`
 * 会误报「未登录」，但 `gh auth token` 能正常取到。所以以能否取到 token 为准。
 */
function ensureGhAuth() {
  try {
    execFileSync(GH_BIN, ['auth', 'status'], { stdio: 'ignore' });
    return { ...process.env };
  } catch {
    // 退一步：直接取 token
  }
  let token = '';
  try {
    token = execFileSync(GH_BIN, ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    token = '';
  }
  if (!token) {
    console.error('gh 已安装但没有可用凭据。请执行：gh auth login');
    console.error('（认证方式请选「Login with a web browser」，不要粘贴细粒度 PAT —— 那种令牌建不了仓库）');
    process.exit(3);
  }
  console.log('（gh auth status 误报未登录，已改用 gh auth token 注入凭据）');
  return { ...process.env, GH_TOKEN: token };
}

const GH_ENV = ensureGhAuth();

function gh(...a) {
  return execFileSync(GH_BIN, a, { encoding: 'utf8', env: GH_ENV }).trim();
}

/* -------------------------------------------------------------- 前置检查 */

const dirty = git('status', '--porcelain');
if (!dirty) {
  console.error('工作区没有改动，没什么可提交的。');
  process.exit(4);
}

const current = git('rev-parse', '--abbrev-ref', 'HEAD');
if (current !== base) {
  console.error(`当前在分支 ${current}，请先切回 ${base} 再执行（避免分支套分支）。`);
  process.exit(5);
}

/* ------------------------------------------------------------------ 执行 */

console.log(`1/6 同步 ${base}…`);
const remotes = git('remote').split('\n').map((s) => s.trim());
if (!remotes.includes('origin')) {
  console.log('   没有 origin 远端，跳过同步（首次本地使用属正常）');
} else {
  try {
    git('fetch', 'origin', base);
    const fetched = git('rev-parse', 'FETCH_HEAD');
    const head = git('rev-parse', 'HEAD');
    if (fetched !== head) {
      try {
        git('merge', '--ff-only', 'FETCH_HEAD');
      } catch {
        console.error(`   本地 ${base} 与 origin/${base} 已经分叉，无法快进。`);
        console.error('   请先手工处理（例如 git rebase 或 git reset --hard），再重跑本脚本。');
        process.exit(6);
      }
    }
    console.log(`   已同步到 ${fetched.slice(0, 7)}`);
  } catch (e) {
    console.error(`   同步失败：${gitErr(e)}`);
    console.error('   为避免基于过期代码开 PR，已中止。请检查网络/代理后重试。');
    process.exit(6);
  }
}

console.log(`2/6 创建分支 ${branch}…`);
if (git('branch').split('\n').some((b) => b.replace(/^\*/, '').trim() === branch)) {
  console.error(`分支 ${branch} 已存在，请换个名字或先删除它。`);
  process.exit(7);
}
git('checkout', '-b', branch);

console.log('3/6 提交…');
git('add', '-A');
execFileSync('git', ['commit', '-F', '-'], {
  input: body ? `${title}\n\n${body}\n` : `${title}\n`,
  encoding: 'utf8'
});
console.log('   ' + git('log', '--oneline', '-1'));

console.log('4/6 推送…');
try {
  git('push', '-u', 'origin', branch);
} catch (e) {
  const msg = gitErr(e);
  if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(msg)) {
    console.error('   推送失败：git 没有可用凭据。执行一次 gh auth setup-git 即可。');
  } else {
    console.error(`   推送失败：${msg}`);
  }
  process.exit(8);
}

console.log('5/6 创建 PR…');
const prArgs = ['pr', 'create', '--base', base, '--title', title, '--body', body || title];
if (has('draft')) prArgs.push('--draft');

let url = '';
try {
  url = gh(...prArgs);
} catch (e) {
  console.error('   创建 PR 失败，分支已经推上去了，可以到网页上手动开 PR。');
  console.error('   ' + gitErr(e));
  process.exit(9);
}

console.log('6/6 完成');
console.log('\nPR 已创建：' + url);
