/**
 * 商品规格选择器：收起时一行摘要，点开是**游客菜单那套商品卡** + 一个搜索框。
 *
 * 起因：套装成分原来是原生 <select>，把「商品名（规格名）」拼成一行文本。
 * 商品一多就退化成一条长列表 —— 名字往往只差「上卷 / 下卷」，封面又完全看不见，
 * 只能挨个读过去。现在展开后直接复用 MenuCard：摊主挑成分要的正是
 * 「看封面翻」的那套体验，和游客菜单、菜单预览用的是同一份标记，
 * 免得又出现「改版只改了菜单、选择器停在旧样式」这种漂移。
 *
 * 不默认铺开：一个套装可能有好几条成分，每行都挂一片卡片墙太重，
 * 而摊主多数时候只是确认一下「这条成分是不是它」。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import MenuCard from './MenuCard';
import { useAssetUrl } from './components';
import { filterVariantOptions, type VariantOption } from './variant-filter';

// 过滤与类型放在不依赖 React 的模块里，好单独测；这里转出去，
// 调用方（商品编辑器）只认识这一个入口。
export { filterVariantOptions, type VariantOption };

/** 摘要行里的小缩略图。没有封面时什么都不画 —— 36px 见方放不下「无图片」三个字。 */
function Thumb({ assetId, alt }: { assetId: string | null; alt: string }) {
  const url = useAssetUrl(assetId);
  if (!url) return <span className="vp-thumb" aria-hidden="true" />;
  return <img className="vp-thumb" src={url} alt={alt} />;
}

export default function VariantPicker({
  options,
  value,
  onChange,
  placeholder = '选择商品规格'
}: {
  options: VariantOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const wrap = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.id === value) ?? null;
  const list = useMemo(() => filterVariantOptions(options, keyword), [options, keyword]);

  // 点外面 / Esc 收起。用 pointerdown 而不是 click：
  // 面板里的卡片点下去会先冒泡到这里，用 click 会「刚点开就被关掉」。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pick(id: string) {
    onChange(id);
    setOpen(false);
    setKeyword('');
  }

  return (
    <div className="variant-picker" ref={wrap}>
      <button
        type="button"
        className="vp-toggle"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          setKeyword('');
        }}
      >
        {selected ? <Thumb assetId={selected.item.cover_asset_id} alt={selected.item.product_name} /> : null}
        <span className="vp-toggle-text">
          {selected ? (
            <>
              <span className="vp-name">{selected.item.product_name}</span>
              <span className="vp-sub">{selected.item.variant_name}</span>
            </>
          ) : (
            <span className="vp-placeholder">{placeholder}</span>
          )}
        </span>
        <span className="vp-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div className="vp-panel">
          <input
            className="vp-search"
            type="search"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- 面板是用户主动点开的，焦点就该落在搜索框
            autoFocus
            placeholder="搜索商品名 / 规格 / SKU"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <div className="vp-grid">
            {list.map((o) => (
              <MenuCard
                key={o.id}
                item={o.item}
                selected={o.id === value}
                onPick={() => pick(o.id)}
              />
            ))}
          </div>
          {!list.length ? (
            <p className="vp-empty">{options.length ? '没有匹配的商品' : '还没有可选的商品'}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
