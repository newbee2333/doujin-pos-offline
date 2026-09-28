import type { Workbook, Worksheet } from 'exceljs';
import type { Event } from '../domain/types';
import { ex } from './context';
import { getEvent } from './events';
import { getDashboard, getExpectedCash, getPaymentSummary, getProductRanking, listCashMovements, listSettlements } from './reports';
import { label, localDate, majorAmount, reportFilename, STATUS_LABEL, unitLabel } from './report-format';

type Value = string | number | Date | null;
type Kind = 'text' | 'number' | 'money' | 'date';
interface Column { title: string; width: number; kind?: Kind }
export interface ReportTable { name: string; note: string; columns: Column[]; rows: Value[][] }
export interface ReportData { event: Event; generatedAt: Date; revision: string; tables: ReportTable[] }
type Row = Record<string, string | number | null>;
const text = (value: unknown) => String(value ?? '');
const col = (title: string, width = 22, kind: Kind = 'text'): Column => ({ title, width, kind });

/** 不同查询之间若发生写入，拒绝生成不一致的跨工作表报表。 */
export async function collectReport(eventId: string): Promise<ReportData> {
  const revision = async () => text((await ex().readOne<{ value: string }>("SELECT value FROM metadata WHERE key='revision'"))?.value);
  const before = await revision();
  const event = await getEvent(eventId);
  if (!event) throw new Error('展会不存在');
  const [dashboard, cash, ranking, payments, movements, settlements, orders, items, inventory, transactions] = await Promise.all([
    getDashboard(eventId), getExpectedCash(eventId), getProductRanking(eventId), getPaymentSummary(eventId),
    listCashMovements(eventId), listSettlements(eventId),
    ex().read<Row>(`SELECT o.*, p.method_name_snapshot, p.amount_minor AS paid_minor,
      r.amount_minor AS refund_minor, r.reason AS refund_reason, oc.reason AS correction_reason
      FROM orders o LEFT JOIN payments p ON p.order_id=o.id
      LEFT JOIN refunds r ON r.order_id=o.id LEFT JOIN order_corrections oc ON oc.order_id=o.id
      WHERE o.event_id=? ORDER BY o.human_readable_number`, [eventId]),
    ex().read<Row>(`SELECT o.human_readable_number, o.status, oi.* FROM order_items oi
      JOIN orders o ON o.id=oi.order_id WHERE o.event_id=? ORDER BY o.human_readable_number, oi.rowid`, [eventId]),
    ex().read<Row>(`SELECT p.name AS product_name, v.name AS variant_name, v.sku, i.* FROM inventory i
      JOIN product_variants v ON v.id=i.variant_id JOIN products p ON p.id=v.product_id
      WHERE i.event_id=? ORDER BY p.name,v.name`, [eventId]),
    ex().read<Row>(`SELECT t.*, p.name AS product_name, v.name AS variant_name, o.human_readable_number
      FROM inventory_transactions t JOIN product_variants v ON v.id=t.variant_id
      JOIN products p ON p.id=v.product_id LEFT JOIN orders o ON o.id=t.order_id
      WHERE t.event_id=? ORDER BY t.created_at,t.rowid`, [eventId])
  ]);
  if (before !== await revision()) throw new Error('导出期间数据发生变化，请等待当前操作完成后重新导出');
  const generatedAt = new Date();
  const money = (value: unknown) => majorAmount(Number(value ?? 0), event.currency);
  const date = (value: unknown) => localDate(value, event.timezone);
  const unit = unitLabel(event.currency);
  const moneyCol = (title: string) => col(`${title}（${unit}）`, 22, 'money');
  const currentSettlement = settlements.find(s => !s.superseded);
  const overview: ReportTable = {
    name: '营业总览', note: '金额为导出时的营业快照，不是利润。明细与总览使用相同统计口径。',
    columns: [col('指标', 28), col('数值', 25, 'number'), col('单位', 18), col('说明', 76)],
    rows: [
      ['销售额', money(dashboard.salesMinor), unit, '含之后已退款的原销售；不含待付款、取消、纠错订单'],
      ['退款额', money(dashboard.refundMinor), unit, '实际退款金额'],
      ['净销售额', money(dashboard.netSalesMinor), unit, '销售额减退款额，未扣成本'],
      ['纠错金额', money(dashboard.correctionMinor), unit, '误记撤销，独立列示，不计销售额或退款额'],
      ['销售件数', dashboard.unitsSold, '件', '不含赠品；含已退款订单原件数，套装按套计'],
      ['赠品发放', dashboard.giftUnits, '件', '含已退款订单原发放件数'],
      ...Object.entries(dashboard.counts).map(([status, count]): Value[] => [label(status, STATUS_LABEL), count, '单', '导出时订单状态']),
      ['开场备用金', money(cash.openingMinor), unit, ''],
      ['有效现金收款', money(cash.cashSalesMinor), unit, '含已退款订单原收款，不含纠错订单'],
      ['实际现金退款', money(cash.cashRefundMinor), unit, ''],
      ['现金存入', money(cash.depositMinor), unit, '加入钱箱的现金'],
      ['现金取出', money(cash.withdrawalMinor), unit, '从钱箱取走的现金'],
      ['理论钱箱', money(cash.expectedMinor), unit, '备用金＋有效现金收款－现金退款＋存入－取出'],
      ['最近盘点现金', currentSettlement ? money(currentSettlement.actual_cash_minor) : null, unit, currentSettlement ? '最近一次保存结算的盘点值' : '尚未保存结算，留空不表示零'],
      ['最近结算差额', currentSettlement ? money(currentSettlement.difference_minor) : null, unit, '相对该次结算的理论现金，正数为多款、负数为少款'],
      ['最近结算时间', currentSettlement ? date(currentSettlement.settled_at) : null, event.timezone, '结算后如继续记账，盘点值可能与当前理论钱箱不同']
    ]
  };
  return { event, generatedAt, revision: before, tables: [
    overview,
    { name: '商品销售', note: '含已退款订单的原销售，不扣退货；套装收入计在套装上，赠品金额为零。',
      columns: [col('商品', 38), col('规格', 28), col('SKU', 22), col('销售件数', 16, 'number'), moneyCol('销售额'), col('含退款订单数', 20, 'number')],
      rows: ranking.map(r => [r.product_name, r.variant_name, r.sku, r.units, money(r.amount_minor), r.refund_order_count]) },
    { name: '收款汇总', note: '有效收款含退款订单的原收款；退款单独扣除；纠错订单不计入。',
      columns: [col('收款方式'), col('方式类型'), moneyCol('有效收款'), moneyCol('实际退款'), moneyCol('净流入'), col('收款单数', 16, 'number')],
      rows: payments.map(r => [r.method_name, label(r.method_type), money(r.received_minor), money(r.refunded_minor), money(r.net_minor), r.order_count]) },
    { name: '订单', note: '包含全部状态；订单金额不能直接求和当销售额。有效销售额仅含成交及退款订单的原销售。',
      columns: [col('订单号', 14, 'number'), col('状态', 15), moneyCol('订单金额'), moneyCol('有效销售额'), moneyCol('退款额'), col('收款方式'), col('来源', 18), col('创建时间', 24, 'date'), col('成交时间', 24, 'date'), col('退款原因', 35), col('纠错原因', 35)],
      rows: orders.map(r => [Number(r.human_readable_number), label(r.status, STATUS_LABEL), money(r.total_minor), ['completed','refunded'].includes(text(r.status)) ? money(r.total_minor) : 0, money(r.refund_minor), text(r.method_name_snapshot), label(r.source), date(r.created_at), date(r.completed_at), text(r.refund_reason), text(r.correction_reason)]) },
    { name: '订单明细', note: '商品名、规格、价格保留成交时快照。包括待付款、取消及纠错明细，汇总前请筛选订单状态。',
      columns: [col('订单号', 14, 'number'), col('订单状态', 16), col('商品', 38), col('规格', 28), col('SKU', 22), col('商品类型', 18), moneyCol('单价'), col('数量', 14, 'number'), moneyCol('小计')],
      rows: items.map(r => [Number(r.human_readable_number), label(r.status, STATUS_LABEL), text(r.product_name_snapshot), text(r.variant_name_snapshot), text(r.sku_snapshot), label(r.product_type_snapshot), money(r.unit_price_minor), Number(r.quantity), money(r.subtotal_minor)]) },
    { name: '库存', note: '可售库存＝实物库存－待付款预留。套装共用成分库存，不应把套装当作额外实物库存相加。',
      columns: [col('商品', 38), col('规格', 28), col('SKU', 22), col('初始入库', 16, 'number'), col('实物库存', 16, 'number'), col('待付款预留', 18, 'number'), col('可售库存', 16, 'number')],
      rows: inventory.map(r => [text(r.product_name), text(r.variant_name), text(r.sku), Number(r.initial_stock), Number(r.physical_stock), Number(r.reserved_stock), Number(r.physical_stock) - Number(r.reserved_stock)]) },
    { name: '库存流水', note: '增减是有符号数：正数增加，负数减少；释放预留不代表实物出库。',
      columns: [col('时间', 24, 'date'), col('变动类型', 20), col('商品', 38), col('规格', 28), col('实物增减', 16, 'number'), col('预留增减', 16, 'number'), col('原因', 42), col('订单号', 14, 'number')],
      rows: transactions.map(r => [date(r.created_at), label(r.type), text(r.product_name), text(r.variant_name), Number(r.delta_physical), Number(r.delta_reserved), text(r.reason), r.human_readable_number === null ? null : Number(r.human_readable_number)]) },
    { name: '现金流水', note: '备用金、存入和取出记录。销售收款与退款请看收款汇总。',
      columns: [col('时间', 24, 'date'), col('类型', 22), moneyCol('金额'), col('备注', 60)],
      rows: movements.map(r => [date(r.created_at), label(r.type), money(r.amount_minor), r.reason]) }
  ] };
}

