/** 商品、分类、规格、套装与资源（第 7、8 节）。 */

import type { Step } from '../db/executor';
import type {
  Asset,
  BundleComponent,
  Category,
  Product,
  ProductType,
  ProductVariant
} from '../domain/types';
import { newId, nowIso } from '../domain/ids';
import { auditStep, ex } from './context';

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

/* ---------------------------------------------------------------- 分类 */

export function listCategories(includeHidden = true): Promise<Category[]> {
  const sql = includeHidden
    ? 'SELECT * FROM categories ORDER BY sort_order, name'
    : 'SELECT * FROM categories WHERE hidden = 0 ORDER BY sort_order, name';
  return ex().read<Category>(sql);
}

export async function createCategory(name: string): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new DomainError('分类名称不能为空');
  const dup = await ex().readOne('SELECT id FROM categories WHERE name = ?', [trimmed]);
  if (dup) throw new DomainError('已存在同名分类');
  const id = newId();
  const now = nowIso();
  await ex().tx([
    {
      t: 'run',
      sql: 'INSERT INTO categories (id, name, sort_order, hidden, created_at, updated_at) VALUES (?, ?, (SELECT COALESCE(MAX(sort_order),0)+1 FROM categories), 0, ?, ?)',
      params: [id, trimmed, now, now]
    }
  ]);
  return id;
}

export async function updateCategory(
  id: string,
  patch: { name?: string; sort_order?: number; hidden?: boolean }
): Promise<void> {
  const steps: Step[] = [];
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) throw new DomainError('分类名称不能为空');
    const dup = await ex().readOne('SELECT id FROM categories WHERE name = ? AND id <> ?', [trimmed, id]);
    if (dup) throw new DomainError('已存在同名分类');
    steps.push({ t: 'run', sql: 'UPDATE categories SET name = ?, updated_at = ? WHERE id = ?', params: [trimmed, nowIso(), id] });
  }
  if (patch.sort_order !== undefined) {
    steps.push({ t: 'run', sql: 'UPDATE categories SET sort_order = ?, updated_at = ? WHERE id = ?', params: [patch.sort_order, nowIso(), id] });
  }
  if (patch.hidden !== undefined) {
    steps.push({ t: 'run', sql: 'UPDATE categories SET hidden = ?, updated_at = ? WHERE id = ?', params: [patch.hidden ? 1 : 0, nowIso(), id] });
    steps.push(auditStep('category.hidden', 'category', id, { hidden: patch.hidden }));
  }
  if (steps.length) await ex().tx(steps);
}

export async function deleteCategory(id: string): Promise<void> {
  const used = await ex().readOne<{ c: number }>('SELECT COUNT(*) AS c FROM products WHERE category_id = ?', [id]);
  if (Number(used?.c ?? 0) > 0) {
    throw new DomainError('该分类下仍有商品，请先移动到其他分类');
  }
  await ex().tx([{ t: 'run', sql: 'DELETE FROM categories WHERE id = ?', params: [id], expectChanges: 1 }]);
}

/* ---------------------------------------------------------------- 商品 */

export interface ProductFilter {
  search?: string;
  categoryId?: string | null;
  archived?: boolean | null;
  type?: ProductType | null;
  eventId?: string | null;
  enabledInEvent?: boolean | null;
}

export interface ProductWithVariants extends Product {
  variants: ProductVariant[];
  category_name: string | null;
}

