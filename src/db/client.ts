/** 主线程数据库客户端：把事务步骤发给 Worker，UI 不接触 SQLite。 */

import type { Bind, SqlExecutor, Step, StepResult } from './executor';
import type { ImportSummary } from './worker';

export type Slot = 'a' | 'b';

export interface DbStatus {
  slot: Slot;
  applicationId: string | null;
  datasetId: string | null;
  schemaVersion: number;
  revision: number;
  createdAt: string | null;
  updatedAt: string | null;
  appVersion: string;
  fileNames: string[];
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

class DbClient implements SqlExecutor {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private initPromise: Promise<DbStatus> | null = null;

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'doujin-pos-db'
    });
    worker.onmessage = (ev: MessageEvent) => {
      const { id, ok, result, error } = ev.data ?? {};
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error ?? '数据库操作失败'));
    };
    worker.onerror = (ev) => {
      const err = new Error(`数据库 Worker 出错：${ev.message}`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    };
    this.worker = worker;
    return worker;
  }

  private call<T>(cmd: string, payload: Record<string, unknown> = {}): Promise<T> {
    const worker = this.ensureWorker();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ id, cmd, ...payload });
    });
  }

  init(slot: Slot): Promise<DbStatus> {
    if (!this.initPromise) {
      this.initPromise = this.call<DbStatus>('init', { slot });
    }
    return this.initPromise;
  }

  status(): Promise<DbStatus> {
    return this.call<DbStatus>('status');
  }

  tx(steps: Step[]): Promise<StepResult[]> {
    return this.call<StepResult[]>('tx', { steps });
  }

  read<T = Record<string, unknown>>(sql: string, params?: Bind[]): Promise<T[]> {
    return this.call<Record<string, unknown>[]>('read', { sql, params }).then((r) => r as unknown as T[]);
  }

  async readOne<T = Record<string, unknown>>(sql: string, params?: Bind[]): Promise<T | null> {
    const rows = await this.read<T>(sql, params);
    return rows[0] ?? null;
  }

  exportDb(): Promise<{ bytes: Uint8Array; slot: Slot }> {
    return this.call<{ bytes: Uint8Array; slot: Slot }>('export');
  }

  importStage(bytes: Uint8Array): Promise<ImportSummary> {
    return this.call<ImportSummary>('importStage', { bytes });
  }

  importCommit(): Promise<{ slot: Slot; status: DbStatus }> {
    return this.call<{ slot: Slot; status: DbStatus }>('importCommit');
  }

  reset() {
    this.initPromise = null;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}

export const db = new DbClient();
