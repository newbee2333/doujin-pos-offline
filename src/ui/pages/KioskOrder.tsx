import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { formatMoney, minorToInput, parseAmountToMinor } from '../../domain/money';
import { newId } from '../../domain/ids';
import { confirmPayment, getOrderDetail, voidOrder } from '../../services/orders';
import { listPaymentMethods, getEventPaymentMethods } from '../../services/events';
import { verifyPin } from '../../services/system';
import { errorMessage, useApp } from '../../store';
import { ErrorBox, PinPad, Spinner, useAsync } from '../components';
import { QrPreview } from './KioskCheckout';

export default function KioskOrderPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const staffUnlocked = useApp((s) => s.staffUnlocked);
  const unlockStaff = useApp((s) => s.unlockStaff);
  const lockStaff = useApp((s) => s.lockStaff);
  const clearCart = useApp((s) => s.clearCart);
  const setCurrentOrder = useApp((s) => s.setCurrentOrder);
  const showToast = useApp((s) => s.showToast);

  const [pinMode, setPinMode] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [methodId, setMethodId] = useState<string>('');
  const [tendered, setTendered] = useState('');

  const detail = useAsync(() => getOrderDetail(id), [id]);
  const eventId = detail.data?.order.event_id;
  const methods = useAsync(
    () => (eventId ? getEventPaymentMethods(eventId) : Promise.resolve([])),
    [eventId]
  );
  const allMethods = useAsync(() => listPaymentMethods(), []);

  // 下面两个提前 return 之前，必须先算出所有 hook 依赖的值并调用完所有 hook。
  const order = detail.data?.order;
  const planned = order?.planned_payment_method_id ?? null;
  const cashMethod = allMethods.data?.find((x) => x.id === (methodId || planned)) ?? null;

  // 现金实收默认填应付金额：选了现金且还没填，就预填；用户清空后会再次预填。
  // ⚠️ 这个 effect 必须待在两个提前 return 之上。原来它在 return 之后：
  //    首次渲染（loading）时没执行它、hook 数少一个；数据到达后第二次渲染多执行一个，
  //    React 直接抛 "Rendered more hooks than during the previous render"，
  //    整棵组件树卸载 → 游客提交订单后卡死在白屏。开发时不会报错，
  //    只有真实走完「提交订单 → 跳到本页」才会暴露。
  useEffect(() => {
    if (order && cashMethod && order.total_minor > 0 && !tendered) {
      setTendered(minorToInput(order.total_minor, order.currency));
    }
  }, [methodId, order, cashMethod, tendered]);

  if (detail.loading) {
    return (
      <div className="center-page">
        <Spinner label="读取订单…" />
      </div>
    );
  }
  if (!order) return <ErrorBox message="订单不存在或已不可访问" />;

  const currency = order.currency;

  async function doConfirm() {
    setBusy(true);
    setError(null);
    try {
      const m = allMethods.data?.find((x) => x.id === (methodId || planned));
      await confirmPayment({
        orderId: order!.id,
        paymentMethodId: methodId || null,
        tenderedMinor: m?.type === 'cash' ? Math.round(Number(tendered) * 100) : null,
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
    if (!window.confirm('确认取消这笔未付款订单？请先核实确实没有收到款。')) return;
    setBusy(true);
    setError(null);
    try {
      await voidOrder(order!.id, '摊主核实未收款', newId());
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
    <div className="kiosk">
      <div className="kiosk-header">
        <span className="title">
          {order.status === 'pending_payment' ? '请付款' : order.status === 'completed' ? '已完成' : '订单已结束'}
        </span>
      </div>

      <div className="content narrow">
        <div className="card center">
          <div className="small muted">订单号</div>
          <div className="order-no">#{order.human_readable_number}</div>
          <div className="big-price" style={{ marginTop: 6 }}>
            {formatMoney(order.total_minor, currency)}
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            {order.status === 'pending_payment'
              ? '请按上方金额付款，并出示给摊主核对'
              : order.status === 'completed'
                ? '摊主已确认收款，感谢惠顾'
                : order.status === 'voided'
                  ? '该订单已取消'
                  : ''}
          </div>
        </div>

        {order.status === 'pending_payment' && order.total_minor > 0 ? (
          <div className="card">
            <h2>{detail.data!.order.planned_method_name_snapshot ?? '付款'}</h2>
            <QrPreview assetId={detail.data!.order.planned_qr_asset_id} />
            {detail.data!.order.planned_instruction_snapshot ? (
              <p className="small muted">{detail.data!.order.planned_instruction_snapshot}</p>
            ) : (
              <p className="small muted">请按订单金额付款，付款后请摊主确认到账。</p>
            )}
          </div>
        ) : null}

        <div className="card">
          <h2>商品明细</h2>
          {detail.data?.items.map((it) => (
            <div key={it.id} className="row" style={{ padding: '4px 0' }}>
              <div style={{ flex: 1 }}>
                {it.product_name_snapshot}
                <div className="small muted">
                  {it.variant_name_snapshot} · {formatMoney(it.unit_price_minor, currency)} × {it.quantity}
                </div>
              </div>
              <div className="nowrap">{formatMoney(it.subtotal_minor, currency)}</div>
            </div>
          ))}
        </div>

        <ErrorBox message={detail.error ?? error} />

        {order.status === 'pending_payment' ? (
          !staffUnlocked ? (
            <div className="card">
              {pinMode ? (
                <PinPad
                  hint="摊主 PIN"
                  error={pinError}
                  onCancel={() => setPinMode(false)}
                  onSubmit={async (pin) => {
                    if (await verifyPin(pin)) {
                      setPinMode(false);
                      setPinError(null);
                      unlockStaff();
                    } else setPinError('PIN 不正确');
                  }}
                />
              ) : (
                <button className="primary block" onClick={() => setPinMode(true)}>
                  请摊主处理
                </button>
              )}
            </div>
          ) : (
            <div className="card">
              <h2>摊主处理</h2>
              {order.total_minor > 0 ? (
                <div className="col">
                  <label className="field">
                    <span>实际收款方式（可与游客选择不同）</span>
                    <select value={methodId || planned || ''} onChange={(e) => setMethodId(e.target.value)}>
                      {(methods.data ?? []).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {cashMethod?.type === 'cash' ? (
                    <label className="field">
                      <span>
                        实收金额（{currency === 'CNY' ? '元' : '日元'}）·{' '}
                        <button
                          type="button"
                          className="small ghost"
                          onClick={() =>
                            order && setTendered(minorToInput(order.total_minor, order.currency))
                          }
                        >
                          按应付金额
                        </button>
                      </span>
                      <input
                        type="text"
                        value={tendered}
                        onChange={(e) => setTendered(e.target.value)}
                        placeholder={currency === 'CNY' ? '例如 30.00' : '例如 3000'}
                      />
                    </label>
                  ) : null}
                </div>
              ) : null}

              <div className="row" style={{ marginTop: 12 }}>
                <button className="primary" onClick={doConfirm} disabled={busy}>
                  {busy ? <span className="spinner" /> : null}
                  {order.total_minor > 0 ? '确认已收款' : '确认发放'}
                </button>
                <button className="danger" onClick={doVoid} disabled={busy}>
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

        {order.status === 'completed' ? (
          <button className="primary block" style={{ minHeight: 54 }} onClick={finishAndReturn}>
            完成并返回菜单
          </button>
        ) : null}
      </div>
    </div>
  );
}
