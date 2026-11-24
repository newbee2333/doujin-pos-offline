import { useEffect, useMemo, useState } from 'react';
import { getEvent } from '../../services/events';
import { getKioskMenu } from '../../services/orders';
import { listCategories } from '../../services/catalog';
import { getBoothName, getLandscapeCartEnabled } from '../../services/system';
import { stockLabel, type MenuItem } from '../../domain/types';
import { useApp, type CartItem } from '../../store';
import { ErrorBox, Spinner, useAsync } from '../components';
import MenuCard, { effectiveItemMax } from '../MenuCard';
import MenuOrder from '../MenuOrder';
import KioskSideCart from '../KioskSideCart';
import KioskCatalogHeader from '../KioskCatalogHeader';
import KioskItemDetailModal from '../KioskItemDetailModal';
import { getThresholdStatus, PromotionHint, useCartQuote } from '../Pricing';
import { formatMoney } from '../../domain/money';

const FRAMES = [
  { key: 'ipad-landscape', label: '平板横屏 1180×820', width: 1180, height: 820 },
  { key: 'ipad-portrait', label: '平板竖屏 820×1180', width: 820, height: 1180 },
  { key: 'phone', label: '手机 390×844', width: 390, height: 844 }
];

/**
 * 菜单预览：使用真实商品配置，但不生成订单、付款或库存变化。
 * 与游客菜单共享刊头、商品卡、详情弹层与侧栏购物车，确保所见即所得。
 */
