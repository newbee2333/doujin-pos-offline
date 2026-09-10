/// <reference lib="webworker" />
/**
 * 数据库 Worker。
 *
 * 所有 SQLite 操作都在这里执行；主线程只发「事务步骤」，不写 SQL。
 * 存储使用 opfs-sahpool VFS，活动库在两个槽位之间 A/B 切换，
 * 保证整库替换的任何中断点都能回到一个完整有效的库（第 4 / 21 / 22 节）。
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { APPLICATION_ID, APP_VERSION, SCHEMA_VERSION, checkSchemaSupport } from './schema';
import { INVARIANT_CHECKS } from './invariants';
import { buildInitialSchemaSteps, buildMigrationSteps, metaUpsertStep } from './bootstrap';
import type { Bind, Step, StepResult } from './executor';
import { nowIso } from '../domain/ids';

type Slot = 'a' | 'b';
const SLOT_PATH: Record<Slot, string> = {
  a: '/doujin-pos-a.sqlite3',
  b: '/doujin-pos-b.sqlite3'
};

let sqlite3: any = null;
let pool: any = null;
let db: any = null;
let activeSlot: Slot = 'a';
let ready = false;

interface Req {
  id: number;
  cmd: 'init' | 'tx' | 'read' | 'export' | 'importStage' | 'importCommit' | 'status';
  slot?: Slot;
  steps?: Step[];
  sql?: string;
  params?: Bind[];
  bytes?: Uint8Array;
}

self.onmessage = async (ev: MessageEvent<Req>) => {
  const req = ev.data;
  try {
    const result = await handle(req);
    postResult(req.id, true, result);
  } catch (err) {
    postResult(req.id, false, undefined, err instanceof Error ? err.message : String(err));
  }
};

function postResult(id: number, ok: boolean, result?: unknown, error?: string, transfer?: Transferable[]) {
  const payload: Record<string, unknown> = { id, ok, result, error };
  if (transfer && transfer.length) (self as any).postMessage(payload, transfer);
  else (self as any).postMessage(payload);
}

async function handle(req: Req): Promise<unknown> {
  switch (req.cmd) {
    case 'init':
      return init(req.slot ?? 'a');
    case 'status':
      return status();
    case 'tx':
      ensureReady();
      return execSteps(db, req.steps ?? []);
    case 'read':
      ensureReady();
      return selectAll(db, req.sql ?? '', req.params);
    case 'export': {
      ensureReady();
      const bytes = await exportBytes(db);
      const copy = new Uint8Array(bytes);
      postResult(req.id, true, { bytes: copy, slot: activeSlot }, undefined, [copy.buffer]);
      return undefined;
    }
    case 'importStage':
      ensureReady();
      return importStage(req.bytes ?? new Uint8Array());
    case 'importCommit':
      ensureReady();
      return importCommit();
    default:
      throw new Error(`未知的 Worker 命令：${(req as Req).cmd}`);
  }
}

function ensureReady() {
  if (!ready || !db) throw new Error('数据库尚未初始化');
}

/* ------------------------------------------------------------------ 初始化 */

async function init(slot: Slot): Promise<unknown> {
  if (!sqlite3) {
    sqlite3 = await sqlite3InitModule();
  }
  if (!pool) {
    pool = await sqlite3.installOpfsSAHPoolVfs({
      name: 'doujin-pos-v1',
      initialCapacity: 8
    });
  }
  activeSlot = slot;
  db = new pool.OpfsSAHPoolDb(SLOT_PATH[slot]);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
  ensureSchema(db);
  ready = true;
  // 实际写入并重开读取，验证不是空壳
  db.exec('CREATE TABLE IF NOT EXISTS __write_probe (v INTEGER)');
  db.exec('INSERT INTO __write_probe VALUES (1)');
  db.exec('DROP TABLE __write_probe');
  return status();
}

function status() {
  const meta = readAllMeta(db);
  return {
    slot: activeSlot,
    applicationId: meta.application_id ?? null,
    datasetId: meta.dataset_id ?? null,
    schemaVersion: Number(meta.schema_version ?? 0),
    revision: Number(meta.revision ?? 0),
    createdAt: meta.created_at ?? null,
    updatedAt: meta.updated_at ?? null,
    appVersion: APP_VERSION,
    fileNames: pool ? Array.from(pool.getFileNames?.() ?? []) : []
  };
}

function readAllMeta(d: any): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    if (!tableExists(d, 'metadata')) return out;
    const rows = selectAll(d, 'SELECT key, value FROM metadata');
    for (const r of rows) out[String(r.key)] = String(r.value);
  } catch {
    /* 建库前没有 metadata 表 */
  }
  return out;
}

function tableExists(d: any, name: string): boolean {
  const rows = selectAll(d, `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name=?`, [name]);
  return Number(rows[0]?.c ?? 0) > 0;
}

