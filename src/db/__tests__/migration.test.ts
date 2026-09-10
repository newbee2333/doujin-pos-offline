/**
 * schema 迁移测试。
 *
 * payment_methods.confirm_requires_pin 是第一个走 MIGRATIONS 的变更，
 * 而 iPad 上的真实数据库是 v1——这条迁移跑坏就是丢数据级别的事故，必须测。
 *
 * 模拟方式：建一个 v2 测试库，DROP 掉新列并把 schema_version 写回 1，
 * 就等价于一台还没升级的 v1 设备；然后跑 buildMigrationSteps(1)。
 */
import { describe, expect, it } from 'vitest';
import { buildMigrationSteps } from '../bootstrap';
import { createTestDatabase, openFromBytes, type TestDatabase } from '../test-executor';
import { bindExecutor } from '../../services/context';
import { listPaymentMethods, updatePaymentMethod } from '../../services/events';

/** 把一个 v2 测试库退化成 v1：删掉新列、版本号写回 1，导出字节。 */
async function makeV1Bytes(): Promise<Uint8Array> {
  const db: TestDatabase = await createTestDatabase();
  await db.executor.tx([
    { t: 'run', sql: 'ALTER TABLE payment_methods DROP COLUMN confirm_requires_pin' },
    { t: 'run', sql: "UPDATE metadata SET value = '1' WHERE key = 'schema_version'" }
  ]);
  const bytes = db.exportBytes();
  db.close();
  return bytes;
}

describe('schema 迁移 v1 → v2', () => {
  it('老库补出 confirm_requires_pin 列，存量行默认 1', async () => {
    const migrated = await openFromBytes(await makeV1Bytes());
    await migrated.executor.tx(buildMigrationSteps(1));

    // 列确实回来了
    const info = await migrated.executor.read<{ name: string }>(
      "PRAGMA table_info(payment_methods)"
    );
    expect(info.map((c) => c.name)).toContain('confirm_requires_pin');

    // 存量行默认 1（要 PIN），与迁移前的行为一致
    const rows = await migrated.executor.read<{ confirm_requires_pin: number }>(
      'SELECT confirm_requires_pin FROM payment_methods'
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.confirm_requires_pin).toBe(1);
    migrated.close();
  });

  it('迁移后版本号写到 2，且不会重复执行', async () => {
    const migrated = await openFromBytes(await makeV1Bytes());
    await migrated.executor.tx(buildMigrationSteps(1));
    const meta = await migrated.executor.read<{ value: string }>(
      "SELECT value FROM metadata WHERE key = 'schema_version'"
    );
    expect(meta[0]?.value).toBe('2');

    // 再跑一次迁移不应报错（buildMigrationSteps(2) 找不到可用的迁移，产出空步骤）
    expect(buildMigrationSteps(2)).toEqual([]);
    migrated.close();
  });

  it('迁移后的库能通过服务层正常读写 confirm_requires_pin', async () => {
    const migrated = await openFromBytes(await makeV1Bytes());
    await migrated.executor.tx(buildMigrationSteps(1));
    bindExecutor(migrated.executor);

    const methods = await listPaymentMethods();
    expect(methods.length).toBeGreaterThan(0);
    for (const m of methods) expect(m.confirm_requires_pin).toBe(1);

    // 关掉其中一个，其余不受影响
    const target = methods[0].id;
    await updatePaymentMethod(target, { confirm_requires_pin: false });
    const after = await listPaymentMethods();
    expect(after.find((m) => m.id === target)?.confirm_requires_pin).toBe(0);
    expect(after.filter((m) => m.confirm_requires_pin === 1).length).toBe(after.length - 1);
    migrated.close();
  });
});
