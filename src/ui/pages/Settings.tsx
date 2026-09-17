import { useState } from 'react';
import { setSetting } from '../../services/context';
import { isPinSet, setPin } from '../../services/system';
import { checkCapabilities, requestPersistence } from '../../db/storage-guard';
import { errorMessage, useApp } from '../../store';
import { ErrorBox, Field, SetPinFlow, Spinner, useAsync } from '../components';
import { formatBytes } from '../../domain/image';

export default function SettingsPage() {
  const diagnostics = useApp((s) => s.diagnostics);
  const limited = useApp((s) => s.limitedMode);
  const showToast = useApp((s) => s.showToast);
  const [mode, setMode] = useState<'none' | 'new'>('none');
  const [error, setError] = useState<string | null>(null);

  const pinSet = useAsync(() => isPinSet(), []);
  const persisted = useAsync(() => requestPersistence(), []);
  const caps = useAsync(() => checkCapabilities(), []);

  return (
    <div className="page narrow">
      <h1>设置</h1>

      <div className="card">
        <h2>安全与访问</h2>
        <p className="small muted">
          PIN 只用于防止游客误触后台，不是对设备持有者的强安全认证。不要通过 URL 传递。
        </p>
        {pinSet.loading ? (
          <Spinner label="读取…" />
        ) : mode === 'none' ? (
          <div className="col">
            <div className="row">
              <button onClick={() => setMode('new')}>
                {pinSet.data ? '修改后台 PIN' : '设置后台 PIN'}
              </button>
              <span className="tiny muted">改完不会把你踢出去，下次进入后台时生效。</span>
            </div>
            <p className="tiny muted" style={{ margin: 0 }}>
              忘记 PIN 没有自助找回的办法：一旦忘了就进不去后台，只能清空本站数据重来
              （商品和订单会一起没掉）。所以请先用上面的按钮把它改成一个你记得住的数字，
              并把导出备份养成习惯。
            </p>
          </div>
        ) : (
          <>
            <ErrorBox message={error} />
            {/* 不要求先输旧 PIN：能走到这一页说明会话本来就是解锁状态，
                再输一次只是多一道仪式感。 */}
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
                  showToast('PIN 已更新，下次进入后台时生效');
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            />
          </>
        )}
      </div>

      {/* 「库存展示」原来在设置里，但真正要调的是「哪几个商品露库存」——
          那是个逐商品的开关，在展会配置的参展商品表里。设置里放一个全局默认值，
          既和逐商品开关重复，又让人以为改了它就等于改了全部。
          现在只保留逐商品开关，说明挂在那个列头的问号上。 */}

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
