import { describe, expect, it } from 'vitest';
import { EVENT_DATE_MAX, EVENT_DATE_MIN, validateEventDates } from '../event-dates';

describe('validateEventDates', () => {
  it('日期都可以不填', () => {
    expect(validateEventDates(null, null)).toBeNull();
    expect(validateEventDates('', '')).toBeNull();
  });

  it('六位数年份被拦截（浏览器日期框的原生行为）', () => {
    expect(validateEventDates('222222-02-22', '222222-02-22')).toBe('日期格式不正确，请用日期选择器重新选择');
  });

  it('超出范围被拦截', () => {
    expect(validateEventDates('2020-01-01', '2036-03-01')).toContain('日期需要在');
    expect(validateEventDates('2019-12-31', '2020-01-02')).toContain('日期需要在');
  });

  it('先后倒置被拦截', () => {
    expect(validateEventDates('2035-01-01', '2030-01-01')).toBe('开始日期不能晚于结束日期');
    expect(validateEventDates('2026-10-07', '2026-10-01')).toBe('开始日期不能晚于结束日期');
  });

  it('只填一头被拦截', () => {
    expect(validateEventDates('2026-10-01', null)).toContain('一起填');
    expect(validateEventDates(null, '2026-10-07')).toContain('一起填');
  });

  it('正常日期通过', () => {
    expect(validateEventDates('2026-10-01', '2026-10-07')).toBeNull();
    expect(validateEventDates(EVENT_DATE_MIN, EVENT_DATE_MAX)).toBeNull();
  });
});
