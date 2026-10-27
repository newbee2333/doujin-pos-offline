import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { checkEventReady, getActiveEvent, listEvents } from '../../services/events';
import { listOrderSummaries } from '../../services/orders';
import { getDashboard } from '../../services/reports';
import { setCurrentEventId } from '../../services/system';
import { useApp } from '../../store';
import { ErrorBox, Spinner, useAsync } from '../components';
import { confirmEnterKiosk } from '../kiosk-entry';
import { ORDER_STATUS_LABEL, orderStatusClass } from '../order-status';

export default function HomePage() {
  const navigate = useNavigate();
  const currentEventId = useApp(s => s.currentEventId);
  const setCurrentEvent = useApp(s => s.setCurrentEvent);
  const events = useAsync(() => listEvents(), []);
  const active = useAsync(() => getActiveEvent(), []);
  const current = events.data?.find(event => event.id === currentEventId) ?? active.data ?? events.data?.[0] ?? null;
  const dash = useAsync(() => current ? getDashboard(current.id) : Promise.resolve(null), [current?.id]);
  const recent = useAsync(() => current ? listOrderSummaries({ eventId: current.id, limit: 4 }) : Promise.resolve([]), [current?.id]);
  const ready = useAsync(() => current?.status === 'draft' ? checkEventReady(current.id) : Promise.resolve([]), [current?.id, current?.status]);
  useEffect(() => {
    if (current && currentEventId !== current.id) {
      setCurrentEvent(current.id);
      void setCurrentEventId(current.id);
    }
  }, [current?.id, currentEventId, setCurrentEvent]);
  if (events.loading) return <div className="center-page"><Spinner label="读取展会…" /></div>;
  if (events.error) return <ErrorBox message={events.error} />;
  if (!current) return <div className="page home-workspace"><h1>展会主页</h1><div className="empty-panel"><h2>从一场展会开始</h2><p className="muted">创建展会，配置商品、价格和库存后即可开场。</p><button className="primary" onClick={() => navigate('/staff/events')}>去创建展会</button></div></div>;
  const phase = current.status === 'active' ? '营业中' : current.status === 'closed' ? '已收摊' : '准备中';
  return (
    <div className="page home-workspace">
      <div className="page-head"><h1>展会主页</h1><span className={`badge ${current.status === 'active' ? 'ok' : ''}`}>{phase}</span></div>
      <section className="workspace-hero" aria-label="当前展会">
        <div>
          <span className="eyebrow">当前展会</span><h2>{current.name}</h2>
          <p className="muted">{current.booth_number ? `摊位 ${current.booth_number}` : '摊位号未设置'} · {current.currency === 'CNY' ? '人民币 / CNY' : '日元 / JPY'}</p>
          <p className="small muted">日期：{current.start_date || current.end_date ? `${current.start_date || '未设置'} 至 ${current.end_date || '未设置'}` : '未设置'} · {current.timezone}</p>
        </div>
        <div className="workspace-actions">
          {current.status === 'active' ? <>
            <button className="primary" onClick={() => navigate('/staff/checkout')}>摊主收银</button>
            <button onClick={() => confirmEnterKiosk(navigate)}>进入游客菜单</button>
          </> : current.status === 'draft' ? <>
            <button className="primary" onClick={() => navigate('/staff/events')}>配置展会</button>
            <button onClick={() => navigate('/preview')}>预览菜单效果</button>
          </> : <>
            <button className="primary" onClick={() => navigate('/staff/reports')}>查看本场报表</button>
            <button onClick={() => navigate('/staff/events')}>管理展会</button>
          </>}
        </div>
      </section>
      {current.status === 'draft' ? <section className="workspace-section preparation-checklist" aria-label="开场准备">
        <div className="section-heading"><h2>开场准备</h2><button className="small ghost" onClick={ready.reload}>重新检查</button></div>
        {ready.loading ? <Spinner label="检查配置…" /> : ready.error ? <ErrorBox message={ready.error} /> : ready.data?.length ? <ul className="readiness-list">{ready.data.map(issue => <li key={issue}><span className="badge warn">待完善</span>{issue}</li>)}</ul> : <p className="status-line"><span className="badge ok">配置齐全</span>可前往展会配置检查并开场。</p>}
      </section> : null}
      <div className="workspace-metrics">
        <button onClick={() => navigate('/staff/pending')}><span className="muted">待付款</span><strong>{dash.loading ? '…' : dash.data?.counts.pending_payment ?? '—'}<small> 笔</small></strong><span className="tiny muted">核对收款与预留库存</span></button>
        <button onClick={() => navigate('/staff/orders')}><span className="muted">已完成</span><strong>{dash.loading ? '…' : dash.data?.counts.completed ?? '—'}<small> 笔</small></strong><span className="tiny muted">查看本场订单记录</span></button>
        <button onClick={() => navigate('/staff/inventory')}><span className="muted">库存</span><strong className="metric-link">查看库存</strong><span className="tiny muted">盘点、补货与调整</span></button>
      </div>
      <ErrorBox message={dash.error} />
      <section className="workspace-section" aria-label="最近订单">
        <div className="section-heading"><h2>最近订单</h2><button className="small ghost" onClick={() => navigate('/staff/orders')}>全部订单</button></div>
        {recent.loading ? <Spinner label="读取订单…" /> : recent.error ? <ErrorBox message={recent.error} /> : recent.data?.length ? <div className="recent-orders">{recent.data.map(order => <button key={order.id} onClick={() => navigate(`/staff/orders?order=${order.id}`)}>
          <strong>#{order.human_readable_number}</strong><span>{order.item_summary || '查看商品明细'}</span><span className={`badge ${orderStatusClass(order.status)}`}>{ORDER_STATUS_LABEL[order.status]}</span>
        </button>)}</div> : <p className="muted">本场还没有订单。{current.status === 'active' ? '从摊主收银或游客菜单开始接待。' : '开场后可在这里查看最近订单。'}</p>}
      </section>
      <div className="workspace-switch"><label className="field"><span>切换展会</span><select aria-label="切换展会" value={current.id} onChange={async e => { setCurrentEvent(e.target.value); await setCurrentEventId(e.target.value); }}>{events.data?.map(event => <option key={event.id} value={event.id}>{event.name}（{event.status === 'active' ? '进行中' : event.status === 'closed' ? '已收摊' : '草稿'}）</option>)}</select></label><button onClick={() => navigate('/staff/events')}>管理展会</button></div>
    </div>
  );
}
