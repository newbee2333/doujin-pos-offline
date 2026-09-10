import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatMoney } from '../../domain/money';
import { newId } from '../../domain/ids';
import { createPendingOrder } from '../../services/orders';
import { getEvent, getEventPaymentMethods } from '../../services/events';
import { useApp, errorMessage } from '../../store';
import { ErrorBox, Spinner, useAssetUrl, useAsync } from '../components';
import type { Currency } from '../../domain/types';

export default function KioskCheckoutPage() {
  const navigate = useNavigate();
  const cart = useApp((s) => s.cart);
  const eventId = useApp((s) => s.currentEventId);
  const clearCart = useApp((s) => s.clearCart);
  const setCurrentOrder = useApp((s) => s.setCurrentOrder);

  const [methodId, setMethodId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const event = useAsync(() => (eventId ? getEvent(eventId) : Promise.resolve(null)), [eventId]);
  const methods = useAsync(
    () => (eventId ? getEventPaymentMethods(eventId) : Promise.resolve([])),
    [eventId]
  );

  const currency: Currency = event.data?.currency ?? 'CNY';
  const eventActive = event.data?.status === 'active';
  const totalMinor = cart.reduce((a, c) => a + c.priceMinor * c.quantity, 0);
  const usable = (methods.data ?? []).filter((m) => m.type !== 'qr_payment' || m.qr_asset_id);

  if (!eventId) return <ErrorBox message="未选择展会" />;
  if (!cart.length) {
    return (
      <div className="center-page">
        <div className="card">
          <p>购物车是空的。</p>
          <button onClick={() => navigate('/kiosk')}>返回菜单</button>
        </div>
      </div>
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const { orderId } = await createPendingOrder({
        eventId: eventId!,
        lines: cart.map((c) => ({ variantId: c.variantId, quantity: c.quantity })),
        plannedPaymentMethodId: totalMinor > 0 ? methodId || null : null,
        operationId: newId()
      });
      setCurrentOrder(orderId);
      clearCart();
      navigate(`/kiosk/order/${orderId}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="kiosk">
      <div className="kiosk-header">
        <button className="small ghost" onClick={() => navigate('/kiosk/cart')} disabled={busy}>
          ‹ 返回购物车
        </button>
        <span className="title">结算</span>
      </div>

      <div className="content narrow">
        <div className="card">
          <h2>订单内容</h2>
          {cart.map((c) => (
            <div key={c.variantId} className="row" style={{ padding: '6px 0' }}>
              <div style={{ flex: 1 }}>
                <div>{c.productName}</div>
                <div className="small muted">
                  {c.variantName} · {formatMoney(c.priceMinor, currency)} × {c.quantity}
                </div>
              </div>
              <div className="strong nowrap">{formatMoney(c.priceMinor * c.quantity, currency)}</div>
            </div>
          ))}
          <div className="row" style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <span className="strong">应付总额</span>
            <span className="spacer" />
            <span className="big-price">{formatMoney(totalMinor, currency)}</span>
          </div>
        </div>

        {totalMinor > 0 ? (
          <div className="card">
            <h2>选择支付方式</h2>
            {methods.loading ? <Spinner label="读取支付方式…" /> : null}
            <div className="grid cols-2">
              {usable.map((m) => (
                <button
                  key={m.id}
                  className={methodId === m.id ? 'primary' : ''}
                  onClick={() => setMethodId(m.id)}
                >
                  {m.name}
                </button>
              ))}
            </div>
            {!usable.length ? (
              <div className="notice danger">当前展会没有可用的支付方式，请让摊主到后台补齐。</div>
            ) : null}
          </div>
        ) : (
          <div className="notice ok">本单为零元订单，提交后请摊主确认发放。</div>
        )}

        <ErrorBox message={error} />

        {event.data && !eventActive ? (
          <div className="notice danger">
            本场展会当前是「{event.data.status === 'closed' ? '已收摊' : '草稿'}」状态，暂时无法下单，请找摊主处理。
          </div>
        ) : null}

        <button
          className="primary block"
          style={{ minHeight: 56, fontSize: '1.05rem' }}
          disabled={busy || (totalMinor > 0 && !methodId) || !eventActive}
          onClick={submit}
        >
          {busy ? <span className="spinner" /> : null}
          提交订单
        </button>
      </div>
    </div>
  );
}

export function QrPreview({ assetId }: { assetId: string | null }) {
  const url = useAssetUrl(assetId);
  if (!url) return null;
  return (
    <div className="qr-box">
      <img src={url} alt="收款二维码" />
    </div>
  );
}
