import type { Currency } from '../domain/types';

export const STATUS_LABEL: Record<string, string> = {
  pending_payment: '待付款', completed: '已成交', voided: '已取消', refunded: '已退款', corrected: '已纠错'
};
export const TYPE_LABEL: Record<string, string> = {
  normal: '普通商品', bundle: '套装', gift: '赠品', non_stock: '不计库存',
  cash: '现金', qr_payment: '扫码支付', other: '其他', kiosk: '游客下单', staff: '摊主收银',
  initial: '初始入库', reservation: '预留库存', reservation_release: '释放预留',
  sale: '销售出库', refund_return: '退款返库', correction_return: '纠错返库',
  restock: '补货', correction: '盘点调整', damaged: '损坏', personal: '自用', lost: '丢失',
  opening: '开场备用金', deposit: '现金存入', withdrawal: '现金取出'
};
export const label = (value: unknown, labels = TYPE_LABEL) => labels[String(value)] ?? String(value ?? '');
export const unitLabel = (currency: Currency) => currency === 'CNY' ? '人民币元' : '日元';
export const majorAmount = (minor: number, currency: Currency) => minor / (currency === 'CNY' ? 100 : 1);

/** Excel 没有时区：写入展会当地墙上时间，表头明确标注时区。 */
export function localDate(value: unknown, timezone: string): Date | null {
  if (!value) return null;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('报表中存在无效时间，无法导出');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const part = (key: string) => Number(parts.find(p => p.type === key)?.value);
  return new Date(Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')));
}

export function reportFilename(eventName: string, title: string, extension: string, date = new Date()) {
  const name = eventName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 70) || '展会';
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`;
  return `${name}-${title}-${stamp}.${extension}`;
}
