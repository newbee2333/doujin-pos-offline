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
 * 快捷加减的量。
 * 左边减少、右边增加（和上面「− [输入框] +」同一个方向），
 * 两组里靠近中间的都是小步长（−1 / +1），越靠外越大。
 */
const QUICK_DOWN = [-10, -5, -1];
const QUICK_UP = [1, 5, 10];

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

  /** 在当前数量上累加。空值当 0，所以第一次点 +5 就是 5。 */
  const bump = (n: number) => setDelta(String((Number(delta) || 0) + n));

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
            <button type="button" className="small" aria-label="减少 1" onClick={() => bump(-1)}>
              −
            </button>
            <input
              type="number"
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              placeholder="0"
              aria-label="调整数量"
              style={{ maxWidth: 110, textAlign: 'center' }}
            />
            <button type="button" className="small" aria-label="增加 1" onClick={() => bump(1)}>
              +
            </button>
          </div>
          {/* 快捷加减：**每点一次在现有数量上累加**，左边减少右边增加。
              原来是「设为」——点了 +10 之后再点 +5 会变成 +5，
              而现场补货经常是「三摞各十本」「先抱二十本过来」，要的是能叠。
              末尾的「清空数量」只清这个输入框，不动实际库存 ——
              原来那个「清零」是「把实际库存盘点成 0」，和「清空我输入的数字」是两件事，
              现场按起来很容易误伤（2026-09-17 用户反馈）。 */}
          <div className="row tight" style={{ marginTop: 6 }}>
            {QUICK_DOWN.map((n) => (
              <button
                key={n}
                type="button"
                className="small ghost"
                title={`在当前数量上减少 ${Math.abs(n)}`}
                onClick={() => bump(n)}
              >
                {n}
              </button>
            ))}
            {QUICK_UP.map((n) => (
              <button
                key={n}
                type="button"
                className="small ghost"
                title={`在当前数量上增加 ${n}`}
                onClick={() => bump(n)}
              >
                +{n}
              </button>
            ))}
            <button
              type="button"
              className="small ghost"
              onClick={() => setDelta('')}
              title="把上面输入的数量清空（不改实际库存）"
            >
              清空数量
            </button>
          </div>
          <div className="tiny muted" style={{ marginTop: 6 }}>
            快捷按钮按累计叠加：连点三次「+5」就是 +15。也可以直接在中间输入框里改。
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
