/**
 * 业务不变量检查（第 22 节）。
 *
 * 每条检查返回「违反数量」，正常应为 0。Worker 与测试共用同一组 SQL，
 * 保证「文件合法不等于业务有效」这一点在两侧一致。
 */

export interface InvariantCheck {
  name: string;
  label: string;
  sql: string;
}

export const INVARIANT_CHECKS: InvariantCheck[] = [
  {
    name: 'order_amounts',
    label: '订单金额关系',
    sql: `SELECT COUNT(*) FROM (
      SELECT o.id FROM orders o
      WHERE o.total_minor > o.subtotal_minor
         OR o.total_minor <> COALESCE((SELECT SUM(COALESCE(oi.net_minor,oi.subtotal_minor)) FROM order_items oi WHERE oi.order_id=o.id),0)
         OR o.subtotal_minor <> COALESCE((SELECT SUM(oi.subtotal_minor) FROM order_items oi WHERE oi.order_id = o.id), 0)
    )`
  },
  {
    name: 'order_item_amounts',
    label: '订单行金额',
    sql: `SELECT COUNT(*) FROM order_items
          WHERE subtotal_minor <> unit_price_minor * quantity OR COALESCE(net_minor,subtotal_minor)>subtotal_minor
          OR (pricing_json IS NOT NULL AND (net_minor IS NULL
            OR net_minor <> subtotal_minor - json_extract(pricing_json,'$.thresholdDiscount') - json_extract(pricing_json,'$.orderDiscount')))`
  },
  {
    name: 'pricing_snapshots',
    label: '优惠快照与订单金额一致',
    sql: `SELECT COUNT(*) FROM orders o WHERE o.pricing_json IS NOT NULL AND (
      json_extract(o.pricing_json,'$.total') IS NOT o.total_minor
      OR json_extract(o.pricing_json,'$.subtotal') IS NOT o.subtotal_minor
      OR json_extract(o.pricing_json,'$.listTotal') IS NOT
        (SELECT SUM(json_extract(oi.pricing_json,'$.listUnit')*oi.quantity) FROM order_items oi WHERE oi.order_id=o.id)
      OR json_extract(o.pricing_json,'$.discount') IS NOT
        json_extract(o.pricing_json,'$.listTotal')-o.total_minor
      OR json_extract(o.pricing_json,'$.thresholdDiscount') IS NOT
        (SELECT SUM(json_extract(oi.pricing_json,'$.thresholdDiscount')) FROM order_items oi WHERE oi.order_id=o.id)
      OR json_extract(o.pricing_json,'$.orderDiscount') IS NOT
        (SELECT SUM(json_extract(oi.pricing_json,'$.orderDiscount')) FROM order_items oi WHERE oi.order_id=o.id)
    )`
  },
  {
    name: 'pending_has_no_payment',
    label: '待付款订单不应有收款记录',
    sql: `SELECT COUNT(*) FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE o.status = 'pending_payment'`
  },
  {
    name: 'completed_payment_count',
    label: '已完成订单收款记录数',
    sql: `SELECT COUNT(*) FROM (
      SELECT o.total_minor,
             (SELECT COUNT(*) FROM payments p WHERE p.order_id = o.id) AS pc
      FROM orders o WHERE o.status = 'completed'
    ) WHERE NOT ((total_minor > 0 AND pc = 1) OR (total_minor = 0 AND pc = 0))`
  },
  {
    name: 'refund_amount_matches',
    label: '退款金额与订单一致',
    sql: `SELECT COUNT(*) FROM refunds r JOIN orders o ON o.id = r.order_id
          WHERE r.amount_minor <> o.total_minor`
  },
  {
    name: 'refund_payment_belongs_to_order',
    label: '退款关联的收款记录',
    sql: `SELECT COUNT(*) FROM refunds r
          WHERE r.payment_id IS NOT NULL
            AND r.payment_id NOT IN (SELECT p.id FROM payments p WHERE p.order_id = r.order_id)`
  },
  {
    name: 'inventory_balance',
    label: '库存余额非负且预留不超限',
    sql: `SELECT COUNT(*) FROM inventory
          WHERE physical_stock < 0 OR reserved_stock < 0 OR physical_stock < reserved_stock`
  },
  {
    name: 'inventory_physical_matches_tx',
    label: '实际库存等于流水累计',
    sql: `SELECT COUNT(*) FROM inventory i
          WHERE i.physical_stock <> COALESCE((SELECT SUM(t.delta_physical) FROM inventory_transactions t
                         WHERE t.event_id = i.event_id AND t.variant_id = i.variant_id), 0)`
  },
  {
    name: 'inventory_initial_matches_first_tx',
    label: '初始库存与 initial 流水一致',
    sql: `SELECT COUNT(*) FROM inventory i
          WHERE i.initial_stock <> COALESCE((SELECT SUM(t.delta_physical) FROM inventory_transactions t
                         WHERE t.event_id = i.event_id AND t.variant_id = i.variant_id AND t.type = 'initial'), 0)`
  },
  {
    name: 'inventory_reserved_matches_tx',
    label: '预留库存等于流水累计',
    sql: `SELECT COUNT(*) FROM inventory i
          WHERE i.reserved_stock <> COALESCE((SELECT SUM(t.delta_reserved) FROM inventory_transactions t
                         WHERE t.event_id = i.event_id AND t.variant_id = i.variant_id), 0)`
  },
  {
    name: 'reserved_matches_pending_orders',
    label: '预留等于待付款订单成分汇总',
    sql: `SELECT COUNT(*) FROM (
      SELECT i.event_id, i.variant_id, i.reserved_stock,
             COALESCE((SELECT SUM(c.quantity_total)
                       FROM order_inventory_components c
                       JOIN order_items oi ON oi.id = c.order_item_id
                       JOIN orders o ON o.id = oi.order_id
                       WHERE o.status = 'pending_payment'
                         AND o.event_id = i.event_id
                         AND c.component_variant_id = i.variant_id), 0) AS pending_qty
      FROM inventory i
    ) WHERE reserved_stock <> pending_qty`
  },
  {
    name: 'stock_items_have_components',
    label: '库存商品行有成分快照',
    sql: `SELECT COUNT(*) FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          LEFT JOIN order_inventory_components c ON c.order_item_id = oi.id
          WHERE oi.product_type_snapshot IN ('normal','gift','bundle')
            AND c.id IS NULL`
  }
];