function styleSheet(sheet: Worksheet, table: ReportTable, data: ReportData) {
  const n = table.columns.length;
  sheet.columns = table.columns.map(c => ({ width: c.width }));
  sheet.mergeCells(1, 1, 1, n);
  sheet.getCell(1, 1).value = `${data.event.name} · ${table.name}`;
  sheet.getCell(1, 1).font = { name: '微软雅黑', size: 20, bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF263448' } };
  sheet.getCell(1, 1).alignment = { vertical: 'middle', wrapText: true };
  sheet.getRow(1).height = 52;
  sheet.mergeCells(2, 1, 2, n);
  sheet.getCell(2, 1).value = `展会：${data.event.start_date ?? '未设置'} 至 ${data.event.end_date ?? '未设置'}　摊位：${data.event.booth_number || '未设置'}　金额：${unitLabel(data.event.currency)}（${data.event.currency}）　时间：${data.event.timezone}`;
  sheet.getRow(2).height = 36;
  sheet.mergeCells(3, 1, 3, n);
  sheet.getCell(3, 1).value = table.note;
  sheet.getRow(3).height = 38;
  sheet.mergeCells(4, 1, 4, n);
  sheet.getCell(4, 1).value = `导出时间：${localDate(data.generatedAt.toISOString(), data.event.timezone)!.toISOString().replace('T', ' ').slice(0, 19)}　数据修订：${data.revision}　报表用于阅读与分析，完整恢复请使用 SQLite 备份。`;
  sheet.getRow(4).height = 32;
  for (const i of [2, 3, 4]) {
    sheet.getCell(i, 1).font = { name: '微软雅黑', size: 11, color: { argb: 'FF526176' } };
    sheet.getCell(i, 1).alignment = { wrapText: true, vertical: 'middle' };
  }
  sheet.getRow(6).values = table.columns.map(c => c.title);
  sheet.getRow(6).height = 34;
  sheet.getRow(6).eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD23760' } };
    cell.font = { name: '微软雅黑', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  const moneyFormat = data.event.currency === 'CNY' ? '#,##0.00;[Red]-#,##0.00' : '#,##0;[Red]-#,##0';
  table.rows.forEach((values, i) => {
    const row = sheet.getRow(i + 7);
    row.values = values; // Text is never interpreted as a formula or hyperlink.
    const lines = values.map((value, j) => typeof value === 'string'
      ? value.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(
        [...line].reduce((width, char) => width + (char.charCodeAt(0) > 255 ? 2 : 1), 0) / Math.max(1, table.columns[j].width - 3)
      )), 0) : 1);
    row.height = Math.min(409, Math.max(38, Math.max(...lines) * 17 + 10));
    table.columns.forEach((column, j) => {
      const cell = row.getCell(j + 1);
      const value = values[j];
      cell.font = { name: '微软雅黑', size: 11, color: { argb: 'FF263448' } };
      cell.alignment = { wrapText: true, vertical: 'middle', horizontal: typeof value === 'number' ? 'right' : 'left' };
      if (i % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F5F9' } };
      cell.numFmt = value instanceof Date ? 'yyyy-mm-dd hh:mm:ss' : column.kind === 'money' ? moneyFormat : column.kind === 'number' ? '#,##0;[Red]-#,##0' : '@';
      if (table.name === '营业总览' && j === 1 && values[2] === unitLabel(data.event.currency)) cell.numFmt = moneyFormat;
    });
  });
  if (table.rows.length === 0) {
    sheet.mergeCells(7, 1, 7, n);
    sheet.getCell(7, 1).value = '本场暂无记录';
    sheet.getRow(7).height = 30;
  } else {
    sheet.autoFilter = { from: { row: 6, column: 1 }, to: { row: 6 + table.rows.length, column: n } };
  }
  sheet.views = [{ state: 'frozen', ySplit: 6, xSplit: 1, showGridLines: false }];
  sheet.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:6' };
  sheet.headerFooter.oddFooter = '&L' + table.name + '&R第 &P 页 / 共 &N 页';
}

export async function createReportWorkbook(data: ReportData): Promise<Workbook> {
  // Vite 将其打成独立分块；PWA 预缓存也包含该分块，断网可以首次导出。
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  book.creator = 'Doujin POS';
  book.created = data.generatedAt;
  for (const table of data.tables) {
    if (table.rows.length > 1048570) throw new Error('报表超过 Excel 行数限制，请使用 CSV 导出');
    styleSheet(book.addWorksheet(table.name), table, data);
  }
  return book;
}

export async function exportEventWorkbook(eventId: string) {
  const data = await collectReport(eventId);
  const book = await createReportWorkbook(data);
  const bytes = new Uint8Array(await book.xlsx.writeBuffer());
  return { bytes, filename: reportFilename(data.event.name, '营业报表', 'xlsx', data.generatedAt) };
}
