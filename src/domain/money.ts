/** 金额：全部以最小货币单位整数保存（CNY=分，JPY=日元）。第 6 节。 */

import type { Currency } from './types';

export const CURRENCY_LABEL: Record<Currency, string> = {
  CNY: '人民币/CNY',
  JPY: '日元/JPY'
};

/** 把用户输入的字符串精确解析为最小单位整数。禁止浮点。 */
export function parseAmountToMinor(input: string, currency: Currency): number {
  const raw = String(input ?? '').trim().replace(/[,，\s]/g, '');
  if (raw === '') throw new Error('请填写金额');
  if (currency === 'JPY') {
    if (!/^\d+$/.test(raw)) throw new Error('日元金额请填整数，不带小数');
    const v = Number(raw);
    if (!Number.isSafeInteger(v)) throw new Error('金额超出可处理范围');
    return v;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error('人民币金额格式不正确，最多两位小数');
  }
  const [intPart, fracPart = ''] = raw.split('.');
  const minor = Number(intPart) * 100 + Number(fracPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor)) throw new Error('金额超出可处理范围');
  return minor;
}

/** 把最小单位整数格式化回用户输入友好的字符串（不带币种后缀）。 */
export function minorToInput(minor: number, currency: Currency): string {
  if (currency === 'JPY') return String(minor);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** 展示用金额。必须显示币种，不能只显示 ¥。 */
export function formatMoney(minor: number, currency: Currency): string {
  const symbol = currency === 'CNY' ? '¥' : '¥';
  if (currency === 'JPY') return `${symbol}${groupDigits(minor)} JPY`;
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${symbol}${groupDigits(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')} CNY`;
}

function groupDigits(n: number): string {
  return n.toLocaleString('en-US');
}

/** 安全乘法：单价 × 数量，越界抛错。 */
export function mulQty(unitMinor: number, quantity: number): number {
  const v = unitMinor * quantity;
  if (!Number.isSafeInteger(v)) throw new Error('金额超出可处理范围');
  return v;
}

export function sumMinor(values: number[]): number {
  return values.reduce((a, b) => {
    const v = a + b;
    if (!Number.isSafeInteger(v)) throw new Error('合计金额超出可处理范围');
    return v;
  }, 0);
}
