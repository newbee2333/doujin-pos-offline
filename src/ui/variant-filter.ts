/**
 * 套装成分选择器的关键词过滤。
 *
 * 单独放一个不依赖 React / 数据库的模块，是为了让 vitest 能直接引到它 ——
 * 组件文件会连带引入 useAssetUrl → 资源表与 worker，在 node 环境里跑不起来。
 * 只从这里 import type，编译后被完全抹掉，不会把 React 拖进来。
 */
import type { MenuCardItem } from './MenuCard';

export interface VariantOption {
  id: string;
  item: MenuCardItem;
  /** 参与搜索但卡片上不显示（SKU 是拿来对账的，不是拿来认封面的） */
  sku: string | null;
}

export function filterVariantOptions(options: VariantOption[], keyword: string): VariantOption[] {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return options;
  return options.filter((o) =>
    `${o.item.product_name} ${o.item.variant_name} ${o.sku ?? ''}`.toLowerCase().includes(kw)
  );
}
