/**
 * 故障恢复与业务有效性校验（第 22、27 节）。
 *
 * 规格要求「文件合法不等于业务有效」：导入前必须验证金额关系、状态与
 * Payment/Refund/Correction 一致性、库存余额/流水/预留及成分快照关联。
 * 这里逐条制造违规数据，确认检查能检出；同时验证资源往返字节一致。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, openFromBytes, type TestDatabase } from '../../db/test-executor';
import { INVARIANT_CHECKS } from '../../db/invariants';
import { SCHEMA_VERSION, checkSchemaSupport } from '../../db/schema';
import { bindExecutor, ex } from '../context';
import {
  addVariantsToEvent,
  activateEvent,
  createEvent,
  listPaymentMethods,
  setEventPaymentMethods,
  updateConfig,
  updatePaymentMethod
} from '../events';
import { createAsset, createProduct, listCategories } from '../catalog';
import { initializeStock } from '../inventory';
import { staffDirectSale } from '../orders';
import { newId } from '../../domain/ids';
import type { Currency } from '../../domain/types';

let tdb: TestDatabase;

async function raw(sql: string, params: unknown[] = []) {
  await ex().tx([{ t: 'run', sql, params: params as never[] }]);
}

async function violationsOf(name: string): Promise<number> {
  const check = INVARIANT_CHECKS.find((c) => c.name === name);
  if (!check) throw new Error(`没有名为 ${name} 的检查`);
  const rows = await ex().read(check.sql);
  return Number(rows.length ? Object.values(rows[0] as Record<string, unknown>)[0] : 0);
}

async function setupEvent(currency: Currency = 'CNY') {
  const eventId = await createEvent({ name: '恢复测试展', currency });
  const existing = (await listCategories()).find((c) => c.name === '新刊');
  const categoryId = existing ? existing.id : '';
  const cash = (await listPaymentMethods()).find((m) => m.type === 'cash')!;
  await updatePaymentMethod(cash.id, { enabled: true });
  await setEventPaymentMethods(eventId, [cash.id]);
  return { eventId, categoryId, cashId: cash.id };
}

async function addItem(
  eventId: string,
  categoryId: string,
  opts: { name: string; price: number; stock?: number }
) {
  const { variantId } = await createProduct({
    name: opts.name,
    type: 'normal',
    category_id: categoryId || null,
    default_currency: 'CNY',
    default_price_minor: opts.price
  });
  await addVariantsToEvent(eventId, [variantId]);
  await updateConfig(eventId, variantId, { event_price_minor: opts.price });
  await initializeStock(eventId, variantId, opts.stock ?? 10);
  return { variantId };
}

beforeEach(async () => {
  if (tdb) tdb.close();
  tdb = await createTestDatabase();
  bindExecutor(tdb.executor);
});

describe('schema 兼容性（第 22、23 节）', () => {
  it('未来版本一律拒绝，不尝试降级', () => {
    expect(checkSchemaSupport(SCHEMA_VERSION + 1).ok).toBe(false);
    expect(checkSchemaSupport(99).ok).toBe(false);
    expect(checkSchemaSupport(SCHEMA_VERSION + 1).reason).toContain('更高版本');
  });

  it('当前版本与旧版本允许（旧版本走迁移）', () => {
    expect(checkSchemaSupport(SCHEMA_VERSION).ok).toBe(true);
    expect(checkSchemaSupport(1).ok).toBe(true);
  });

  it('缺失或非法版本号被拒绝', () => {
    expect(checkSchemaSupport(0).ok).toBe(false);
    expect(checkSchemaSupport(Number.NaN).ok).toBe(false);
  });
});

describe('业务不变量检出', () => {
  it('删掉已成交订单的收款记录会被检出', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: 'A', price: 1000, stock: 5 });
    await activateEvent(eventId);
    await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      paymentMethodId: cashId,
      tenderedMinor: 1000
    });
    expect(await violationsOf('completed_payment_count')).toBe(0);

    await raw('DELETE FROM payments');
    expect(await violationsOf('completed_payment_count')).toBeGreaterThan(0);
  });

  it('给待付款订单挂上收款记录会被检出', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: 'B', price: 1000, stock: 5 });
    await activateEvent(eventId);
    await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      paymentMethodId: cashId,
      tenderedMinor: 1000
    });
    // 人为把订单改回待付款，制造「待付款却有收款」的非法状态
    await raw("UPDATE orders SET status = 'pending_payment'");
    expect(await violationsOf('pending_has_no_payment')).toBeGreaterThan(0);
  });

  it('订单金额与明细不一致会被检出', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: 'C', price: 1000, stock: 5 });
    await activateEvent(eventId);
    await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      paymentMethodId: cashId,
      tenderedMinor: 1000
    });
    await raw('UPDATE orders SET subtotal_minor = 99999', []);
    expect(await violationsOf('order_amounts')).toBeGreaterThan(0);
  });

  it('订单行金额与单价×数量不一致会被检出', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: 'D', price: 1000, stock: 5 });
    await activateEvent(eventId);
    await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      paymentMethodId: cashId,
      tenderedMinor: 1000
    });
    await raw('UPDATE order_items SET subtotal_minor = 1');
    expect(await violationsOf('order_item_amounts')).toBeGreaterThan(0);
  });

  it('库存余额与流水不一致会被检出', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: 'E', price: 1000, stock: 5 });
    await activateEvent(eventId);
    await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      paymentMethodId: cashId,
      tenderedMinor: 1000
    });
    expect(await violationsOf('inventory_physical_matches_tx')).toBe(0);

    // 直接改余额但不动流水（模拟外部工具改库）
    await raw('UPDATE inventory SET physical_stock = physical_stock + 7');
    expect(await violationsOf('inventory_physical_matches_tx')).toBeGreaterThan(0);
  });

  it('预留与待付款订单成分不一致会被检出', async () => {
    const { eventId, categoryId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: 'F', price: 1000, stock: 20 });
    await activateEvent(eventId);
    // 制造一个预留但没有对应待付款订单的状态
    await raw('UPDATE inventory SET reserved_stock = 3 WHERE variant_id = ? AND physical_stock >= 3', [
      variantId
    ]);
    expect(await violationsOf('reserved_matches_pending_orders')).toBeGreaterThan(0);
  });

  it('库存商品行缺少成分快照会被检出', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: 'G', price: 1000, stock: 5 });
    await activateEvent(eventId);
    await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      paymentMethodId: cashId,
      tenderedMinor: 1000
    });
    await raw('DELETE FROM order_inventory_components');
    expect(await violationsOf('stock_items_have_components')).toBeGreaterThan(0);
  });
});

describe('资源往返（第 21 节）', () => {
  it('图片与收款码字节在整库往返后完全一致', async () => {
    const bytes = new Uint8Array(512);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const assetId = await createAsset('image/png', 64, 64, bytes, 'testhash');

    const exported = tdb.exportBytes();
    const restored = await openFromBytes(exported);
    bindExecutor(restored.executor);

    const row = await ex().readOne<{ blob: Uint8Array; mime_type: string; width: number }>(
      'SELECT blob, mime_type, width FROM assets WHERE id = ?',
      [assetId]
    );
    expect(row).not.toBeNull();
    expect(row!.mime_type).toBe('image/png');
    expect(row!.width).toBe(64);
    expect(row!.blob.length).toBe(bytes.length);
    expect(Array.from(row!.blob)).toEqual(Array.from(bytes));
    restored.close();
  });

  it('导出字节可直接被 SQLite 打开且完整性检查通过', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: 'H', price: 500, stock: 3 });
    await activateEvent(eventId);
    await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 2 }],
      paymentMethodId: cashId,
      tenderedMinor: 1000,
      operationId: newId()
    });

    const exported = tdb.exportBytes();
    expect(exported.length).toBeGreaterThan(1024); // 不是空壳
    const restored = await openFromBytes(exported);
    bindExecutor(restored.executor);
    const integrity = await ex().read('PRAGMA integrity_check');
    expect(String(Object.values(integrity[0] as Record<string, unknown>)[0])).toBe('ok');
    for (const check of INVARIANT_CHECKS) {
      expect(await violationsOf(check.name), check.label).toBe(0);
    }
    restored.close();
  });
});
