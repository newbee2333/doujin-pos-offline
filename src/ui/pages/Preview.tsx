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
  // 分类胶囊必须是能点的 —— 预览的用处就是「按游客的方式翻一遍」，
  // 只画出一排不可点的胶囊，摊主会以为是自己点错了。
  // 选中态与过滤口径都跟游客菜单（KioskMenu）保持一致，别在这里再写一套。
  const [category, setCategory] = useState('');
  const [cartCount, setCartCount] = useState(0);

  const menu = useAsync(() => (eventId ? getKioskMenu(eventId) : Promise.resolve([])), [eventId]);
  const cats = useAsync(() => listCategories(false), []);
  const frame = FRAMES[frameIdx];

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return (menu.data ?? []).filter((m) => {
      if (category && m.category_id !== category) return false;
      if (kw) {
        // 搜索框写着「搜索商品名 / 分类」，就得真的能按分类搜 —— 游客菜单是这么做的。
        const hay = `${m.product_name} ${m.variant_name} ${m.sku ?? ''} ${m.category_name ?? ''}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [menu.data, category, keyword]);

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
          <button className={`chip ${category === '' ? 'active' : ''}`} onClick={() => setCategory('')}>
            全部
          </button>
          {cats.data?.map((c) => (
            <button
              key={c.id}
              className={`chip ${category === c.id ? 'active' : ''}`}
              onClick={() => setCategory(c.id)}
            >
              {c.name}
            </button>
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
            {!filtered.length ? <p className="muted">没有找到商品。</p> : null}
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
