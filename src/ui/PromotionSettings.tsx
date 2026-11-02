import { useState } from 'react';
import type { Currency } from '../domain/types';
import { formatMoney, minorToInput, parseAmountToMinor } from '../domain/money';
import { adjustedUnit, automaticUnit, type PromotionRules } from '../domain/pricing';
import { getPromotions, savePromotions } from '../services/promotions';
import { listEventConfigs } from '../services/events';
import { listCategories, listProducts } from '../services/catalog';
import { errorMessage } from '../store';
import { ErrorBox, Spinner, useAsync } from './components';

export default function PromotionSettings({ eventId, currency, disabled }: { eventId: string; currency: Currency; disabled: boolean }) {
  const state = useAsync(async () => ({ rules: await getPromotions(eventId), configs: await listEventConfigs(eventId), categories: await listCategories(true), products: await listProducts({}) }), [eventId]);
  return <details className="card promotion-settings"><summary className="strong">优惠活动 · 活动价与满减</summary>
    <p className="small muted">按当前展会独立保存。已提交订单保留原金额；新订单使用最新活动。满减按参与商品的本场原价计算，自动折扣和人工降价均不影响门槛。</p>
    {state.loading ? <Spinner label="读取优惠…"/> : state.data ? <PromotionForm key={state.data.rules.version || eventId} data={state.data} eventId={eventId} currency={currency} disabled={disabled} onSaved={state.reload}/> : null}
    <ErrorBox message={state.error}/>
  </details>;
}
function PromotionForm({ data, eventId, currency, disabled, onSaved }: {
  data: { rules: PromotionRules; configs: Awaited<ReturnType<typeof listEventConfigs>>; categories: Awaited<ReturnType<typeof listCategories>>; products: Awaited<ReturnType<typeof listProducts>> };
  eventId: string; currency: Currency; disabled: boolean; onSaved: () => void;
}) {
  const [rules, setRules] = useState(data.rules);
  const [tiers, setTiers] = useState(data.rules.tiers.map(t => ({ threshold: minorToInput(t.threshold, currency), reduction: minorToInput(t.reduction, currency) })));
  const [selected, setSelected] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('');
  const [kind, setKind] = useState<'price' | 'rate'>('rate');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const products = new Map(data.products.map(p => [p.id, p]));
  const rows = data.configs.filter(c => c.enabled && c.product_type !== 'gift' && (!category || products.get(c.product_id)?.category_id === category) && `${c.product_name} ${c.variant_name} ${c.sku ?? ''}`.toLowerCase().includes(keyword.toLowerCase()));
  function apply() {
    try {
      if (!selected.length) throw new Error('请先勾选商品');
      if (kind === 'rate' && !/^(?:10|[0-9])(?:\.\d{1,2})?$/.test(value.trim())) throw new Error('请输入 0 至 10 折，例如 8 或 9.5');
      const adjustment = { kind, value: kind === 'rate' ? Math.round(Number(value) * 1000) : parseAmountToMinor(value, currency) };
      const prices = { ...rules.prices };
      for (const id of selected) {
        const c = data.configs.find(c => c.variant_id === id)!;
        if (c.event_price_minor === null) throw new Error(`「${c.product_name}」尚未设置本场定价`);
        adjustedUnit(c.event_price_minor, adjustment);
        prices[id] = adjustment;
      }
      setRules({ ...rules, prices }); setError(null); setSaved(false);
    } catch (e) { setError(errorMessage(e)); }
  }
  return <fieldset disabled={disabled || busy} className="promotion-form"><legend className="sr-only">本场优惠配置</legend>
    <div className="row wrap"><input aria-label="搜索活动商品" placeholder="搜索商品 / 规格 / SKU" value={keyword} onChange={e => setKeyword(e.target.value)}/>
      <select aria-label="活动商品分类" value={category} onChange={e => setCategory(e.target.value)}><option value="">全部分类</option>{data.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <button onClick={() => setSelected(rows.map(c => c.variant_id))}>选择当前结果</button><button onClick={() => setSelected([])}>清除选择</button>
    </div>
    <div className="promotion-products">{rows.map(c => <div className="promotion-product" key={c.variant_id}>
      <label className="check"><input type="checkbox" checked={selected.includes(c.variant_id)} onChange={e => setSelected(e.target.checked ? [...selected, c.variant_id] : selected.filter(id => id !== c.variant_id))}/><span>{c.product_name} · {c.variant_name}</span></label>
      <span className="small muted">本场 {c.event_price_minor === null ? '未定价' : formatMoney(c.event_price_minor, currency)}</span>
      {rules.prices[c.variant_id] && <><strong className="small">活动 {formatMoney(automaticUnit(c.event_price_minor ?? 0, rules.prices[c.variant_id]), currency)}</strong><button className="small" onClick={() => { const prices = { ...rules.prices }; delete prices[c.variant_id]; setRules({ ...rules, prices }); }}>取消活动价</button></>}
    </div>)}</div>
    <div className="row wrap"><span>已选 {selected.length} 项</span><select aria-label="活动价方式" value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option value="rate">打折</option><option value="price">设置优惠单价</option></select>
      <input aria-label="活动优惠值" inputMode="decimal" value={value} onChange={e => setValue(e.target.value)} placeholder={kind === 'rate' ? '如 8，表示八折' : '每件优惠价'}/><button onClick={apply}>应用到所选商品</button>
    </div>
    <h3>满减</h3><label className="check"><input type="checkbox" checked={rules.eligible === null} onChange={e => setRules({ ...rules, eligible: e.target.checked ? null : [] })}/>全部非赠品商品参与</label>
    {rules.eligible !== null && <div className="row wrap"><span className="small">参与 {rules.eligible.length} 个规格（未选中的商品不计门槛、不分摊满减）</span><button onClick={() => setRules({ ...rules, eligible: [...selected] })}>用所选商品替换参与范围</button></div>}
    {tiers.map((tier, index) => <div className="row" key={index}><label>满<input aria-label={`满减门槛${index + 1}`} inputMode="decimal" value={tier.threshold} onChange={e => setTiers(tiers.map((v, i) => i === index ? { ...v, threshold: e.target.value } : v))}/></label><label>减<input aria-label={`满减金额${index + 1}`} inputMode="decimal" value={tier.reduction} onChange={e => setTiers(tiers.map((v, i) => i === index ? { ...v, reduction: e.target.value } : v))}/></label><button onClick={() => setTiers(tiers.filter((_, i) => i !== index))}>删除档位</button></div>)}
    <button onClick={() => setTiers([...tiers, { threshold: '', reduction: '' }])}>添加满减档位</button>
    <p className="tiny muted">每单取达到门槛的最高一档，不累加。套装按套装售价计算，不重复计算成分；满减最多减至参与商品为零元。</p>
    <ErrorBox message={error}/>{saved && <p role="status">已保存优惠活动</p>}
    <button className="primary" onClick={async () => { setBusy(true); setError(null); try { await savePromotions(eventId, { ...rules, tiers: tiers.map(t => ({ threshold: parseAmountToMinor(t.threshold, currency), reduction: parseAmountToMinor(t.reduction, currency) })) }); setSaved(true); onSaved(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } }}>保存本场优惠</button>
    {disabled && <p className="small muted">已收摊展会需要重新打开后才能修改优惠。</p>}
  </fieldset>;
}
