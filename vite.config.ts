import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// opfs-sahpool VFS 依赖 SharedArrayBuffer，需要跨源隔离响应头。
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

export default defineConfig({
  plugins: [
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
