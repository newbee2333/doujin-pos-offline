/** 展会、参展配置、支付方式（第 9、14 节）。 */

import type { Step } from '../db/executor';
import type { Currency, Event, EventVariantConfig, PaymentMethod } from '../domain/types';
import { newId, nowIso } from '../domain/ids';
import { auditStep, ex } from './context';
import { DomainError } from './catalog';

export function listEvents(): Promise<Event[]> {
  return ex().read<Event>('SELECT * FROM events ORDER BY created_at DESC');
}

export function getEvent(id: string): Promise<Event | null> {
  return ex().readOne<Event>('SELECT * FROM events WHERE id = ?', [id]);
}

export async function getActiveEvent(): Promise<Event | null> {
  return ex().readOne<Event>("SELECT * FROM events WHERE status = 'active'");
}

export interface EventInput {
  name: string;
  start_date?: string | null;
  end_date?: string | null;
  timezone?: string;
  booth_number?: string | null;
  currency: Currency;
  note?: string | null;
}

export async function createEvent(input: EventInput): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new DomainError('展会名称不能为空');
  const id = newId();
  const now = nowIso();
  await ex().tx([
    {
      t: 'run',
      sql: `INSERT INTO events (id, name, start_date, end_date, timezone, booth_number, currency, status, note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      params: [
        id,
        name,
        input.start_date ?? null,
        input.end_date ?? null,
        input.timezone ?? 'Asia/Shanghai',
        input.booth_number?.trim() || null,
        input.currency,
        input.note ?? null,
        now,
        now
      ]
    }
  ]);
  return id;
}

export async function updateEvent(
  id: string,
  patch: Partial<Pick<Event, 'name' | 'start_date' | 'end_date' | 'timezone' | 'booth_number' | 'currency' | 'note'>>
): Promise<void> {
  const current = await getEvent(id);
  if (!current) throw new DomainError('展会不存在');
  if (patch.currency && patch.currency !== current.currency) {
    const row = await ex().readOne<{ c: number }>('SELECT COUNT(*) AS c FROM orders WHERE event_id = ?', [id]);
    if (Number(row?.c ?? 0) > 0) {
      throw new DomainError('本场已有订单，不能再更改币种');
    }
  }
  const fields: [string, unknown][] = [];
  for (const key of ['name', 'start_date', 'end_date', 'timezone', 'booth_number', 'currency', 'note'] as const) {
    const v = patch[key];
    if (v !== undefined) fields.push([key, v]);
  }
  if (!fields.length) return;
  await ex().tx([
    {
      t: 'run',
      sql: `UPDATE events SET ${fields.map(([c]) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      params: [...fields.map(([, v]) => v as string | null), nowIso(), id]
    }
  ]);
}

/** 开场：校验配置与离线状态，并把展会置为 active（同时最多一个）。 */
export async function activateEvent(id: string): Promise<void> {
  const ev = await getEvent(id);
  if (!ev) throw new DomainError('展会不存在');
  if (ev.status === 'active') return;
  const issues = await checkEventReady(id);
  if (issues.length) throw new DomainError(`无法开场：${issues.join('；')}`);
  await ex().tx([
    { t: 'run', sql: "UPDATE events SET status = 'closed', updated_at = ? WHERE status = 'active' AND id <> ?", params: [nowIso(), id] },
    { t: 'run', sql: "UPDATE events SET status = 'active', updated_at = ? WHERE id = ?", params: [nowIso(), id], expectChanges: 1 },
    auditStep('event.open', 'event', id, { name: ev.name })
  ]);
}

export async function checkEventReady(id: string): Promise<string[]> {
  const issues: string[] = [];
  const ev = await getEvent(id);
  if (!ev) return ['展会不存在'];

  const cfgRows = await ex().read<{ c: number }>(
    'SELECT COUNT(*) AS c FROM event_variant_configs WHERE event_id = ? AND enabled = 1',
    [id]
  );
  if (Number(cfgRows[0]?.c ?? 0) === 0) issues.push('没有启用任何参展商品');

  const missingPrice = await ex().read<{ variant_name: string }>(
    `SELECT v.name AS variant_name FROM event_variant_configs c
     JOIN product_variants v ON v.id = c.variant_id
     WHERE c.event_id = ? AND c.enabled = 1 AND c.event_price_minor IS NULL`,
    [id]
  );
  if (missingPrice.length) {
    issues.push(`${missingPrice.length} 个启用商品未设置本场价格`);
  }

  // 套装没有自己的库存，它消耗成分库存；normal/gift 需要自身初始库存
  const noInventory = await ex().read<{ variant_name: string }>(
    `SELECT v.name AS variant_name FROM event_variant_configs c
     JOIN product_variants v ON v.id = c.variant_id
     JOIN products p ON p.id = v.product_id
     WHERE c.event_id = ? AND c.enabled = 1 AND p.type IN ('normal','gift')
       AND NOT EXISTS (SELECT 1 FROM inventory i WHERE i.event_id = c.event_id AND i.variant_id = c.variant_id)`,
    [id]
  );
  if (noInventory.length) {
    issues.push(`${noInventory.length} 个库存商品未设置初始库存`);
  }

  const badBundle = await ex().read<{ variant_name: string }>(
    `SELECT v.name AS variant_name FROM event_variant_configs c
     JOIN product_variants v ON v.id = c.variant_id
     JOIN products p ON p.id = v.product_id
     WHERE c.event_id = ? AND c.enabled = 1 AND p.type = 'bundle'
       AND (NOT EXISTS (SELECT 1 FROM bundle_components bc WHERE bc.bundle_variant_id = c.variant_id)
            OR EXISTS (SELECT 1 FROM bundle_components bc
                       WHERE bc.bundle_variant_id = c.variant_id
                         AND NOT EXISTS (SELECT 1 FROM inventory i
                                         WHERE i.event_id = c.event_id AND i.variant_id = bc.component_variant_id)))`,
    [id]
  );
  if (badBundle.length) {
    issues.push(`${badBundle.length} 个套装缺少成分或成分未设置初始库存`);
  }

  const methods = await getEventPaymentMethods(id);
  if (!methods.length) issues.push('没有启用任何支付方式');
  const incompleteQr = methods.filter((m) => m.type === 'qr_payment' && !m.qr_asset_id);
  if (incompleteQr.length) {
    issues.push(`收款码未上传：${incompleteQr.map((m) => m.name).join('、')}`);
  }
  return issues;
}

/** 复制展会：只复制配置，不复制订单、库存余额、现金流水。 */
export async function duplicateEvent(id: string, newName: string): Promise<string> {
  const ev = await getEvent(id);
  if (!ev) throw new DomainError('展会不存在');
  const freshId = newId();
  const now = nowIso();
  await ex().tx([
    {
      t: 'run',
      sql: `INSERT INTO events (id, name, start_date, end_date, timezone, booth_number, currency, status, note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      params: [
        freshId,
        newName.trim() || `${ev.name}（副本）`,
        ev.start_date,
        ev.end_date,
        ev.timezone,
        ev.booth_number,
        ev.currency,
        ev.note,
        now,
        now
      ]
    },
    {
      t: 'run',
      sql: `INSERT INTO event_variant_configs (event_id, variant_id, enabled, event_price_minor, sort_order, purchase_limit, show_exact_stock, low_stock_threshold, kiosk_visible)
            SELECT ?, variant_id, enabled, event_price_minor, sort_order, purchase_limit, show_exact_stock, low_stock_threshold, kiosk_visible
            FROM event_variant_configs WHERE event_id = ?`,
      params: [freshId, id]
    },
    {
      t: 'run',
      sql: `INSERT INTO event_payment_methods (event_id, payment_method_id, enabled, sort_order)
            SELECT ?, payment_method_id, enabled, sort_order FROM event_payment_methods WHERE event_id = ?`,
      params: [freshId, id]
    }
  ]);
  return freshId;
}

export async function closeEvent(id: string): Promise<void> {
  const ev = await getEvent(id);
  if (!ev) throw new DomainError('展会不存在');
  const pending = await ex().readOne<{ c: number }>(
    "SELECT COUNT(*) AS c FROM orders WHERE event_id = ? AND status = 'pending_payment'",
    [id]
  );
  if (Number(pending?.c ?? 0) > 0) {
    throw new DomainError(`还有 ${pending?.c} 笔待付款订单未处理，不能收摊`);
  }
  await ex().tx([
    { t: 'run', sql: "UPDATE events SET status = 'closed', updated_at = ? WHERE id = ?", params: [nowIso(), id], expectChanges: 1 },
    auditStep('event.close', 'event', id, {})
  ]);
}

/** 重新打开已关闭展会：需要原因与审计记录，且不能与另一个 active 展会冲突。 */
export async function reopenEvent(id: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new DomainError('请填写重新打开的原因');
  const active = await getActiveEvent();
  if (active && active.id !== id) {
    throw new DomainError(`已有进行中的展会「${active.name}」，不能同时开启两场`);
  }
  await ex().tx([
    { t: 'run', sql: "UPDATE events SET status = 'active', updated_at = ? WHERE id = ?", params: [nowIso(), id], expectChanges: 1 },
    auditStep('event.reopen', 'event', id, { reason })
  ]);
}

/** 只有未产生订单、库存或现金等业务流水的草稿展会可删除。 */
export async function deleteDraftEvent(id: string): Promise<void> {
  const ev = await getEvent(id);
  if (!ev) throw new DomainError('展会不存在');
  if (ev.status !== 'draft') throw new DomainError('只有草稿状态的展会可以删除');
  const counts = await Promise.all([
    ex().readOne<{ c: number }>('SELECT COUNT(*) AS c FROM orders WHERE event_id = ?', [id]),
    ex().readOne<{ c: number }>('SELECT COUNT(*) AS c FROM inventory_transactions WHERE event_id = ?', [id]),
    ex().readOne<{ c: number }>('SELECT COUNT(*) AS c FROM cash_movements WHERE event_id = ?', [id])
  ]);
  const total = counts.reduce((a, r) => a + Number(r?.c ?? 0), 0);
  if (total > 0) throw new DomainError('该展会已有业务数据，不能删除');
  await ex().tx([
    { t: 'run', sql: 'DELETE FROM event_variant_configs WHERE event_id = ?', params: [id] },
    { t: 'run', sql: 'DELETE FROM event_payment_methods WHERE event_id = ?', params: [id] },
    { t: 'run', sql: 'DELETE FROM inventory WHERE event_id = ?', params: [id] },
    { t: 'run', sql: 'DELETE FROM events WHERE id = ?', params: [id], expectChanges: 1 }
  ]);
}

/* ------------------------------------------------------------ 参展配置 */

export interface EventConfigRow extends EventVariantConfig {
  product_id: string;
  product_name: string;
  product_type: string;
  variant_name: string;
  sku: string | null;
  category_name: string | null;
  archived: number;
  initial_stock: number | null;
  physical_stock: number | null;
  reserved_stock: number | null;
}

export async function listEventConfigs(eventId: string): Promise<EventConfigRow[]> {
  return ex().read<EventConfigRow>(
    `SELECT c.*, p.id AS product_id, p.name AS product_name, p.type AS product_type, p.archived AS archived,
            v.name AS variant_name, v.sku, cat.name AS category_name,
            i.initial_stock, i.physical_stock, i.reserved_stock
     FROM event_variant_configs c
     JOIN product_variants v ON v.id = c.variant_id
     JOIN products p ON p.id = v.product_id
     LEFT JOIN categories cat ON cat.id = p.category_id
     LEFT JOIN inventory i ON i.event_id = c.event_id AND i.variant_id = c.variant_id
     WHERE c.event_id = ?
     ORDER BY c.sort_order, p.name, v.name`,
    [eventId]
  );
}

export async function addVariantsToEvent(eventId: string, variantIds: string[]): Promise<void> {
  const steps: Step[] = [];
  for (const variantId of variantIds) {
    steps.push({
      t: 'run',
      sql: `INSERT INTO event_variant_configs (event_id, variant_id, enabled, event_price_minor, sort_order, purchase_limit, show_exact_stock, low_stock_threshold, kiosk_visible)
            SELECT ?, ?, 1, NULL,
                   (SELECT COALESCE(MAX(sort_order),0)+1 FROM event_variant_configs WHERE event_id = ?),
                   NULL, 0, 3,
                   CASE WHEN (SELECT p.type FROM product_variants v2 JOIN products p ON p.id = v2.product_id WHERE v2.id = ?) = 'gift' THEN 0 ELSE 1 END
            ON CONFLICT(event_id, variant_id) DO NOTHING`,
      params: [eventId, variantId, eventId, variantId]
    });
  }
  if (steps.length) await ex().tx(steps);
}

export async function updateConfig(
  eventId: string,
  variantId: string,
  patch: Partial<Omit<EventVariantConfig, 'event_id' | 'variant_id'>>
): Promise<void> {
  const ev = await getEvent(eventId);
  if (ev?.status === 'closed' && patch.event_price_minor !== undefined) {
    throw new DomainError('展会已收摊，不能改价');
  }
  const fields: [string, unknown][] = [];
  for (const key of ['enabled', 'event_price_minor', 'sort_order', 'purchase_limit', 'show_exact_stock', 'low_stock_threshold', 'kiosk_visible'] as const) {
    const v = patch[key];
    if (v !== undefined) fields.push([key, v]);
  }
  if (!fields.length) return;
  await ex().tx([
    {
      t: 'run',
      sql: `UPDATE event_variant_configs SET ${fields.map(([c]) => `${c} = ?`).join(', ')}
            WHERE event_id = ? AND variant_id = ?`,
      params: [...fields.map(([, v]) => v as string | number | null), eventId, variantId]
    }
  ]);
}

export async function setVariantsEnabled(eventId: string, variantIds: string[], enabled: boolean): Promise<void> {
  if (!variantIds.length) return;
  const steps: Step[] = variantIds.map((variantId) => ({
    t: 'run',
    sql: 'UPDATE event_variant_configs SET enabled = ? WHERE event_id = ? AND variant_id = ?',
    params: [enabled ? 1 : 0, eventId, variantId]
  }));
  await ex().tx(steps);
}

export async function bulkSetCategoryEnabled(
  eventId: string,
  categoryId: string,
  enabled: boolean
): Promise<void> {
  await ex().tx([
    {
      t: 'run',
      sql: `UPDATE event_variant_configs SET enabled = ?
            WHERE event_id = ? AND variant_id IN (
              SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.category_id = ?)`,
      params: [enabled ? 1 : 0, eventId, categoryId]
    }
  ]);
}

/* ------------------------------------------------------------ 支付方式 */

export function listPaymentMethods(): Promise<PaymentMethod[]> {
  return ex().read<PaymentMethod>('SELECT * FROM payment_methods ORDER BY sort_order, name');
}

export async function createPaymentMethod(input: {
  name: string;
  type: PaymentMethod['type'];
  qr_asset_id?: string | null;
  instruction?: string | null;
}): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new DomainError('支付方式名称不能为空');
  const id = newId();
  await ex().tx([
    {
      t: 'run',
      sql: `INSERT INTO payment_methods (id, name, type, qr_asset_id, enabled, sort_order, instruction, created_at)
            VALUES (?, ?, ?, ?, 1, (SELECT COALESCE(MAX(sort_order),0)+1 FROM payment_methods), ?, ?)`,
      params: [id, name, input.type, input.qr_asset_id ?? null, input.instruction ?? null, nowIso()]
    }
  ]);
  return id;
}

export async function updatePaymentMethod(
  id: string,
  patch: { name?: string; type?: PaymentMethod['type']; qr_asset_id?: string | null; enabled?: boolean; sort_order?: number; instruction?: string | null }
): Promise<void> {
  const fields: [string, unknown][] = [];
  const map: Record<string, string> = {
    name: 'name',
    type: 'type',
    qr_asset_id: 'qr_asset_id',
    enabled: 'enabled',
    sort_order: 'sort_order',
    instruction: 'instruction'
  };
  for (const [key, col] of Object.entries(map)) {
    const v = (patch as Record<string, unknown>)[key];
    if (v === undefined) continue;
    fields.push([col, typeof v === 'boolean' ? (v ? 1 : 0) : v]);
  }
  if (!fields.length) return;
  await ex().tx([
    {
      t: 'run',
      sql: `UPDATE payment_methods SET ${fields.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`,
      params: [...fields.map(([, v]) => v as string | number | null), id]
    }
  ]);
}

export interface EventPaymentMethodRow extends PaymentMethod {
  event_enabled: number;
  event_sort_order: number;
}

/** 本场启用的支付方式（模板不等于自动启用）。 */
export async function getEventPaymentMethods(eventId: string): Promise<EventPaymentMethodRow[]> {
  return ex().read<EventPaymentMethodRow>(
    `SELECT m.*, e.enabled AS event_enabled, e.sort_order AS event_sort_order
     FROM event_payment_methods e JOIN payment_methods m ON m.id = e.payment_method_id
     WHERE e.event_id = ? AND e.enabled = 1 AND m.enabled = 1
     ORDER BY e.sort_order, m.name`,
    [eventId]
  );
}

export async function setEventPaymentMethods(
  eventId: string,
  methodIds: string[]
): Promise<void> {
  const steps: Step[] = [{ t: 'run', sql: 'DELETE FROM event_payment_methods WHERE event_id = ?', params: [eventId] }];
  methodIds.forEach((methodId, i) => {
    steps.push({
      t: 'run',
      sql: 'INSERT INTO event_payment_methods (event_id, payment_method_id, enabled, sort_order) VALUES (?, ?, 1, ?)',
      params: [eventId, methodId, i]
    });
  });
  await ex().tx(steps);
}
