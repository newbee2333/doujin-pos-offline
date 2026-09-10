import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getBackupState } from '../services/system';
import { useApp } from '../store';

const REMIND_MS = 2 * 60 * 60 * 1000;
const CHECK_MS = 10 * 60 * 1000;

/**
 * 营业中的备份提醒（第 24 节）。
 *
 * 非打断：只显示一条可关闭的横幅，不用弹窗；游客付款过程中不显示
 * （调用方保证只在非 /kiosk 路由渲染）。
 */
export default function BackupNudge() {
  const navigate = useNavigate();
  const limited = useApp((s) => s.limitedMode);
  const [due, setDue] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const st = await getBackupState();
        if (cancelled) return;
        const ref = st.lastConfirmedSavedAt ?? st.lastExportAt;
        setDue(!ref || Date.now() - new Date(ref).getTime() > REMIND_MS);
      } catch {
        /* 读不到就当作需要提醒 */
        if (!cancelled) setDue(true);
      }
    };
    void check();
    const t = setInterval(check, CHECK_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (!due || dismissed) return null;

  return (
    <div
      className="notice"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        margin: '10px 18px 0',
        flexWrap: 'wrap'
      }}
    >
      <span style={{ flex: 1 }}>
        {limited
          ? '受限营业模式下数据被回收的风险更高，距上次备份已超过 2 小时，建议现在导出一份。'
          : '距上次备份已超过 2 小时，建议现在导出完整数据库。'}
      </span>
      <button className="small primary" onClick={() => navigate('/staff/backup')}>
        立即导出
      </button>
      <button className="small ghost" onClick={() => setDismissed(true)}>
        稍后
      </button>
    </div>
  );
}
