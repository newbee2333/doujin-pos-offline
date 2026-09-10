import { useNavigate } from 'react-router-dom';
import { formatMoney } from '../../domain/money';
import { getEvent } from '../../services/events';
import { useApp } from '../../store';
import { ErrorBox, QtyStepper, useAsync } from '../components';
import type { Currency } from '../../domain/types';

export default function KioskCartPage() {
  const navigate = useNavigate();
  const cart = useApp((s) => s.cart);
  const setCart = useApp((s) => s.setCart);
  const eventId = useApp((s) => s.currentEventId);
  const event = useAsync(() => (eventId ? getEvent(eventId) : Promise.resolve(null)), [eventId]);

  const currency: Currency = event.data?.currency ?? 'CNY';
  const totalMinor = cart.reduce((a, c) => a + c.priceMinor * c.quantity, 0);

  if (!eventId) return <ErrorBox message="未选择展会" />;

  function setQty(variantId: string, quantity: number) {
    if (quantity <= 0) {
      setCart(cart.filter((c) => c.variantId !== variantId));
      return;
    }
    setCart(cart.map((c) => (c.variantId === variantId ? { ...c, quantity } : c)));
  }

  return (
    <div className="kiosk">
      <div className="kiosk-header">
        <button className="small ghost" onClick={() => navigate('/kiosk')}>
          ‹ 继续选购
        </button>
        <span className="title">购物车</span>
      </div>

      <div style={{ padding: '14px 18px 120px' }}>
        {!cart.length ? (
          <p className="muted">购物车是空的。</p>
        ) : (
          <div className="col">
            {cart.map((c) => (
              <div key={c.variantId} className="card">
                <div className="row">
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div className="strong">{c.productName}</div>
                    <div className="small muted">{c.variantName}</div>
                    <div className="small muted">
                      {formatMoney(c.priceMinor, currency)} × {c.quantity}
                    </div>
                  </div>
                  <QtyStepper
                    value={c.quantity}
                    min={0}
                    max={c.maxAvailable}
                    onChange={(v) => setQty(c.variantId, v)}
                  />
                  <div className="strong nowrap">{formatMoney(c.priceMinor * c.quantity, currency)}</div>
                </div>
              </div>
            ))}

            <div className="card">
              <div className="row">
                <span className="strong">合计</span>
                <span className="spacer" />
                <span className="big-price">{formatMoney(totalMinor, currency)}</span>
              </div>
              <p className="tiny muted" style={{ marginBottom: 0 }}>
                购物车只是暂存，提交订单后才会占用库存。
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="cart-bar">
        <span className="strong">{formatMoney(totalMinor, currency)}</span>
        <span className="spacer" />
        <button className="primary" disabled={!cart.length} onClick={() => navigate('/kiosk/checkout')}>
          去结算
        </button>
      </div>
    </div>
  );
}
