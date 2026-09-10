import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, openFromBytes, type TestDatabase } from '../../db/test-executor';
import { INVARIANT_CHECKS } from '../../db/invariants';
import { bindExecutor, ex } from '../context';
import { IdempotencyConflictError } from '../context';
import {
  confirmPayment,
  correctOrder,
  createPendingOrder,
  getKioskMenu,
  getOrderDetail,
  recordRefund,
  staffDirectSale,
  voidOrder
} from '../orders';
import {
  addVariantsToEvent,
  activateEvent,
  checkEventReady,
  createEvent,
  listPaymentMethods,
  setEventPaymentMethods,
  updateConfig,
  updatePaymentMethod
} from '../events';
import {
  createCategory,
  createProduct,
  listCategories,
  setBundleComponents,
  updateCategory,
  updateProduct
} from '../catalog';
import { adjustStock, getInventory, initializeStock, listTransactions, reconcile } from '../inventory';
import {
  addCashMovement,
  exportOrderItemsCsv,
  getDashboard,
  getExpectedCash,
  getInventoryConsumption,
  getPaymentSummary
} from '../reports';
import { parseAmountToMinor, formatMoney } from '../../domain/money';
import type { Currency, ProductType } from '../../domain/types';

let tdb: TestDatabase;

async function setupEvent(currency: Currency = 'CNY') {
  const eventId = await createEvent({ name: 'C107', currency });
  // 建库时已种入默认分类，避免重复创建
  const existing = (await listCategories()).find((c) => c.name === '新刊');
  const categoryId = existing ? existing.id : await createCategory('新刊');
  const cash = (await listPaymentMethods()).find((m) => m.type === 'cash')!;
  await updatePaymentMethod(cash.id, { enabled: true });
  await setEventPaymentMethods(eventId, [cash.id]);
  return { eventId, categoryId, cashId: cash.id };
}

async function addItem(
  eventId: string,
  categoryId: string,
  opts: { name: string; type?: ProductType; price: number; stock?: number }
) {
  const { productId, variantId } = await createProduct({
    name: opts.name,
    type: opts.type ?? 'normal',
    category_id: categoryId,
    default_currency: 'CNY',
    default_price_minor: opts.price
  });
  await addVariantsToEvent(eventId, [variantId]);
  await updateConfig(eventId, variantId, { event_price_minor: opts.price });
  if ((opts.type ?? 'normal') !== 'non_stock') {
    await initializeStock(eventId, variantId, opts.stock ?? 10);
  }
  return { productId, variantId };
}

beforeEach(async () => {
  if (tdb) tdb.close();
  tdb = await createTestDatabase();
  bindExecutor(tdb.executor);
});

describe('金额（第 6 节）', () => {
  it('人民币按分精确累计，不出现浮点误差', () => {
    const unit = parseAmountToMinor('0.10', 'CNY');
    expect(unit).toBe(10);
    expect(unit * 3).toBe(30);
    expect(formatMoney(30, 'CNY')).toBe('¥0.30 CNY');
  });

  it('日元不接受小数，展示不带小数', () => {
    expect(parseAmountToMinor('1200', 'JPY')).toBe(1200);
    expect(() => parseAmountToMinor('1200.5', 'JPY')).toThrow();
    expect(formatMoney(1200, 'JPY')).toBe('¥1,200 JPY');
  });

  it('人民币最多两位小数，其他格式拒绝', () => {
    expect(() => parseAmountToMinor('1.234', 'CNY')).toThrow();
    expect(() => parseAmountToMinor('abc', 'CNY')).toThrow();
    expect(parseAmountToMinor('12', 'CNY')).toBe(1200);
  });
});

