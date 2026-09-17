/**
 * 商品编辑器：新增和编辑共用同一套字段与同一套版式。
 *
 * 以前这里是三套：商品页的「新增商品」只有 5 个字段、展会页的「现场新建」只有 4 个、
 * 只有「编辑商品」是完整的。后果是新建完必须再点一次「编辑」才能把封面、说明、
 * 原作圈子填上——同一个对象两套心智模型，而且新建那套永远落后于编辑那套。
 * 现在统一到这里。`mode` 只决定三件事：标题、保存时调 create 还是 update、
 * 以及套装成分能不能配（成分指向别的规格，必须先有 variant id）。
 *
 * 规格部分：一件商品只有一个「默认规格」，名称由系统生成、不可改，
 * 也不再提供「新增规格」——那个入口在现场没有对应动作，只会让人以为要点。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  createAsset,
  createProduct,
  getBundleComponents,
  listProducts,
  setBundleComponents,
  updateProduct,
  updateVariant
} from '../services/catalog';
import { hashBytes, prepareProductImage, type PreparedAsset } from '../domain/image';
import { minorToInput } from '../domain/money';
import { errorMessage, useApp } from '../store';
import AssetEditor from './AssetEditor';
import { ErrorBox, Field, Modal, useAsync } from './components';
import type { Category, Currency, ProductType } from '../domain/types';
import type { ProductWithVariants } from '../services/catalog';

/** 类型中文名。只有这一份，商品页也从这里取——两边各留一份迟早改漏 */
export const TYPE_LABEL: Record<ProductType, string> = {
  normal: '普通库存',
  bundle: '虚拟套装',
  gift: '赠品',
  non_stock: '不计库存'
};

/** 系统生成的规格名。不允许改，也不允许再新增别的规格。 */
const DEFAULT_VARIANT = '默认规格';

interface VariantDraft {
  id: string;
  name: string;
  sku: string;
}

