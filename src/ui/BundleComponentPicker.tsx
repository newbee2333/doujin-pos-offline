import { useEffect, useMemo, useRef, useState } from 'react';
import type { BundleComponentInput } from '../services/catalog';
import { AssetImage, Modal } from './components';
import { filterVariantOptions, type VariantOption } from './variant-filter';

export function BundleComponentRow({ component, option, onQuantity, onRemove }: {
  component: BundleComponentInput;
  option?: VariantOption;
  onQuantity: (quantity: number) => void;
  onRemove: () => void;
}) {
  const name = option?.item.product_name ?? '商品已不可用';
  const valid = Number.isSafeInteger(component.quantity) && component.quantity > 0;
  return (
    <article className="bundle-member" aria-label={name}>
      <AssetImage assetId={option?.item.cover_asset_id} alt="" className="bundle-member-thumb" />
      <div className="bundle-member-info">
        <strong>{name}</strong>
        <span className="tiny muted">{option?.item.variant_name}{option?.archived ? ' · 已归档' : ''}</span>
        {option?.sku ? <span className="tiny muted">SKU {option.sku}</span> : null}
      </div>
      <div className="bundle-member-controls">
        <span className="tiny muted">每套</span>
        <div className="bundle-quantity">
          <button type="button" aria-label={`减少 ${name} 用量`} disabled={component.quantity <= 1}
            onClick={() => onQuantity(Math.max(1, component.quantity - 1))}>−</button>
          <input type="number" min={1} step={1} inputMode="numeric" aria-label={`${name} 每套数量`}
            aria-invalid={!valid} value={component.quantity || ''} onChange={e => onQuantity(Number(e.target.value))} />
          <button type="button" aria-label={`增加 ${name} 用量`} onClick={() => onQuantity(component.quantity + 1)}>+</button>
        </div>
        <button type="button" className="small ghost" aria-label={`移除 ${name}`} onClick={onRemove}>移除</button>
      </div>
    </article>
  );
}

/** A separate selection step replaces per-row nested popovers. Nothing is
 * written until the parent product editor is saved. */
