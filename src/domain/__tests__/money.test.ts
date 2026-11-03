import { describe, expect, it } from 'vitest';
import { minorToInput, parseAmountToMinor } from '../money';

describe('金额格式化', () => {



  it('输入框字符串与金额可以互转', () => {
    expect(minorToInput(3500, 'CNY')).toBe('35.00');
    expect(minorToInput(5, 'CNY')).toBe('0.05');
    expect(minorToInput(1200, 'JPY')).toBe('1200');
    expect(parseAmountToMinor('35.00', 'CNY')).toBe(3500);
    expect(parseAmountToMinor('1,200', 'CNY')).toBe(120000);
    expect(parseAmountToMinor('1200', 'JPY')).toBe(1200);
    expect(() => parseAmountToMinor('35.999', 'CNY')).toThrow();
    expect(() => parseAmountToMinor('12.5', 'JPY')).toThrow();
  });
});
