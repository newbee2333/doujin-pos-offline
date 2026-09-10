/** 设置、PIN、备份与恢复编排（第 21、22、24 节）。 */

import { db } from '../db/client';
import type { Slot } from '../db/client';
import type { ImportSummary } from '../db/worker';
import { getSetting, setSetting } from './context';
import { DomainError } from './catalog';

export interface BackupState {
  lastExportAt: string | null;
  lastConfirmedSavedAt: string | null;
}

export async function getBackupState(): Promise<BackupState> {
  const [lastExportAt, lastConfirmedSavedAt] = await Promise.all([
    getSetting('backup.last_export_at'),
    getSetting('backup.last_confirmed_saved_at')
  ]);
  return { lastExportAt, lastConfirmedSavedAt };
}

/** 导出生成成功 ≠ 用户已保存。两者分别记录。 */
export async function markExported(): Promise<void> {
  await setSetting('backup.last_export_at', new Date().toISOString());
}

export async function markConfirmedSaved(): Promise<void> {
  await setSetting('backup.last_confirmed_saved_at', new Date().toISOString());
}

const BACKUP_REMIND_HOURS = 24;

export async function shouldRemindBackup(): Promise<boolean> {
  const state = await getBackupState();
  const ref = state.lastConfirmedSavedAt ?? state.lastExportAt;
  if (!ref) return true;
  const elapsed = Date.now() - new Date(ref).getTime();
  return elapsed > BACKUP_REMIND_HOURS * 3600 * 1000;
}

/* ------------------------------------------------------------------ PIN */

const PIN_KEY = 'security.pin_hash';
const PIN_SALT_KEY = 'security.pin_salt';

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPin(pin: string, salt: string): Promise<string> {
  const enc = new TextEncoder().encode(`${salt}:${pin}`);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    // 无 WebCrypto 环境下退化为简单混淆，仅防误触
    let h = 0;
    for (let i = 0; i < enc.length; i++) h = (Math.imul(h, 31) + enc[i]) >>> 0;
    return `weak-${h.toString(16)}`;
  }
  return toHex(await subtle.digest('SHA-256', enc));
}

export async function isPinSet(): Promise<boolean> {
  return (await getSetting(PIN_KEY)) !== null;
}

export async function setPin(pin: string): Promise<void> {
  if (!/^\d{4,8}$/.test(pin)) throw new DomainError('PIN 请设置为 4 到 8 位数字');
  const salt =
    (await getSetting(PIN_SALT_KEY)) ??
    Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
  await setSetting(PIN_SALT_KEY, salt);
  await setSetting(PIN_KEY, await hashPin(pin, salt));
}

export async function verifyPin(pin: string): Promise<boolean> {
  const stored = await getSetting(PIN_KEY);
  const salt = await getSetting(PIN_SALT_KEY);
  if (stored === null || salt === null) return false;
  return (await hashPin(pin, salt)) === stored;
}

/* -------------------------------------------------------------- 当前展会 */

export async function getCurrentEventId(): Promise<string | null> {
  return getSetting('app.current_event_id');
}

export async function setCurrentEventId(id: string | null): Promise<void> {
  await setSetting('app.current_event_id', id ?? '');
}

/* ---------------------------------------------------------------- 导出 */

export function suggestFileName(eventName?: string): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const base = (eventName ?? 'circle').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || 'circle';
  return `${base}-${stamp}.sqlite3`;
}

/** 保存字节到本地。优先使用文件保存对话框，其次浏览器下载。 */
export async function saveBytes(bytes: Uint8Array, filename: string): Promise<'picker' | 'download'> {
  const w = window as unknown as {
    showSaveFilePicker?: (opts: unknown) => Promise<{
      createWritable: () => Promise<{ write: (data: Uint8Array) => Promise<void>; close: () => Promise<void> }>;
    }>;
  };
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'SQLite 数据库', accept: { 'application/x-sqlite3': ['.sqlite3', '.db'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return 'picker';
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw new DomainError('已取消保存');
      // 其他错误退回下载
    }
  }
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/x-sqlite3' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return 'download';
}

export function canShareFiles(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.canShare === 'function' &&
    typeof navigator.share === 'function'
  );
}

export async function shareBytes(bytes: Uint8Array, filename: string): Promise<boolean> {
  if (!canShareFiles()) return false;
  const file = new File([bytes as unknown as BlobPart], filename, { type: 'application/x-sqlite3' });
  if (!navigator.canShare!({ files: [file] })) return false;
  try {
    await navigator.share!({ files: [file], title: 'Doujin POS 数据库导出' });
    return true;
  } catch {
    return false;
  }
}

export async function exportDatabase(filename: string): Promise<{ bytes: Uint8Array; mode: 'picker' | 'download' }> {
  const { bytes } = await db.exportDb();
  const mode = await saveBytes(bytes, filename);
  await markExported();
  return { bytes, mode };
}

/* ---------------------------------------------------------------- 导入 */

export interface ReplacePreview {
  current: {
    datasetId: string | null;
    revision: number;
    orderCount: number;
    completedOrderCount: number;
    eventCount: number;
  };
  candidate: ImportSummary;
  warnings: string[];
}

export async function stageImport(bytes: Uint8Array): Promise<ReplacePreview> {
  const current = await db.status();
  const currentOrders = await db.read<{ c: number }>('SELECT COUNT(*) AS c FROM orders');
  const currentCompleted = await db.read<{ c: number }>(
    "SELECT COUNT(*) AS c FROM orders WHERE status = 'completed'"
  );
  const candidate = await db.importStage(bytes);
  const warnings: string[] = [];
  if (candidate.datasetId !== current.datasetId) {
    warnings.push('这是另一个数据集，整库替换会覆盖当前设备上的全部营业数据');
  } else if (candidate.revision < current.revision) {
    warnings.push('待导入的副本比当前数据更旧，当前设备上的新成交可能被覆盖');
  } else {
    warnings.push('整库替换不会合并任何本地独有修改，请确认当前数据已另外保存');
  }
  return {
    current: {
      datasetId: current.datasetId,
      revision: current.revision,
      orderCount: Number(currentOrders[0]?.c ?? 0),
      completedOrderCount: Number(currentCompleted[0]?.c ?? 0),
      eventCount: 0
    },
    candidate,
    warnings
  };
}

export async function commitImport(): Promise<Slot> {
  const { slot } = await db.importCommit();
  await setSetting('db.active_slot', slot);
  return slot;
}

export function readStoredSlot(): Slot {
  try {
    const v = localStorage.getItem('doujin-pos:active-slot');
    return v === 'b' ? 'b' : 'a';
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
