import { adjustedUnit, automaticUnit, emptyRules, priceOrder, validateRules, type OrderAdjustment, type PriceAdjustment, type PriceLine, type PromotionRules } from '../domain/pricing';
import { newId } from '../domain/ids';
import type { Step } from '../db/executor';
import { auditStep, ex, getSetting, setSetting } from './context';
import { verifyPin } from './system';

export const promotionKey = (eventId: string) => `promotions.${eventId}`;
/** One settings record gives rule writes and checkout a single atomic revision boundary. */
export async function getPromotions(eventId: string): Promise<PromotionRules> {
  const raw = await getSetting(promotionKey(eventId));
  const rules: PromotionRules = raw ? JSON.parse(raw) : emptyRules();
  validateRules(rules);
  return rules;
}
export function promotionGuard(eventId: string, rules: PromotionRules): Step {
  return { t: 'assert', sql: "SELECT COALESCE(json_extract((SELECT value FROM settings WHERE key = ?), '$.version'), '')", params: [promotionKey(eventId)], equals: rules.version, message: '优惠活动已变化，请重新核对金额后提交' };
}
export async function savePromotions(eventId: string, rules: PromotionRules): Promise<void> {
  validateRules(rules);
  const event = await ex().readOne<{ status: string }>('SELECT status FROM events WHERE id = ?', [eventId]);
  if (!event || event.status === 'closed') throw new Error('请先重新打开展会，再修改优惠活动');
  const configs = await ex().read<{ variant_id: string; event_price_minor: number | null }>('SELECT variant_id, event_price_minor FROM event_variant_configs WHERE event_id = ?', [eventId]);
  for (const [id, adjustment] of Object.entries(rules.prices)) {
    const config = configs.find(c => c.variant_id === id);
    if (!config || config.event_price_minor === null) throw new Error('活动商品需要先设置本场定价');
    adjustedUnit(config.event_price_minor, adjustment);
  }
  const next = { ...rules, version: newId(), tiers: [...rules.tiers].sort((a, b) => a.threshold - b.threshold) };
  await ex().tx([
    promotionGuard(eventId, rules),
    { t: 'run', sql: 'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', params: [promotionKey(eventId), JSON.stringify(next)] },
    auditStep('promotion.save', 'event', eventId, next)
  ]);
}
export interface QuoteInputLine { variantId: string; quantity: number; lineId?: string; manual?: PriceAdjustment }
export async function quoteCart(eventId: string, lines: QuoteInputLine[], manual?: OrderAdjustment) {
  const rules = await getPromotions(eventId);
  const configs = await ex().read<{ variant_id: string; event_price_minor: number | null; type: string }>(
    'SELECT c.variant_id,c.event_price_minor,p.type FROM event_variant_configs c JOIN product_variants v ON v.id=c.variant_id JOIN products p ON p.id=v.product_id WHERE c.event_id=?', [eventId]);
  const priceLines: PriceLine[] = lines.map((l, index) => {
    const c = configs.find(c => c.variant_id === l.variantId);
    if (!c || (c.type !== 'gift' && c.event_price_minor === null)) throw new Error('商品未设置本场价格，请刷新菜单');
    const listUnit = c.type === 'gift' ? 0 : Number(c.event_price_minor);
    return { lineId: l.lineId ?? `${l.variantId}:${index}`, variantId: l.variantId, quantity: l.quantity, listUnit,
      autoUnit: automaticUnit(listUnit, rules.prices[l.variantId]),
      eligible: c.type !== 'gift' && (rules.eligible === null || rules.eligible.includes(l.variantId)), manual: l.manual };
  });
  return { ...priceOrder(priceLines, rules.tiers, manual), rules, manual };
}
export const requiresAdjustmentPin = async () => (await getSetting('security.adjustment_pin')) !== '0';
/** Attempts survive reloads; concurrent calls cannot all pass the attempt check. */
let pinQueue: Promise<unknown> = Promise.resolve();
export function authorizeAdjustment(pin?: string): Promise<void> {
  const check = async () => {
    if (!(await requiresAdjustmentPin())) return;
    if (!pin) throw new Error('人工调价需要输入后台密码确认');
    const now = Date.now();
    const state = JSON.parse((await getSetting('security.adjustment_attempts')) ?? '{"count":0,"since":0}') as { count: number; since: number };
    if (now - state.since < 60000 && state.count >= 5) throw new Error('密码尝试过多，请一分钟后重试');
    const count = now - state.since >= 60000 ? 1 : state.count + 1;
    await setSetting('security.adjustment_attempts', JSON.stringify({ count, since: count === 1 ? now : state.since }));
    if (!(await verifyPin(pin))) throw new Error('后台密码不正确');
    await setSetting('security.adjustment_attempts', '{"count":0,"since":0}');
  };
  const pending = pinQueue.then(check, check);
  pinQueue = pending.catch(() => {});
  return pending;
}
