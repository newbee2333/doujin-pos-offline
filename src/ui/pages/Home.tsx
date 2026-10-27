import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { checkEventReady, getActiveEvent, listEvents } from '../../services/events';
import { getKioskMenu, listOrderSummaries } from '../../services/orders';
import { getDashboard } from '../../services/reports';
import { setCurrentEventId } from '../../services/system';
import { stockLabel } from '../../domain/types';
import { errorMessage, useApp } from '../../store';
import { ErrorBox, Spinner, useAsync } from '../components';
import { confirmEnterKiosk } from '../kiosk-entry';
import { ORDER_STATUS_LABEL, orderStatusClass } from '../order-status';

export default function HomePage() {
  const navigate = useNavigate();
  const currentEventId = useApp(s => s.currentEventId);
  const setCurrentEvent = useApp(s => s.setCurrentEvent);
  const showToast = useApp(s => s.showToast);
  const [switching, setSwitching] = useState(false);
  const events = useAsync(() => listEvents(), []);
  const active = useAsync(() => getActiveEvent(), []);
  const current = events.data?.find(event => event.id === currentEventId) ?? active.data ?? events.data?.[0] ?? null;
  const dash = useAsync(() => current ? getDashboard(current.id) : Promise.resolve(null), [current?.id]);
  const menu = useAsync(() => current ? getKioskMenu(current.id) : Promise.resolve([]), [current?.id]);
  const recent = useAsync(() => current ? listOrderSummaries({ eventId: current.id, limit: 4 }) : Promise.resolve([]), [current?.id]);
  const ready = useAsync(() => current?.status === 'draft' ? checkEventReady(current.id) : Promise.resolve([]), [current?.id, current?.status]);
  useEffect(() => {
    if (current && currentEventId !== current.id) {
      setCurrentEvent(current.id);
      void setCurrentEventId(current.id).catch(e => showToast(errorMessage(e)));
    }
  }, [current?.id, currentEventId, setCurrentEvent, showToast]);
  function refresh() {
    events.reload(); active.reload(); dash.reload(); menu.reload(); recent.reload(); ready.reload();
  }
  async function switchEvent(id: string) {
    setSwitching(true);
    try {
      await setCurrentEventId(id);
      setCurrentEvent(id);
    } catch (e) {
      showToast(errorMessage(e));
    } finally {
      setSwitching(false);
    }
  }
  if (events.loading && !events.data) return <div className="center-page"><Spinner label="读取展会…" /></div>;
  if (events.error) return <ErrorBox message={events.error} />;
  if (!current) return <div className="page home-workspace"><h1>展会主页</h1><div className="empty-panel"><h2>从一场展会开始</h2><p className="muted">创建展会，配置商品、价格和库存后即可开场。</p><button className="primary" onClick={() => navigate('/staff/events')}>去创建展会</button></div></div>;
  const phase = current.status === 'active' ? '营业中' : current.status === 'closed' ? '已收摊' : '准备中';
  const stockIssues = menu.data?.filter(item => ['少量', '售罄'].includes(stockLabel(item))).length ?? 0;
  const overviewLoading = dash.loading || menu.loading;
  return (
    <div className="page home-workspace">
      <div className="page-head"><h1>展会主页</h1><span className="small muted">首页 / 本场经营</span></div>
      <section className="workspace-hero" aria-label="当前展会">
        <div className="workspace-event-info">
          <div className="row tight"><span className="eyebrow">当前展会</span><span className={`badge ${current.status === 'active' ? 'ok' : ''}`}>{phase}</span></div>
          <h2>{current.name}</h2>
          <dl className="workspace-event-meta">
            <div><dt>日期</dt><dd>{current.start_date || current.end_date ? `${current.start_date || '未设置'} 至 ${current.end_date || '未设置'}` : '未设置'}</dd></div>
            <div><dt>摊位</dt><dd>{current.booth_number || '未设置'}</dd></div>
            <div><dt>币种</dt><dd>{current.currency === 'CNY' ? '人民币 / CNY' : '日元 / JPY'}</dd></div>
          </dl>
          <p className="tiny muted">展会时区：{current.timezone}</p>
        </div>
        <div className="workspace-info-actions">
          <button onClick={() => navigate('/staff/events')}>修改展会信息</button>
          <button onClick={() => navigate('/preview')}>菜单预览与排序</button>
        </div>
        <div className="workspace-operation-bar">
          <div><strong>{current.status === 'active' ? '营业操作' : current.status === 'closed' ? '收摊后操作' : '开场前准备'}</strong><span className="small muted">{current.status === 'active' ? '摊主收银，或将设备交给游客选购' : current.status === 'closed' ? '查看本场记录，或到展会配置重新打开' : '完善配置后，再到展会配置检查并开场'}</span></div>
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
        </div>
      </section>
      {current.status === 'draft' ? <section className="workspace-section preparation-checklist" aria-label="开场准备">
        <div className="section-heading"><h2>开场准备</h2><button className="small ghost" onClick={ready.reload}>重新检查</button></div>
        {ready.loading ? <Spinner label="检查配置…" /> : ready.error ? <ErrorBox message={ready.error} /> : ready.data?.length ? <ul className="readiness-list">{ready.data.map(issue => <li key={issue}><span className="badge warn">待完善</span>{issue}</li>)}</ul> : <p className="status-line"><span className="badge ok">配置齐全</span>可前往展会配置检查并开场。</p>}
      </section> : null}
      <section className="workspace-overview" aria-label="本场经营概览">
        <div className="section-heading"><h2>本场经营概览</h2><button className="small ghost" disabled={overviewLoading || events.loading} onClick={refresh}>{overviewLoading ? '读取中…' : '刷新数据'}</button></div>
        <div className="workspace-metrics">
          <button className={dash.data?.counts.pending_payment ? 'needs-attention' : ''} onClick={() => navigate('/staff/pending')}>
            <span className="metric-title">待付款订单</span><strong>{dash.loading ? '…' : dash.data?.counts.pending_payment ?? '—'}<small> 笔</small></strong>
            <span className="small muted">核对收款与预留库存</span><span className="metric-action">查看待付款 <span aria-hidden="true">→</span></span>
          </button>
          <button onClick={() => navigate('/staff/orders')}>
            <span className="metric-title">已完成订单</span><strong>{dash.loading ? '…' : dash.data?.counts.completed ?? '—'}<small> 笔</small></strong>
            <span className="small muted">本场已完成的订单记录</span><span className="metric-action">查看订单记录 <span aria-hidden="true">→</span></span>
          </button>
          <button onClick={() => navigate('/preview')}>
            <span className="metric-title">菜单商品</span><strong>{menu.loading ? '…' : menu.error ? '—' : menu.data?.length ?? 0}<small> 项规格</small></strong>
            <span className="small muted">当前游客菜单可见的规格</span><span className="metric-action">预览与调整顺序 <span aria-hidden="true">→</span></span>
          </button>
          <button className={!menu.error && stockIssues ? 'stock-attention' : ''} onClick={() => navigate('/staff/inventory')}>
            <span className="metric-title">库存关注</span><strong>{menu.loading ? '…' : menu.error ? '—' : stockIssues}<small> 项规格</small></strong>
            <span className="small muted">菜单中少量或售罄的规格</span><span className="metric-action">检查库存 <span aria-hidden="true">→</span></span>
          </button>
        </div>
        <ErrorBox message={dash.error ?? menu.error} />
      </section>
      <section className="workspace-section workspace-recent" aria-label="最近订单">
        <div className="section-heading"><h2>最近订单</h2><button className="small" onClick={() => navigate('/staff/orders')}>查看全部订单</button></div>
        {recent.loading ? <Spinner label="读取订单…" /> : recent.error ? <ErrorBox message={recent.error} /> : recent.data?.length ? <div className="table-wrap recent-orders">
          <table>
            <thead><tr><th scope="col">取货号</th><th scope="col">商品明细</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
            <tbody>{recent.data.map(order => <tr key={order.id}>
              <th scope="row">#{order.human_readable_number}</th>
              <td><div className="recent-order-summary">{order.item_summary || '查看商品明细'}</div><div className="tiny muted">{new Date(order.created_at).toLocaleString('zh-CN')} · {order.source === 'kiosk' ? '游客自助' : '摊主开单'}</div></td>
              <td><span className={`badge ${orderStatusClass(order.status)}`}>{ORDER_STATUS_LABEL[order.status]}</span></td>
              <td>{order.status === 'pending_payment' ? <button className="small recent-order-action" onClick={() => navigate(`/staff/pending?order=${order.id}`)}>去收款</button> : <button className="small recent-order-action" onClick={() => navigate(`/staff/orders?order=${order.id}`)}>查看详情</button>}</td>
            </tr>)}</tbody>
          </table>
        </div> : <div className="empty-panel"><p className="muted">本场还没有订单。{current.status === 'active' ? '从摊主收银或游客菜单开始接待。' : '开场后可在这里查看最近订单。'}</p></div>}
      </section>
      <section className="workspace-switch" aria-label="切换展会">
        <div><h2>切换展会</h2><p className="tiny muted">选择当前查看与操作的展会</p></div>
        <label className="field"><span className="sr-only">切换展会</span><select aria-label="切换展会" value={current.id} disabled={switching} onChange={e => void switchEvent(e.target.value)}>{events.data?.map(event => <option key={event.id} value={event.id}>{event.name}（{event.status === 'active' ? '进行中' : event.status === 'closed' ? '已收摊' : '草稿'}）</option>)}</select></label>
        <button onClick={() => navigate('/staff/events')}>管理展会</button>
      </section>
    </div>
  );
}
