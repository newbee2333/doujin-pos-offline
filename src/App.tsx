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
import { ErrorBox, PinPad, SetPinFlow, Spinner } from './ui/components';
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

/** 摊主在「持久化未获批」的确认框里点了取消。
 *
 *  这一屏刻意不复用 BlockedScreen：那边的每一行都在说「你的环境不行」，
 *  而这里环境完全正常，只是刚才那个选择需要重新做一次。把两者混用会让
 *  摊主去查一个根本不存在的浏览器问题。 */
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
        <p className="small muted">
          受限营业只是意味着数据有被系统回收的可能，需要更勤地导出备份。
        </p>
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
      // 判据要和 BlockedScreen 里列的那几行对齐：那边显示了「跨源隔离」和
      // 「Service Worker」，这里就必须真的检查它们，否则卡片会出现
      // 「全部通过」却仍然拒绝启动的自相矛盾画面。
      // OPFS 只有在跨源隔离成立时才谈得上（opfs-sahpool 依赖 SharedArrayBuffer）。
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
          // 这里以前是 setStage('blocked')，会把它和「环境不支持」混为一谈：
          // 摊主明明看到能力检测全绿，却被告知「当前环境不能营业 / 请检查 COOP 头」，
          // 与真实原因（自己刚点了取消）毫无关系。改成独立的一屏，说清发生了什么、
          // 以及怎么回到营业状态。
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
      setStage('error', errorMessage(e));
    }
  }, [setCurrentEvent, setDbStatus, setDiagnostics, setStage]);
}

/** 后台路由保护：未解锁时只显示 PIN 界面，不渲染后台内容。
 *
 *  这一页刻意只做一件事——输 PIN。
 *  它有且只有一条出路：输对 PIN。
 */
function StaffGuard({ children }: { children: React.ReactNode }) {
  const unlocked = useApp((s) => s.staffUnlocked);
  const unlockStaff = useApp((s) => s.unlockStaff);
  const [error, setError] = useState<string | null>(null);
  const [needSetup, setNeedSetup] = useState<boolean | null>(null);

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
          <ErrorBox message={error} />
          {/* 首次设置也走「输两遍」。按错一位当场就能发现，
              比事后靠恢复流程找回来便宜得多。 */}
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

      {/* 三段式：品牌固定 / 导航自己滚 / 底部固定。
          矮屏（1024×768 的横屏 iPad）装不下 12 项导航，如果整条侧栏一起滚，
          「锁定后台」会被推到折叠线以下；改成底部 sticky 又会盖住上面一项。
          拆成独立滚动区之后，两边都不需要将就。 */}
      <div className="sidebar-scroll">
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
        </NavLink>

        {/* 12 项平铺时，分组落点和摆摊节奏对不上：营业中要在「收银/待付款/订单/库存」
            之间反复切，而「商品/展会配置」开摊前调一次就基本不动、却和它们挨在一起。
            现在按 经营 → 配置 → 收摊 三组排，说明书这类参考资料降到侧栏底部。 */}
        <div className="nav-group">
          <div className="nav-label">经营</div>
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
        </div>

        <div className="nav-group">
          <div className="nav-label">配置</div>
          <NavLink to="/staff/products" className={({ isActive }) => (isActive ? 'active' : '')}>
            商品
          </NavLink>
          <NavLink to="/staff/events" className={({ isActive }) => (isActive ? 'active' : '')}>
            展会配置
          </NavLink>
        </div>

        <div className="nav-group">
          <div className="nav-label">收摊</div>
          <NavLink to="/staff/reports" className={({ isActive }) => (isActive ? 'active' : '')}>
            报表收摊
          </NavLink>
          <NavLink to="/staff/backup" className={({ isActive }) => (isActive ? 'active' : '')}>
            备份恢复
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
            设置
          </NavLink>
        </div>
      </div>

      <div className="side-bottom">
        <NavLink to="/help" className={({ isActive }) => (isActive ? 'active' : '')}>
          说明书
        </NavLink>
        {limited ? <div className="side-note">受限营业模式：请频繁导出备份</div> : null}
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

  useEffect(() => {
    // 切后台/回到游客页面时清理会话
    if (isKiosk) useApp.getState().lockStaff();
  }, [isKiosk]);

  return (
    <div className={isKiosk ? 'app app-kiosk' : 'app app-backend'}>
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
            {/* 说明书不加 StaffGuard：锁着也看得。
                忘了 PIN 的人正需要翻它。 */}
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
