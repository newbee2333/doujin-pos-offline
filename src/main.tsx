import { createRoot } from 'react-dom/client';
import App from './App';
import { Toast } from './ui/components';
import './styles.css';

/**
 * PWA 更新：registerType 为 prompt，营业页不会自动 reload。
 * 只在空闲时提示，由摊主决定何时更新。
 */
async function setupPwa() {
  try {
    const { registerSW } = await import('virtual:pwa-register');
    const updateSW = registerSW({
      immediate: false,
      onNeedRefresh() {
        const el = document.createElement('div');
        el.className = 'toast';
        el.style.bottom = '76px';
        el.textContent = '发现新版本，建议营业结束后更新';
        const btn = document.createElement('button');
        btn.className = 'small primary';
        btn.style.marginLeft = '12px';
        btn.textContent = '立即更新';
        btn.onclick = () => {
          el.remove();
          void updateSW(true);
        };
        const later = document.createElement('button');
        later.className = 'small';
        later.style.marginLeft = '6px';
        later.textContent = '稍后';
        later.onclick = () => el.remove();
        el.appendChild(btn);
        el.appendChild(later);
        document.body.appendChild(el);
      }
    });
    void updateSW;
  } catch {
    // 开发模式或未生成 SW 时忽略
  }
}

void setupPwa();

// 不使用 StrictMode：启动阶段会重复执行 Effect，导致 Web Locks 所有权被自己占用
createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <Toast />
  </>
);
