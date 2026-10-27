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
  /** 支持搜索，并显示在选择器中，帮助区分同名商品。 */
  sku: string | null;
  categoryId?: string | null;
  archived?: boolean;
  searchText?: string;
}

export function filterVariantOptions(options: VariantOption[], keyword: string): VariantOption[] {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return options;
  const terms = kw.split(/\s+/);
  return options.filter((o) => {
    const haystack = `${o.item.product_name} ${o.item.variant_name} ${o.sku ?? ''} ${o.item.category_name ?? ''} ${o.searchText ?? ''}`.toLowerCase();
    return terms.every(term => haystack.includes(term));
  });
}
