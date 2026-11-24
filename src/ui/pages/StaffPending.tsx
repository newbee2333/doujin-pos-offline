import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { confirmPayment, getOrderDetail, listOrderSummaries, voidOrder, type OrderSummary } from '../../services/orders';
import { getEvent, getEventPaymentMethods, listPaymentMethods } from '../../services/events';
import { formatMoney, minorToInput, parseAmountToMinor } from '../../domain/money';
import { newId } from '../../domain/ids';
import { errorMessage, useApp } from '../../store';
import { ConfirmDialog, ErrorBox, Spinner, useAsync } from '../components';
import CashTenderControl from '../CashTenderControl';
import type { Currency, Order } from '../../domain/types';
import PendingPriceEditor from '../PendingPriceEditor';
import { acknowledgeOrderPrice } from '../../services/order-pricing';
import { PriceSummary } from '../Pricing';

function toQueue(orders: OrderSummary[]): OrderSummary[] {
  return [...orders].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function clockOf(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function waitedMinutes(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

export default function StaffPendingPage() {
  const [params] = useSearchParams();
  const eventId = useApp((s) => s.currentEventId);
  const showToast = useApp((s) => s.showToast);
  const bumpDataVersion = useApp((s) => s.bumpDataVersion);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [methodFor, setMethodFor] = useState<Record<string, string>>({});
  const [tenderedFor, setTenderedFor] = useState<Record<string, string>>({});
  const lastAutoKeyFor = useRef<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(() => params.get('order'));
  const [adjustOrder, setAdjustOrder] = useState<Order | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Order | null>(null);

  const orders = useAsync(
    () => (eventId ? listOrderSummaries({ eventId, status: 'pending_payment', limit: 200 }) : Promise.resolve([])),
    [eventId]
  );

  // 切回页面或窗口重新聚焦时自动刷新待付款队列，避免忘记点刷新漏单
  useEffect(() => {
    const onResume = () => {
      if (document.visibilityState === 'visible') orders.reload();
    };
    window.addEventListener('focus', onResume);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      window.removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [orders.reload]);
  const event = useAsync(() => (eventId ? getEvent(eventId) : Promise.resolve(null)), [eventId]);
  const methods = useAsync(
    () => (eventId ? getEventPaymentMethods(eventId) : Promise.resolve([])),
    [eventId]
  );
  const allMethods = useAsync(() => listPaymentMethods(), []);
  const currency: Currency = event.data?.currency ?? 'CNY';

  const queue = useMemo(() => toQueue(orders.data ?? []), [orders.data]);

  useEffect(() => {
    if (orders.loading || orders.error) return;
    if (!queue.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !queue.some((o) => o.id === selectedId)) {
      setSelectedId(queue[0].id);
    }
  }, [queue, selectedId, orders.loading, orders.error]);

  const selected = queue.find((o) => o.id === selectedId) ?? null;

  useEffect(() => {
    if (!orders.data || !allMethods.data) return;
    const cashIds = new Set(allMethods.data.filter((m) => m.type === 'cash').map((m) => m.id));
    const updates: Record<string, string> = {};
    const activeIds = new Set<string>();
    for (const o of orders.data) {
      activeIds.add(o.id);
      const methodId = methodFor[o.id] ?? o.planned_payment_method_id ?? '';
      const isCash = cashIds.has(methodId) && o.total_minor > 0;
      const autoKey = isCash ? `${o.pricing_version ?? 0}:${o.total_minor}:${methodId}` : '';
      if (!autoKey) {
        delete lastAutoKeyFor.current[o.id];
        continue;
      }
      if (lastAutoKeyFor.current[o.id] !== autoKey) {
        lastAutoKeyFor.current[o.id] = autoKey;
        updates[o.id] = minorToInput(o.total_minor, currency);
      }
    }
    for (const id of Object.keys(lastAutoKeyFor.current)) {
      if (!activeIds.has(id)) delete lastAutoKeyFor.current[id];
    }
    if (Object.keys(updates).length) {
      setTenderedFor((prev) => ({ ...prev, ...updates }));
    }
  }, [orders.data, allMethods.data, methodFor, currency]);

  async function confirm(o: Order) {
    setBusyId(o.id);
    setError(null);
    try {
      const isPaid = o.total_minor > 0;
      const methodId = isPaid ? (methodFor[o.id] ?? o.planned_payment_method_id ?? '') : '';
      const m = isPaid ? allMethods.data?.find((x) => x.id === methodId) : null;
      const tenderedMinor =
        isPaid && m?.type === 'cash' ? parseAmountToMinor(tenderedFor[o.id] ?? '', currency) : null;
      await confirmPayment({
        orderId: o.id,
        paymentMethodId: isPaid ? methodId || null : null,
        tenderedMinor,
        expectedPricingVersion: o.pricing_version ?? 0,
        operationId: newId()
      });
      showToast(`订单 #${o.human_readable_number} 已确认`);
      bumpDataVersion();
      orders.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  }

  async function doCancel(o: Order) {
    setBusyId(o.id);
    setError(null);
    try {
      await voidOrder(o.id, '摊主核实未收款', newId());
      setCancelTarget(null);
      showToast('已取消');
      bumpDataVersion();
      orders.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  }

  if (!eventId) return <ErrorBox message="请先选择展会" />;
  if (orders.loading && !orders.data) {
    return (
      <div className="center-page">
        <Spinner label="读取待付款订单…" />
      </div>
    );
  }

  const selectedMethodId = selected
    ? methodFor[selected.id] ?? selected.planned_payment_method_id ?? ''
    : '';
  const selectedMethod = allMethods.data?.find((x) => x.id === selectedMethodId);

  return (
    <div className="page page-cols">
      {adjustOrder && (
        <PendingPriceEditor
          order={adjustOrder}
          onClose={() => {
            setAdjustOrder(null);
            orders.reload();
          }}
          onDone={() => {
            setTenderedFor((previous) => {
              const next = { ...previous };
              delete next[adjustOrder.id];
              return next;
            });
            setAdjustOrder(null);
            orders.reload();
            showToast('金额已调整，请顾客重新核对');
          }}
        />
      )}

      {cancelTarget ? (
        <ConfirmDialog
          title="取消这笔待付款订单？"
          message={`确认取消订单 #${cancelTarget.human_readable_number}？请先核实确实没有收到款，取消后将释放预留库存。`}
          confirmText="确认取消"
          danger
          busy={busyId === cancelTarget.id}
          onConfirm={() => void doCancel(cancelTarget)}
          onCancel={() => setCancelTarget(null)}
        />
      ) : null}

      <div className="page-head">
        <h1>待付款与挂起订单</h1>
        {queue.length ? <span className="badge accent">{queue.length} 笔等待处理</span> : null}
        <span className="spacer" />
        <button className="small" onClick={orders.reload} disabled={orders.loading}>
          刷新
        </button>
      </div>

      <ErrorBox message={orders.error ?? error} />

      {!queue.length ? (
        <div className="notice ok">当前没有待付款订单。</div>
      ) : (
        <div className="cols-side queue-layout" style={{ marginTop: 'var(--sp-3)' }}>
          <div className="side-panel">
            <div className="side-panel-head">
              <span className="strong">等待中 · {queue.length}</span>
              <span className="spacer" />
              <span className="tiny muted">最早在前</span>
            </div>
            <div className="side-panel-body">
              <div className="queue">
                {queue.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className={`queue-item ${o.id === selectedId ? 'active' : ''}`}
                    onClick={() => setSelectedId(o.id)}
                    aria-pressed={o.id === selectedId}
                  >
                    <div>
                      <div className="queue-no">#{o.human_readable_number}</div>
                      <div className="queue-meta">
                        {clockOf(o.created_at)} · {o.payment_method_name}
                      </div>
                      {o.item_summary ? <div className="queue-summary">{o.item_summary}</div> : null}
                    </div>
                    <span className="queue-amt">{formatMoney(o.total_minor, currency)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {selected ? (
            <div className="side-panel">
              <div className="side-panel-head">
                <span className="strong total-price">#{selected.human_readable_number}</span>
                <span className="badge warn">待付款</span>
                <span className="spacer" />
                <span className="big-price total-price">{formatMoney(selected.total_minor, currency)}</span>
              </div>

              <div className="side-panel-body">
                <PendingDetail order={selected} currency={currency} />
              </div>

              <div className="side-panel-foot">
                <button className="small" disabled={!!busyId} onClick={() => setAdjustOrder(selected)}>
                  {selected.pricing_editing ? '继续调价 / 取消调价' : '人工优惠 / 调整应收'}
                </button>
                {selected.pricing_editing ? (
                  <div className="notice warn">本单正在调价，暂时不能确认收款。可继续调价或取消本次调整。</div>
                ) : (selected.customer_ack_version ?? 0) !== (selected.pricing_version ?? 0) ? (
                  <div className="notice warn">
                    <p>金额已调整，请顾客重新核对。</p>
                    <button
                      disabled={!!busyId}
                      onClick={async () => {
                        setBusyId(selected.id);
                        try {
                          await acknowledgeOrderPrice(selected.id, selected.pricing_version ?? 0, 'staff');
                          orders.reload();
                        } catch (e) {
                          setError(errorMessage(e));
                        } finally {
                          setBusyId(null);
                        }
                      }}
                    >
                      顾客已核对新的应收金额
                    </button>
                  </div>
                ) : null}
                {selected.total_minor > 0 ? (
                  <>
                    <div className="field-label">实际收款方式（可与顾客选择不同）</div>
                    <div className="seg">
                      {(methods.data ?? []).map((pm) => (
                        <button
                          key={pm.id}
                          type="button"
                          className={`seg-item ${selectedMethodId === pm.id ? 'active' : ''}`}
                          onClick={() => setMethodFor({ ...methodFor, [selected.id]: pm.id })}
                        >
                          {pm.name}
                        </button>
                      ))}
                    </div>
                    {selectedMethod?.type === 'cash' ? (
                      <CashTenderControl
                        totalMinor={selected.total_minor}
                        currency={currency}
                        value={tenderedFor[selected.id] ?? ''}
                        disabled={busyId === selected.id}
                        onChange={(next) => setTenderedFor({ ...tenderedFor, [selected.id]: next })}
                      />
                    ) : null}
                  </>
                ) : null}

                <ErrorBox message={error} />

                <div className="row">
                  <button
                    className="primary"
                    style={{ flex: 1, minHeight: 52 }}
                    disabled={
                      busyId === selected.id ||
                      !!selected.pricing_editing ||
                      (selected.customer_ack_version ?? 0) !== (selected.pricing_version ?? 0) ||
                      (selected.total_minor > 0 && !selectedMethodId)
                    }
                    onClick={() => confirm(selected)}
                  >
                    {busyId === selected.id ? <span className="spinner" /> : null}
                    {selected.total_minor > 0 ? '确认已收款' : '确认发放'}
                  </button>
                  <button
                    className="danger"
                    style={{ minHeight: 52 }}
                    disabled={busyId === selected.id}
                    onClick={() => setCancelTarget(selected)}
                  >
                    取消订单
                  </button>
                </div>

                <p className="tiny muted" style={{ margin: 0 }}>
                  未付款订单会一直保留预留，不会自动过期。请逐单核实到账后再确认或取消。
                </p>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function PendingDetail({ order, currency }: { order: Order; currency: Currency }) {
  const d = useAsync(() => getOrderDetail(order.id), [order.id, order.pricing_version]);
  const items = d.data?.items ?? [];
  const units = items.reduce((a, it) => a + it.quantity, 0);
  const waited = waitedMinutes(order.created_at);

  return (
    <>
      <p className="small muted" style={{ marginTop: 0 }}>
        {order.source === 'kiosk' ? '游客自助提交' : '摊主开单'} · {clockOf(order.created_at)}
        {items.length ? ` · 预留 ${units} 件` : ''} · 已等待 {waited} 分钟
      </p>

      {d.loading && !items.length ? <Spinner label="读取明细…" /> : null}

      {items.map((it) => (
        <div key={it.id} className="pos-line">
          <div className="pos-line-main">
            <div className="pos-line-name">
              {it.product_name_snapshot}（{it.variant_name_snapshot}）
            </div>
            <div className="pos-line-sub">
              {formatMoney(it.unit_price_minor, currency)} × {it.quantity}
            </div>
          </div>
          <div className="pos-line-amt">{formatMoney(it.net_minor ?? it.subtotal_minor, currency)}</div>
        </div>
      ))}

      <PriceSummary quote={order.pricing_json ? JSON.parse(order.pricing_json) : null} currency={currency} />
      {order.note ? <div className="notice info">备注：{order.note}</div> : null}
    </>
  );
}