describe('摊主直接销售（第 16 节）', () => {
  it('扣减实际库存并生成一条收款记录', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: '新刊A', price: 2500, stock: 5 });
    await activateEvent(eventId);

    const { orderId } = await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 2 }],
      paymentMethodId: cashId,
      tenderedMinor: 6000
    });

    const inv = await getInventory(eventId, variantId);
    expect(inv?.physical_stock).toBe(3);
    expect(inv?.reserved_stock).toBe(0);

    const detail = await getOrderDetail(orderId);
    expect(detail?.order.status).toBe('completed');
    expect(detail?.order.total_minor).toBe(5000);
    expect(detail?.payment?.amount_minor).toBe(5000);
    expect(detail?.payment?.tendered_minor).toBe(6000);
    expect(detail?.payment?.change_minor).toBe(1000);
    expect(await reconcile(eventId)).toEqual([]);
  });

  it('零元赠品订单扣库存但不生成收款记录', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, {
      name: '无料贴纸',
      type: 'gift',
      price: 0,
      stock: 4
    });
    await activateEvent(eventId);

    const { orderId } = await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      paymentMethodId: cashId
    });

    const inv = await getInventory(eventId, variantId);
    expect(inv?.physical_stock).toBe(3);
    const detail = await getOrderDetail(orderId);
    expect(detail?.order.total_minor).toBe(0);
    expect(detail?.payment).toBeNull();
  });
});

describe('待付款生命周期（第 13、16 节）', () => {
  it('预留 → 确认：释放预留并扣实际库存，余额与流水一致', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: '新刊B', price: 1000, stock: 5 });
    await activateEvent(eventId);

    const { orderId } = await createPendingOrder({
      eventId,
      lines: [{ variantId, quantity: 2 }],
      plannedPaymentMethodId: cashId
    });
    let inv = await getInventory(eventId, variantId);
    expect(inv?.physical_stock).toBe(5);
    expect(inv?.reserved_stock).toBe(2);

    await confirmPayment({ orderId, paymentMethodId: cashId, tenderedMinor: 2000 });
    inv = await getInventory(eventId, variantId);
    expect(inv?.physical_stock).toBe(3);
    expect(inv?.reserved_stock).toBe(0);

    const txs = await listTransactions(eventId, variantId);
    expect(txs.filter((t) => t.type === 'reservation')).toHaveLength(1);
    expect(txs.filter((t) => t.type === 'sale')).toHaveLength(1);
    expect(await reconcile(eventId)).toEqual([]);
  });

  it('取消：只释放预留，不动实际库存', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: '新刊C', price: 1000, stock: 5 });
    await activateEvent(eventId);

    const { orderId } = await createPendingOrder({
      eventId,
      lines: [{ variantId, quantity: 3 }],
      plannedPaymentMethodId: cashId
    });
    await voidOrder(orderId, '游客放弃');

    const inv = await getInventory(eventId, variantId);
    expect(inv?.physical_stock).toBe(5);
    expect(inv?.reserved_stock).toBe(0);
    const detail = await getOrderDetail(orderId);
    expect(detail?.order.status).toBe('voided');
  });
});

