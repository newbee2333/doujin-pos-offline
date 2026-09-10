#!/usr/bin/env node
/**
 * 把当前改动发成一个 Pull Request。
 *
 *   node scripts/git-pr.mjs --branch fix/ios-file-input \
 *        --title "fix: 修复 iOS 上 SQLite 文件无法选择" \
 *        --body "..." [--base main] [--draft]
 *
 * 流程：从最新 main 拉分支 → 提交全部改动 → 推送 → 用 gh 建 PR。
 * 前置：已安装 gh 并完成 gh auth login；工作区有未提交改动。
 */
import { execFileSync } from 'node:child_process';

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

// 分支名里的斜杠要换掉。
// 原因：本机沙箱文件系统留不住 .git/refs/heads/ 下的子目录，
// `git checkout -b feat/x` 会「报告成功」但引用根本没写出来，HEAD 变成 unborn，
// 紧接着的 commit 会成为一个没有父提交的根提交（跟 main 断了血缘）。
// 这是实测踩过的坑，别再改回斜杠。
const branch = branchRaw.replace(/\//g, '-');
if (branch !== branchRaw) {
  console.log(`注意：分支名 ${branchRaw} 中的斜杠已替换为连字符 → ${branch}`);
}

function git(...a) {
  return execFileSync('git', a, { encoding: 'utf8' }).trim();
}

/**
 * 确认 gh 可用并拿到凭据。
 *
 * 本机实测：gh 把 token 存在 Windows 凭据管理器里，
 * `gh auth status` 会误报「未登录」，但 `gh auth token` 能正常取到。
 * 所以这里以能否取到 token 为准，取到就注入 GH_TOKEN 供后续调用。
 */
function ensureGhAuth() {
  try {
    gh('auth', 'status');
    return {};
  } catch {
    // 退一步：直接取 token
  }
  let token = '';
  try {
    token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    console.error('gh 未登录，且取不到 token。请先执行：gh auth login');
    process.exit(3);
  }
  if (!token) {
    console.error('gh 未登录。请先执行：gh auth login');
    process.exit(3);
  }
  console.log('（gh auth status 误报未登录，已改用 gh auth token 注入凭据）');
  return { ...process.env, GH_TOKEN: token };
}

function gh(...a) {
  return execFileSync('gh', a, { encoding: 'utf8', env: GH_ENV }).trim();
}

const GH_ENV = ensureGhAuth();

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

console.log(`1/5 同步 ${base}…`);
try {
  git('pull', '--ff-only', 'origin', base);
} catch {
  console.log('   本地没有远端或无法快进，跳过（首次推送时正常）');
}

console.log(`2/5 创建分支 ${branch}…`);
git('checkout', '-b', branch);

console.log('3/5 提交…');
git('add', '-A');
execFileSync('git', ['commit', '-F', '-'], { input: body ? `${title}\n\n${body}\n` : `${title}\n`, encoding: 'utf8' });
console.log('   ' + git('log', '--oneline', '-1'));

console.log('4/5 推送…');
git('push', '-u', 'origin', branch);

console.log('5/5 创建 PR…');
const prArgs = ['pr', 'create', '--base', base, '--title', title, '--body', body || title];
if (has('draft')) prArgs.push('--draft');
const url = gh(...prArgs);
console.log('\nPR 已创建：' + url);
