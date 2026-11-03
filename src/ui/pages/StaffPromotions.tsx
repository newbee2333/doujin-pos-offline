import { Link, useSearchParams } from 'react-router-dom';
import { getEvent } from '../../services/events';
import { useApp } from '../../store';
import { ErrorBox, Spinner, useAsync } from '../components';
import { PromotionWorkspace } from '../PromotionSettings';

export default function StaffPromotionsPage() {
  const [params] = useSearchParams();
  const currentEventId = useApp(s => s.currentEventId);
  const eventId = params.get('event') || currentEventId;
  const state = useAsync(() => eventId ? getEvent(eventId) : Promise.resolve(null), [eventId]);
  if (state.loading) return <Spinner label="读取展会…"/>;
  if (!state.data) return <div className="page"><h1>优惠活动</h1><ErrorBox message={state.error}/><p>请先选择或创建一场展会。</p><Link className="btn" to="/staff/events">前往展会配置</Link></div>;
  const event = state.data;
  return <div className="page promotion-page" key={event.id}>
    <div className="page-head"><div><h1>优惠活动</h1><p className="small muted">{event.name} · 点商品改价，勾选后批量设置</p></div><span className="spacer"/><Link className="btn small" to="/staff/events">返回展会配置</Link></div>
    {event.status === 'closed' && <p className="notice">本场已收摊，重新打开后可修改优惠。</p>}
    <PromotionWorkspace eventId={event.id} currency={event.currency} disabled={event.status === 'closed'}/>
  </div>;
}
