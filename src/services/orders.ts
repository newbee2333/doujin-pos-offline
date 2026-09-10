/**
 * 订单、收款、退款、纠错与库存成分快照（第 11、13、15、16、17 节）。
 *
 * 关键点：
 * - 购物车不占库；pending_payment 预留；completed 消耗实际库存并释放原预留；voided 只释放预留。
 * - 套装与普通商品共用库存，按整单合并成分后校验，逐行检查会漏掉「A×1 + 含 A 的套装」这类冲突。
 * - 确认、取消、退款、纠错只读订单快照，不重读现行套装配方或价格。
 */

import type { Step } from '../db/executor';
import type {
  Currency,
  MenuItem,
  Order,
  OrderItem,
  Payment,
  PaymentMethodType,
  ProductType,
  Refund,
  OrderSource
} from '../domain/types';
import { newId, nowIso } from '../domain/ids';
import { mulQty, sumMinor } from '../domain/money';
import { auditStep, beginIdempotent, ex, idempotencyStep } from './context';
import { DomainError } from './catalog';
import { getBundleComponentsBatch } from './catalog';
import { getEvent } from './events';

export class OrderValidationError extends Error {
  issues: string[];
  priceChanges?: { variantId: string; oldPrice: number; newPrice: number }[];
  constructor(issues: string[], priceChanges?: { variantId: string; oldPrice: number; newPrice: number }[]) {
    super(issues.join('；'));
    this.name = 'OrderValidationError';
    this.issues = issues;
    this.priceChanges = priceChanges;
  }
}

export interface CartLine {
  variantId: string;
  quantity: number;
}

interface VariantContext {
  variant_id: string;
  variant_name: string;
  sku: string | null;
  variant_archived: number;
  product_id: string;
  product_name: string;
  product_type: ProductType;
  product_archived: number;
  category_id: string | null;
  category_hidden: number | null;
  event_price_minor: number | null;
  enabled: number | null;
  purchase_limit: number | null;
  kiosk_visible: number | null;
  show_exact_stock: number | null;
  low_stock_threshold: number | null;
}

interface ResolvedItem {
  variantId: string;
  quantity: number;
  productId: string;
  productName: string;
  variantName: string;
  sku: string | null;
  productType: ProductType;
  unitPrice: number;
  subtotal: number;
  /** 每 1 件该商品消耗的库存成分。 */
  perUnitComponents: { variantId: string; quantity: number; name: string; sku: string | null }[];
}

export interface OrderPlan {
  eventId: string;
  currency: Currency;
  items: ResolvedItem[];
  /** 整单合并后的成分需求。 */
  componentDemand: Map<string, number>;
  totalMinor: number;
}

/* ------------------------------------------------------------ 解析与校验 */

