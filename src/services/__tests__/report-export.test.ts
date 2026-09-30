import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { createTestDatabase, type TestDatabase } from '../../db/test-executor';
import { bindExecutor } from '../context';
import { collectReport, createReportWorkbook, exportEventWorkbook } from '../report-export';
import { localDate, reportFilename } from '../report-format';
import { createEvent, listPaymentMethods, updatePaymentMethod, setEventPaymentMethods, addVariantsToEvent, removeVariantsFromEvent, updateConfig, activateEvent } from '../events';
import { createProduct, listCategories, setBundleComponents } from '../catalog';
import { initializeStock } from '../inventory';
import { staffDirectSale, recordRefund, correctOrder, createPendingOrder, voidOrder } from '../orders';
import { addCashMovement, exportInventoryCsv, settleEvent } from '../reports';
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
    expect(data.tables.find(t => t.name === '库存')!.rows[0].slice(3)).toEqual(['在场', 20, 19, 1, 18]);
    const workbook = await createReportWorkbook(data);
    const encoded = await workbook.xlsx.writeBuffer();
    if (process.env.REPORT_LAYOUT_SAMPLE === '1' && currency === 'CNY') {
      const fs = await import('node:fs/promises');
      await fs.mkdir('test-results', { recursive: true });
      await fs.writeFile('test-results/report-layout-cny.xlsx', new Uint8Array(encoded));
    }
    const readBack = new ExcelJS.Workbook();
    await readBack.xlsx.load(encoded);
    expect(readBack.worksheets.map(s => s.name)).toEqual(['营业总览','商品销售','收款汇总','订单','订单明细','库存','库存流水','现金流水']);
    expect(readBack.getWorksheet('营业总览')!.getCell('A6').value).toBe(24690 / factor);
    expect(readBack.getWorksheet('营业总览')!.getCell('A6').numFmt).toContain(currency === 'CNY' ? '#,##0.00' : '#,##0');
    const items = readBack.getWorksheet('订单明细')!;
    expect(items.getCell('C6').value).toBe('=SUM(1,2)\n长商品名');
    expect(items.getCell('C6').type).toBe(ExcelJS.ValueType.String);
    expect(items.getCell('G6').value).toBe(12345 / factor);
    expect(items.views[0]).toMatchObject({ state: 'normal', showGridLines: false });
    for (const sheet of readBack.worksheets) expect(sheet.views.every(v => v.state === 'normal' && !('xSplit' in v) && !('ySplit' in v))).toBe(true);
    expect(readBack.getWorksheet('营业总览')!.autoFilter).toBeUndefined();
    expect(readBack.getWorksheet('营业总览')!.getCell('C6').value).toBe(12345 / factor);
    expect(readBack.getWorksheet('营业总览')!.getCell('E6').value).toBe(12345 / factor);
    expect(readBack.getWorksheet('营业总览')!.getCell('C20').value).toBe(-37035 / factor);
    expect(readBack.getWorksheet('营业总览')!.getCell('F19').value).toBe('未盘点');
    expect(readBack.getWorksheet('营业总览')!.getCell('F20').value).toBe('未结算');
    expect(items.autoFilter).toBeTruthy();
    const orders = readBack.getWorksheet('订单')!;
    expect(orders.getCell('B6').value).toBe('已成交');
    expect(orders.getCell('B7').value).toBe('已退款');
    expect(orders.getCell('B8').value).toBe('已纠错');
    expect(orders.getCell('D8').value).toBe(0);
    expect(orders.getCell('H6').value).toBeInstanceOf(Date);
    for (const sheet of readBack.worksheets) sheet.eachRow(row => row.eachCell(cell => expect(cell.type).not.toBe(ExcelJS.ValueType.Formula)));
  });

  it('空展会仍有说明和表头，未盘点不填零', async () => {
    const eventId = await createEvent({ name: '空展会', currency: 'CNY' });
    const { bytes, filename } = await exportEventWorkbook(eventId);
    expect(filename).toMatch(/^空展会-营业报表-.*\.xlsx$/);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    expect(book.getWorksheet('商品销售')!.getCell('A6').value).toBe('本场暂无记录');
    expect(book.getWorksheet('营业总览')!.getCell('A6').value).toBe(0);
  });

  it('实际盘点零现金与尚未盘点不同', async () => {
    const { eventId } = await setup('CNY');
    await settleEvent(eventId, 0, null);
    const book = await createReportWorkbook(await collectReport(eventId));
    const bytes = await book.xlsx.writeBuffer();
    const saved = new ExcelJS.Workbook();
    await saved.xlsx.load(bytes);
    expect(saved.getWorksheet('营业总览')!.getCell('F19').value).toBe(0);
    expect(saved.getWorksheet('营业总览')!.getCell('F20').value).toBe(0);
  });

  it('总览只列前五名，完整商品记录与长商品名保留在明细', async () => {
    const { eventId } = await setup('CNY');
    const data = await collectReport(eventId);
    const ranking = data.tables.find(t => t.name === '商品销售')!;
    const longName = '很长的商品名'.repeat(10);
    ranking.rows = Array.from({ length: 6 }, (_, i) => [i === 0 ? longName : `商品 ${i + 1}`, '规格', `000${i}`, 1, 100 - i, 0]);
    const book = await createReportWorkbook(data);
    const saved = new ExcelJS.Workbook();
    await saved.xlsx.load(await book.xlsx.writeBuffer());
    expect(saved.getWorksheet('营业总览')!.getCell('A26').value).toBe(`${longName} / 规格`);
    expect(saved.getWorksheet('营业总览')!.getRow(26).height).toBeGreaterThan(40);
    expect(saved.getWorksheet('营业总览')!.getCell('A30').value).toBe('商品 5 / 规格');
    expect(saved.getWorksheet('商品销售')!.getCell('A11').value).toBe('商品 6');
    expect(saved.getWorksheet('商品销售')!.getCell('C6').value).toBe('0000');
    expect(saved.getWorksheet('商品销售')!.autoFilter).toEqual('A5:F11');
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

  it('库存表的「在场状态」分三档：在场 / 仅作套装成分 / 已移出本场', async () => {
    const eventId = await createEvent({ name: '状态展', currency: 'CNY', timezone: 'Asia/Shanghai' });
    const cash = (await listPaymentMethods()).find(m => m.type === 'cash')!;
    await updatePaymentMethod(cash.id, { enabled: true });
    await setEventPaymentMethods(eventId, [cash.id]);
    const category = (await listCategories())[0];
    const mk = (name: string, price: number) =>
      createProduct({ name, type: 'normal' as const, category_id: category.id, default_currency: 'CNY' as const, default_price_minor: price });

    // 成分故意「不入场」：开场校验只要求成分有库存行，不要求它在名册里
    const comp = await mk('只在套装里卖', 300);
    const lone = await mk('会被移除', 500);
    const stay = await mk('留场', 700);
    const { variantId: bundleId } = await createProduct({
      name: '套装', type: 'bundle', category_id: category.id, default_currency: 'CNY', default_price_minor: 900
    });

    await addVariantsToEvent(eventId, [bundleId, lone.variantId, stay.variantId]);
    for (const [id, price] of [[bundleId, 900], [lone.variantId, 500], [stay.variantId, 700]] as const) {
      await updateConfig(eventId, id, { event_price_minor: price });
    }
    await setBundleComponents(bundleId, [{ component_variant_id: comp.variantId, quantity: 2 }]);
    await initializeStock(eventId, comp.variantId, 30);
    await initializeStock(eventId, lone.variantId, 12);
    await initializeStock(eventId, stay.variantId, 7);
    await activateEvent(eventId);

    // 套装自身不持有库存行，所以这里只有三个普通商品
    const presenceOf = async () => {
      const rows = (await collectReport(eventId)).tables.find(t => t.name === '库存')!.rows;
      return Object.fromEntries(rows.map(r => [String(r[0]), String(r[3])]));
    };
    // 成分从一开始就不在名册里，但被在场套装消耗 —— 所以是第二档而不是第一档
    expect(await presenceOf()).toEqual({
      只在套装里卖: '仅作套装成分',
      会被移除: '在场',
      留场: '在场'
    });

    await removeVariantsFromEvent(eventId, [lone.variantId]);

    // 移除只删名册行，库存行按设计保留 —— 所以三档状态必须各自正确
    expect(await presenceOf()).toEqual({
      只在套装里卖: '仅作套装成分',
      会被移除: '已移出本场',
      留场: '在场'
    });

    // CSV 与 Excel 用同一份判定：列名与取值都要一致
    const csv = await exportInventoryCsv(eventId);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toContain('在场状态');
    expect(lines.find(l => l.startsWith('只在套装里卖'))).toContain('仅作套装成分');
    expect(lines.find(l => l.startsWith('会被移除'))).toContain('已移出本场');
    expect(lines.find(l => l.startsWith('留场'))).toContain('在场');

    // 已移出本场的行仍然列出（货还在箱子里），但不再是「在场」
    const book = await createReportWorkbook(await collectReport(eventId));
    const sheet = book.getWorksheet('库存')!;
    expect(sheet.getCell('D6').value).toBeDefined();
    expect(sheet.columnCount).toBe(8);
  });
});