describe('库存校验（第 10、11 节）', () => {
  it('库存不足时整单拒绝，不留半笔记录', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: '限量本', price: 1000, stock: 2 });
    await activateEvent(eventId);

    await expect(
      staffDirectSale({ eventId, lines: [{ variantId, quantity: 3 }], paymentMethodId: cashId, tenderedMinor: 3000 })
    ).rejects.toThrow(/库存不足/);

    const inv = await getInventory(eventId, variantId);
    expect(inv?.physical_stock).toBe(2);
    const orders = await ex().read('SELECT COUNT(*) AS c FROM orders');
    expect(Number(orders[0].c)).toBe(0);
  });

  it('单品与套装共用最后一件库存时必须整单校验', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId: compId } = await addItem(eventId, categoryId, { name: '单品A', price: 1000, stock: 1 });
    const bundle = await createProduct({ name: '套装', type: 'bundle', category_id: categoryId, default_currency: 'CNY' });
    await addVariantsToEvent(eventId, [bundle.variantId]);
    await updateConfig(eventId, bundle.variantId, { event_price_minor: 1500 });
    await setBundleComponents(bundle.variantId, [{ component_variant_id: compId, quantity: 1 }]);
    await activateEvent(eventId);

    await expect(
      staffDirectSale({
        eventId,
        lines: [
          { variantId: compId, quantity: 1 },
          { variantId: bundle.variantId, quantity: 1 }
        ],
        paymentMethodId: cashId,
        tenderedMinor: 5000
      })
    ).rejects.toThrow(/库存不足/);

    expect((await getInventory(eventId, compId))?.physical_stock).toBe(1);
  });

  it('盘点导致实际库存低于已有预留时拒绝', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: '新刊D', price: 1000, stock: 5 });
    await activateEvent(eventId);
    await createPendingOrder({ eventId, lines: [{ variantId, quantity: 4 }], plannedPaymentMethodId: cashId });

    await expect(
      adjustStock({ eventId, variantId, deltaPhysical: -2, type: 'correction', reason: '盘点' })
    ).rejects.toThrow(/低于已预留/);

    const inv = await getInventory(eventId, variantId);
    expect(inv?.physical_stock).toBe(5);
  });

  it('合并限购：套装成分与普通行一起计', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId: compId } = await addItem(eventId, categoryId, { name: '限购本', price: 500, stock: 20 });
    await updateConfig(eventId, compId, { purchase_limit: 2 });
    await activateEvent(eventId);

    await expect(
      staffDirectSale({ eventId, lines: [{ variantId: compId, quantity: 3 }], paymentMethodId: cashId, tenderedMinor: 5000 })
    ).rejects.toThrow(/限购/);
  });
});

describe('订单快照（第 11、13 节）', () => {
  it('套装配方变化后，旧订单确认仍按原快照扣库', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const a = await addItem(eventId, categoryId, { name: '成分A', price: 800, stock: 10 });
    const b = await addItem(eventId, categoryId, { name: '成分B', price: 900, stock: 10 });
    const bundle = await createProduct({ name: '套装', type: 'bundle', category_id: categoryId, default_currency: 'CNY' });
    await addVariantsToEvent(eventId, [bundle.variantId]);
    await updateConfig(eventId, bundle.variantId, { event_price_minor: 1500 });
    await setBundleComponents(bundle.variantId, [{ component_variant_id: a.variantId, quantity: 1 }]);
    await activateEvent(eventId);

    const { orderId } = await createPendingOrder({
      eventId,
      lines: [{ variantId: bundle.variantId, quantity: 1 }],
      plannedPaymentMethodId: cashId
    });

    // 改配方：换成成分 B
    await setBundleComponents(bundle.variantId, [{ component_variant_id: b.variantId, quantity: 1 }]);

    await confirmPayment({ orderId, paymentMethodId: cashId, tenderedMinor: 1500 });

    expect((await getInventory(eventId, a.variantId))?.physical_stock).toBe(9);
    expect((await getInventory(eventId, b.variantId))?.physical_stock).toBe(10);
    expect(await reconcile(eventId)).toEqual([]);
  });

  it('改名与改支付方式不影响历史订单快照', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { productId, variantId } = await addItem(eventId, categoryId, { name: '原名', price: 1000, stock: 5 });
    await activateEvent(eventId);
    const { orderId } = await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      paymentMethodId: cashId,
      tenderedMinor: 1000
    });

    await updateProduct(productId, { name: '改名后' });
    await updatePaymentMethod(cashId, { name: '现金（改名）' });

    const detail = await getOrderDetail(orderId);
    expect(detail?.items[0].product_name_snapshot).toBe('原名');
    expect(detail?.payment?.method_name_snapshot).toBe('现金');
  });
});