export function ProductEditorModal({
  mode,
  product,
  categories,
  defaultCurrency = 'CNY',
  onClose,
  onSaved
}: {
  mode: 'create' | 'edit';
  /** edit 模式必传 */
  product?: ProductWithVariants;
  categories: Category[];
  /** create 模式的初始币种（跟当前展会走） */
  defaultCurrency?: Currency;
  onClose: () => void;
  /**
   * create 模式回传新建的 productId 与默认规格的 variantId——
   * 展会页要拿 variantId 把商品顺手加进本场，不该让调用方再查一次库。
   * edit 模式只给 productId。
   */
  onSaved: (saved: { productId: string; variantId?: string }) => void;
}) {
  const showToast = useApp((s) => s.showToast);
  const editing = mode === 'edit' && !!product;

  const [form, setForm] = useState(() => ({
    name: product?.name ?? '',
    short_name: product?.short_name ?? '',
    description: product?.description ?? '',
    category_id: product?.category_id ?? categories[0]?.id ?? '',
    fandom: product?.fandom ?? '',
    tags: product?.tags ?? '',
    type: product?.type ?? ('normal' as ProductType),
    // 用 minorToInput 而不是 /100：日元没有小数位，除以 100 会把它显示错
    default_price:
      product && product.default_price_minor !== null
        ? minorToInput(product.default_price_minor, product.default_currency)
        : '',
    default_currency: product?.default_currency ?? defaultCurrency
  }));

  const [variants, setVariants] = useState<VariantDraft[]>(() =>
    product && product.variants.length
      ? product.variants.map((v) => ({ id: v.id, name: v.name, sku: v.sku ?? '' }))
      : [{ id: 'new', name: DEFAULT_VARIANT, sku: '' }]
  );

  const [coverId, setCoverId] = useState<string | null>(product?.cover_asset_id ?? null);
  const [bundleComps, setBundleComps] = useState<{ component_variant_id: string; quantity: number }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isBundleEdit = editing && form.type === 'bundle';

  // 套装成分的下拉只列「普通库存」商品的规格；不是套装就不用拉
  const bundleSource = useAsync(
    () => (isBundleEdit ? listProducts({ archived: null }) : Promise.resolve([])),
    [isBundleEdit]
  );
  const normalVariants = useMemo(
    () =>
      (bundleSource.data ?? []).flatMap((p) =>
        p.type === 'normal' ? p.variants.map((v) => ({ ...v, pname: p.name })) : []
      ),
    [bundleSource.data]
  );

  // 打开编辑套装时读一次现有成分
  const firstVariantId = product?.variants[0]?.id ?? null;
  useEffect(() => {
    if (!isBundleEdit || !firstVariantId) return;
    let cancelled = false;
    void getBundleComponents(firstVariantId).then((rows) => {
      if (!cancelled) {
        setBundleComps(rows.map((r) => ({ component_variant_id: r.component_variant_id, quantity: r.quantity })));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isBundleEdit, firstVariantId]);

  function parsePrice(): number | null {
    if (!form.default_price.trim()) return null;
    const n = Number(form.default_price);
    if (!Number.isFinite(n) || n < 0) throw new Error('默认价格必须为非负数');
    return form.default_currency === 'CNY' ? Math.round(n * 100) : Math.round(n);
  }

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

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const priceMinor = parsePrice();
      const base = {
        name: form.name.trim(),
        short_name: form.short_name.trim() || null,
        description: form.description || null,
        category_id: form.category_id || null,
        fandom: form.fandom.trim() || null,
        tags: form.tags.trim() || null,
        type: form.type,
        default_currency: form.default_currency,
        default_price_minor: priceMinor,
        cover_asset_id: coverId
      };

      if (product) {
        await updateProduct(product.id, base);
        // SKU 跟着「保存」一起落盘。原来是每敲一个字就写一次库，
        // 既和同一个弹窗里的「保存/取消」语义不一致，也会白写很多次。
        for (const v of variants) {
          const before = product.variants.find((x) => x.id === v.id);
          if (!before) continue;
          const nextName = v.name.trim() || DEFAULT_VARIANT;
          const nextSku = v.sku.trim() || '';
          if (nextName !== before.name) await updateVariant(v.id, { name: nextName });
          if (nextSku !== (before.sku ?? '')) await updateVariant(v.id, { sku: nextSku || null });
        }
        if (form.type === 'bundle' && bundleComps && product.variants[0]) {
          await setBundleComponents(product.variants[0].id, bundleComps);
        }
        onSaved({ productId: product.id });
      } else {
        const created = await createProduct({
          ...base,
          variantName: variants[0]?.name.trim() || DEFAULT_VARIANT,
          sku: variants[0]?.sku.trim() || null
        });
        onSaved({ productId: created.productId, variantId: created.variantId });
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={editing ? `编辑：${product!.name}` : '新增商品'}
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy || !form.name.trim()} onClick={save}>
            {busy ? <span className="spinner" /> : null}
            {editing ? '保存' : '创建'}
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
            <input
              value={form.default_price}
              onChange={(e) => setForm({ ...form, default_price: e.target.value })}
              placeholder={form.default_currency === 'CNY' ? '0.00' : '0'}
            />
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
          {variants.map((v, i) => (
            <div key={v.id} className="row tight" style={{ marginTop: i ? 6 : 0 }}>
              {/* 规格名是系统生成的，做成纯文本而不是只读输入框——
                  只读输入框看起来仍然像个能改的字段，点进去发现改不动更让人困惑。 */}
              {/* 规格名可以改。留空会回退成「默认规格」（后端不允许空名）。
                  改名后会显示在游客菜单的副标题上 —— 见下面那行说明。 */}
              <input
                value={v.name}
                placeholder="规格名"
                aria-label="规格名"
                onChange={(e) =>
                  setVariants((prev) => prev.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                }
                style={{ maxWidth: 200 }}
              />
              <input
                value={v.sku}
                placeholder="SKU（全库唯一，可留空）"
                aria-label={`${v.name} 的 SKU`}
                onChange={(e) =>
                  setVariants((prev) => prev.map((x, j) => (j === i ? { ...x, sku: e.target.value } : x)))
                }
                style={{ maxWidth: 240 }}
              />
            </div>
          ))}
          <p className="tiny muted" style={{ marginTop: 6, marginBottom: 0 }}>
            一件商品只有一个规格。名字可以改（比如「上册」「带特典」），改名后会显示在游客菜单的副标题上；
            留空则回退成「默认规格」。SKU 用来和自己的表格对账，可以留空。
          </p>
        </div>

        {form.type === 'bundle' ? (
          editing ? (
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
          ) : (
            <div className="notice info">
              套装成分要等商品创建之后才能配——成分指向的是其他商品的规格。
              先保存，再从「商品」页点「编辑」回来添加成分。
            </div>
          )
        ) : null}

        <ErrorBox message={error} />
      </div>
    </Modal>
  );
}
