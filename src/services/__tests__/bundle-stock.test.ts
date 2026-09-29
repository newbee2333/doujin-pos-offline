/**
 * 套装（bundle）的库存扣减闭环。
 *
 * 这套用例是补写的：原有的 `bundle-purchase-limit.test.ts` 只覆盖「成分限购」，
 * 而套装最核心的行为 —— 卖出时按成分数量**同步扣减**多个商品的库存 ——
 * 一直没有断言守着。这是整个套装功能最容易悄悄坏掉的地方。
 *
 * 场景就用摊主实际会配的：三件套 = 1 本子 + 2 吧唧 + 1 色纸。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/test-executor';
import { bindExecutor } from '../context';
import {
  activateEvent, addVariantsToEvent, createEvent, listEventConfigs, listPaymentMethods,
  removeVariantsFromEvent, setEventPaymentMethods, updateConfig, updatePaymentMethod
} from '../events';
import { createProduct, getBundleComponentsBatch, listCategories, setBundleComponents } from '../catalog';
import { adjustStock, getInventory, initializeStock, listTransactions } from '../inventory';
import { createPendingOrder, staffDirectSale, recordRefund, voidOrder } from '../orders';
import { collectReport } from '../report-export';

let tdb: TestDatabase;
beforeEach(async () => { tdb = await createTestDatabase(); bindExecutor(tdb.executor); });
afterEach(() => { tdb.close(); });

/** 三件套：1 本子 + 2 吧唧 + 1 色纸，外加两个单品用于对照。 */
async function setup() {
  const eventId = await createEvent({ name: '套装展', currency: 'CNY', timezone: 'Asia/Shanghai' });
  const cash = (await listPaymentMethods()).find(m => m.type === 'cash')!;
  await updatePaymentMethod(cash.id, { enabled: true });
  await setEventPaymentMethods(eventId, [cash.id]);
  const category = (await listCategories())[0];
  const mk = (name: string, type: 'normal' | 'bundle', price: number) =>
    createProduct({ name, type, category_id: category.id, default_currency: 'CNY', default_price_minor: price });

  // 成分按摊主的实际配法：本子、吧唧、色纸都入场单独卖
  const book = await mk('本子', 'normal', 3000);
  const badge = await mk('吧唧', 'normal', 1500);
  const paper = await mk('色纸', 'normal', 500);
  const set = await mk('三件套', 'bundle', 4500);

  await addVariantsToEvent(eventId, [book.variantId, badge.variantId, paper.variantId, set.variantId]);
  for (const [id, price] of [
    [book.variantId, 3000], [badge.variantId, 1500], [paper.variantId, 500], [set.variantId, 4500]
  ] as const) {
    await updateConfig(eventId, id, { event_price_minor: price });
  }
  await setBundleComponents(set.variantId, [
    { component_variant_id: book.variantId, quantity: 1 },
    { component_variant_id: badge.variantId, quantity: 2 },
    { component_variant_id: paper.variantId, quantity: 1 }
  ]);
  await initializeStock(eventId, book.variantId, 10);
  await initializeStock(eventId, badge.variantId, 10);
  await initializeStock(eventId, paper.variantId, 10);
  await activateEvent(eventId);

  const stock = async (variantId: string) => {
    const inv = await getInventory(eventId, variantId);
    return { physical: Number(inv?.physical_stock ?? 0), reserved: Number(inv?.reserved_stock ?? 0) };
  };
  const avail = async (variantId: string) => {
    const s = await stock(variantId);
    return s.physical - s.reserved;
  };
  return { eventId, cashId: cash.id, book, badge, paper, set, stock, avail };
}

