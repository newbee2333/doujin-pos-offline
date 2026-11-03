import type { Step } from '../db/executor';
import { newId } from '../domain/ids';
import { emptyRules, priceOrder, type OrderAdjustment, type PriceAdjustment, type PriceLine, type PromotionRules } from '../domain/pricing';
import { auditStep, beginIdempotent, ex, idempotencyStep } from './context';
import { authorizeAdjustment } from './promotions';
import { getOrderDetail, type OrderDetail } from './orders';

export interface AdjustmentLine extends PriceLine { sourceItemId: string; name: string }
export function pendingPriceLines(detail: OrderDetail): AdjustmentLine[] {
  return detail.items.map(item => {
    const snapshot = item.pricing_json ? JSON.parse(item.pricing_json) as PriceLine : null;
    return { lineId: item.id, sourceItemId: item.id, variantId: item.variant_id, name: `${item.product_name_snapshot}（${item.variant_name_snapshot}）`,
      quantity: item.quantity, listUnit: snapshot?.listUnit ?? item.unit_price_minor, autoUnit: snapshot?.autoUnit ?? item.unit_price_minor,
      eligible: snapshot?.eligible ?? false, manual: snapshot?.manual };
  });
}
export function pendingRules(detail: OrderDetail): PromotionRules {
  return detail.order.pricing_json ? JSON.parse(detail.order.pricing_json).rules : emptyRules();
}
export function pendingManual(detail: OrderDetail): OrderAdjustment | undefined {
  return detail.order.pricing_json ? JSON.parse(detail.order.pricing_json).manual : undefined;
}
export async function beginOrderAdjustment(orderId: string, version: number): Promise<void> {
  await ex().tx([{ t: 'run', sql: "UPDATE orders SET pricing_editing=1 WHERE id=? AND status='pending_payment' AND pricing_version=?", params: [orderId, version], expectChanges: 1 }]);
}
export async function cancelOrderAdjustment(orderId: string, version: number): Promise<void> {
  await ex().tx([{ t: 'run', sql: "UPDATE orders SET pricing_editing=0 WHERE id=? AND status='pending_payment' AND pricing_version=?", params: [orderId, version], expectChanges: 1 }]);
}
export async function acknowledgeOrderPrice(orderId: string, version: number, actor: 'staff' | 'kiosk'): Promise<void> {
  await ex().tx([
    { t: 'run', sql: "UPDATE orders SET customer_ack_version=? WHERE id=? AND status='pending_payment' AND pricing_version=? AND pricing_editing=0", params: [version, orderId, version], expectChanges: 1 },
    auditStep('order.priceAcknowledged', 'order', orderId, { version }, actor)
  ]);
}
export async function adjustPendingPrice(input: { orderId: string; version: number; lines: AdjustmentLine[]; manual?: OrderAdjustment; reason: string; pin?: string; operationId: string }) {
  const { pin, ...payload } = input;
  const { hash, existing } = await beginIdempotent('order.adjustPrice', input.operationId, payload);
  if (existing) return;
  const detail = await getOrderDetail(input.orderId);
  if (!detail || detail.order.status !== 'pending_payment') throw new Error('只有待付款订单可以调价');
  if (detail.order.pricing_version !== input.version || !detail.order.pricing_editing) throw new Error('订单已变化，请刷新后重新调整');
  const originals = pendingPriceLines(detail);
  // Reconstruct trusted price bases from stored order snapshots. UI cannot alter eligibility or base prices.
  const lines = input.lines.map(line => {
    const original = originals.find(o => o.sourceItemId === line.sourceItemId);
    if (!original) throw new Error('订单明细已变化');
    return { ...original, lineId: line.lineId, quantity: line.quantity, manual: line.manual };
  });
  for (const original of originals) {
    if (lines.filter(l => l.sourceItemId === original.sourceItemId).reduce((s, l) => s + l.quantity, 0) !== original.quantity) throw new Error('调价不能改变订单商品数量，请取消订单后重新下单');
  }
  const rules = pendingRules(detail);
  const quote = { ...priceOrder(lines, rules.tiers, input.manual), rules, manual: input.manual };
  await authorizeAdjustment(pin);
  const steps: Step[] = [
    { t: 'assert', sql: "SELECT COUNT(*) FROM orders WHERE id=? AND status='pending_payment' AND pricing_version=? AND pricing_editing=1", params: [input.orderId, input.version], equals: 1, message: '订单已变化，调价未保存' },
    { t: 'run', sql: 'DELETE FROM order_inventory_components WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id=?)', params: [input.orderId] },
    { t: 'run', sql: 'DELETE FROM order_items WHERE order_id=?', params: [input.orderId] }
  ];
  for (const [index, line] of lines.entries()) {
    const item = detail.items.find(i => i.id === line.sourceItemId)!;
    const priced = quote.lines[index];
    steps.push({ t: 'run', sql: 'INSERT INTO order_items (id,order_id,product_id,variant_id,product_name_snapshot,variant_name_snapshot,sku_snapshot,product_type_snapshot,unit_price_minor,quantity,subtotal_minor,pricing_json,net_minor) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      params: [line.lineId, input.orderId, item.product_id, item.variant_id, item.product_name_snapshot, item.variant_name_snapshot, item.sku_snapshot, item.product_type_snapshot, priced.unit, line.quantity, priced.subtotal, JSON.stringify(priced), priced.net] });
    for (const component of item.components) {
      const quantity = component.quantity_total / item.quantity * line.quantity;
      if (!Number.isSafeInteger(quantity)) throw new Error('库存成分快照数量不正确');
      steps.push({ t: 'run', sql: 'INSERT INTO order_inventory_components (id,order_item_id,component_variant_id,quantity_total,component_name_snapshot,sku_snapshot) VALUES (?,?,?,?,?,?)',
        params: [newId(), line.lineId, component.component_variant_id, quantity, component.component_name_snapshot, component.sku_snapshot ?? null] });
    }
  }
  steps.push(
    { t: 'run', sql: 'UPDATE orders SET subtotal_minor=?,total_minor=?,pricing_json=?,pricing_version=pricing_version+1,pricing_editing=0 WHERE id=?', params: [quote.subtotal, quote.total, JSON.stringify(quote), input.orderId] },
    auditStep('order.adjustPrice', 'order', input.orderId, { before: detail.order.total_minor, after: quote.total, reason: input.reason.trim(), pricing: quote, version: input.version + 1 }),
    idempotencyStep(input.operationId, 'order.adjustPrice', hash, { orderId: input.orderId })
  );
  await ex().tx(steps);
}
