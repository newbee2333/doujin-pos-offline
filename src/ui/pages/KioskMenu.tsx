import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getEvent } from '../../services/events';
import { getKioskMenu } from '../../services/orders';
import { listCategories } from '../../services/catalog';
import { getBoothName, getLandscapeCartEnabled } from '../../services/system';
import { formatMoney } from '../../domain/money';
import { stockLabel, type MenuItem } from '../../domain/types';
import { useApp } from '../../store';
import { ErrorBox, Modal, Spinner, useAsync } from '../components';
import MenuCard, { effectiveItemMax } from '../MenuCard';
import KioskSideCart from '../KioskSideCart';
import KioskCatalogHeader from '../KioskCatalogHeader';
import KioskItemDetailModal from '../KioskItemDetailModal';
import { getThresholdStatus, PromotionHint, useCartQuote } from '../Pricing';

export default function KioskMenuPage() {
  const navigate = useNavigate();
  const eventId = useApp((s) => s.currentEventId);
  const cart = useApp((s) => s.cart);
  const setCart = useApp((s) => s.setCart);
  const clearCart = useApp((s) => s.clearCart);

  const [category, setCategory] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [detail, setDetail] = useState<MenuItem | null>(null);
  const [qty, setQty] = useState(1);
  const [clearing, setClearing] = useState(false);
  const [pop, setPop] = useState(false);

  const event = useAsync(() => (eventId ? getEvent(eventId) : Promise.resolve(null)), [eventId]);
  const boothName = useAsync(getBoothName, []);
  const menu = useAsync(() => (eventId ? getKioskMenu(eventId) : Promise.resolve([])), [eventId]);
  const cats = useAsync(() => listCategories(false), []);
  const layout = useAsync(getLandscapeCartEnabled, []);
  const quote = useCartQuote(eventId, cart);

  // 自动隐藏本场 0 商品的空分类，减少逛摊视觉噪音
  const visibleCategories = useMemo(() => {
    const used = new Set((menu.data ?? []).map((m) => m.category_id).filter(Boolean));
    return (cats.data ?? []).filter((c) => used.has(c.id));
  }, [cats.data, menu.data]);

  // 选中分类若已变为 0 商品被隐藏，自动回退到「全部」
  useEffect(() => {
    if (!menu.loading && category && !visibleCategories.some((c) => c.id === category)) {
      setCategory('');
    }
  }, [menu.loading, category, visibleCategories]);

  // 菜单刷新后同步校准购物车里的单价、限购/库存上限，并自动移除已下架或已归档项
  useEffect(() => {
    if (menu.loading || !menu.data || !cart.length) return;
    const byId = new Map(menu.data.map((m) => [m.variant_id, m]));
    let changed = false;
    const synced = cart.flatMap((c) => {
      const m = byId.get(c.variantId);
      if (!m) {
        changed = true;
        return [];
      }
      const cap = effectiveItemMax(m);
      const nextQty = cap !== null && cap > 0 ? Math.min(c.quantity, cap) : c.quantity;
      if (
        c.maxAvailable !== cap ||
        c.priceMinor !== m.price_minor ||
        c.quantity !== nextQty ||
        c.coverAssetId !== m.cover_asset_id
      ) {
        changed = true;
        return [{ ...c, priceMinor: m.price_minor, maxAvailable: cap, quantity: nextQty, coverAssetId: m.cover_asset_id }];
      }
      return [c];
    });
    if (changed) setCart(synced);
  }, [menu.loading, menu.data, cart, setCart]);

  const filtered = useMemo(() => {
    const list = menu.data ?? [];
    const kw = keyword.trim().toLowerCase();
    return list.filter((m) => {
      if (category && m.category_id !== category) return false;
      if (inStockOnly && stockLabel(m) === '售罄') return false;
      if (kw) {
        const hay = `${m.product_name} ${m.variant_name} ${m.sku ?? ''} ${m.category_name ?? ''}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [menu.data, category, inStockOnly, keyword]);

  const totalQty = cart.reduce((a, c) => a + c.quantity, 0);
  const totalMinor = quote.data?.total ?? 0;
  const currency = (event.data?.currency ?? menu.data?.[0]?.currency ?? 'CNY') as MenuItem['currency'];
  const threshold = getThresholdStatus(quote.data, currency);

  const prevQty = useRef(totalQty);
  useEffect(() => {
    if (totalQty > prevQty.current) {
      setPop(false);
      const id = requestAnimationFrame(() => setPop(true));
      const timer = window.setTimeout(() => setPop(false), 260);
      prevQty.current = totalQty;
      return () => {
        cancelAnimationFrame(id);
        window.clearTimeout(timer);
      };
    }
    prevQty.current = totalQty;
  }, [totalQty]);

  if (!eventId) {
    return (
      <div className="center-page">
        <div className="card">请先在后台选择并开启一场展会。</div>
      </div>
    );
  }
  if (menu.loading || layout.loading) {
    return (
      <div className="center-page">
        <Spinner label="读取菜单…" />
      </div>
    );
  }
  if (menu.error || layout.error) {
    return (
      <div className="center-page">
        <ErrorBox message={menu.error ?? layout.error} />
      </div>
    );
  }

  function setItemInCart(item: MenuItem, targetQuantity: number) {
    const cap = effectiveItemMax(item);
    const clamped = cap !== null ? Math.min(targetQuantity, cap) : targetQuantity;
    if (clamped <= 0) {
      setCart(cart.filter((c) => c.variantId !== item.variant_id));
      setDetail(null);
      return;
    }
    const next = [...cart];
    const idx = next.findIndex((c) => c.variantId === item.variant_id);
    if (idx >= 0) {
      next[idx] = {
        ...next[idx],
        priceMinor: item.price_minor,
        quantity: clamped,
        maxAvailable: cap,
        coverAssetId: item.cover_asset_id
      };
    } else {
      next.push({
        variantId: item.variant_id,
        productName: item.product_name,
        variantName: item.variant_name,
        priceMinor: item.price_minor,
        quantity: clamped,
        maxAvailable: cap,
        coverAssetId: item.cover_asset_id
      });
    }
    setCart(next);
    setDetail(null);
  }

  function addToCart(item: MenuItem, quantity: number) {
    const cur = cart.find((c) => c.variantId === item.variant_id)?.quantity ?? 0;
    setItemInCart(item, cur + quantity);
  }

  function updateCartQty(variantId: string, quantity: number) {
    if (quantity <= 0) {
      setCart(cart.filter((c) => c.variantId !== variantId));
      return;
    }
    const item = menu.data?.find((m) => m.variant_id === variantId);
    const cap = item ? effectiveItemMax(item) : undefined;
    setCart(
      cart.map((c) => {
        if (c.variantId !== variantId) return c;
        const limit = cap !== undefined ? cap : c.maxAvailable;
        const clamped = limit !== null ? Math.min(quantity, limit) : quantity;
        return { ...c, quantity: clamped, maxAvailable: limit };
      })
    );
  }

  return (
    <div className={`kiosk kiosk-menu${layout.data ? ' landscape-cart-enabled' : ''}`}>
      <KioskCatalogHeader
        boothName={boothName.data}
        eventName={event.data?.name}
        boothNumber={event.data?.booth_number}
        itemCount={filtered.length}
        categories={visibleCategories}
        activeCategory={category}
        onSelectCategory={setCategory}
        inStockOnly={inStockOnly}
        onToggleInStockOnly={() => setInStockOnly((v) => !v)}
        keyword={keyword}
        onKeywordChange={setKeyword}
        onStaffClick={() => navigate('/staff/pending')}
      />

      <PromotionHint rules={quote.data?.rules} currency={currency} />
      <ErrorBox message={quote.error} />
      <div className="kiosk-menu-body">
        <div className="menu-grid">
          {filtered.map((item) => {
            const label = stockLabel(item);
            const soldOut = label === '售罄';
            const inCart = cart.find((c) => c.variantId === item.variant_id);
            const cartQty = inCart?.quantity ?? 0;
            return (
              <MenuCard
                key={item.variant_id}
                item={item}
                inCartQty={cartQty}
                onAdd={() => addToCart(item, 1)}
                onSetQty={(v) => updateCartQty(item.variant_id, v)}
                onOpenDetail={() => {
                  if (soldOut) return;
                  setQty(Math.max(1, cartQty || 1));
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
          cart={cart}
          currency={currency}
          quote={quote.data}
          onSetQty={updateCartQty}
          onClear={() => setClearing(true)}
          onCheckout={() => navigate('/kiosk/checkout')}
        />
      </div>

      {clearing ? (
        <Modal
          title="清空购物车"
          onClose={() => setClearing(false)}
          actions={
            <>
              <button onClick={() => setClearing(false)}>取消</button>
              <button
                className="danger"
                onClick={() => {
                  clearCart();
                  setClearing(false);
                }}
              >
                确认清空
              </button>
            </>
          }
        >
          <p>要移除购物车里的全部商品吗？</p>
        </Modal>
      ) : null}

      {detail ? (
        <KioskItemDetailModal
          item={detail}
          qty={qty}
          inCartQty={cart.find((c) => c.variantId === detail.variant_id)?.quantity ?? 0}
          onQtyChange={setQty}
          onClose={() => setDetail(null)}
          onAdd={(q) => setItemInCart(detail, q)}
        />
      ) : null}

      <div className="cart-bar">
        <span className={`count${pop ? ' cart-pop' : ''}`}>{totalQty}</span>
        <div className="cart-bar-main">
          <span className="strong">{formatMoney(totalMinor, currency)}</span>
          {threshold ? <span className="cart-bar-nudge">{threshold.compactText}</span> : null}
        </div>
        <span className="spacer" />
        <button onClick={() => navigate('/kiosk/cart')} disabled={!cart.length}>
          查看购物车
        </button>
      </div>
    </div>
  );
}
