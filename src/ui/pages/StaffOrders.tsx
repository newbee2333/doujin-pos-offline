import { useState } from 'react';
import { correctOrder, getOrderDetail, listOrders, recordRefund } from '../../services/orders';
import { getEvent } from '../../services/events';
import { listPaymentMethods } from '../../services/events';
import { formatMoney } from '../../domain/money';
import { newId } from '../../domain/ids';
import { errorMessage, useApp } from '../../store';
import { ErrorBox, Field, Modal, Spinner, useAsync } from '../components';
import type { Currency, Order } from '../../domain/types';

const STATUS_LABEL: Record<string, string> = {
  pending_payment: '待付款',
  completed: '已完成',
  voided: '已取消',
  refunded: '已退款',
  corrected: '已纠错'
};

export default function StaffOrdersPage() {
  const eventId = useApp((s) => s.currentEventId);
  const [status, setStatus] = useState('');
  const [keyword, setKeyword] = useState('');
  const [source, setSource] = useState('');
  const [methodId, setMethodId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);

  const event = useAsync(() => (eventId ? getEvent(eventId) : Promise.resolve(null)), [eventId]);
  const methods = useAsync(() => listPaymentMethods(), []);
  const orders = useAsync(
    () =>
      eventId
        ? listOrders({
            eventId,
            status: status || undefined,
            source: (source || undefined) as 'kiosk' | 'staff' | undefined,
            keyword: keyword || undefined,
            paymentMethodId: methodId || undefined,
            // 结束日期按当地含当天处理：+1 天
            from: dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : undefined,
            to: dateTo ? new Date(new Date(`${dateTo}T00:00:00`).getTime() + 86400000).toISOString() : undefined
          })
        : Promise.resolve([]),
    [eventId, status, source, methodId, keyword, dateFrom, dateTo]
  );
  const currency: Currency = event.data?.currency ?? 'CNY';

  if (!eventId) return <ErrorBox message="请先选择展会" />;

  return (
    <div className="content">
      <h1>订单</h1>
      <div className="card">
        <div className="row">
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 150 }}>
            <option value="">全部状态</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select value={source} onChange={(e) => setSource(e.target.value)} style={{ maxWidth: 130 }}>
            <option value="">全部来源</option>
            <option value="kiosk">游客自助</option>
            <option value="staff">摊主</option>
          </select>
          <select value={methodId} onChange={(e) => setMethodId(e.target.value)} style={{ maxWidth: 160 }}>
            <option value="">全部支付方式</option>
            {methods.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            title="起始日期"
            style={{ maxWidth: 160 }}
          />
          <span className="muted small">至</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            title="结束日期（含当天）"
            style={{ maxWidth: 160 }}
          />
          <input
            type="search"
            placeholder="订单号 / 商品名 / SKU"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ maxWidth: 240 }}
          />
          {status || source || methodId || dateFrom || dateTo || keyword ? (
            <button
              className="small ghost"
              onClick={() => {
                setStatus('');
                setSource('');
                setMethodId('');
                setDateFrom('');
                setDateTo('');
                setKeyword('');
              }}
            >
              清空筛选
            </button>
          ) : null}
        </div>
        <div className="small muted" style={{ marginTop: 6 }}>
          共 {orders.data?.length ?? 0} 笔
          {orders.data?.length === 200 ? '（仅显示最近 200 笔，请用筛选缩小范围）' : ''}
        </div>

        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th>订单号</th>
                <th>时间</th>
                <th>来源</th>
                <th className="num">金额</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.data?.map((o) => (
                <tr key={o.id}>
                  <td className="strong">#{o.human_readable_number}</td>
                  <td className="tiny">{new Date(o.created_at).toLocaleString('zh-CN')}</td>
                  <td>{o.source === 'kiosk' ? '游客' : '摊主'}</td>
                  <td className="num nowrap">{formatMoney(o.total_minor, currency)}</td>
                  <td>
                    <span
                      className={`badge ${
                        o.status === 'completed'
                          ? 'ok'
                          : o.status === 'pending_payment'
                            ? 'warn'
                            : o.status === 'voided'
                              ? ''
                              : 'danger'
                      }`}
                    >
                      {STATUS_LABEL[o.status]}
                    </span>
                  </td>
                  <td>
                    <button className="small" onClick={() => setDetailId(o.id)}>
                      详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {detailId ? <OrderDetailModal orderId={detailId} onClose={() => setDetailId(null)} onChanged={orders.reload} /> : null}
    </div>
  );
}