describe('退款与纠错（第 17 节）', () => {
  it('整单退款：全额、部分返库，重复退款被阻止', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: '退款测试', price: 2000, stock: 5 });
    await activateEvent(eventId);
    const { orderId } = await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 2 }],
      paymentMethodId: cashId,
      tenderedMinor: 4000
    });

    await recordRefund({
      orderId,
      paymentMethodId: cashId,
      reason: '瑕疵品',
      returns: { [variantId]: 1 }
    });

    expect((await getInventory(eventId, variantId))?.physical_stock).toBe(4);
    const detail = await getOrderDetail(orderId);
    expect(detail?.order.status).toBe('refunded');
    expect(detail?.refund?.amount_minor).toBe(4000);
    expect(await reconcile(eventId)).toEqual([]);

    await expect(
      recordRefund({ orderId, paymentMethodId: cashId, reason: '再退一次', returns: {} })
    ).rejects.toThrow();
  });

  it('零返库也可以整单退款，金额仍为全额', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: '不返库', price: 1500, stock: 3 });
    await activateEvent(eventId);
    const { orderId } = await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      paymentMethodId: cashId,
      tenderedMinor: 1500
    });
    await recordRefund({ orderId, paymentMethodId: cashId, reason: '已带走', returns: { [variantId]: 0 } });
    expect((await getInventory(eventId, variantId))?.physical_stock).toBe(2);
    expect((await getOrderDetail(orderId))?.refund?.amount_minor).toBe(1500);
  });

  it('撤销误记与真实退款分开，报表与钱箱口径正确', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: '误记测试', price: 1000, stock: 5 });
    await activateEvent(eventId);
    await addCashMovement(eventId, 'opening', 500, '备用金');

    const { orderId } = await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      paymentMethodId: cashId,
      tenderedMinor: 1000
    });
    let cash = await getExpectedCash(eventId);
    expect(cash.expectedMinor).toBe(1500);

    await correctOrder({ orderId, reason: '误点确认', returns: { [variantId]: 1 } });

    cash = await getExpectedCash(eventId);
    expect(cash.expectedMinor).toBe(500); // 冲正后现金收款不再计入
    expect((await getInventory(eventId, variantId))?.physical_stock).toBe(5);

    const dash = await getDashboard(eventId);
    expect(dash.salesMinor).toBe(0); // corrected 不计销售
    expect(dash.correctionMinor).toBe(1000);
    expect(dash.refundMinor).toBe(0);
  });
});

