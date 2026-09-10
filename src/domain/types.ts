/** 领域基础类型。与 3.3 / 第 5~20 节的数据模型对应。 */

export type Currency = 'CNY' | 'JPY';

/** 商品库存语义类型。参与订单后禁止变更。 */
export type ProductType = 'normal' | 'bundle' | 'gift' | 'non_stock';

export type EventStatus = 'draft' | 'active' | 'closed';

export type OrderStatus = 'pending_payment' | 'completed' | 'voided' | 'refunded' | 'corrected';

export type PaymentMethodType = 'cash' | 'qr_payment' | 'other';

export type OrderSource = 'kiosk' | 'staff';

export type InventoryTxType =
  | 'initial'
  | 'reservation'
  | 'reservation_release'
  | 'sale'
  | 'refund_return'
  | 'correction_return'
  | 'restock'
  | 'correction'
  | 'damaged'
  | 'gift'
  | 'personal'
  | 'lost'
  | 'other';

export type CashMovementType = 'opening' | 'deposit' | 'withdrawal';

export interface Category {
  id: string;
  name: string;
  sort_order: number;
  hidden: number;
  created_at: string;
  updated_at: string;
}

export interface Product {
  id: string;
  name: string;
  short_name: string | null;
  description: string | null;
  category_id: string | null;
  fandom: string | null;
  tags: string | null;
  type: ProductType;
  default_currency: Currency;
  default_price_minor: number | null;
  optional_cost_minor: number | null;
  cover_asset_id: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
}

export interface ProductVariant {
  id: string;
  product_id: string;
  name: string;
  sku: string | null;
  archived: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface BundleComponent {
  bundle_variant_id: string;
  component_variant_id: string;
  quantity: number;
}

export interface Asset {
  id: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  hash: string;
  created_at: string;
}

export interface Event {
  id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  timezone: string;
  booth_number: string | null;
  currency: Currency;
  status: EventStatus;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventVariantConfig {
  event_id: string;
  variant_id: string;
  enabled: number;
  /** 未设置价格为 NULL；启用参展前必须填写（允许 0）。 */
  event_price_minor: number | null;
  sort_order: number;
  purchase_limit: number | null;
  show_exact_stock: number;
  low_stock_threshold: number;
  kiosk_visible: number;
}

export interface InventoryRow {
  event_id: string;
  variant_id: string;
  initial_stock: number;
  physical_stock: number;
  reserved_stock: number;
}

export interface InventoryTransaction {
  id: string;
  event_id: string;
  variant_id: string;
  delta_physical: number;
  delta_reserved: number;
  type: InventoryTxType;
  order_id: string | null;
  operation_id: string;
  reason: string | null;
  note: string | null;
  created_at: string;
}

export interface PaymentMethod {
  id: string;
  name: string;
  type: PaymentMethodType;
  qr_asset_id: string | null;
  enabled: number;
  sort_order: number;
  instruction: string | null;
  created_at: string;
}

export interface Order {
  id: string;
  human_readable_number: number;
  event_id: string;
  status: OrderStatus;
  currency: Currency;
  subtotal_minor: number;
  total_minor: number;
  planned_payment_method_id: string | null;
  planned_method_name_snapshot: string | null;
  planned_method_type_snapshot: PaymentMethodType | null;
  planned_instruction_snapshot: string | null;
  planned_qr_asset_id: string | null;
  source: OrderSource;
  created_at: string;
  completed_at: string | null;
  voided_at: string | null;
  refunded_at: string | null;
  corrected_at: string | null;
  note: string | null;
  operation_id: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  variant_id: string;
  product_name_snapshot: string;
  variant_name_snapshot: string;
  sku_snapshot: string | null;
  product_type_snapshot: ProductType;
  unit_price_minor: number;
  quantity: number;
  subtotal_minor: number;
}

export interface OrderInventoryComponent {
  id: string;
  order_item_id: string;
  component_variant_id: string;
  quantity_total: number;
  component_name_snapshot: string;
  sku_snapshot: string | null;
}

export interface Payment {
  id: string;
  order_id: string;
  amount_minor: number;
  currency: Currency;
  payment_method_id: string;
  method_name_snapshot: string;
  method_type_snapshot: PaymentMethodType;
  confirmed_at: string;
  tendered_minor: number | null;
  change_minor: number | null;
  operation_id: string;
}

export interface Refund {
  id: string;
  order_id: string;
  payment_id: string | null;
  amount_minor: number;
  currency: Currency;
  payment_method_id: string | null;
  method_name_snapshot: string;
  method_type_snapshot: PaymentMethodType | null;
  confirmed_at: string;
  reason: string | null;
  operation_id: string;
}

export interface OrderCorrection {
  id: string;
  order_id: string;
  payment_id: string | null;
  reason: string;
  created_at: string;
  operation_id: string;
}

export interface CashMovement {
  id: string;
  event_id: string;
  type: CashMovementType;
  amount_minor: number;
  reason: string | null;
  created_at: string;
  operation_id: string;
}

export interface Settlement {
  id: string;
  event_id: string;
  settled_at: string;
  expected_cash_minor: number;
  actual_cash_minor: number;
  difference_minor: number;
  summary_json: string;
  note: string | null;
  superseded: number;
  created_at: string;
}

/** 菜单展示用的一行商品（含本场价格与库存状态）。 */
export interface MenuItem {
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
  price_minor: number;
  currency: Currency;
  cover_asset_id: string | null;
  available_stock: number | null;
  display_stock: boolean;
  show_exact_stock: number;
  low_stock_threshold: number;
  purchase_limit: number | null;
  sort_order: number;
}

export type StockLabel = '有货' | '少量' | '售罄' | '不限';

export function stockLabel(item: Pick<MenuItem, 'product_type' | 'available_stock' | 'low_stock_threshold'>): StockLabel {
  if (item.product_type === 'non_stock') return '不限';
  const n = item.available_stock ?? 0;
  if (n <= 0) return '售罄';
  if (n <= item.low_stock_threshold) return '少量';
  return '有货';
}
