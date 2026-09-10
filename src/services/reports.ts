/** 报表、现金流水、收摊与 CSV（第 19、20、24 节）。 */

import type { CashMovement, Currency, Settlement } from '../domain/types';
import { newId, nowIso } from '../domain/ids';
import { auditStep, beginIdempotent, ex, idempotencyStep } from './context';
import { DomainError } from './catalog';
import { getEvent } from './events';

/** 有效成交：completed 与之后被退款的 refunded 都算原销售。 */
const SALES_STATUSES = "('completed','refunded')";

export interface Dashboard {
  currency: Currency;
  salesMinor: number;
  refundMinor: number;
  netSalesMinor: number;
  correctionMinor: number;
  counts: Record<string, number>;
  unitsSold: number;
  giftUnits: number;
  orderCount: number;
}

export async function getDashboard(eventId: string): Promise<Dashboard> {
  const event = await getEvent(eventId);
  if (!event) throw new DomainError('展会不存在');
  const sum = async (sql: string, params: (string | number)[] = []) => {
    const row = await ex().readOne<{ v: number | null }>(sql, params);
    return Number(row?.v ?? 0);
  };
  const salesMinor = await sum(
    `SELECT SUM(total_minor) AS v FROM orders WHERE event_id = ? AND status IN ${SALES_STATUSES}`,
    [eventId]
  );
  const refundMinor = await sum(
    'SELECT SUM(r.amount_minor) AS v FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.event_id = ?',
    [eventId]
  );
  const correctionMinor = await sum(
    "SELECT SUM(total_minor) AS v FROM orders WHERE event_id = ? AND status = 'corrected'",
    [eventId]
  );
  const unitsSold = await sum(
    `SELECT SUM(oi.quantity) AS v FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.event_id = ? AND o.status IN ${SALES_STATUSES} AND oi.product_type_snapshot <> 'gift'`,
    [eventId]
  );
  const giftUnits = await sum(
    `SELECT SUM(oi.quantity) AS v FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.event_id = ? AND o.status IN ${SALES_STATUSES} AND oi.product_type_snapshot = 'gift'`,
    [eventId]
  );

  const statusRows = await ex().read<{ status: string; c: number }>(
    'SELECT status, COUNT(*) AS c FROM orders WHERE event_id = ? GROUP BY status',
    [eventId]
  );
  const counts: Record<string, number> = {
    pending_payment: 0,
    completed: 0,
    voided: 0,
    refunded: 0,
    corrected: 0
  };
  for (const r of statusRows) counts[r.status] = Number(r.c);

  return {
    currency: event.currency,
    salesMinor,
    refundMinor,
    netSalesMinor: salesMinor - refundMinor,
    correctionMinor,
    counts,
    unitsSold,
    giftUnits,
    orderCount: Object.values(counts).reduce((a, b) => a + b, 0)
  };
}

export interface PaymentSummaryRow {
  method_name: string;
  method_type: string;
  received_minor: number;
  refunded_minor: number;
  net_minor: number;
  order_count: number;
}

export function getPaymentSummary(eventId: string): Promise<PaymentSummaryRow[]> {
  return ex().read<PaymentSummaryRow>(
    `SELECT m.name AS method_name, m.type AS method_type,
            COALESCE(recv.amount, 0) AS received_minor,
            COALESCE(rf.amount, 0) AS refunded_minor,
            COALESCE(recv.amount, 0) - COALESCE(rf.amount, 0) AS net_minor,
            COALESCE(recv.cnt, 0) AS order_count
     FROM payment_methods m
     LEFT JOIN (
       SELECT p.method_name_snapshot AS name, SUM(p.amount_minor) AS amount, COUNT(*) AS cnt
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE o.event_id = ? AND o.status IN ${SALES_STATUSES}
       GROUP BY p.method_name_snapshot
     ) recv ON recv.name = m.name
     LEFT JOIN (
       SELECT r.method_name_snapshot AS name, SUM(r.amount_minor) AS amount
       FROM refunds r JOIN orders o ON o.id = r.order_id
       WHERE o.event_id = ?
       GROUP BY r.method_name_snapshot
     ) rf ON rf.name = m.name
     WHERE COALESCE(recv.amount, 0) <> 0 OR COALESCE(rf.amount, 0) <> 0
     ORDER BY received_minor DESC`,
    [eventId, eventId]
  );
}

export interface ProductRankRow {
  product_name: string;
  variant_name: string;
  sku: string | null;
  units: number;
  amount_minor: number;
  refund_order_count: number;
}

