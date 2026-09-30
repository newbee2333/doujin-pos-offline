import type { Cell, Worksheet } from 'exceljs';
import type { ReportData, ReportTable } from './report-export';
import { localDate, unitLabel } from './report-format';

const INK = 'FF263448';
const MUTED = 'FF64748B';
const ROSE = 'FFB62C52';
const PALE_ROSE = 'FFFBEAF0';
const PALE = 'FFF4F6F9';
const GREEN = 'FF08765C';
const DATE_FORMAT = 'yyyy-mm-dd hh:mm:ss';
export const DETAIL_HEADER_ROW = 5;

function formatMoney(data: ReportData, unit = false) {
  const digits = data.event.currency === 'CNY' ? '#,##0.00' : '#,##0';
  const suffix = unit ? (data.event.currency === 'CNY' ? '" 元"' : '" 日元"') : '';
  return `${digits}${suffix};[Red]-${digits}${suffix}`;
}

function paint(cell: Cell, { bold = false, color = INK, size = 11, fill, right = false }: {
  bold?: boolean; color?: string; size?: number; fill?: string; right?: boolean;
} = {}) {
  cell.font = { name: '微软雅黑', size, bold, color: { argb: color } };
  cell.alignment = { vertical: 'middle', horizontal: right ? 'right' : 'left', wrapText: true, indent: 1 };
  if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
}

function span(sheet: Worksheet, row: number, from: number, to: number, value: Cell['value'], style: Parameters<typeof paint>[1] = {}) {
  sheet.mergeCells(row, from, row, to);
  const cell = sheet.getCell(row, from);
  cell.value = value;
  paint(cell, style);
  return cell;
}

function lines(text: string, width: number) {
  return text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(
    [...line].reduce((n, char) => n + (char.charCodeAt(0) > 255 ? 2 : 1), 0) / Math.max(1, width - 3)
  )), 0);
}

function timestamp(data: ReportData) {
  return localDate(data.generatedAt.toISOString(), data.event.timezone)!.toISOString().replace('T', ' ').slice(0, 19);
}

function sheetSettings(sheet: Worksheet, lastColumn: string, lastRow: number) {
  // 冻结窗格会在 Excel / WPS 中绘制明显分隔线。导出文件默认从 A1 正常显示。
  sheet.views = [{ state: 'normal', showGridLines: false, zoomScale: 100, activeCell: 'A1' }];
  sheet.pageSetup = {
    orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    printArea: `A1:${lastColumn}${lastRow}`,
    margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 }
  };
  sheet.headerFooter.oddFooter = `&L${sheet.name}&R第 &P 页 / 共 &N 页`;
}

