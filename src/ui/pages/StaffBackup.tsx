import { useState } from 'react';
import { db } from '../../db/client';
import { getBackupState, exportDatabase, markConfirmedSaved, shareBytes, suggestFileName } from '../../services/system';
import { getEvent } from '../../services/events';
import { formatBytes } from '../../domain/image';
import { errorMessage, useApp } from '../../store';
import SetupPage from './Setup';
import { ErrorBox, Spinner, useAsync } from '../components';

export default function StaffBackupPage() {
  const eventId = useApp((s) => s.currentEventId);
  const dbStatus = useApp((s) => s.dbStatus);
  const showToast = useApp((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastBytes, setLastBytes] = useState<Uint8Array | null>(null);
  const [lastFile, setLastFile] = useState('');
  const [showImport, setShowImport] = useState(false);

  const event = useAsync(() => (eventId ? getEvent(eventId) : Promise.resolve(null)), [eventId]);
  const backup = useAsync(() => getBackupState(), [busy]);
  const status = useAsync(() => db.status(), [busy]);

  if (showImport) return <SetupPage onDone={() => setShowImport(false)} />;

  async function doExport() {
    setBusy(true);
    setError(null);
    try {
      const name = suggestFileName(event.data?.name);
      const { bytes, mode } = await exportDatabase(name);
      setLastBytes(bytes);
      setLastFile(name);
      showToast(mode === 'picker' ? '已保存到你选择的位置' : '已发起下载');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="content narrow">
      <h1>备份与恢复</h1>

      <div className="card">
        <h2>导出完整数据库</h2>
        <p className="small muted">
          导出为标准 SQLite 文件，包含商品、图片、收款码、展会配置、库存、订单、收款、退款、纠错与现金流水。
          导出时会暂停新的写入并等待当前事务完成，生成一致快照。
        </p>
        <div className="row">
          <button className="primary" onClick={doExport} disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            导出 SQLite
          </button>
          {lastBytes ? (
            <>
              <button
                onClick={async () => {
                  if (await shareBytes(lastBytes, lastFile)) showToast('已调用系统分享');
                  else showToast('当前浏览器不支持文件分享，请用导出保存到「文件」');
                }}
              >
                分享 / 保存到文件
              </button>
              <button
                onClick={async () => {
                  await markConfirmedSaved();
                  showToast('已确认保存');
                  backup.reload();
                }}
              >
                我确认已保存
              </button>
            </>
          ) : null}
        </div>
        {lastBytes ? (
          <p className="tiny muted" style={{ marginBottom: 0 }}>
            已生成 {lastFile}（{formatBytes(lastBytes.length)}）。浏览器发起下载不等于文件一定落盘成功，
            请在平板的「文件」里确认后再点「我确认已保存」。
          </p>
        ) : null}
        <ErrorBox message={error} />
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
          恢复是整库替换，不合并本地修改。覆盖前会保留可恢复的旧副本，但仍建议先导出当前数据。
        </p>
        <button onClick={() => setShowImport(true)}>选择 SQLite 文件恢复</button>
      </div>
    </div>
  );
}
