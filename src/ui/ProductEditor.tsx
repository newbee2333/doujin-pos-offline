/**
 * 商品编辑器：新增和编辑共用同一套字段与同一套版式。
 *
 * 以前这里是三套：商品页的「新增商品」只有 5 个字段、展会页的「现场新建」只有 4 个、
 * 只有「编辑商品」是完整的。后果是新建完必须再点一次「编辑」才能把封面、说明、
 * 原作圈子填上——同一个对象两套心智模型，而且新建那套永远落后于编辑那套。
 * 现在统一到这里。`mode` 只决定两件事：标题、保存时调 create 还是 update。
 * 套装成分两种模式都能配：成分指向别的规格，而新建时还没有 variant id ——
 * 处理办法是先把商品建出来拿到 id，紧接着写成分，对用户仍然是一次「创建」。
 *
 * 规格部分：一件商品只有一个「默认规格」，名称由系统生成、不可改，
 * 也不再提供「新增规格」——那个入口在现场没有对应动作，只会让人以为要点。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { minorToInput, parseAmountToMinor } from '../domain/money';
import { errorMessage, useApp } from '../store';
import AssetEditor from './AssetEditor';
import BundleComponentPicker, { BundleComponentRow } from './BundleComponentPicker';
import type { VariantOption } from './variant-filter';
import { ErrorBox, Field, Modal, useAsync } from './components';
import type { Category, Currency, ProductType } from '../domain/types';
import type { ProductWithVariants } from '../services/catalog';

/**
 * 类型中文名。只有这一份，商品页也从这里取——两边各留一份迟早改漏。
 *
 * `bundle` 原来叫「虚拟套装」。改名是因为编辑器里「菜单分类」和「库存类型」并排，
 * 而默认分类里就有一个叫「套装」的——两个下拉都带「套装」二字，
 * 摊主会去改分类那个（分类只管菜单归类，不影响库存），然后找不到配成分的地方。
 * 「组合套装」至少把「它由几样东西组合而成」这层意思说出来了。
 */
export const TYPE_LABEL: Record<ProductType, string> = {
  normal: '普通库存',
  bundle: '组合套装',
  gift: '赠品',
  non_stock: '不计库存'
};

/**
 * 选中某个类型时紧跟在下拉下面的那句说明。
 * 光看四个名字看不出差别在哪，真正要讲清的是「库存怎么算」。
 */