export async function listProducts(filter: ProductFilter = {}): Promise<ProductWithVariants[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.search) {
    where.push('(p.name LIKE ? OR p.short_name LIKE ? OR p.tags LIKE ? OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND (v.name LIKE ? OR v.sku LIKE ?)))');
    const like = `%${filter.search}%`;
    params.push(like, like, like, like, like);
  }
  if (filter.categoryId !== undefined && filter.categoryId !== null) {
    where.push('p.category_id = ?');
    params.push(filter.categoryId);
  }
  if (filter.archived !== undefined && filter.archived !== null) {
    where.push('p.archived = ?');
    params.push(filter.archived ? 1 : 0);
  }
  if (filter.type) {
    where.push('p.type = ?');
    params.push(filter.type);
  }
  if (filter.eventId && filter.enabledInEvent !== undefined && filter.enabledInEvent !== null) {
    if (filter.enabledInEvent) {
      where.push('EXISTS (SELECT 1 FROM event_variant_configs c JOIN product_variants v ON v.id = c.variant_id WHERE c.event_id = ? AND v.product_id = p.id AND c.enabled = 1)');
    } else {
      where.push('NOT EXISTS (SELECT 1 FROM event_variant_configs c JOIN product_variants v ON v.id = c.variant_id WHERE c.event_id = ? AND v.product_id = p.id AND c.enabled = 1)');
    }
    params.push(filter.eventId);
  }
  const sql = `SELECT p.*, c.name AS category_name
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY p.archived, p.name`;
  const products = await ex().read<ProductWithVariants>(sql, params);
  if (!products.length) return products;
  const ids = products.map((p) => p.id);
  const placeholders = ids.map(() => '?').join(',');
  const variants = await ex().read<ProductVariant>(
    `SELECT * FROM product_variants WHERE product_id IN (${placeholders}) ORDER BY sort_order, name`,
    ids
  );
  const byProduct = new Map<string, ProductVariant[]>();
  for (const v of variants) {
    const arr = byProduct.get(v.product_id) ?? [];
    arr.push(v);
    byProduct.set(v.product_id, arr);
  }
  for (const p of products) p.variants = byProduct.get(p.id) ?? [];
  return products;
}

export async function getProduct(id: string): Promise<ProductWithVariants | null> {
  const p = await ex().readOne<ProductWithVariants>(
    'SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?',
    [id]
  );
  if (!p) return null;
  p.variants = await ex().read<ProductVariant>(
    'SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, name',
    [id]
  );
  return p;
}

export interface ProductInput {
  name: string;
  short_name?: string | null;
  description?: string | null;
  category_id?: string | null;
  fandom?: string | null;
  tags?: string | null;
  type: ProductType;
  default_currency?: 'CNY' | 'JPY';
  default_price_minor?: number | null;
  optional_cost_minor?: number | null;
  cover_asset_id?: string | null;
  variantName?: string;
  sku?: string | null;
}