describe('幂等与重复提交（第 5、27 节）', () => {
  it('同一 operation_id 重复提交只产生一笔订单', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: '幂等测试', price: 1000, stock: 5 });
    await activateEvent(eventId);
    const opId = 'fixed-operation-id-1';

    const first = await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      paymentMethodId: cashId,
      tenderedMinor: 1000,
      operationId: opId
    });
    const second = await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      paymentMethodId: cashId,
      tenderedMinor: 1000,
      operationId: opId
    });

    expect(second.orderId).toBe(first.orderId);
    const rows = await ex().read('SELECT COUNT(*) AS c FROM orders');
    expect(Number(rows[0].c)).toBe(1);
    expect((await getInventory(eventId, variantId))?.physical_stock).toBe(4);
  });

  it('同一 operation_id 参数不同则拒绝', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: '冲突测试', price: 1000, stock: 5 });
    await activateEvent(eventId);
    const opId = 'fixed-operation-id-2';
    await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      paymentMethodId: cashId,
      tenderedMinor: 1000,
      operationId: opId
    });
    await expect(
      staffDirectSale({
        eventId,
        lines: [{ variantId, quantity: 2 }],
        paymentMethodId: cashId,
        tenderedMinor: 2000,
        operationId: opId
      })
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

describe('报表口径（第 20 节）', () => {
  it('pending 与 voided 不计销售；refunded 保留销售并另列退款', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const sold = await addItem(eventId, categoryId, { name: '已售', price: 1000, stock: 10 });
    const cancelled = await addItem(eventId, categoryId, { name: '取消', price: 700, stock: 10 });
    const refunded = await addItem(eventId, categoryId, { name: '退款', price: 500, stock: 10 });
    await activateEvent(eventId);

    await staffDirectSale({
      eventId,
      lines: [{ variantId: sold.variantId, quantity: 1 }],
      paymentMethodId: cashId,
      tenderedMinor: 1000
    });
    const pending = await createPendingOrder({
      eventId,
      lines: [{ variantId: cancelled.variantId, quantity: 1 }],
      plannedPaymentMethodId: cashId
    });
    await voidOrder(pending.orderId, '放弃');
    const toRefund = await staffDirectSale({
      eventId,
      lines: [{ variantId: refunded.variantId, quantity: 1 }],
      paymentMethodId: cashId,
      tenderedMinor: 500
    });
    await recordRefund({
      orderId: toRefund.orderId,
      paymentMethodId: cashId,
      reason: '退回',
      returns: { [refunded.variantId]: 1 }
    });

    const dash = await getDashboard(eventId);
    expect(dash.salesMinor).toBe(1500); // 1000 + 500，含已退款的原销售
    expect(dash.refundMinor).toBe(500);
    expect(dash.netSalesMinor).toBe(1000);
    expect(dash.counts.voided).toBe(1);
    expect(dash.counts.refunded).toBe(1);
    expect(dash.counts.completed).toBe(1);

    const summary = await getPaymentSummary(eventId);
    const cash = summary.find((s) => s.method_name === '现金');
    expect(cash?.received_minor).toBe(1500);
    expect(cash?.refunded_minor).toBe(500);
    expect(cash?.net_minor).toBe(1000);
  });

  it('现金流水：备用金、存入、取出与现金退款', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: '现金测试', price: 1000, stock: 5 });
    await activateEvent(eventId);
    await addCashMovement(eventId, 'opening', 300, '备用金');
    await addCashMovement(eventId, 'deposit', 5000, '存入银行');

    const { orderId } = await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 2 }],
      paymentMethodId: cashId,
      tenderedMinor: 2000
    });

    let cash = await getExpectedCash(eventId);
    expect(cash.expectedMinor).toBe(300 + 2000 - 0 + 5000);

    await recordRefund({ orderId, paymentMethodId: cashId, reason: '退', returns: { [variantId]: 2 } });
    cash = await getExpectedCash(eventId);
    expect(cash.expectedMinor).toBe(300 + 2000 - 2000 + 5000);
    expect(cash.cashRefundMinor).toBe(2000);
  });
});

describe('不变量与往返（第 22、27 节）', () => {
  it('所有业务不变量在正常流程后为 0 违反', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: '对账测试', price: 1000, stock: 5 });
    await activateEvent(eventId);
    await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 1 }],
      paymentMethodId: cashId,
      tenderedMinor: 1000
    });

    for (const check of INVARIANT_CHECKS) {
      const rows = await ex().read(check.sql);
      const count = Number(rows.length ? Object.values(rows[0])[0] : 0);
      expect(count, check.label).toBe(0);
    }
  });

  it('整库往返后订单、库存、金额与报表一致', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: '往返测试', price: 1200, stock: 8 });
    const gift = await addItem(eventId, categoryId, { name: '无料', type: 'gift', price: 0, stock: 8 });
    await activateEvent(eventId);
    await addCashMovement(eventId, 'opening', 1000, '备用金');

    await staffDirectSale({
      eventId,
      lines: [{ variantId, quantity: 2 }],
      paymentMethodId: cashId,
      tenderedMinor: 2400
    });
    // 赠品默认只由摊主发放
    await staffDirectSale({
      eventId,
      lines: [{ variantId: gift.variantId, quantity: 1 }],
      paymentMethodId: cashId
    });

    const before = await getDashboard(eventId);
    const beforeInv = await getInventory(eventId, variantId);
    const beforeCsv = await exportOrderItemsCsv(eventId);
    const bytes = tdb.exportBytes();

    const restored = await openFromBytes(bytes);
    bindExecutor(restored.executor);
    const after = await getDashboard(eventId);
    const afterInv = await getInventory(eventId, variantId);
    const afterCsv = await exportOrderItemsCsv(eventId);

    expect(after).toEqual(before);
    expect(afterInv).toEqual(beforeInv);
    expect(afterCsv).toBe(beforeCsv);
    expect(await reconcile(eventId)).toEqual([]);
    restored.close();
  });
});

