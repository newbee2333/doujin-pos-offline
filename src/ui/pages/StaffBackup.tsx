import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../../db/client';
import {
  createEmptyDatabase,
  getBackupState,
  getCurrentEventId,
  previewNewDatabase
} from '../../services/system';
import { getEvent } from '../../services/events';
import { errorMessage, openDatabase, resetDatabaseBinding, useApp } from '../../store';
import SaveDatabase from '../SaveDatabase';
import SetupPage from './Setup';
import { ErrorBox, Spinner, useAsync } from '../components';

export default function StaffBackupPage() {
  const navigate = useNavigate();
  const eventId = useApp((s) => s.currentEventId);
  const dbStatus = useApp((s) => s.dbStatus);
  const showToast = useApp((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [ackSaved, setAckSaved] = useState(false);
  const [ackLost, setAckLost] = useState(false);

  const event = useAsync(() => (eventId ? getEvent(eventId) : Promise.resolve(null)), [eventId]);
  const backup = useAsync(() => getBackupState(), [busy]);
  const status = useAsync(() => db.status(), [busy]);
  const nudge = useAsync(() => previewNewDatabase(), [busy]);

  if (showImport) return <SetupPage onDone={() => setShowImport(false)} />;

  const savedAt = backup.data?.lastConfirmedSavedAt ?? null;

  async function doNewDatabase() {
    setBusy(true);
    setError(null);
    try {
      const slot = await createEmptyDatabase();
      // 整库换掉之后，旧库的会话状态一律作废：购物车、当前订单、当前展会
      // 说的都是上一个库的东西，后台解锁状态更是与新库的 PIN 无关。
      resetDatabaseBinding();
      const opened = await openDatabase(slot);
      const st = useApp.getState();
      st.setDbStatus(opened);
      st.clearCart();
      st.setCurrentOrder(null);
      st.setCurrentEvent(await getCurrentEventId());
      st.lockStaff();
      showToast('已新建空数据库');
      setShowNew(false);
      navigate('/', { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page narrow">
      <h1>备份与恢复</h1>

      <div className="card">
        <h2>保存当前数据库</h2>
        <p className="small muted">
          导出为标准 SQLite 文件，包含商品、图片、收款码、展会配置、库存、订单、收款、退款、纠错与现金流水。
          导出时会暂停新的写入并等待当前事务完成，生成一致快照。
        </p>
        {/* 按钮文案是「导出 SQLite」而不是卡片标题：几个验收脚本和 CI 按这个取按钮。 */}
        <SaveDatabase
          eventName={event.data?.name}
          label="导出 SQLite"
          reloadKey={savedAt}
          onSaved={() => {
            backup.reload();
            // 下面两张卡的提醒强度取决于这个时间戳，一起刷新。
            nudge.reload();
          }}
        />
      </div>

      <div className="card">
        <h2>备份状态</h2>
        {backup.loading ? (
          <Spinner label="读取…" />
        ) : (
          <dl className="kv">
            <dt>最近生成导出</dt>
            <dd>{backup.data?.lastExportAt ? new Date(backup.data.lastExportAt).toLocaleString('zh-CN') : '从未'}</dd>
            <dt>用户确认保存</dt>
            <dd>
              {backup.data?.lastConfirmedSavedAt
                ? new Date(backup.data.lastConfirmedSavedAt).toLocaleString('zh-CN')
                : '从未确认'}
            </dd>
          </dl>
        )}
      </div>

      <div className="card">
        <h2>数据库状态</h2>
        <dl className="kv">
          <dt>数据集标识</dt>
          <dd className="tiny">{status.data?.datasetId ?? dbStatus?.datasetId ?? '—'}</dd>
          <dt>schema 版本</dt>
          <dd>{status.data?.schemaVersion ?? dbStatus?.schemaVersion ?? '—'}</dd>
          <dt>revision</dt>
          <dd>{status.data?.revision ?? dbStatus?.revision ?? '—'}</dd>
          <dt>槽位</dt>
          <dd>{status.data?.slot ?? dbStatus?.slot ?? '—'}</dd>
          <dt>应用版本</dt>
          <dd>{status.data?.appVersion ?? '—'}</dd>
        </dl>
      </div>

      <div className="card">
        <h2>从文件恢复</h2>
        <p className="small muted">
          恢复是整库替换，不合并本地修改。旧库文件会留在设备上，但界面上没有入口能打开它。
        </p>

        {savedAt ? null : (
          <div className="notice danger">
            <strong>恢复之后回不去。</strong>
            现在这个库在界面上就再也打不开了——先在上面保存一份，再往下走。
          </div>
        )}

        <SaveDatabase
          eventName={event.data?.name}
          reloadKey={savedAt}
          onSaved={() => {
            backup.reload();
            nudge.reload();
          }}
        />

        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={() => setShowImport(true)}>选择 SQLite 文件恢复</button>
        </div>
      </div>

      {/* 放在最后：它是这个页面上唯一会丢营业数据的动作，不该摆在「导出」旁边顺手就点到。 */}
      <div className="card">
        <h2>新建空数据库</h2>
        <p className="small muted">
          建一个全新的空库：菜单分类与支付方式回到默认，商品、展会、订单、收款、退款、纠错与现金流水都不带过去。
        </p>

        {savedAt ? (
          <div className="notice info">
            最近一次确认保存：{new Date(savedAt).toLocaleString('zh-CN')}。
            这个时间之后新产生的数据不在那份文件里，动之前先确认它还在这台设备之外。
          </div>
        ) : (
          <div className="notice danger">
            <strong>这台设备还没有确认保存过任何备份。</strong>
            新建之后，界面上不会再有打开现在这个库的入口——能把你带回来的只有你自己导出的那份文件。
            请先用上面的「导出 SQLite」导出一份，在平板的「文件」里确认后再回来。
          </div>
        )}

        <div className="row">
          <button
            className="danger"
            disabled={busy}
            onClick={() => {
              setShowNew(true);
              setAckSaved(false);
              setAckLost(false);
            }}
          >
            新建空数据库
          </button>
        </div>

        {showNew ? (
          <div className="card" style={{ background: 'var(--surface-2)' }}>
            <h3>确认新建</h3>

            {event.data?.status === 'active' ? (
              <div className="notice danger">
                当前展会「{event.data.name}」还在进行中。新建空库会把它连同未结算的订单一起丢下，
                建议先收摊并导出这一场的报表。
              </div>
            ) : null}

            <div className="small muted">即将丢下的数据</div>
            <dl className="kv">
              <dt>数据集</dt>
              <dd className="tiny">{nudge.data?.current.datasetId ?? '—'}</dd>
              <dt>revision</dt>
              <dd>{nudge.data?.current.revision ?? '—'}</dd>
              <dt>展会</dt>
              <dd>{nudge.data?.current.eventCount ?? '—'} 场</dd>
              <dt>订单</dt>
              <dd>
                {nudge.data?.current.orderCount ?? '—'} 笔（成交 {nudge.data?.current.completedOrderCount ?? '—'}）
              </dd>
              <dt>商品</dt>
              <dd>{nudge.data?.current.productCount ?? '—'} 件</dd>
            </dl>

            <p className="small muted">
              新库会带着默认的菜单分类与支付方式，从零开始。旧库不会立刻从设备上抹掉，
              但没有任何入口能打开它——所以别把它当备份。
            </p>

            {/* 现场就是这个顺序：先导出一份 → 在「文件」里确认 → 再勾下面那两句话。 */}
            <SaveDatabase
              eventName={event.data?.name}
              reloadKey={savedAt}
              onSaved={() => {
                backup.reload();
                nudge.reload();
              }}
            />

            <label className="check">
              <input type="checkbox" checked={ackSaved} onChange={(e) => setAckSaved(e.target.checked)} />
              <span>我已经把导出的文件保存到这台设备之外，并确认过它能打开</span>
            </label>
            {savedAt ? null : (
              <label className="check">
                <input type="checkbox" checked={ackLost} onChange={(e) => setAckLost(e.target.checked)} />
                <span>我知道现在这个库里的数据将无法找回</span>
              </label>
            )}

            <ErrorBox message={error} />

            <div className="row" style={{ marginTop: 12 }}>
              <button
                className="danger"
                onClick={doNewDatabase}
                disabled={busy || !ackSaved || (!savedAt && !ackLost)}
              >
                {busy ? <span className="spinner" /> : null}
                确认新建
              </button>
              <button onClick={() => setShowNew(false)} disabled={busy}>
                取消
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
