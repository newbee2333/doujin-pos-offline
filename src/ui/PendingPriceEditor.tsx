import { useState } from 'react';
import type { Order } from '../domain/types';
import { newId } from '../domain/ids';
import { adjustPendingPrice, beginOrderAdjustment, cancelOrderAdjustment, pendingManual, pendingPriceLines, pendingRules, type AdjustmentLine } from '../services/order-pricing';
import { getOrderDetail, type OrderDetail } from '../services/orders';
import { errorMessage } from '../store';
import { ErrorBox, Modal } from './components';
import { AdjustmentEditor } from './Pricing';

export default function PendingPriceEditor({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: () => void }) {
  const [checked, setChecked] = useState(false);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const version = order.pricing_version ?? 0;

  async function releaseAndClose() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await cancelOrderAdjustment(order.id, version);
      onClose();
    } catch (e) {
      // 若期间订单状态或定价版本已变，不再困在弹窗内，关闭并交由父级刷新
      setError(errorMessage(e));
      onClose();
    } finally {
      setBusy(false);
    }
  }

  if (detail) return <>
    <AdjustmentEditor
      initialLines={pendingPriceLines(detail)}
      initialManual={pendingManual(detail)}
      rules={pendingRules(detail)}
      currency={order.currency}
      closing={busy}
      onClose={() => void releaseAndClose()}
      onSave={async (lines, manual, reason, pin) => {
        await adjustPendingPrice({ orderId: order.id, version, lines: lines as AdjustmentLine[], manual, reason, pin, operationId: newId() });
        onDone();
      }}
    />
    {error && <div className="toast" role="alert">{error}</div>}
  </>;

  return <Modal
    title={order.pricing_editing ? '继续或取消调价' : '调整待付款金额'}
    onClose={busy ? undefined : onClose}
    actions={
      <>
        <button disabled={busy} onClick={onClose}>关闭</button>
        {order.pricing_editing ? (
          <button className="danger" disabled={busy} onClick={() => void releaseAndClose()}>取消本次调价</button>
        ) : null}
        <button className="primary" disabled={!checked || busy} onClick={async () => {
          setBusy(true); setError(null);
          try {
            await beginOrderAdjustment(order.id, version);
            const current = await getOrderDetail(order.id);
            if (!current) throw new Error('订单不存在');
            setDetail(current);
          } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
        }}>{order.pricing_editing ? '继续调价' : '开始调价'}</button>
      </>
    }
  >
    <p>请先让顾客停止付款。调价期间收款确认和收款码会暂停显示，保存后必须重新核对新金额。</p>
    <p className="small muted">已经在微信、支付宝等完成的付款不会随调价撤回；如已付款，请按实际到账金额核对并处理退款。</p>
    <label className="check"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)}/>已核实顾客尚未付款，并告知暂时不要扫码</label>
    <ErrorBox message={error}/>
  </Modal>;
}
