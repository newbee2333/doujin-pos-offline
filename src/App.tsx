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
import { getEvent } from './services/events';
import { countPendingOrders } from './services/orders';
import { getCurrentEventId, isPinSet, setPin, verifyPin } from './services/system';
import type { Event as BoothEvent } from './domain/types';
import { ErrorBox, PinPad, SetPinFlow, Spinner } from './ui/components';
import SetupPage from './ui/pages/Setup';
import HomePage from './ui/pages/Home';
import HelpPage from './ui/pages/Help';
import KioskMenuPage from './ui/pages/KioskMenu';
import KioskCartPage from './ui/pages/KioskCart';
import KioskCheckoutPage from './ui/pages/KioskCheckout';
import KioskOrderPage from './ui/pages/KioskOrder';
import StaffPendingPage from './ui/pages/StaffPending';
import StaffProductsPage from './ui/pages/StaffProducts';
import StaffEventsPage from './ui/pages/StaffEvents';
import StaffPromotionsPage from './ui/pages/StaffPromotions';
import StaffInventoryPage from './ui/pages/StaffInventory';
import StaffOrdersPage from './ui/pages/StaffOrders';
import StaffReportsPage from './ui/pages/StaffReports';
import StaffBackupPage from './ui/pages/StaffBackup';
import SettingsPage from './ui/pages/Settings';
import PreviewPage from './ui/pages/Preview';
import { askBeforeKiosk, confirmEnterKiosk } from './ui/kiosk-entry';

let activeOwnership: { release: () => void; reason?: string } | null = null;

function releaseActiveOwnership() {
  if (!activeOwnership) return;
  try {
    activeOwnership.release();
  } catch {
    /* 忽略 */
  }
  activeOwnership = null;
}

function BootScreen() {
  const diagnostics = useApp((s) => s.diagnostics);
  const error = useApp((s) => s.error);
  const stage = useApp((s) => s.stage);
  const bootstrap = useBootstrap();
  return (
    <div className="center-page">
      <div className="card">
        <h2>{stage === 'error' ? '离线数据库启动失败' : '正在准备离线数据库'}</h2>
        <p className="muted small">
          {stage === 'error'
            ? '未能完成本机数据库初始化，你可以点击重试或检查浏览器存储权限。'
            : '正在检查浏览器和持久化状态，并打开本机数据库。'}
        </p>
        {error ? <ErrorBox message={error} /> : <Spinner label="检查中…" />}
        {stage === 'error' ? (
          <button className="primary" onClick={bootstrap}>
            重试
          </button>
        ) : null}
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
        <p className="small muted">当前打开方式或浏览器不支持本机数据保存。请通过正式发布链接打开应用；仍无法使用时，可展开技术详情提供给维护者排查。</p>
        <details>
          <summary>查看技术详情</summary>
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
        </details>
      </div>
    </div>
  );
}

function DeclinedLimitedScreen() {
  const bootstrap = useBootstrap();
  return (
    <div className="center-page">
      <div className="card">
        <h2>未进入营业模式</h2>
        <p className="small muted">
          浏览器没有授予持久化存储权限，而你没有选择受限营业，所以没有打开数据库。
          这不影响换台设备或换种方式继续——你的数据没有被改动。
        </p>
        <p className="small muted">受限营业意味着本机数据有被浏览器回收的可能。</p>
        <button className="primary" onClick={bootstrap}>
          返回并重新选择
        </button>
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
      if (
        !capabilities.secureContext ||
        !capabilities.webAssembly ||
        !capabilities.crossOriginIsolated ||
        !capabilities.sharedArrayBuffer ||
        !capabilities.opfs
      ) {
        setStage('blocked');
        return;
      }
      if (!activeOwnership) {
        const ownership = await acquireOwnership();
        if (!ownership.ok) {
          setStage('another-window');
          return;
        }
        activeOwnership = ownership;
      }
      setDiagnostics({ ownershipReason: activeOwnership.reason });
      const persistence = await requestPersistence();
      setDiagnostics({ persistence });
      if (!persistence.granted) {
        const confirmed = window.confirm(
          '浏览器未授予持久化存储权限。本机数据可能被系统回收。\n\n选择「确定」进入受限营业模式，选择「取消」退出。'
        );
        if (!confirmed) {
          releaseActiveOwnership();
          setStage('declined-limited');
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
      releaseActiveOwnership();
      setStage('error', errorMessage(e));
    }
  }, [setCurrentEvent, setDbStatus, setDiagnostics, setStage]);
}