export default function BundleComponentPicker({ options, components, onApply, onCancel }: {
  options: VariantOption[];
  components: BundleComponentInput[];
  onApply: (components: BundleComponentInput[]) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => components.map(row => ({ ...row })));
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [tab, setTab] = useState<'catalog' | 'selected'>('catalog');
  const content = useRef<HTMLDivElement>(null);
  const selectedIds = useMemo(() => new Set(draft.map(row => row.component_variant_id)), [draft]);
  const byId = useMemo(() => new Map(options.map(option => [option.id, option])), [options]);
  const categories = useMemo(() => Array.from(new Map(options.map(option => [option.categoryId ?? 'uncategorized', option.item.category_name ?? '未分类'])).entries()), [options]);
  const visible = useMemo(() => filterVariantOptions(options, keyword).filter(option =>
    (!category || (option.categoryId ?? 'uncategorized') === category) &&
    (showArchived || !option.archived || selectedIds.has(option.id))
  ), [options, keyword, category, showArchived, selectedIds]);
  const invalid = draft.some(row => !byId.has(row.component_variant_id) || !Number.isSafeInteger(row.quantity) || row.quantity <= 0);
  const totalUnits = draft.reduce((sum, row) => sum + row.quantity, 0);

  useEffect(() => {
    const modal = content.current?.closest<HTMLElement>('.modal');
    modal?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
      if (event.key !== 'Tab' || !modal) return;
      const controls = Array.from(modal.querySelectorAll<HTMLElement>('button, input, select, [tabindex]'))
        .filter(el => el.getClientRects().length && !el.matches(':disabled') && el.tabIndex >= 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === modal)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === modal)) {
        event.preventDefault(); first?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  function toggle(id: string) {
    setDraft(rows => rows.some(row => row.component_variant_id === id) ? rows.filter(row => row.component_variant_id !== id)
      : [...rows, { component_variant_id: id, quantity: 1 }]);
  }

  return (
    <Modal title="选择套装商品" className="bundle-picker-modal" onClose={onCancel} actions={<>
      <span className="bundle-picker-summary" role="status">已选 {draft.length} 种{!invalid && draft.length ? ` · 每套共 ${totalUnits} 件` : ''}</span>
      <button type="button" onClick={onCancel}>取消</button>
      <button type="button" className="primary" disabled={!draft.length || invalid} onClick={() => onApply(draft)}>确认选择（{draft.length} 种）</button>
    </>}>
      <div className="bundle-picker" ref={content}>
        <p className="small muted bundle-picker-hint">可连续勾选多个商品，再调整每套用量。确认选择后回到编辑页，保存商品才会生效。</p>
        <div className="bundle-picker-tools">
          <input type="search" aria-label="搜索套装成分" placeholder="搜索商品名 / 规格 / SKU / 原作" value={keyword} onChange={e => setKeyword(e.target.value)} />
          <select aria-label="成分分类" value={category} onChange={e => setCategory(e.target.value)}>
            <option value="">全部分类</option>
            {categories.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          {options.some(option => option.archived) ? <label className="check"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />显示已归档</label> : null}
        </div>
        <div className="bundle-picker-tabs">
          <button type="button" className={tab === 'catalog' ? 'primary' : ''} aria-pressed={tab === 'catalog'} onClick={() => setTab('catalog')}>商品库（{visible.length}）</button>
          <button type="button" className={tab === 'selected' ? 'primary' : ''} aria-pressed={tab === 'selected'} onClick={() => setTab('selected')}>已选商品（{draft.length}）</button>
        </div>
        <div className="bundle-picker-workspace" data-tab={tab}>
          <section className="bundle-catalog" aria-label="可选成分">
            <div className="bundle-section-title">普通库存商品 <span className="muted">{visible.length} 项</span></div>
            <div className="bundle-candidates">
              {visible.map(option => <label key={option.id} className={`bundle-candidate${selectedIds.has(option.id) ? ' selected' : ''}`}>
                <AssetImage assetId={option.item.cover_asset_id} alt="" className="bundle-candidate-thumb" />
                <span className="bundle-candidate-info">
                  <strong>{option.item.product_name}</strong>
                  <span className="tiny muted">{[option.item.category_name, option.item.variant_name !== '默认规格' ? option.item.variant_name : null].filter(Boolean).join(' · ') || '默认规格'}</span>
                  {option.sku ? <span className="tiny muted">SKU {option.sku}</span> : null}
                  {option.archived ? <span className="tiny muted">已归档</span> : null}
                </span>
                <input type="checkbox" aria-label={`选择 ${option.item.product_name} · ${option.item.variant_name}`} checked={selectedIds.has(option.id)} onChange={() => toggle(option.id)} />
              </label>)}
              {!visible.length ? <div className="bundle-picker-empty"><strong>没有匹配的商品</strong><p>成分仅支持普通库存商品，试试其他关键词或分类。</p><button type="button" onClick={() => { setKeyword(''); setCategory(''); setShowArchived(true); }}>重置筛选</button></div> : null}
            </div>
          </section>
          <section className="bundle-selection" aria-label="已选成分">
            <div className="bundle-section-title">已选商品 <span className="muted">{draft.length} 种</span></div>
            <div className="bundle-selected-list">
              {draft.map(row => <BundleComponentRow key={row.component_variant_id} component={row} option={byId.get(row.component_variant_id)}
                onQuantity={quantity => setDraft(rows => rows.map(item => item.component_variant_id === row.component_variant_id ? { ...item, quantity } : item))}
                onRemove={() => setDraft(rows => rows.filter(item => item.component_variant_id !== row.component_variant_id))} />)}
              {!draft.length ? <div className="bundle-picker-empty"><strong>还未选择商品</strong><p>勾选商品后，在这里调整每套用量。</p></div> : null}
            </div>
            {invalid ? <p className="notice danger">请移除不可用的商品，并为每项填写正整数用量。</p> : null}
          </section>
        </div>
      </div>
    </Modal>
  );
}
