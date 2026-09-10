import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createProduct,
  createVariant,
  deleteUnusedAssets,
  getBundleComponents,
  listCategories,
  listProducts,
  setBundleComponents,
  setProductArchived,
  updateProduct,
  updateVariant
} from '../../services/catalog';
import { prepareProductImage, hashBytes, type PreparedAsset } from '../../domain/image';
import { createAsset } from '../../services/catalog';
import { formatMoney } from '../../domain/money';
import { errorMessage, useApp } from '../../store';
import AssetEditor from '../AssetEditor';
import { ErrorBox, Field, Modal, Spinner, useAsync } from '../components';
import type { Category, Currency, ProductType } from '../../domain/types';
import type { ProductWithVariants } from '../../services/catalog';

const TYPE_LABEL: Record<ProductType, string> = {
  normal: '普通库存',
  bundle: '虚拟套装',
  gift: '赠品',
  non_stock: '不计库存'
};

export default function StaffProductsPage() {
  const showToast = useApp((s) => s.showToast);
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<ProductWithVariants | null>(null);
  const [creating, setCreating] = useState(false);

  const products = useAsync(() => listProducts({ search, categoryId: categoryId || null, archived: showArchived ? null : false }), [
    search,
    categoryId,
    showArchived
  ]);
  const cats = useAsync(() => listCategories(true), []);

  if (products.loading && !products.data) {
    return (
      <div className="center-page">
        <Spinner label="读取商品…" />
      </div>
    );
  }

  return (
    <div className="content">
      <div className="row">
        <h1 style={{ margin: 0 }}>商品管理</h1>
        <span className="spacer" />
        <button onClick={() => void deleteUnusedAssets().then((n) => showToast(`已回收 ${n} 个未使用资源`))}>
          回收未使用图片
        </button>
        <button onClick={() => navigate('/preview')} title="不锁定后台，可切换屏幕尺寸">
          预览菜单效果
        </button>
        <button className="primary" onClick={() => setCreating(true)}>
          新增商品
        </button>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="row">
          <input
            type="search"
            placeholder="搜索名称 / SKU / 标签"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 280 }}
          />
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} style={{ maxWidth: 200 }}>
            <option value="">全部分类</option>
            {cats.data?.map((c: Category) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.hidden ? '（隐藏）' : ''}
              </option>
            ))}
          </select>
          <label className="check">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            显示已归档
          </label>
        </div>

        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th>商品</th>
                <th>分类</th>
                <th>类型</th>
                <th className="num">默认价格</th>
                <th>规格</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {products.data?.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.name}
                    {p.archived ? <span className="badge" style={{ marginLeft: 6 }}>已归档</span> : null}
                    {p.short_name ? <div className="tiny muted">{p.short_name}</div> : null}
                  </td>
                  <td>{p.category_name ?? '—'}</td>
                  <td>{TYPE_LABEL[p.type]}</td>
                  <td className="num nowrap">
                    {p.default_price_minor === null
                      ? '—'
                      : formatMoney(p.default_price_minor, p.default_currency)}
                  </td>
                  <td className="small">
                    {p.variants.map((v) => v.name).join('、') || '—'}
                  </td>
                  <td className="nowrap">
                    <button className="small" onClick={() => setEditing(p)}>
                      编辑
                    </button>
                    <button
                      className="small"
                      onClick={async () => {
                        try {
                          await setProductArchived(p.id, !p.archived);
                          products.reload();
                        } catch (e) {
                          showToast(errorMessage(e));
                        }
                      }}
                    >
                      {p.archived ? '取消归档' : '归档'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {creating ? (
        <CreateProductModal
          categories={cats.data ?? []}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            products.reload();
          }}
        />
      ) : null}

      {editing ? (
        <EditProductModal
          product={editing}
          categories={cats.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            products.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function CreateProductModal({
  categories,
  onClose,
  onCreated
}: {
  categories: Category[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<ProductType>('normal');
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState<Currency>('CNY');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title="新增商品"
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                let priceMinor: number | null = null;
                if (price.trim()) {
                  const n = Number(price);
                  priceMinor = currency === 'CNY' ? Math.round(n * 100) : Math.round(n);
                }
                await createProduct({
                  name,
                  type,
                  category_id: categoryId || null,
                  default_currency: currency,
                  default_price_minor: priceMinor
                });
                onCreated();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            创建
          </button>
        </>
      }
    >
      <div className="col">
        <Field label="商品名称">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid cols-2">
          <Field label="类型">
            <select value={type} onChange={(e) => setType(e.target.value as ProductType)}>
              {Object.entries(TYPE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="分类">
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="默认价格（仅作填表参考）">
            <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
          </Field>
          <Field label="币种">
            <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
              <option value="CNY">人民币 / CNY</option>
              <option value="JPY">日元 / JPY</option>
            </select>
          </Field>
        </div>
        <div className="small muted">创建后会自动生成「默认规格」。本场价格需要在展会配置里单独填写。</div>
        <ErrorBox message={error} />
      </div>
    </Modal>
  );
}

function EditProductModal({
  product,
  categories,
  onClose,
  onSaved
}: {
  product: ProductWithVariants;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const showToast = useApp((s) => s.showToast);
  const [form, setForm] = useState({
    name: product.name,
    short_name: product.short_name ?? '',
    description: product.description ?? '',
    category_id: product.category_id ?? '',
    fandom: product.fandom ?? '',
    tags: product.tags ?? '',
    type: product.type,
    default_price: product.default_price_minor === null ? '' : String(product.default_price_minor / 100),
    default_currency: product.default_currency
  });
  const [coverId, setCoverId] = useState<string | null>(product.cover_asset_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newVariant, setNewVariant] = useState('');
  const [bundleComps, setBundleComps] = useState<{ component_variant_id: string; quantity: number }[] | null>(null);
  const allProducts = useAsync(() => listProducts({ archived: null }), []);

  const normalVariants = useMemo(
    () => (allProducts.data ?? []).flatMap((p) => (p.type === 'normal' ? p.variants.map((v) => ({ ...v, pname: p.name })) : [])),
    [allProducts.data]
  );

  async function loadBundle() {
    if (product.type !== 'bundle') return;
    const first = product.variants[0];
    if (!first) return;
    const rows = await getBundleComponents(first.id);
    setBundleComps(rows.map((r) => ({ component_variant_id: r.component_variant_id, quantity: r.quantity })));
  }
  if (product.type === 'bundle' && bundleComps === null) void loadBundle();

  async function onCover(file: File) {
    setBusy(true);
    setError(null);
    try {
      const prepared: PreparedAsset = await prepareProductImage(file);
      const id = await createAsset(
        prepared.mimeType,
        prepared.width,
        prepared.height,
        prepared.bytes,
        await hashBytes(prepared.bytes)
      );
      setCoverId(id);
      if (prepared.note) showToast(prepared.note);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`编辑：${product.name}`}
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await updateProduct(product.id, {
                  name: form.name,
                  short_name: form.short_name || null,
                  description: form.description || null,
                  category_id: form.category_id || null,
                  fandom: form.fandom || null,
                  tags: form.tags || null,
                  type: form.type,
                  default_currency: form.default_currency,
                  default_price_minor: form.default_price.trim() ? Math.round(Number(form.default_price) * 100) : null,
                  cover_asset_id: coverId
                });
                if (product.type === 'bundle' && bundleComps && product.variants[0]) {
                  await setBundleComponents(product.variants[0].id, bundleComps);
                }
                onSaved();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            保存
          </button>
        </>
      }
    >
      <div className="col">
        <div className="grid cols-2">
          <Field label="名称">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="简称">
            <input value={form.short_name} onChange={(e) => setForm({ ...form, short_name: e.target.value })} />
          </Field>
          <Field label="分类">
            <select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
              <option value="">未分类</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="类型">
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ProductType })}>
              {Object.entries(TYPE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="原作 / 圈子">
            <input value={form.fandom} onChange={(e) => setForm({ ...form, fandom: e.target.value })} />
          </Field>
          <Field label="标签（逗号分隔）">
            <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
          </Field>
          <Field label="默认价格">
            <input value={form.default_price} onChange={(e) => setForm({ ...form, default_price: e.target.value })} />
          </Field>
          <Field label="币种">
            <select
              value={form.default_currency}
              onChange={(e) => setForm({ ...form, default_currency: e.target.value as Currency })}
            >
              <option value="CNY">人民币 / CNY</option>
              <option value="JPY">日元 / JPY</option>
            </select>
          </Field>
        </div>

        <Field label="说明（纯文本展示）">
          <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>

        <AssetEditor
          label="封面图（自动压缩到最大边 1600px）"
          assetId={coverId}
          onChange={setCoverId}
          onPick={onCover}
        />

        <div>
          <h3>规格</h3>
          {product.variants.map((v) => (
            <div key={v.id} className="row tight">
              <input
                value={v.name}
                onChange={(e) => {
                  const name = e.target.value;
                  void updateVariant(v.id, { name });
                }}
                style={{ maxWidth: 180 }}
              />
              <input
                value={v.sku ?? ''}
                placeholder="SKU（全库唯一）"
                onChange={(e) => {
                  const sku = e.target.value;
                  void updateVariant(v.id, { sku: sku || null }).catch((err) => showToast(errorMessage(err)));
                }}
                style={{ maxWidth: 200 }}
              />
            </div>
          ))}
          <div className="row tight" style={{ marginTop: 6 }}>
            <input
              value={newVariant}
              placeholder="新增规格名"
              onChange={(e) => setNewVariant(e.target.value)}
              style={{ maxWidth: 180 }}
            />
            <button
              className="small"
              onClick={async () => {
                if (!newVariant.trim()) return;
                try {
                  await createVariant(product.id, newVariant);
                  setNewVariant('');
                  showToast('已新增规格，请刷新列表');
                } catch (e) {
                  showToast(errorMessage(e));
                }
              }}
            >
              添加规格
            </button>
          </div>
        </div>

        {product.type === 'bundle' ? (
          <div>
            <h3>套装成分</h3>
            <p className="tiny muted">套装只消耗成分的库存，自身不持有库存。成分只能是普通库存商品。</p>
            {(bundleComps ?? []).map((c, i) => (
              <div key={i} className="row tight">
                <select
                  value={c.component_variant_id}
                  onChange={(e) =>
                    setBundleComps(
                      (bundleComps ?? []).map((x, j) =>
                        j === i ? { ...x, component_variant_id: e.target.value } : x
                      )
                    )
                  }
                >
                  {normalVariants.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.pname}（{v.name}）
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min={1}
                  value={c.quantity}
                  onChange={(e) =>
                    setBundleComps(
                      (bundleComps ?? []).map((x, j) =>
                        j === i ? { ...x, quantity: Math.max(1, Number(e.target.value)) } : x
                      )
                    )
                  }
                  style={{ maxWidth: 90 }}
                />
                <button
                  className="small"
                  onClick={() => setBundleComps((bundleComps ?? []).filter((_, j) => j !== i))}
                >
                  移除
                </button>
              </div>
            ))}
            <button
              className="small"
              onClick={() =>
                setBundleComps([
                  ...(bundleComps ?? []),
                  { component_variant_id: normalVariants[0]?.id ?? '', quantity: 1 }
                ])
              }
            >
              添加成分
            </button>
          </div>
        ) : null}

        <ErrorBox message={error} />
      </div>
    </Modal>
  );
}