export default function PreviewPage() {
  const eventId = useApp((s) => s.currentEventId);
  const unlocked = useApp((s) => s.staffUnlocked);
  const [frameIdx, setFrameIdx] = useState(0);
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [previewCart, setPreviewCart] = useState<CartItem[]>([]);
  const [detail, setDetail] = useState<MenuItem | null>(null);
  const [detailQty, setDetailQty] = useState(1);
  const [sorting, setSorting] = useState(false);

  const event = useAsync(() => (eventId ? getEvent(eventId) : Promise.resolve(null)), [eventId]);
  const boothName = useAsync(getBoothName, []);
  const menu = useAsync(() => (eventId ? getKioskMenu(eventId) : Promise.resolve([])), [eventId]);
  const cats = useAsync(() => listCategories(false), []);
  const layout = useAsync(getLandscapeCartEnabled, []);
  const quote = useCartQuote(eventId, previewCart);
  const frame = FRAMES[frameIdx];
  const cartCount = previewCart.reduce((sum, item) => sum + item.quantity, 0);
  const totalMinor = quote.data?.total ?? 0;
  const currency = (event.data?.currency ?? menu.data?.[0]?.currency ?? 'CNY') as MenuItem['currency'];
  const threshold = getThresholdStatus(quote.data, currency);

  const visibleCategories = useMemo(() => {
    const used = new Set((menu.data ?? []).map((m) => m.category_id).filter(Boolean));
    return (cats.data ?? []).filter((c) => used.has(c.id));
  }, [cats.data, menu.data]);

  useEffect(() => {
    setPreviewCart([]);
    setCategory('');
    setDetail(null);
  }, [eventId]);

  useEffect(() => {
    if (!menu.loading && category && !visibleCategories.some((c) => c.id === category)) {
      setCategory('');
    }
  }, [menu.loading, category, visibleCategories]);

  function setPreviewQty(item: MenuItem, quantity: number) {
    const cap = effectiveItemMax(item);
    const clamped = cap !== null ? Math.min(quantity, cap) : quantity;
    setPreviewCart((rows) => {
      if (clamped <= 0) return rows.filter((row) => row.variantId !== item.variant_id);
      const nextItem: CartItem = {
        variantId: item.variant_id,
        productName: item.product_name,
        variantName: item.variant_name,
        priceMinor: item.price_minor,
        quantity: clamped,
        maxAvailable: cap,
        coverAssetId: item.cover_asset_id
      };
      const exists = rows.some((row) => row.variantId === item.variant_id);
      return exists ? rows.map((row) => (row.variantId === item.variant_id ? nextItem : row)) : [...rows, nextItem];
    });
  }

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return (menu.data ?? []).filter((m) => {
      if (category && m.category_id !== category) return false;
      if (inStockOnly && stockLabel(m) === '售罄') return false;
      if (kw) {
        const hay = `${m.product_name} ${m.variant_name} ${m.sku ?? ''} ${m.category_name ?? ''}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [menu.data, category, inStockOnly, keyword]);

  if (!eventId) return <ErrorBox message="请先选择展会" />;
  if (menu.loading || layout.loading) {
    return (
      <div className="center-page">
        <Spinner label="读取菜单…" />
      </div>
    );
  }
  if (menu.error || layout.error) return <ErrorBox message={menu.error ?? layout.error} />;

  return (
    <div className="page">
      <div className="row">
        <h1 style={{ margin: 0 }}>菜单预览</h1>
        <span className="spacer" />
        <button
          disabled={!menu.data?.length || !unlocked}
          title={unlocked ? '调整本场游客菜单的商品顺序' : '请先解锁后台再调整顺序'}
          onClick={() => setSorting(true)}
        >
          调整顺序
        </button>
        <select value={frameIdx} onChange={(e) => setFrameIdx(Number(e.target.value))} style={{ maxWidth: 260 }}>
          {FRAMES.map((f, i) => (
            <option key={f.key} value={i}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      {sorting && unlocked && menu.data ? (
        <MenuOrder
          key={eventId}
          eventId={eventId}
          items={menu.data}
          onClose={() => setSorting(false)}
          onSaved={() => {
            setSorting(false);
            menu.reload();
          }}
        />
      ) : null}
      <p className="small muted">
        预览使用本场真实商品配置，但不会产生订单、收款或库存变化。共 {filtered.length} 个规格 ·{' '}
        {visibleCategories.length} 个有货分类。
      </p>

      <div
        className={`preview-frame${frame.width > frame.height && layout.data ? ' landscape-cart-preview' : ''}`}
        style={{ maxWidth: '100%', width: frame.width, height: frame.height, overflow: 'auto', marginTop: 10 }}
      >
        <div className="preview-badge">预览模式 · 不会产生任何真实业务数据</div>
        <KioskCatalogHeader
          boothName={boothName.data}
          eventName={event.data?.name}
          boothNumber={event.data?.booth_number}
          preview
          itemCount={filtered.length}
          categories={visibleCategories}
          activeCategory={category}
          onSelectCategory={setCategory}
          inStockOnly={inStockOnly}
          onToggleInStockOnly={() => setInStockOnly((v) => !v)}
          keyword={keyword}
          onKeywordChange={setKeyword}
        />
        <PromotionHint rules={quote.data?.rules} currency={currency} />
        <div className="kiosk-menu-body">
          <div className="menu-grid">
            {filtered.map((item) => {
              const inCartQty = previewCart.find((row) => row.variantId === item.variant_id)?.quantity ?? 0;
              return (
                <MenuCard
                  key={item.variant_id}
                  item={item}
                  inCartQty={inCartQty}
                  onAdd={() => setPreviewQty(item, inCartQty + 1)}
                  onSetQty={(v) => setPreviewQty(item, v)}
                  onOpenDetail={() => {
                    if (stockLabel(item) === '售罄') return;
                    setDetailQty(Math.max(1, inCartQty || 1));
                    setDetail(item);
                  }}
                />
              );
            })}
            {!filtered.length ? (
              <div className="kiosk-empty">
                <strong>{inStockOnly ? '当前筛选下暂无现货' : '没有找到商品'}</strong>
                <p>{inStockOnly ? '可以关闭「仅看有货」查看全部商品。' : '试试其他关键词或分类。'}</p>
              </div>
            ) : null}
          </div>
          <KioskSideCart
            cart={previewCart}
            currency={currency}
            quote={quote.data}
            preview
            onSetQty={(id, qty) => {
              const item = menu.data?.find((m) => m.variant_id === id);
              if (item) setPreviewQty(item, qty);
            }}
            onClear={() => setPreviewCart([])}
            onCheckout={() => {}}
          />
        </div>
        <div className="cart-bar" style={{ position: 'sticky', bottom: 0 }}>
          <span className="count">{cartCount}</span>
          <div className="cart-bar-main">
            <span className="strong">{formatMoney(totalMinor, currency)}</span>
            {threshold ? <span className="cart-bar-nudge">{threshold.compactText}</span> : null}
          </div>
          <span className="spacer" />
          <button disabled>去结算（预览不产生订单）</button>
        </div>
      </div>

      {detail ? (
        <KioskItemDetailModal
          item={detail}
          qty={detailQty}
          inCartQty={previewCart.find((row) => row.variantId === detail.variant_id)?.quantity ?? 0}
          preview
          onQtyChange={setDetailQty}
          onClose={() => setDetail(null)}
          onAdd={(q) => {
            setPreviewQty(detail, q);
            setDetail(null);
          }}
        />
      ) : null}
    </div>
  );
}
