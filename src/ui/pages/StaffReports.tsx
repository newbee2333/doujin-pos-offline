import { useState } from 'react';
import {
  addCashMovement,
  exportInventoryCsv,
  exportInventoryTransactionsCsv,
  exportOrderItemsCsv,
  exportOrdersCsv,
  exportPaymentSummaryCsv,
  exportProductSalesCsv,
  getDashboard,
  getExpectedCash,
  getInventoryConsumption,
  getPaymentSummary,
  getProductRanking,
  listCashMovements,
  listSettlements,
  settleEvent
} from '../../services/reports';
import { getEvent } from '../../services/events';
import { formatMoney } from '../../domain/money';
import { newId } from '../../domain/ids';
import { errorMessage, useApp } from '../../store';
import { ErrorBox, Field, Spinner, useAsync } from '../components';
import type { Currency } from '../../domain/types';

function downloadCsv(name: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}

export default function StaffReportsPage() {
  const eventId = useApp((s) => s.currentEventId);
  const showToast = useApp((s) => s.showToast);
  const event = useAsync(() => (eventId ? getEvent(eventId) : Promise.resolve(null)), [eventId]);
  const dash = useAsync(() => (eventId ? getDashboard(eventId) : Promise.resolve(null)), [eventId]);
  const payments = useAsync(() => (eventId ? getPaymentSummary(eventId) : Promise.resolve([])), [eventId]);
  const ranking = useAsync(() => (eventId ? getProductRanking(eventId) : Promise.resolve([])), [eventId]);
  const consumption = useAsync(
    () => (eventId ? getInventoryConsumption(eventId) : Promise.resolve([])),
    [eventId]
  );
  const cash = useAsync(() => (eventId ? getExpectedCash(eventId) : Promise.resolve(null)), [eventId]);
  const movements = useAsync(() => (eventId ? listCashMovements(eventId) : Promise.resolve([])), [eventId]);
  const settlements = useAsync(() => (eventId ? listSettlements(eventId) : Promise.resolve([])), [eventId]);

  const [actual, setActual] = useState('');
  const [settleNote, setSettleNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!eventId) return <ErrorBox message="请先选择展会" />;
  const currency: Currency = event.data?.currency ?? 'CNY';
  if (dash.loading) {
    return (
      <div className="center-page">
        <Spinner label="统计中…" />
      </div>
    );
  }

  return (
    <div className="content">
      <h1>报表与收摊</h1>

      {dash.data ? (
        <div className="stat-grid">
          <div className="stat">
            <div className="label">销售额</div>
            <div className="value">{formatMoney(dash.data.salesMinor, currency)}</div>
          </div>
          <div className="stat">
            <div className="label">退款额</div>
            <div className="value">{formatMoney(dash.data.refundMinor, currency)}</div>
          </div>
          <div className="stat">
            <div className="label">净销售额</div>
            <div className="value">{formatMoney(dash.data.netSalesMinor, currency)}</div>
          </div>
          <div className="stat">
            <div className="label">纠错额（审计）</div>
            <div className="value">{formatMoney(dash.data.correctionMinor, currency)}</div>
          </div>
          <div className="stat">
            <div className="label">成交 / 待付款 / 取消</div>
            <div className="value">
              {dash.data.counts.completed} / {dash.data.counts.pending_payment} / {dash.data.counts.voided}
            </div>
          </div>
          <div className="stat">
            <div className="label">销量 / 赠品发放</div>
            <div className="value">
              {dash.data.unitsSold} / {dash.data.giftUnits}
            </div>
          </div>
        </div>
      ) : null}

      <div className="card">
        <h2>支付方式</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>方式</th>
                <th className="num">有效收款</th>
                <th className="num">实际退款</th>
                <th className="num">净流入</th>
              </tr>
            </thead>
            <tbody>
              {payments.data?.map((p) => (
                <tr key={p.method_name}>
                  <td>{p.method_name}</td>
                  <td className="num">{formatMoney(p.received_minor, currency)}</td>
                  <td className="num">{formatMoney(p.refunded_minor, currency)}</td>
                  <td className="num strong">{formatMoney(p.net_minor, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>商品排行</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>商品</th>
                  <th className="num">数量</th>
                  <th className="num">金额</th>
                  <th className="num">含退款单</th>
                </tr>
              </thead>
              <tbody>
                {ranking.data?.map((r, i) => (
                  <tr key={i}>
                    <td>
                      {r.product_name}
                      <div className="tiny muted">{r.variant_name}</div>
                    </td>
                    <td className="num">{r.units}</td>
                    <td className="num">{formatMoney(r.amount_minor, currency)}</td>
                    <td className="num">{r.refund_order_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <h2>库存成分消耗</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>成分</th>
                  <th className="num">售出</th>
                  <th className="num">返库</th>
                  <th className="num">净消耗</th>
                </tr>
              </thead>
              <tbody>
                {consumption.data?.map((r) => (
                  <tr key={r.variant_id}>
                    <td>{r.component_name}</td>
                    <td className="num">{r.sold_units}</td>
                    <td className="num">{r.returned_units}</td>
                    <td className="num strong">{r.net_units}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>现金与收摊</h2>
        {cash.data ? (
          <div className="grid cols-2">
            <dl className="kv">
              <dt>开场备用金</dt>
              <dd>{formatMoney(cash.data.openingMinor, currency)}</dd>
              <dt>有效现金收款</dt>
              <dd>{formatMoney(cash.data.cashSalesMinor, currency)}</dd>
              <dt>实际现金退款</dt>
              <dd>{formatMoney(cash.data.cashRefundMinor, currency)}</dd>
              <dt>存入 / 取出</dt>
              <dd>
                {formatMoney(cash.data.depositMinor, currency)} / {formatMoney(cash.data.withdrawalMinor, currency)}
              </dd>
              <dt>理论钱箱</dt>
              <dd>
                <strong>{formatMoney(cash.data.expectedMinor, currency)}</strong>
              </dd>
            </dl>
            <div className="col">
              <Field label="实际盘点现金">
                <input
                  value={actual}
                  onChange={(e) => setActual(e.target.value)}
                  placeholder={currency === 'CNY' ? '0.00' : '0'}
                />
              </Field>
              <Field label="备注">
                <input value={settleNote} onChange={(e) => setSettleNote(e.target.value)} />
              </Field>
              <div className="row">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      const n = Number(actual || 0);
                      const res = await settleEvent(
                        eventId,
                        currency === 'CNY' ? Math.round(n * 100) : Math.round(n),
                        settleNote || null,
                        newId()
                      );
                      showToast(`已结算，差额 ${formatMoney(res.differenceMinor, currency)}`);
                      settlements.reload();
                      cash.reload();
                    } catch (e) {
                      setError(errorMessage(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  保存结算
                </button>
                <button
                  disabled={busy}
                  onClick={async () => {
                    const v = window.prompt('备用金金额：', '0');
                    if (v === null) return;
                    try {
                      await addCashMovement(
                        eventId,
                        'opening',
                        currency === 'CNY' ? Math.round(Number(v) * 100) : Math.round(Number(v)),
                        '开场备用金',
                        newId()
                      );
                      cash.reload();
                      movements.reload();
                    } catch (e) {
                      showToast(errorMessage(e));
                    }
                  }}
                >
                  设置备用金
                </button>
                <button
                  disabled={busy}
                  onClick={async () => {
                    const v = window.prompt('存入金额：', '0');
                    if (v === null) return;
                    await addCashMovement(
                      eventId,
                      'deposit',
                      currency === 'CNY' ? Math.round(Number(v) * 100) : Math.round(Number(v)),
                      '存入',
                      newId()
                    );
                    cash.reload();
                    movements.reload();
                  }}
                >
                  存入
                </button>
                <button
                  disabled={busy}
                  onClick={async () => {
                    const v = window.prompt('取出金额：', '0');
                    if (v === null) return;
                    await addCashMovement(
                      eventId,
                      'withdrawal',
                      currency === 'CNY' ? Math.round(Number(v) * 100) : Math.round(Number(v)),
                      '取出',
                      newId()
                    );
                    cash.reload();
                    movements.reload();
                  }}
                >
                  取出
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {settlements.data?.length ? (
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead>
                <tr>
                  <th>结算时间</th>
                  <th className="num">理论</th>
                  <th className="num">实际</th>
                  <th className="num">差额</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {settlements.data.map((s) => (
                  <tr key={s.id}>
                    <td className="tiny">{new Date(s.settled_at).toLocaleString('zh-CN')}</td>
                    <td className="num">{formatMoney(s.expected_cash_minor, currency)}</td>
                    <td className="num">{formatMoney(s.actual_cash_minor, currency)}</td>
                    <td className="num strong">{formatMoney(s.difference_minor, currency)}</td>
                    <td>{s.superseded ? <span className="badge">已被后续结算替代</span> : '最新'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <ErrorBox message={error} />
      </div>

      <div className="card">
        <h2>导出 CSV</h2>
        <p className="tiny muted">CSV 仅供分析，不能作为完整恢复格式。完整备份请使用「备份恢复」导出 SQLite。</p>
        <div className="row">
          <button
            className="small"
            onClick={async () => downloadCsv('orders.csv', await exportOrdersCsv(eventId))}
          >
            订单
          </button>
          <button
            className="small"
            onClick={async () => downloadCsv('order-items.csv', await exportOrderItemsCsv(eventId))}
          >
            订单明细
          </button>
          <button
            className="small"
            onClick={async () => downloadCsv('inventory.csv', await exportInventoryCsv(eventId))}
          >
            库存
          </button>
          <button
            className="small"
            onClick={async () =>
              downloadCsv('inventory-transactions.csv', await exportInventoryTransactionsCsv(eventId))
            }
          >
            库存流水
          </button>
          <button
            className="small"
            onClick={async () => downloadCsv('product-sales.csv', await exportProductSalesCsv(eventId))}
          >
            商品销售汇总
          </button>
          <button
            className="small"
            onClick={async () => downloadCsv('payment-summary.csv', await exportPaymentSummaryCsv(eventId))}
          >
            付款汇总
          </button>
        </div>
      </div>
    </div>
  );
}
