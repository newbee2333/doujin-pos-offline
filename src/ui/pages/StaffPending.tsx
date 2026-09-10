import { useEffect, useState } from 'react';
import { confirmPayment, getOrderDetail, listOrders, voidOrder } from '../../services/orders';
import { getEvent, getEventPaymentMethods } from '../../services/events';
import { listPaymentMethods } from '../../services/events';
import { formatMoney, minorToInput, parseAmountToMinor } from '../../domain/money';
import { newId } from '../../domain/ids';
import { errorMessage, useApp } from '../../store';
import { ErrorBox, Spinner, useAsync } from '../components';
import type { Currency, Order } from '../../domain/types';

export default function StaffPendingPage() {
  const eventId = useApp((s) => s.currentEventId);
  const showToast = useApp((s) => s.showToast);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [methodFor, setMethodFor] = useState<Record<string, string>>({});
  const [tenderedFor, setTenderedFor] = useState<Record<string, string>>({});

  const orders = useAsync(
    () => (eventId ? listOrders({ eventId, status: 'pending_payment' }) : Promise.resolve([])),
    [eventId]
  );
  const event = useAsync(() => (eventId ? getEvent(eventId) : Promise.resolve(null)), [eventId]);
  const methods = useAsync(
    () => (eventId ? getEventPaymentMethods(eventId) : Promise.resolve([])),
    [eventId]
  );
  const allMethods = useAsync(() => listPaymentMethods(), []);
  const currency: Currency = event.data?.currency ?? 'CNY';

  // 选了现金就预填实收：未填的、且对应的订单已知
  useEffect(() => {
    if (!orders.data || !allMethods.data) return;
    const cashIds = new Set(allMethods.data.filter((m) => m.type === 'cash').map((m) => m.id));
    const newTendered: Record<string, string> = {};
    for (const o of orders.data) {
      const methodId = methodFor[o.id] ?? o.planned_payment_method_id ?? '';
      if (!cashIds.has(methodId)) continue;
      if ((tenderedFor[o.id] ?? '') !== '') continue;
      newTendered[o.id] = minorToInput(o.total_minor, currency);
    }
    if (Object.keys(newTendered).length) {
      setTenderedFor((prev) => ({ ...prev, ...newTendered }));
    }
  }, [orders.data, allMethods.data, methodFor, currency, tenderedFor]);

  async function confirm(o: Order) {
    setBusyId(o.id);
    setError(null);
    try {
      const methodId = methodFor[o.id] ?? o.planned_payment_method_id ?? '';
      const m = allMethods.data?.find((x) => x.id === methodId);
      const tenderedMinor =
        m?.type === 'cash' ? parseAmountToMinor(tenderedFor[o.id] || '0', currency) : null;
      await confirmPayment({ orderId: o.id, paymentMethodId: methodId || null, tenderedMinor, operationId: newId() });
      showToast(`订单 #${o.human_readable_number} 已确认`);
      orders.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  }

  async function cancel(o: Order) {
    if (!window.confirm(`确认取消订单 #${o.human_readable_number}？请先核实确实没有收到款。`)) return;
    setBusyId(o.id);
    setError(null);
    try {
      await voidOrder(o.id, '摊主核实未收款', newId());
      showToast('已取消');
      orders.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  }

  if (!eventId) return <ErrorBox message="请先选择展会" />;
  if (orders.loading) {
    return (
      <div className="center-page">
        <Spinner label="读取待付款订单…" />
      </div>
    );
  }

  return (
    <div className="content">
      <h1>待付款与挂起订单</h1>
      <p className="small muted">
        未付款订单会一直保留预留，不会自动过期。请逐单核实到账后再确认或取消。
      </p>
      <ErrorBox message={orders.error ?? error} />

      {!orders.data?.length ? <div className="notice ok">当前没有待付款订单。</div> : null}

      <div className="col">
        {(orders.data ?? []).map((o) => {
          const methodId = methodFor[o.id] ?? o.planned_payment_method_id ?? '';
          const m = allMethods.data?.find((x) => x.id === methodId);
          return (
            <div key={o.id} className="card">
              <div className="row">
                <div>
                  <div className="strong">#{o.human_readable_number}</div>
                  <div className="tiny muted">
                    {new Date(o.created_at).toLocaleString('zh-CN')} ·{' '}
                    {o.source === 'kiosk' ? '游客自助' : '摊主'}
                  </div>
                </div>
                <span className="spacer" />
                <span className="big-price">{formatMoney(o.total_minor, currency)}</span>
              </div>

              <PendingSummary orderId={o.id} currency={currency} />

              <div className="row" style={{ marginTop: 10 }}>
                {o.total_minor > 0 ? (
                  <>
                    <select
                      value={methodId}
                      onChange={(e) => setMethodFor({ ...methodFor, [o.id]: e.target.value })}
                      style={{ maxWidth: 180 }}
                    >
                      <option value="">选择实际收款方式</option>
                      {(methods.data ?? []).map((pm) => (
                        <option key={pm.id} value={pm.id}>
                          {pm.name}
                        </option>
                      ))}
                    </select>
                    {m?.type === 'cash' ? (
                      <span className="row tight">
                        <input
                          type="text"
                          placeholder={currency === 'CNY' ? '实收 0.00' : '实收 0'}
                          value={tenderedFor[o.id] ?? ''}
                          onChange={(e) => setTenderedFor({ ...tenderedFor, [o.id]: e.target.value })}
                          style={{ maxWidth: 140 }}
                        />
                        <button
                          className="small ghost"
                          type="button"
                          onClick={() =>
                            setTenderedFor({
                              ...tenderedFor,
                              [o.id]: minorToInput(o.total_minor, currency)
                            })
                          }
                        >
                          按应付金额
                        </button>
                      </span>
                    ) : null}
                  </>
                ) : null}
                <span className="spacer" />
                <button
                  className="primary"
                  disabled={busyId === o.id || (o.total_minor > 0 && !methodId)}
                  onClick={() => confirm(o)}
                >
                  {busyId === o.id ? <span className="spinner" /> : null}
                  {o.total_minor > 0 ? '确认已收款' : '确认发放'}
                </button>
                <button className="danger" disabled={busyId === o.id} onClick={() => cancel(o)}>
                  取消
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PendingSummary({ orderId, currency }: { orderId: string; currency: Currency }) {
  const d = useAsync(() => getOrderDetail(orderId), [orderId]);
  if (d.loading || !d.data) return null;
  return (
    <div className="small muted" style={{ marginTop: 6 }}>
      {d.data.items.map((it) => (
        <div key={it.id}>
          {it.product_name_snapshot}（{it.variant_name_snapshot}） × {it.quantity} ·{' '}
          {formatMoney(it.subtotal_minor, currency)}
        </div>
      ))}
    </div>
  );
}
