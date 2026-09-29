/**
 * 套装成分选择器的搜索过滤。
 *
 * 起因：摊主反馈商品一多，靠鼠标在长列表里翻封面找不到东西，
 * 而列表里几个候选常常只差「上卷 / 下卷」这种一个字。
 * 这里只测过滤本身；「搜索结果能不能点中」由 scripts/verify-bundle-ux.mjs 实机验。
 */
import { describe, expect, it } from 'vitest';
import { filterVariantOptions, type VariantOption } from '../variant-filter';

function opt(productName: string, variantName = '默认规格', sku: string | null = null): VariantOption {
  return {
    id: `${productName}/${variantName}`,
    sku,
    item: {
      product_name: productName,
      variant_name: variantName,
      category_name: '新刊',
      cover_asset_id: null,
      price_minor: 1000,
      currency: 'CNY',
      product_type: 'normal',
      available_stock: null,
      show_exact_stock: 0,
      low_stock_threshold: 0
    }
  };
}

const OPTIONS = [
  opt('《夜行车》上卷', '默认规格', 'YXC-01'),
  opt('《夜行车》下卷', '默认规格', 'YXC-02'),
  opt('《旧梦重拍》'),
  opt('吧唧·主角', '亚克力 58mm')
];

const names = (list: VariantOption[]) => list.map((o) => o.item.product_name);

describe('套装成分搜索', () => {
  it('空关键词原样返回，不重新排序', () => {
    expect(filterVariantOptions(OPTIONS, '')).toBe(OPTIONS);
    expect(filterVariantOptions(OPTIONS, '   ')).toBe(OPTIONS);
  });

  it('按商品名过滤', () => {
    expect(names(filterVariantOptions(OPTIONS, '夜行车'))).toEqual(['《夜行车》上卷', '《夜行车》下卷']);
  });

  it('按规格名过滤 —— 抽屉里的「亚克力 58mm」也要能搜到', () => {
    expect(names(filterVariantOptions(OPTIONS, '58mm'))).toEqual(['吧唧·主角']);
  });

  it('按 SKU 过滤', () => {
    expect(names(filterVariantOptions(OPTIONS, 'yxc-02'))).toEqual(['《夜行车》下卷']);
  });

  it('大小写与首尾空格都不敏感', () => {
    expect(names(filterVariantOptions(OPTIONS, '  YXC-01 '))).toEqual(['《夜行车》上卷']);
  });

  it('搜不到就是空数组，不兜底成全量 —— 兜底会让「没找到」变成「全都在」', () => {
    expect(filterVariantOptions(OPTIONS, '不存在的东西')).toEqual([]);
  });
});
