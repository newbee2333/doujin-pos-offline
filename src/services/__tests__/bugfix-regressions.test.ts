import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/test-executor';
import { INVARIANT_CHECKS } from '../../db/invariants';
import { formatMoney } from '../../domain/money';
import { validateEventDates } from '../../domain/event-dates';
import { bindExecutor, ex } from '../context';
import {
  createAsset,
  createProduct,
  deleteUnusedAssets,
  getAsset,
  listCategories,
  setBundleComponents,
  updateProduct,
  updateVariant
} from '../catalog';
import {
  activateEvent,
  addVariantsToEvent,
  checkEventReady,
  closeEvent,
  createEvent,
  listPaymentMethods,
  reopenEvent,
  setEventPaymentMethods,
  updateConfig,
  updatePaymentMethod
} from '../events';
import { adjustStock, initializeStock, listTransactions } from '../inventory';
import {
  buildOrderPlan,
  confirmPayment,
  correctOrder,
  countPendingOrders,
  createPendingOrder,
  getKioskMenu,
  getOrderDetail,
  staffDirectSale
} from '../orders';
import { getPromotions, savePromotions } from '../promotions';
import {
  exportInventoryTransactionsCsv,
  getInventoryConsumption
} from '../reports';
import { getCurrentEventId, setCurrentEventId } from '../system';

let tdb: TestDatabase;

beforeEach(async () => {
  tdb = await createTestDatabase();
  bindExecutor(tdb.executor);
});

afterEach(() => {
  tdb.close();
});

async function assertInvariants() {
  for (const check of INVARIANT_CHECKS) {
    const row = await ex().readOne<Record<string, number>>(check.sql);
    expect(Object.values(row!)[0], check.name).toBe(0);
  }
}

async function setupActiveEvent() {
  const eventId = await createEvent({ name: '回归测试展', currency: 'CNY' });
  const catId = (await listCategories())[0].id;
  const methods = await listPaymentMethods();
  const cash = methods.find((m) => m.type === 'cash')!;
  const qr = methods.find((m) => m.type === 'qr_payment')!;
  const qrAssetId = await createAsset('image/png', 100, 100, new Uint8Array([1, 2, 3]), 'h-qr-1');
  await updatePaymentMethod(cash.id, { enabled: true });
  await updatePaymentMethod(qr.id, { enabled: true, qr_asset_id: qrAssetId });
  await setEventPaymentMethods(eventId, [cash.id, qr.id]);

  const prod = await createProduct({
    name: '测试本子',
    type: 'normal',
    category_id: catId,
    default_currency: 'CNY',
    default_price_minor: 5000
  });
  await addVariantsToEvent(eventId, [prod.variantId]);
  await initializeStock(eventId, prod.variantId, 20);
  await activateEvent(eventId);
  return { eventId, catId, cashId: cash.id, qrId: qr.id, qrAssetId, ...prod };
}

