import { useState } from 'react';
import { newId } from '../domain/ids';
import { formatMoney, parseAmountToMinor } from '../domain/money';
import { adjustedUnit, priceOrder, type OrderAdjustment, type PriceLine, type PromotionRules, type Quote } from '../domain/pricing';
import type { Currency } from '../domain/types';
import { quoteCart, requiresAdjustmentPin, type QuoteInputLine } from '../services/promotions';
import { errorMessage } from '../store';
import { ErrorBox, Modal, useAsync } from './components';

export function useCartQuote(eventId: string | null, lines: QuoteInputLine[], manual?: OrderAdjustment) {
  const key = JSON.stringify({ eventId, lines, manual });
  const state = useAsync(async () => ({ key, quote: eventId ? await quoteCart(eventId, lines, manual) : null }), [eventId, key]);
  return { ...state, data: state.data?.key === key ? state.data.quote : null, loading: state.loading || state.data?.key !== key };
}
export function PriceSummary({ quote, currency, compact = false }: { quote: Quote | null | undefined; currency: Currency; compact?: boolean }) {
  if (!quote || !quote.discount) return null;
  if (compact) return <div className="price-summary compact" title={`满减 ${formatMoney(quote.thresholdDiscount, currency)}；整单人工优惠 ${formatMoney(quote.orderDiscount, currency)}`}><div className="strong"><span>共优惠</span><span>{formatMoney(quote.discount, currency)}</span></div></div>;
  return <div className={`price-summary ${compact ? 'compact' : ''}`}>
    {!compact && <div><span>本场原价合计</span><span>{formatMoney(quote.listTotal, currency)}</span></div>}
    {!!quote.thresholdDiscount && <div><span>满减优惠</span><span>−{formatMoney(quote.thresholdDiscount, currency)}</span></div>}
    {!!quote.orderDiscount && <div><span>整单人工优惠</span><span>−{formatMoney(quote.orderDiscount, currency)}</span></div>}
    <div className="strong"><span>共优惠</span><span>{formatMoney(quote.discount, currency)}</span></div>
  </div>;
}
export function PromotionHint({ rules, currency }: { rules?: PromotionRules; currency: Currency }) {
  if (!rules?.tiers.length) return null;
  return <p className="promotion-hint small">{rules.tiers.map(t => `满 ${formatMoney(t.threshold, currency)} 减 ${formatMoney(t.reduction, currency)}`).join('；')} · 按参与商品本场原价计算，取最高一档</p>;
}
export interface EditablePriceLine extends PriceLine { name: string; sourceItemId?: string }
export function AdjustmentEditor({ initialLines, initialManual, rules, currency, onClose, onSave }: {
  initialLines: EditablePriceLine[]; initialManual?: OrderAdjustment; rules: PromotionRules; currency: Currency;
  onClose: () => void;
  onSave: (lines: EditablePriceLine[], manual: OrderAdjustment | undefined, reason: string, pin: string) => Promise<void>;
}) {
  const [lines, setLines] = useState(initialLines);
  const [manual, setManual] = useState(initialManual);
  const [target, setTarget] = useState(initialLines[0]?.lineId ?? '');
  const [quantity, setQuantity] = useState('1');
  const [kind, setKind] = useState<'price' | 'rate'>('price');
  const [value, setValue] = useState('');
  const [orderKind, setOrderKind] = useState<'total' | 'rate'>('total');
  const [orderValue, setOrderValue] = useState('');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const security = useAsync(requiresAdjustmentPin, []);
  let quote: Quote | null = null, quoteError: string | null = null;
  try { quote = priceOrder(lines, rules.tiers, manual); } catch (e) { quoteError = errorMessage(e); }
  const parseDiscount = (text: string, rate: boolean) => {
    if (rate) {
      if (!/^(?:10|[0-9])(?:\.\d{1,2})?$/.test(text.trim())) throw new Error('请输入 0 至 10 折，最多两位小数');
      const number = Math.round(Number(text) * 1000);
      if (number > 10000) throw new Error('折扣不能超过 10 折');
      return number;
    }
    return parseAmountToMinor(text, currency);
  };
  function applyLine() {
    try {
      const original = lines.find(l => l.lineId === target);
      if (!original) throw new Error('请选择商品');
      const qty = Number(quantity);
      if (!Number.isInteger(qty) || qty <= 0 || qty > original.quantity) throw new Error('优惠件数应为 1 至该明细的数量');
      const adjustment = { kind, value: parseDiscount(value, kind === 'rate') };
      adjustedUnit(original.autoUnit, adjustment);
      const changed = { ...original, quantity: qty, manual: adjustment };
      const next = qty === original.quantity ? lines.map(l => l.lineId === target ? changed : l)
        : lines.flatMap(l => l.lineId === target ? [{ ...l, quantity: l.quantity - qty }, { ...changed, lineId: newId(), sourceItemId: original.sourceItemId ?? original.lineId }] : [l]);
      setLines(next); setManual(undefined); setOrderValue(''); setValue(''); setError(null);
    } catch (e) { setError(errorMessage(e)); }
  }
  return <Modal title="人工优惠" onClose={busy ? undefined : onClose} className="pricing-dialog" actions={<>
    <button disabled={busy} onClick={onClose}>取消</button>
    <button className="primary" disabled={busy || !quote || security.loading || !!security.error || !reason.trim() || (!!security.data && !/^\d{4,8}$/.test(pin))} onClick={async () => {
      setBusy(true); setError(null);
      try { await onSave(lines, manual, reason.trim(), pin); } catch (e) { setError(errorMessage(e)); }
      finally { setBusy(false); }
    }}>{busy ? '保存中…' : '保存优惠'}</button>
  </>}>
    <p className="small muted">仅在尚未付款时调整。单品改价不影响满减门槛；修改单品后，整单人工优惠需要重新设置。</p>
    <div className="pricing-lines">{lines.map(l => <div className="pricing-line" key={l.lineId}>
      <div><strong>{l.name}</strong><div className="small muted">{l.quantity} 件 · 活动单价 {formatMoney(l.autoUnit, currency)}{l.manual ? ` → ${formatMoney(adjustedUnit(l.autoUnit, l.manual), currency)}` : ''}</div></div>
      {l.manual && <button className="small" onClick={() => { setLines(lines.map(v => v.lineId === l.lineId ? { ...v, manual: undefined } : v)); setManual(undefined); }}>恢复活动价</button>}
    </div>)}</div>
    <fieldset><legend>单品优惠</legend>
      <label>选择明细<select aria-label="调价商品" value={target} onChange={e => { setTarget(e.target.value); setQuantity('1'); }}>{lines.map(l => <option key={l.lineId} value={l.lineId}>{l.name} ×{l.quantity}{l.manual ? '（已调价）' : ''}</option>)}</select></label>
      <div className="pricing-inputs"><label>优惠件数<input aria-label="优惠件数" type="number" min="1" value={quantity} onChange={e => setQuantity(e.target.value)} /></label>
        <label>方式<select value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option value="price">设置单价</option><option value="rate">打折</option></select></label>
        <label>{kind === 'rate' ? '折扣（8 表示八折）' : '每件优惠价'}<input aria-label="单品优惠值" inputMode="decimal" value={value} onChange={e => setValue(e.target.value)} /></label>
      </div><button onClick={applyLine}>应用单品优惠</button>
    </fieldset>
    <fieldset><legend>整单优惠</legend><div className="pricing-inputs">
      <select aria-label="整单优惠方式" value={orderKind} onChange={e => setOrderKind(e.target.value as typeof orderKind)}><option value="total">设置最终应收</option><option value="rate">满减后再打折</option></select>
      <input aria-label="整单优惠值" inputMode="decimal" placeholder={orderKind === 'rate' ? '如 9.5，表示九五折' : '输入最终应收金额'} value={orderValue} onChange={e => setOrderValue(e.target.value)} />
      <button onClick={() => { try { const next = { kind: orderKind, value: parseDiscount(orderValue, orderKind === 'rate') }; priceOrder(lines, rules.tiers, next); setManual(next); setError(null); } catch (e) { setError(errorMessage(e)); } }}>应用</button>
    </div>{manual && <button className="small" onClick={() => { setManual(undefined); setOrderValue(''); }}>取消整单人工优惠</button>}</fieldset>
    <PriceSummary quote={quote} currency={currency} />
    <div className="row"><strong>最终应收</strong><span className="spacer"/><strong className="big-price">{quote ? formatMoney(quote.total, currency) : '请检查优惠'}</strong></div>
    <label>调价原因<input value={reason} maxLength={200} onChange={e => setReason(e.target.value)} placeholder="例如：瑕疵品优惠、摊主特批" /></label>
    {security.data && <label>输入后台密码确认<input aria-label="调价确认密码" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} /></label>}
    <ErrorBox message={error ?? quoteError ?? security.error} />
  </Modal>;
}