export async function buildOrderPlan(
  eventId: string,
  lines: CartLine[],
  opts: { source: OrderSource; expectedPrices?: Record<string, number> }
): Promise<OrderPlan> {
  const event = await getEvent(eventId);
  if (!event) throw new DomainError('展会不存在');
  if (event.status !== 'active') throw new DomainError('展会未在开始状态，不能下单');

  if (!lines.length) throw new OrderValidationError(['购物车是空的']);
  const issues: string[] = [];
  const priceChanges: { variantId: string; oldPrice: number; newPrice: number }[] = [];

  const ids = lines.map((l) => l.variantId);
  const rows = await ex().read<VariantContext>(
    `SELECT v.id AS variant_id, v.name AS variant_name, v.sku, v.archived AS variant_archived,
            p.id AS product_id, p.name AS product_name, p.type AS product_type, p.archived AS product_archived,
            p.category_id, cat.hidden AS category_hidden,
            cfg.event_price_minor, cfg.enabled, cfg.purchase_limit, cfg.kiosk_visible,
            cfg.show_exact_stock, cfg.low_stock_threshold
     FROM product_variants v
     JOIN products p ON p.id = v.product_id
     LEFT JOIN categories cat ON cat.id = p.category_id
     LEFT JOIN event_variant_configs cfg ON cfg.variant_id = v.id AND cfg.event_id = ?
     WHERE v.id IN (${ids.map(() => '?').join(',')})`,
    [eventId, ...ids]
  );
  const ctxMap = new Map(rows.map((r) => [r.variant_id, r]));

  const bundleIds = rows.filter((r) => r.product_type === 'bundle').map((r) => r.variant_id);
  const bundleMap = await getBundleComponentsBatch(bundleIds);

  const items: ResolvedItem[] = [];
  for (const line of lines) {
    const ctx = ctxMap.get(line.variantId);
    if (!ctx) {
      issues.push('购物车里有已不存在的商品');
      continue;
    }
    const qty = line.quantity;
    if (!Number.isInteger(qty) || qty <= 0) {
      issues.push('商品数量必须为正整数');
      continue;
    }
    if (ctx.enabled !== 1) {
      issues.push(`「${ctx.product_name}」本场未上架`);
      continue;
    }
    if (ctx.product_archived === 1 || ctx.variant_archived === 1) {
      issues.push(`「${ctx.product_name}」已归档`);
      continue;
    }
    if (opts.source === 'kiosk') {
      if (ctx.category_hidden === 1) {
        issues.push(`「${ctx.product_name}」所在分类已隐藏`);
        continue;
      }
      if (ctx.kiosk_visible !== 1) {
        issues.push(`「${ctx.product_name}」不对游客开放`);
        continue;
      }
    }
    if (ctx.product_type !== 'gift' && ctx.event_price_minor === null) {
      issues.push(`「${ctx.product_name}」未设置本场价格`);
      continue;
    }
    const unitPrice = ctx.product_type === 'gift' ? 0 : Number(ctx.event_price_minor ?? 0);
    if (opts.expectedPrices && opts.expectedPrices[line.variantId] !== undefined) {
      const expected = opts.expectedPrices[line.variantId];
      if (expected !== unitPrice) {
        priceChanges.push({ variantId: line.variantId, oldPrice: expected, newPrice: unitPrice });
      }
    }

    let perUnitComponents: ResolvedItem['perUnitComponents'] = [];
    if (ctx.product_type === 'bundle') {
      const comps = bundleMap.get(ctx.variant_id) ?? [];
      if (!comps.length) {
        issues.push(`套装「${ctx.product_name}」没有配置成分`);
        continue;
      }
      perUnitComponents = comps.map((c) => ({
        variantId: c.component_variant_id,
        quantity: c.quantity,
        name: '',
        sku: null
      }));
    } else if (ctx.product_type === 'normal' || ctx.product_type === 'gift') {
      perUnitComponents = [
        { variantId: ctx.variant_id, quantity: 1, name: ctx.variant_name, sku: ctx.sku }
      ];
    }
    items.push({
      variantId: ctx.variant_id,
      quantity: qty,
      productId: ctx.product_id,
      productName: ctx.product_name,
      variantName: ctx.variant_name,
      sku: ctx.sku,
      productType: ctx.product_type,
      unitPrice,
      subtotal: mulQty(unitPrice, qty),
      perUnitComponents
    });
  }

  if (priceChanges.length) {
    throw new OrderValidationError(['价格已变化，请确认新的金额后重新提交'], priceChanges);
  }

  // 整单合并成分需求
  const componentDemand = new Map<string, number>();
  for (const item of items) {
    for (const c of item.perUnitComponents) {
      const need = c.quantity * item.quantity;
      componentDemand.set(c.variantId, (componentDemand.get(c.variantId) ?? 0) + need);
    }
  }

  // 库存校验：合并后的实际需求
  const compIds = Array.from(componentDemand.keys());
  if (compIds.length) {
    const invRows = await ex().read<{ variant_id: string; physical_stock: number; reserved_stock: number; name: string }>(
      `SELECT i.variant_id, i.physical_stock, i.reserved_stock, v.name
       FROM inventory i JOIN product_variants v ON v.id = i.variant_id
       WHERE i.event_id = ? AND i.variant_id IN (${compIds.map(() => '?').join(',')})`,
      [eventId, ...compIds]
    );
    const invMap = new Map(invRows.map((r) => [r.variant_id, r]));
    for (const [variantId, need] of componentDemand) {
      const inv = invMap.get(variantId);
      const available = inv ? inv.physical_stock - inv.reserved_stock : 0;
      if (available < need) {
        issues.push(`库存不足：${inv?.name ?? variantId} 可用 ${available}，本单需要 ${need}`);
      }
    }
  }

  // 限购：按实际 Variant 消耗量合并普通销售与套装成分
  for (const item of items) {
    const ctx = ctxMap.get(item.variantId);
    if (!ctx || ctx.purchase_limit === null) continue;
    const consumed =
      (componentDemand.get(item.variantId) ?? 0) > 0 && item.productType !== 'bundle'
        ? componentDemand.get(item.variantId) ?? 0
        : item.quantity;
    if (consumed > Number(ctx.purchase_limit)) {
      issues.push(`「${item.productName}」每单限购 ${ctx.purchase_limit} 件，本单 ${consumed} 件`);
    }
  }

  if (issues.length) throw new OrderValidationError(issues);

  return {
    eventId,
    currency: event.currency,
    items,
    componentDemand,
    totalMinor: sumMinor(items.map((i) => i.subtotal))
  };
}

/* -------------------------------------------------------------- 建单步骤 */

interface BuildResult {
  orderId: string;
  steps: Step[];
}