describe('P0/P1/P2 逻辑修复回归测试', () => {
  it('日元负数金额负号位于货币符号之前', () => {
    expect(formatMoney(-500, 'JPY')).toBe('-¥500 JPY');
    expect(formatMoney(-12500, 'JPY')).toBe('-¥12,500 JPY');
    expect(formatMoney(0, 'JPY')).toBe('¥0 JPY');
  });

  it('展会日期校验拒绝无效日历日期（如 2 月 30 日）', () => {
    expect(validateEventDates('2025-02-30', '2025-02-31')).not.toBeNull();
    expect(validateEventDates('2025-02-28', '2025-03-01')).toBeNull();
  });

  it('库存消耗报表不再重复扣减已纠错订单的返库数（净消耗不会为负）', async () => {
    const { eventId, cashId, variantId } = await setupActiveEvent();
    // 正常卖出 1 件
    await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      paymentMethodId: cashId,
      tenderedMinor: 5000
    });
    // 误录 3 件并撤销误记返库 3 件
    const wrong = await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 3 }],
      paymentMethodId: cashId,
      tenderedMinor: 15000
    });
    await correctOrder({
      orderId: wrong.orderId,
      reason: '多录一单',
      returns: { [variantId]: 3 }
    });

    const rows = await getInventoryConsumption(eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0].sold_units).toBe(1);
    expect(rows[0].returned_units).toBe(0);
    expect(rows[0].net_units).toBe(1);
    await assertInvariants();
  });

  it('initializeStock 与 adjustStock 幂等重试不会报 UNIQUE 错', async () => {
    const { eventId, catId } = await setupActiveEvent();
    const p = await createProduct({
      name: '幂等徽章',
      type: 'normal',
      category_id: catId,
      default_currency: 'CNY',
      default_price_minor: 1500
    });
    await addVariantsToEvent(eventId, [p.variantId]);

    await initializeStock(eventId, p.variantId, 10, 'init-op-1');
    await initializeStock(eventId, p.variantId, 10, 'init-op-1');

    const r1 = await adjustStock({
      eventId,
      variantId: p.variantId,
      deltaPhysical: 5,
      type: 'restock',
      reason: '补货',
      operationId: 'adj-op-1'
    });
    const r2 = await adjustStock({
      eventId,
      variantId: p.variantId,
      deltaPhysical: 5,
      type: 'restock',
      reason: '补货',
      operationId: 'adj-op-1'
    });
    expect(r1).toEqual({ before: 10, after: 15 });
    expect(r2).toEqual({ before: 10, after: 15 });
    await assertInvariants();
  });

  it('展会状态机守卫：禁止强关含待付款的旧场、禁止重开草稿、允许无定价赠品开场', async () => {
    const { eventId, catId, cashId, variantId } = await setupActiveEvent();
    await createPendingOrder({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      plannedPaymentMethodId: cashId
    });
    expect(await countPendingOrders(eventId)).toBe(1);

    // 另一场草稿展会（仅含无定价赠品）
    const ev2 = await createEvent({ name: '二号草稿展', currency: 'CNY' });
    await setEventPaymentMethods(ev2, [cashId]);
    const gift = await createProduct({
      name: '免费无料明信片',
      type: 'gift',
      category_id: catId,
      default_currency: 'CNY',
      default_price_minor: null
    });
    await addVariantsToEvent(ev2, [gift.variantId]);
    await initializeStock(ev2, gift.variantId, 30);

    // 无定价赠品不应阻断就绪检查
    expect(await checkEventReady(ev2)).toEqual([]);
    // 不能对 draft 调用 reopenEvent
    await expect(reopenEvent(ev2, '绕过测试')).rejects.toThrow('只有已收摊');
    // 不能在旧场仍有待付款订单时直接开新场
    await expect(activateEvent(ev2)).rejects.toThrow('待付款');

    // 清掉旧场待付款后即可收摊，且已收摊不能再调 activateEvent
    const detail = await ex().readOne<{ id: string }>("SELECT id FROM orders WHERE event_id = ? AND status = 'pending_payment'", [eventId]);
    await confirmPayment({ orderId: detail!.id, paymentMethodId: cashId, tenderedMinor: 5000 });
    await closeEvent(eventId);
    await expect(activateEvent(eventId)).rejects.toThrow('重新打开');
    await assertInvariants();
  });

  it('降价或清空本场定价会自动清理失效活动特价，不锁死保存优惠', async () => {
    const { eventId, variantId } = await setupActiveEvent();
    const rules = await getPromotions(eventId);
    await savePromotions(eventId, {
      ...rules,
      prices: { [variantId]: { kind: 'price', value: 4000 } }
    });
    // 本场价降到 3000（低于原特价 4000）
    await updateConfig(eventId, variantId, { event_price_minor: 3000 });
    const afterLower = await getPromotions(eventId);
    expect(afterLower.prices[variantId]).toBeUndefined();

    // 重新加特价 2500 后清空本场价
    await savePromotions(eventId, {
      ...afterLower,
      prices: { [variantId]: { kind: 'price', value: 2500 } }
    });
    await updateConfig(eventId, variantId, { event_price_minor: null });
    const afterClear = await getPromotions(eventId);
    expect(afterClear.prices[variantId]).toBeUndefined();
    // 仍能正常保存满减等其他优惠
    await savePromotions(eventId, {
      ...afterClear,
      tiers: [{ threshold: 10000, reduction: 1000 }]
    });
  });

  it('游客菜单过滤未定价非赠品；deleteUnusedAssets 保留待付款订单引用的收款码', async () => {
    const { eventId, catId, qrId, qrAssetId, variantId } = await setupActiveEvent();
    const unpriced = await createProduct({
      name: '未定价新品',
      type: 'normal',
      category_id: catId,
      default_currency: 'JPY',
      default_price_minor: 1000
    });
    await addVariantsToEvent(eventId, [unpriced.variantId]);
    await initializeStock(eventId, unpriced.variantId, 5);
    const menu = await getKioskMenu(eventId);
    expect(menu.some((m) => m.variant_id === unpriced.variantId)).toBe(false);

    // 用旧收款码创建待付款订单，随后更换收款码并清理未用资源
    await createPendingOrder({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      plannedPaymentMethodId: qrId
    });
    const newQrId = await createAsset('image/png', 100, 100, new Uint8Array([4, 5, 6]), 'h-qr-2');
    await updatePaymentMethod(qrId, { qr_asset_id: newQrId });
    const orphanId = await createAsset('image/png', 10, 10, new Uint8Array([9]), 'h-orphan');

    const deleted = await deleteUnusedAssets();
    expect(deleted).toBe(1);
    expect(await getAsset(qrAssetId)).not.toBeNull();
    expect(await getAsset(orphanId)).toBeNull();
  });

  it('混合订单确认收款按商品行记录 sale/gift；非现金收款不写入负数找零；停用方式不可下单', async () => {
    const { eventId, catId, cashId, qrId, variantId } = await setupActiveEvent();
    const gift = await createProduct({
      name: '满赠特典',
      type: 'gift',
      category_id: catId,
      default_currency: 'CNY',
      default_price_minor: 0
    });
    await addVariantsToEvent(eventId, [gift.variantId]);
    await updateConfig(eventId, gift.variantId, { kiosk_visible: 1 });
    await initializeStock(eventId, gift.variantId, 10);

    const { orderId } = await createPendingOrder({
      eventId,
      lines: [
        { variantId, quantity: 1 },
        { variantId: gift.variantId, quantity: 1 }
      ],
      plannedPaymentMethodId: qrId
    });

    // 非现金即便误传 tenderedMinor: 0 也不写负数找零
    await confirmPayment({ orderId, paymentMethodId: qrId, tenderedMinor: 0 });
    const detail = (await getOrderDetail(orderId))!;
    expect(detail.payment?.tendered_minor).toBeNull();
    expect(detail.payment?.change_minor).toBeNull();

    const txs = await listTransactions(eventId);
    const saleTx = txs.find((t) => t.order_id === orderId && t.variant_id === variantId && t.delta_physical < 0);
    const giftTx = txs.find((t) => t.order_id === orderId && t.variant_id === gift.variantId && t.delta_physical < 0);
    expect(saleTx?.type).toBe('sale');
    expect(giftTx?.type).toBe('gift');

    // 现金 NaN 被拦下
    const pending2 = await createPendingOrder({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      plannedPaymentMethodId: cashId
    });
    await expect(
      confirmPayment({ orderId: pending2.orderId, paymentMethodId: cashId, tenderedMinor: Number.NaN })
    ).rejects.toThrow('有效实收金额');

    // 从本场移除 qrId 后不可再用来下单
    await setEventPaymentMethods(eventId, [cashId]);
    await expect(
      createPendingOrder({
        eventId,
        lines: [{ variantId, quantity: 1 }],
        plannedPaymentMethodId: qrId
      })
    ).rejects.toThrow('未启用');
    await assertInvariants();
  });

  it('CSV 导出保留负数数值不加单引号；buildOrderPlan 优先报下架而非未定价；SKU 冲突抛友好错误；currentEventId 置空返回 null', async () => {
    const { eventId, catId, cashId, variantId } = await setupActiveEvent();
    await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 2 }],
      paymentMethodId: cashId,
      tenderedMinor: 10000
    });
    const csv = await exportInventoryTransactionsCsv(eventId);
    expect(csv).toContain(',-2,');
    expect(csv).not.toContain(",'-2,");

    // 商品下架且清空价格时，buildOrderPlan 报「本场未上架」而不是笼统报「未设置本场价格」
    await updateConfig(eventId, variantId, { enabled: 0, event_price_minor: null });
    await expect(buildOrderPlan(eventId, [{ variantId, quantity: 1 }], { source: 'kiosk' })).rejects.toThrow('未上架');

    // SKU 唯一冲突抛 DomainError
    const p1 = await createProduct({ name: 'SKU商品1', type: 'normal', category_id: catId, sku: 'DUP-001' });
    await expect(
      createProduct({ name: 'SKU商品2', type: 'normal', category_id: catId, sku: 'DUP-001' })
    ).rejects.toThrow('SKU 在全库必须唯一');
    const p2 = await createProduct({ name: 'SKU商品3', type: 'normal', category_id: catId, sku: 'DUP-002' });
    await expect(updateVariant(p2.variantId, { sku: 'DUP-001' })).rejects.toThrow('SKU 在全库必须唯一');

    // 套装成分不可变更库存语义类型
    const bundle = await createProduct({ name: '测试套装', type: 'bundle', category_id: catId });
    await setBundleComponents(bundle.variantId, [{ component_variant_id: p1.variantId, quantity: 1 }]);
    await expect(updateProduct(p1.productId, { type: 'non_stock' })).rejects.toThrow('套装');

    // setCurrentEventId(null) 后取回 null 而非空串
    await setCurrentEventId(eventId);
    expect(await getCurrentEventId()).toBe(eventId);
    await setCurrentEventId(null);
    expect(await getCurrentEventId()).toBeNull();
  });
});
