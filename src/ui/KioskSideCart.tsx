import type { CartItem } from '../store';
import type { Currency } from '../domain/types';
import { formatMoney } from '../domain/money';
import { AssetImage, QtyStepper } from './components';

/** The landscape menu shares the same cart and checkout as the compact layout. */
export default function KioskSideCart({ cart, currency, onSetQty, onClear, onCheckout, preview = false }: {
  cart: CartItem[];
  currency: Currency;
  onSetQty: (variantId: string, quantity: number) => void;
  onClear: () => void;
  onCheckout: () => void;
  preview?: boolean;
}) {
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);
  const total = cart.reduce((sum, item) => sum + item.quantity * item.priceMinor, 0);
  return (
    <aside className="kiosk-side-cart" aria-labelledby="side-cart-title">
      <header className="side-cart-header">
        <div className="side-cart-title">
          <h2 id="side-cart-title">购物车</h2>
          <span className="side-cart-count">{count} 件</span>
        </div>
        <button className="small ghost" disabled={!cart.length} onClick={onClear}>清空</button>
      </header>

      <div className="side-cart-items">
        {!cart.length ? (
          <div className="side-cart-empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <path d="m3 9 2 12h14l2-12H3ZM8 9l4-7 4 7M9 13v4m6-4v4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <strong>购物车还是空的</strong>
            <p>点击左侧商品的＋，加入购物车</p>
          </div>
        ) : cart.map(item => (
          <article className="side-cart-item" key={item.variantId} aria-label={item.productName}>
            <div className="side-cart-product">
              <AssetImage assetId={item.coverAssetId} alt={item.productName} className="side-cart-thumb" />
              <div className="side-cart-product-info">
                <div className="strong">{item.productName}</div>
                {item.variantName !== '默认规格' ? <div className="tiny muted">{item.variantName}</div> : null}
                <div className="tiny muted">{formatMoney(item.priceMinor, currency)} / 件</div>
              </div>
              <button className="small ghost side-cart-remove" aria-label={`移除 ${item.productName}`} onClick={() => onSetQty(item.variantId, 0)}>×</button>
            </div>
            <div className="side-cart-item-actions">
              <QtyStepper value={item.quantity} min={0} max={item.maxAvailable} onChange={qty => onSetQty(item.variantId, qty)} />
              <span className="strong side-cart-line-total">{formatMoney(item.priceMinor * item.quantity, currency)}</span>
            </div>
          </article>
        ))}
      </div>

      <footer className="side-cart-footer">
        <div className="side-cart-total"><span>合计</span><strong>{formatMoney(total, currency)}</strong></div>
        <p className="tiny muted">{preview ? '预览购物车，不会生成订单' : '提交订单后才会占用库存'}</p>
        <button className="primary block" disabled={!cart.length || preview} onClick={onCheckout}>{preview ? '去结算（预览）' : '去结算'}</button>
      </footer>
    </aside>
  );
}
