import { useEffect, useState } from 'react';
import type { BackupState } from '../services/system';
import { useApp } from '../store';

/** 只在备份与恢复页展示，区分生成导出与用户确认保存。 */
export default function BackupNudge({ state }: { state: BackupState | null }) {
  const limited = useApp((s) => s.limitedMode);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  if (!state) return null;
  const confirmed = state.lastConfirmedSavedAt ? Date.parse(state.lastConfirmedSavedAt) : 0;
  const exported = state.lastExportAt ? Date.parse(state.lastExportAt) : 0;
  let text = '';
  if (exported > confirmed) text = '已生成导出，请在「文件」中核对后点击「我确认已保存」。';
  else if (!confirmed) text = '还未确认保存过备份。请导出数据库，并在「文件」中核对保存结果。';
  else if (now - confirmed >= 24 * 60 * 60 * 1000) text = '距上次确认保存已超过 24 小时，请及时保存当前数据库。';
  else if (now - confirmed >= 2 * 60 * 60 * 1000) text = '距上次确认保存已超过 2 小时，建议保存当前数据库。';
  if (!text) return null;
  return <div className="backup-reminder" role="status"><span aria-hidden="true">●</span><span>{text}{limited ? ' 当前为受限营业模式。' : ''}</span></div>;
}