export function getProductRanking(eventId: string): Promise<ProductRankRow[]> {
  return ex().read<ProductRankRow>(
    `SELECT oi.product_name_snapshot AS product_name, oi.variant_name_snapshot AS variant_name,
            oi.sku_snapshot AS sku, SUM(oi.quantity) AS units, SUM(oi.subtotal_minor) AS amount_minor,
            SUM(CASE WHEN o.status = 'refunded' THEN 1 ELSE 0 END) AS refund_order_count
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.event_id = ? AND o.status IN ${SALES_STATUSES}
     GROUP BY oi.product_name_snapshot, oi.variant_name_snapshot, oi.sku_snapshot
     ORDER BY amount_minor DESC, units DESC`,
    [eventId]
  );
}

export interface ConsumptionRow {
  variant_id: string;
  component_name: string;
  sold_units: number;
  returned_units: number;
  net_units: number;
}

/** 实际库存成分消耗：套装归套装商品收入，成分只计库存消耗。 */
export function getInventoryConsumption(eventId: string): Promise<ConsumptionRow[]> {
  return ex().read<ConsumptionRow>(
    `SELECT c.component_variant_id AS variant_id,
            MAX(c.component_name_snapshot) AS component_name,
            SUM(c.quantity_total) AS sold_units,
            COALESCE((SELECT SUM(rr.quantity_returned) FROM refund_returns rr
                      JOIN refunds r2 ON r2.id = rr.refund_id
                      JOIN orders o2 ON o2.id = r2.order_id
                      WHERE o2.event_id = ? AND rr.component_variant_id = c.component_variant_id), 0)
            + COALESCE((SELECT SUM(cr.quantity_returned) FROM correction_returns cr
                      JOIN order_corrections oc ON oc.id = cr.correction_id
                      JOIN orders o3 ON o3.id = oc.order_id
                      WHERE o3.event_id = ? AND cr.component_variant_id = c.component_variant_id), 0) AS returned_units,
            SUM(c.quantity_total)
            - COALESCE((SELECT SUM(rr.quantity_returned) FROM refund_returns rr
                      JOIN refunds r2 ON r2.id = rr.refund_id
                      JOIN orders o2 ON o2.id = r2.order_id
                      WHERE o2.event_id = ? AND rr.component_variant_id = c.component_variant_id), 0)
            - COALESCE((SELECT SUM(cr.quantity_returned) FROM correction_returns cr
                      JOIN order_corrections oc ON oc.id = cr.correction_id
                      JOIN orders o3 ON o3.id = oc.order_id
                      WHERE o3.event_id = ? AND cr.component_variant_id = c.component_variant_id), 0) AS net_units
     FROM order_inventory_components c
     JOIN order_items oi ON oi.id = c.order_item_id
     JOIN orders o ON o.id = oi.order_id
     WHERE o.event_id = ? AND o.status IN ${SALES_STATUSES}
     GROUP BY c.component_variant_id
     ORDER BY sold_units DESC`,
    [eventId, eventId, eventId, eventId, eventId]
  );
}

/* ---------------------------------------------------------------- 现金 */

export function listCashMovements(eventId: string): Promise<CashMovement[]> {
  return ex().read<CashMovement>(
    'SELECT * FROM cash_movements WHERE event_id = ? ORDER BY created_at, rowid',
    [eventId]
  );
}

export async function addCashMovement(
  eventId: string,
  type: CashMovement['type'],
  amountMinor: number,
  reason: string | null,
  operationId?: string
): Promise<void> {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) throw new DomainError('金额必须为非负整数');
  const opId = operationId ?? newId();
  const { hash, existing } = await beginIdempotent('cash.movement', opId, { eventId, type, amountMinor });
  if (existing) return;
  if (type === 'opening') {
    const row = await ex().readOne<{ c: number }>(
      "SELECT COUNT(*) AS c FROM cash_movements WHERE event_id = ? AND type = 'opening'",
      [eventId]
    );
    if (Number(row?.c ?? 0) > 0) throw new DomainError('本场已设置过开场备用金，后续增减请存入/取出');
  }
  await ex().tx([
    {
      t: 'run',
      sql: 'INSERT INTO cash_movements (id, event_id, type, amount_minor, reason, created_at, operation_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      params: [newId(), eventId, type, amountMinor, reason, nowIso(), opId]
    },
    auditStep('cash.movement', 'event', eventId, { type, amountMinor, reason }),
    idempotencyStep(opId, 'cash.movement', hash, { ok: true })
  ]);
}

export interface CashBreakdown {
  openingMinor: number;
  cashSalesMinor: number;
  cashRefundMinor: number;
  depositMinor: number;
  withdrawalMinor: number;
  expectedMinor: number;
}