function insertOrderSteps(
  plan: OrderPlan,
  orderId: string,
  status: 'pending_payment' | 'completed',
  source: OrderSource,
  operationId: string,
  planned: { id: string | null; name: string | null; type: PaymentMethodType | null; instruction: string | null; qr: string | null },
  note?: string | null
): Step[] {
  const now = nowIso();
  const steps: Step[] = [
    {
      t: 'assert',
      sql: "SELECT CASE WHEN (SELECT status FROM events WHERE id = ?) = 'active' THEN 1 ELSE 0 END",
      params: [plan.eventId],
      equals: 1,
      message: '展会已不在进行状态，订单未提交'
    },
    {
      t: 'run',
      sql: `INSERT INTO orders (id, human_readable_number, event_id, status, currency, subtotal_minor, total_minor,
              planned_payment_method_id, planned_method_name_snapshot, planned_method_type_snapshot,
              planned_instruction_snapshot, planned_qr_asset_id, source, created_at, completed_at, note, operation_id)
            VALUES (?, (SELECT COALESCE(MAX(human_readable_number), 0) + 1 FROM orders WHERE event_id = ?),
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        orderId,
        plan.eventId,
        plan.eventId,
        status,
        plan.currency,
        plan.totalMinor,
        plan.totalMinor,
        planned.id,
        planned.name,
        planned.type,
        planned.instruction,
        planned.qr,
        source,
        now,
        status === 'completed' ? now : null,
        note ?? null,
        operationId
      ],
      expectChanges: 1
    }
  ];

  for (const item of plan.items) {
    const itemId = newId();
    steps.push({
      t: 'run',
      sql: `INSERT INTO order_items (id, order_id, product_id, variant_id, product_name_snapshot, variant_name_snapshot,
              sku_snapshot, product_type_snapshot, unit_price_minor, quantity, subtotal_minor)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        itemId,
        orderId,
        item.productId,
        item.variantId,
        item.productName,
        item.variantName,
        item.sku,
        item.productType,
        item.unitPrice,
        item.quantity,
        item.subtotal
      ]
    });
    for (const c of item.perUnitComponents) {
      steps.push({
        t: 'run',
        sql: `INSERT INTO order_inventory_components (id, order_item_id, component_variant_id, quantity_total, component_name_snapshot, sku_snapshot)
              SELECT ?, ?, ?, ?, COALESCE((SELECT v.name FROM product_variants v WHERE v.id = ?), ?),
                     (SELECT v.sku FROM product_variants v WHERE v.id = ?)`,
        params: [newId(), itemId, c.variantId, c.quantity * item.quantity, c.variantId, c.variantId, c.variantId]
      });
    }
  }
  return steps;
}

function reserveSteps(plan: OrderPlan, orderId: string, operationId: string): Step[] {
  const steps: Step[] = [];
  for (const [variantId, need] of plan.componentDemand) {
    steps.push({
      t: 'run',
      sql: 'UPDATE inventory SET reserved_stock = reserved_stock + ? WHERE event_id = ? AND variant_id = ? AND physical_stock - reserved_stock >= ?',
      params: [need, plan.eventId, variantId, need],
      expectChanges: 1
    });
    steps.push({
      t: 'run',
      sql: `INSERT INTO inventory_transactions (id, event_id, variant_id, delta_physical, delta_reserved, type, order_id, operation_id, reason, note, created_at)
            VALUES (?, ?, ?, 0, ?, 'reservation', ?, ?, NULL, NULL, ?)`,
      params: [newId(), plan.eventId, variantId, need, orderId, operationId, nowIso()]
    });
  }
  return steps;
}

/** 直接销售：扣实际库存 + 写 sale/gift 流水（不经过预留）。 */
function consumeSteps(plan: OrderPlan, orderId: string, operationId: string): Step[] {
  const steps: Step[] = [];
  for (const item of plan.items) {
    const isGift = item.productType === 'gift';
    for (const c of item.perUnitComponents) {
      const need = c.quantity * item.quantity;
      steps.push({
        t: 'run',
        sql: 'UPDATE inventory SET physical_stock = physical_stock - ? WHERE event_id = ? AND variant_id = ? AND physical_stock - reserved_stock >= ?',
        params: [need, plan.eventId, c.variantId, need],
        expectChanges: 1
      });
      steps.push({
        t: 'run',
        sql: `INSERT INTO inventory_transactions (id, event_id, variant_id, delta_physical, delta_reserved, type, order_id, operation_id, reason, note, created_at)
              VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, ?)`,
        params: [
          newId(),
          plan.eventId,
          c.variantId,
          -need,
          isGift ? 'gift' : 'sale',
          orderId,
          operationId,
          nowIso()
        ]
      });
    }
  }
  return steps;
}