describe('套装扣减', () => {
  it('卖出一套，按成分数量同步扣减三个商品', async () => {
    const { eventId, cashId, book, badge, paper, set, stock } = await setup();

    // 套装自身不持有库存
    expect(await getInventory(eventId, set.variantId)).toBeNull();

    await staffDirectSale({
      eventId, lines: [{ variantId: set.variantId, quantity: 2 }],
      paymentMethodId: cashId, tenderedMinor: 9000
    });

    // 两套 = 2 本子 + 4 吧唧 + 2 色纸
    expect(await stock(book.variantId)).toEqual({ physical: 8, reserved: 0 });
    expect(await stock(badge.variantId)).toEqual({ physical: 6, reserved: 0 });
    expect(await stock(paper.variantId)).toEqual({ physical: 8, reserved: 0 });

    // 流水要落到成分上、而不是套装上，且是 sale
    const bookTx = await listTransactions(eventId, book.variantId);
    expect(bookTx[0]).toMatchObject({ type: 'sale', delta_physical: -2, delta_reserved: 0 });
    const badgeTx = await listTransactions(eventId, badge.variantId);
    expect(badgeTx[0]).toMatchObject({ type: 'sale', delta_physical: -4, delta_reserved: 0 });
  });

  it('同一单里套装与单品混买，成分需求要合并计算', async () => {
    const { eventId, cashId, book, set, stock } = await setup();

    // 1 套（含 1 本子）+ 2 个单卖本子 = 本子共 3
    await staffDirectSale({
      eventId,
      lines: [{ variantId: set.variantId, quantity: 1 }, { variantId: book.variantId, quantity: 2 }],
      paymentMethodId: cashId, tenderedMinor: 10500
    });

    expect(await stock(book.variantId)).toEqual({ physical: 7, reserved: 0 });
  });

  it('待付款期间只预留、不扣实物；取消后精确释放', async () => {
    const { eventId, cashId, badge, set, stock } = await setup();

    const pending = await createPendingOrder({
      eventId, lines: [{ variantId: set.variantId, quantity: 1 }], plannedPaymentMethodId: cashId
    });
    // 1 套要 2 个吧唧 —— 预留了但实物还在
    expect(await stock(badge.variantId)).toEqual({ physical: 10, reserved: 2 });

    await voidOrder(pending.orderId, '游客放弃');
    expect(await stock(badge.variantId)).toEqual({ physical: 10, reserved: 0 });
  });

  it('成分库存不足时拦住整套，不会只扣一半', async () => {
    const { eventId, cashId, badge, book, paper, set, stock } = await setup();

    // 吧唧只剩 3 个，两套需要 4 个 —— 必须整单失败
    await adjustStock({ eventId, variantId: badge.variantId, deltaPhysical: -7, type: 'damaged', reason: '展会前破损' });
    expect(await stock(badge.variantId)).toEqual({ physical: 3, reserved: 0 });

    await expect(staffDirectSale({
      eventId, lines: [{ variantId: set.variantId, quantity: 2 }],
      paymentMethodId: cashId, tenderedMinor: 9000
    })).rejects.toThrow(/库存不足/);

    // 三个成分都不能被动过（事务回滚）
    expect(await stock(book.variantId)).toEqual({ physical: 10, reserved: 0 });
    expect(await stock(badge.variantId)).toEqual({ physical: 3, reserved: 0 });
    expect(await stock(paper.variantId)).toEqual({ physical: 10, reserved: 0 });
  });

  it('退款按成分各自返库', async () => {
    const { eventId, cashId, book, badge, paper, set, stock } = await setup();

    const sale = await staffDirectSale({
      eventId, lines: [{ variantId: set.variantId, quantity: 1 }],
      paymentMethodId: cashId, tenderedMinor: 4500
    });
    expect(await stock(badge.variantId)).toEqual({ physical: 8, reserved: 0 });

    await recordRefund({
      orderId: sale.orderId, paymentMethodId: cashId, reason: '客人退货',
      returns: { [book.variantId]: 1, [badge.variantId]: 2, [paper.variantId]: 1 }
    });

    expect(await stock(book.variantId)).toEqual({ physical: 10, reserved: 0 });
    expect(await stock(badge.variantId)).toEqual({ physical: 10, reserved: 0 });
    expect(await stock(paper.variantId)).toEqual({ physical: 10, reserved: 0 });
  });

  it('成分先在本场设好库存、再移出名册，套装仍能卖且照常扣它的库存', async () => {
    const { eventId, cashId, book, badge, set, stock } = await setup();

    // 实操路径：吧唧先加入本场并设初始库存（界面上只有这条路能给它设库存），
    // 然后摊主不想让吧唧在菜单上单独卖，于是把它从本场移除 —— 但套装还要用它。
    await removeVariantsFromEvent(eventId, [badge.variantId]);

    // 名册里没有吧唧了，但它在场套装的成分里，所以开场条件仍然满足
    expect((await listEventConfigs(eventId)).some(c => c.variant_id === badge.variantId)).toBe(false);

    // 卖一套：吧唧照样扣 2 个
    await staffDirectSale({
      eventId, lines: [{ variantId: set.variantId, quantity: 1 }],
      paymentMethodId: cashId, tenderedMinor: 4500
    });
    expect(await stock(book.variantId)).toEqual({ physical: 9, reserved: 0 });
    expect(await stock(badge.variantId)).toEqual({ physical: 8, reserved: 0 });

    // 报表要把它标成「仅作套装成分」，而不是「已移出本场」
    const rows = (await collectReport(eventId)).tables.find(t => t.name === '库存')!.rows;
    const presence = Object.fromEntries(rows.map(r => [String(r[0]), String(r[3])]));
    expect(presence['吧唧']).toBe('仅作套装成分');
    expect(presence['本子']).toBe('在场');
  });
});

