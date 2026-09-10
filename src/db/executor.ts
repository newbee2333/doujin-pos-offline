/**
 * 事务步骤抽象。
 *
 * 服务层（主线程）负责校验与生成步骤；Worker / 测试执行器负责在单个
 * BEGIN IMMEDIATE ... COMMIT 内顺序执行，任一步失败整体回滚。
 * 这样 React 不写 SQL，同时保证跨语句的原子性与可测性。
 */

export type Bind = string | number | null | Uint8Array;

export type Step =
  /** 执行写语句，可断言影响行数。 */
  | { t: 'run'; sql: string; params?: Bind[]; expectChanges?: number | 'nonzero' }
  /** 查询并捕获结果行（单条）。 */
  | { t: 'one'; sql: string; params?: Bind[] }
  /** 查询并捕获结果行（多条）。 */
  | { t: 'all'; sql: string; params?: Bind[] }
  /** 断言标量查询等于预期值，否则抛错回滚。用于事务内的不变量复核。 */
  | { t: 'assert'; sql: string; params?: Bind[]; equals: string | number; message: string };

export type StepResult = number | Record<string, unknown> | Record<string, unknown>[] | null;

export interface SqlExecutor {
  /** 在一个事务内执行全部步骤，返回与步骤一一对应的结果。 */
  tx(steps: Step[]): Promise<StepResult[]>;
  /** 单条读查询。 */
  read<T = Record<string, unknown>>(sql: string, params?: Bind[]): Promise<T[]>;
  /** 单条读查询，取第一行。 */
  readOne<T = Record<string, unknown>>(sql: string, params?: Bind[]): Promise<T | null>;
}

export function run(sql: string, params?: Bind[], expectChanges?: number | 'nonzero'): Step {
  return { t: 'run', sql, params, expectChanges };
}

export function one(sql: string, params?: Bind[]): Step {
  return { t: 'one', sql, params };
}

export function all(sql: string, params?: Bind[]): Step {
  return { t: 'all', sql, params };
}

export function assertEq(
  sql: string,
  params: Bind[] | undefined,
  equals: string | number,
  message: string
): Step {
  return { t: 'assert', sql, params, equals, message };
}

export function scalar(res: StepResult): string | number | null {
  if (res === null || typeof res === 'number') return res;
  if (Array.isArray(res)) return res.length ? scalar(res[0]) : null;
  const values = Object.values(res);
  const v = values.length ? values[0] : null;
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  return String(v);
}

export function rows<T>(res: StepResult): T[] {
  if (res === null || typeof res === 'number') return [];
  return (Array.isArray(res) ? res : [res]) as unknown as T[];
}

export function row<T>(res: StepResult): T | null {
  return (rows<T>(res)[0] ?? null) as T | null;
}
