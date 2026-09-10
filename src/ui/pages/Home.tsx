import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { getActiveEvent, listEvents } from '../../services/events';
import { getDashboard } from '../../services/reports';
import { getCurrentEventId, setCurrentEventId, shouldRemindBackup } from '../../services/system';
import { formatMoney } from '../../domain/money';
import type { Event } from '../../domain/types';
import { useApp } from '../../store';
import { ErrorBox, Spinner, useAsync } from '../components';
import { confirmEnterKiosk } from '../kiosk-entry';

export default function HomePage() {
  const navigate = useNavigate();
  const currentEventId = useApp((s) => s.currentEventId);
  const setCurrentEvent = useApp((s) => s.setCurrentEvent);
  const [remind, setRemind] = useState(false);

  const events = useAsync(() => listEvents(), []);
  const active = useAsync(() => getActiveEvent(), []);
  const dash = useAsync(
    () => (currentEventId ? getDashboard(currentEventId) : Promise.resolve(null)),
    [currentEventId]
  );

  useEffect(() => {
    void shouldRemindBackup().then(setRemind);
  }, []);

  const current: Event | null =
    events.data?.find((e) => e.id === currentEventId) ?? active.data ?? events.data?.[0] ?? null;

  useEffect(() => {
    if (!currentEventId && current) {
      setCurrentEvent(current.id);
      void setCurrentEventId(current.id);
    }
  }, [current, currentEventId, setCurrentEvent]);

  if (events.loading) {
    return (
      <div className="center-page">
        <Spinner label="读取展会…" />
      </div>
    );
  }
  const error = events.error;
  if (error) return <ErrorBox message={error} />;

  return (
    <div className="content narrow">
      {remind ? (
        <div className="notice">
          距上次确认保存已超过 24 小时，或还没有备份。请在营业前后到「备份恢复」导出完整数据库。
        </div>
      ) : null}

      {/* 收摊后必须明显提示导出：此时数据只在这台设备上，丢了就没有第二份 */}
      {current?.status === 'closed' ? (
        <div
          className="notice danger"
          style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: remind ? 10 : 0 }}
        >
          <span style={{ flex: 1 }}>
            本场已收摊，数据目前只存在这台设备上。请<strong>立即导出</strong>完整数据库并保存到别处。
          </span>
          <button className="small primary" onClick={() => navigate('/staff/backup')}>
            立即导出
          </button>
        </div>
      ) : null}

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>当前展会</h2>
          <span className="spacer" />
          {current ? (
            <span
              className={`badge ${
                current.status === 'active' ? 'ok' : current.status === 'closed' ? 'danger' : ''
              }`}
            >
              {current.status === 'active' ? '进行中' : current.status === 'closed' ? '已收摊' : '草稿'}
            </span>
          ) : null}
        </div>

        {current ? (
          <>
            <div style={{ fontSize: '1.15rem', fontWeight: 600, marginTop: 8 }}>{current.name}</div>
            <dl className="kv" style={{ marginTop: 10 }}>
              <dt>摊位号</dt>
              <dd>{current.booth_number || '—'}</dd>
              <dt>日期</dt>
              <dd>
                {current.start_date ?? '—'} ~ {current.end_date ?? '—'}（{current.timezone}）
              </dd>
              <dt>币种</dt>
              <dd>{current.currency === 'CNY' ? '人民币 / CNY' : '日元 / JPY'}</dd>
            </dl>

            {dash.data ? (
              <div className="stat-grid" style={{ marginTop: 14 }}>
                <div className="stat">
                  <div className="label">销售额</div>
                  <div className="value">{formatMoney(dash.data.salesMinor, current.currency)}</div>
                </div>
                <div className="stat">
                  <div className="label">退款额</div>
                  <div className="value">{formatMoney(dash.data.refundMinor, current.currency)}</div>
                </div>
                <div className="stat">
                  <div className="label">净销售额</div>
                  <div className="value">{formatMoney(dash.data.netSalesMinor, current.currency)}</div>
                </div>
                <div className="stat">
                  <div className="label">待付款</div>
                  <div className="value">{dash.data.counts.pending_payment}</div>
                </div>
              </div>
            ) : null}

            <div className="row" style={{ marginTop: 14 }}>
              <button className="primary" onClick={() => navigate('/staff/checkout')}>
                摊主收银
              </button>
              <button onClick={() => navigate('/staff/pending')}>待付款</button>
              <button onClick={() => navigate('/preview')}>预览菜单效果</button>
              <button onClick={() => confirmEnterKiosk(navigate)}>游客菜单</button>
              <button onClick={() => navigate('/staff/reports')}>报表</button>
            </div>
          </>
        ) : (
          <>
            <p className="muted small">还没有展会。请先到「展会配置」创建展会并启用商品。</p>
            <button className="primary" onClick={() => navigate('/staff/events')}>
              去创建展会
            </button>
          </>
        )}
      </div>

      <div className="card">
        <h3>切换展会</h3>
        <div className="row">
          <select
            value={currentEventId ?? ''}
            onChange={async (e) => {
              const id = e.target.value || null;
              setCurrentEvent(id);
              await setCurrentEventId(id);
            }}
            style={{ maxWidth: 420 }}
          >
            <option value="">未选择</option>
            {events.data?.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.name}（{ev.status === 'active' ? '进行中' : ev.status === 'closed' ? '已收摊' : '草稿'}）
              </option>
            ))}
          </select>
          <button onClick={() => navigate('/staff/events')}>管理展会</button>
        </div>
      </div>
    </div>
  );
}
