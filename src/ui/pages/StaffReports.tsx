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

const MOVEMENT_LABEL: Record<string, string> = {
  opening: '备用金',
  deposit: '存入',
  withdrawal: '取出'
};

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
  const statusLabel =
    event.data?.status === 'active' ? '进行中' : event.data?.status === 'closed' ? '已收摊' : '草稿';

  /** 备用金 / 存入 / 取出共用一个入口，只是方向不同。 */
  async function addMovement(kind: 'opening' | 'deposit' | 'withdrawal', title: string) {
    const v = window.prompt(`${title}金额：`, '0');
    if (v === null) return;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      showToast('金额格式不正确');
      return;
    }
    try {
      await addCashMovement(
        eventId!,
        kind,
        currency === 'CNY' ? Math.round(n * 100) : Math.round(n),
        title,
        newId()
      );
      cash.reload();
      movements.reload();
    } catch (e) {
      showToast(errorMessage(e));
    }
  }

  if (dash.loading) {
    return (
      <div className="center-page">
        <Spinner label="统计中…" />
      </div>
    );
  }

  return (
    <div className="page page-cols">
      <div className="page-head">
        <h1>报表与收摊</h1>
        {event.data ? (
          <span className={`badge ${event.data.status === 'active' ? 'ok' : ''}`}>
            {event.data.name} · {statusLabel}
          </span>
        ) : null}
      </div>

      {/* 六个盒子改成一条带分隔线的数字条。原来每格各自一圈描边、每格 150px 起，
          六个盒子占掉整整一行高度，但这一行要读的只是六个数字 ——
          描边在这里没承载任何信息，去了反而更快扫。 */}
      {dash.data ? (
        <div className="stat-strip">
          <div className="cell">
            <div className="label">销售额</div>
            <div className="value">{formatMoney(dash.data.salesMinor, currency)}</div>
          </div>
          <div className="cell">
            <div className="label">净销售额</div>
            <div className="value">{formatMoney(dash.data.netSalesMinor, currency)}</div>
          </div>
          <div className="cell">
            <div className="label">退款额</div>
            <div className="value">{formatMoney(dash.data.refundMinor, currency)}</div>
          </div>
          <div className="cell">
            <div className="label">成交 / 待付款 / 取消</div>
            <div className="value">
              {dash.data.counts.completed} / {dash.data.counts.pending_payment} / {dash.data.counts.voided}
            </div>
          </div>
          <div className="cell">
            <div className="label">销量 / 赠品发放</div>
            <div className="value">
              {dash.data.unitsSold} / {dash.data.giftUnits}
            </div>
          </div>
          <div className="cell">
            <div className="label">纠错额（审计）</div>
            <div className="value">{formatMoney(dash.data.correctionMinor, currency)}</div>
          </div>
        </div>
      ) : null}

      <div className="cols-side" style={{ marginTop: 'var(--sp-4)' }}>
        <div className="stack">
          <div className="card">
            <h2>商品排行</h2>
            <div className="table-wrap">
              <table className="zebra">
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
              <table className="zebra">
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

          <div className="card">
            <h2>支付方式</h2>
            <div className="table-wrap">
              <table className="zebra">
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

          {settlements.data?.length ? (
            <div className="card">
              <h2>结算记录</h2>
              <div className="table-wrap">
                <table className="zebra">
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
            </div>
          ) : null}

          <div className="card">
            <h2>导出 CSV</h2>
            <p className="tiny muted">
              CSV 仅供分析，不能作为完整恢复格式。完整备份请使用「备份恢复」导出 SQLite。
            </p>
            <div className="row">
              <button className="small" onClick={async () => downloadCsv('orders.csv', await exportOrdersCsv(eventId))}>
                订单
              </button>
              <button
                className="small"
                onClick={async () => downloadCsv('order-items.csv', await exportOrderItemsCsv(eventId))}
              >
                订单明细
              </button>
              <button className="small" onClick={async () => downloadCsv('inventory.csv', await exportInventoryCsv(eventId))}>
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

        {/* 收摊独立成右栏。它是「收摊时才走一遍」的流程，混在报表长表里
            会被表格淹掉 —— 而这一步做错（盘点填错、忘了保存）当天就结算不了。 */}
        <aside className="side-panel">
          <div className="side-panel-head">
            <span className="strong">收摊结算</span>
          </div>

          <div className="side-panel-body">
            {cash.data ? (
              <>
                <dl className="ledger">
                  <div className="ledger-line">
                    <dt>开场备用金</dt>
                    <dd>{formatMoney(cash.data.openingMinor, currency)}</dd>
                  </div>
                  <div className="ledger-line">
                    <dt>有效现金收款</dt>
                    <dd>{formatMoney(cash.data.cashSalesMinor, currency)}</dd>
                  </div>
                  <div className="ledger-line">
                    <dt>实际现金退款</dt>
                    <dd>{formatMoney(cash.data.cashRefundMinor, currency)}</dd>
                  </div>
                  <div className="ledger-line">
                    <dt>存入 / 取出</dt>
                    <dd>
                      {formatMoney(cash.data.depositMinor, currency)} /{' '}
                      {formatMoney(cash.data.withdrawalMinor, currency)}
                    </dd>
                  </div>
                  <div className="ledger-total">
                    <dt className="strong">理论钱箱</dt>
                    <dd className="big-price total-price">
                      {formatMoney(cash.data.expectedMinor, currency)}
                    </dd>
                  </div>
                </dl>

                <div className="stack" style={{ marginTop: 'var(--sp-4)' }}>
                  <Field label="实际盘点现金">
                    <input
                      value={actual}
                      onChange={(e) => setActual(e.target.value)}
                      placeholder={currency === 'CNY' ? '0.00' : '0'}
                      inputMode="decimal"
                    />
                  </Field>
                  {!actual ? <div className="notice">尚未盘点，保存后会记录差额。</div> : null}
                  <Field label="备注">
                    <input value={settleNote} onChange={(e) => setSettleNote(e.target.value)} />
                  </Field>
                  <div className="row tight">
                    <button className="small" disabled={busy} onClick={() => addMovement('opening', '备用金')}>
                      设置备用金
                    </button>
                    <button className="small" disabled={busy} onClick={() => addMovement('deposit', '存入')}>
                      存入
                    </button>
                    <button className="small" disabled={busy} onClick={() => addMovement('withdrawal', '取出')}>
                      取出
                    </button>
                  </div>
                  {movements.data?.length ? (
                    <details>
                      <summary className="small muted">查看现金流水（{movements.data.length}）</summary>
                      <div className="table-wrap" style={{ marginTop: 'var(--sp-2)', maxHeight: '30vh' }}>
                        <table className="zebra">
                          <tbody>
                            {movements.data.map((m) => (
                              <tr key={m.id}>
                                <td className="tiny">
                                  {new Date(m.created_at).toLocaleString('zh-CN')}
                                </td>
                                <td>{m.reason ?? MOVEMENT_LABEL[m.type] ?? m.type}</td>
                                <td className="num">{formatMoney(m.amount_minor, currency)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  ) : null}
                </div>
              </>
            ) : (
              <Spinner label="读取现金账…" />
            )}
          </div>

          <div className="side-panel-foot">
            <ErrorBox message={error} />
            <button
              className="primary block"
              style={{ minHeight: 52 }}
              disabled={busy || !cash.data}
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
              {busy ? <span className="spinner" /> : null}
              保存结算
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
