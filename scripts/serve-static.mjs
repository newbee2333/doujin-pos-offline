#!/usr/bin/env node
/**
 * 本地静态服务器：为 dist/ 加上 opfs-sahpool 必需的跨源隔离响应头。
 *
 *   node scripts/serve-static.mjs              # HTTP，仅桌面自测（Service Worker 需要安全上下文）
 *   node scripts/serve-static.mjs --cert ./certs/cert.pem --key ./certs/key.pem
 *
 * 要在 iPad 上装 PWA 必须 HTTPS 且证书被信任（localhost 除外）。
 * 推荐用 mkcert 签发局域网证书并在 iPad 上安装根证书，或直接用 Cloudflare Pages / Netlify 部署。
 * 自签名证书在 iOS Safari 上无法用于 Service Worker。
 */
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';

const ROOT = resolve(process.env.SERVE_ROOT ?? process.argv[2] ?? 'dist');
const PORT = Number(process.env.PORT ?? 4173);
// 云上必须绑 0.0.0.0，否则反向代理连不进来
const HOST = process.env.HOST ?? '0.0.0.0';

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const certPath = arg('cert');
const keyPath = arg('key');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.sqlite3': 'application/x-sqlite3'
};

const HEADERS = {
  // opfs-sahpool 依赖 SharedArrayBuffer，必须跨源隔离
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // 避免旧版本被缓存导致升级后读不到新 schema
  'Cache-Control': 'no-cache'
};

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

async function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  let rel = normalize(clean).replace(/^(\.\.[/\\])+/, '');
  if (rel === '/' || rel === '\\') rel = '/index.html';
  let full = join(ROOT, rel);
  if (!full.startsWith(ROOT)) return null; // 防目录穿越
  try {
    const st = await stat(full);
    if (st.isDirectory()) full = join(full, 'index.html');
  } catch {
    // 找不到：SPA 回退
    if (extname(rel) === '') full = join(ROOT, 'index.html');
    else return null;
  }
  return full;
}

const handler = async (req, res) => {
  const file = await resolveFile(req.url ?? '/');
  if (!file) {
    res.writeHead(404, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      ...HEADERS,
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length
    });
    res.end(body);
  } catch {
    res.writeHead(404, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
};

if (certPath && keyPath) {
  const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
  createHttpsServer({ cert, key }, handler).listen(PORT, HOST, () => {
    console.log(`HTTPS 已启动（含 COOP/COEP）：`);
    console.log(`  https://localhost:${PORT}`);
    for (const ip of lanAddresses()) console.log(`  https://${ip}:${PORT}`);
  });
} else {
  createServer(handler).listen(PORT, HOST, () => {
    console.log(`HTTP 已启动（含 COOP/COEP）：http://localhost:${PORT}`);
    for (const ip of lanAddresses()) console.log(`  http://${ip}:${PORT}`);
    console.log('');
    console.log('提示：Service Worker / PWA 安装需要 HTTPS 或 localhost。');
    console.log('在 iPad 上测试请用 --cert/--key 提供被信任的证书，或部署到静态托管。');
  });
}
