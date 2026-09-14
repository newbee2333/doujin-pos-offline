import { useState } from 'react';
import { adjustStock, getInventory } from '../services/inventory';
import { newId } from '../domain/ids';
import { errorMessage, useApp } from '../store';
import { ErrorBox, Field, Modal, useAsync } from './components';

/**
 * 手工调整可选的类型（售出/预留等由交易流程产生，不在这里选）。
 * 库存改动必须走「类型 + 备注」并记入流水，所以不能直接改数字。
 */
export type AdjustKind = 'restock' | 'correction' | 'damaged' | 'personal' | 'lost' | 'other';

export const ADJUST_TYPES: { value: AdjustKind; label: string }[] = [
  { value: 'restock', label: '补货' },
  { value: 'correction', label: '盘点调整' },
  { value: 'damaged', label: '报损' },
  { value: 'personal', label: '自用' },
  { value: 'lost', label: '丢失' },
  { value: 'other', label: '其他' }
];

/**
 * 库存调整弹窗。库存页与展会配置页共用，保证两条入口的
 * 调整语义、流水记录、校验完全一致。
 */
export function AdjustStockModal({
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
