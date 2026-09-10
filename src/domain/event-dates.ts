/**
 * 展会日期的校验。
 *
 * 背景：浏览器的日期框年份段允许键入 6 位数（HTML 原生行为，规格上限 275760 年），
 * 不是表单代码的 bug。除了在输入框上加 min/max，提交时还要兜底校验。
 *
 * 规则：日期可以不填；填了就必须成对、格式正确（YYYY-MM-DD）、
 * 在 EVENT_DATE_MIN 至 EVENT_DATE_MAX 之间、且开始不晚于结束。
 */

export const EVENT_DATE_MIN = '2020-01-01';
export const EVENT_DATE_MAX = '2035-12-31';

/** 返回错误信息；null 表示通过。 */
export function validateEventDates(start: string | null, end: string | null): string | null {
  if (start && !end) return '填了开始日期，结束日期也要一起填';
  if (!start && end) return '填了结束日期，开始日期也要一起填';
  if (!start && !end) return null;

  const shapeOk =
    /^\d{4}-\d{2}-\d{2}$/.test(start!) &&
    /^\d{4}-\d{2}-\d{2}$/.test(end!) &&
    !Number.isNaN(Date.parse(start!)) &&
    !Number.isNaN(Date.parse(end!));
  if (!shapeOk) return '日期格式不正确，请用日期选择器重新选择';
  if (start! < EVENT_DATE_MIN || end! > EVENT_DATE_MAX) {
    return `日期需要在 ${EVENT_DATE_MIN} 至 ${EVENT_DATE_MAX} 之间`;
  }
  if (end! < start!) return '开始日期不能晚于结束日期';
  return null;
}