function paymentStep(
  orderId: string,
  method: { id: string; name: string; type: PaymentMethodType },
  amount: number,
  currency: Currency,
  operationId: string,
  tendered?: number | null
): Step {
  return {
    t: 'run',
    sql: `INSERT INTO payments (id, order_id, amount_minor, currency, payment_method_id, method_name_snapshot,
            method_type_snapshot, confirmed_at, tendered_minor, change_minor, operation_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      newId(),
      orderId,
      amount,
      currency,
      method.id,
      method.name,
      method.type,
      nowIso(),
      tendered ?? null,
      tendered != null ? tendered - amount : null,
      operationId
    ]
  };
}

/* ------------------------------------------------------------ 对外服务 */

export interface CreatePendingInput {
  eventId: string;
  lines: CartLine[];
  plannedPaymentMethodId: string | null;
  operationId?: string;
  note?: string | null;
}

/** 游客提交：创建 pending_payment 并预留库存。 */
export async function createPendingOrder(input: CreatePendingInput): Promise<{ orderId: string }> {
  const opId = input.operationId ?? newId();
  const { hash, existing } = await beginIdempotent('order.createPending', opId, input);
  if (existing) return existing as { orderId: string };

  const plan = await buildOrderPlan(input.eventId, input.lines, { source: 'kiosk' });
  let planned = { id: null as string | null, name: null as string | null, type: null as PaymentMethodType | null, instruction: null as string | null, qr: null as string | null };
  if (plan.totalMinor > 0) {
    if (!input.plannedPaymentMethodId) throw new DomainError('请选择支付方式');
    const m = await ex().readOne<{ id: string; name: string; type: PaymentMethodType; instruction: string | null; qr_asset_id: string | null }>(
      'SELECT id, name, type, instruction, qr_asset_id FROM payment_methods WHERE id = ?',
      [input.plannedPaymentMethodId]
    );
    if (!m) throw new DomainError('支付方式不存在');
    if (m.type === 'qr_payment' && !m.qr_asset_id) throw new DomainError('该支付方式未上传收款码，请更换方式');
    planned = { id: m.id, name: m.name, type: m.type, instruction: m.instruction, qr: m.qr_asset_id };
  }

  const orderId = newId();
  const steps: Step[] = [
    ...insertOrderSteps(plan, orderId, 'pending_payment', 'kiosk', opId, planned, input.note),
    ...reserveSteps(plan, orderId, opId),
    auditStep('order.createPending', 'order', orderId, { total: plan.totalMinor, source: 'kiosk' }, 'kiosk'),
    idempotencyStep(opId, 'order.createPending', hash, { orderId })
  ];
  await ex().tx(steps);
  return { orderId };
}

export interface StaffSaleInput {
  eventId: string;
  lines: CartLine[];
  paymentMethodId: string;
  tenderedMinor?: number | null;
  operationId?: string;
  note?: string | null;
}

/** 摊主直接收银：一步完成，扣实际库存并写收款。 */
export async function staffDirectSale(input: StaffSaleInput): Promise<{ orderId: string }> {
  const opId = input.operationId ?? newId();
  const { hash, existing } = await beginIdempotent('order.staffSale', opId, input);
  if (existing) return existing as { orderId: string };

  const plan = await buildOrderPlan(input.eventId, input.lines, { source: 'staff' });
  const method = await ex().readOne<{ id: string; name: string; type: PaymentMethodType; instruction: string | null; qr_asset_id: string | null }>(
    'SELECT id, name, type, instruction, qr_asset_id FROM payment_methods WHERE id = ?',
    [input.paymentMethodId]
  );
  if (!method) throw new DomainError('支付方式不存在');

  if (plan.totalMinor > 0) {
    if (method.type === 'cash') {
      const tendered = input.tenderedMinor ?? null;
      if (tendered === null) throw new DomainError('现金收款请填写实收金额');
      if (tendered < plan.totalMinor) throw new DomainError('实收金额小于应付金额');
    }
  }

  const orderId = newId();
  const planned = { id: method.id, name: method.name, type: method.type, instruction: method.instruction, qr: method.qr_asset_id };
  const steps: Step[] = [
    ...insertOrderSteps(plan, orderId, 'completed', 'staff', opId, planned, input.note),
    ...consumeSteps(plan, orderId, opId)
  ];
  if (plan.totalMinor > 0) {
    steps.push(paymentStep(orderId, method, plan.totalMinor, plan.currency, opId, input.tenderedMinor ?? null));
  }
  steps.push(auditStep('order.staffSale', 'order', orderId, { total: plan.totalMinor, method: method.name }));
  steps.push(idempotencyStep(opId, 'order.staffSale', hash, { orderId }));
  await ex().tx(steps);
  return { orderId };
}

export interface ConfirmInput {
  orderId: string;
  paymentMethodId?: string | null;
  tenderedMinor?: number | null;
  operationId?: string;
}

/**
 * 摊主确认收款：pending_payment → completed。
 * 只读订单快照扣库，不因现行配方或价格变化重算。
 */
export async function confirmPayment(input: ConfirmInput): Promise<void> {
  const opId = input.operationId ?? newId();
  const { hash, existing } = await beginIdempotent('order.confirm', opId, input);
  if (existing) return;

  const order = await ex().readOne<Order>('SELECT * FROM orders WHERE id = ?', [input.orderId]);
  if (!order) throw new DomainError('订单不存在');
  if (order.status !== 'pending_payment') throw new DomainError('只有待付款订单可以确认收款');
  if (order.total_minor > 0) {
    const methodId = input.paymentMethodId ?? order.planned_payment_method_id;
    if (!methodId) throw new DomainError('请选择实际收款方式');
    const method = await ex().readOne<{ id: string; name: string; type: PaymentMethodType }>(
      'SELECT id, name, type FROM payment_methods WHERE id = ?',
      [methodId]
    );
    if (!method) throw new DomainError('收款方式不存在');
    if (method.type === 'cash') {
      const tendered = input.tenderedMinor ?? null;
      if (tendered === null) throw new DomainError('现金收款请填写实收金额');
      if (tendered < order.total_minor) throw new DomainError('实收金额小于应付金额');
    }
  }

  const components = await ex().read<{ component_variant_id: string; quantity_total: number }>(
    `SELECT c.component_variant_id, SUM(c.quantity_total) AS quantity_total
     FROM order_inventory_components c JOIN order_items oi ON oi.id = c.order_item_id
     WHERE oi.order_id = ? GROUP BY c.component_variant_id`,
    [order.id]
  );

  const steps: Step[] = [
    {
      t: 'assert',
      sql: "SELECT CASE WHEN (SELECT status FROM orders WHERE id = ?) = 'pending_payment' THEN 1 ELSE 0 END",
      params: [order.id],
      equals: 1,
      message: '订单状态已变化，请刷新后重试'
    }
  ];

  for (const c of components) {
    const qty = Number(c.quantity_total);
    steps.push({
      t: 'run',
      sql: 'UPDATE inventory SET physical_stock = physical_stock - ?, reserved_stock = reserved_stock - ? WHERE event_id = ? AND variant_id = ? AND physical_stock >= ? AND reserved_stock >= ?',
      params: [qty, qty, order.event_id, c.component_variant_id, qty, qty],
      expectChanges: 1
    });
    const isGift = await isGiftOrder(order.id);
    steps.push({
      t: 'run',
      sql: `INSERT INTO inventory_transactions (id, event_id, variant_id, delta_physical, delta_reserved, type, order_id, operation_id, reason, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      params: [newId(), order.event_id, c.component_variant_id, -qty, -qty, isGift ? 'gift' : 'sale', order.id, opId, nowIso()]
    });
  }

  if (order.total_minor > 0) {
    const methodId = input.paymentMethodId ?? order.planned_payment_method_id;
    const method = await ex().readOne<{ id: string; name: string; type: PaymentMethodType }>(
      'SELECT id, name, type FROM payment_methods WHERE id = ?',
      [methodId]
    );
    steps.push(
      paymentStep(
        order.id,
        { id: method!.id, name: method!.name, type: method!.type },
        order.total_minor,
        order.currency,
        opId,
        input.tenderedMinor ?? null
      )
    );
  }

  steps.push({
    t: 'run',
    sql: "UPDATE orders SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'pending_payment'",
    params: [nowIso(), order.id],
    expectChanges: 1
  });
  steps.push(auditStep('order.confirm', 'order', order.id, { total: order.total_minor }));
  steps.push(idempotencyStep(opId, 'order.confirm', hash, { orderId: order.id }));
  await ex().tx(steps);
}