/**
 * 上一条用例证明了这个缺口真实存在，但它是「静默」的 ——
 * 界面不会报错，只是库存页从此没有吧唧那一行，补货入口跟着一起消失。
 * 所以 StaffEvents 的「从本场移除」确认框要提前提醒一句，
 * 判据就是下面这两次查询；换个写法（比如以为成分一定有库存行）这条会红。
 */
describe('移除规格时的套装成分提醒（确认框的判据）', () => {
  it('成分被移出名册、套装还在场：能查出是哪个套装在消耗它', async () => {
    const { eventId, badge, set } = await setup();
    await removeVariantsFromEvent(eventId, [badge.variantId]);

    // 判据第 1 步：本场名册里还有哪些「组合套装」
    const stillIn = (await listEventConfigs(eventId))
      .filter(c => c.product_type === 'bundle')
      .map(c => c.variant_id);
    expect(stillIn).toEqual([set.variantId]);

    // 判据第 2 步：这些套装各自消耗哪些成分 —— 吧唧在名单里，所以要提醒
    const comps = await getBundleComponentsBatch(stillIn);
    expect((comps.get(set.variantId) ?? []).map(c => c.component_variant_id)).toContain(badge.variantId);
  });

  it('套装和成分一起移除：名册里不剩套装，不必提醒', async () => {
    const { eventId, badge, set } = await setup();
    await removeVariantsFromEvent(eventId, [badge.variantId, set.variantId]);

    expect((await listEventConfigs(eventId)).filter(c => c.product_type === 'bundle')).toEqual([]);
  });
});

/**
 * 商品编辑弹窗在「新增」时也要能配套装成分：先 createProduct 拿到 variantId，
 * 紧接着写成分，对用户仍然只是一次「创建」。
 * 这条链路是后补的 —— 原来新建套装只能先保存、再点一次「编辑」回来配，
 * 摊主第一反应是「我怎么找不到给套装选商品的地方」。
 */
describe('新建时一次配齐套装成分', () => {
  it('刚创建的套装规格就能写成分，入场后卖出照常扣减', async () => {
    const eventId = await createEvent({ name: '一次配齐', currency: 'CNY', timezone: 'Asia/Shanghai' });
    const cash = (await listPaymentMethods()).find(m => m.type === 'cash')!;
    await updatePaymentMethod(cash.id, { enabled: true });
    await setEventPaymentMethods(eventId, [cash.id]);
    const category = (await listCategories())[0];

    const comp = await createProduct({
      name: '挂件', type: 'normal', category_id: category.id, default_currency: 'CNY', default_price_minor: 2000
    });
    const bundle = await createProduct({
      name: '配件组合', type: 'bundle', category_id: category.id, default_currency: 'CNY', default_price_minor: 5000
    });

    // 弹窗点「创建」时做的就是这一句：拿刚返回的 variantId 写成分。
    // 成分指向新建出来的规格，所以 create 必须先把 variantId 交回来。
    await setBundleComponents(bundle.variantId, [{ component_variant_id: comp.variantId, quantity: 3 }]);

    await addVariantsToEvent(eventId, [comp.variantId, bundle.variantId]);
    await initializeStock(eventId, comp.variantId, 10);
    await activateEvent(eventId);

    await staffDirectSale({
      eventId, lines: [{ variantId: bundle.variantId, quantity: 1 }],
      paymentMethodId: cash.id, tenderedMinor: 5000
    });

    // 1 套 = 3 个挂件
    expect(Number((await getInventory(eventId, comp.variantId))?.physical_stock)).toBe(7);
  });
});
