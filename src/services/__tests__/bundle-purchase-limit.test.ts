import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/test-executor';
import { bindExecutor } from '../context';
import { staffDirectSale } from '../orders';
import {
  addVariantsToEvent,
  activateEvent,
  createEvent,
  listPaymentMethods,
  setEventPaymentMethods,
  updateConfig,
  updatePaymentMethod
} from '../events';
import { createCategory, createProduct, listCategories, setBundleComponents } from '../catalog';
import { initializeStock } from '../inventory';

/**
 * 回归防线（2026-09-14 审计问题 2）：
 * 限购检查原来只遍历订单直接行。没有单独加入购物车的套装成分不在其中，
 * 于是「只买套装」可以绕过限量单品的每单限购——而库存需求已经把它算进去了。
 */
let tdb: TestDatabase;

beforeEach(async () => {
  if (tdb) tdb.close();
  tdb = await createTestDatabase();
  bindExecutor(tdb.executor);
});

async function setup() {
  const eventId = await createEvent({ name: 'C107', currency: 'CNY' });
  // 建库时已预置默认分类，复用而不是新建（重复创建会报「已存在同名分类」）
  const existing = (await listCategories()).find((c) => c.name === '新刊');
  const categoryId = existing ? existing.id : await createCategory('新刊');
  const cash = (await listPaymentMethods()).find((m) => m.type === 'cash')!;
  await updatePaymentMethod(cash.id, { enabled: true });
  await setEventPaymentMethods(eventId, [cash.id]);
  return { eventId, categoryId, cashId: cash.id };
}

async function makeBundleOf(
  eventId: string,
  categoryId: string,
  component: { variantId: string },
  price: number,
  limit?: number
) {
  const b = await createProduct({
    name: '套装',
    type: 'bundle',
    category_id: categoryId,
    default_currency: 'CNY'
  });
  await addVariantsToEvent(eventId, [b.variantId]);
  await updateConfig(eventId, b.variantId, {
    event_price_minor: price,
    ...(limit === undefined ? {} : { purchase_limit: limit })
  });
  await setBundleComponents(b.variantId, [{ component_variant_id: component.variantId, quantity: 1 }]);
  return b;
}

describe('套装成分的每单限购', () => {
  it('只买套装也不能绕过成分单品的限购', async () => {
    const { eventId, categoryId, cashId } = await setup();

    // 单品「限购本」：库存 20，每单限购 1
    const a = await createProduct({
      name: '限购本',
      type: 'normal',
      category_id: categoryId,
      default_currency: 'CNY',
      default_price_minor: 500
    });
    await addVariantsToEvent(eventId, [a.variantId]);
    await updateConfig(eventId, a.variantId, { event_price_minor: 500, purchase_limit: 1 });
    await initializeStock(eventId, a.variantId, 20);

    const b = await makeBundleOf(eventId, categoryId, a, 1000);
    await activateEvent(eventId);

    // 买 2 份套装 = 消耗 2 件「限购本」，超过其每单限购 1 → 必须拒绝
    await expect(
      staffDirectSale({
        eventId,
        lines: [{ variantId: b.variantId, quantity: 2 }],
        paymentMethodId: cashId,
        tenderedMinor: 2000
      })
    ).rejects.toThrow(/限购/);
  });

  it('套装自身也受自己的限购约束', async () => {
    const { eventId, categoryId, cashId } = await setup();
    const a = await createProduct({
      name: '立牌',
      type: 'normal',
      category_id: categoryId,
      default_currency: 'CNY',
      default_price_minor: 500
    });
    await addVariantsToEvent(eventId, [a.variantId]);
    await updateConfig(eventId, a.variantId, { event_price_minor: 500 });
    await initializeStock(eventId, a.variantId, 50);

    const b = await makeBundleOf(eventId, categoryId, a, 1000, 1);
    await activateEvent(eventId);

    await expect(
      staffDirectSale({
        eventId,
        lines: [{ variantId: b.variantId, quantity: 2 }],
        paymentMethodId: cashId,
        tenderedMinor: 2000
      })
    ).rejects.toThrow(/限购/);
  });

  it('未超限购的套装正常成交', async () => {
    const { eventId, categoryId, cashId } = await setup();
    const a = await createProduct({
      name: '限购本',
      type: 'normal',
      category_id: categoryId,
      default_currency: 'CNY',
      default_price_minor: 500
    });
    await addVariantsToEvent(eventId, [a.variantId]);
    await updateConfig(eventId, a.variantId, { event_price_minor: 500, purchase_limit: 5 });
    await initializeStock(eventId, a.variantId, 20);

    const b = await makeBundleOf(eventId, categoryId, a, 1000);
    await activateEvent(eventId);

    const res = await staffDirectSale({
      eventId,
      lines: [{ variantId: b.variantId, quantity: 2 }],
      paymentMethodId: cashId,
      tenderedMinor: 2000
    });
    expect(res.orderId).toBeTruthy();
  });
});
