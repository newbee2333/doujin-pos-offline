import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { createTestDatabase, type TestDatabase } from '../../db/test-executor';
import { bindExecutor } from '../context';
import { collectReport, createReportWorkbook, exportEventWorkbook } from '../report-export';
import { localDate, reportFilename } from '../report-format';
import { createEvent, listPaymentMethods, updatePaymentMethod, setEventPaymentMethods, addVariantsToEvent, updateConfig, activateEvent } from '../events';
import { createProduct, listCategories } from '../catalog';
import { initializeStock } from '../inventory';
import { staffDirectSale, recordRefund, correctOrder, createPendingOrder, voidOrder } from '../orders';
import { addCashMovement } from '../reports';
import type { Currency } from '../../domain/types';

let tdb: TestDatabase;
beforeEach(async () => { tdb = await createTestDatabase(); bindExecutor(tdb.executor); });
afterEach(() => { vi.restoreAllMocks(); tdb.close(); });

async function setup(currency: Currency) {
  const eventId = await createEvent({ name: '测试展/九月', currency, timezone: 'Asia/Tokyo' });
  const cash = (await listPaymentMethods()).find(m => m.type === 'cash')!;
  await updatePaymentMethod(cash.id, { enabled: true });
  await setEventPaymentMethods(eventId, [cash.id]);
  const category = (await listCategories())[0];
  const { variantId } = await createProduct({ name: '=SUM(1,2)\n长商品名', type: 'normal', category_id: category.id, default_currency: currency, default_price_minor: 12345 });
  await addVariantsToEvent(eventId, [variantId]);
  await updateConfig(eventId, variantId, { event_price_minor: 12345 });
  await initializeStock(eventId, variantId, 20);
  await activateEvent(eventId);
  return { eventId, variantId, cashId: cash.id };
}