function OrderDetailModal({
  orderId,
  onClose,
  onChanged
}: {
  orderId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const showToast = useApp((s) => s.showToast);
  const d = useAsync(() => getOrderDetail(orderId), [orderId]);
  const methods = useAsync(() => listPaymentMethods(), []);
  const [action, setAction] = useState<'refund' | 'correct' | null>(null);
  const [methodId, setMethodId] = useState('');
  const [reason, setReason] = useState('');
  const [returns, setReturns] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (d.loading || !d.data) {
    return (
      <div className="center-page">
        <Spinner label="读取订单…" />
      </div>
    );
  }
  const { order, items, payment, refund, correction } = d.data;
  const currency = order.currency;

  const componentTotals = new Map<string, { qty: number; name: string }>();
  for (const it of items) {
    for (const c of it.components) {
      const cur = componentTotals.get(c.component_variant_id) ?? { qty: 0, name: c.component_name_snapshot };
      componentTotals.set(c.component_variant_id, { qty: cur.qty + c.quantity_total, name: cur.name });
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (action === 'refund') {
        await recordRefund({ orderId, paymentMethodId: methodId, reason, returns, operationId: newId() });
        showToast('已记录退款');
      } else if (action === 'correct') {
        await correctOrder({ orderId, reason, returns, operationId: newId() });
        showToast('已撤销误记');
      }
      setAction(null);
      d.reload();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`订单 #${order.human_readable_number}`}
      onClose={onClose}
      actions={<button onClick={onClose}>关闭</button>}
    >
      <div className="col">
        <div className="row">
          <span className="badge">{STATUS_LABEL[order.status]}</span>
          <span className="small muted">{new Date(order.created_at).toLocaleString('zh-CN')}</span>
          <span className="spacer" />
          <strong>{formatMoney(order.total_minor, currency)}</strong>
        </div>

        <div>
          {items.map((it) => (
            <div key={it.id} className="row" style={{ padding: '4px 0' }}>
              <div style={{ flex: 1 }}>
                {it.product_name_snapshot}（{it.variant_name_snapshot}）
                <div className="tiny muted">
                  {formatMoney(it.unit_price_minor, currency)} × {it.quantity}
                </div>
              </div>
              <div className="nowrap">{formatMoney(it.subtotal_minor, currency)}</div>
            </div>
          ))}
        </div>

        {payment ? (
          <div className="small">
            收款：{payment.method_name_snapshot} · {formatMoney(payment.amount_minor, currency)}
            {payment.tendered_minor !== null
              ? ` · 实收 ${formatMoney(payment.tendered_minor, currency)}，找零 ${formatMoney(payment.change_minor ?? 0, currency)}`
              : ''}
          </div>
        ) : null}
        {refund ? (
          <div className="small">
            退款：{refund.method_name_snapshot} · {formatMoney(refund.amount_minor, currency)} · {refund.reason}
          </div>
        ) : null}
        {correction ? <div className="small">纠错：{correction.reason}</div> : null}

        {order.status === 'completed' && !action ? (
          <div className="card" style={{ background: 'var(--surface-2)' }}>
            <h3>需要改正这笔订单？</h3>
            <p className="tiny muted">
              两种处理互不通用，金额都是整单全额。选错会导致报表口径不对，请按实际情况选择。
            </p>
            <div className="col" style={{ gap: 10 }}>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <button
                  type="button"
                  className="small"
                  style={{ minWidth: 132, borderColor: 'var(--warn)', color: 'var(--warn)' }}
                  onClick={() => setAction('refund')}
                >
                  整单退款
                </button>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div className="small strong">顾客确实付过钱，现在要退回去</div>
                  <div className="tiny muted">
                    你已经在外卖（现金 / 微信 / 支付宝）把钱退给顾客了，这里只是补一条记录。
                    计销售、也计退款，净额为零。
                  </div>
                </div>
              </div>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <button
                  type="button"
                  className="small"
                  style={{ minWidth: 132, borderColor: 'var(--danger)', color: 'var(--danger)' }}
                  onClick={() => setAction('correct')}
                >
                  撤销误记
                </button>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div className="small strong">这单本来就不该存在（记错了）</div>
                  <div className="tiny muted">
                    点错确认、金额记错、重复记账等。没有真实收款发生，因此不记销售也不记退款，
                    而是单列到「纠错额」供事后审计。真实收到过钱请不要用这个。
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {action ? (
          <div className="card" style={{ background: 'var(--surface-2)' }}>
            <h3>{action === 'refund' ? '整单退款' : '撤销误记'}</h3>
            <p className="tiny muted">
              {action === 'refund'
                ? '本操作只做记账：请先在外部完成退款并核实。金额为整单全额，实物可只部分返库。'
                : '仅在确认属于记账错误时使用；真实已收款必须走退款流程。'}
            </p>
            {action === 'refund' ? (
              <Field label="实际退款渠道">
                <select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
                  <option value="">请选择</option>
                  {methods.data?.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field label="原因">
              <input value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div>
              <div className="small muted">可重新上架数量（不超过原售出量）</div>
              {Array.from(componentTotals.entries()).map(([variantId, info]) => (
                <div key={variantId} className="row tight">
                  <span style={{ flex: 1 }}>{info.name}</span>
                  <input
                    type="number"
                    min={0}
                    max={info.qty}
                    value={returns[variantId] ?? 0}
                    onChange={(e) =>
                      setReturns({ ...returns, [variantId]: Math.max(0, Math.min(info.qty, Number(e.target.value))) })
                    }
                    style={{ maxWidth: 100 }}
                  />
                  <span className="tiny muted">/ {info.qty}</span>
                </div>
              ))}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="danger" disabled={busy || !reason.trim()} onClick={submit}>
                {busy ? <span className="spinner" /> : null}
                确认{action === 'refund' ? '记录退款' : '撤销'}
              </button>
              <button onClick={() => setAction(null)} disabled={busy}>
                取消
              </button>
            </div>
            <ErrorBox message={error} />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