export async function createProduct(input: ProductInput): Promise<{ productId: string; variantId: string }> {
  const name = input.name.trim();
  if (!name) throw new DomainError('商品名称不能为空');
  const productId = newId();
  const variantId = newId();
  const now = nowIso();
  await ex().tx([
    {
      t: 'run',
      sql: `INSERT INTO products (id, name, short_name, description, category_id, fandom, tags, type,
            default_currency, default_price_minor, optional_cost_minor, cover_asset_id, archived, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      params: [
        productId,
        name,
        input.short_name?.trim() || null,
        input.description ?? null,
        input.category_id ?? null,
        input.fandom?.trim() || null,
        input.tags?.trim() || null,
        input.type,
        input.default_currency ?? 'CNY',
        input.default_price_minor ?? null,
        input.optional_cost_minor ?? null,
        input.cover_asset_id ?? null,
        now,
        now
      ]
    },
    {
      t: 'run',
      sql: 'INSERT INTO product_variants (id, product_id, name, sku, archived, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?)',
      params: [variantId, productId, (input.variantName ?? '默认规格').trim() || '默认规格', input.sku?.trim() || null, now, now]
    }
  ]);
  return { productId, variantId };
}

export async function updateProduct(
  id: string,
  patch: Partial<Omit<Product, 'id' | 'created_at' | 'updated_at'>> & { type?: ProductType }
): Promise<void> {
  const current = await ex().readOne<Product>('SELECT * FROM products WHERE id = ?', [id]);
  if (!current) throw new DomainError('商品不存在');
  if (patch.type && patch.type !== current.type) {
    const used = await variantHasOrders(id);
    if (used) {
      throw new DomainError('该商品已产生订单，不能直接变更库存语义类型，请新建商品');
    }
  }
  const fields: [string, unknown][] = [];
  const map: Record<string, string> = {
    name: 'name',
    short_name: 'short_name',
    description: 'description',
    category_id: 'category_id',
    fandom: 'fandom',
    tags: 'tags',
    type: 'type',
    default_currency: 'default_currency',
    default_price_minor: 'default_price_minor',
    optional_cost_minor: 'optional_cost_minor',
    cover_asset_id: 'cover_asset_id',
    archived: 'archived'
  };
  for (const [key, col] of Object.entries(map)) {
    const v = (patch as Record<string, unknown>)[key];
    if (v !== undefined) fields.push([col, typeof v === 'string' && key === 'name' ? (v as string).trim() : v]);
  }
  if (!fields.length) return;
  await ex().tx([
    {
      t: 'run',
      sql: `UPDATE products SET ${fields.map(([c]) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      params: [...fields.map(([, v]) => v as string | number | null), nowIso(), id]
    }
  ]);
}

export async function setProductArchived(id: string, archived: boolean): Promise<void> {
  await ex().tx([
    { t: 'run', sql: 'UPDATE products SET archived = ?, updated_at = ? WHERE id = ?', params: [archived ? 1 : 0, nowIso(), id] },
    auditStep(archived ? 'product.archive' : 'product.unarchive', 'product', id, { archived })
  ]);
}

async function variantHasOrders(productId: string): Promise<boolean> {
  const row = await ex().readOne<{ c: number }>(
    'SELECT COUNT(*) AS c FROM order_items WHERE product_id = ?',
    [productId]
  );
  return Number(row?.c ?? 0) > 0;
}

/* ---------------------------------------------------------------- 规格 */

export async function createVariant(productId: string, name: string, sku?: string | null): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new DomainError('规格名称不能为空');
  const id = newId();
  const now = nowIso();
  try {
    await ex().tx([
      {
        t: 'run',
        sql: `INSERT INTO product_variants (id, product_id, name, sku, archived, sort_order, created_at, updated_at)
              VALUES (?, ?, ?, ?, 0, (SELECT COALESCE(MAX(sort_order),0)+1 FROM product_variants WHERE product_id = ?), ?, ?)`,
        params: [id, productId, trimmed, sku?.trim() || null, productId, now, now]
      }
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('idx_variants_sku')) {
      throw new DomainError('SKU 在全库必须唯一，该 SKU 已被其他规格使用');
    }
    throw e;
  }
  return id;
}

export async function updateVariant(
  id: string,
  patch: { name?: string; sku?: string | null; archived?: boolean; sort_order?: number }
): Promise<void> {
  const steps: Step[] = [];
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) throw new DomainError('规格名称不能为空');
    steps.push({ t: 'run', sql: 'UPDATE product_variants SET name = ?, updated_at = ? WHERE id = ?', params: [trimmed, nowIso(), id] });
  }
  if (patch.sku !== undefined) {
    steps.push({ t: 'run', sql: 'UPDATE product_variants SET sku = ?, updated_at = ? WHERE id = ?', params: [patch.sku?.trim() || null, nowIso(), id] });
  }
  if (patch.archived !== undefined) {
    steps.push({ t: 'run', sql: 'UPDATE product_variants SET archived = ?, updated_at = ? WHERE id = ?', params: [patch.archived ? 1 : 0, nowIso(), id] });
  }
  if (patch.sort_order !== undefined) {
    steps.push({ t: 'run', sql: 'UPDATE product_variants SET sort_order = ?, updated_at = ? WHERE id = ?', params: [patch.sort_order, nowIso(), id] });
  }
  if (!steps.length) return;
  try {
    await ex().tx(steps);
  } catch (e) {
    if (String(e).includes('idx_variants_sku')) {
      throw new DomainError('SKU 在全库必须唯一，该 SKU 已被其他规格使用');
    }
    throw e;
  }
}

/* ---------------------------------------------------------------- 套装 */

export interface BundleComponentInput {
  component_variant_id: string;
  quantity: number;
}

/**
 * 设置套装成分。V1 套装仅包含 normal 类型 Variant，禁止嵌套与自引用。
 */
