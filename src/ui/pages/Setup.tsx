import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  commitImport,
  getBackupState,
  getCurrentEventId,
  stageImport,
  type ReplacePreview
} from '../../services/system';
import { errorMessage, openDatabase, resetDatabaseBinding, useApp } from '../../store';
import SaveDatabase from '../SaveDatabase';
import { ErrorBox, Spinner, useAsync } from '../components';
import { formatBytes } from '../../domain/image';
import { importFileAccept, importFileHint } from '../file-accept';

export default function SetupPage({
  firstLaunch,
  onDone
}: {
  firstLaunch?: boolean;
  onDone?: () => void;
}) {
  const navigate = useNavigate();
  const showToast = useApp((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReplacePreview | null>(null);
  const [fileName, setFileName] = useState('');
  /** 只有「从文件恢复」这条路径上有值得保存的库；首次启动是空的，不问。 */
  const backup = useAsync(() => (firstLaunch ? Promise.resolve(null) : getBackupState()), []);
  const savedAt = backup.data?.lastConfirmedSavedAt ?? null;

  async function onFile(file: File) {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setFileName(file.name);
      setPreview(await stageImport(bytes));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function doCommit() {
    setBusy(true);
    setError(null);
    try {
      const slot = await commitImport();
      // 整库替换后，旧库的会话状态不再适用：重新绑定并打开新库，
      // 清掉购物车与当前订单，重读「当前展会」，并锁定后台
      // ——导入的可能是另一个数据集的库，它的 PIN 与当前解锁状态无关。
      resetDatabaseBinding();
      const status = await openDatabase(slot);
      const st = useApp.getState();
      st.setDbStatus(status);
      st.clearCart();
      st.setCurrentOrder(null);
      st.setCurrentEvent(await getCurrentEventId());
      st.lockStaff();
      showToast('数据库已替换');
      setPreview(null);
      if (onDone) onDone();
      else navigate('/', { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-page">
      <div className="card">
        <h2>{firstLaunch ? '准备本地数据库' : '导入数据库'}</h2>
        {firstLaunch ? (
          <p className="small muted">
            展会数据全部保存在这台设备的浏览器存储里，不上传服务器。可以先建立空库在电脑上录入商品，
            也可以直接导入之前导出的 SQLite 文件。
          </p>
        ) : null}

        <div className="col" style={{ marginTop: 14 }}>
          <div className="notice info">
            <strong>整库替换</strong>：导入会用文件完整替换当前数据库，不合并任何本地修改。
            {firstLaunch
              ? '这里还是空的，直接选文件即可。'
              : '旧库文件会留在设备上，但界面上没有入口能打开它——先导出一份备份，再替换。'}
          </div>

          <label className="field">
            <span>选择 SQLite 文件（.sqlite3 / .db）</span>
            {/*
              accept 按平台给：
              Android 上裸 input 会退化成媒体选择器（只有拍照/相册，没有「文件」入口），
              必须给通配 accept 才选得到 .sqlite3；iOS 反之，写具体类型会把文件整个置灰。
              详见 src/ui/file-accept.ts
            */}
            <input
              type="file"
              accept={importFileAccept(navigator.userAgent)}
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                // 清空 value：否则同一个文件第二次选不会触发 change
                e.target.value = '';
                if (f) void onFile(f);
              }}
            />
          </label>
          <p className="tiny muted" style={{ marginTop: -4 }}>
            {importFileHint(navigator.userAgent)}
          </p>

          {busy ? <Spinner label="正在校验文件…" /> : null}
          <ErrorBox message={error} />

          {preview ? (
            <div className="card" style={{ background: 'var(--surface-2)' }}>
              <h3>确认替换</h3>
              <div className="grid cols-2">
                <div>
                  <div className="small muted">当前设备数据</div>
                  <dl className="kv">
                    <dt>数据集</dt>
                    <dd className="tiny">{preview.current.datasetId ?? '—'}</dd>
                    <dt>revision</dt>
                    <dd>{preview.current.revision}</dd>
                    <dt>订单数</dt>
                    <dd>{preview.current.orderCount}（成交 {preview.current.completedOrderCount}）</dd>
                  </dl>
                </div>
                <div>
                  <div className="small muted">待导入（{fileName}）</div>
                  <dl className="kv">
                    <dt>数据集</dt>
                    <dd className="tiny">{preview.candidate.datasetId ?? '—'}</dd>
                    <dt>revision</dt>
                    <dd>{preview.candidate.revision}</dd>
                    <dt>订单数</dt>
                    <dd>
                      {preview.candidate.orderCount}（成交 {preview.candidate.completedOrderCount}）
                    </dd>
                    <dt>商品数</dt>
                    <dd>{preview.candidate.productCount}</dd>
                    <dt>最近成交</dt>
                    <dd>{preview.candidate.latestCompletedAt ?? '—'}</dd>
                    <dt>文件大小</dt>
                    <dd>{formatBytes(preview.candidate.byteSize)}</dd>
                  </dl>
                </div>
              </div>
              {preview.warnings.map((w) => (
                <div key={w} className="notice" style={{ marginTop: 8 }}>
                  {w}
                </div>
              ))}
              {preview.candidate.migratedFrom !== null ? (
                <div className="notice info" style={{ marginTop: 8 }}>
                  该文件来自旧 schema {preview.candidate.migratedFrom}，已迁移到当前版本。
                </div>
              ) : null}

              {/* 和「新建空数据库」的确认面板对称：这是最后一个能回头的地方，
                  保存入口就摆在这儿，不用退回上一页去导。 */}
              {firstLaunch ? null : (
                <SaveDatabase reloadKey={savedAt} onSaved={() => backup.reload()} />
              )}

              <div className="row" style={{ marginTop: 12 }}>
                <button className="danger" onClick={doCommit} disabled={busy}>
                  确认替换
                </button>
                <button onClick={() => setPreview(null)} disabled={busy}>
                  取消
                </button>
              </div>
            </div>
          ) : null}

          {firstLaunch ? (
            <div className="row">
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  if (onDone) onDone();
                  else navigate('/', { replace: true });
                }}
              >
                建立新的空数据库
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
