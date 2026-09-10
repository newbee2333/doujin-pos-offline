import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { commitImport, stageImport, type ReplacePreview } from '../../services/system';
import { errorMessage, useApp } from '../../store';
import { ErrorBox, Spinner } from '../components';
import { formatBytes } from '../../domain/image';

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
      await commitImport();
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
            覆盖前会自动保留可恢复的旧副本，但仍建议先导出一份备份保存到设备外。
          </div>

          <label className="field">
            <span>选择 SQLite 文件（.sqlite3 / .db）</span>
            {/*
              故意不写 accept：iOS Safari 按系统 UTI 过滤，.sqlite3/.db 和
              application/x-sqlite3 都没有对应 UTI，文件会被整个置灰选不中。
              文件是否合法由内容判定（读文件头 + application_id），不靠扩展名。
            */}
            <input
              type="file"
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
            如果列表里选不中，检查「文件」App 里文件有没有下载到本机（iCloud 未下载的条目也会是灰色）。
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