export const TYPE_HINT: Record<ProductType, string> = {
  normal: '卖一件就扣自己一件。',
  bundle: '自己没有库存。卖一套时按下面「套装成分」里的数量，同时扣掉几样别的商品。',
  gift: '不收钱（按 0 元记账），但照常扣自己的库存。',
  non_stock: '无料、宣传品这类，卖多少都不扣库存。'
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
  const [bundleComps, setBundleComps] = useState<{ component_variant_id: string; quantity: number }[]>([]);
  // 只回写用户改过的成分。异步读取期间禁止保存与选择，避免空表覆盖。
  const [compsTouched, setCompsTouched] = useState(false);
  const [selectingComponents, setSelectingComponents] = useState(false);
  const componentButton = useRef<HTMLButtonElement>(null);
  const editorScrollTop = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const editorContent = useRef<HTMLDivElement>(null);

  // 类型决定库存怎么算 —— 套装成分只在这个类型下出现。
  // 注意别和「菜单分类」混了：分类里也有一个叫「套装」的默认分类，
  // 那只影响它在游客菜单的哪一栏，不影响库存。
  const isBundle = form.type === 'bundle';
  const categoryIsBundleish = !isBundle && (categories.find((c) => c.id === form.category_id)?.name ?? '').includes('套装');

  // 套装成分只列「普通库存」商品的规格；不是套装就不用拉
  const bundleSource = useAsync(
    () => (isBundle ? listProducts({ archived: null }) : Promise.resolve([])),
    [isBundle]
  );
  const bundleOptions = useMemo<VariantOption[]>(
    () =>
      (bundleSource.data ?? []).flatMap((p) =>
        p.type === 'normal' && p.id !== product?.id
          ? p.variants.map((v) => ({
              id: v.id,
              sku: v.sku ?? null,
              categoryId: p.category_id,
              archived: !!p.archived || !!v.archived,
              searchText: `${p.short_name ?? ''} ${p.fandom ?? ''} ${p.tags ?? ''}`,
              item: {
                product_name: p.name,
                variant_name: v.name,
                category_name: p.category_name,
                cover_asset_id: p.cover_asset_id,
                // 编辑器里没有「本场价格」，用商品自己的默认价；选择模式下只作参考。
                price_minor: p.default_price_minor ?? 0,
                currency: p.default_currency,
                product_type: p.type,
                // 本场库存这里拿不到，选择模式也不做售罄判断 —— 传 null。
                // 传 0 会重演收银台那个 bug：把「拿不到」当成「卖完了」。
                available_stock: null,
                show_exact_stock: 0,
                low_stock_threshold: 0
              }
            }))
          : []
      ),
    [bundleSource.data, product?.id]
  );

  // 打开编辑套装时读一次现有成分
  const firstVariantId = product?.variants[0]?.id ?? null;
  const storedComponents = useAsync(
    () => isBundle && editing && firstVariantId ? getBundleComponents(firstVariantId) : Promise.resolve([]),
    [isBundle, editing, firstVariantId]
  );
  useEffect(() => {
    if (!isBundle || compsTouched || storedComponents.loading || !storedComponents.data) return;
    setBundleComps(storedComponents.data.map(row => ({ component_variant_id: row.component_variant_id, quantity: row.quantity })));
  }, [isBundle, compsTouched, storedComponents.data, storedComponents.loading]);
  const componentsLoading = bundleSource.loading || storedComponents.loading;
  const componentsError = bundleSource.error ?? storedComponents.error;

  function closeComponentPicker() {
    setSelectingComponents(false);
    requestAnimationFrame(() => {
      const scroll = componentButton.current?.closest('.modal-content');
      if (scroll) scroll.scrollTop = editorScrollTop.current;
      componentButton.current?.focus({ preventScroll: true });
    });
  }

  /** 改成分表都要走这里：顺手把「动过了」标上，保存时才知道该不该回写。 */
  function editComps(next: { component_variant_id: string; quantity: number }[]) {
    setCompsTouched(true);
    setBundleComps(next);
  }

  function parsePrice(): number | null {
    if (!form.default_price.trim()) return null;
    return parseAmountToMinor(form.default_price, form.default_currency);
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
    setFieldErrors({});
    try {
      // 成分自检放在最前面：写到一半被服务端拒掉，商品那部分已经落盘了，现场很难解释。
      if (isBundle && editing && compsTouched && !bundleComps.length) {
        throw new Error('套装至少要有一个成分');
      }
      const willWriteComps = isBundle && bundleComps.length > 0 && (compsTouched || !editing);
      if (willWriteComps) {
        if (bundleComps.some((c) => !c.component_variant_id)) throw new Error('请为每个成分选择一个商品规格');
        const ids = bundleComps.map((c) => c.component_variant_id);
        if (new Set(ids).size !== ids.length) throw new Error('同一成分请合并为一条');
        if (bundleComps.some(c => !Number.isSafeInteger(c.quantity) || c.quantity <= 0)) throw new Error('每项成分的用量必须为正整数');
        if (ids.some(id => !bundleOptions.some(option => option.id === id))) throw new Error('存在不可用的成分，请重新选择商品');
      }

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
        if (willWriteComps && product.variants[0]) {
          await setBundleComponents(product.variants[0].id, bundleComps);
        }
        onSaved({ productId: product.id });
      } else {
        const created = await createProduct({
          ...base,
          variantName: variants[0]?.name.trim() || DEFAULT_VARIANT,
          sku: variants[0]?.sku.trim() || null
        });
        // 成分要指向新建出来的这个规格，所以只能建完再写。
        // 这样「新建套装」一次就能配齐，不用先保存、再点一次「编辑」回来补。
        if (willWriteComps) await setBundleComponents(created.variantId, bundleComps);
        onSaved({ productId: created.productId, variantId: created.variantId });
      }
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      const key = /SKU/.test(message) ? 'sku' : /金额|价格|日元/.test(message) ? 'price' : /成分|套装/.test(message) ? 'components' : /名称/.test(message) ? 'name' : '';
      if (key) {
        setFieldErrors({ [key]: message });
        requestAnimationFrame(() => {
          const target = editorContent.current?.querySelector<HTMLElement>(key === 'components' ? '.bundle-comps input[aria-invalid="true"], [data-error-field="components"]' : `[data-error-field="${key}"]`);
          target?.scrollIntoView({ block: 'center' }); target?.focus({ preventScroll: true });
        });
      }
    } finally {
      setBusy(false);
    }
  }

  if (selectingComponents) return <BundleComponentPicker options={bundleOptions} components={bundleComps}
    onCancel={closeComponentPicker} onApply={rows => { editComps(rows); closeComponentPicker(); }} />;

  return (
    <Modal
      title={editing ? `编辑：${product!.name}` : '新增商品'}
      className="product-editor-modal"
      subheader={<nav className="editor-section-nav" aria-label="商品编辑分组">{[['product-basic', '基本信息'], ['product-art', '图片说明'], ['product-display', '分类展示'], ['product-variants', '规格 / SKU'], ...(isBundle ? [['product-components', '套装成分']] : [])].map(([id, label]) => <button type="button" key={id} onClick={() => document.getElementById(id)?.scrollIntoView({ block: 'start' })}>{label}</button>)}</nav>}
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy || !form.name.trim() || (isBundle && (componentsLoading || !!componentsError))} onClick={save}>
            {busy ? <span className="spinner" /> : null}
            {editing ? '保存' : '创建'}
          </button>
        </>
      }
    >
      <div className="product-editor-content" ref={editorContent}>
        <section className="editor-section" id="product-basic">
          <h3>基本信息</h3>
          <p className="tiny muted">名称用于菜单展示；默认价格可留空，在展会里单独设置本场售价。</p>
          <div className="grid cols-2">
          <Field label="名称">
            <input aria-required="true" data-error-field="name" aria-invalid={!!fieldErrors.name} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="默认价格">
            <input
              value={form.default_price}
              data-error-field="price" aria-invalid={!!fieldErrors.price}
              onChange={(e) => setForm({ ...form, default_price: e.target.value })}
              placeholder={form.default_currency === 'CNY' ? '0.00' : '0'}
            />
            {fieldErrors.price ? <span className="field-error">{fieldErrors.price}</span> : null}
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
          <Field label="库存类型">
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ProductType })}>
              {Object.entries(TYPE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          </div>
        {/* 分类不决定扣库方式，保留提示防止把「套装」分类当成组合套装。 */}
        <p className="tiny muted" style={{ marginTop: -4, marginBottom: 0 }}>
          「菜单分类」只决定它摆在游客菜单的哪一栏，不影响库存怎么算。
          「库存类型」{TYPE_LABEL[form.type]}：{TYPE_HINT[form.type]}
        </p>
        {categoryIsBundleish ? (
          <div className="notice info">
            分类选的是「套装」，但「库存类型」不是「组合套装」—— 这样它只是一件普通的商品，
            卖出去只扣自己的库存。要按套装扣库存，把「库存类型」改成「组合套装」。
          </div>
        ) : null}

        </section>
        <section className="editor-section" id="product-art">
          <h3>图片与说明</h3>
        <AssetEditor
          label="封面图（自动压缩到最大边 1600px）"
          assetId={coverId}
          onChange={setCoverId}
          onPick={onCover}
        />

        <Field label="说明（纯文本展示）">
          <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>

        </section>
        <section className="editor-section" id="product-display">
          <h3>分类与展示</h3>
          <div className="grid cols-2">
          <Field label="菜单分类">
            <select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
              <option value="">未分类</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="简称">
            <input value={form.short_name} onChange={(e) => setForm({ ...form, short_name: e.target.value })} />
          </Field>
          <Field label="原作 / 圈子">
            <input value={form.fandom} onChange={(e) => setForm({ ...form, fandom: e.target.value })} />
          </Field>
          <Field label="标签（逗号分隔）">
            <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
          </Field>
          </div>
        </section>
        <section className="editor-section" id="product-variants">
          <h3>规格与 SKU</h3>
          {variants.map((v, i) => (
            <div key={v.id} className="row tight" style={{ marginTop: i ? 6 : 0 }}>
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
                data-error-field="sku" aria-invalid={!!fieldErrors.sku}
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
        </section>

        {isBundle ? (
          <section className="bundle-comps editor-section" id="product-components" data-error-field="components" tabIndex={-1}>
            <h3>套装成分</h3>
            <p className="tiny muted">
              套装只消耗成分的库存，自身不持有库存。成分只能是普通库存商品。
              {editing ? '保存后生效。' : '创建时一起写入，不用先保存再回来配。'}
            </p>
            {componentsLoading ? <p className="small muted" role="status">正在读取套装商品…</p> : null}
            {componentsError ? <div className="col"><ErrorBox message={componentsError} /><button onClick={() => { bundleSource.reload(); storedComponents.reload(); }}>重新读取</button></div> : null}
            {!componentsLoading && !componentsError && !bundleOptions.length ? (
              <div className="notice info">
                还没有「普通库存」商品的规格可以选。先把要打包进去的商品建成「普通库存」类型，
                再回来配套装成分。
              </div>
            ) : null}
            {!componentsLoading ? bundleComps.map((c, i) => <BundleComponentRow key={c.component_variant_id} component={c}
              option={bundleOptions.find(option => option.id === c.component_variant_id)}
              onQuantity={quantity => editComps(bundleComps.map((row, j) => j === i ? { ...row, quantity } : row))}
              onRemove={() => editComps(bundleComps.filter((_, j) => j !== i))} />) : null}
            {!componentsLoading && !componentsError && !bundleComps.length && bundleOptions.length ? <p className="small muted">还未选择商品，可一次勾选多项。</p> : null}
            <button
              ref={componentButton}
              className="small"
              disabled={componentsLoading || !!componentsError || !bundleOptions.length}
              onClick={() => {
                editorScrollTop.current = componentButton.current?.closest('.modal-content')?.scrollTop ?? 0;
                setSelectingComponents(true);
              }}
            >
              {bundleComps.length ? '选择 / 添加商品' : '选择套装商品'}
            </button>
          </section>
        ) : null}

        <ErrorBox message={error} />
      </div>
    </Modal>
  );
}
