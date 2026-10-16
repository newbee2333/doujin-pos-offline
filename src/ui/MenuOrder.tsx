import { useEffect, useRef, useState } from 'react';
import type { MenuItem } from '../domain/types';
import { saveMenuOrder } from '../services/events';
import { errorMessage } from '../store';
import MenuCard from './MenuCard';
import { ErrorBox } from './components';

export default function MenuOrder({ eventId, items, onClose, onSaved }: {
  eventId: string; items: MenuItem[]; onClose: () => void; onSaved: () => void;
}) {
  const [draft, setDraft] = useState(items);
  const [drag, setDrag] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ id: string; x: number; y: number; startX: number; startY: number; active: boolean; scrolling: boolean; timer: ReturnType<typeof setTimeout> } | null>(null);
  const stop = () => {
    if (gesture.current) clearTimeout(gesture.current.timer);
    gesture.current = null;
    setDrag(null);
  };
  const move = (from: string, to: string) => setDraft(rows => {
    const result = [...rows];
    const a = result.findIndex(item => item.variant_id === from);
    const b = result.findIndex(item => item.variant_id === to);
    if (a < 0 || b < 0 || a === b) return rows;
    result.splice(b, 0, result.splice(a, 1)[0]);
    return result;
  });
  useEffect(() => {
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
    let frame: number;
    const tick = () => {
      const g = gesture.current;
      const el = area.current;
      if (g?.active && el) {
        if (ghost.current) ghost.current.style.transform = `translate(${g.x - 70}px, ${g.y - 60}px)`;
        const rect = el.getBoundingClientRect();
        const speed = g.y < rect.top + 65 ? -12 : g.y > rect.bottom - 65 ? 12 : 0;
        el.scrollTop += speed;
        const target = document.elementFromPoint(g.x, g.y)?.closest<HTMLElement>('[data-order-id]');
        if (target?.dataset.orderId) move(g.id, target.dataset.orderId);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); window.removeEventListener('blur', stop); cancelAnimationFrame(frame); if (gesture.current) clearTimeout(gesture.current.timer); };
  }, []);
  return <div className="menu-order" role="dialog" aria-modal="true" aria-label="调整菜单顺序">
    <div className="row"><h2>调整菜单顺序</h2><span className="spacer" />
      <button disabled={busy || !!drag} onClick={onClose}>取消</button>
      <button className="primary" disabled={busy || !!drag} onClick={async () => {
        setBusy(true); setError(null);
        try { await saveMenuOrder(eventId, draft.map(item => item.variant_id)); onSaved(); }
        catch (e) { setError(errorMessage(e)); setBusy(false); }
      }}>{busy ? '保存中…' : '保存顺序'}</button>
    </div>
    <p className="muted">长按商品后拖动；靠近上下边缘可滚动。也可用前移、后移按钮。顺序仅应用于本场展会。</p>
    <ErrorBox message={error} />
    <div className="menu-order-scroll" ref={area}>
      <div className="menu-grid">{draft.map((item, index) => <div key={item.variant_id} data-order-id={item.variant_id}
        className={`menu-order-item${drag === item.variant_id ? ' dragging' : ''}`}
        onContextMenu={e => e.preventDefault()}
        onPointerDown={e => {
          if (busy || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
          stop();
          const node = e.currentTarget;
          const pointerId = e.pointerId;
          node.setPointerCapture(pointerId);
          const g = { id: item.variant_id, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, active: false, scrolling: false,
            timer: setTimeout(() => { g.active = true; setDrag(g.id); }, 420) };
          gesture.current = g;
        }}
        onPointerMove={e => {
          const g = gesture.current;
          if (!g) return;
          const dy = g.y - e.clientY;
          g.x = e.clientX; g.y = e.clientY;
          if (!g.active && (g.scrolling || Math.hypot(g.x - g.startX, g.y - g.startY) > 10)) {
            clearTimeout(g.timer); g.scrolling = true;
            if (area.current) area.current.scrollTop += dy;
          }
        }}
        onPointerUp={stop} onPointerCancel={stop}>
        <div className="menu-order-cover" aria-hidden="true" ref={node => { node?.setAttribute('inert', ''); }}><MenuCard item={item} onOpenDetail={() => {}} /></div>
        <div className="row"><span className="muted">{index + 1}</span><span className="spacer" />
          <button disabled={busy || index === 0} aria-label={`前移 ${item.product_name}`} onClick={() => move(item.variant_id, draft[index - 1].variant_id)}>前移</button>
          <button disabled={busy || index === draft.length - 1} aria-label={`后移 ${item.product_name}`} onClick={() => move(item.variant_id, draft[index + 1].variant_id)}>后移</button>
        </div>
      </div>)}</div>
    </div>
    {drag ? <div className="menu-order-ghost" ref={ghost} aria-hidden="true"><MenuCard item={draft.find(item => item.variant_id === drag)!} /></div> : null}
  </div>;
}
