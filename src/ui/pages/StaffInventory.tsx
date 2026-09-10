import { useState } from 'react';
import { adjustStock, getInventory, listInventory, listTransactions, reconcile } from '../../services/inventory';
import { listEventConfigs } from '../../services/events';
import { newId } from '../../domain/ids';
import { errorMessage, useApp } from '../../store';
import { ErrorBox, Field, Modal, Spinner, useAsync } from '../components';

/** 手工调整可选的类型（售出/预留等由交易流程产生，不在这里选）。 */
type AdjustKind = 'restock' | 'correction' | 'damaged' | 'personal' | 'lost' | 'other';

const ADJUST_TYPES: { value: AdjustKind; label: string }[] = [
  { value: 'restock', label: '补货' },
  { value: 'correction', label: '盘点调整' },
  { value: 'damaged', label: '报损' },
  { value: 'personal', label: '自用' },
  { value: 'lost', label: '丢失' },
  { value: 'other', label: '其他' }
];

interface AdjustTarget {
  variantId: string;
  name: string;
  /** 由快捷按钮带入的预设，摊主只需核对前后数量再确认。 */
  preset?: { type: AdjustKind; delta: number; reason: string };
}

export default function StaffInventoryPage() {
  const eventId = useApp((s) => s.currentEventId);
  const showToast = useApp((s) => s.showToast);
  const [adjust, setAdjust] = useState<AdjustTarget | null>(null);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [showTx, setShowTx] = useState(false);

  const configs = useAsync(() => (eventId ? listEventConfigs(eventId) : Promise.resolve([])), [eventId]);
  const inventory = useAsync(() => (eventId ? listInventory(eventId) : Promise.resolve([])), [eventId]);

  if (!eventId) return <ErrorBox message="请先选择展会" />;
  if (configs.loading) {
    return (
      <div className="center-page">
        <Spinner label="读取库存…" />
      </div>
    );
  }

  return (
    <div className="content">
      <div className="row">
        <h1 style={{ margin: 0 }}>库存与流水</h1>
        <span className="spacer" />
        <button
          onClick={async () => {
            const p = await reconcile(eventId);
            setProblems(p);
            showToast(p.length ? `发现 ${p.length} 项不一致` : '对账通过');
          }}
        >
          对账
        </button>
      </div>

      {problems ? (
        problems.length ? (
          <div className="notice danger" style={{ marginTop: 10 }}>
            {problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </div>
        ) : (
          <div className="notice ok" style={{ marginTop: 10 }}>
            余额、流水与预留三者一致。
          </div>
        )
      ) : null}

      <div className="card" style={{ marginTop: 12 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>商品</th>
                <th className="num">初始</th>
                <th className="num">实际</th>
                <th className="num">预留</th>
                <th className="num">可用</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {configs.data
                ?.filter((c) => c.product_type === 'normal' || c.product_type === 'gift')
                .map((c) => {
                  const inv = inventory.data?.find((i) => i.variant_id === c.variant_id);
                  const physical = inv?.physical_stock ?? 0;
                  const reserved = inv?.reserved_stock ?? 0;
                  const available = physical - reserved;
                  const label = `${c.product_name}（${c.variant_name}）`;
                  return (
                    <tr key={c.variant_id}>
                      <td>
                        {c.product_name}
                        <div className="tiny muted">{c.variant_name}</div>
                      </td>
                      <td className="num">{inv?.initial_stock ?? '—'}</td>
                      <td className="num">{physical}</td>
                      <td className="num">{reserved}</td>
                      <td className="num strong">{available}</td>
                      <td className="nowrap">
                        <span className="row tight">
                          <button
                            className="small"
                            title="补货 1 件"
                            onClick={() =>
                              setAdjust({
                                variantId: c.variant_id,
                                name: label,
                                preset: { type: 'restock', delta: 1, reason: '补货' }
                              })
                            }
                          >
                            +1
                          </button>
                          <button
                            className="small"
                            title="报损 1 件"
                            disabled={available <= 0}
                            onClick={() =>
                              setAdjust({
                                variantId: c.variant_id,
                                name: label,
                                preset: { type: 'damaged', delta: -1, reason: '报损' }
                              })
                            }
                          >
                            −1
                          </button>
                          <button
                            className="small ghost"
                            onClick={() => setAdjust({ variantId: c.variant_id, name: label })}
                          >
                            调整…
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <p className="tiny muted" style={{ marginBottom: 0 }}>
          套装没有自己的库存，它消耗成分库存。初始库存只初始化一次，之后补货、盘点、报损都通过流水记录。
        </p>
      </div>

      {showTx ? (
        <TransactionList eventId={eventId} />
      ) : (
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={() => setShowTx(true)}>查看库存流水</button>
          <span className="small muted">补货、预留、售出、返库等每一次变动都在这里留痕。</span>
        </div>
      )}

      {adjust ? (
        <AdjustModal
          eventId={eventId}
          variantId={adjust.variantId}
          name={adjust.name}
          preset={adjust.preset}
          onClose={() => setAdjust(null)}
          onDone={() => {
            setAdjust(null);
            inventory.reload();
            configs.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function TransactionList({ eventId }: { eventId: string }) {
  const txs = useAsync(() => listTransactions(eventId), [eventId]);
  const configs = useAsync(() => listEventConfigs(eventId), [eventId]);
  if (txs.loading) return <Spinner label="读取流水…" />;
  const nameOf = (id: string) => {
    const c = configs.data?.find((x) => x.variant_id === id);
    return c ? `${c.product_name}（${c.variant_name}）` : id;
  };
  return (
    <div className="card">
      <h2>库存流水</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>商品</th>
              <th>类型</th>
              <th className="num">实际增减</th>
              <th className="num">预留增减</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            {txs.data?.slice(0, 200).map((t) => (
              <tr key={t.id}>
                <td className="tiny">{new Date(t.created_at).toLocaleString('zh-CN')}</td>
                <td>{nameOf(t.variant_id)}</td>
                <td>
                  <span className="badge">{t.type}</span>
                </td>
                <td className="num">{t.delta_physical}</td>
                <td className="num">{t.delta_reserved}</td>
                <td className="small">{t.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AdjustModal({
  eventId,
  variantId,
  name,
  preset,
  onClose,
  onDone
}: {
  eventId: string;
  variantId: string;
  name: string;
  preset?: { type: AdjustKind; delta: number; reason: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const showToast = useApp((s) => s.showToast);
  const [type, setType] = useState<AdjustKind>(preset?.type ?? 'restock');
  const [delta, setDelta] = useState(preset ? String(preset.delta) : '');
  const [reason, setReason] = useState(preset?.reason ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inv = useAsync(() => getInventory(eventId, variantId), [eventId, variantId]);

  const before = inv.data?.physical_stock ?? 0;
  const d = Number(delta || 0);
  const after = before + d;
  const canSubmit = Number.isInteger(d) && d !== 0 && reason.trim().length > 0;

  return (
    <Modal
      title={`库存调整：${name}`}
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || !canSubmit}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await adjustStock({
                  eventId,
                  variantId,
                  deltaPhysical: d,
                  type,
                  reason: reason.trim(),
                  operationId: newId()
                });
                showToast(`库存 ${r.before} → ${r.after}`);
                onDone();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            确认调整
          </button>
        </>
      }
    >
      <div className="col">
        {/* 先看到结果，再决定要不要提交 */}
        <div className="notice info">
          <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
            <span className="small muted">实际库存</span>
            <strong style={{ fontSize: '1.3rem' }}>{before}</strong>
            <span className="muted">→</span>
            <strong style={{ fontSize: '1.3rem', color: d === 0 ? undefined : 'var(--accent)' }}>{after}</strong>
            <span className={`badge ${d > 0 ? 'ok' : d < 0 ? 'danger' : ''}`}>
              {d === 0 ? '未填写数量' : d > 0 ? `+${d}` : `${d}`}
            </span>
          </div>
          <div className="tiny muted" style={{ marginTop: 4 }}>
            预留 {inv.data?.reserved_stock ?? 0} 件，可用将变为{' '}
            <strong>{after - (inv.data?.reserved_stock ?? 0)}</strong>
          </div>
        </div>

        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            调整原因
          </div>
          <div className="row tight">
            {ADJUST_TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                className={type === t.value ? 'primary small' : 'small'}
                onClick={() => {
                  setType(t.value);
                  // 原因还是空的、或还是上一个类型的默认值，就跟着换
                  const defaults = ADJUST_TYPES.map((x) => x.label);
                  if (!reason.trim() || defaults.includes(reason.trim())) setReason(t.label);
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            数量（正数增加，负数减少）
          </div>
          <div className="row tight">
            <button type="button" className="small" onClick={() => setDelta(String((Number(delta) || 0) - 1))}>
              −
            </button>
            <input
              type="number"
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              placeholder="0"
              style={{ maxWidth: 110, textAlign: 'center' }}
            />
            <button type="button" className="small" onClick={() => setDelta(String((Number(delta) || 0) + 1))}>
              +
            </button>
            {[1, 5, 10].map((n) => (
              <button key={n} type="button" className="small ghost" onClick={() => setDelta(String(n))}>
                +{n}
              </button>
            ))}
            <button
              type="button"
              className="small ghost"
              onClick={() => setDelta(String(-(inv.data?.physical_stock ?? 0)))}
              title="把实际库存清零（盘点为 0）"
            >
              清零
            </button>
          </div>
        </div>

        <Field label="备注（会记入流水）">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="例如：补货 20 本 / 展会第一天卖出后点数"
          />
        </Field>

        <div className="tiny muted">
          调整后实际库存若低于已有预留会被拒绝，请先处理受影响的待付款订单。
        </div>
        <ErrorBox message={error} />
      </div>
    </Modal>
  );
}
