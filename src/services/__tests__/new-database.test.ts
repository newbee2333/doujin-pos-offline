/**
 * 「新建空数据库」的现状预览。
 *
 * 建库与切槽那一段在 Worker 里（OPFS + sqlite-wasm），只能在浏览器里验证
 * 见 scripts/verify-bundle-ux.mjs 的第 6 节。这里守的是**提醒**所依赖的那几个数字：
 * 预览读的是哪几张表、成交数怎么算、确认保存之后提醒会不会换档。
 *
 * 提醒强度直接由 `backup.lastConfirmedSavedAt` 有没有值决定（有 → 普通提示，
 * 没有 → 危险块 + 多一个勾选项），所以「没备份过的库必须报 null」是一条要守的规则。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/test-executor';
import { bindExecutor } from '../context';
import {
  activateEvent,
  addVariantsToEvent,
  createEvent,
  listPaymentMethods,
  setEventPaymentMethods,
  updateConfig,
  updatePaymentMethod
} from '../events';
import { createProduct } from '../catalog';
import { createPendingOrder, staffDirectSale } from '../orders';
import { initializeStock } from '../inventory';
import { markConfirmedSaved, markExported, previewNewDatabase } from '../system';

let tdb: TestDatabase;

beforeEach(async () => {
  if (tdb) tdb.close();
  tdb = await createTestDatabase();
  bindExecutor(tdb.executor);
});

async function setupEvent() {
  const eventId = await createEvent({ name: 'C107', currency: 'CNY' });
  const cash = (await listPaymentMethods()).find((m) => m.type === 'cash')!;
  await updatePaymentMethod(cash.id, { enabled: true });
  await setEventPaymentMethods(eventId, [cash.id]);
  const { variantId } = await createProduct({
    name: '新刊A',
    type: 'normal',
    default_currency: 'CNY',
    default_price_minor: 2500
  });
  await addVariantsToEvent(eventId, [variantId]);
  await updateConfig(eventId, variantId, { event_price_minor: 2500 });
  await initializeStock(eventId, variantId, 10);
  return { eventId, variantId, cashId: cash.id };
}

describe('新建空库前的现状预览（第 22 节）', () => {
  it('刚建好的库没有任何营业数据，也还没有可回去的备份', async () => {
    const p = await previewNewDatabase();

    expect(p.current.datasetId).toBeTruthy();
    // 建库本身是一次写事务，revision 会从 0 变成 1 —— 所以只确认它是个数，
    // 不把「新库的初始 revision 恰好是 1」写死（那是 bootstrap 的实现细节）。
    expect(typeof p.current.revision).toBe('number');
    expect(p.current.revision).toBeGreaterThanOrEqual(1);
    expect(p.current.eventCount).toBe(0);
    expect(p.current.orderCount).toBe(0);
    expect(p.current.completedOrderCount).toBe(0);
    expect(p.current.productCount).toBe(0);
    // 这两个都为 null 时，页面必须按「从未备份」的强度提醒。
    expect(p.backup.lastExportAt).toBeNull();
    expect(p.backup.lastConfirmedSavedAt).toBeNull();
  });

  it('有数据时报真实条数：订单含未成交，成交数只算已完成的单', async () => {
    const { eventId, variantId, cashId } = await setupEvent();
    await activateEvent(eventId);

    // 一笔直接成交
    await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      paymentMethodId: cashId,
      tenderedMinor: 2500
    });
    // 一笔还挂着待付款的
    await createPendingOrder({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      plannedPaymentMethodId: cashId
    });

    const p = await previewNewDatabase();
    expect(p.current.eventCount).toBe(1);
    expect(p.current.productCount).toBe(1);
    expect(p.current.orderCount).toBe(2);
    expect(p.current.completedOrderCount).toBe(1);
  });

  it('生成导出还不算数，确认保存过之后提醒才换档', async () => {
    // 只点过「导出 SQLite」而没确认落盘：这正是最容易骗过自己的状态，
    // 不能让它把危险提醒降级。
    await markExported();
    let p = await previewNewDatabase();
    expect(p.backup.lastExportAt).not.toBeNull();
    expect(p.backup.lastConfirmedSavedAt).toBeNull();

    await markConfirmedSaved();
    p = await previewNewDatabase();
    expect(p.backup.lastConfirmedSavedAt).not.toBeNull();
  });
});
