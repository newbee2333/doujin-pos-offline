/** 数据库 DDL 与有序迁移。schema_version 独立于应用版本（第 5 节）。 */

export const APPLICATION_ID = 0x444f554a; // 'DOUJ'
export const SCHEMA_VERSION = 1;
export const APP_VERSION = '0.1.0';

/** 首次建库执行的建表语句，按顺序执行。 */
export const INITIAL_SCHEMA: string[] = [
  `CREATE TABLE metadata (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `CREATE TABLE categories (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    hidden     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX idx_categories_name ON categories(name)`,

  `CREATE TABLE assets (
    id         TEXT PRIMARY KEY,
    mime_type  TEXT NOT NULL,
    width      INTEGER,
    height     INTEGER,
    blob       BLOB NOT NULL,
    hash       TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE products (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    short_name          TEXT,
    description         TEXT,
    category_id         TEXT REFERENCES categories(id),
    fandom              TEXT,
    tags                TEXT,
    type                TEXT NOT NULL CHECK (type IN ('normal','bundle','gift','non_stock')),
    default_currency    TEXT NOT NULL DEFAULT 'CNY' CHECK (default_currency IN ('CNY','JPY')),
    default_price_minor INTEGER,
    optional_cost_minor INTEGER,
    cover_asset_id      TEXT REFERENCES assets(id),
    archived            INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  )`,
  `CREATE INDEX idx_products_category ON products(category_id)`,
  `CREATE INDEX idx_products_archived ON products(archived)`,

  `CREATE TABLE product_variants (
    id         TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id),
    name       TEXT NOT NULL,
    sku        TEXT,
    archived   INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX idx_variants_product ON product_variants(product_id)`,
  // 非空 SKU 全库唯一
  `CREATE UNIQUE INDEX idx_variants_sku_unique
     ON product_variants(sku) WHERE sku IS NOT NULL AND sku <> ''`,

  `CREATE TABLE bundle_components (
    bundle_variant_id    TEXT NOT NULL REFERENCES product_variants(id),
    component_variant_id TEXT NOT NULL REFERENCES product_variants(id),
    quantity             INTEGER NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (bundle_variant_id, component_variant_id),
    CHECK (bundle_variant_id <> component_variant_id)
  )`,

  `CREATE TABLE events (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    start_date   TEXT,
    end_date     TEXT,
    timezone     TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    booth_number TEXT,
    currency     TEXT NOT NULL CHECK (currency IN ('CNY','JPY')),
    status       TEXT NOT NULL CHECK (status IN ('draft','active','closed')),
    note         TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  )`,
  // 同一数据库最多一个 active 展会
  `CREATE UNIQUE INDEX idx_single_active_event ON events(status) WHERE status = 'active'`,

  `CREATE TABLE event_variant_configs (
    event_id           TEXT NOT NULL REFERENCES events(id),
    variant_id         TEXT NOT NULL REFERENCES product_variants(id),
    enabled            INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    event_price_minor  INTEGER CHECK (event_price_minor IS NULL OR event_price_minor >= 0),
    sort_order         INTEGER NOT NULL DEFAULT 0,
    purchase_limit     INTEGER CHECK (purchase_limit IS NULL OR purchase_limit > 0),
    show_exact_stock   INTEGER NOT NULL DEFAULT 0 CHECK (show_exact_stock IN (0,1)),
    low_stock_threshold INTEGER NOT NULL DEFAULT 3 CHECK (low_stock_threshold >= 0),
    kiosk_visible      INTEGER NOT NULL DEFAULT 1 CHECK (kiosk_visible IN (0,1)),
    PRIMARY KEY (event_id, variant_id)
  )`,

  `CREATE TABLE inventory (
    event_id       TEXT NOT NULL REFERENCES events(id),
    variant_id     TEXT NOT NULL REFERENCES product_variants(id),
    initial_stock  INTEGER NOT NULL DEFAULT 0,
    physical_stock INTEGER NOT NULL DEFAULT 0,
    reserved_stock INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (event_id, variant_id),
    CHECK (physical_stock >= reserved_stock),
    CHECK (reserved_stock >= 0)
  )`,

  `CREATE TABLE inventory_transactions (
    id             TEXT PRIMARY KEY,
    event_id       TEXT NOT NULL REFERENCES events(id),
    variant_id     TEXT NOT NULL REFERENCES product_variants(id),
    delta_physical INTEGER NOT NULL DEFAULT 0,
    delta_reserved INTEGER NOT NULL DEFAULT 0,
    type           TEXT NOT NULL CHECK (type IN ('initial','reservation','reservation_release','sale','refund_return','correction_return','restock','correction','damaged','gift','personal','lost','other')),
    order_id       TEXT,
    operation_id   TEXT NOT NULL,
    reason         TEXT,
    note           TEXT,
    created_at     TEXT NOT NULL
  )`,
  `CREATE INDEX idx_inv_tx_event ON inventory_transactions(event_id, created_at)`,
  `CREATE INDEX idx_inv_tx_variant ON inventory_transactions(variant_id)`,

  `CREATE TABLE payment_methods (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('cash','qr_payment','other')),
    qr_asset_id TEXT REFERENCES assets(id),
    enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    sort_order  INTEGER NOT NULL DEFAULT 0,
    instruction TEXT,
    created_at  TEXT NOT NULL
  )`,

  `CREATE TABLE event_payment_methods (
    event_id          TEXT NOT NULL REFERENCES events(id),
    payment_method_id TEXT NOT NULL REFERENCES payment_methods(id),
    enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    sort_order        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (event_id, payment_method_id)
  )`,

  `CREATE TABLE orders (
    id                            TEXT PRIMARY KEY,
    human_readable_number         INTEGER NOT NULL,
    event_id                      TEXT NOT NULL REFERENCES events(id),
    status                        TEXT NOT NULL CHECK (status IN ('pending_payment','completed','voided','refunded','corrected')),
    currency                      TEXT NOT NULL CHECK (currency IN ('CNY','JPY')),
    subtotal_minor                INTEGER NOT NULL CHECK (subtotal_minor >= 0),
    total_minor                   INTEGER NOT NULL CHECK (total_minor >= 0),
    planned_payment_method_id     TEXT,
    planned_method_name_snapshot  TEXT,
    planned_method_type_snapshot  TEXT,
    planned_instruction_snapshot  TEXT,
    planned_qr_asset_id           TEXT,
    source                        TEXT NOT NULL CHECK (source IN ('kiosk','staff')),
    created_at                    TEXT NOT NULL,
    completed_at                  TEXT,
    voided_at                     TEXT,
    refunded_at                   TEXT,
    corrected_at                  TEXT,
    note                          TEXT,
    operation_id                  TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX idx_orders_number ON orders(event_id, human_readable_number)`,
  `CREATE INDEX idx_orders_event_status ON orders(event_id, status)`,

  `CREATE TABLE order_items (
    id                     TEXT PRIMARY KEY,
    order_id               TEXT NOT NULL REFERENCES orders(id),
    product_id             TEXT NOT NULL,
    variant_id             TEXT NOT NULL,
    product_name_snapshot  TEXT NOT NULL,
    variant_name_snapshot  TEXT NOT NULL,
    sku_snapshot           TEXT,
    product_type_snapshot  TEXT NOT NULL,
    unit_price_minor       INTEGER NOT NULL CHECK (unit_price_minor >= 0),
    quantity               INTEGER NOT NULL CHECK (quantity > 0),
    subtotal_minor         INTEGER NOT NULL CHECK (subtotal_minor >= 0)
  )`,
  `CREATE INDEX idx_order_items_order ON order_items(order_id)`,

  `CREATE TABLE order_inventory_components (
    id                      TEXT PRIMARY KEY,
    order_item_id           TEXT NOT NULL REFERENCES order_items(id),
    component_variant_id    TEXT NOT NULL,
    quantity_total          INTEGER NOT NULL CHECK (quantity_total >= 0),
    component_name_snapshot TEXT NOT NULL,
    sku_snapshot            TEXT
  )`,
  `CREATE INDEX idx_oic_item ON order_inventory_components(order_item_id)`,

  `CREATE TABLE payments (
    id                    TEXT PRIMARY KEY,
    order_id              TEXT NOT NULL REFERENCES orders(id),
    amount_minor          INTEGER NOT NULL CHECK (amount_minor > 0),
    currency              TEXT NOT NULL,
    payment_method_id     TEXT NOT NULL,
    method_name_snapshot  TEXT NOT NULL,
    method_type_snapshot  TEXT NOT NULL,
    confirmed_at          TEXT NOT NULL,
    tendered_minor        INTEGER,
    change_minor          INTEGER,
    operation_id          TEXT NOT NULL
  )`,
  `CREATE INDEX idx_payments_order ON payments(order_id)`,

  `CREATE TABLE refunds (
    id                   TEXT PRIMARY KEY,
    order_id             TEXT NOT NULL REFERENCES orders(id),
    payment_id           TEXT,
    amount_minor         INTEGER NOT NULL CHECK (amount_minor >= 0),
    currency             TEXT NOT NULL,
    payment_method_id    TEXT,
    method_name_snapshot TEXT NOT NULL,
    method_type_snapshot TEXT,
    confirmed_at         TEXT NOT NULL,
    reason               TEXT,
    operation_id         TEXT NOT NULL
  )`,
  // 一单最多一次整单退款
  `CREATE UNIQUE INDEX idx_refunds_order ON refunds(order_id)`,

  `CREATE TABLE refund_returns (
    id                   TEXT PRIMARY KEY,
    refund_id            TEXT NOT NULL REFERENCES refunds(id),
    component_variant_id TEXT NOT NULL,
    quantity_returned    INTEGER NOT NULL CHECK (quantity_returned >= 0)
  )`,

  `CREATE TABLE order_corrections (
    id           TEXT PRIMARY KEY,
    order_id     TEXT NOT NULL REFERENCES orders(id),
    payment_id   TEXT,
    reason       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    operation_id TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX idx_corrections_order ON order_corrections(order_id)`,

  `CREATE TABLE correction_returns (
    id                   TEXT PRIMARY KEY,
    correction_id        TEXT NOT NULL REFERENCES order_corrections(id),
    component_variant_id TEXT NOT NULL,
    quantity_returned    INTEGER NOT NULL CHECK (quantity_returned >= 0)
  )`,

  `CREATE TABLE cash_movements (
    id           TEXT PRIMARY KEY,
    event_id     TEXT NOT NULL REFERENCES events(id),
    type         TEXT NOT NULL CHECK (type IN ('opening','deposit','withdrawal')),
    amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
    reason       TEXT,
    created_at   TEXT NOT NULL,
    operation_id TEXT NOT NULL
  )`,
  `CREATE INDEX idx_cash_event ON cash_movements(event_id)`,

  `CREATE TABLE settlements (
    id                  TEXT PRIMARY KEY,
    event_id            TEXT NOT NULL REFERENCES events(id),
    settled_at          TEXT NOT NULL,
    expected_cash_minor INTEGER NOT NULL,
    actual_cash_minor   INTEGER NOT NULL,
    difference_minor    INTEGER NOT NULL,
    summary_json        TEXT NOT NULL,
    note                TEXT,
    superseded          INTEGER NOT NULL DEFAULT 0 CHECK (superseded IN (0,1)),
    created_at          TEXT NOT NULL
  )`,
  `CREATE INDEX idx_settlements_event ON settlements(event_id)`,

  `CREATE TABLE idempotency_records (
    operation_id TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result_json  TEXT NOT NULL,
    created_at   TEXT NOT NULL
  )`,

  `CREATE TABLE audit_log (
    id         TEXT PRIMARY KEY,
    at         TEXT NOT NULL,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    entity     TEXT,
    entity_id  TEXT,
    detail_json TEXT
  )`,
  `CREATE INDEX idx_audit_at ON audit_log(at)`,

  `CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`
];

export interface Migration {
  fromVersion: number;
  toVersion: number;
  sql: string[];
}

/**
 * 判断候选库的 schema 版本能否被当前应用接受（第 22 节）。
 * 未来版本一律拒绝，不尝试降级，也不删库。
 */
export function checkSchemaSupport(version: number): { ok: boolean; reason?: string } {
  if (!Number.isFinite(version) || version <= 0) {
    return { ok: false, reason: '缺少有效的 schema 版本信息' };
  }
  if (version > SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `该数据库由更高版本应用生成（schema ${version} > ${SCHEMA_VERSION}），请更新应用后再导入`
    };
  }
  return { ok: true };
}

/** 有序迁移。V1 首次 schema 为 1，不人为制造无意义生产 schema。 */
export const MIGRATIONS: Migration[] = [];

export const DEFAULT_CATEGORIES = [
  '新刊',
  '既刊',
  '亚克力',
  '徽章',
  '色纸',
  '套装',
  '无料',
  '其他'
];

export const DEFAULT_PAYMENT_METHODS: { name: string; type: 'cash' | 'qr_payment' | 'other' }[] = [
  { name: '现金', type: 'cash' },
  { name: '微信支付', type: 'qr_payment' },
  { name: '支付宝', type: 'qr_payment' },
  { name: 'PayPay', type: 'qr_payment' },
  { name: '其他', type: 'other' }
];
