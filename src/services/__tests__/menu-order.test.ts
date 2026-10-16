import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDatabase, openFromBytes, type TestDatabase } from '../../db/test-executor';
import { bindExecutor } from '../context';
import { addVariantsToEvent, createEvent, listEventConfigs, saveMenuOrder, updateConfig } from '../events';
import { createProduct } from '../catalog';
import { getKioskMenu } from '../orders';

let db: TestDatabase;
beforeEach(async () => { db = await createTestDatabase(); bindExecutor(db.executor); });
afterEach(() => db.close());
async function setup() {
  const event = await createEvent({ name: '排序展', currency: 'CNY' });
  const other = await createEvent({ name: '另一场', currency: 'CNY' });
  const ids: string[] = [];
  for (const name of ['甲', '隐藏', '乙', '丙']) {
    const { variantId } = await createProduct({ name, type: 'non_stock', default_currency: 'CNY', default_price_minor: 100 });
    ids.push(variantId);
  }
  await addVariantsToEvent(event, ids);
  await addVariantsToEvent(other, ids);
  await updateConfig(event, ids[1], { kiosk_visible: 0 });
  return { event, other, ids };
}
it('游客菜单按保存顺序读取，隐藏商品位置和其他展会不受影响，备份保留顺序', async () => {
  const { event, other, ids } = await setup();
  await saveMenuOrder(event, [ids[3], ids[0], ids[2]]);
  expect((await getKioskMenu(event)).map(item => item.variant_id)).toEqual([ids[3], ids[0], ids[2]]);
  expect((await listEventConfigs(event)).map(item => item.variant_id)).toEqual([ids[3], ids[1], ids[0], ids[2]]);
  expect((await listEventConfigs(other)).map(item => item.variant_id)).toEqual(ids);
  const restored = await openFromBytes(db.exportBytes());
  try {
    bindExecutor(restored.executor);
    expect((await getKioskMenu(event)).map(item => item.variant_id)).toEqual([ids[3], ids[0], ids[2]]);
  } finally { bindExecutor(db.executor); restored.close(); }
});
it('重复或不属于本场的规格不能保存，不产生部分修改', async () => {
  const { event, ids } = await setup();
  const before = await listEventConfigs(event);
  await expect(saveMenuOrder(event, [ids[0], ids[0]])).rejects.toThrow();
  await expect(saveMenuOrder(event, [ids[0], 'missing'])).rejects.toThrow();
  expect(await listEventConfigs(event)).toEqual(before);
});
