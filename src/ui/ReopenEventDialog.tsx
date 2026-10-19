import { useState } from 'react';
import { reopenEvent } from '../services/events';
import { errorMessage } from '../store';
import { ErrorBox, Field, Modal } from './components';

/** Avoid native prompt: it can be suppressed without any visible feedback. */
export default function ReopenEventDialog({ eventId, name, onClose, onDone }: {
  eventId: string; name: string; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <Modal title="重新打开已收摊展会" onClose={() => { if (!busy) onClose(); }} actions={<>
    <button disabled={busy} onClick={onClose}>取消</button>
    <button className="primary" disabled={busy || !reason.trim()} onClick={async () => {
      if (busy || !reason.trim()) return;
      setBusy(true); setError(null);
      try { await reopenEvent(eventId, reason.trim()); onDone(); }
      catch (e) { setError(errorMessage(e)); setBusy(false); }
    }}>{busy ? '正在重新打开…' : '确认重新打开'}</button>
  </>}>
    <p>即将重新打开「{name}」。请填写原因，会记入审计。</p>
    <Field label="重新打开原因">
      <input aria-label="重新打开原因" value={reason} onChange={e => setReason(e.target.value)} disabled={busy}
        placeholder="必填，例如：补录订单、继续营业" />
    </Field>
    <ErrorBox message={error} />
  </Modal>;
}
