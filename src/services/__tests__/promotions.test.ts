import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, openFromBytes, type TestDatabase } from '../../db/test-executor';
import { buildMigrationSteps } from '../../db/bootstrap';
import { INVARIANT_CHECKS } from '../../db/invariants';
import { bindExecutor, ex, setSetting } from '../context';
import { createEvent, duplicateEvent, removeVariantsFromEvent, addVariantsToEvent, updateConfig, activateEvent, listPaymentMethods, updatePaymentMethod, setEventPaymentMethods } from '../events';
import { createProduct, listCategories, setBundleComponents } from '../catalog';
import { initializeStock } from '../inventory';
import { createPendingOrder, confirmPayment, staffDirectSale, getOrderDetail, getKioskMenu, recordRefund, buildOrderPlan } from '../orders';
import { getPromotions, savePromotions, quoteCart, authorizeAdjustment } from '../promotions';
import { acknowledgeOrderPrice, adjustPendingPrice, beginOrderAdjustment, cancelOrderAdjustment, pendingPriceLines } from '../order-pricing';
import { getDashboard, getProductRanking } from '../reports';
import { collectReport, createReportWorkbook } from '../report-export';
import { setPin } from '../system';

let db: TestDatabase, eventId: string, variantId: string, cashId: string;
beforeEach(async () => {
  db = await createTestDatabase(); bindExecutor(db.executor);
  eventId = await createEvent({ name: '优惠测试展', currency: 'CNY' });
  cashId = (await listPaymentMethods()).find(m => m.type === 'cash')!.id;
  await updatePaymentMethod(cashId, { enabled: true }); await setEventPaymentMethods(eventId, [cashId]);
  variantId = (await createProduct({ name: '原商品名', type: 'normal', category_id: (await listCategories())[0].id, default_currency: 'CNY', default_price_minor: 9999 })).variantId;
  await addVariantsToEvent(eventId, [variantId]); await updateConfig(eventId, variantId, { event_price_minor: 5000 }); await initializeStock(eventId, variantId, 50);
  await activateEvent(eventId); await setPin('1234');
});
afterEach(() => db.close());
async function promotion() { await savePromotions(eventId, { ...await getPromotions(eventId), tiers: [{ threshold: 15000, reduction: 2000 }] }); }
async function invariant() {
  for (const check of INVARIANT_CHECKS) {
    const result = await ex().readOne<Record<string, number>>(check.sql);
    expect(Object.values(result!)[0], check.name).toBe(0);
  }
}
describe('优惠业务与恢复', () => {
  it('复制展会带上优惠配置，移除再添加商品不残留旧活动价', async () => {
    await promotion();
    await savePromotions(eventId, { ...await getPromotions(eventId), prices: { [variantId]: { kind: 'price', value: 4000 } } });
    const copiedId = await duplicateEvent(eventId, '下一场');
    expect((await getPromotions(copiedId)).prices[variantId].value).toBe(4000);
    await removeVariantsFromEvent(eventId, [variantId]);
    const rules = await getPromotions(eventId);
    expect(rules.prices[variantId]).toBeUndefined();
    await addVariantsToEvent(eventId, [variantId]);
    await updateConfig(eventId, variantId, { event_price_minor: 3000 });
    await savePromotions(eventId, rules);
    expect((await quoteCart(eventId, [{ variantId, quantity: 1 }])).total).toBe(3000);
    expect((await getPromotions(copiedId)).prices[variantId].value).toBe(4000);
  });
  it('使用本场价格而非商品默认价，并检查最新活动版本', async () => {
    await promotion();
    expect((await quoteCart(eventId, [{ variantId, quantity: 3 }])).total).toBe(13000);
    const old = await quoteCart(eventId, [{ variantId, quantity: 3 }]);
    await savePromotions(eventId, { ...await getPromotions(eventId), prices: { [variantId]: { kind: 'rate', value: 8000 } } });
    await expect(createPendingOrder({ eventId, lines: [{ variantId, quantity: 3 }], plannedPaymentMethodId: cashId, expectedTotalMinor: old.total, expectedPromotionVersion: old.rules.version })).rejects.toThrow('变化');
    expect((await getKioskMenu(eventId))[0]).toMatchObject({ price_minor: 4000, list_price_minor: 5000 });
  });
  it('拆行收款120，报表、退款和备份恢复都使用同一实付金额，商品名不裂行', async () => {
    await promotion();
    const sale = await staffDirectSale({ eventId, lines: [{ variantId, lineId: 'full', quantity: 2 }, { variantId, lineId: 'discount', quantity: 1, manual: { kind: 'price', value: 4000 } }], paymentMethodId: cashId, tenderedMinor: 12000, adjustmentPin: '1234', adjustmentReason: '瑕疵优惠' });
    const detail = (await getOrderDetail(sale.orderId))!;
    expect(detail.order.total_minor).toBe(12000); expect(detail.items.reduce((s, i) => s + i.net_minor!, 0)).toBe(12000);
    expect((await getProductRanking(eventId))).toMatchObject([{ product_name: '原商品名', units: 3, amount_minor: 12000 }]);
    expect(await getDashboard(eventId)).toMatchObject({ salesMinor: 12000, discountMinor: 3000, listSalesMinor: 15000 });
    await invariant();
    const report = await collectReport(eventId); const book = await createReportWorkbook(report); expect((await book.xlsx.writeBuffer()).byteLength).toBeGreaterThan(1000);
    await recordRefund({ orderId: sale.orderId, paymentMethodId: cashId, reason: '整单退款', returns: { [variantId]: 3 } });
    expect((await getDashboard(eventId)).netSalesMinor).toBe(0); expect((await getProductRanking(eventId))[0].refund_order_count).toBe(1);
    const restored = await openFromBytes(db.exportBytes()); bindExecutor(restored.executor); await invariant(); restored.close(); bindExecutor(db.executor);
  });
  it('游客不能提交人工优惠，人工调价必须通过PIN', async () => {
    const lines = [{ variantId, quantity: 1, manual: { kind: 'price' as const, value: 4000 } }];
    await expect(createPendingOrder({ eventId, lines, plannedPaymentMethodId: cashId })).rejects.toThrow('游客');
    await expect(staffDirectSale({ eventId, lines, paymentMethodId: cashId, tenderedMinor: 4000 })).rejects.toThrow('密码');
    for (let i = 0; i < 5; i++) await expect(authorizeAdjustment('9999')).rejects.toThrow('不正确');
    await expect(authorizeAdjustment('1234')).rejects.toThrow('一分钟');
    expect((await ex().readOne<{ count: number }>('SELECT COUNT(*) AS count FROM orders'))!.count).toBe(0);
  });
  it('同规格拆行后，普通、套装、不计库存商品均不能绕过限购', async () => {
    const bundle = (await createProduct({ name: '套装', type: 'bundle', default_currency: 'CNY', default_price_minor: 5000 })).variantId;
    const nonStock = (await createProduct({ name: '不计库存', type: 'non_stock', default_currency: 'CNY', default_price_minor: 5000 })).variantId;
    await setBundleComponents(bundle, [{ component_variant_id: variantId, quantity: 1 }]); await addVariantsToEvent(eventId, [bundle, nonStock]);
    for (const id of [variantId, bundle, nonStock]) {
      await updateConfig(eventId, id, { event_price_minor: 5000, purchase_limit: 1 });
      await expect(buildOrderPlan(eventId, [{ variantId: id, lineId: 'a', quantity: 1 }, { variantId: id, lineId: 'b', quantity: 1 }], { source: 'staff' })).rejects.toThrow('限购');
    }
  });
  it('待付款调价锁、拆行、二次确认和旧版本收款拦截', async () => {
    await promotion();
    const { orderId } = await createPendingOrder({ eventId, lines: [{ variantId, quantity: 3 }], plannedPaymentMethodId: cashId });
    await beginOrderAdjustment(orderId, 0);
    await expect(confirmPayment({ orderId, tenderedMinor: 13000 })).rejects.toThrow('调整');
    const original = pendingPriceLines((await getOrderDetail(orderId))!)[0];
    const input = { orderId, version: 0, lines: [{ ...original, quantity: 2 }, { ...original, lineId: 'split', quantity: 1, manual: { kind: 'price' as const, value: 4000 } }], reason: '', pin: '1234', operationId: 'adjust-once' };
    await adjustPendingPrice(input); await adjustPendingPrice(input);
    expect((await getOrderDetail(orderId))!.order).toMatchObject({ total_minor: 12000, pricing_version: 1, pricing_editing: 0 });
    await invariant();
    await expect(confirmPayment({ orderId, tenderedMinor: 12000, expectedPricingVersion: 1 })).rejects.toThrow('重新确认');
    await acknowledgeOrderPrice(orderId, 1, 'kiosk');
    await expect(confirmPayment({ orderId, tenderedMinor: 13000, expectedPricingVersion: 0 })).rejects.toThrow('变化');
    await confirmPayment({ orderId, tenderedMinor: 12000, expectedPricingVersion: 1 }); await invariant();
  });
  it('取消调价解除锁定，已收款订单不能再进入调价', async () => {
    const { orderId } = await createPendingOrder({ eventId, lines: [{ variantId, quantity: 1 }], plannedPaymentMethodId: cashId });
    await beginOrderAdjustment(orderId, 0); await cancelOrderAdjustment(orderId, 0);
    await confirmPayment({ orderId, tenderedMinor: 5000 });
    await expect(beginOrderAdjustment(orderId, 0)).rejects.toThrow(); await invariant();
  });
  it('人工改为零元不产生收款记录，仍扣实际库存', async () => {
    await promotion();
    const sale = await staffDirectSale({ eventId, lines: [{ variantId, quantity: 3, manual: { kind: 'price', value: 0 } }], paymentMethodId: '', adjustmentPin: '1234', adjustmentReason: '赠送' });
    expect((await getOrderDetail(sale.orderId))!.payment).toBeNull(); await invariant();
  });
  it('v2 历史订单升级后金额与快照不变，可以继续收款和退款', async () => {
    const { orderId } = await createPendingOrder({ eventId, lines: [{ variantId, quantity: 1 }], plannedPaymentMethodId: cashId });
    await ex().tx([
      ...['pricing_json','pricing_version','customer_ack_version','pricing_editing'].map(name => ({ t: 'run' as const, sql: `ALTER TABLE orders DROP COLUMN ${name}` })),
      ...['pricing_json','net_minor'].map(name => ({ t: 'run' as const, sql: `ALTER TABLE order_items DROP COLUMN ${name}` })),
      { t: 'run', sql: "UPDATE metadata SET value='2' WHERE key='schema_version'" }
    ]);
    const restored = await openFromBytes(db.exportBytes()); bindExecutor(restored.executor);
    await ex().tx(buildMigrationSteps(2)); await updateConfig(eventId, variantId, { event_price_minor: 8000 });
    expect((await getOrderDetail(orderId))!.items[0].net_minor).toBe(5000);
    await confirmPayment({ orderId, tenderedMinor: 5000 }); await invariant();
    expect((await getDashboard(eventId)).discountMinor).toBe(0);
    await recordRefund({ orderId, paymentMethodId: cashId, reason: '退款', returns: { [variantId]: 1 } }); await invariant();
    restored.close(); bindExecutor(db.executor);
  });
});
