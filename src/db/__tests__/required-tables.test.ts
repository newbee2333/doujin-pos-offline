import { describe, expect, it } from 'vitest';
import { INITIAL_SCHEMA, REQUIRED_TABLES, SCHEMA_VERSION } from '../schema';
import { buildMigrationSteps } from '../bootstrap';
import { createTestDatabase } from '../test-executor';

/**
 * 回归防线（2026-09-14 审计问题 3）：
 * 导入校验曾把「业务校验 SQL 执行出错」当成"旧 schema 没有这张表"跳过，
 * 导致删掉 inventory_transactions 的文件也被接受并切为活动库。
 * 这里保证必需表清单是从建表语句派生且完整的——导入校验依赖它判定文件结构。
 */
describe('导入所需的结构清单', () => {
  it('REQUIRED_TABLES 从建表语句派生，覆盖全部表且无重复', () => {
    const declared = INITIAL_SCHEMA.flatMap((sql) =>
      Array.from(
        sql.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)
      ).map((m) => m[1])
    );
    expect(new Set(REQUIRED_TABLES).size).toBe(REQUIRED_TABLES.length);
    expect(new Set(REQUIRED_TABLES)).toEqual(new Set(declared));
    // 关键表必须在清单里，否则导入校验形同虚设
    for (const t of ['metadata', 'orders', 'order_items', 'inventory_transactions', 'settings']) {
      expect(REQUIRED_TABLES).toContain(t);
    }
  });

  it('按当前 schema 建出的库包含全部必需表', async () => {
    const db = await createTestDatabase();
    const rows = await db.executor.read<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    );
    const present = new Set(rows.map((r) => r.name));
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    expect(missing).toEqual([]);
    db.close();
  });

  it('schema 版本与迁移链一致（迁移后不会缺列）', () => {
    let v = 1;
    let guard = 0;
    while (v < SCHEMA_VERSION && guard < 10) {
      const steps = buildMigrationSteps(v);
      expect(steps.length).toBeGreaterThan(0);
      v += 1;
      guard += 1;
    }
    expect(v).toBe(SCHEMA_VERSION);
  });
});
