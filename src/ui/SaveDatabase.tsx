/**
 * 「先保存当前数据库」这一块。
 *
 * 用在所有会**整库替换**的地方：顶部那张「保存当前数据库」卡、从文件恢复、
 * 新建空数据库的确认面板、导入的确认替换面板 —— 一份实现四个入口，
 * 免得哪天只改了其中一处。
 *
 * 按钮默认文案是「保存当前数据库」，但顶部那张卡传进来的是「导出 SQLite」：
 * 几个验收脚本和 CI 按这个文案取按钮，不能改。
 *
 * 导出与「我确认已保存」刻意分成两步：浏览器发起下载 ≠ 文件真的落盘。
 * 只有用户自己在平板的「文件」里看到过才算数，这一步写的是
 * `backup.last_confirmed_saved_at` —— 而「新建空数据库」的提醒强度正是拿它判的。
 * 所以两步都不能省，也不能合并成一步。
 */
import { useState } from 'react';
import { exportDatabase, getBackupState, markConfirmedSaved, shareBytes, suggestFileName } from '../services/system';
import { formatBytes } from '../domain/image';
import { errorMessage, useApp } from '../store';
import { ErrorBox, useAsync } from './components';

export default function SaveDatabase({
  eventName,
  label = '保存当前数据库',
  reloadKey,
  onSaved
}: {
  /** 用来拼导出文件名。没有就退回默认名。 */
  eventName?: string;
  label?: string;
  /**
   * 父级的备份状态。同一页上可能挂着两三份这个组件，用户在**另**一份里点了
   * 「我确认已保存」时，自己那一份的提示还是旧的 —— 把父级的
   * `lastConfirmedSavedAt` 传进来当依赖，它一变这边就重新拉一次。
   */
  reloadKey?: unknown;
  /** 确认保存之后回调：调用方据此刷新自己的备份状态、放行后面那个破坏性按钮。 */
  onSaved?: () => void;
}) {
  const showToast = useApp((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [file, setFile] = useState('');
  const state = useAsync(() => getBackupState(), [reloadKey]);

  async function doExport() {
    setBusy(true);
    setError(null);
    try {
      const name = suggestFileName(eventName);
      const { bytes: out, mode } = await exportDatabase(name);
      setBytes(out);
      setFile(name);
      showToast(mode === 'picker' ? '已保存到你选择的位置' : '已发起下载，请到「文件」里确认');
      // 「最近生成导出」那一行要跟着动，否则用户会以为没导出来
      state.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function doShare() {
    if (!bytes) return;
    if (await shareBytes(bytes, file)) showToast('已调用系统分享');
    else showToast('当前浏览器不支持文件分享，请用导出保存到「文件」');
  }

  async function doConfirm() {
    setBusy(true);
    setError(null);
    try {
      await markConfirmedSaved();
      showToast('已确认保存');
      state.reload();
      onSaved?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="save-db">
      <div className="row">
        <button type="button" className="primary" onClick={doExport} disabled={busy}>
          {busy ? <span className="spinner" /> : null}
          {label}
        </button>
        {bytes ? (
          <>
            <button type="button" onClick={doShare} disabled={busy}>
              分享 / 保存到文件
            </button>
            <button type="button" onClick={doConfirm} disabled={busy}>
              我确认已保存
            </button>
          </>
        ) : null}
      </div>

      <p className="tiny muted" style={{ marginTop: 'var(--sp-2)', marginBottom: 0 }}>
        {bytes
          ? `已生成 ${file}（${formatBytes(bytes.length)}）。浏览器发起下载不等于文件一定落盘成功，请在平板的「文件」里确认后再点「我确认已保存」。`
          : state.data?.lastConfirmedSavedAt
            ? `最近确认保存：${new Date(state.data.lastConfirmedSavedAt).toLocaleString('zh-CN')}。`
            : '这台设备还没有确认保存过备份。'}
      </p>

      <ErrorBox message={error} />
    </div>
  );
}
