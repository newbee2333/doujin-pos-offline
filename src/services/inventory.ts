/** 库存余额与流水（第 10 节）。 */

import type { Step } from '../db/executor';
import type { InventoryRow, InventoryTransaction, InventoryTxType } from '../domain/types';
import { newId, nowIso } from '../domain/ids';
import { auditStep, beginIdempotent, ex, idempotencyStep } from './context';
import { DomainError } from './catalog';

export function getInventory(eventId: string, variantId: string): Promise<InventoryRow | null> {
  return ex().readOne<InventoryRow>(
    'SELECT * FROM inventory WHERE event_id = ? AND variant_id = ?',
    [eventId, variantId]
  );
}

export function listInventory(eventId: string): Promise<InventoryRow[]> {
  return ex().read<InventoryRow>('SELECT * FROM inventory WHERE event_id = ?', [eventId]);
}

export function listTransactions(eventId: string, variantId?: string): Promise<InventoryTransaction[]> {
  if (variantId) {
    return ex().read<InventoryTransaction>(
      'SELECT * FROM inventory_transactions WHERE event_id = ? AND variant_id = ? ORDER BY created_at DESC, id DESC',
      [eventId, variantId]
    );
  }
  return ex().read<InventoryTransaction>(
    'SELECT * FROM inventory_transactions WHERE event_id = ? ORDER BY created_at DESC, id DESC',
    [eventId]
  );
}

/**
 * 初始化初始库存。只做一次；之后补货、盘点、报损都走流水，不覆盖 initial_stock。
 */
export async function initializeStock(
  eventId: string,
  variantId: string,
  quantity: number,
  operationId?: string
): Promise<void> {
  if (!Number.isInteger(quantity) || quantity < 0) throw new DomainError('初始库存必须为非负整数');
  const opId = operationId ?? newId();
  const { hash } = await beginIdempotent('inventory.initial', opId, { eventId, variantId, quantity });

  const existing = await ex().readOne<{ c: number }>(
    "SELECT COUNT(*) AS c FROM inventory_transactions WHERE event_id = ? AND variant_id = ? AND type = 'initial'",
    [eventId, variantId]
  );
  if (Number(existing?.c ?? 0) > 0) {
    // 已经初始化过：只有在还没有其他流水时才允许改写，避免制造两套初始库存来源
    const other = await ex().readOne<{ c: number }>(
      "SELECT COUNT(*) AS c FROM inventory_transactions WHERE event_id = ? AND variant_id = ? AND type <> 'initial'",
      [eventId, variantId]
    );
    if (Number(other?.c ?? 0) > 0) {
      throw new DomainError('该商品已初始化过库存，后续变更请使用盘点或补货');
    }
  }

  const steps: Step[] = [
    {
      t: 'run',
      sql: `UPDATE inventory_transactions SET delta_physical = ? WHERE event_id = ? AND variant_id = ? AND type = 'initial'`,
      params: [quantity, eventId, variantId]
    },
    {
      t: 'run',
      sql: `INSERT INTO inventory_transactions (id, event_id, variant_id, delta_physical, delta_reserved, type, order_id, operation_id, reason, note, created_at)
            SELECT ?, ?, ?, ?, 0, 'initial', NULL, ?, NULL, NULL, ?
            WHERE NOT EXISTS (SELECT 1 FROM inventory_transactions t WHERE t.event_id = ? AND t.variant_id = ? AND t.type = 'initial')`,
      params: [newId(), eventId, variantId, quantity, opId, nowIso(), eventId, variantId]
    },
    {
      t: 'run',
      sql: `INSERT INTO inventory (event_id, variant_id, initial_stock, physical_stock, reserved_stock)
            VALUES (?, ?, ?, ?, 0)
            ON CONFLICT(event_id, variant_id) DO UPDATE SET initial_stock = excluded.initial_stock, physical_stock = excluded.physical_stock`,
      params: [eventId, variantId, quantity, quantity]
    },
    idempotencyStep(opId, 'inventory.initial', hash, { eventId, variantId, quantity })
  ];
  await ex().tx(steps);
}

export interface AdjustInput {
  eventId: string;
  variantId: string;
  /** 实际库存增减量，整数（可为负）。 */
  deltaPhysical: number;
  type: Extract<InventoryTxType, 'restock' | 'correction' | 'damaged' | 'personal' | 'lost' | 'other'>;
  reason?: string | null;
  note?: string | null;
  operationId?: string;
}

