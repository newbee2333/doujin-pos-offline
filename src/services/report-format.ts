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

/**
 * 库存行的「在场状态」判定。
 *
 * 为什么要三档而不是「在 / 不在」：一条 inventory 行有三种处境，
 * 它们对「这场到底还在卖什么」的意义完全不同。
 *
 *   在场          名册里有这一行，正常在卖。
 *   仅作套装成分   名册里没有，但被某个**在场**套装消耗。
 *                 「只在套装里卖、单独不上菜单，但照样备货」是受支持的做法：
 *                 开场校验只要求成分有 inventory 行，并不要求它在名册里。
 *   已移出本场     名册里没有，也不再被任何在场套装消耗。
 *
 * 只标「是 / 否」会把第二种错判成「不在场」，而它其实正在被消耗；
 * 报表的「库存」表本来就写着「套装共用成分库存」，标错正好自相矛盾。
 *
 * 另外第二种和第三种都**不删**库存行 —— 前者是因为还要用，
 * 后者是故意的（`removeVariantsFromEvent` 的注释：以后加回来，备货数和流水都还在）。
 * 所以列表里留行没错，错的是不标出来：摊主会以为它还在卖。
 */
export const PRESENCE_LABEL = {
  inRoster: '在场',
  componentOnly: '仅作套装成分',
  removed: '已移出本场'
} as const;

export interface StockPresenceFlags {
  /** SQLite 的 EXISTS 结果是 0 / 1；用 unknown 接住不同查询的行类型。 */
  in_roster?: unknown;
  as_component?: unknown;
}

/**
 * 判定「在场状态」用的两个标记列。
 *
 * Excel 与 CSV 两条导出都拼这段，是为了不让两边各自手写一份 ——
 * 这种「同一语义写两遍」的地方，改一边忘一边是迟早的事。
 */
export const PRESENCE_COLUMNS = `EXISTS (SELECT 1 FROM event_variant_configs pc
                WHERE pc.event_id = i.event_id AND pc.variant_id = i.variant_id) AS in_roster,
            EXISTS (SELECT 1 FROM bundle_components bc
                    JOIN event_variant_configs pc2
                      ON pc2.variant_id = bc.bundle_variant_id AND pc2.event_id = i.event_id
                    WHERE bc.component_variant_id = i.variant_id) AS as_component`;

export function stockPresence(row: StockPresenceFlags): string {
  if (Number(row.in_roster) === 1) return PRESENCE_LABEL.inRoster;
  if (Number(row.as_component) === 1) return PRESENCE_LABEL.componentOnly;
  return PRESENCE_LABEL.removed;
}

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
