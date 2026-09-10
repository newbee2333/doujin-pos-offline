/**
 * 测试用的真实 SQLite 执行器（sql.js）。
 *
 * 规格要求关键事务不走 mock Repository，这里用真正的 SQLite 跑同一套步骤，
 * 行为与浏览器中的 Worker 执行器保持一致（含事务回滚与 revision 递增）。
 */

import initSqlJs from 'sql.js';
import type { Bind, SqlExecutor, Step, StepResult } from './executor';
import { buildInitialSchemaSteps } from './bootstrap';

/* eslint-disable @typescript-eslint/no-explicit-any */
type SqlJsDb = any;

export class SqlJsExecutor implements SqlExecutor {
  constructor(private db: SqlJsDb) {}

  private query(sql: string, params?: Bind[]): Record<string, unknown>[] {
    const res = this.db.exec(sql, params as any);
    if (!res || !res.length) return [];
    const out: Record<string, unknown>[] = [];
    for (const part of res) {
      for (const row of part.values) {
        const obj: Record<string, unknown> = {};
        part.columns.forEach((col: string, i: number) => {
          obj[col] = row[i];
        });
        out.push(obj);
      }
    }
    return out;
  }

  async tx(steps: Step[]): Promise<StepResult[]> {
    this.db.run('BEGIN IMMEDIATE');
    const out: StepResult[] = [];
    try {
      for (const step of steps) {
        const params = (step.params ?? []) as any;
        if (step.t === 'run') {
          this.db.run(step.sql, params);
          const changes = Number(this.db.getRowsModified());
          if (step.expectChanges === 'nonzero' && changes === 0) {
            throw new Error('写入未生效，事务已回滚');
          }
          if (typeof step.expectChanges === 'number' && changes !== step.expectChanges) {
            throw new Error(`写入影响行数异常（期望 ${step.expectChanges}，实际 ${changes}）`);
          }
          out.push(changes);
        } else if (step.t === 'one') {
          const rows = this.query(step.sql, step.params);
          out.push(rows.length ? rows[0] : null);
        } else if (step.t === 'all') {
          out.push(this.query(step.sql, step.params));
        } else {
          const rows = this.query(step.sql, step.params);
          const first = rows.length ? rows[0] : null;
          const value = first ? Object.values(first)[0] : null;
          if (String(value ?? '') !== String(step.equals)) throw new Error(step.message);
          out.push(null);
        }
      }
      const hasWrite = steps.some((s) => s.t === 'run');
      if (hasWrite) {
        this.db.run("UPDATE metadata SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'");
      }
      this.db.run('COMMIT');
      return out;
    } catch (e) {
      try {
        this.db.run('ROLLBACK');
      } catch {
        /* 忽略 */
      }
      throw e;
    }
  }

  async read<T = Record<string, unknown>>(sql: string, params?: Bind[]): Promise<T[]> {
    return this.query(sql, params) as unknown as T[];
  }

  async readOne<T = Record<string, unknown>>(sql: string, params?: Bind[]): Promise<T | null> {
    const rows = await this.read<T>(sql, params);
    return rows[0] ?? null;
  }
}

export interface TestDatabase {
  executor: SqlJsExecutor;
  raw: SqlJsDb;
  exportBytes: () => Uint8Array;
  close: () => void;
}

let sqlPromise: Promise<any> | null = null;

async function getSql() {
  if (!sqlPromise) sqlPromise = initSqlJs();
  return sqlPromise;
}

/** 建立一个已建好 schema 的内存测试库。 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const SQL = await getSql();
  const db = new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  const executor = new SqlJsExecutor(db);
  await executor.tx(buildInitialSchemaSteps());
  return {
    executor,
    raw: db,
    exportBytes: () => db.export() as Uint8Array,
    close: () => db.close()
  };
}

/** 从字节恢复一个库，用于往返一致性测试。 */
export async function openFromBytes(bytes: Uint8Array): Promise<TestDatabase> {
  const SQL = await getSql();
  const db = new SQL.Database(bytes);
  db.run('PRAGMA foreign_keys = ON');
  return {
    executor: new SqlJsExecutor(db),
    raw: db,
    exportBytes: () => db.export() as Uint8Array,
    close: () => db.close()
  };
}
