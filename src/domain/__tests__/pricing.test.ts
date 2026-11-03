import { describe, expect, it } from 'vitest';
import { allocate, priceOrder, validateRules, emptyRules, type PriceLine } from '../pricing';

const line = (id: string, quantity: number, manual?: number): PriceLine => ({ lineId: id, variantId: 'sku', quantity, listUnit: 5000, autoUnit: 5000, eligible: true, manual: manual === undefined ? undefined : { kind: 'price', value: manual } });
const tiers = [{ threshold: 15000, reduction: 2000 }];
describe('确定性优惠定价', () => {
  it('先加商品或先调价，以及明细顺序变化，均按原价150减20收120', () => {
    const first = priceOrder([line('full', 2), line('manual', 1, 4000)], tiers);
    priceOrder([line('full', 1), line('manual', 1, 4000)], tiers);
    const second = priceOrder([line('manual', 1, 4000), line('full', 2)], tiers);
    expect(first.total).toBe(12000); expect(second.total).toBe(first.total);
    expect(first.eligibleBase).toBe(15000);
    expect(first.lines.map(l => [l.lineId, l.net]).sort()).toEqual(second.lines.map(l => [l.lineId, l.net]).sort());
  });
  it('全调为零，仍然达档但实际满减封顶为零', () => {
    const quote = priceOrder([line('a', 3, 0)], tiers);
    expect(quote.eligibleBase).toBe(15000); expect(quote.thresholdDiscount).toBe(0); expect(quote.total).toBe(0);
  });
  it('自动活动价不影响门槛，最高档不累加', () => {
    const q = priceOrder([{ ...line('a', 4), autoUnit: 4000 }], [...tiers, { threshold: 20000, reduction: 3000 }]);
    expect(q.total).toBe(13000); expect(q.thresholdDiscount).toBe(3000);
  });
  it('不参与的商品不分摊满减，整单优惠在满减后单独分摊', () => {
    const q = priceOrder([line('yes', 3), { ...line('no', 2), eligible: false }], tiers, { kind: 'total', value: 19000 });
    expect(q.lines[1].thresholdDiscount).toBe(0);
    expect(q.orderDiscount).toBe(4000);
    expect(q.lines.reduce((s, l) => s + l.net, 0)).toBe(19000);
  });
  it('真正的最大余数法，每一行误差小于一个最小单位', () => {
    expect(allocate(2, ['a','b','c'].map(id => ({ id, value: 1 })))).toEqual([1, 1, 0]);
    expect(allocate(2, ['c','b','a'].map(id => ({ id, value: 1 })))).toEqual([0, 1, 1]);
    for (let total = 0; total <= 30; total++) {
      const weights = [3, 7, 9, 11].map((value, i) => ({ id: String(i), value }));
      const parts = allocate(total, weights);
      expect(parts.reduce((s, n) => s + n, 0)).toBe(total);
      parts.forEach((n, i) => expect(Math.abs(n - total * weights[i].value / 30)).toBeLessThan(1));
    }
  });
  it('JPY 按日元取整，比例用整数计算', () => {
    const q = priceOrder([{ ...line('a', 3), listUnit: 101, autoUnit: 101, manual: { kind: 'rate', value: 9500 } }], [], { kind: 'rate', value: 9000 });
    expect(q.lines[0].unit).toBe(96); expect(q.total).toBe(259);
  });
  it('拒绝负数、重复行标识、提价及超过范围的折扣', () => {
    expect(() => priceOrder([line('a', 1, -1)], tiers)).toThrow();
    expect(() => priceOrder([line('a', 1), line('a', 1)], [])).toThrow();
    expect(() => priceOrder([line('a', 1)], [], { kind: 'total', value: 5001 })).toThrow();
    expect(() => priceOrder([{ ...line('a', 1), manual: { kind: 'rate', value: 10001 } }], [])).toThrow();
  });
  it('门槛不能重复，高档优惠不能减少', () => {
    expect(() => validateRules({ ...emptyRules(), tiers: [...tiers, { threshold: 15000, reduction: 2500 }] })).toThrow();
    expect(() => validateRules({ ...emptyRules(), tiers: [...tiers, { threshold: 20000, reduction: 1000 }] })).toThrow();
  });
});
