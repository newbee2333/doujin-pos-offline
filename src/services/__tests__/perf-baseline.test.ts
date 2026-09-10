/**
 * 性能与数据体积基线（规格第 28 节「持续营业」）。
 *
 * 注意：这里跑的是 **内存 sql.js**，不是真机 OPFS。
 * 它的用途是给「数据体积」和「事务语句复杂度」建立可比基线，
 * 不能当作设备上的 p95 响应时间——那部分必须在目标平板上实测。
 */

import { describe, expect, it } from 'vitest';
import { createTestDatabase, openFromBytes, type TestDatabase } from '../../db/test-executor';
import { bindExecutor, ex } from '../context';
import {
  activateEvent,
  addVariantsToEvent,
  createEvent,
  listPaymentMethods,
  setEventPaymentMethods,
  updateConfig,
  updatePaymentMethod
} from '../events';
import { createAsset, createProduct, listCategories } from '../catalog';
import { initializeStock } from '../inventory';
import { getKioskMenu, staffDirectSale } from '../orders';
import { getDashboard, getProductRanking } from '../reports';

const PRODUCT_COUNT = 120;
const ORDER_COUNT = 1000;

function pct(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function coverBytes(seed: number): Uint8Array {
  // 模拟压缩后的 WebP 封面（约 4 KB）
  const buf = new Uint8Array(4096);
  let x = seed + 1;
  for (let i = 0; i < buf.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = x % 256;
  }
  return buf;
}

describe('性能与数据体积基线', () => {
  it(
    `含图 ${PRODUCT_COUNT} 商品 / ${ORDER_COUNT} 订单`,
    async () => {
      const tdb: TestDatabase = await createTestDatabase();
      bindExecutor(tdb.executor);

      const eventId = await createEvent({ name: '压测展', currency: 'CNY' });
      const cats = await listCategories();
      const cash = (await listPaymentMethods()).find((m) => m.type === 'cash')!;
      await updatePaymentMethod(cash.id, { enabled: true });
      await setEventPaymentMethods(eventId, [cash.id]);

      // 1. 建商品（含封面图）
      const tSeedStart = performance.now();
      const variantIds: string[] = [];
      for (let i = 0; i < PRODUCT_COUNT; i++) {
        const cat = cats[i % cats.length];
        const { variantId } = await createProduct({
          name: `压测商品 ${String(i + 1).padStart(3, '0')}`,
          type: 'normal',
          category_id: cat.id,
          default_currency: 'CNY',
          default_price_minor: 500 + (i % 20) * 100
        });
        if (i % 2 === 0) {
          const bytes = coverBytes(i);
          const assetId = await createAsset('image/webp', 800, 1131, bytes, `h${i}`);
          await ex().tx([
            { t: 'run', sql: 'UPDATE products SET cover_asset_id = ? WHERE id = (SELECT product_id FROM product_variants WHERE id = ?)', params: [assetId, variantId] }
          ]);
        }
        await addVariantsToEvent(eventId, [variantId]);
        await updateConfig(eventId, variantId, {
          event_price_minor: 500 + (i % 20) * 100,
          kiosk_visible: 1
        });
        await initializeStock(eventId, variantId, 200);
        variantIds.push(variantId);
      }
      const seedMs = performance.now() - tSeedStart;

      await activateEvent(eventId);

      // 2. 下单测响应时间
      const orderMs: number[] = [];
      for (let i = 0; i < ORDER_COUNT; i++) {
        const t0 = performance.now();
        const variantId = variantIds[i % variantIds.length];
        await staffDirectSale({
          eventId,
          lines: [{ variantId, quantity: 1 + (i % 3) }],
          paymentMethodId: cash.id,
          tenderedMinor: 10000
        });
        orderMs.push(performance.now() - t0);
      }

      // 3. 常用读操作
      const tMenu = performance.now();
      const menu = await getKioskMenu(eventId);
      const menuMs = performance.now() - tMenu;

      const tDash = performance.now();
      await getDashboard(eventId);
      const dashMs = performance.now() - tDash;

      const tRank = performance.now();
      await getProductRanking(eventId);
      const rankMs = performance.now() - tRank;

      // 4. 导出 / 重开
      const tExport = performance.now();
      const bytes = tdb.exportBytes();
      const exportMs = performance.now() - tExport;

      const tOpen = performance.now();
      const restored = await openFromBytes(bytes);
      const reopenMs = performance.now() - tOpen;
      restored.close();

      const lines = [
        '',
        '──────── 基线（内存 sql.js，非设备实测） ────────',
        `商品数 / 订单数        ${PRODUCT_COUNT} / ${ORDER_COUNT}`,
        `建商品耗时             ${seedMs.toFixed(0)} ms（${(seedMs / PRODUCT_COUNT).toFixed(1)} ms/个）`,
        `下单 p50 / p95 / max   ${pct(orderMs, 50).toFixed(2)} / ${pct(orderMs, 95).toFixed(2)} / ${Math.max(...orderMs).toFixed(2)} ms`,
        `菜单查询（${menu.length} 项）      ${menuMs.toFixed(1)} ms`,
        `仪表盘统计             ${dashMs.toFixed(1)} ms`,
        `商品排行               ${rankMs.toFixed(1)} ms`,
        `导出耗时               ${exportMs.toFixed(0)} ms`,
        `重开耗时               ${reopenMs.toFixed(0)} ms`,
        `数据库体积             ${(bytes.length / 1024 / 1024).toFixed(2)} MB（含 ${Math.ceil(PRODUCT_COUNT / 2)} 张 4 KB 测试封面）`,
        '',
        '体积外推：真实 1600px WebP 封面约 100–300 KB/张；',
        `若 ${PRODUCT_COUNT} 个商品都配真实封面，预计 ${((PRODUCT_COUNT * 0.15)).toFixed(0)}–${((PRODUCT_COUNT * 0.35)).toFixed(0)} MB。`,
        '导入导出耗时在真机 OPFS 上会显著高于此处（内存 vs 闪存）。',
        '───────────────────────────────────────────────',
        ''
      ];
      console.log(lines.join('\n'));

      // 基本正确性：不是空库跑出来的数字
      expect(variantIds.length).toBe(PRODUCT_COUNT);
      expect(menu.length).toBe(PRODUCT_COUNT);
      expect(bytes.length).toBeGreaterThan(1024 * 1024); // 含图应显著大于 1 MB
      expect(pct(orderMs, 95)).toBeLessThan(1000); // 内存环境下不应出现秒级

      tdb.close();
    },
    180_000
  );
});