/**
 * 库存调整（补货 / 盘点 / 报损 / 自用 / 丢失 / 其他）。
 * 余额与流水在同一事务写入；调整后实际库存低于已预留时拒绝。
 */
export async function adjustStock(input: AdjustInput): Promise<{ before: number; after: number }> {
  if (!Number.isInteger(input.deltaPhysical) || input.deltaPhysical === 0) {
    throw new DomainError('调整数量必须为非零整数');
  }
  const inv = await getInventory(input.eventId, input.variantId);
  if (!inv) throw new DomainError('该商品没有库存记录，请先设置初始库存');
  const before = inv.physical_stock;
  const after = before + input.deltaPhysical;

  const opId = input.operationId ?? newId();
  const { hash } = await beginIdempotent('inventory.adjust', opId, input);

  const steps: Step[] = [
    {
      t: 'assert',
      sql: 'SELECT CASE WHEN COALESCE((SELECT physical_stock + ? FROM inventory WHERE event_id = ? AND variant_id = ?), -1) >= 0 THEN 1 ELSE 0 END',
      params: [input.deltaPhysical, input.eventId, input.variantId],
      equals: 1,
      message: '调整后实际库存会变成负数'
    },
    {
      t: 'assert',
      sql: 'SELECT CASE WHEN COALESCE((SELECT physical_stock + ? - reserved_stock FROM inventory WHERE event_id = ? AND variant_id = ?), -1) >= 0 THEN 1 ELSE 0 END',
      params: [input.deltaPhysical, input.eventId, input.variantId],
      equals: 1,
      message: '调整后实际库存会低于已预留数量，请先处理受影响的待付款订单'
    },
    {
      t: 'run',
      sql: 'UPDATE inventory SET physical_stock = physical_stock + ? WHERE event_id = ? AND variant_id = ?',
      params: [input.deltaPhysical, input.eventId, input.variantId],
      expectChanges: 1
    },
    {
      t: 'run',
      sql: `INSERT INTO inventory_transactions (id, event_id, variant_id, delta_physical, delta_reserved, type, order_id, operation_id, reason, note, created_at)
            VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?, ?, ?)`,
      params: [
        newId(),
        input.eventId,
        input.variantId,
        input.deltaPhysical,
        input.type,
        opId,
        input.reason ?? null,
        input.note ?? null,
        nowIso()
      ]
    },
    auditStep('inventory.adjust', 'inventory', input.variantId, {
      eventId: input.eventId,
      delta: input.deltaPhysical,
      type: input.type,
      before,
      after,
      reason: input.reason ?? null
    }),
    idempotencyStep(opId, 'inventory.adjust', hash, { before, after })
  ];
  await ex().tx(steps);
  return { before, after };
}

/** 对账：余额等于流水累计，预留等于待付款订单成分汇总。 */
export async function reconcile(eventId: string): Promise<string[]> {
  const problems: string[] = [];
  const physical = await ex().read<{ variant_id: string; diff: number }>(
    `SELECT i.variant_id,
            i.physical_stock - COALESCE((SELECT SUM(t.delta_physical) FROM inventory_transactions t
              WHERE t.event_id = i.event_id AND t.variant_id = i.variant_id), 0) AS diff
     FROM inventory i WHERE i.event_id = ?`,
    [eventId]
  );
  for (const r of physical) {
    if (Number(r.diff) !== 0) problems.push(`库存余额与流水不一致（规格 ${r.variant_id}，差 ${r.diff}）`);
  }
  const reserved = await ex().read<{ variant_id: string; diff: number }>(
    `SELECT i.variant_id,
            i.reserved_stock - COALESCE((SELECT SUM(c.quantity_total)
               FROM order_inventory_components c
               JOIN order_items oi ON oi.id = c.order_item_id
               JOIN orders o ON o.id = oi.order_id
               WHERE o.status = 'pending_payment' AND o.event_id = i.event_id
                 AND c.component_variant_id = i.variant_id), 0) AS diff
     FROM inventory i WHERE i.event_id = ?`,
    [eventId]
  );
  for (const r of reserved) {
    if (Number(r.diff) !== 0) problems.push(`预留库存与待付款订单不一致（规格 ${r.variant_id}，差 ${r.diff}）`);
  }
  const negative = await ex().read<{ variant_id: string }>(
    'SELECT variant_id FROM inventory WHERE event_id = ? AND (physical_stock < 0 OR reserved_stock < 0 OR physical_stock < reserved_stock)',
    [eventId]
  );
  for (const r of negative) problems.push(`库存出现非法余额（规格 ${r.variant_id}）`);
  return problems;
}