function StaffGuard({ children }: { children: React.ReactNode }) {
  const unlocked = useApp((s) => s.staffUnlocked);
  const unlockStaff = useApp((s) => s.unlockStaff);
  const datasetId = useApp((s) => s.dbStatus?.datasetId ?? null);
  const slot = useApp((s) => s.dbStatus?.slot ?? null);
  const dataVersion = useApp((s) => s.dataVersion);
  const [error, setError] = useState<string | null>(null);
  const [needSetup, setNeedSetup] = useState<boolean | null>(null);

  useEffect(() => {
    if (unlocked) return;
    let cancelled = false;
    setNeedSetup(null);
    setError(null);
    isPinSet()
      .then((v) => {
        if (!cancelled) setNeedSetup(!v);
      })
      .catch((e) => {
        if (!cancelled) {
          setNeedSetup(false);
          setError(errorMessage(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [unlocked, datasetId, slot, dataVersion]);

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
          <h2>设置后台密码</h2>
          <p className="small muted">
            后台密码为 4～8 位数字，用于防止游客误触后台，不能代替设备锁屏密码。请妥善保管。
          </p>
          <ErrorBox message={error} />
          <SetPinFlow
            firstHint="输入 4 到 8 位数字"
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
        <h2>请输入后台密码</h2>
        <PinPad
          error={error}
          onSubmit={async (pin) => {
            const ok = await verifyPin(pin);
            if (ok) {
              setError(null);
              unlockStaff();
            } else {
              setError('后台密码不正确');
            }
          }}
        />
      </div>
    </div>
  );
}

function Sidebar({ pendingCount }: { pendingCount: number }) {
  const lockStaff = useApp((s) => s.lockStaff);
  const limited = useApp((s) => s.limitedMode);
  const staffUnlocked = useApp((s) => s.staffUnlocked);
  return (
    <nav className="sidebar">
      <div className="brand">
        <span className="brand-stamp" aria-hidden="true">D</span>
        <span className="brand-text">
          <strong>Doujin POS</strong>
          <small>同人摊位工作台</small>
        </span>
      </div>

      <div className="sidebar-scroll">
        <NavLink to="/" className={({ isActive }) => (isActive ? 'active' : '')} end>
          <span>展会主页</span>
        </NavLink>
        <NavLink
          to="/kiosk"
          className={({ isActive }) => (isActive ? 'active' : '')}
          onClick={(e) => {
            if (!askBeforeKiosk()) e.preventDefault();
          }}
        >
          <span>游客菜单</span>
        </NavLink>
        <NavLink to="/preview" className={({ isActive }) => (isActive ? 'active' : '')}>
          <span>菜单预览</span>
        </NavLink>

        <div className="nav-group">
          <div className="nav-label">经营</div>
          <NavLink to="/staff/pending" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span>待付款</span>
            {pendingCount > 0 ? (
              <span className="nav-badge" aria-label={`${pendingCount} 笔待付款`}>
                {pendingCount}
              </span>
            ) : null}
          </NavLink>
          <NavLink to="/staff/orders" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span>订单</span>
          </NavLink>
          <NavLink to="/staff/inventory" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span>库存</span>
          </NavLink>
        </div>

        <div className="nav-group">
          <div className="nav-label">配置</div>
          <NavLink to="/staff/products" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span>商品</span>
          </NavLink>
          <NavLink to="/staff/events" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span>展会配置</span>
          </NavLink>
          <NavLink to="/staff/promotions" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span>优惠活动</span>
          </NavLink>
        </div>

        <div className="nav-group">
          <div className="nav-label">收摊</div>
          <NavLink to="/staff/reports" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span>报表收摊</span>
          </NavLink>
          <NavLink to="/staff/backup" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span>备份恢复</span>
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span>设置</span>
          </NavLink>
        </div>
      </div>

      <div className="side-bottom">
        <NavLink to="/help" className={({ isActive }) => (isActive ? 'active' : '')}>
          <span>说明书</span>
        </NavLink>
        {limited ? <div className="side-note">受限营业模式</div> : null}
        {staffUnlocked ? (
          <button className="small ghost" onClick={lockStaff}>
            锁定后台
          </button>
        ) : null}
      </div>
    </nav>
  );
}

function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  const isKiosk = location.pathname.startsWith('/kiosk');
  const currentEventId = useApp((s) => s.currentEventId);
  const dataVersion = useApp((s) => s.dataVersion);
  const dbDatasetId = useApp((s) => s.dbStatus?.datasetId ?? null);
  const dbSlot = useApp((s) => s.dbStatus?.slot ?? null);

  const [currentEvent, setCurrentEventData] = useState<BoothEvent | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    // 进入任何游客页面时锁定后台；在游客付款页（/kiosk/order/:id）允许摊主临时输入 PIN 解锁，
    // 但只要返回 /kiosk、/kiosk/cart 或 /kiosk/checkout 就必须重新锁定，防止浏览返回手势绕过鉴权。
    if (isKiosk && !location.pathname.startsWith('/kiosk/order/')) {
      useApp.getState().lockStaff();
    }
  }, [isKiosk, location.pathname]);

  useEffect(() => {
    if (isKiosk) return;
    if (!currentEventId) {
      setCurrentEventData(null);
      setPendingCount(0);
      return;
    }
    let cancelled = false;
    Promise.all([
      getEvent(currentEventId),
      countPendingOrders(currentEventId)
    ])
      .then(([ev, pending]) => {
        if (cancelled) return;
        setCurrentEventData(ev);
        setPendingCount(pending);
      })
      .catch(() => {
        /* 顶栏状态刷新失败不阻塞主页面 */
      });
    return () => {
      cancelled = true;
    };
  }, [currentEventId, isKiosk, location.pathname, dataVersion, dbDatasetId, dbSlot]);

  const statusText =
    currentEvent?.status === 'active'
      ? '营业中'
      : currentEvent?.status === 'closed'
        ? '已收摊'
        : '准备中';

  return (
    <div className={isKiosk ? 'app app-kiosk' : 'app app-backend'}>
      {!isKiosk ? <Sidebar pendingCount={pendingCount} /> : null}
      <div className="main">
        {!isKiosk ? (
          <div className="topbar">
            {currentEvent ? (
              <div className="topbar-event">
                <span className="topbar-event-name">{currentEvent.name}</span>
                {currentEvent.booth_number ? (
                  <span className="topbar-booth-stamp">{currentEvent.booth_number}</span>
                ) : null}
                <span className={`badge ${currentEvent.status === 'active' ? 'ok' : ''}`}>{statusText}</span>
              </div>
            ) : (
              <div className="topbar-event">
                <span className="topbar-event-name">Doujin POS</span>
                <span className="badge warn">未选择展会</span>
              </div>
            )}
            <span className="spacer" />
            <button className="small ghost" onClick={() => confirmEnterKiosk(navigate)}>
              进入游客菜单
            </button>
          </div>
        ) : null}
        <div className={isKiosk ? 'kiosk-route' + (location.pathname === '/kiosk' ? ' kiosk-menu-route' : '') : 'content'}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/kiosk" element={<KioskMenuPage />} />
            <Route path="/kiosk/cart" element={<KioskCartPage />} />
            <Route path="/kiosk/checkout" element={<KioskCheckoutPage />} />
            <Route path="/kiosk/order/:id" element={<KioskOrderPage />} />
            <Route path="/staff/checkout" element={<Navigate to="/staff/pending" replace />} />
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
              path="/staff/promotions"
              element={
                <StaffGuard>
                  <StaffPromotionsPage />
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
            <Route path="/help" element={<HelpPage />} />
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
  if (stage === 'declined-limited') return <DeclinedLimitedScreen />;
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
