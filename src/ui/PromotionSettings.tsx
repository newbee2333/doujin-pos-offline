import { useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Currency } from '../domain/types';
import { formatAmountOnly, formatMoney, minorToInput, parseAmountToMinor } from '../domain/money';
import { adjustedUnit, automaticUnit, type PriceAdjustment, type PromotionRules } from '../domain/pricing';
import { getPromotions, savePromotions } from '../services/promotions';
import { listEventConfigs, type EventConfigRow } from '../services/events';
import { listCategories, listProducts } from '../services/catalog';
import { errorMessage } from '../store';
import { AssetImage, ConfirmDialog, ErrorBox, Modal, Spinner, useAsync } from './components';

/** Keep event setup short; prices are edited in a dedicated visual workspace. */
export default function PromotionSettings({ eventId, currency, disabled }: { eventId: string; currency: Currency; disabled: boolean }) {
  const state = useAsync(() => getPromotions(eventId), [eventId]);
  return <section className="card promotion-settings promotion-entry">
    <div><h2>优惠活动</h2><p className="small muted">看封面选商品，设置单件、整类优惠或满减。</p>
      {state.data && <span className="small muted">{Object.keys(state.data.prices).length} 项活动价 · {state.data.tiers.length ? state.data.tiers.map(t => `满 ${formatAmountOnly(t.threshold, currency)} 减 ${formatAmountOnly(t.reduction, currency)}`).join(' / ') : '未设置满减'}</span>}
      <ErrorBox message={state.error}/>
    </div>
    <Link className="btn primary" to={`/staff/promotions?event=${encodeURIComponent(eventId)}`}>{disabled ? '查看优惠活动' : '设置优惠活动'}</Link>
  </section>;
}
async function loadWorkspace(eventId: string) {
  const [rules, configs, categories, products] = await Promise.all([getPromotions(eventId), listEventConfigs(eventId), listCategories(true), listProducts({})]);
  return { rules, configs, categories, products };
}
export function PromotionWorkspace({ eventId, currency, disabled }: { eventId: string; currency: Currency; disabled: boolean }) {
  const state = useAsync(() => loadWorkspace(eventId), [eventId]);
  if (!state.data) return <><Spinner label="读取优惠与商品…"/><ErrorBox message={state.error}/></>;
  return <PromotionForm key={eventId} data={state.data} eventId={eventId} currency={currency} disabled={disabled}/>;
}
type TierDraft = { threshold: string; reduction: string };
const tierDrafts = (rules: PromotionRules, currency: Currency): TierDraft[] => rules.tiers.map(t => ({ threshold: minorToInput(t.threshold, currency), reduction: minorToInput(t.reduction, currency) }));
const fingerprint = (rules: PromotionRules, tiers: TierDraft[]) => JSON.stringify({ prices: rules.prices, eligible: rules.eligible, tiers });
const discountLabel = (value?: PriceAdjustment) => value?.kind === 'rate' ? `${value.value / 1000} 折` : value ? '特价' : '';

