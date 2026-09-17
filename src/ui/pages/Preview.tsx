import { useMemo, useState } from 'react';
import { getKioskMenu } from '../../services/orders';
import { listCategories } from '../../services/catalog';
import { formatMoney } from '../../domain/money';
import { useApp } from '../../store';
import { ErrorBox, Spinner, useAsync } from '../components';
import MenuCard from '../MenuCard';

const FRAMES = [
  { key: 'ipad-landscape', label: '平板横屏 1180×820', width: 1180, height: 820 },
  { key: 'ipad-portrait', label: '平板竖屏 820×1180', width: 820, height: 1180 },
  { key: 'phone', label: '手机 390×844', width: 390, height: 844 }
];

/**
 * 菜单预览：使用真实商品配置，但不生成订单、付款或库存变化。
 * 结算按钮在此明确标记为预览，不执行任何业务写入。
 */
export default function PreviewPage() {
  const eventId = useApp((s) => s.currentEventId);
  const [frameIdx, setFrameIdx] = useState(0);
  const [keyword, setKeyword] = useState('');
  const [cartCount, setCartCount] = useState(0);

  const menu = useAsync(() => (eventId ? getKioskMenu(eventId) : Promise.resolve([])), [eventId]);
  const cats = useAsync(() => listCategories(false), []);
  const frame = FRAMES[frameIdx];

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return (menu.data ?? []).filter((m) =>
      !kw || `${m.product_name} ${m.variant_name} ${m.sku ?? ''}`.toLowerCase().includes(kw)
    );
  }, [menu.data, keyword]);

  if (!eventId) return <ErrorBox message="请先选择展会" />;
  if (menu.loading) {
    return (
      <div className="center-page">
        <Spinner label="读取菜单…" />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="row">
        <h1 style={{ margin: 0 }}>菜单预览</h1>
        <span className="spacer" />
        <select value={frameIdx} onChange={(e) => setFrameIdx(Number(e.target.value))} style={{ maxWidth: 260 }}>
          {FRAMES.map((f, i) => (
            <option key={f.key} value={i}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      <p className="small muted">
        预览使用本场真实商品配置，但不会产生订单、收款或库存变化。共 {filtered.length} 个规格 ·{' '}
        {cats.data?.length ?? 0} 个可见分类。
      </p>

      <div
        className="preview-frame"
        style={{ maxWidth: '100%', width: frame.width, height: frame.height, overflow: 'auto', marginTop: 10 }}
      >
        <div className="preview-badge">预览模式 · 不会产生任何真实业务数据</div>
        <div className="kiosk-hero">
          <div className="kiosk-hero-top">
            <div style={{ flex: 1, minWidth: 0 }}>
              {/* 必须保留「（预览）」：预览画框要一眼能看出不是真实游客菜单，
                  否则截图/投屏时可能被当成顾客界面。CI 有断言守着这一点。 */}
              <div className="kiosk-hero-title">商品目录（预览）</div>
              <div className="kiosk-hero-sub">共 {filtered.length} 件在售</div>
            </div>
          </div>
          <div className="kiosk-search">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.2-3.2" />
            </svg>
            <input
              type="search"
              placeholder="搜索商品名 / 分类"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
        </div>
        <div className="chip-row">
          <span className="chip active">全部</span>
          {cats.data?.map((c) => (
            <span key={c.id} className="chip">
              {c.name}
            </span>
          ))}
        </div>
        <div className="menu-grid">
            {filtered.map((item) => (
              <MenuCard
                key={item.variant_id}
                item={item}
                onAdd={() => setCartCount((c) => c + 1)}
                onSetQty={(v) => setCartCount(v)}
                onOpenDetail={() => {}}
              />
            ))}
        </div>
        <div className="cart-bar" style={{ position: 'sticky', bottom: 0 }}>
          <span className="count">{cartCount}</span>
          <span className="spacer" />
          <button disabled>去结算（预览不产生订单）</button>
        </div>
      </div>
    </div>
  );
}
