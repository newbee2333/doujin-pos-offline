import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { formatMoney, minorToInput, parseAmountToMinor } from '../../domain/money';
import { newId } from '../../domain/ids';
import { confirmPayment, getOrderDetail, voidOrder } from '../../services/orders';
import { listPaymentMethods, getEventPaymentMethods } from '../../services/events';
import { verifyPin } from '../../services/system';
import { errorMessage, useApp } from '../../store';
import { ConfirmDialog, ErrorBox, PinPad, Spinner, useAsync } from '../components';
import CashTenderControl from '../CashTenderControl';
import { QrPreview } from './KioskCheckout';
import { acknowledgeOrderPrice } from '../../services/order-pricing';
import type { Order } from '../../domain/types';
import PendingPriceEditor from '../PendingPriceEditor';
import { PriceSummary } from '../Pricing';

export default function KioskOrderPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const staffUnlocked = useApp((s) => s.staffUnlocked);
  const unlockStaff = useApp((s) => s.unlockStaff);
  const lockStaff = useApp((s) => s.lockStaff);
  const clearCart = useApp((s) => s.clearCart);
  const setCurrentOrder = useApp((s) => s.setCurrentOrder);
  const showToast = useApp((s) => s.showToast);

  const [adjustOrder, setAdjustOrder] = useState<Order | null>(null);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [pinMode, setPinMode] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [methodId, setMethodId] = useState<string>('');
  const [tendered, setTendered] = useState('');
  const lastAutoKeyRef = useRef('');

  const detail = useAsync(() => getOrderDetail(id), [id]);
  const order = detail.data?.order;
  const isPendingOrder = !order || order.status === 'pending_payment';
  useEffect(() => {
    if (!isPendingOrder) return;
    const timer = window.setInterval(detail.reload, 1500);
    return () => window.clearInterval(timer);
  }, [id, isPendingOrder, detail.reload]);

  // 离开游客付款页时强制重新锁定后台，防止通过返回手势把解锁状态带回游客菜单
  useEffect(() => () => {
    useApp.getState().lockStaff();
  }, []);

  const eventId = detail.data?.order.event_id;
  const methods = useAsync(
    () => (eventId ? getEventPaymentMethods(eventId) : Promise.resolve([])),
    [eventId]
  );
  const allMethods = useAsync(() => listPaymentMethods(), []);

  const planned = order?.planned_payment_method_id ?? null;
  const selectedMethodId = methodId || planned || '';
  const cashMethod = allMethods.data?.find((x) => x.id === selectedMethodId) ?? null;

  const plannedMethod = planned ? allMethods.data?.find((x) => x.id === planned) : undefined;
  const needsPin = plannedMethod ? plannedMethod.confirm_requires_pin === 1 : true;
  const canManage = staffUnlocked || !needsPin;

  // 仅在订单/定价版本/金额/支付方式变化时自动回填现金实收，不干扰用户退格清空重输
  const autoKey =
    order && cashMethod?.type === 'cash' && order.total_minor > 0
      ? `${order.id}:${order.pricing_version ?? 0}:${order.total_minor}:${cashMethod.id}`
      : '';
  useEffect(() => {
    if (!autoKey) {
      lastAutoKeyRef.current = '';
      if (order && order.total_minor === 0) setTendered('');
      return;
    }
    if (lastAutoKeyRef.current !== autoKey && order) {
      lastAutoKeyRef.current = autoKey;
      setTendered(minorToInput(order.total_minor, order.currency));
    }
  }, [autoKey, order]);

  if (detail.loading && !order) {
    return (
      <div className="center-page">
        <Spinner label="读取订单…" />
      </div>
    );
  }
  if (!order) return <ErrorBox message="订单不存在或已不可访问" />;

  const currency = order.currency;
  const needsAcknowledgement = (order.customer_ack_version ?? 0) !== (order.pricing_version ?? 0);
  const priceBlocked = !!order.pricing_editing || needsAcknowledgement;
  const hasQrImage = !!order.planned_qr_asset_id;
  const showQr = order.status === 'pending_payment' && order.total_minor > 0 && !priceBlocked && hasQrImage;

  async function doConfirm() {
    setBusy(true);
    setError(null);
    try {
      const isPaidOrder = order!.total_minor > 0;
      const m = isPaidOrder ? allMethods.data?.find((x) => x.id === (methodId || planned)) : null;
      await confirmPayment({
        orderId: order!.id,
        paymentMethodId: isPaidOrder ? (methodId || null) : null,
        tenderedMinor: isPaidOrder && m?.type === 'cash' ? parseAmountToMinor(tendered, order!.currency) : null,
        expectedPricingVersion: order!.pricing_version ?? 0,
        operationId: newId()
      });
      showToast('已确认收款');
      detail.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function doVoid() {
    setBusy(true);
    setError(null);
    try {
      await voidOrder(order!.id, '摊主核实未收款', newId());
      setConfirmVoid(false);
      showToast('已取消');
      detail.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function finishAndReturn() {
    clearCart();
    setCurrentOrder(null);
    lockStaff();
    navigate('/kiosk');
  }

  return (
    <div className="kiosk kiosk-order">
      <div className="kiosk-header">
        <span className="title">
          {order.status === 'pending_payment' ? '请付款' : order.status === 'completed' ? '已完成' : '订单已结束'}
        </span>
      </div>

      <div className={`content narrow kiosk-order-page${showQr ? ' has-qr' : ''}`}>
        {order.status === 'pending_payment' && priceBlocked && (
          <div className="card ord-price-warning" role="alert">
            <h2>{order.pricing_editing ? '摊主正在调整金额，请暂时不要付款' : '金额已调整，请重新核对'}</h2>
            <p>请向摊主确认新的应收金额。已经付款的，请出示实际付款记录。</p>
            {!order.pricing_editing && (
              <button
                className="primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await acknowledgeOrderPrice(order.id, order.pricing_version ?? 0, 'kiosk');
                    setTendered('');
                    detail.reload();
                  } catch (e) {
                    setError(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                已核对 {formatMoney(order.total_minor, currency)}，继续付款
              </button>
            )}
          </div>
        )}

        <div
          className={`card center ord-no ticket-card${
            order.status === 'completed' ? ' is-completed' : order.status === 'voided' ? ' is-voided' : ''
          }`}
        >
          <div className="ticket-kicker">
            {order.status === 'completed'
              ? '✓ 已收款 · 取货号'
              : order.status === 'voided'
                ? '已取消 · 取货号'
                : '摊位领货券 · 取货号'}
          </div>
          <div className="order-no">#{order.human_readable_number}</div>
          <div className="ticket-divider" aria-hidden="true" />
          <div className="big-price">{formatMoney(order.total_minor, currency)}</div>
          {order.status === 'pending_payment' && !hasQrImage && order.total_minor > 0 && order.planned_method_name_snapshot ? (
            <div className="ticket-method-line">
              <span className="badge">{order.planned_method_name_snapshot}</span>
              {order.planned_instruction_snapshot ? (
                <span className="small muted">{order.planned_instruction_snapshot}</span>
              ) : null}
            </div>
          ) : null}
          <div className="small muted" style={{ marginTop: 6 }}>
            {order.status === 'pending_payment'
              ? priceBlocked
                ? '请先与摊主核对金额，暂时不要付款'
                : '请按上方金额付款，并出示此券给摊主核对'
              : order.status === 'completed'
                ? '摊主已确认收款，感谢惠顾'
                : order.status === 'voided'
                  ? '该订单已取消'
                  : ''}
          </div>
        </div>

        {showQr ? (
          <div className="card ord-qr">
            <h2>{detail.data!.order.planned_method_name_snapshot ?? '付款'}</h2>
            <QrPreview assetId={detail.data!.order.planned_qr_asset_id} />
            {detail.data!.order.planned_instruction_snapshot ? (
              <p className="small muted">{detail.data!.order.planned_instruction_snapshot}</p>
            ) : (
              <p className="small muted">请按订单金额付款，付款后请摊主确认到账。</p>
            )}
          </div>
        ) : null}

        <div className="card ord-items">
          <h2>商品明细</h2>
          {detail.data?.items.map((it) => (
            <div key={it.id} className="row" style={{ padding: '4px 0' }}>
              <div style={{ flex: 1 }}>
                {it.product_name_snapshot}
                <div className="small muted">
                  {it.variant_name_snapshot} · {formatMoney(it.unit_price_minor, currency)} × {it.quantity}
                </div>
              </div>
              <div className="nowrap">{formatMoney(it.net_minor ?? it.subtotal_minor, currency)}</div>
            </div>
          ))}
          <PriceSummary quote={order.pricing_json ? JSON.parse(order.pricing_json) : null} currency={currency} />
        </div>

        <div className="ord-err">
          <ErrorBox message={detail.error ?? error} />
        </div>

        {order.status === 'pending_payment' ? (
          (!canManage || pinMode) ? (
            <div className="card ord-staff ord-staff-sep">
              {pinMode ? (
                <PinPad
                  hint="摊主密码"
                  error={pinError}
                  onCancel={() => setPinMode(false)}
                  onSubmit={async (pin) => {
                    if (await verifyPin(pin)) {
                      setPinMode(false);
                      setPinError(null);
                      unlockStaff();
                    } else setPinError('后台密码不正确');
                  }}
                />
              ) : (
                <button className="primary block" onClick={() => setPinMode(true)}>
                  请摊主处理
                </button>
              )}
            </div>
          ) : (
            <div className="card ord-staff ord-staff-sep">
              <div className="row">
                <h2>摊主处理</h2>
                <span className="spacer" />
                <button
                  className="small"
                  disabled={busy || (needsAcknowledgement && !order.pricing_editing)}
                  onClick={() => {
                    if (staffUnlocked) setAdjustOrder(order);
                    else setPinMode(true);
                  }}
                >
                  {order.pricing_editing ? '继续调价' : '改应收'}
                </button>
              </div>
              {adjustOrder?.id === order.id && (
                <PendingPriceEditor
                  order={adjustOrder}
                  onClose={() => {
                    setAdjustOrder(null);
                    detail.reload();
                  }}
                  onDone={() => {
                    setAdjustOrder(null);
                    setTendered('');
                    detail.reload();
                  }}
                />
              )}
              {order.total_minor > 0 ? (
                <div className="col">
                  <label className="field">
                    <span>实际收款方式（可与游客选择不同）</span>
                    <select value={selectedMethodId} onChange={(e) => setMethodId(e.target.value)}>
                      {planned && !(methods.data ?? []).some((m) => m.id === planned) ? (
                        <option value={planned}>
                          {order.planned_method_name_snapshot ?? '原支付方式'}（已停用）
                        </option>
                      ) : null}
                      {(methods.data ?? []).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {cashMethod?.type === 'cash' ? (
                    <CashTenderControl
                      totalMinor={order.total_minor}
                      currency={currency}
                      value={tendered}
                      disabled={busy}
                      onChange={(next) => setTendered(next)}
                    />
                  ) : null}
                </div>
              ) : null}

              <div className="row" style={{ marginTop: 12 }}>
                <button className="primary" onClick={doConfirm} disabled={busy || priceBlocked}>
                  {busy ? <span className="spinner" /> : null}
                  {order.total_minor > 0 ? '确认已收款' : '确认发放'}
                </button>
                <button className="danger" onClick={() => setConfirmVoid(true)} disabled={busy}>
                  取消订单
                </button>
                <button
                  onClick={() => {
                    lockStaff();
                    clearCart();
                    setCurrentOrder(null);
                    navigate('/kiosk');
                  }}
                  disabled={busy}
                >
                  挂起，接待下一位
                </button>
              </div>
            </div>
          )
        ) : null}

        {order.status !== 'pending_payment' ? (
          <button className="primary block ord-staff" style={{ minHeight: 54 }} onClick={finishAndReturn}>
            {order.status === 'completed' ? '完成并返回菜单' : '返回游客菜单'}
          </button>
        ) : null}
      </div>

      {confirmVoid ? (
        <ConfirmDialog
          title="取消这笔订单？"
          message={`确认取消订单 #${order.human_readable_number}？请先核实确实没有收到款，取消后将立即释放预留库存。`}
          confirmText="确认取消"
          danger
          busy={busy}
          onConfirm={doVoid}
          onCancel={() => setConfirmVoid(false)}
        />
      ) : null}
    </div>
  );
}