function PromotionForm({ data, eventId, currency, disabled }: {
  data: Awaited<ReturnType<typeof loadWorkspace>>; eventId: string; currency: Currency; disabled: boolean;
}) {
  const [rules, setRules] = useState(data.rules);
  const [savedRules, setSavedRules] = useState(data.rules);
  const [tiers, setTiers] = useState(tierDrafts(data.rules, currency));
  const [selected, setSelected] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('');
  const [onlyDiscounted, setOnlyDiscounted] = useState(false);
  const [editing, setEditing] = useState<{ ids: string[]; scope: string; batch: boolean } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const products = new Map(data.products.map(p => [p.id, p]));
  const available = data.configs.filter(c => c.enabled && !c.archived && c.product_type !== 'gift');
  const inCategory = available.filter(c => !category || products.get(c.product_id)?.category_id === category);
  const rows = inCategory.filter(c => (!onlyDiscounted || !!rules.prices[c.variant_id]) && `${c.product_name} ${c.variant_name} ${c.sku ?? ''}`.toLowerCase().includes(keyword.toLowerCase()));
  const selectable = rows.filter(c => c.event_price_minor !== null).map(c => c.variant_id);
  const categoryTargets = inCategory.filter(c => c.event_price_minor !== null).map(c => c.variant_id);
  const dirty = fingerprint(rules, tiers) !== fingerprint(savedRules, tierDrafts(savedRules, currency));
  const outsideSelection = selected.filter(id => !selectable.includes(id)).length;
  const activeCategories = data.categories.filter(cat => available.some(c => products.get(c.product_id)?.category_id === cat.id));
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const guardNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement) || link.target === '_blank' || link.hasAttribute('download')) return;
      const destination = new URL(link.href);
      if (destination.origin !== location.origin || destination.href === location.href) return;
      event.preventDefault(); setLeaving(destination.pathname + destination.search + destination.hash);
    };
    window.addEventListener('beforeunload', guard);
    document.addEventListener('click', guardNavigation, true);
    return () => { window.removeEventListener('beforeunload', guard); document.removeEventListener('click', guardNavigation, true); };
  }, [dirty]);
  function restore(ids: string[]) {
    const prices = { ...rules.prices }; ids.forEach(id => { delete prices[id]; });
    setRules({ ...rules, prices }); setError(null);
  }
  async function save() {
    setBusy(true); setError(null);
    try {
      await savePromotions(eventId, { ...rules, tiers: tiers.map(t => ({ threshold: parseAmountToMinor(t.threshold, currency), reduction: parseAmountToMinor(t.reduction, currency) })) });
      const next = await getPromotions(eventId);
      setRules(next); setSavedRules(next); setTiers(tierDrafts(next, currency));
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <>
    <fieldset disabled={disabled || busy} className="promotion-form promotion-workspace">
      <legend className="sr-only">本场优惠配置</legend>
      <div className="promotion-workspace-body">
        <section className="promotion-catalog" aria-label="优惠商品目录">
          <div className="promotion-catalog-tools"><input type="search" aria-label="搜索活动商品" placeholder="搜索商品名 / 规格 / SKU" value={keyword} onChange={e => setKeyword(e.target.value)}/><label className="check"><input type="checkbox" checked={onlyDiscounted} onChange={e => setOnlyDiscounted(e.target.checked)}/>只看已优惠</label></div>
          <div className="chip-row promotion-categories" aria-label="活动商品分类">
            <button className={`chip${!category ? ' active' : ''}`} aria-pressed={!category} onClick={() => setCategory('')}>全部 <small>{available.length}</small></button>
            {activeCategories.map(cat => <button key={cat.id} className={`chip${category === cat.id ? ' active' : ''}`} aria-pressed={category === cat.id} onClick={() => setCategory(cat.id)}>{cat.name} <small>{available.filter(c => products.get(c.product_id)?.category_id === cat.id).length}</small></button>)}
          </div>
          <div className="promotion-selection-row"><span className="small muted">{rows.length} 项 · 点封面改价，勾选后批量设置</span><div className="row wrap"><button className="small" disabled={!selectable.length} onClick={() => setSelected([...new Set([...selected, ...selectable])])}>选择当前结果</button>{category && <button className="small primary" disabled={!categoryTargets.length} onClick={() => setEditing({ ids: categoryTargets, scope: `${data.categories.find(c => c.id === category)?.name ?? '当前分类'} · 共 ${categoryTargets.length} 个规格`, batch: true })}>整类优惠</button>}</div></div>
          {!rows.length ? <div className="card promotion-empty"><strong>{available.length ? '没有匹配的商品' : '还没有可设置优惠的商品'}</strong><p className="small muted">{available.length ? '试试其他分类或清除搜索条件。' : '请先在展会配置中添加并上架商品；赠品不设置活动价。'}</p><Link to="/staff/events">前往展会配置</Link></div> : <div className="promotion-card-grid">
            {rows.map(c => {
              const product = products.get(c.product_id), adjustment = rules.prices[c.variant_id], base = c.event_price_minor;
              const price = base === null ? null : automaticUnit(base, adjustment), picked = selected.includes(c.variant_id);
              const eligible = rules.eligible === null || rules.eligible.includes(c.variant_id);
              return <article className={`menu-card menu-card-cover promotion-card${picked ? ' picked' : ''}`} key={c.variant_id} aria-label={`${c.product_name} · ${c.variant_name}`}>
                <label className="promotion-pick" title="选择后可批量设置优惠"><input type="checkbox" aria-label={`选择 ${c.product_name} · ${c.variant_name}`} disabled={base === null} checked={picked} onChange={e => setSelected(e.target.checked ? [...selected, c.variant_id] : selected.filter(id => id !== c.variant_id))}/><span className="sr-only">选择商品</span></label>
                {adjustment && <span className="promotion-card-tag">{discountLabel(adjustment)}</span>}
                <button className="menu-card-info" aria-label={`设置 ${c.product_name} · ${c.variant_name} 优惠`} disabled={base === null} onClick={() => setEditing({ ids: [c.variant_id], scope: `${c.product_name} · ${c.variant_name}`, batch: false })}>
                  <span className="thumb-wrap"><AssetImage assetId={product?.cover_asset_id} alt={c.product_name}/></span><span className="caption"><span className="name">{c.product_name}</span><span className="sub">{[c.category_name, c.variant_name !== '默认规格' ? c.variant_name : null].filter(Boolean).join(' · ') || '默认规格'}</span></span>
                </button>
                <button className="promotion-card-price" aria-label={`修改 ${c.product_name} · ${c.variant_name} 优惠价`} disabled={base === null} onClick={() => setEditing({ ids: [c.variant_id], scope: `${c.product_name} · ${c.variant_name}`, batch: false })}><span className="tiny muted">{adjustment ? '活动价' : '本场价'}</span><span className="price">{price === null ? '未定价' : formatAmountOnly(price, currency)} <small>{currency}</small></span><span className="promotion-original tiny muted">{adjustment && base !== null ? <del>原价 {formatAmountOnly(base, currency)}</del> : base === null ? '先设置本场价格' : '点此设置优惠'}</span></button>
                {!!tiers.length && <span className="tiny promotion-card-scope">{eligible ? '参与满减' : '不参与满减'}</span>}
              </article>;
            })}
          </div>}
        </section>
        <aside className="promotion-rules card" aria-label="满减设置">
          <div><span className="eyebrow">整单活动</span><h2>满减</h2><p className="small muted">达到门槛后自动减免，和商品优惠一起生效。</p></div>
          <label className="check"><input type="checkbox" checked={rules.eligible === null} onChange={e => setRules({ ...rules, eligible: e.target.checked ? null : [] })}/>全部非赠品商品参与</label>
          {rules.eligible !== null && <div className="promotion-scope"><strong className="small">已指定 {rules.eligible.length} 个规格</strong><button className="small" disabled={!selected.length} onClick={() => setRules({ ...rules, eligible: [...selected] })}>使用当前勾选商品</button><p className="tiny muted">先在左侧勾选，再点此按钮替换参与范围。</p></div>}
          {!tiers.length && <p className="small muted">尚未设置满减。例：满 150 减 20。</p>}
          {tiers.map((tier, index) => <div className="promotion-tier" key={index}><label><span>满（{currency === 'CNY' ? '元' : '日元'}）</span><input aria-label={`满减门槛${index + 1}`} inputMode="decimal" value={tier.threshold} onChange={e => setTiers(tiers.map((v, i) => i === index ? { ...v, threshold: e.target.value } : v))}/></label><label><span>减</span><input aria-label={`满减金额${index + 1}`} inputMode="decimal" value={tier.reduction} onChange={e => setTiers(tiers.map((v, i) => i === index ? { ...v, reduction: e.target.value } : v))}/></label><button className="small ghost" aria-label={`删除第${index + 1}档`} onClick={() => setTiers(tiers.filter((_, i) => i !== index))}>删除</button></div>)}
          <button onClick={() => setTiers([...tiers, { threshold: '', reduction: '' }])}>＋ 添加满减档位</button>
          <details className="promotion-explanation"><summary className="small">门槛怎么算？</summary><p className="tiny muted">按参与商品的本场原价 × 数量判断，打折和人工降价不改变资格。每单取达到的最高一档，不累加；实际减免最多减至参与商品为零元。套装按套装价计算，不重复计算成分。</p></details>
        </aside>
      </div>
      <div className="promotion-save-bar">
        {!!selected.length && <div className="promotion-batch"><div><strong>已选 {selected.length} 项</strong>{outsideSelection > 0 && <span className="tiny muted">含筛选外 {outsideSelection} 项</span>}</div><button className="primary" onClick={() => setEditing({ ids: selected, scope: `勾选商品 · 共 ${selected.length} 个规格${outsideSelection ? `（含筛选外 ${outsideSelection} 项）` : ''}`, batch: true })}>批量设置优惠</button><button className="small ghost" onClick={() => setSelected([])}>清除选择</button></div>}
        <ErrorBox message={error}/>
        <div className="promotion-save-actions"><span role="status" className={`small ${dirty ? 'promotion-unsaved' : 'muted'}`}>{disabled ? '已收摊 · 重新打开后可修改' : dirty ? '有未保存的修改 · 保存后才生效' : '本场优惠已保存'}</span><span className="spacer"/><button disabled={!dirty} onClick={() => setResetting(true)}>放弃修改</button><button className="primary" disabled={!dirty} onClick={save}>{busy ? '保存中…' : '保存本场优惠'}</button></div>
      </div>
    </fieldset>
    {editing && <ProductPriceDialog rows={available.filter(c => editing.ids.includes(c.variant_id))} scope={editing.scope} batch={editing.batch} products={products} currency={currency} rules={rules} onClose={() => setEditing(null)} onApply={adjustment => {
      const prices = { ...rules.prices }; editing.ids.forEach(id => { prices[id] = adjustment; }); setRules({ ...rules, prices }); setEditing(null); setError(null);
    }} onRestore={() => { restore(editing.ids); setEditing(null); }}/ >}
    {resetting && <ConfirmDialog title="放弃本次修改？" message="商品活动价和满减将恢复到上次保存的设置。" confirmText="放弃修改" onCancel={() => setResetting(false)} onConfirm={() => { setRules(savedRules); setTiers(tierDrafts(savedRules, currency)); setError(null); setResetting(false); }}/ >}
    {leaving && <ConfirmDialog title="还有未保存的优惠" message="离开会放弃本次修改。先留在此页保存，或放弃修改后离开。" confirmText="放弃并离开" onCancel={() => setLeaving(null)} onConfirm={() => navigate(leaving)}/ >}
  </>;
}

function ProductPriceDialog({ rows, scope, batch, products, currency, rules, onClose, onApply, onRestore }: {
  rows: EventConfigRow[]; products: Map<string, Awaited<ReturnType<typeof listProducts>>[number]>; currency: Currency; rules: PromotionRules;
  scope: string; batch: boolean;
  onClose: () => void; onApply: (adjustment: PriceAdjustment) => void; onRestore: () => void;
}) {
  const single = rows.length === 1;
  const first = rules.prices[rows[0]?.variant_id];
  const existing = first && rows.every(c => {
    const price = rules.prices[c.variant_id];
    return price?.kind === first.kind && price.value === first.value;
  }) ? first : undefined;
  const [kind, setKind] = useState<'price' | 'rate'>(existing?.kind ?? (batch ? 'rate' : 'price'));
  const [values, setValues] = useState({
    price: existing?.kind === 'price' ? minorToInput(existing.value, currency) : '',
    rate: existing?.kind === 'rate' ? String(existing.value / 1000) : ''
  });
  const value = values[kind];
  const setValue = (next: string) => setValues(previous => ({ ...previous, [kind]: next }));
  const inputId = useId();
  const validRate = /^(?:10|[0-9])(?:\.\d{1,2})?$/.test(value.trim()) && Number(value) <= 10;
  const stepRate = !value.trim() ? 10 : validRate ? Number(value) : null;
  const changeRate = (delta: number) => {
    if (stepRate !== null) setValue(String(Math.max(0, Math.min(1000, Math.round(stepRate * 100) + delta * 100)) / 100));
  };
  let adjustment: PriceAdjustment | null = null, error: string | null = null;
  if (value.trim()) try {
    if (kind === 'rate' && !validRate) throw new Error('请输入 0 至 10 折，最多两位小数');
    adjustment = { kind, value: kind === 'rate' ? Math.round(Number(value) * 1000) : parseAmountToMinor(value, currency) };
    for (const c of rows) { if (c.event_price_minor === null) throw new Error(`「${c.product_name}」需要先设置本场价格`); try { adjustedUnit(c.event_price_minor, adjustment); } catch (e) { throw new Error(`「${c.product_name}」：${errorMessage(e)}`); } }
  } catch (e) { error = errorMessage(e); }
  return <Modal title={batch ? '批量设置优惠' : '设置商品优惠'} onClose={onClose} className="promotion-price-dialog" actions={<><button className="ghost" onClick={onClose}>取消</button><button className="primary" disabled={!!error || !adjustment || !rows.length} onClick={() => adjustment && onApply(adjustment)}>应用优惠</button></>}>
    <div className="promotion-target-summary"><span className="tiny muted">作用范围</span><strong>{scope}</strong>{!single && <span className="tiny muted">{existing ? '已回填这批商品相同的优惠设置' : '每件商品按自己的本场原价计算'}</span>}</div>
    {single ? <div className="promotion-dialog-product"><AssetImage assetId={products.get(rows[0].product_id)?.cover_asset_id} alt={rows[0].product_name}/><div><strong>{rows[0].product_name}</strong><p className="small muted">{rows[0].variant_name}</p><span className="small">本场原价 {formatMoney(rows[0].event_price_minor ?? 0, currency)}</span></div></div> : <p className="small muted">统一应用到这 {rows.length} 个规格。每个商品按自己的本场原价计算折扣。</p>}
    <div className="seg promotion-price-method" aria-label="优惠方式"><button className={`seg-item${kind === 'price' ? ' active' : ''}`} aria-pressed={kind === 'price'} onClick={() => setKind('price')}>优惠单价</button><button className={`seg-item${kind === 'rate' ? ' active' : ''}`} aria-pressed={kind === 'rate'} onClick={() => setKind('rate')}>打几折</button></div>
    <div className="field">
      <label htmlFor={inputId}>{kind === 'price' ? `优惠后单价（${currency === 'CNY' ? '元' : '日元'}）` : '折扣（折）'}</label>
      <div className={kind === 'rate' ? 'qty promotion-rate-stepper' : undefined}>
        {kind === 'rate' && <button type="button" aria-label="减少一折" disabled={stepRate === null || stepRate <= 0} onClick={() => changeRate(-1)}>−</button>}
        <input id={inputId} autoFocus aria-label="活动优惠值" inputMode="decimal" value={value} onFocus={e => e.currentTarget.select()} onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && !error && adjustment) { e.preventDefault(); onApply(adjustment); } }} placeholder={kind === 'rate' ? '10 折起算，也可直接输入' : '输入优惠后的每件价格'}/>
        {kind === 'rate' && <button type="button" aria-label="增加一折" disabled={stepRate === null || stepRate >= 10} onClick={() => changeRate(1)}>+</button>}
      </div>
    </div>
    {!value.trim() && <p className="small muted">{kind === 'price' ? '输入优惠后单价，查看每件省多少钱。' : '点减号从 10 折开始调整，或直接输入折扣。'}</p>}
    <ErrorBox message={error}/>
    {!error && adjustment && <div className="promotion-price-preview" aria-label="优惠价格预览">{rows.map(c => { const price = adjustedUnit(c.event_price_minor!, adjustment!); return <div key={c.variant_id}><div><strong className="small">{c.product_name}</strong><span className="tiny muted">{c.variant_name}</span></div><div><del className="tiny muted">原价 {formatMoney(c.event_price_minor!, currency)}</del><strong className="price">→ {formatMoney(price, currency)}</strong><span className="tiny muted">每件省 {formatMoney(c.event_price_minor! - price, currency)}</span></div></div>; })}</div>}
    <button className="small ghost" onClick={onRestore}>恢复{single ? '本商品' : '这批商品'}的本场原价</button><p className="tiny muted">应用后可在卡片上核对，点页面底部「保存本场优惠」才正式生效。</p>
  </Modal>;
}
