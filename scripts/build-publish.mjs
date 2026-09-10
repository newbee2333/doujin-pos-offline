#!/usr/bin/env node
/**
 * 生成自包含的发布目录：构建产物 + 零依赖 Node 静态服务器。
 *
 * 为什么不用「上传源码、云端构建」：
 *   1. 云端构建需要 devDependencies（vite/esbuild），而 playwright 的 postinstall 会尝试下载浏览器，
 *      在沙箱里既慢又容易失败；
 *   2. 这个应用必须有 COOP/COEP 响应头（opfs-sahpool 依赖 SharedArrayBuffer），
 *      纯静态托管拿不到自定义头，iPad 上会直接提示「当前环境不能营业」。
 * 所以发布目录 = dist 内容平铺 + 自带 server.mjs，云端无需安装任何依赖。
 *
 * 用法：node scripts/build-publish.mjs [输出目录]
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const outDir = resolve(process.argv[2] ?? join(projectRoot, '..', 'doujin-pos-live'));
const distDir = join(projectRoot, 'dist');

console.log('构建前端…');
// 直接调 vite 的 JS 入口：Windows 上 execFileSync 无法执行 npx.cmd
const viteBin = join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
execFileSync(process.execPath, [viteBin, 'build'], { cwd: projectRoot, stdio: 'inherit' });

if (!existsSync(join(distDir, 'index.html'))) {
  throw new Error('构建没有产出 dist/index.html，已中止');
}

console.log('准备发布目录：', outDir);
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// 平铺复制，不保留名为 dist 的目录（避免被当作构建产物跳过）
await cp(distDir, outDir, { recursive: true });

// 拷贝服务器实现
await cp(join(here, 'serve-static.mjs'), join(outDir, 'server.mjs'));

await writeFile(
  join(outDir, 'package.json'),
  JSON.stringify(
    {
      name: 'doujin-pos-live',
      private: true,
      type: 'module',
      // 无任何依赖，云端 installCmd 传空字符串即可跳过安装
      scripts: { start: 'node server.mjs .' }
    },
    null,
    2
  ),
  'utf8'
);

await writeFile(
  join(outDir, 'README.txt'),
  [
    'Doujin POS 线上预览版',
    '',
    '启动：node server.mjs .   （监听 $PORT，默认 4173）',
    '',
    '必要的响应头（server.mjs 已设置）：',
    '  Cross-Origin-Opener-Policy: same-origin',
    '  Cross-Origin-Embedder-Policy: require-corp',
    '缺少这两个头时，opfs-sahpool 无法取得 SharedArrayBuffer，',
    '应用会显示「当前环境不能营业」。',
    ''
  ].join('\n'),
  'utf8'
);

const files = await readdir(outDir);
console.log('发布目录就绪，顶层内容：', files.join(', '));
const indexHtml = await readFile(join(outDir, 'index.html'), 'utf8');
console.log('index.html 大小：', indexHtml.length, '字节');
