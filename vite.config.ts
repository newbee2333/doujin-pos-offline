import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'node:fs';
import path from 'node:path';

// opfs-sahpool VFS 依赖 SharedArrayBuffer，需要跨源隔离响应头。
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 手册用到的 Markdown 子集：标题/列表/表格/引用/加粗/行内代码/链接/裸 URL。 */
function inline(s: string): string {
  let t = escapeHtml(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  t = t.replace(
    /(^|[\s：、，。；（(])(https?:\/\/[^\s）)"']+)/g,
    '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>'
  );
  return t;
}

export function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { flush(); i += 1; continue; }
    if (/^-{3,}$/.test(line)) { flush(); out.push('<hr />'); i += 1; continue; }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (line.startsWith('>')) {
      flush();
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${buf.map((l) => (l ? `<p>${inline(l)}</p>` : '')).join('')}</blockquote>`);
      continue;
    }
    if (line.startsWith('|')) {
      flush();
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(lines[i].trim().slice(1, -1).split('|').map((c) => c.trim()));
        i += 1;
      }
      if (rows.length >= 2) {
        out.push(
          `<table><thead><tr>${rows[0].map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
            .slice(2)
            .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`
        );
      }
      continue;
    }
    if (/^[-*]\s+/.test(line) || /^\d+[.、]\s+/.test(line)) {
      flush();
      const ordered = /^\d+[.、]\s+/.test(line);
      const re = ordered ? /^\d+[.、]\s+/ : /^[-*]\s+/;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(re, ''));
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</${tag}>`);
      continue;
    }
    para.push(line);
    i += 1;
  }
  flush();
  return out.join('\n');
}

/**
 * 应用内说明书 = 仓库 README.md。
 * 构建期把 README 转成 HTML 注入：网页、GitHub 首页、应用内三处永远同源，不会漂移。
 */
function userManualPlugin(): Plugin {
  const virtualId = '\0virtual:manual-html';
  return {
    name: 'user-manual',
    resolveId(id) {
      return id === 'virtual:manual-html' ? virtualId : null;
    },
    load(id) {
      if (id !== virtualId) return null;
      const md = fs.readFileSync(path.resolve(process.cwd(), 'README.md'), 'utf8');
      return `export default ${JSON.stringify(mdToHtml(md))};`;
    },
    handleHotUpdate(ctx) {
      if (ctx.file.endsWith('README.md')) {
        ctx.server.ws.send({ type: 'full-reload' });
      }
    }
  };
}

export default defineConfig({
  plugins: [
    userManualPlugin(),
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icon.svg'],
      manifest: {
        name: 'Doujin POS 同人摊位电子菜单',
        short_name: 'Doujin POS',
        description: '本地优先的离线同人展摊位电子菜单与 POS 系统',
        lang: 'zh-CN',
        display: 'standalone',
        orientation: 'any',
        background_color: '#f6f5f2',
        theme_color: '#b3541e',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        navigateFallback: '/index.html'
      },
      devOptions: { enabled: false }
    })
  ],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  build: { outDir: 'dist', target: 'es2022' },
  server: { port: 5173, headers: isolationHeaders },
  preview: { port: 4173, headers: isolationHeaders }
});
