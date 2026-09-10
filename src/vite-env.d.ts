/// <reference types="vite/client" />

declare module 'virtual:manual-html' {
  /** 由 vite.config.ts 的 userManualPlugin 在构建期从仓库 README.md 生成 */
  const html: string;
  export default html;
}
