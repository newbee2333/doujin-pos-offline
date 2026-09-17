import { useEffect, useMemo, useState } from 'react';
import { confirmPayment, getOrderDetail, listOrders, voidOrder } from '../../services/orders';
import { getEvent, getEventPaymentMethods } from '../../services/events';
import { listPaymentMethods } from '../../services/events';
import { formatMoney, minorToInput, parseAmountToMinor } from '../../domain/money';
import { newId } from '../../domain/ids';
import { errorMessage, useApp } from '../../store';
import { ErrorBox, Spinner, useAsync } from '../components';
import type { Currency, Order } from '../../domain/types';

/** 队列按「最早在前」排——先来的先处理，和现场排队顺序一致。
    listOrders 默认是 created_at DESC（订单页要最新的在上），这里反过来。 */
function toQueue(orders: Order[]): Order[] {
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
  const eventId = useApp((s) => s.currentEventId);
  const showToast = useApp((s) => s.showToast);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [methodFor, setMethodFor] = useState<Record<string, string>>({});
  const [tenderedFor, setTenderedFor] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  const queue = useMemo(() => toQueue(orders.data ?? []), [orders.data]);

  // 选中项跟着数据走：列表刷新后如果那一单已经确认/取消，自动落到队首。
  useEffect(() => {
    if (!queue.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !queue.some((o) => o.id === selectedId)) {
      setSelectedId(queue[0].id);
    }
  }, [queue, selectedId]);

  const selected = queue.find((o) => o.id === selectedId) ?? null;

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

  const selectedMethodId = selected
    ? methodFor[selected.id] ?? selected.planned_payment_method_id ?? ''
    : '';
  const selectedMethod = allMethods.data?.find((x) => x.id === selectedMethodId);

  return (
    <div className="page page-cols">
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
          {/* 左队列：一单一行（单号 / 时间·来源 / 金额）。
              原来一单一张卡纵向堆，5 单就要滚两屏才看得到最后一单，
              而营业中对单时顾客是举着 #A16 站在台前的，找单本身成了瓶颈。 */}
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
                        {clockOf(o.created_at)} · {o.source === 'kiosk' ? '游客自助' : '摊主开单'}
                      </div>
                    </div>
                    <span className="queue-amt">{formatMoney(o.total_minor, currency)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 右处理面板：选中的那一单的全部信息 + 操作，一屏走完 */}
          {selected ? (
            <div className="side-panel">
              <div className="side-panel-head">
                <span className="strong total-price">#{selected.human_readable_number}</span>
                <span className="badge warn">待付款</span>
                <span className="spacer" />
                <span className="big-price total-price">
                  {formatMoney(selected.total_minor, currency)}
                </span>
              </div>

              <div className="side-panel-body">
                <PendingDetail order={selected} currency={currency} />
              </div>

              <div className="side-panel-foot">
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
                      <>
                        <div className="field-label">
                          <span>实收金额（{currency === 'CNY' ? '元' : '日元'}）</span>
                          <button
                            type="button"
                            className="link-btn"
                            onClick={() =>
                              setTenderedFor({
                                ...tenderedFor,
                                [selected.id]: minorToInput(selected.total_minor, currency)
                              })
                            }
                          >
                            按应付金额
                          </button>
                        </div>
                        <input
                          type="text"
                          placeholder={currency === 'CNY' ? '0.00' : '0'}
                          value={tenderedFor[selected.id] ?? ''}
                          onChange={(e) => setTenderedFor({ ...tenderedFor, [selected.id]: e.target.value })}
                          aria-label="实收金额"
                        />
                      </>
                    ) : null}
                  </>
                ) : null}

                <ErrorBox message={error} />

                <div className="row">
                  <button
                    className="primary"
                    style={{ flex: 1, minHeight: 52 }}
                    disabled={busyId === selected.id || (selected.total_minor > 0 && !selectedMethodId)}
                    onClick={() => confirm(selected)}
                  >
                    {busyId === selected.id ? <span className="spinner" /> : null}
                    {selected.total_minor > 0 ? '确认已收款' : '确认发放'}
                  </button>
                  <button
                    className="danger"
                    style={{ minHeight: 52 }}
                    disabled={busyId === selected.id}
                    onClick={() => cancel(selected)}
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

/** 选中订单的明细：来源、时间、预留件数、等待时长、逐行商品。 */
function PendingDetail({ order, currency }: { order: Order; currency: Currency }) {
  const d = useAsync(() => getOrderDetail(order.id), [order.id]);
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
          <div className="pos-line-amt">{formatMoney(it.subtotal_minor, currency)}</div>
        </div>
      ))}

      {order.note ? <div className="notice info">备注：{order.note}</div> : null}
    </>
  );
}
