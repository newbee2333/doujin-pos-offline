import type { Category } from '../domain/types';

/**
 * 游客菜单与菜单预览共享的单行紧凑刊头。
 * 保持同一组件实现，彻底避免两处布局漂移；
 * 预览态下始终保留「商品目录（预览）」文本以区分真实菜单并满足自动化验收。
 */
export default function KioskCatalogHeader({
  boothName,
  eventName,
  boothNumber,
  preview = false,
  itemCount,
  categories,
  activeCategory,
  onSelectCategory,
  inStockOnly,
  onToggleInStockOnly,
  keyword,
  onKeywordChange,
  onStaffClick
}: {
  boothName?: string | null;
  eventName?: string | null;
  boothNumber?: string | null;
  preview?: boolean;
  itemCount: number;
  categories: Category[];
  activeCategory: string;
  onSelectCategory: (id: string) => void;
  inStockOnly: boolean;
  onToggleInStockOnly: () => void;
  keyword: string;
  onKeywordChange: (kw: string) => void;
  onStaffClick?: () => void;
}) {
  const custom = boothName?.trim() || '';
  const ev = eventName?.trim() || '';
  const booth = boothNumber?.trim() || '';

  const baseTitle = custom || ev || '商品目录';
  const titleText = preview ? (custom || ev ? `${baseTitle}` : '商品目录（预览）') : baseTitle;
  const subParts: string[] = [];
  if (preview && titleText !== '商品目录（预览）') subParts.push('商品目录（预览）');
  else if (!preview && custom && ev) subParts.push(ev);
  subParts.push(`共 ${itemCount} 件商品`);

  const stampText = booth || baseTitle.slice(0, 1) || 'D';

  return (
    <div className="kiosk-hero">
      <div className="kiosk-hero-top">
        <div className="kiosk-hero-head">
          <span className="booth-stamp" title={booth ? `摊位号 ${booth}` : undefined} aria-hidden={!booth}>
            {stampText}
          </span>
          <div className="kiosk-hero-titles">
            {preview ? (
              <div className="kiosk-hero-title">{titleText}</div>
            ) : (
              <h1 className="kiosk-hero-title">{titleText}</h1>
            )}
            <div className="kiosk-hero-sub">{subParts.join(' · ')}</div>
          </div>
        </div>

        <div className="chip-row kiosk-chips">
          <button
            type="button"
            className={`chip ${activeCategory === '' ? 'active' : ''}`}
            aria-pressed={activeCategory === ''}
            onClick={() => onSelectCategory('')}
          >
            全部
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`chip ${activeCategory === c.id ? 'active' : ''}`}
              aria-pressed={activeCategory === c.id}
              onClick={() => onSelectCategory(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>

        <button
          type="button"
          className={`in-stock-toggle${inStockOnly ? ' active' : ''}`}
          aria-pressed={inStockOnly}
          onClick={onToggleInStockOnly}
          title="隐藏已售罄商品"
        >
          仅看有货
        </button>

        <div className="kiosk-search">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.2-3.2" />
          </svg>
          <input
            type="search"
            aria-label="搜索商品名或分类"
            placeholder="搜索商品"
            value={keyword}
            onChange={(e) => onKeywordChange(e.target.value)}
          />
          {keyword ? (
            <button
              type="button"
              className="kiosk-search-clear"
              aria-label="清空搜索"
              onClick={() => onKeywordChange('')}
            >
              ×
            </button>
          ) : null}
        </div>

        <button
          type="button"
          className="small ghost"
          disabled={preview}
          onClick={onStaffClick}
        >
          摊主处理
        </button>
      </div>
    </div>
  );
}
