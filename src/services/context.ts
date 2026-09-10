/**
 * 服务层上下文。
 *
 * 应用启动时把 Worker 客户端绑定进来；测试时绑定真实 SQLite（sql.js）执行器。
 * 服务层负责业务规则与校验，SQL 只出现在这里，不出现在 React 组件里。
 */

import type { SqlExecutor, Step } from '../db/executor';
import { hashRequest, newId, nowIso } from '../domain/ids';

let executor: SqlExecutor | null = null;

export function bindExecutor(e: SqlExecutor) {
  executor = e;
}

export function ex(): SqlExecutor {
  if (!executor) throw new Error('服务层未绑定数据库执行器');
  return executor;
}

/* ------------------------------------------------------------------ 设置 */

export async function getSetting(key: string): Promise<string | null> {
  const row = await ex().readOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await ex().tx([
    {
      t: 'run',
      sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      params: [key, value]
    }
  ]);
}

/* ------------------------------------------------------------------ 审计 */

export function auditStep(
  action: string,
  entity: string | null,
  entityId: string | null,
  detail: unknown,
  actor = 'staff'
): Step {
  return {
    t: 'run',
    sql: 'INSERT INTO audit_log (id, at, actor, action, entity, entity_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    params: [newId(), nowIso(), actor, action, entity, entityId, JSON.stringify(detail ?? null)]
  };
}

/* -------------------------------------------------------------- 幂等 */

export interface IdempotencyRecord {
  operation_id: string;
  kind: string;
  request_hash: string;
  result_json: string;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('同一操作标识对应了不同的参数，已拒绝执行');
    this.name = 'IdempotencyConflictError';
  }
}

/**
 * 幂等写入。同一 operation_id 且参数相同 → 返回既有结果；参数不同 → 拒绝。
 * 幂等记录与业务修改在同一个事务里提交。
 */
export async function beginIdempotent(
  kind: string,
  operationId: string,
  payload: unknown
): Promise<{ hash: string; existing: unknown | null }> {
  const hash = hashRequest({ kind, payload });
  const row = await ex().readOne<IdempotencyRecord>(
    'SELECT * FROM idempotency_records WHERE operation_id = ?',
    [operationId]
  );
  if (row) {
    if (row.request_hash !== hash) throw new IdempotencyConflictError();
    return { hash, existing: JSON.parse(row.result_json) };
  }
  return { hash, existing: null };
}

export function idempotencyStep(operationId: string, kind: string, hash: string, result: unknown): Step {
  return {
    t: 'run',
    sql: 'INSERT INTO idempotency_records (operation_id, kind, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)',
    params: [operationId, kind, hash, JSON.stringify(result), nowIso()]
  };
}

/* ------------------------------------------------------------------ 杂项 */

export async function nextHumanNumber(eventId: string): Promise<number> {
  const row = await ex().readOne<{ n: number }>(
    'SELECT COALESCE(MAX(human_readable_number), 0) + 1 AS n FROM orders WHERE event_id = ?',
    [eventId]
  );
  return Number(row?.n ?? 1);
}

export async function getMeta(key: string): Promise<string | null> {
  const row = await ex().readOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]);
  return row ? row.value : null;
}

export async function bumpRevision(): Promise<void> {
  await ex().tx([
    {
      t: 'run',
      sql: "UPDATE metadata SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'"
    }
  ]);
}
