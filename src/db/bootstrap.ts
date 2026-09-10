/**
 * 建库步骤。Worker 与测试执行器共用同一份 DDL，避免两处漂移。
 */

import { DEFAULT_CATEGORIES, DEFAULT_PAYMENT_METHODS, INITIAL_SCHEMA, MIGRATIONS, SCHEMA_VERSION, APP_VERSION } from './schema';
import type { Step } from './executor';
import { newId, nowIso } from '../domain/ids';

/** 建立首版 schema 并写入 metadata 与默认模板。 */
export function buildInitialSchemaSteps(): Step[] {
  const now = nowIso();
  const steps: Step[] = [];
  for (const sql of INITIAL_SCHEMA) steps.push({ t: 'run', sql });

  const meta: [string, string][] = [
    ['dataset_id', newId()],
    ['schema_version', String(SCHEMA_VERSION)],
    ['created_app_version', APP_VERSION],
    ['last_write_app_version', APP_VERSION],
    ['created_at', now],
    ['updated_at', now],
    ['revision', '0']
  ];
  for (const [k, v] of meta) {
    steps.push({ t: 'run', sql: 'INSERT INTO metadata (key, value) VALUES (?, ?)', params: [k, v] });
  }

  DEFAULT_CATEGORIES.forEach((name, i) => {
    steps.push({
      t: 'run',
      sql: 'INSERT INTO categories (id, name, sort_order, hidden, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
      params: [newId(), name, i, now, now]
    });
  });
  DEFAULT_PAYMENT_METHODS.forEach((m, i) => {
    steps.push({
      t: 'run',
      sql: 'INSERT INTO payment_methods (id, name, type, qr_asset_id, enabled, sort_order, instruction, created_at) VALUES (?, ?, ?, NULL, 0, ?, NULL, ?)',
      params: [newId(), m.name, m.type, i, now]
    });
  });
  return steps;
}

/** 从 fromVersion 迁移到当前版本所需步骤（按 MIGRATIONS 顺序）。 */
export function buildMigrationSteps(fromVersion: number): Step[] {
  const steps: Step[] = [];
  let version = fromVersion;
  for (const m of MIGRATIONS) {
    if (m.fromVersion !== version) continue;
    for (const sql of m.sql) steps.push({ t: 'run', sql });
    steps.push({
      t: 'run',
      sql: 'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      params: ['schema_version', String(m.toVersion)]
    });
    version = m.toVersion;
  }
  return steps;
}

export function metaUpsertStep(key: string, value: string): Step {
  return {
    t: 'run',
    sql: 'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    params: [key, value]
  };
}
