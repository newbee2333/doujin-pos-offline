import { useState } from 'react';
import { exportInventoryCsv, exportInventoryTransactionsCsv, exportOrderItemsCsv, exportOrdersCsv, exportPaymentSummaryCsv, exportProductSalesCsv } from '../services/reports';
import { reportFilename } from '../services/report-format';
import { errorMessage } from '../store';
import { ErrorBox } from './components';

const CSV_OPTIONS = [
  { name: '订单', description: '每单的状态、金额和付款方式', export: exportOrdersCsv },
  { name: '订单明细', description: '每单购买了哪些商品及数量', export: exportOrderItemsCsv },
  { name: '库存', description: '当前实物、预留和可售数量', export: exportInventoryCsv },
  { name: '库存流水', description: '每次库存变化及对应订单', export: exportInventoryTransactionsCsv },
  { name: '商品销售汇总', description: '各商品的销售数量与金额', export: exportProductSalesCsv },
  { name: '付款汇总', description: '各付款方式的收款、退款和净流入', export: exportPaymentSummaryCsv }
];

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export default function ReportExport({ eventId, eventName }: { eventId: string; eventName: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedName, setSavedName] = useState('');
  const [csvIndex, setCsvIndex] = useState(0);

  async function run(kind: 'xlsx' | 'csv') {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSavedName('');
    try {
      let filename: string;
      let blob: Blob;
      if (kind === 'xlsx') {
        const { exportEventWorkbook } = await import('../services/report-export');
        const result = await exportEventWorkbook(eventId);
        filename = result.filename;
        blob = new Blob([result.bytes.buffer as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      } else {
        const option = CSV_OPTIONS[csvIndex];
        filename = reportFilename(eventName, option.name, 'csv');
        blob = new Blob([await option.export(eventId)], { type: 'text/csv;charset=utf-8' });
      }
      download(filename, blob);
      setSavedName(filename);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return <section className="card" aria-labelledby="report-export-title">
    <h2 id="report-export-title">导出营业报表</h2>
    <p className="small muted">一个 Excel 文件，先看营业总览，再按工作表查看商品、收款、订单和库存。金额使用元／日元，时间按展会时区显示。</p>
    <button className="primary" disabled={busy} onClick={() => void run('xlsx')}>
      {busy ? '正在生成报表…' : '导出 Excel 营业报表'}
    </button>
    <p className="tiny muted">含 8 张工作表，可用 Excel、Numbers 或 WPS 打开。无需联网。</p>
    {savedName ? <p className="small" role="status">已发起下载：{savedName}。请在下载列表或「文件」中确认保存。</p> : null}
    <ErrorBox message={error} />
    <details style={{ marginTop: 'var(--sp-3)' }}>
      <summary>更多导出：原始 CSV</summary>
      <p className="small muted">供已有分析工具使用，保留原字段和英文状态。金额单位为分（CNY）或日元（JPY）；直接阅读推荐使用上面的 Excel 报表。</p>
      <label className="field">
        <span>选择 CSV 内容</span>
        <select value={csvIndex} disabled={busy} onChange={e => setCsvIndex(Number(e.target.value))}>
          {CSV_OPTIONS.map((o, i) => <option key={o.name} value={i}>{o.name} — {o.description}</option>)}
        </select>
      </label>
      <button className="small" disabled={busy} onClick={() => void run('csv')}>导出所选 CSV</button>
    </details>
    <p className="tiny muted" style={{ marginTop: 'var(--sp-3)' }}>报表用于阅读与分析，不能恢复营业数据。完整备份请到「备份恢复」导出 SQLite。</p>
  </section>;
}