/** 总览为阅读排版，明细表保留可筛选的完整记录。 */
export function layoutOverview(sheet: Worksheet, table: ReportTable, data: ReportData) {
  sheet.columns = [22, 12, 20, 22, 12, 20].map(width => ({ width }));
  sheet.properties.tabColor = { argb: ROSE };
  const metrics = new Map(table.rows.map(row => [String(row[0]), row]));
  const value = (name: string) => metrics.get(name)?.[1] ?? null;
  const note = (row: number, content: string) => {
    span(sheet, row, 1, 6, content, { color: MUTED, size: 10 });
    sheet.getRow(row).height = Math.max(24, lines(content, 108) * 15 + 6);
  };
  const section = (row: number, title: string) => {
    span(sheet, row, 1, 6, title, { bold: true, size: 12, fill: PALE });
    sheet.getRow(row).height = 29;
  };
  const metric = (row: number, start: number, title: string, key = title, money = false, important = false) => {
    span(sheet, row, start, start + 1, title, { color: MUTED });
    const cell = sheet.getCell(row, start + 2);
    cell.value = value(key);
    paint(cell, { right: true, bold: important, color: important ? ROSE : INK, size: important ? 14 : 11 });
    cell.numFmt = money ? formatMoney(data, true) : '#,##0" 单"';
    if (cell.value === null) {
      cell.value = '未盘点';
      paint(cell, { right: true, color: MUTED });
    }
    sheet.getRow(row).height = 29;
    return cell;
  };

  span(sheet, 1, 1, 6, `${data.event.name} · 营业总览`, { size: 20, bold: true });
  sheet.getRow(1).height = Math.max(40, lines(data.event.name, 70) * 26 + 10);
  const period = data.event.start_date || data.event.end_date ? `${data.event.start_date ?? '未设置'} 至 ${data.event.end_date ?? '未设置'}` : '未设置';
  note(2, `展会日期：${period}    摊位：${data.event.booth_number || '未设置'}`);
  note(3, `导出：${timestamp(data)}（${data.event.timezone}）    币种：${unitLabel(data.event.currency)}`);
  sheet.getRow(4).height = 12;
  ['销售额', '退款额', '净销售额'].forEach((title, i) => {
    const start = i * 2 + 1;
    span(sheet, 5, start, start + 1, title, { bold: true, color: i === 2 ? GREEN : MUTED, fill: i === 2 ? 'FFEAF5F0' : PALE });
    const cell = span(sheet, 6, start, start + 1, value(title), { size: 22, bold: true, color: i === 2 ? GREEN : INK, fill: i === 2 ? 'FFEAF5F0' : PALE });
    cell.numFmt = formatMoney(data, true);
  });
  sheet.getRow(5).height = 27;
  sheet.getRow(6).height = 42;
  note(7, '净销售额＝销售额－退款额，未扣成本。销售额包含已退款订单的原销售；待付款、取消及纠错不计入。');
  sheet.getRow(8).height = 10;
  section(9, '订单与件数');
  metric(10, 1, '已成交订单', '已成交');
  metric(10, 4, '待付款订单', '待付款');
  metric(11, 1, '已退款订单', '已退款');
  metric(11, 4, '已取消订单', '已取消');
  metric(12, 1, '已纠错订单', '已纠错');
  const sold = metric(12, 4, '原销售件数', '销售件数');
  sold.numFmt = '#,##0" 件"';
  metric(13, 1, '纠错金额', '纠错金额', true);
  const gifts = metric(13, 4, '赠品发放');
  gifts.numFmt = '#,##0" 件"';
  note(14, '件数含已退款订单的原件数，套装按套计。纠错为误记撤销，金额单列。');
  sheet.getRow(15).height = 10;
  section(16, '钱箱与盘点');
  metric(17, 1, '开场备用金', '开场备用金', true);
  metric(17, 4, '现金存入', '现金存入', true);
  metric(18, 1, '有效现金收款', '有效现金收款', true);
  metric(18, 4, '现金取出', '现金取出', true);
  metric(19, 1, '实际现金退款', '实际现金退款', true);
  metric(19, 4, '最近盘点现金', '最近盘点现金', true);
  metric(20, 1, '理论钱箱', '理论钱箱', true, true);
  const difference = metric(20, 4, '最近结算差额', '最近结算差额', true, true);
  if (value('最近结算差额') === null) difference.value = '未结算';
  note(21, '理论钱箱＝备用金＋现金收款－现金退款＋存入－取出。结算差额：正数多款，负数少款。');
  const settled = value('最近结算时间');
  note(22, settled instanceof Date ? `最近结算：${settled.toISOString().replace('T', ' ').slice(0, 19)}（${data.event.timezone}）。结算后如继续记账，盘点值可能与当前钱箱不同。` : '尚未保存结算，盘点值留空不表示零。');
  sheet.getRow(23).height = 10;
  section(24, '商品销售前五名');
  span(sheet, 25, 1, 3, '商品 / 规格', { bold: true, fill: PALE_ROSE });
  sheet.getCell('D25').value = '原销售件数';
  paint(sheet.getCell('D25'), { bold: true, fill: PALE_ROSE, right: true });
  span(sheet, 25, 5, 6, `原销售额（${unitLabel(data.event.currency)}）`, { bold: true, fill: PALE_ROSE, right: true });
  sheet.getRow(25).height = 28;
  const products = data.tables.find(t => t.name === '商品销售')!.rows.slice(0, 5);
  products.forEach((r, i) => {
    const row = i + 26;
    const name = `${r[0]}${r[1] ? ` / ${r[1]}` : ''}`;
    const fill = i % 2 === 0 ? PALE : undefined;
    span(sheet, row, 1, 3, name, { fill });
    sheet.getCell(row, 4).value = r[3];
    paint(sheet.getCell(row, 4), { right: true, fill });
    sheet.getCell(row, 4).numFmt = '#,##0';
    const amount = span(sheet, row, 5, 6, r[4], { right: true, fill });
    amount.numFmt = formatMoney(data);
    sheet.getRow(row).height = Math.max(30, lines(name, 54) * 17 + 8);
  });
  const end = 26 + Math.max(1, products.length);
  if (!products.length) note(26, '本场暂无销售记录');
  note(end, '按原销售额排序，含已退款原销售，不扣退货；全部商品见「商品销售」。');
  note(end + 1, '收款、订单及库存请查看对应工作表。完整备份使用 SQLite。');
  sheetSettings(sheet, 'F', end + 1);
}