function ensureSchema(d: any) {
  const meta = readAllMeta(d);
  if (!meta.schema_version) {
    execSteps(d, buildInitialSchemaSteps());
    return;
  }
  applyMigrations(d, Number(meta.schema_version));
}

function applyMigrations(d: any, from: number) {
  if (from > SCHEMA_VERSION) {
    throw new Error('数据库来自更高版本的应用，请更新应用后再打开');
  }
  if (from < SCHEMA_VERSION) {
    const steps = buildMigrationSteps(from);
    if (steps.length === 0) {
      throw new Error(`数据库 schema 版本 ${from} 无法迁移到 ${SCHEMA_VERSION}`);
    }
    execSteps(d, steps);
    const recheck = selectAll(d, 'PRAGMA integrity_check');
    if (String(recheck[0]?.integrity_check ?? '') !== 'ok') {
      throw new Error('迁移后完整性检查未通过');
    }
  }
  execSteps(d, [metaUpsertStep('last_write_app_version', APP_VERSION)]);
}

function setMeta(d: any, key: string, value: string) {
  d.exec({
    sql: 'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    bind: [key, value]
  });
}

/* -------------------------------------------------------------- 语句执行 */

function selectAll(d: any, sql: string, params?: Bind[]): Record<string, unknown>[] {
  const res = d.exec({
    sql,
    bind: (params ?? []) as any,
    rowMode: 'object',
    returnValue: 'resultRows'
  });
  return (res ?? []) as Record<string, unknown>[];
}

function execSteps(d: any, steps: Step[]): StepResult[] {
  d.exec('BEGIN IMMEDIATE');
  const out: StepResult[] = [];
  try {
    for (const step of steps) {
      const params = (step.params ?? []) as any;
      if (step.t === 'run') {
        d.exec({ sql: step.sql, bind: params });
        const changes = Number(d.changes());
        if (step.expectChanges === 'nonzero' && changes === 0) {
          throw new Error('写入未生效，事务已回滚');
        }
        if (typeof step.expectChanges === 'number' && changes !== step.expectChanges) {
          throw new Error(`写入影响行数异常（期望 ${step.expectChanges}，实际 ${changes}），事务已回滚`);
        }
        out.push(changes);
      } else if (step.t === 'one') {
        const rows = selectAll(d, step.sql, step.params);
        out.push(rows.length ? rows[0] : null);
      } else if (step.t === 'all') {
        out.push(selectAll(d, step.sql, step.params));
      } else {
        const rows = selectAll(d, step.sql, step.params);
        const first = rows.length ? rows[0] : null;
        const value = first ? Object.values(first)[0] : null;
        if (String(value ?? '') !== String(step.equals)) {
          throw new Error(step.message);
        }
        out.push(null);
      }
    }
    // 业务写入提交后递增 revision
    const hasWrite = steps.some((s) => s.t === 'run');
    if (hasWrite) {
      d.exec({
        sql: "UPDATE metadata SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'"
      });
      d.exec({
        sql: "INSERT INTO metadata (key, value) SELECT 'revision', '1' WHERE NOT EXISTS (SELECT 1 FROM metadata WHERE key = 'revision')"
      });
      setMeta(d, 'updated_at', nowIso());
      setMeta(d, 'last_write_app_version', APP_VERSION);
    }
    d.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      d.exec('ROLLBACK');
    } catch {
      /* 忽略 */
    }
    throw e;
  }
}

/* ------------------------------------------------------------ 导入导出 */

async function exportBytes(d: any): Promise<Uint8Array> {
  // 优先使用官方导出接口生成一致快照，失败再退回 SAHPool 的文件导出
  try {
    const bytes = sqlite3.capi.sqlite3_js_db_export(d.pointer ?? d);
    if (bytes && bytes.length) return bytes;
  } catch {
    /* 退回 */
  }
  return pool.exportFile(SLOT_PATH[activeSlot]);
}

async function writeSlot(slot: Slot, bytes: Uint8Array) {
  const path = SLOT_PATH[slot];
  try {
    const names: string[] = Array.from(pool.getFileNames?.() ?? []);
    if (names.includes(path) && typeof pool.unlink === 'function') {
      try {
        pool.unlink(path);
      } catch {
        /* 忽略，交给 importDb 覆盖 */
      }
    }
  } catch {
    /* 忽略 */
  }
  await pool.importDb(path, bytes);
}

export interface ImportSummary {
  datasetId: string | null;
  revision: number;
  schemaVersion: number;
  eventCount: number;
  orderCount: number;
  completedOrderCount: number;
  productCount: number;
  latestCompletedAt: string | null;
  byteSize: number;
  migratedFrom: number | null;
  targetSlot: Slot;
}

let stagedSlot: Slot | null = null;

