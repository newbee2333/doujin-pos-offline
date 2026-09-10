import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getKioskMenu } from '../../services/orders';
import { listCategories } from '../../services/catalog';
import { formatMoney } from '../../domain/money';
import { stockLabel, type MenuItem } from '../../domain/types';
import { useApp } from '../../store';
import { AssetImage, ErrorBox, Modal, Money, QtyStepper, Spinner, useAsync } from '../components';

const IDLE_MS = 5 * 60 * 1000;
const WARN_MS = 30 * 1000;

export default function KioskMenuPage() {
  const navigate = useNavigate();
  const eventId = useApp((s) => s.currentEventId);
  const cart = useApp((s) => s.cart);
  const setCart = useApp((s) => s.setCart);
  const clearCart = useApp((s) => s.clearCart);

  const [category, setCategory] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const [detail, setDetail] = useState<MenuItem | null>(null);
  const [qty, setQty] = useState(1);

  const menu = useAsync(() => (eventId ? getKioskMenu(eventId) : Promise.resolve([])), [eventId]);
  const cats = useAsync(() => listCategories(false), []);

  // 未提交购物车 5 分钟无操作提示，30 秒内无响应才清空
  const [warnAt, setWarnAt] = useState<number | null>(null);
  const [left, setLeft] = useState(30);
  const lastTouch = useRef(Date.now());
  const touch = () => {
    lastTouch.current = Date.now();
    setWarnAt(null);
  };

  useEffect(() => {
    const t = setInterval(() => {
      if (cart.length === 0) {
        setWarnAt(null);
        return;
      }
      const idle = Date.now() - lastTouch.current;
      if (idle > IDLE_MS) {
        setWarnAt((w) => w ?? Date.now());
      }
    }, 1000);
    return () => clearInterval(t);
  }, [cart.length]);

  useEffect(() => {
    if (warnAt === null) return;
    const t = setInterval(() => {
      const remain = Math.max(0, Math.ceil((WARN_MS - (Date.now() - warnAt)) / 1000));
      setLeft(remain);
      if (remain <= 0) {
        clearCart();
        setWarnAt(null);
      }
    }, 250);
    return () => clearInterval(t);
  }, [warnAt, clearCart]);

  const filtered = useMemo(() => {
    const list = menu.data ?? [];
    const kw = keyword.trim().toLowerCase();
    return list.filter((m) => {
      if (category && m.category_id !== category) return false;
      if (kw) {
        const hay = `${m.product_name} ${m.variant_name} ${m.sku ?? ''} ${m.category_name ?? ''}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [menu.data, category, keyword]);

  const totalQty = cart.reduce((a, c) => a + c.quantity, 0);
  const totalMinor = cart.reduce((a, c) => a + c.priceMinor * c.quantity, 0);
  const currency = (menu.data?.[0]?.currency ?? 'CNY') as MenuItem['currency'];

  if (!eventId) {
    return (
      <div className="center-page">
        <div className="card">请先在后台选择并开启一场展会。</div>
      </div>
    );
  }
  if (menu.loading) {
    return (
      <div className="center-page">
        <Spinner label="读取菜单…" />
      </div>
    );
  }
  if (menu.error) {
    return (
      <div className="center-page">
        <ErrorBox message={menu.error} />
      </div>
    );
  }

  function addToCart(item: MenuItem, quantity: number) {
    touch();
    const next = [...cart];
    const idx = next.findIndex((c) => c.variantId === item.variant_id);
    if (idx >= 0) next[idx] = { ...next[idx], quantity: next[idx].quantity + quantity };
    else
      next.push({
        variantId: item.variant_id,
        productName: item.product_name,
        variantName: item.variant_name,
        priceMinor: item.price_minor,
        quantity,
        maxAvailable: item.available_stock
      });
    setCart(next);
    setDetail(null);
  }

  function updateCartQty(item: MenuItem, quantity: number) {
    touch();
    if (quantity <= 0) {
      setCart(cart.filter((c) => c.variantId !== item.variant_id));
      return;
    }
    setCart(
      cart.map((c) =>
        c.variantId === item.variant_id
          ? { ...c, quantity, maxAvailable: item.available_stock }
          : c
      )
    );
  }

  return (
    <div className="kiosk" onPointerDown={touch} onKeyDown={touch}>
      <div className="kiosk-header">
        <span className="title">商品目录</span>
        <input
          type="search"
          placeholder="搜索商品名或 SKU"
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value);
            touch();
          }}
          style={{ maxWidth: 320 }}
        />
        <span className="spacer" />
        <button className="small ghost" onClick={() => navigate('/staff/pending')}>
          摊主处理
        </button>
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

      {warnAt !== null ? (
        <div className="notice" style={{ margin: '8px 18px 0' }}>
          长时间无操作，购物车将在 {left} 秒后清空。点击任意处继续使用。
        </div>
      ) : null}

      <div className="menu-grid">
        {filtered.map((item) => {
          const label = stockLabel(item);
          const soldOut = label === '售罄';
          const inCart = cart.find((c) => c.variantId === item.variant_id);
          const cartQty = inCart?.quantity ?? 0;
          const max = item.product_type === 'non_stock' ? null : item.available_stock;
          return (
            <div key={item.variant_id} className={`menu-card ${soldOut ? 'sold-out' : ''}`}>
              <button
                type="button"
                className="menu-card-info"
                onClick={() => {
                  if (soldOut) return;
                  setQty(Math.max(1, cartQty || 1));
                  setDetail(item);
                  touch();
                }}
                aria-label={`查看 ${item.product_name} 详情`}
              >
                <AssetImage assetId={item.cover_asset_id} alt={item.product_name} />
                <div className="body">
                  <span className="name">{item.product_name}</span>
                  {item.variant_name !== '默认规格' ? (
                    <span className="tiny muted">{item.variant_name}</span>
                  ) : null}
                  <span className="price">{formatMoney(item.price_minor, item.currency)}</span>
                  <span className="row tight">
                    <span
                      className={`badge ${
                        label === '售罄' ? 'danger' : label === '少量' ? 'warn' : label === '不限' ? '' : 'ok'
                      }`}
                    >
                      {label}
                    </span>
                    {item.show_exact_stock && item.available_stock !== null ? (
                      <span className="tiny muted">剩 {item.available_stock}</span>
                    ) : null}
                  </span>
                </div>
              </button>
              {soldOut ? null : (
                <div className="menu-card-action">
                  {inCart ? (
                    <QtyStepper
                      value={cartQty}
                      min={0}
                      max={max}
                      onChange={(v) => updateCartQty(item, v)}
                    />
                  ) : (
                    <button
                      type="button"
                      className="add-btn"
                      onClick={() => addToCart(item, 1)}
                      aria-label={`加入购物车：${item.product_name}`}
                    >
                      + 加入购物车
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!filtered.length ? <p className="muted">没有找到商品。</p> : null}
      </div>

      {detail ? (
        <Modal
          title={detail.product_name}
          onClose={() => setDetail(null)}
          actions={
            <>
              <button onClick={() => setDetail(null)}>关闭</button>
              <button
                className="primary"
                onClick={() => addToCart(detail, qty)}
                disabled={qty <= 0}
              >
                加入购物车
              </button>
            </>
          }
        >
          <div className="col">
            {detail.cover_asset_id ? <AssetImage assetId={detail.cover_asset_id} alt={detail.product_name} /> : null}
            {detail.description ? <p style={{ whiteSpace: 'pre-wrap' }}>{detail.description}</p> : null}
            <div className="small muted">
              {detail.variant_name}
              {detail.sku ? ` · SKU ${detail.sku}` : ''}
            </div>
            <div className="row">
              <Money minor={detail.price_minor} currency={detail.currency} big />
              <span className="spacer" />
              <QtyStepper
                value={qty}
                min={1}
                max={detail.available_stock ?? (detail.product_type === 'non_stock' ? null : 0)}
                onChange={setQty}
              />
            </div>
            {detail.purchase_limit ? (
              <div className="small muted">每单限购 {detail.purchase_limit} 件</div>
            ) : null}
          </div>
        </Modal>
      ) : null}

      <div className="cart-bar">
        <span className="count">{totalQty}</span>
        <span className="strong">{formatMoney(totalMinor, currency)}</span>
        <span className="spacer" />
        <button onClick={() => navigate('/kiosk/cart')} disabled={!cart.length}>
          查看购物车
        </button>
      </div>
    </div>
  );
}
