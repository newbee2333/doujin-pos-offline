import { describe, expect, it } from 'vitest';
import { formatAmountOnly, formatMoney, minorToInput, parseAmountToMinor } from '../money';

/**
 * 这几个断言存在的理由：`formatMoney` 改成基于 `formatAmountOnly` 之后，
 * 字符串拼接顺序错一位（例如把币种拼到符号前面）不会让 typecheck 或构建报错，
 * 但会让全站的金额显示变样。把改动前的实际输出钉在这里。
 */
describe('金额格式化', () => {
  it('formatMoney 与改动前逐字一致', () => {
    expect(formatMoney(3500, 'CNY')).toBe('¥35.00 CNY');
    expect(formatMoney(0, 'CNY')).toBe('¥0.00 CNY');
    expect(formatMoney(120000, 'CNY')).toBe('¥1,200.00 CNY');
    expect(formatMoney(1, 'CNY')).toBe('¥0.01 CNY');
    expect(formatMoney(1200, 'JPY')).toBe('¥1,200 JPY');
    expect(formatMoney(0, 'JPY')).toBe('¥0 JPY');
  });

  it('formatAmountOnly 不带币种代码，符号与分组规则和 formatMoney 一致', () => {
    expect(formatAmountOnly(3500, 'CNY')).toBe('¥35.00');
    expect(formatAmountOnly(120000, 'CNY')).toBe('¥1,200.00');
    expect(formatAmountOnly(1200, 'JPY')).toBe('¥1,200');
    // 拼回去必须与 formatMoney 完全相同 —— 这是「只换呈现、不改数值」的保证
    for (const [minor, cur] of [
      [0, 'CNY'],
      [7, 'CNY'],
      [99999, 'CNY'],
      [123456789, 'CNY'],
      [0, 'JPY'],
      [9800, 'JPY']
    ] as [number, 'CNY' | 'JPY'][]) {
      expect(`${formatAmountOnly(minor, cur)} ${cur}`).toBe(formatMoney(minor, cur));
    }
  });

  it('负数只出现在人民币分支（日元分支沿用原行为）', () => {
    expect(formatAmountOnly(-3500, 'CNY')).toBe('-¥35.00');
    expect(formatMoney(-3500, 'CNY')).toBe('-¥35.00 CNY');
  });

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
