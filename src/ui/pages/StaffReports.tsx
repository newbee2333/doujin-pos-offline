import ReportExport from '../ReportExport';
import { useState } from 'react';
import {
  addCashMovement,
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
import { formatMoney, parseAmountToMinor } from '../../domain/money';
import { newId } from '../../domain/ids';
import { errorMessage, useApp } from '../../store';
import { ErrorBox, Field, Modal, Spinner, useAsync } from '../components';
import type { CashMovementType, Currency } from '../../domain/types';

const MOVEMENT_LABEL: Record<string, string> = {
  opening: '备用金',
  deposit: '存入',
  withdrawal: '取出'
};

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

  const [movementModal, setMovementModal] = useState<{ kind: CashMovementType; title: string } | null>(null);
  const [movementAmount, setMovementAmount] = useState('');
  const [movementNote, setMovementNote] = useState('');
  const [movementBusy, setMovementBusy] = useState(false);
  const [movementError, setMovementError] = useState<string | null>(null);

  if (!eventId) return <ErrorBox message="请先选择展会" />;
  const currency: Currency = event.data?.currency ?? 'CNY';
  const statusLabel =
    event.data?.status === 'active' ? '进行中' : event.data?.status === 'closed' ? '已收摊' : '草稿';

  function openMovement(kind: CashMovementType, title: string) {
    setMovementModal({ kind, title });
    setMovementAmount('');
    setMovementNote('');
    setMovementError(null);
  }

  async function submitMovement() {
    if (!movementModal) return;
    setMovementBusy(true);
    setMovementError(null);
    try {
      const amountMinor = parseAmountToMinor(movementAmount.trim(), currency);
      if (amountMinor <= 0 && movementModal.kind !== 'opening') {
        throw new Error('请输入大于 0 的金额');
      }
      await addCashMovement(
        eventId!,
        movementModal.kind,
        amountMinor,
        movementNote.trim() || movementModal.title,
        newId()
      );
      showToast(`已记录${movementModal.title}`);
      setMovementModal(null);
      cash.reload();
      movements.reload();
    } catch (e) {
      setMovementError(errorMessage(e));
    } finally {
      setMovementBusy(false);
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

      <ErrorBox message={dash.error} />
      {dash.data ? (
        <section className="report-overview" aria-label="营业概览">
          <div className="report-primary">
            <span className="eyebrow">本场净销售额</span>
            <strong>{formatMoney(dash.data.netSalesMinor, currency)}</strong>
            <span className="small muted">销售额减退款额，未扣成本</span>
          </div>
          <div className="report-orders">
            <span className="eyebrow">已完成订单</span>
            <strong>
              {dash.data.counts.completed}
              <small> 笔</small>
            </strong>
            <span className="small muted">
              待付款 {dash.data.counts.pending_payment} · 已取消 {dash.data.counts.voided}
            </span>
            <span className="tiny muted">
              已退款 {dash.data.counts.refunded} · 已纠错 {dash.data.counts.corrected}
            </span>
          </div>
          <dl className="report-secondary">
            <div>
              <dt>销售额</dt>
              <dd>{formatMoney(dash.data.salesMinor, currency)}</dd>
            </div>
            <div>
              <dt>优惠合计</dt>
              <dd>{formatMoney(dash.data.discountMinor, currency)}</dd>
            </div>
            <div>
              <dt>退款额</dt>
              <dd>{formatMoney(dash.data.refundMinor, currency)}</dd>
            </div>
            <div>
              <dt>销量 / 赠品发放</dt>
              <dd>
                {dash.data.unitsSold} / {dash.data.giftUnits}
                <small> 件</small>
              </dd>
            </div>
            <div>
              <dt>纠错额（审计）</dt>
              <dd>{formatMoney(dash.data.correctionMinor, currency)}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      <div className="cols-side" style={{ marginTop: 'var(--sp-4)' }}>
        <div className="stack">
          <div className="card">
            <h2>商品排行</h2>
            <ErrorBox message={ranking.error} />
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
                  {!ranking.loading && !ranking.error && !ranking.data?.length ? (
                    <tr>
                      <td colSpan={4} className="muted">
                        本场还没有商品销售记录。
                      </td>
                    </tr>
                  ) : null}
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
            <h2>库存消耗明细</h2>
            <p className="tiny muted" style={{ marginTop: -6 }}>
              卖出去多少件就消耗多少库存，套装按成分展开算。「套装带出」是随套装一起卖掉的，
              「单卖」是单独卖掉的。金额不在这里——套装是整单收的钱，拆到成分上是人为定的比例。
            </p>
            <div className="table-wrap">
              <table className="zebra">
                <thead>
                  <tr>
                    <th>商品</th>
                    <th className="num">套装带出</th>
                    <th className="num">单卖</th>
                    <th className="num">合计售出</th>
                    <th className="num">返库</th>
                    <th className="num">净消耗</th>
                  </tr>
                </thead>
                <tbody>
                  {consumption.data?.map((r) => (
                    <tr key={r.variant_id}>
                      <td>
                        {r.product_name}
                        <div className="tiny muted">
                          {r.variant_name}
                          {r.sku ? ` · SKU ${r.sku}` : ''}
                        </div>
                      </td>
                      <td className="num">{r.from_bundle_units || ''}</td>
                      <td className="num">{r.solo_units || ''}</td>
                      <td className="num">{r.sold_units}</td>
                      <td className="num">{r.returned_units || ''}</td>
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

          <ReportExport eventId={eventId} eventName={event.data?.name ?? '展会'} />
        </div>

        <aside className="side-panel">
          <div className="side-panel-head">
            <span className="strong">现金核对与收摊</span>
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
                    <dd className="big-price total-price">{formatMoney(cash.data.expectedMinor, currency)}</dd>
                  </div>
                </dl>

                <div className="stack" style={{ marginTop: 'var(--sp-4)' }}>
                  <Field label="实际盘点现金">
                    <input
                      value={actual}
                      onChange={(e) => setActual(e.target.value)}
                      placeholder={currency === 'CNY' ? '0.00' : '0'}
                      inputMode={currency === 'JPY' ? 'numeric' : 'decimal'}
                    />
                  </Field>
                  {!actual ? <div className="notice">尚未盘点，保存后会记录差额。</div> : null}
                  <Field label="备注">
                    <input value={settleNote} onChange={(e) => setSettleNote(e.target.value)} />
                  </Field>
                  <div className="row tight">
                    <button className="small" disabled={busy} onClick={() => openMovement('opening', '备用金')}>
                      设置备用金
                    </button>
                    <button className="small" disabled={busy} onClick={() => openMovement('deposit', '存入')}>
                      存入
                    </button>
                    <button className="small" disabled={busy} onClick={() => openMovement('withdrawal', '取出')}>
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
                                <td className="tiny">{new Date(m.created_at).toLocaleString('zh-CN')}</td>
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
                  const actualMinor = parseAmountToMinor(actual.trim() || '0', currency);
                  const res = await settleEvent(
                    eventId,
                    actualMinor,
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

      {movementModal ? (
        <Modal
          title={`记录${movementModal.title}`}
          onClose={movementBusy ? undefined : () => setMovementModal(null)}
          actions={
            <>
              <button disabled={movementBusy} onClick={() => setMovementModal(null)}>
                取消
              </button>
              <button className="primary" disabled={movementBusy || !movementAmount.trim()} onClick={submitMovement}>
                {movementBusy ? <span className="spinner" /> : null}
                确认记录
              </button>
            </>
          }
        >
          <div className="col">
            <Field label={`${movementModal.title}金额（${currency === 'CNY' ? '元' : '日元'}）`}>
              <input
                type="text"
                inputMode={currency === 'JPY' ? 'numeric' : 'decimal'}
                autoFocus
                value={movementAmount}
                onChange={(e) => setMovementAmount(e.target.value)}
                placeholder={currency === 'CNY' ? '例如 200.00' : '例如 10000'}
              />
            </Field>
            <Field label="说明（选填）">
              <input
                type="text"
                value={movementNote}
                onChange={(e) => setMovementNote(e.target.value)}
                placeholder={`默认记录为「${movementModal.title}」`}
              />
            </Field>
            <ErrorBox message={movementError} />
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