describe('营业报表 Excel', () => {
  it('收款方式改名后仍保留历史收款和退款', async () => {
    const { eventId, variantId, cashId } = await setup('CNY');
    const oldName = (await listPaymentMethods()).find(m => m.id === cashId)!.name;
    const sale = await staffDirectSale({ eventId, lines: [{ variantId, quantity: 1 }], paymentMethodId: cashId, tenderedMinor: 12345 });
    await updatePaymentMethod(cashId, { name: '改名后的现金' });
    await recordRefund({ orderId: sale.orderId, paymentMethodId: cashId, reason: '退款', returns: { [variantId]: 1 } });
    const data = await collectReport(eventId);
    const payments = data.tables.find(t => t.name === '收款汇总')!.rows;
    expect(payments.find(r => r[0] === oldName)!.slice(2)).toEqual([123.45, 0, 123.45, 1]);
    expect(payments.find(r => r[0] === '改名后的现金')!.slice(2)).toEqual([0, 123.45, -123.45, 0]);
  });

  it.each(['CNY', 'JPY'] as const)('%s：快照金额、状态、负数、文本安全及保存后读回', async currency => {
    const { eventId, variantId, cashId } = await setup(currency);
    const sale = () => staffDirectSale({ eventId, lines: [{ variantId, quantity: 1 }], paymentMethodId: cashId, tenderedMinor: 12345 });
    await sale();
    const refund = await sale();
    await recordRefund({ orderId: refund.orderId, paymentMethodId: cashId, reason: '退款', returns: { [variantId]: 1 } });
    const corrected = await sale();
    await correctOrder({ orderId: corrected.orderId, reason: '误记', returns: { [variantId]: 1 } });
    await createPendingOrder({ eventId, lines: [{ variantId, quantity: 1 }], plannedPaymentMethodId: cashId });
    const cancelled = await createPendingOrder({ eventId, lines: [{ variantId, quantity: 1 }], plannedPaymentMethodId: cashId });
    await voidOrder(cancelled.orderId, '取消');
    await addCashMovement(eventId, 'withdrawal', 4 * 12345, '取款');
    const data = await collectReport(eventId);
    const factor = currency === 'CNY' ? 100 : 1;
    const rows = data.tables[0].rows;
    const get = (name: string) => rows.find(r => r[0] === name)![1];
    expect(get('销售额')).toBe(24690 / factor);
    expect(get('净销售额')).toBe(12345 / factor);
    expect(get('退款额')).toBe(12345 / factor);
    expect(get('纠错金额')).toBe(12345 / factor);
    expect(get('理论钱箱')).toBe(-37035 / factor);
    expect(get('最近盘点现金')).toBeNull();
    expect(data.tables.find(t => t.name === '库存')!.rows[0].slice(3)).toEqual([20, 19, 1, 18]);
    const workbook = await createReportWorkbook(data);
    const encoded = await workbook.xlsx.writeBuffer();
    const readBack = new ExcelJS.Workbook();
    await readBack.xlsx.load(encoded);
    expect(readBack.worksheets.map(s => s.name)).toEqual(['营业总览','商品销售','收款汇总','订单','订单明细','库存','库存流水','现金流水']);
    expect(readBack.getWorksheet('营业总览')!.getCell('B7').value).toBe(24690 / factor);
    expect(readBack.getWorksheet('营业总览')!.getCell('B7').numFmt).toContain(currency === 'CNY' ? '#,##0.00' : '#,##0');
    const items = readBack.getWorksheet('订单明细')!;
    expect(items.getCell('C7').value).toBe('=SUM(1,2)\n长商品名');
    expect(items.getCell('C7').type).toBe(ExcelJS.ValueType.String);
    expect(items.getCell('G7').value).toBe(12345 / factor);
    expect(items.views[0]).toMatchObject({ state: 'frozen', ySplit: 6, xSplit: 1 });
    expect(items.autoFilter).toBeTruthy();
    const orders = readBack.getWorksheet('订单')!;
    expect(orders.getCell('B7').value).toBe('已成交');
    expect(orders.getCell('B8').value).toBe('已退款');
    expect(orders.getCell('B9').value).toBe('已纠错');
    expect(orders.getCell('D9').value).toBe(0);
    expect(orders.getCell('H7').value).toBeInstanceOf(Date);
    for (const sheet of readBack.worksheets) sheet.eachRow(row => row.eachCell(cell => expect(cell.type).not.toBe(ExcelJS.ValueType.Formula)));
  });

  it('空展会仍有说明和表头，未盘点不填零', async () => {
    const eventId = await createEvent({ name: '空展会', currency: 'CNY' });
    const { bytes, filename } = await exportEventWorkbook(eventId);
    expect(filename).toMatch(/^空展会-营业报表-.*\.xlsx$/);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    expect(book.getWorksheet('商品销售')!.getCell('A7').value).toBe('本场暂无记录');
    expect(book.getWorksheet('营业总览')!.getCell('B7').value).toBe(0);
  });

  it('时间按展会时区转换，文本标识不会被当成金额', () => {
    expect(localDate('2026-09-28T16:30:00Z', 'Asia/Tokyo')!.toISOString()).toBe('2026-09-29T01:30:00.000Z');
    expect(localDate(null, 'Asia/Tokyo')).toBeNull();
    expect(reportFilename('展会/一:二', '营业报表', 'xlsx')).not.toMatch(/[/:]/);
  });

  it('导出跨查询期间发生写入时拒绝混合数据', async () => {
    const { eventId } = await setup('CNY');
    const original = tdb.executor.readOne.bind(tdb.executor);
    let revisionReads = 0;
    vi.spyOn(tdb.executor, 'readOne').mockImplementation(async (sql, params) => {
      if (sql.includes("key='revision'") && ++revisionReads === 2) {
        await tdb.executor.tx([{ t: 'run', sql: "UPDATE events SET note='concurrent write' WHERE id=?", params: [eventId] }]);
      }
      return original(sql, params);
    });
    await expect(collectReport(eventId)).rejects.toThrow('数据发生变化');
  });
});
