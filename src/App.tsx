import { useCallback, useEffect, useState } from 'react';
import {
  BrowserRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate
} from 'react-router-dom';
import './styles.css';
import { checkCapabilities, requestPersistence, acquireOwnership } from './db/storage-guard';
import {
  errorMessage,
  isFirstLaunch,
  markInitialized,
  openDatabase,
  readStoredSlot,
  useApp
} from './store';
import { getCurrentEventId, isPinSet, setPin, verifyPin } from './services/system';
import { ErrorBox, PinPad, Spinner } from './ui/components';
import BackupNudge from './ui/BackupNudge';
import SetupPage from './ui/pages/Setup';
import HomePage from './ui/pages/Home';
import HelpPage from './ui/pages/Help';
import KioskMenuPage from './ui/pages/KioskMenu';
import KioskCartPage from './ui/pages/KioskCart';
import KioskCheckoutPage from './ui/pages/KioskCheckout';
import KioskOrderPage from './ui/pages/KioskOrder';
import StaffCheckoutPage from './ui/pages/StaffCheckout';
import StaffPendingPage from './ui/pages/StaffPending';
import StaffProductsPage from './ui/pages/StaffProducts';
import StaffEventsPage from './ui/pages/StaffEvents';
import StaffInventoryPage from './ui/pages/StaffInventory';
import StaffOrdersPage from './ui/pages/StaffOrders';
import StaffReportsPage from './ui/pages/StaffReports';
import StaffBackupPage from './ui/pages/StaffBackup';
import SettingsPage from './ui/pages/Settings';
import PreviewPage from './ui/pages/Preview';
import { askBeforeKiosk, confirmEnterKiosk } from './ui/kiosk-entry';