async function isGiftOrder(orderId: string): Promise<boolean> {
  const row = await ex().readOne<{ c: number }>(
    "SELECT COUNT(*) AS c FROM order_items WHERE order_id = ? AND product_type_snapshot <> 'gift'",
    [orderId]
  );
  return Number(row?.c ?? 0) === 0;
}

/** 取消未付款订单：只释放预留。 */
export async function voidOrder(orderId: string, reason: string | null, operationId?: string): Promise<void> {
  const opId = operationId ?? newId();
  const { hash, existing } = await beginIdempotent('order.void', opId, { orderId, reason });
  if (existing) return;

  const order = await ex().readOne<Order>('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) throw new DomainError('订单不存在');
  if (order.status !== 'pending_payment') throw new DomainError('只有待付款订单可以取消');

  const components = await ex().read<{ component_variant_id: string; quantity_total: number }>(
    `SELECT c.component_variant_id, SUM(c.quantity_total) AS quantity_total
     FROM order_inventory_components c JOIN order_items oi ON oi.id = c.order_item_id
     WHERE oi.order_id = ? GROUP BY c.component_variant_id`,
    [orderId]
  );

  const steps: Step[] = [
    {
      t: 'assert',
      sql: "SELECT CASE WHEN (SELECT status FROM orders WHERE id = ?) = 'pending_payment' THEN 1 ELSE 0 END",
      params: [orderId],
      equals: 1,
      message: '订单状态已变化，请刷新后重试'
    }
  ];
  for (const c of components) {
    const qty = Number(c.quantity_total);
    steps.push({
      t: 'run',
      sql: 'UPDATE inventory SET reserved_stock = reserved_stock - ? WHERE event_id = ? AND variant_id = ? AND reserved_stock >= ?',
      params: [qty, order.event_id, c.component_variant_id, qty],
      expectChanges: 1
    });
    steps.push({
      t: 'run',
      sql: `INSERT INTO inventory_transactions (id, event_id, variant_id, delta_physical, delta_reserved, type, order_id, operation_id, reason, note, created_at)
            VALUES (?, ?, ?, 0, ?, 'reservation_release', ?, ?, ?, NULL, ?)`,
      params: [newId(), order.event_id, c.component_variant_id, -qty, orderId, opId, reason, nowIso()]
    });
  }
  steps.push({
    t: 'run',
    sql: "UPDATE orders SET status = 'voided', voided_at = ? WHERE id = ? AND status = 'pending_payment'",
    params: [nowIso(), orderId],
    expectChanges: 1
  });
  steps.push(auditStep('order.void', 'order', orderId, { reason }));
  steps.push(idempotencyStep(opId, 'order.void', hash, { orderId }));
  await ex().tx(steps);
}

export interface RefundInput {
  orderId: string;
  /** 实际退款渠道，可与原收款渠道不同。 */
  paymentMethodId: string;
  reason: string;
  /** 各成分实际返库数量，key 为 component_variant_id。 */
  returns: Record<string, number>;
  operationId?: string;
}

/**
 * 记录已完成的整单退款。金额恒等于原订单金额；返库数量可为 0 到原售出量。
 */
export async function recordRefund(input: RefundInput): Promise<void> {
  const opId = input.operationId ?? newId();
  const { hash, existing } = await beginIdempotent('order.refund', opId, input);
  if (existing) return;

  const order = await ex().readOne<Order>('SELECT * FROM orders WHERE id = ?', [input.orderId]);
  if (!order) throw new DomainError('订单不存在');
  if (order.status !== 'completed') throw new DomainError('只有已完成的订单可以记录退款');
  if (!input.reason.trim()) throw new DomainError('请填写退款原因');
  const method = await ex().readOne<{ id: string; name: string; type: PaymentMethodType }>(
    'SELECT id, name, type FROM payment_methods WHERE id = ?',
    [input.paymentMethodId]
  );
  if (!method) throw new DomainError('退款渠道不存在');

  const payment = await ex().readOne<{ id: string }>('SELECT id FROM payments WHERE order_id = ?', [order.id]);
  const components = await ex().read<{ component_variant_id: string; quantity_total: number }>(
    `SELECT c.component_variant_id, SUM(c.quantity_total) AS quantity_total
     FROM order_inventory_components c JOIN order_items oi ON oi.id = c.order_item_id
     WHERE oi.order_id = ? GROUP BY c.component_variant_id`,
    [order.id]
  );
  for (const c of components) {
    const back = input.returns[c.component_variant_id] ?? 0;
    if (!Number.isInteger(back) || back < 0) throw new DomainError('返库数量必须为非负整数');
    if (back > Number(c.quantity_total)) throw new DomainError('返库数量不能超过原售出数量');
  }

  const refundId = newId();
  const steps: Step[] = [
    {
      t: 'assert',
      sql: "SELECT CASE WHEN (SELECT status FROM orders WHERE id = ?) = 'completed' THEN 1 ELSE 0 END",
      params: [order.id],
      equals: 1,
      message: '订单状态已变化，请刷新后重试'
    },
    {
      t: 'run',
      sql: `INSERT INTO refunds (id, order_id, payment_id, amount_minor, currency, payment_method_id,
              method_name_snapshot, method_type_snapshot, confirmed_at, reason, operation_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        refundId,
        order.id,
        payment?.id ?? null,
        order.total_minor,
        order.currency,
        method.id,
        method.name,
        method.type,
        nowIso(),
        input.reason,
        opId
      ],
      expectChanges: 1
    }
  ];
  for (const c of components) {
    const back = input.returns[c.component_variant_id] ?? 0;
    steps.push({
      t: 'run',
      sql: 'INSERT INTO refund_returns (id, refund_id, component_variant_id, quantity_returned) VALUES (?, ?, ?, ?)',
      params: [newId(), refundId, c.component_variant_id, back]
    });
    if (back > 0) {
      steps.push({
        t: 'run',
        sql: 'UPDATE inventory SET physical_stock = physical_stock + ? WHERE event_id = ? AND variant_id = ?',
        params: [back, order.event_id, c.component_variant_id],
        expectChanges: 1
      });
      steps.push({
        t: 'run',
        sql: `INSERT INTO inventory_transactions (id, event_id, variant_id, delta_physical, delta_reserved, type, order_id, operation_id, reason, note, created_at)
              VALUES (?, ?, ?, ?, 0, 'refund_return', ?, ?, ?, NULL, ?)`,
        params: [newId(), order.event_id, c.component_variant_id, back, order.id, opId, input.reason, nowIso()]
      });
    }
  }
  steps.push({
    t: 'run',
    sql: "UPDATE orders SET status = 'refunded', refunded_at = ? WHERE id = ? AND status = 'completed'",
    params: [nowIso(), order.id],
    expectChanges: 1
  });
  steps.push(auditStep('order.refund', 'order', order.id, { amount: order.total_minor, method: method.name, reason: input.reason }));
  steps.push(idempotencyStep(opId, 'order.refund', hash, { refundId }));
  await ex().tx(steps);
}

export interface CorrectionInput {
  orderId: string;
  reason: string;
  returns: Record<string, number>;
  operationId?: string;
}

/**
 * 撤销误记（记账纠错）。与真实退款分开：不生成退款记录，原收款作为错误记录保留。
 */
export async function correctOrder(input: CorrectionInput): Promise<void> {
  const opId = input.operationId ?? newId();
  const { hash, existing } = await beginIdempotent('order.correct', opId, input);
  if (existing) return;

  const order = await ex().readOne<Order>('SELECT * FROM orders WHERE id = ?', [input.orderId]);
  if (!order) throw new DomainError('订单不存在');
  if (order.status !== 'completed') throw new DomainError('只有已完成的订单可以撤销误记');
  if (!input.reason.trim()) throw new DomainError('请填写撤销原因');

  const payment = await ex().readOne<{ id: string }>('SELECT id FROM payments WHERE order_id = ?', [order.id]);
  const components = await ex().read<{ component_variant_id: string; quantity_total: number }>(
    `SELECT c.component_variant_id, SUM(c.quantity_total) AS quantity_total
     FROM order_inventory_components c JOIN order_items oi ON oi.id = c.order_item_id
     WHERE oi.order_id = ? GROUP BY c.component_variant_id`,
    [order.id]
  );
  for (const c of components) {
    const back = input.returns[c.component_variant_id] ?? 0;
    if (!Number.isInteger(back) || back < 0) throw new DomainError('返库数量必须为非负整数');
    if (back > Number(c.quantity_total)) throw new DomainError('返库数量不能超过原售出数量');
  }

  const correctionId = newId();
  const steps: Step[] = [
    {
      t: 'assert',
      sql: "SELECT CASE WHEN (SELECT status FROM orders WHERE id = ?) = 'completed' THEN 1 ELSE 0 END",
      params: [order.id],
      equals: 1,
      message: '订单状态已变化，请刷新后重试'
    },
    {
      t: 'run',
      sql: 'INSERT INTO order_corrections (id, order_id, payment_id, reason, created_at, operation_id) VALUES (?, ?, ?, ?, ?, ?)',
      params: [correctionId, order.id, payment?.id ?? null, input.reason, nowIso(), opId],
      expectChanges: 1
    }
  ];
  for (const c of components) {
    const back = input.returns[c.component_variant_id] ?? 0;
    steps.push({
      t: 'run',
      sql: 'INSERT INTO correction_returns (id, correction_id, component_variant_id, quantity_returned) VALUES (?, ?, ?, ?)',
      params: [newId(), correctionId, c.component_variant_id, back]
    });
    if (back > 0) {
      steps.push({
        t: 'run',
        sql: 'UPDATE inventory SET physical_stock = physical_stock + ? WHERE event_id = ? AND variant_id = ?',
        params: [back, order.event_id, c.component_variant_id],
        expectChanges: 1
      });
      steps.push({
        t: 'run',
        sql: `INSERT INTO inventory_transactions (id, event_id, variant_id, delta_physical, delta_reserved, type, order_id, operation_id, reason, note, created_at)
              VALUES (?, ?, ?, ?, 0, 'correction_return', ?, ?, ?, NULL, ?)`,
        params: [newId(), order.event_id, c.component_variant_id, back, order.id, opId, input.reason, nowIso()]
      });
    }
  }
  steps.push({
    t: 'run',
    sql: "UPDATE orders SET status = 'corrected', corrected_at = ? WHERE id = ? AND status = 'completed'",
    params: [nowIso(), order.id],
    expectChanges: 1
  });
  steps.push(auditStep('order.correct', 'order', order.id, { reason: input.reason, amount: order.total_minor }));
  steps.push(idempotencyStep(opId, 'order.correct', hash, { correctionId }));
  await ex().tx(steps);
}

/* ---------------------------------------------------------------- 查询 */

export interface OrderFilter {
  eventId?: string;
  status?: string;
  source?: OrderSource;
  keyword?: string;
  /** 起始时间（含），UTC ISO 字符串。 */
  from?: string;
  /** 结束时间（不含），UTC ISO 字符串。 */
  to?: string;
  /** 实际支付方式；没有收款记录时回退到计划的支付方式（待付款单）。 */
  paymentMethodId?: string;
  limit?: number;
}

export async function listOrders(filter: OrderFilter = {}): Promise<Order[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.eventId) {
    where.push('o.event_id = ?');
    params.push(filter.eventId);
  }
  if (filter.status) {
    where.push('o.status = ?');
    params.push(filter.status);
  }
  if (filter.source) {
    where.push('o.source = ?');
    params.push(filter.source);
  }
  if (filter.from) {
    where.push('o.created_at >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('o.created_at < ?');
    params.push(filter.to);
  }
  if (filter.paymentMethodId) {
    where.push(`(EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.payment_method_id = ?)
                 OR (o.planned_payment_method_id = ? AND NOT EXISTS (SELECT 1 FROM payments p2 WHERE p2.order_id = o.id)))`);
    params.push(filter.paymentMethodId, filter.paymentMethodId);
  }
  if (filter.keyword) {
    where.push('(CAST(o.human_readable_number AS TEXT) LIKE ? OR EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND (oi.product_name_snapshot LIKE ? OR oi.sku_snapshot LIKE ?)))');
    const like = `%${filter.keyword}%`;
    params.push(like, like, like);
  }
  const limit = filter.limit ?? 200;
  return ex().read<Order>(
    `SELECT o.* FROM orders o ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY o.created_at DESC LIMIT ${limit}`,
    params
  );
}

export interface OrderDetail {
  order: Order;
  items: (OrderItem & { components: { component_variant_id: string; quantity_total: number; component_name_snapshot: string }[] })[];
  payment: Payment | null;
  refund: Refund | null;
  correction: { id: string; reason: string; created_at: string; returns: { component_variant_id: string; quantity_returned: number }[] } | null;
  transactions: { id: string; type: string; variant_id: string; delta_physical: number; delta_reserved: number; created_at: string }[];
}

export async function getOrderDetail(orderId: string): Promise<OrderDetail | null> {
  const order = await ex().readOne<Order>('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) return null;
  const items = await ex().read<OrderItem>('SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid', [orderId]);
  const comps = await ex().read<{ order_item_id: string; component_variant_id: string; quantity_total: number; component_name_snapshot: string }>(
    'SELECT * FROM order_inventory_components WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)',
    [orderId]
  );
  const byItem = new Map<string, typeof comps>();
  for (const c of comps) {
    const arr = byItem.get(c.order_item_id) ?? [];
    arr.push(c);
    byItem.set(c.order_item_id, arr);
  }
  const payment = await ex().readOne<Payment>('SELECT * FROM payments WHERE order_id = ?', [orderId]);
  const refund = await ex().readOne<Refund>('SELECT * FROM refunds WHERE order_id = ?', [orderId]);
  const correctionRow = await ex().readOne<{ id: string; reason: string; created_at: string; payment_id: string | null }>(
    'SELECT id, reason, created_at, payment_id FROM order_corrections WHERE order_id = ?',
    [orderId]
  );
  let correction: OrderDetail['correction'] = null;
  if (correctionRow) {
    const returns = await ex().read<{ component_variant_id: string; quantity_returned: number }>(
      'SELECT component_variant_id, quantity_returned FROM correction_returns WHERE correction_id = ?',
      [correctionRow.id]
    );
    correction = { id: correctionRow.id, reason: correctionRow.reason, created_at: correctionRow.created_at, returns };
  }
  const transactions = await ex().read<OrderDetail['transactions'][number]>(
    'SELECT id, type, variant_id, delta_physical, delta_reserved, created_at FROM inventory_transactions WHERE order_id = ? ORDER BY created_at',
    [orderId]
  );
  return {
    order,
    items: items.map((i) => ({ ...i, components: byItem.get(i.id) ?? [] })),
    payment: payment ?? null,
    refund: refund ?? null,
    correction,
    transactions
  };
}

/* ------------------------------------------------------------ 游客菜单 */

export async function getKioskMenu(eventId: string): Promise<MenuItem[]> {
  const event = await getEvent(eventId);
  if (!event) return [];
  const rows = await ex().read<{
    variant_id: string;
    product_id: string;
    product_name: string;
    short_name: string | null;
    variant_name: string;
    sku: string | null;
    description: string | null;
    category_id: string | null;
    category_name: string | null;
    product_type: ProductType;
    event_price_minor: number | null;
    cover_asset_id: string | null;
    show_exact_stock: number;
    low_stock_threshold: number;
    purchase_limit: number | null;
    sort_order: number;
    physical_stock: number | null;
    reserved_stock: number | null;
  }>(
    `SELECT v.id AS variant_id, p.id AS product_id, p.name AS product_name, p.short_name,
            v.name AS variant_name, v.sku, p.description, p.category_id, cat.name AS category_name,
            p.type AS product_type, c.event_price_minor, p.cover_asset_id,
            c.show_exact_stock, c.low_stock_threshold, c.purchase_limit, c.sort_order,
            i.physical_stock, i.reserved_stock
     FROM event_variant_configs c
     JOIN product_variants v ON v.id = c.variant_id
     JOIN products p ON p.id = v.product_id
     LEFT JOIN categories cat ON cat.id = p.category_id
     LEFT JOIN inventory i ON i.event_id = c.event_id AND i.variant_id = c.variant_id
     WHERE c.event_id = ? AND c.enabled = 1 AND c.kiosk_visible = 1
       AND p.archived = 0 AND v.archived = 0
       AND COALESCE(cat.hidden, 0) = 0
     ORDER BY c.sort_order, p.name, v.name`,
    [eventId]
  );

  const bundleIds = rows.filter((r) => r.product_type === 'bundle').map((r) => r.variant_id);
  const bundleMap = await getBundleComponentsBatch(bundleIds);
  const componentIds = new Set<string>();
  for (const comps of bundleMap.values()) for (const c of comps) componentIds.add(c.component_variant_id);
  let availability = new Map<string, number>();
  if (componentIds.size) {
    const list = Array.from(componentIds);
    const inv = await ex().read<{ variant_id: string; physical_stock: number; reserved_stock: number }>(
      `SELECT variant_id, physical_stock, reserved_stock FROM inventory
       WHERE event_id = ? AND variant_id IN (${list.map(() => '?').join(',')})`,
      [eventId, ...list]
    );
    availability = new Map(inv.map((r) => [r.variant_id, r.physical_stock - r.reserved_stock]));
  }

  return rows.map((r) => {
    let available: number | null = null;
    if (r.product_type === 'bundle') {
      const comps = bundleMap.get(r.variant_id) ?? [];
      available = comps.length
        ? Math.min(...comps.map((c) => Math.floor((availability.get(c.component_variant_id) ?? 0) / c.quantity)))
        : 0;
    } else if (r.product_type === 'normal' || r.product_type === 'gift') {
      available = r.physical_stock === null ? 0 : r.physical_stock - (r.reserved_stock ?? 0);
    }
    return {
      variant_id: r.variant_id,
      product_id: r.product_id,
      product_name: r.product_name,
      short_name: r.short_name,
      variant_name: r.variant_name,
      sku: r.sku,
      description: r.description,
      category_id: r.category_id,
      category_name: r.category_name,
      product_type: r.product_type,
      price_minor: r.product_type === 'gift' ? 0 : Number(r.event_price_minor ?? 0),
      currency: event.currency,
      cover_asset_id: r.cover_asset_id,
      available_stock: available,
      display_stock: r.product_type !== 'non_stock',
      show_exact_stock: r.show_exact_stock,
      low_stock_threshold: r.low_stock_threshold,
      purchase_limit: r.purchase_limit,
      sort_order: r.sort_order
    };
  });
}
