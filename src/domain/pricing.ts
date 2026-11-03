/** All prices use integer minor units. Threshold eligibility never depends on edit history. */
export type PriceAdjustment = { kind: 'price' | 'rate'; value: number };
export type OrderAdjustment = { kind: 'total' | 'rate'; value: number };
export interface PromotionRules {
  version: string;
  prices: Record<string, PriceAdjustment>;
  tiers: { threshold: number; reduction: number }[];
  /** null means every non-gift item; [] means none. */
  eligible: string[] | null;
}
export interface PriceLine {
  lineId: string;
  variantId: string;
  quantity: number;
  listUnit: number;
  autoUnit: number;
  eligible: boolean;
  manual?: PriceAdjustment;
}
export interface PricedLine extends PriceLine {
  unit: number;
  subtotal: number;
  thresholdDiscount: number;
  orderDiscount: number;
  net: number;
}
export interface Quote {
  lines: PricedLine[];
  listTotal: number;
  subtotal: number;
  eligibleBase: number;
  thresholdDiscount: number;
  orderDiscount: number;
  discount: number;
  total: number;
}
export const emptyRules = (): PromotionRules => ({ version: '', prices: {}, tiers: [], eligible: null });
export function amount(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('金额或数量超出允许范围');
  return n;
}
export function adjustedUnit(base: number, adjustment?: PriceAdjustment): number {
  amount(base);
  if (!adjustment) return base;
  amount(adjustment.value);
  if (adjustment.kind === 'price') {
    if (adjustment.value > base) throw new Error('优惠价不能高于当前参考价');
    return adjustment.value;
  }
  if (adjustment.kind !== 'rate' || adjustment.value > 10000) throw new Error('折扣应在 0 至 10 折之间');
  return Number((BigInt(base) * BigInt(adjustment.value) + 5000n) / 10000n);
}
/** A later reduction of the event base price must not turn a saved special price into a surcharge. */
export function automaticUnit(base: number, adjustment?: PriceAdjustment): number {
  return adjustedUnit(base, adjustment?.kind === 'price' ? { ...adjustment, value: Math.min(base, adjustment.value) } : adjustment);
}
/** Largest remainders, with stable IDs as ties. No row ever absorbs all rounding error. */
export function allocate(total: number, weights: { id: string; value: number }[]): number[] {
  amount(total);
  const sum = weights.reduce((s, w) => amount(s + amount(w.value)), 0);
  if (total > sum) throw new Error('优惠不能超过可分摊金额');
  if (!sum) return weights.map(() => 0);
  const denominator = BigInt(sum);
  const parts = weights.map((w, index) => {
    const numerator = BigInt(total) * BigInt(w.value);
    return { index, id: w.id, value: Number(numerator / denominator), remainder: numerator % denominator };
  });
  let rest = total - parts.reduce((s, p) => s + p.value, 0);
  for (const p of [...parts].sort((a, b) => a.remainder === b.remainder ? a.id.localeCompare(b.id) : a.remainder > b.remainder ? -1 : 1)) {
    if (!rest) break;
    p.value++;
    rest--;
  }
  return parts.map(p => p.value);
}
export function validateRules(rules: PromotionRules): void {
  let previous = -1, previousReduction = 0;
  for (const tier of [...rules.tiers].sort((a, b) => a.threshold - b.threshold)) {
    amount(tier.threshold); amount(tier.reduction);
    if (tier.threshold <= 0 || tier.threshold === previous || tier.reduction > tier.threshold || tier.reduction < previousReduction) {
      throw new Error('满减门槛必须为不同的正数，减免不能超过门槛，且高档减免不能少于低档');
    }
    previous = tier.threshold; previousReduction = tier.reduction;
  }
  for (const adjustment of Object.values(rules.prices)) {
    amount(adjustment.value);
    if (!['price', 'rate'].includes(adjustment.kind) || (adjustment.kind === 'rate' && adjustment.value > 10000)) throw new Error('活动折扣格式不正确');
  }
}
export function priceOrder(lines: PriceLine[], tiers: PromotionRules['tiers'], manual?: OrderAdjustment): Quote {
  const ids = new Set<string>();
  const result: PricedLine[] = lines.map(l => {
    if (!l.lineId || ids.has(l.lineId)) throw new Error('商品明细标识重复');
    ids.add(l.lineId);
    if (amount(l.quantity) === 0) throw new Error('商品数量必须大于零');
    amount(l.listUnit); amount(l.autoUnit);
    if (l.autoUnit > l.listUnit) throw new Error('活动价不能高于本场定价');
    const unit = adjustedUnit(l.autoUnit, l.manual);
    return { ...l, unit, subtotal: amount(unit * l.quantity), thresholdDiscount: 0, orderDiscount: 0, net: 0 };
  });
  const sum = (f: (l: PricedLine) => number) => result.reduce((s, l) => amount(s + f(l)), 0);
  const listTotal = sum(l => amount(l.listUnit * l.quantity));
  const subtotal = sum(l => l.subtotal);
  const eligibleBase = sum(l => l.eligible ? amount(l.listUnit * l.quantity) : 0);
  const nominal = [...tiers].filter(t => eligibleBase >= t.threshold).sort((a, b) => b.threshold - a.threshold)[0]?.reduction ?? 0;
  const thresholdDiscount = Math.min(nominal, sum(l => l.eligible ? l.subtotal : 0));
  const thresholdParts = allocate(thresholdDiscount, result.map(l => ({ id: l.lineId, value: l.eligible ? l.subtotal : 0 })));
  const afterThreshold = subtotal - thresholdDiscount;
  let total = afterThreshold;
  if (manual) {
    amount(manual.value);
    if (manual.kind === 'total') {
      if (manual.value > afterThreshold) throw new Error('整单应收不能高于自动计算金额');
      total = manual.value;
    } else if (manual.kind === 'rate') total = adjustedUnit(afterThreshold, { kind: 'rate', value: manual.value });
    else throw new Error('整单优惠格式不正确');
  }
  const orderDiscount = afterThreshold - total;
  const orderParts = allocate(orderDiscount, result.map((l, i) => ({ id: l.lineId, value: l.subtotal - thresholdParts[i] })));
  result.forEach((l, i) => { l.thresholdDiscount = thresholdParts[i]; l.orderDiscount = orderParts[i]; l.net = l.subtotal - thresholdParts[i] - orderParts[i]; });
  return { lines: result, listTotal, subtotal, eligibleBase, thresholdDiscount, orderDiscount, total, discount: listTotal - total };
}