function BootScreen() {
  const { diagnostics, error } = useApp((s) => ({ diagnostics: s.diagnostics, error: s.error }));
  return (
    <div className="center-page">
      <div className="card">
        <h2>正在准备离线数据库</h2>
        <p className="muted small">检查浏览器能力、持久化与存储权限，并打开本地 SQLite。</p>
        {error ? <ErrorBox message={error} /> : <Spinner label="检查中…" />}
        {diagnostics.capabilities?.details?.length ? (
          <ul className="small muted" style={{ textAlign: 'left' }}>
            {diagnostics.capabilities.details.map((d: string) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function BlockedScreen() {
  const d = useApp((s) => s.diagnostics);
  const caps = d.capabilities;
  return (
    <div className="center-page">
      <div className="card">
        <h2>当前环境不能营业</h2>
        <p className="small muted">
          本应用需要安全上下文、WebAssembly、OPFS 与跨源隔离（SharedArrayBuffer）。
          请使用 HTTPS 或 localhost 打开，并确认服务端返回 COOP/COEP 响应头。
        </p>
        <table className="small">
          <tbody>
            <tr>
              <td>安全上下文</td>
              <td>{caps?.secureContext ? '通过' : '不满足'}</td>
            </tr>
            <tr>
              <td>跨源隔离</td>
              <td>{caps?.crossOriginIsolated ? '通过' : '不满足'}</td>
            </tr>
            <tr>
              <td>WebAssembly</td>
              <td>{caps?.webAssembly ? '通过' : '不满足'}</td>
            </tr>
            <tr>
              <td>OPFS</td>
              <td>{caps?.opfs ? '通过' : '不满足'}</td>
            </tr>
            <tr>
              <td>SharedArrayBuffer</td>
              <td>{caps?.sharedArrayBuffer ? '通过' : '不满足'}</td>
            </tr>
            <tr>
              <td>Service Worker</td>
              <td>{caps?.serviceWorker ? '可用' : '不可用'}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AnotherWindowScreen() {
  const bootstrap = useBootstrap();
  return (
    <div className="center-page">
      <div className="card">
        <h2>Doujin POS 已在另一个窗口运行</h2>
        <p className="small muted">请切换至已有窗口操作。同一浏览器同时只能有一个可写数据库实例。</p>
        <button className="primary" onClick={bootstrap}>
          重试
        </button>
      </div>
    </div>
  );
}

function useBootstrap() {
  const setStage = useApp((s) => s.setStage);
  const setDiagnostics = useApp((s) => s.setDiagnostics);
  const setDbStatus = useApp((s) => s.setDbStatus);
  const setCurrentEvent = useApp((s) => s.setCurrentEvent);

  return useCallback(async () => {
    setStage('checking');
    try {
      const capabilities = await checkCapabilities();
      setDiagnostics({ capabilities });
      if (!capabilities.secureContext || !capabilities.webAssembly || !capabilities.opfs || !capabilities.sharedArrayBuffer) {
        setStage('blocked');
        return;
      }
      const ownership = await acquireOwnership();
      if (!ownership.ok) {
        setStage('another-window');
        return;
      }
      setDiagnostics({ ownershipReason: ownership.reason });
      const persistence = await requestPersistence();
      setDiagnostics({ persistence });
      if (!persistence.granted) {
        // 持久化未获批但 OPFS 可写：交给摊主在引导页决定是否受限营业
        const confirmed = window.confirm(
          '浏览器未授予持久化存储权限。继续营业存在数据被系统回收的风险，需要频繁导出备份。\n\n选择「确定」进入受限营业模式，选择「取消」退出。'
        );
        if (!confirmed) {
          setStage('blocked');
          return;
        }
        useApp.getState().setLimitedMode(true);
      }
      const status = await openDatabase(readStoredSlot());
      setDbStatus(status);
      const eventId = await getCurrentEventId();
      setCurrentEvent(eventId || null);
      setStage('ready');
    } catch (e) {
      setStage('error', errorMessage(e));
    }
  }, [setCurrentEvent, setDbStatus, setDiagnostics, setStage]);
}

/** 后台路由保护：未解锁时只显示 PIN 界面，不渲染后台内容。 */
function StaffGuard({ children }: { children: React.ReactNode }) {
  const unlocked = useApp((s) => s.staffUnlocked);
  const unlockStaff = useApp((s) => s.unlockStaff);
  const [error, setError] = useState<string | null>(null);
  const [needSetup, setNeedSetup] = useState<boolean | null>(null);
  const [newPin, setNewPin] = useState('');

  useEffect(() => {
    isPinSet().then((v) => setNeedSetup(!v));
  }, []);

  if (unlocked) return <>{children}</>;
  if (needSetup === null) {
    return (
      <div className="center-page">
        <Spinner label="检查后台锁定状态…" />
      </div>
    );
  }

  if (needSetup) {
    return (
      <div className="center-page">
        <div className="card">
          <h2>设置后台 PIN</h2>
          <p className="small muted">
            PIN 用于防止游客误触后台，不是强安全认证。请勿在 URL 中传递，也不要用生日等易猜数字。
          </p>
          <PinPad
            hint="输入 4 到 8 位数字"
            error={error}
            onSubmit={async (pin) => {
              try {
                await setPin(pin);
                setError(null);
                setNeedSetup(false);
                unlockStaff();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="center-page">
      <div className="card">
        <h2>请输入后台 PIN</h2>
        <PinPad
          error={error}
          onSubmit={async (pin) => {
            const ok = await verifyPin(pin);
            if (ok) {
              setError(null);
              unlockStaff();
            } else {
              setError('PIN 不正确');
            }
          }}
        />
        <div className="row" style={{ marginTop: 12 }}>
          <input
            className="small"
            placeholder="改 PIN（可选）"
            value={newPin}
            onChange={(e) => setNewPin(e.target.value)}
            style={{ maxWidth: 160 }}
          />
          <button
            className="small"
            onClick={() => {
              setNewPin('');
              setNeedSetup(true);
            }}
          >
            重新设置
          </button>
        </div>
      </div>
    </div>
  );
}

function Sidebar() {
  const lockStaff = useApp((s) => s.lockStaff);
  const limited = useApp((s) => s.limitedMode);
  const staffUnlocked = useApp((s) => s.staffUnlocked);
  return (
    <nav className="sidebar">
      <div className="brand">Doujin POS</div>
      <NavLink to="/" className={({ isActive }) => (isActive ? 'active' : '')} end>
        展会主页
      </NavLink>
      <NavLink
        to="/kiosk"
        className={({ isActive }) => (isActive ? 'active' : '')}
        onClick={(e) => {
          if (!askBeforeKiosk()) e.preventDefault();
        }}
      >
        游客菜单
      </NavLink>
      <NavLink to="/preview" className={({ isActive }) => (isActive ? 'active' : '')}>
        菜单预览
        <span className="tiny muted" style={{ display: 'block', fontWeight: 400 }}>
          不锁后台，可换尺寸
        </span>
      </NavLink>
      <div className="sep" />
      <NavLink to="/staff/checkout" className={({ isActive }) => (isActive ? 'active' : '')}>
        摊主收银
      </NavLink>
      <NavLink to="/staff/pending" className={({ isActive }) => (isActive ? 'active' : '')}>
        待付款
      </NavLink>
      <NavLink to="/staff/orders" className={({ isActive }) => (isActive ? 'active' : '')}>
        订单
      </NavLink>
      <NavLink to="/staff/inventory" className={({ isActive }) => (isActive ? 'active' : '')}>
        库存
      </NavLink>
      <div className="sep" />
      <NavLink to="/staff/products" className={({ isActive }) => (isActive ? 'active' : '')}>
        商品
      </NavLink>
      <NavLink to="/staff/events" className={({ isActive }) => (isActive ? 'active' : '')}>
        展会配置
      </NavLink>
      <NavLink to="/staff/reports" className={({ isActive }) => (isActive ? 'active' : '')}>
        报表收摊
      </NavLink>
      <NavLink to="/staff/backup" className={({ isActive }) => (isActive ? 'active' : '')}>
        备份恢复
      </NavLink>
      <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
        设置
      </NavLink>
      <NavLink to="/help" className={({ isActive }) => (isActive ? 'active' : '')}>
        说明书
        <span className="tiny muted" style={{ display: 'block', fontWeight: 400 }}>
          摆摊前中后怎么做
        </span>
      </NavLink>
      {limited ? <div className="side-note">受限营业模式：请频繁导出备份</div> : null}
      {staffUnlocked ? (
        <button className="small ghost" onClick={lockStaff}>
          锁定后台
        </button>
      ) : null}
    </nav>
  );
}

function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  const isKiosk = location.pathname.startsWith('/kiosk');
  const currentEventId = useApp((s) => s.currentEventId);

  useEffect(() => {
    // 切后台/回到游客页面时清理会话
    if (isKiosk) useApp.getState().lockStaff();
  }, [isKiosk]);

  return (
    <div className="app">
      {!isKiosk ? <Sidebar /> : null}
      <div className="main">
        {!isKiosk ? (
          <div className="topbar">
            <strong>同人摊位电子菜单</strong>
            {currentEventId ? null : <span className="badge warn">未选择展会</span>}
            <span className="spacer" />
            <button className="small" onClick={() => navigate('/preview')}>
              预览菜单效果
            </button>
            <button className="small ghost" onClick={() => confirmEnterKiosk(navigate)}>
              进入游客菜单
            </button>
          </div>
        ) : null}
        <div className={isKiosk ? '' : 'content'}>
          {/* 只在后台显示：游客付款过程中不弹后台信息 */}
          {!isKiosk ? <BackupNudge /> : null}
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/kiosk" element={<KioskMenuPage />} />
            <Route path="/kiosk/cart" element={<KioskCartPage />} />
            <Route path="/kiosk/checkout" element={<KioskCheckoutPage />} />
            <Route path="/kiosk/order/:id" element={<KioskOrderPage />} />
            <Route
              path="/staff/checkout"
              element={
                <StaffGuard>
                  <StaffCheckoutPage />
                </StaffGuard>
              }
            />
            <Route
              path="/staff/pending"
              element={
                <StaffGuard>
                  <StaffPendingPage />
                </StaffGuard>
              }
            />
            <Route
              path="/staff/products"
              element={
                <StaffGuard>
                  <StaffProductsPage />
                </StaffGuard>
              }
            />
            <Route
              path="/staff/events"
              element={
                <StaffGuard>
                  <StaffEventsPage />
                </StaffGuard>
              }
            />
            <Route
              path="/staff/inventory"
              element={
                <StaffGuard>
                  <StaffInventoryPage />
                </StaffGuard>
              }
            />
            <Route
              path="/staff/orders"
              element={
                <StaffGuard>
                  <StaffOrdersPage />
                </StaffGuard>
              }
            />
            <Route
              path="/staff/reports"
              element={
                <StaffGuard>
                  <StaffReportsPage />
                </StaffGuard>
              }
            />
            <Route
              path="/staff/backup"
              element={
                <StaffGuard>
                  <StaffBackupPage />
                </StaffGuard>
              }
            />
            <Route path="/help" element={<HelpPage />} />
            <Route
              path="/settings"
              element={
                <StaffGuard>
                  <SettingsPage />
                </StaffGuard>
              }
            />
            <Route
              path="/preview"
              element={
                <StaffGuard>
                  <PreviewPage />
                </StaffGuard>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const stage = useApp((s) => s.stage);
  const bootstrap = useBootstrap();
  const [setupDone, setSetupDone] = useState(false);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (stage === 'idle' || stage === 'checking') return <BootScreen />;
  if (stage === 'another-window') return <AnotherWindowScreen />;
  if (stage === 'blocked') return <BlockedScreen />;
  if (stage === 'error') return <BootScreen />;

  return (
    <BrowserRouter>
      {isFirstLaunch() && !setupDone ? (
        <SetupPage
          firstLaunch
          onDone={() => {
            markInitialized();
            setSetupDone(true);
          }}
        />
      ) : (
        <Shell />
      )}
    </BrowserRouter>
  );
}