export function layoutDetailSheet(sheet: Worksheet, table: ReportTable, data: ReportData) {
  const n = table.columns.length;
  sheet.columns = table.columns.map(c => ({ width: c.width }));
  span(sheet, 1, 1, n, `${data.event.name} · ${table.name}`, { size: 18, bold: true });
  sheet.getRow(1).height = 36;
  span(sheet, 2, 1, n, `导出：${timestamp(data)}（${data.event.timezone}）    金额：${unitLabel(data.event.currency)}    摊位：${data.event.booth_number || '未设置'}`, { color: MUTED, size: 10 });
  sheet.getRow(2).height = 24;
  span(sheet, 3, 1, n, table.note, { color: MUTED, size: 10 });
  sheet.getRow(3).height = Math.max(24, lines(table.note, table.columns.reduce((sum, c) => sum + c.width, 0)) * 15 + 6);
  sheet.getRow(4).height = 10;
  const header = sheet.getRow(DETAIL_HEADER_ROW);
  header.values = table.columns.map(c => c.title);
  header.height = 32;
  header.eachCell(cell => {
    paint(cell, { bold: true, color: ROSE, fill: PALE_ROSE });
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  table.rows.forEach((values, i) => {
    const row = sheet.getRow(i + DETAIL_HEADER_ROW + 1);
    row.values = values; // 直接赋值保证 = / + 开头的商品名仍为文本。
    row.height = Math.min(409, Math.max(29, Math.max(...values.map((v, j) => typeof v === 'string' ? lines(v, table.columns[j].width) : 1)) * 17 + 8));
    table.columns.forEach((column, j) => {
      const cell = row.getCell(j + 1);
      const value = values[j];
      paint(cell, { right: typeof value === 'number', fill: i % 2 === 0 ? PALE : undefined });
      cell.numFmt = value instanceof Date ? DATE_FORMAT : column.kind === 'money' ? formatMoney(data) : column.kind === 'number' ? '#,##0;[Red]-#,##0' : '@';
      // 导出为固定营业快照，状态颜色只辅助阅读，不替代文字。
      if (/状态/.test(column.title)) {
        const color = value === '待付款' ? 'FFA46416' : value === '已成交' ? GREEN : MUTED;
        paint(cell, { color, bold: value === '待付款', fill: i % 2 === 0 ? PALE : undefined });
      }
    });
  });
  if (!table.rows.length) {
    span(sheet, DETAIL_HEADER_ROW + 1, 1, n, '本场暂无记录', { color: MUTED });
    sheet.getRow(DETAIL_HEADER_ROW + 1).height = 29;
  } else {
    sheet.autoFilter = { from: { row: DETAIL_HEADER_ROW, column: 1 }, to: { row: DETAIL_HEADER_ROW + table.rows.length, column: n } };
  }
  sheetSettings(sheet, sheet.getColumn(n).letter, DETAIL_HEADER_ROW + Math.max(1, table.rows.length));
  sheet.pageSetup.printTitlesRow = `1:${DETAIL_HEADER_ROW}`;
}
