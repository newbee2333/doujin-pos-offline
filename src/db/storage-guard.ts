/**
 * 运行前检查与单写所有权（第 4 节）。
 *
 * 检查项与「写入失败」区分开：能力缺失、持久化未获批、OPFS 不可写
 * 是三种不同的失败，不能混为一谈；也不能因为其中一项失败就静默回退到内存库。
 */

export interface CapabilityReport {
  secureContext: boolean;
  crossOriginIsolated: boolean;
  webAssembly: boolean;
  worker: boolean;
  opfs: boolean;
  serviceWorker: boolean;
  webLocks: boolean;
  sharedArrayBuffer: boolean;
  details: string[];
}

export async function checkCapabilities(): Promise<CapabilityReport> {
  const details: string[] = [];
  const secureContext = typeof isSecureContext !== 'undefined' ? isSecureContext : false;
  const crossOriginIsolated = typeof globalThis.crossOriginIsolated === 'boolean' ? globalThis.crossOriginIsolated : false;
  const webAssembly = typeof WebAssembly === 'object';
  const worker = typeof Worker === 'function';
  const webLocks = typeof navigator !== 'undefined' && 'locks' in navigator;
  const sharedArrayBuffer = typeof SharedArrayBuffer === 'function';

  let opfs = false;
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function') {
      const root = await navigator.storage.getDirectory();
      opfs = !!root;
    }
  } catch (e) {
    details.push(`OPFS 目录访问失败：${e instanceof Error ? e.message : String(e)}`);
  }

  const serviceWorker = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

  if (!secureContext) details.push('当前不是安全上下文（需要 HTTPS 或 localhost）');
  if (!crossOriginIsolated) details.push('未启用跨源隔离，opfs-sahpool 需要 COOP/COEP 响应头');
  if (!sharedArrayBuffer) details.push('SharedArrayBuffer 不可用');
  if (!webAssembly) details.push('WebAssembly 不可用');
  if (!opfs) details.push('OPFS 不可用');

  return {
    secureContext,
    crossOriginIsolated,
    webAssembly,
    worker,
    opfs,
    serviceWorker,
    webLocks,
    sharedArrayBuffer,
    details
  };
}

export interface PersistenceReport {
  supported: boolean;
  persistedBefore: boolean;
  persistedAfter: boolean;
  granted: boolean;
  usageBytes: number | null;
  quotaBytes: number | null;
  error: string | null;
}

export async function requestPersistence(): Promise<PersistenceReport> {
  const empty: PersistenceReport = {
    supported: false,
    persistedBefore: false,
    persistedAfter: false,
    granted: false,
    usageBytes: null,
    quotaBytes: null,
    error: null
  };
  if (typeof navigator === 'undefined' || !navigator.storage) {
    return { ...empty, error: '浏览器不支持 StorageManager' };
  }
  try {
    const persistedBefore = await navigator.storage.persisted();
    let granted = persistedBefore;
    if (!persistedBefore && typeof navigator.storage.persist === 'function') {
      granted = await navigator.storage.persist();
    }
    let usageBytes: number | null = null;
    let quotaBytes: number | null = null;
    if (typeof navigator.storage.estimate === 'function') {
      const est = await navigator.storage.estimate();
      usageBytes = typeof est.usage === 'number' ? est.usage : null;
      quotaBytes = typeof est.quota === 'number' ? est.quota : null;
    }
    return {
      supported: true,
      persistedBefore,
      persistedAfter: await navigator.storage.persisted(),
      granted,
      usageBytes,
      quotaBytes,
      error: null
    };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface Ownership {
  ok: boolean;
  release: () => void;
  reason?: string;
}

const LOCK_NAME = 'doujin-pos:db-owner';

/**
 * 用 Web Locks 取得同源同存储的独占所有权。未拿到锁的窗口不能启动第二个
 * 可写实例；不支持 Web Locks 时只能单窗口运行，明确标记。
 */
export function acquireOwnership(): Promise<Ownership> {
  if (typeof navigator === 'undefined' || !('locks' in navigator)) {
    return Promise.resolve({ ok: true, release: () => undefined, reason: '浏览器不支持 Web Locks，请只开一个窗口' });
  }
  return new Promise<Ownership>((resolve) => {
    let releaseLock: (() => void) | null = null;
    navigator.locks
      .request(
        LOCK_NAME,
        { mode: 'exclusive', ifAvailable: true } as LockOptions,
        (lock: Lock | null) => {
          if (lock === null) {
            resolve({ ok: false, release: () => undefined });
            return Promise.resolve();
          }
          resolve({ ok: true, release: () => releaseLock && releaseLock() });
          return new Promise<void>((r) => {
            releaseLock = r;
          });
        }
      )
      .catch(() => {
        resolve({ ok: true, release: () => undefined, reason: 'Web Locks 请求失败，按单窗口运行' });
      });
  });
}

/** BroadcastChannel 只用于状态通知，不承载互斥语义。 */
export function createStateChannel(onMessage: (msg: unknown) => void): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const ch = new BroadcastChannel('doujin-pos:state');
  ch.onmessage = (ev) => onMessage(ev.data);
  return ch;
}
