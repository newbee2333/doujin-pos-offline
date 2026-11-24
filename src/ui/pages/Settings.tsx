import { useEffect, useState } from 'react';
import { getSetting, setSetting } from '../../services/context';
import {
  getBoothName,
  getLandscapeCartEnabled,
  isPinSet,
  setBoothName,
  setLandscapeCartEnabled,
  setPin
} from '../../services/system';
import { checkCapabilities, requestPersistence } from '../../db/storage-guard';
import { errorMessage, useApp } from '../../store';
import { ErrorBox, Field, Modal, SetPinFlow, Spinner, useAsync } from '../components';
import { formatBytes } from '../../domain/image';
import { useTheme, type ThemePreference } from '../../theme';
import { authorizeAdjustment, requiresAdjustmentPin } from '../../services/promotions';

const THEME_OPTIONS: { value: ThemePreference; label: string; hint: string }[] = [
  { value: 'system', label: '跟随系统', hint: '随设备自动切换' },
  { value: 'light', label: '浅色', hint: '始终使用浅色界面' },
  { value: 'dark', label: '深色', hint: '始终使用夜间界面' }
];

export default function SettingsPage() {
  const diagnostics = useApp((s) => s.diagnostics);
  const limited = useApp((s) => s.limitedMode);
  const showToast = useApp((s) => s.showToast);
  const [mode, setMode] = useState<'none' | 'new'>('none');
  const [error, setError] = useState<string | null>(null);
  const [layoutOverride, setLayoutOverride] = useState<boolean | null>(null);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const layout = useAsync(getLandscapeCartEnabled, []);
  const storedBoothName = useAsync(getBoothName, []);
  const storedDeviceLabel = useAsync(() => getSetting('device.label'), []);
  const [boothNameInput, setBoothNameInput] = useState('');
  const [boothNameLoaded, setBoothNameLoaded] = useState(false);
  const [deviceLabelInput, setDeviceLabelInput] = useState('');
  const [deviceLabelLoaded, setDeviceLabelLoaded] = useState(false);
  const { preference, setPreference, lightPalette, setLightPalette, storageError } = useTheme();

  const pinSet = useAsync(() => isPinSet(), []);
  const adjustmentSecurity = useAsync(requiresAdjustmentPin, []);
  const [changingSecurity, setChangingSecurity] = useState(false);
  const [securityPin, setSecurityPin] = useState('');
  const [securityError, setSecurityError] = useState<string | null>(null);
  const [securityBusy, setSecurityBusy] = useState(false);
  const persisted = useAsync(() => requestPersistence(), []);
  const caps = useAsync(() => checkCapabilities(), []);

  useEffect(() => {
    if (!storedBoothName.loading && !boothNameLoaded) {
      setBoothNameInput(storedBoothName.data ?? '');
      setBoothNameLoaded(true);
    }
  }, [storedBoothName.loading, storedBoothName.data, boothNameLoaded]);

  useEffect(() => {
    if (!storedDeviceLabel.loading && !deviceLabelLoaded) {
      setDeviceLabelInput(storedDeviceLabel.data ?? '');
      setDeviceLabelLoaded(true);
    }
  }, [storedDeviceLabel.loading, storedDeviceLabel.data, deviceLabelLoaded]);

  return (
    <div className="page narrow">
      {changingSecurity && (
        <Modal
          title="关闭调价密码确认"
          onClose={
            securityBusy
              ? undefined
              : () => {
                  setChangingSecurity(false);
                  setSecurityPin('');
                  setSecurityError(null);
                }
          }
          actions={
            <>
              <button
                disabled={securityBusy}
                onClick={() => {
                  setChangingSecurity(false);
                  setSecurityPin('');
                  setSecurityError(null);
                }}
              >
                取消
              </button>
              <button
                className="primary"
                disabled={securityBusy}
                onClick={async () => {
                  setSecurityBusy(true);
                  setSecurityError(null);
                  try {
                    await authorizeAdjustment(securityPin);
                    await setSetting('security.adjustment_pin', '0');
                    setSecurityPin('');
                    setSecurityError(null);
                    setChangingSecurity(false);
                    adjustmentSecurity.reload();
                  } catch (e) {
                    setSecurityError(errorMessage(e));
                  } finally {
                    setSecurityBusy(false);
                  }
                }}
              >
                确认关闭
              </button>
            </>
          }
        >
          <p>关闭后，已解锁后台的人员可以直接人工调价。请输入后台密码确认。</p>
          <input
            type="password"
            aria-label="安全设置确认密码"
            inputMode="numeric"
            value={securityPin}
            onChange={(e) => setSecurityPin(e.target.value)}
          />
          <ErrorBox message={securityError} />
        </Modal>
      )}
      <h1>设置</h1>

      <div className="card">
        <h2>外观</h2>
        <div className="theme-options" role="radiogroup" aria-label="外观模式">
          {THEME_OPTIONS.map((option) => (
            <label className={`theme-choice${preference === option.value ? ' selected' : ''}`} key={option.value}>
              <input
                type="radio"
                name="theme"
                value={option.value}
                checked={preference === option.value}
                onChange={() => setPreference(option.value)}
              />
              <span>
                <strong>{option.label}</strong>
                <span className="tiny muted">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <h3 className="palette-heading">浅色配色</h3>
        <div className="theme-options light-theme-options" role="radiogroup" aria-label="浅色配色">
          {(['default', 'warm'] as const).map((palette) => (
            <label className={`theme-choice${lightPalette === palette ? ' selected' : ''}`} key={palette}>
              <input
                type="radio"
                name="light-palette"
                checked={lightPalette === palette}
                onChange={() => setLightPalette(palette)}
              />
              <span className={`palette-swatch ${palette}`} aria-hidden="true" />
              <span>
                <strong>{palette === 'warm' ? '暖纸' : '清爽白'}</strong>
                <span className="tiny muted">
                  {palette === 'warm' ? '暖米画纸 · 温润护眼' : '浅画纸白 · 樱桃玫红'}
                </span>
              </span>
            </label>
          ))}
        </div>
        <p className="tiny muted">浅色配色也用于跟随系统时的日间界面，深色模式保持深靛夜间配色。</p>
        <p className="small muted">默认跟随系统，游客菜单与后台同步切换。选择只保存在这台设备的浏览器中，不随数据库备份迁移。</p>
        {storageError ? (
          <p className="notice" role="status">
            当前浏览器无法保存本次外观选择；当前窗口已生效，重新打开后可能恢复原设置。
          </p>
        ) : null}
      </div>

      <div className="card">
        <h2>游客菜单</h2>
        <div className="col" style={{ marginBottom: 14 }}>
          <Field label="摊位 / 社团招牌名（选填，显示在游客菜单顶部；留空则显示当前展会名）">
            <div className="row tight">
              <input
                type="text"
                style={{ flex: 1 }}
                value={boothNameInput}
                onChange={(e) => setBoothNameInput(e.target.value)}
                placeholder="例如：猫猫印务局"
              />
              <button
                type="button"
                className="small"
                onClick={async () => {
                  try {
                    await setBoothName(boothNameInput);
                    showToast(boothNameInput.trim() ? '已保存摊位招牌名' : '已清除，将显示当前展会名');
                  } catch (e) {
                    showToast(errorMessage(e));
                  }
                }}
              >
                保存
              </button>
            </div>
          </Field>
        </div>

        {layout.loading ? (
          <Spinner label="读取布局设置…" />
        ) : (
          <label className="check">
            <input
              type="checkbox"
              role="switch"
              checked={layoutOverride ?? layout.data ?? true}
              disabled={layoutBusy || !!layout.error}
              onChange={async (e) => {
                const enabled = e.target.checked;
                const previous = layoutOverride ?? layout.data ?? true;
                setLayoutOverride(enabled);
                setLayoutBusy(true);
                setLayoutError(null);
                try {
                  await setLandscapeCartEnabled(enabled);
                  showToast(enabled ? '横屏改用右侧购物车' : '横屏改用底部购物车入口');
                } catch (err) {
                  setLayoutOverride(previous);
                  setLayoutError(errorMessage(err));
                } finally {
                  setLayoutBusy(false);
                }
              }}
            />
            <span>iPad 横屏右侧购物车</span>
          </label>
        )}
        <p className="small muted">
          默认开启。关闭后，横屏也使用底部的「查看购物车」入口，点击后进入购物车页。竖屏和手机布局不变。
        </p>
        <ErrorBox message={layoutError ?? layout.error} />
      </div>

      <div className="card">
        <h2>安全与访问</h2>
        <label className="check">
          <input
            type="checkbox"
            role="switch"
            checked={adjustmentSecurity.data ?? true}
            disabled={adjustmentSecurity.loading || !!adjustmentSecurity.error}
            onChange={async (e) => {
              if (!e.target.checked) {
                setSecurityPin('');
                setSecurityError(null);
                setChangingSecurity(true);
              } else {
                try {
                  await setSetting('security.adjustment_pin', '1');
                  adjustmentSecurity.reload();
                } catch (e) {
                  setError(errorMessage(e));
                }
              }
            }}
          />
          人工调价需要后台密码确认
        </label>
        <p className="tiny muted">
          默认开启。调价与后台共用密码，连续输错 5 次需等待一分钟；调价原因和金额会记入审计。此设置随数据库备份保存。
        </p>
        <p className="small muted">
          后台密码为 4～8 位数字，用于防止游客误触后台，不能代替设备锁屏密码。请妥善保管。
        </p>
        {pinSet.loading ? (
          <Spinner label="读取…" />
        ) : mode === 'none' ? (
          <div className="col">
            <div className="row">
              <button onClick={() => setMode('new')}>
                {pinSet.data ? '修改后台密码' : '设置后台密码'}
              </button>
              <span className="tiny muted">改完不会把你踢出去，下次进入后台时生效。</span>
            </div>
            <p className="tiny muted" style={{ margin: 0 }}>
              忘记后台密码没有自助找回的办法：一旦忘了就进不去后台，只能清空本站数据重来
              （商品和订单会一起没掉）。所以请先用上面的按钮把它改成一个你记得住的数字，
              数据保存与恢复操作集中在「备份与恢复」。
            </p>
          </div>
        ) : (
          <>
            <ErrorBox message={error} />
            <SetPinFlow
              firstHint="输入新的 4 到 8 位数字"
              onCancel={() => {
                setError(null);
                setMode('none');
              }}
              onSubmit={async (pin) => {
                try {
                  await setPin(pin);
                  setError(null);
                  setMode('none');
                  pinSet.reload();
                  showToast('后台密码已更新，下次进入后台时生效');
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            />
          </>
        )}
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
          <dt>受限营业</dt>
          <dd>{limited ? '是' : '否'}</dd>
        </dl>
        <details>
          <summary>查看技术详情</summary>
          <dl className="kv">
            <dt>OPFS</dt>
            <dd>{caps.data?.opfs ?? diagnostics.capabilities?.opfs ? '可用' : '不可用'}</dd>
            <dt>跨源隔离</dt>
            <dd>{caps.data?.crossOriginIsolated ?? diagnostics.capabilities?.crossOriginIsolated ? '已启用' : '未启用'}</dd>
          </dl>
          {(caps.data?.details?.length ?? 0) > 0 ? (
            <div className="notice">
              {(caps.data?.details ?? []).map((d) => (
                <div key={d}>{d}</div>
              ))}
            </div>
          ) : null}
        </details>
        <p className="tiny muted" style={{ marginBottom: 0 }}>
          持久化状态由当前浏览器决定。
        </p>
      </div>

      <div className="card">
        <h2>关于</h2>
        <p className="small muted">
          Doujin POS V1 —— 本地优先、完全离线的同人摊位电子菜单与收银系统。界面为简体中文，币种支持人民币与日元。
        </p>
        <Field label="备注（记录在设置里，可用于标记设备）">
          <input
            value={deviceLabelInput}
            onChange={(e) => setDeviceLabelInput(e.target.value)}
            placeholder="例如：主营业平板"
            onBlur={async () => {
              await setSetting('device.label', deviceLabelInput.trim());
            }}
          />
        </Field>
      </div>
    </div>
  );
}