describe('游客菜单（第 12 节）', () => {
  it('隐藏分类与赠品默认不对游客展示，售罄标记正确', async () => {
    const { eventId, categoryId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: '公开本', price: 1000, stock: 1 });
    const gift = await addItem(eventId, categoryId, { name: 'staff 赠品', type: 'gift', price: 0, stock: 3 });
    const hidden = await createCategory('隐藏分类');
    await updateCategory(hidden, { hidden: true });
    const hiddenItem = await addItem(eventId, hidden, { name: '隐藏本', price: 500, stock: 2 });
    await activateEvent(eventId);

    const menu = await getKioskMenu(eventId);
    const ids = menu.map((m) => m.variant_id);
    expect(ids).toContain(variantId);
    expect(ids).not.toContain(gift.variantId);
    expect(ids).not.toContain(hiddenItem.variantId);

    const pub = menu.find((m) => m.variant_id === variantId)!;
    expect(pub.available_stock).toBe(1);
    expect(pub.price_minor).toBe(1000);
  });

  it('开局检查能发现未设置价格与未上传收款码', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const { variantId } = await addItem(eventId, categoryId, { name: '未定价', price: 0, stock: 1 });
    await updateConfig(eventId, variantId, { event_price_minor: null });
    const qr = (await listPaymentMethods()).find((m) => m.type === 'qr_payment')!;
    await updatePaymentMethod(qr.id, { enabled: true });
    await setEventPaymentMethods(eventId, [cashId, qr.id]);

    const issues = await checkEventReady(eventId);
    expect(issues.some((i) => i.includes('未设置本场价格'))).toBe(true);
    expect(issues.some((i) => i.includes('收款码未上传'))).toBe(true);
  });
});

describe('库存消耗统计（第 20 节）', () => {
  it('套装成分消耗与返库分别统计', async () => {
    const { eventId, categoryId, cashId } = await setupEvent();
    const a = await addItem(eventId, categoryId, { name: '成分A', price: 800, stock: 10 });
    const bundle = await createProduct({ name: '套装', type: 'bundle', category_id: categoryId, default_currency: 'CNY' });
    await addVariantsToEvent(eventId, [bundle.variantId]);
    await updateConfig(eventId, bundle.variantId, { event_price_minor: 1500 });
    await setBundleComponents(bundle.variantId, [{ component_variant_id: a.variantId, quantity: 2 }]);
    await activateEvent(eventId);

    const { orderId } = await staffDirectSale({
      eventId,
      lines: [{ variantId: bundle.variantId, quantity: 1 }],
      paymentMethodId: cashId,
      tenderedMinor: 1500
    });

    let rows = await getInventoryConsumption(eventId);
    expect(rows.find((r) => r.variant_id === a.variantId)?.sold_units).toBe(2);
    expect(rows.find((r) => r.variant_id === a.variantId)?.net_units).toBe(2);

    await recordRefund({ orderId, paymentMethodId: cashId, reason: '退', returns: { [a.variantId]: 1 } });
    rows = await getInventoryConsumption(eventId);
    const row = rows.find((r) => r.variant_id === a.variantId)!;
    expect(row.sold_units).toBe(2);
    expect(row.returned_units).toBe(1);
    expect(row.net_units).toBe(1);
    expect((await getInventory(eventId, a.variantId))?.physical_stock).toBe(9);
  });
});