/** 理论钱箱现金 = 备用金 + 有效现金收款 - 实际现金退款 + 存入 - 取出。 */
export async function getExpectedCash(eventId: string): Promise<CashBreakdown> {
  const movements = await listCashMovements(eventId);
  let openingMinor = 0;
  let depositMinor = 0;
  let withdrawalMinor = 0;
  for (const m of movements) {
    if (m.type === 'opening') openingMinor += m.amount_minor;
    else if (m.type === 'deposit') depositMinor += m.amount_minor;
    else withdrawalMinor += m.amount_minor;
  }
  const sum = async (sql: string, params: string[]) => {
    const row = await ex().readOne<{ v: number | null }>(sql, params);
    return Number(row?.v ?? 0);
  };
  const cashSalesMinor = await sum(
    `SELECT SUM(p.amount_minor) AS v FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE o.event_id = ? AND p.method_type_snapshot = 'cash' AND o.status IN ${SALES_STATUSES}`,
    [eventId]
  );
  const cashRefundMinor = await sum(
    `SELECT SUM(r.amount_minor) AS v FROM refunds r JOIN orders o ON o.id = r.order_id
     WHERE o.event_id = ? AND r.method_type_snapshot = 'cash'`,
    [eventId]
  );
  return {
    openingMinor,
    cashSalesMinor,
    cashRefundMinor,
    depositMinor,
    withdrawalMinor,
    expectedMinor: openingMinor + cashSalesMinor - cashRefundMinor + depositMinor - withdrawalMinor
  };
}

export interface SettlementSummary {
  salesMinor: number;
  refundMinor: number;
  netSalesMinor: number;
  correctionMinor: number;
  counts: Record<string, number>;
  unitsSold: number;
  giftUnits: number;
}

