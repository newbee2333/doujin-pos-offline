import { useState } from 'react';
import { getSetting, setSetting } from '../../services/context';
import { isPinSet, setPin, verifyPin } from '../../services/system';
import { checkCapabilities, requestPersistence } from '../../db/storage-guard';
import { errorMessage, useApp } from '../../store';
import { ErrorBox, Field, PinPad, Spinner, useAsync } from '../components';
import { formatBytes } from '../../domain/image';

export default function SettingsPage() {
  const diagnostics = useApp((s) => s.diagnostics);
  const limited = useApp((s) => s.limitedMode);
  const showToast = useApp((s) => s.showToast);
  const [mode, setMode] = useState<'none' | 'verify' | 'new'>('none');
  const [error, setError] = useState<string | null>(null);
  const [showExact, setShowExact] = useState<string>('0');

  const pinSet = useAsync(() => isPinSet(), []);
  const persisted = useAsync(() => requestPersistence(), []);
  const caps = useAsync(() => checkCapabilities(), []);
  const stockSetting = useAsync(() => getSetting('display.show_exact_stock'), []);

  if (stockSetting.data !== null && showExact !== stockSetting.data && stockSetting.data !== undefined) {
    setShowExact(stockSetting.data);
  }

  return (
    <div className="content narrow">
      <h1>设置</h1>

      <div className="card">
        <h2>后台 PIN</h2>
        <p className="small muted">
          PIN 只用于防止游客误触后台，不是对设备持有者的强安全认证。不要通过 URL 传递。
        </p>
        {pinSet.loading ? (
          <Spinner label="读取…" />
        ) : mode === 'none' ? (
          <button
            onClick={() => setMode(pinSet.data ? 'verify' : 'new')}
          >
            {pinSet.data ? '修改 PIN' : '设置 PIN'}
          </button>
        ) : mode === 'verify' ? (
          <PinPad
            hint="先输入当前 PIN"
            error={error}
            onCancel={() => setMode('none')}
            onSubmit={async (pin) => {
              if (await verifyPin(pin)) {
                setError(null);
                setMode('new');
              } else setError('PIN 不正确');
            }}
          />
        ) : (
          <PinPad
            hint="输入新的 4 到 8 位数字"
            error={error}
            onCancel={() => setMode('none')}
            onSubmit={async (pin) => {
              try {
                await setPin(pin);
                setError(null);
                setMode('none');
                pinSet.reload();
                showToast('PIN 已更新');
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          />
        )}
      </div>

      <div className="card">
        <h2>库存展示</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={showExact === '1'}
            onChange={async (e) => {
              const v = e.target.checked ? '1' : '0';
              setShowExact(v);
              await setSetting('display.show_exact_stock', v);
            }}
          />
          游客菜单默认显示精确剩余数量（不选则显示「有货 / 少量 / 售罄」）
        </label>
        <p className="tiny muted">单个商品仍可在展会配置里单独覆盖。</p>
      </div>

      <div className="card">
        <h2>存储与离线状态</h2>
        <dl className="kv">
          <dt>持久化</dt>
          <dd>
            {persisted.data?.granted ? (
              <span className="badge ok">已获批</span>
            ) : (
              <span className="badge danger">未获批</span>
            )}
          </dd>
          <dt>已用 / 配额</dt>
          <dd>
            {persisted.data?.usageBytes != null ? formatBytes(persisted.data.usageBytes) : '—'} /{' '}
            {persisted.data?.quotaBytes != null ? formatBytes(persisted.data.quotaBytes) : '—'}
          </dd>
          <dt>OPFS</dt>
          <dd>{caps.data?.opfs ?? diagnostics.capabilities?.opfs ? '可用' : '不可用'}</dd>
          <dt>跨源隔离</dt>
          <dd>{caps.data?.crossOriginIsolated ?? diagnostics.capabilities?.crossOriginIsolated ? '已启用' : '未启用'}</dd>
          <dt>受限营业</dt>
          <dd>{limited ? '是（请频繁导出备份）' : '否'}</dd>
        </dl>
        {(caps.data?.details?.length ?? 0) > 0 ? (
          <div className="notice">
            {(caps.data?.details ?? []).map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>
        ) : null}
        <p className="tiny muted" style={{ marginBottom: 0 }}>
          持久化获批不等于数据绝不丢失，它不能代替设备外的备份文件。
        </p>
      </div>

      <div className="card">
        <h2>关于</h2>
        <p className="small muted">
          Doujin POS V1 —— 本地优先、完全离线的同人摊位电子菜单与收银系统。界面为简体中文，币种支持人民币与日元。
        </p>
        <Field label="备注（记录在设置里，可用于标记设备）">
          <input
            defaultValue=""
            placeholder="例如：主营业平板"
            onBlur={async (e) => {
              await setSetting('device.label', e.target.value);
            }}
          />
        </Field>
      </div>
    </div>
  );
}