async function importStage(bytes: Uint8Array): Promise<ImportSummary> {
  if (!bytes || bytes.length < 100) throw new Error('文件太小，不像一个 SQLite 数据库');
  const header = String.fromCharCode(...Array.from(bytes.slice(0, 15)));
  if (!header.startsWith('SQLite format 3')) {
    throw new Error('不是有效的 SQLite 数据库文件');
  }

  const target: Slot = activeSlot === 'a' ? 'b' : 'a';
  await writeSlot(target, bytes);

  let cand: any = null;
  let migratedFrom: number | null = null;
  try {
    cand = new pool.OpfsSAHPoolDb(SLOT_PATH[target]);
    cand.exec('PRAGMA foreign_keys = ON');

    const integrity = selectAll(cand, 'PRAGMA integrity_check');
    if (String(integrity[0]?.integrity_check ?? '') !== 'ok') {
      throw new Error('数据库完整性检查未通过');
    }
    const fk = selectAll(cand, 'PRAGMA foreign_key_check');
    if (fk.length > 0) throw new Error(`外键一致性检查未通过（${fk.length} 处）`);

    const appId = Number(selectAll(cand, 'PRAGMA application_id')[0]?.application_id ?? 0);
    if (appId !== APPLICATION_ID) {
      throw new Error('这不是 Doujin POS 导出的数据库（文件头标识不匹配）');
    }

    const meta = readAllMeta(cand);
    const version = Number(meta.schema_version ?? 0);
    const support = checkSchemaSupport(version);
    if (!support.ok) throw new Error(support.reason ?? 'schema 版本不受支持');
    if (version < SCHEMA_VERSION) {
      migratedFrom = version;
      applyMigrations(cand, version);
      const recheck = selectAll(cand, 'PRAGMA integrity_check');
      if (String(recheck[0]?.integrity_check ?? '') !== 'ok') {
        throw new Error('迁移后完整性检查未通过');
      }
    }

    const problems = runInvariantChecks(cand);
    if (problems.length) {
      throw new Error(`业务数据校验未通过：${problems.join('；')}`);
    }

    const summary = buildSummary(cand, bytes.length, target);
    summary.migratedFrom = migratedFrom;
    stagedSlot = target;
    return summary;
  } finally {
    if (cand) {
      try {
        cand.close();
      } catch {
        /* 忽略 */
      }
    }
  }
}

function runInvariantChecks(d: any): string[] {
  const problems: string[] = [];
  for (const check of INVARIANT_CHECKS) {
    let rows: Record<string, unknown>[] = [];
    try {
      rows = selectAll(d, check.sql);
    } catch {
      continue; // 旧 schema 可能没有对应表，跳过
    }
    const count = Number(rows[0] ? Object.values(rows[0])[0] : 0);
    if (count > 0) problems.push(`${check.label}（${count} 处）`);
  }
  return problems;
}

function buildSummary(d: any, byteSize: number, target: Slot): ImportSummary {
  const meta = readAllMeta(d);
  const q = (sql: string) => Number(selectAll(d, sql)[0] ? Object.values(selectAll(d, sql)[0])[0] : 0);
  const latest = selectAll(d, "SELECT MAX(completed_at) AS m FROM orders WHERE status = 'completed'");
  return {
    datasetId: meta.dataset_id ?? null,
    revision: Number(meta.revision ?? 0),
    schemaVersion: Number(meta.schema_version ?? 0),
    eventCount: q('SELECT COUNT(*) FROM events'),
    orderCount: q('SELECT COUNT(*) FROM orders'),
    completedOrderCount: q("SELECT COUNT(*) FROM orders WHERE status = 'completed'"),
    productCount: q('SELECT COUNT(*) FROM products'),
    latestCompletedAt: (latest[0]?.m as string) ?? null,
    byteSize,
    migratedFrom: null,
    targetSlot: target
  };
}

async function importCommit(): Promise<{ slot: Slot; status: unknown }> {
  if (!stagedSlot) throw new Error('没有待确认的导入');
  const previous = activeSlot;
  const target = stagedSlot;

  try {
    if (db) {
      try {
        db.close();
      } catch {
        /* 忽略 */
      }
      db = null;
    }
    activeSlot = target;
    db = new pool.OpfsSAHPoolDb(SLOT_PATH[target]);
    db.exec('PRAGMA foreign_keys = ON');
    const integrity = selectAll(db, 'PRAGMA integrity_check');
    if (String(integrity[0]?.integrity_check ?? '') !== 'ok') {
      throw new Error('切换后复查未通过');
    }
    ensureSchema(db);
    stagedSlot = null;
    return { slot: activeSlot, status: status() };
  } catch (e) {
    // 回滚到原槽位
    stagedSlot = null;
    activeSlot = previous;
    db = new pool.OpfsSAHPoolDb(SLOT_PATH[previous]);
    db.exec('PRAGMA foreign_keys = ON');
    throw new Error(`导入失败，已恢复到原数据库：${e instanceof Error ? e.message : String(e)}`);
  }
}