export async function settleEvent(
  eventId: string,
  actualCashMinor: number,
  note: string | null,
  operationId?: string
): Promise<{ settlementId: string; differenceMinor: number }> {
  if (!Number.isInteger(actualCashMinor) || actualCashMinor < 0) throw new DomainError('实际现金必须为非负整数');
  const pending = await ex().readOne<{ c: number }>(
    "SELECT COUNT(*) AS c FROM orders WHERE event_id = ? AND status = 'pending_payment'",
    [eventId]
  );
  if (Number(pending?.c ?? 0) > 0) throw new DomainError('还有待付款订单未处理，不能结算');

  const opId = operationId ?? newId();
  const { hash, existing } = await beginIdempotent('event.settle', opId, { eventId, actualCashMinor });
  if (existing) return existing as { settlementId: string; differenceMinor: number };

  const cash = await getExpectedCash(eventId);
  const dash = await getDashboard(eventId);
  const summary: SettlementSummary = {
    salesMinor: dash.salesMinor,
    refundMinor: dash.refundMinor,
    netSalesMinor: dash.netSalesMinor,
    correctionMinor: dash.correctionMinor,
    counts: dash.counts,
    unitsSold: dash.unitsSold,
    giftUnits: dash.giftUnits
  };
  const differenceMinor = actualCashMinor - cash.expectedMinor;
  const settlementId = newId();
  await ex().tx([
    {
      t: 'run',
      sql: 'UPDATE settlements SET superseded = 1 WHERE event_id = ? AND superseded = 0',
      params: [eventId]
    },
    {
      t: 'run',
      sql: `INSERT INTO settlements (id, event_id, settled_at, expected_cash_minor, actual_cash_minor, difference_minor, summary_json, note, superseded, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      params: [
        settlementId,
        eventId,
        nowIso(),
        cash.expectedMinor,
        actualCashMinor,
        differenceMinor,
        JSON.stringify({ ...summary, cash }),
        note,
        nowIso()
      ]
    },
    auditStep('event.settle', 'event', eventId, { actualCashMinor, differenceMinor }),
    idempotencyStep(opId, 'event.settle', hash, { settlementId, differenceMinor })
  ]);
  return { settlementId, differenceMinor };
}

export function listSettlements(eventId: string): Promise<Settlement[]> {
  return ex().read<Settlement>('SELECT * FROM settlements WHERE event_id = ? ORDER BY created_at DESC', [eventId]);
}

/* ------------------------------------------------------------------ CSV */

function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  // 表格软件公式注入防护
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

export async function exportOrdersCsv(eventId: string): Promise<string> {
  const rows = await ex().read<Record<string, unknown>>(
    `SELECT o.human_readable_number, o.status, o.currency, o.total_minor, o.source, o.created_at, o.completed_at,
            p.method_name_snapshot, r.amount_minor AS refund_amount, oc.reason AS correction_reason
     FROM orders o
     LEFT JOIN payments p ON p.order_id = o.id
     LEFT JOIN refunds r ON r.order_id = o.id
     LEFT JOIN order_corrections oc ON oc.order_id = o.id
     WHERE o.event_id = ? ORDER BY o.human_readable_number`,
    [eventId]
  );
  return toCsv(
    ['订单号', '状态', '币种', '金额(最小单位)', '来源', '创建时间', '完成时间', '收款方式', '退款金额', '纠错原因'],
    rows.map((r) => [
      r.human_readable_number,
      r.status,
      r.currency,
      r.total_minor,
      r.source,
      r.created_at,
      r.completed_at,
      r.method_name_snapshot,
      r.refund_amount,
      r.correction_reason
    ])
  );
}

export async function exportOrderItemsCsv(eventId: string): Promise<string> {
  const rows = await ex().read<Record<string, unknown>>(
    `SELECT o.human_readable_number, oi.product_name_snapshot, oi.variant_name_snapshot, oi.sku_snapshot,
            oi.product_type_snapshot, oi.unit_price_minor, oi.quantity, oi.subtotal_minor, o.currency, o.status
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.event_id = ? ORDER BY o.human_readable_number`,
    [eventId]
  );
  return toCsv(
    ['订单号', '商品', '规格', 'SKU', '类型', '单价(最小单位)', '数量', '小计(最小单位)', '币种', '订单状态'],
    rows.map((r) => [
      r.human_readable_number,
      r.product_name_snapshot,
      r.variant_name_snapshot,
      r.sku_snapshot,
      r.product_type_snapshot,
      r.unit_price_minor,
      r.quantity,
      r.subtotal_minor,
      r.currency,
      r.status
    ])
  );
}

export async function exportInventoryCsv(eventId: string): Promise<string> {
  const rows = await ex().read<Record<string, unknown>>(
    `SELECT p.name AS product_name, v.name AS variant_name, v.sku, i.initial_stock, i.physical_stock, i.reserved_stock,
            i.physical_stock - i.reserved_stock AS available_stock
     FROM inventory i
     JOIN product_variants v ON v.id = i.variant_id
     JOIN products p ON p.id = v.product_id
     WHERE i.event_id = ? ORDER BY p.name, v.name`,
    [eventId]
  );
  return toCsv(
    ['商品', '规格', 'SKU', '初始库存', '实际库存', '预留', '可用'],
    rows.map((r) => [
      r.product_name,
      r.variant_name,
      r.sku,
      r.initial_stock,
      r.physical_stock,
      r.reserved_stock,
      r.available_stock
    ])
  );
}

export async function exportInventoryTransactionsCsv(eventId: string): Promise<string> {
  const rows = await ex().read<Record<string, unknown>>(
    `SELECT t.created_at, t.type, p.name AS product_name, v.name AS variant_name,
            t.delta_physical, t.delta_reserved, t.reason, o.human_readable_number
     FROM inventory_transactions t
     JOIN product_variants v ON v.id = t.variant_id
     JOIN products p ON p.id = v.product_id
     LEFT JOIN orders o ON o.id = t.order_id
     WHERE t.event_id = ? ORDER BY t.created_at, t.rowid`,
    [eventId]
  );
  return toCsv(
    ['时间', '类型', '商品', '规格', '实际库存增减', '预留增减', '原因', '订单号'],
    rows.map((r) => [
      r.created_at,
      r.type,
      r.product_name,
      r.variant_name,
      r.delta_physical,
      r.delta_reserved,
      r.reason,
      r.human_readable_number
    ])
  );
}

export async function exportProductSalesCsv(eventId: string): Promise<string> {
  const rows = await getProductRanking(eventId);
  const event = await getEvent(eventId);
  return toCsv(
    ['商品', '规格', 'SKU', '销售数量', '销售金额(最小单位)', '币种', '含退款订单数'],
    rows.map((r) => [
      r.product_name,
      r.variant_name,
      r.sku,
      r.units,
      r.amount_minor,
      event?.currency ?? '',
      r.refund_order_count
    ])
  );
}

export async function exportPaymentSummaryCsv(eventId: string): Promise<string> {
  const rows = await getPaymentSummary(eventId);
  const event = await getEvent(eventId);
  return toCsv(
    ['支付方式', '类型', '有效收款(最小单位)', '实际退款(最小单位)', '净流入(最小单位)', '币种'],
    rows.map((r) => [
      r.method_name,
      r.method_type,
      r.received_minor,
      r.refunded_minor,
      r.net_minor,
      event?.currency ?? ''
    ])
  );
}