export async function setBundleComponents(
  bundleVariantId: string,
  components: BundleComponentInput[]
): Promise<void> {
  if (!components.length) throw new DomainError('套装至少需要一个成分');
  const seen = new Set<string>();
  for (const c of components) {
    if (!Number.isInteger(c.quantity) || c.quantity <= 0) throw new DomainError('成分数量必须为正整数');
    if (c.component_variant_id === bundleVariantId) throw new DomainError('套装不能包含自己');
    if (seen.has(c.component_variant_id)) throw new DomainError('同一成分请合并为一条');
    seen.add(c.component_variant_id);
  }
  const rows = await ex().read<{ id: string; type: ProductType }>(
    `SELECT v.id, p.type FROM product_variants v JOIN products p ON p.id = v.product_id
     WHERE v.id IN (${components.map(() => '?').join(',')})`,
    components.map((c) => c.component_variant_id)
  );
  if (rows.length !== components.length) throw new DomainError('存在不存在的规格');
  const bad = rows.filter((r) => r.type !== 'normal');
  if (bad.length) throw new DomainError('套装成分只能是普通库存商品');

  const steps: Step[] = [
    { t: 'run', sql: 'DELETE FROM bundle_components WHERE bundle_variant_id = ?', params: [bundleVariantId] }
  ];
  for (const c of components) {
    steps.push({
      t: 'run',
      sql: 'INSERT INTO bundle_components (bundle_variant_id, component_variant_id, quantity) VALUES (?, ?, ?)',
      params: [bundleVariantId, c.component_variant_id, c.quantity]
    });
  }
  await ex().tx(steps);
}

export function getBundleComponents(bundleVariantId: string): Promise<BundleComponent[]> {
  return ex().read<BundleComponent>(
    'SELECT * FROM bundle_components WHERE bundle_variant_id = ?',
    [bundleVariantId]
  );
}

/** 取一批套装的成分（一次查询，避免 N+1）。 */
export async function getBundleComponentsBatch(
  bundleVariantIds: string[]
): Promise<Map<string, BundleComponent[]>> {
  const map = new Map<string, BundleComponent[]>();
  if (!bundleVariantIds.length) return map;
  const rows = await ex().read<BundleComponent>(
    `SELECT * FROM bundle_components WHERE bundle_variant_id IN (${bundleVariantIds.map(() => '?').join(',')})`,
    bundleVariantIds
  );
  for (const r of rows) {
    const arr = map.get(r.bundle_variant_id) ?? [];
    arr.push(r);
    map.set(r.bundle_variant_id, arr);
  }
  return map;
}

/* ---------------------------------------------------------------- 资源 */

export async function createAsset(
  mimeType: string,
  width: number | null,
  height: number | null,
  bytes: Uint8Array,
  hash: string
): Promise<string> {
  const id = newId();
  await ex().tx([
    {
      t: 'run',
      sql: 'INSERT INTO assets (id, mime_type, width, height, blob, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      params: [id, mimeType, width, height, bytes, hash, nowIso()]
    }
  ]);
  return id;
}

export function getAsset(id: string): Promise<{ mime_type: string; blob: Uint8Array } | null> {
  return ex().readOne<{ mime_type: string; blob: Uint8Array }>(
    'SELECT mime_type, blob FROM assets WHERE id = ?',
    [id]
  );
}

export function listAssets(): Promise<Asset[]> {
  return ex().read<Asset>('SELECT id, mime_type, width, height, hash, created_at FROM assets');
}

/** 清理没有业务引用的资源。仍被引用的不能删除。 */
export async function deleteUnusedAssets(): Promise<number> {
  const rows = await ex().read<{ id: string }>(
    `SELECT a.id FROM assets a
     WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.cover_asset_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM payment_methods m WHERE m.qr_asset_id = a.id)`
  );
  for (const r of rows) {
    await ex().tx([{ t: 'run', sql: 'DELETE FROM assets WHERE id = ?', params: [r.id] }]);
  }
  return rows.length;
}
