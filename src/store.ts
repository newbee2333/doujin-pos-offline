/** 应用状态。会话、解锁、购物车与当前订单都存在内存里，不随数据库迁移。 */

import { create } from 'zustand';
import { db, type DbStatus, type Slot } from './db/client';
import type { CapabilityReport, PersistenceReport } from './db/storage-guard';
import { bindExecutor } from './services/context';

export interface CartItem {
  variantId: string;
  productName: string;
  variantName: string;
  priceMinor: number;
  quantity: number;
  maxAvailable: number | null;
  /** 封面图。购物车里没有小图的话，顾客核对"我到底加了哪个"只能靠品名。 */
  coverAssetId: string | null;
}

export type BootStage = 'idle' | 'checking' | 'ready' | 'blocked' | 'another-window' | 'error';

export interface BootDiagnostics {
  capabilities: CapabilityReport | null;
  persistence: PersistenceReport | null;
  ownershipReason?: string;
}

interface AppState {
  stage: BootStage;
  diagnostics: BootDiagnostics;
  error: string | null;
  dbStatus: DbStatus | null;
  currentEventId: string | null;
  staffUnlocked: boolean;
  cart: CartItem[];
  currentOrderId: string | null;
  /** 受限营业：持久化未获批但 OPFS 可写时由摊主显式选择。 */
  limitedMode: boolean;
  busy: number;
  toast: string | null;

  setDiagnostics: (d: Partial<BootDiagnostics>) => void;
  setStage: (s: BootStage, error?: string | null) => void;
  setDbStatus: (s: DbStatus | null) => void;
  setCurrentEvent: (id: string | null) => void;
  unlockStaff: () => void;
  lockStaff: () => void;
  setLimitedMode: (v: boolean) => void;
  setCart: (items: CartItem[]) => void;
  clearCart: () => void;
  setCurrentOrder: (id: string | null) => void;
  setBusy: (delta: number) => void;
  showToast: (msg: string | null) => void;
}

export const useApp = create<AppState>((set) => ({
  stage: 'idle',
  diagnostics: { capabilities: null, persistence: null },
  error: null,
  dbStatus: null,
  currentEventId: null,
  staffUnlocked: false,
  cart: [],
  currentOrderId: null,
  limitedMode: false,
  busy: 0,
  toast: null,

  setDiagnostics: (d) => set((s) => ({ diagnostics: { ...s.diagnostics, ...d } })),
  setStage: (stage, error = null) => set({ stage, error }),
  setDbStatus: (dbStatus) => set({ dbStatus }),
  setCurrentEvent: (currentEventId) => set({ currentEventId }),
  unlockStaff: () => set({ staffUnlocked: true }),
  lockStaff: () => set({ staffUnlocked: false, currentOrderId: null }),
  setLimitedMode: (limitedMode) => set({ limitedMode }),
  setCart: (cart) => set({ cart }),
  clearCart: () => set({ cart: [] }),
  setCurrentOrder: (currentOrderId) => set({ currentOrderId }),
  setBusy: (delta) => set((s) => ({ busy: Math.max(0, s.busy + delta) })),
  showToast: (toast) => set({ toast })
}));

const INIT_FLAG = 'doujin-pos:initialized';

export function isFirstLaunch(): boolean {
  try {
    return localStorage.getItem(INIT_FLAG) !== '1';
  } catch {
    return true;
  }
}

export function markInitialized() {
  try {
    localStorage.setItem(INIT_FLAG, '1');
  } catch {
    /* 忽略 */
  }
}

export function readStoredSlot(): Slot {
  try {
    return localStorage.getItem('doujin-pos:active-slot') === 'b' ? 'b' : 'a';
  } catch {
    return 'a';
  }
}

export function storeSlot(slot: Slot) {
  try {
    localStorage.setItem('doujin-pos:active-slot', slot);
  } catch {
    /* 忽略 */
  }
}

let bound = false;

/** 绑定服务层执行器并打开数据库。 */
export async function openDatabase(slot: Slot): Promise<DbStatus> {
  if (!bound) {
    bindExecutor(db);
    bound = true;
  }
  const status = await db.init(slot);
  storeSlot(status.slot);
  return status;
}

export function resetDatabaseBinding() {
  bound = false;
  db.reset();
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
