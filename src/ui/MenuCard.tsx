import { AssetImage, QtyStepper } from './components';
import { formatMoney } from '../domain/money';
import { stockLabel, type MenuItem } from '../domain/types';

/**
 * 游客菜单的商品卡片。
 *
 * 抽成共享组件是因为：它同时被「游客菜单」和「菜单预览」渲染。
 * 之前两处各自写了一份标记，结果改版只改了游客面，预览仍然显示旧卡片——
 * 而预览的唯一作用就是忠实反映游客面。共用一份能从根上避免再次漂移。
 *
 * 摊主收银有自己的卡片（带 .body 的那一套），不使用本组件，
 * 所以本组件的 class 带 menu-card-cover，样式不会误伤后台。
 */
export default function MenuCard({
  item,
  inCartQty = 0,
  onAdd,
  onSetQty,
  onOpenDetail
}: {
  item: MenuItem;
  /** 已在购物车中的数量；为 0 时显示「加入」按钮 */
  inCartQty?: number;
  onAdd: () => void;
  onSetQty: (quantity: number) => void;
  onOpenDetail: () => void;
}) {
  const label = stockLabel(item);
  const soldOut = label === '售罄';
  const max = item.product_type === 'non_stock' ? null : item.available_stock;

  // 只在「会影响购买决策」的状态下显示标签。
  // 「有货」是默认状态，标在每张卡上只是噪音，还会压住封面顶部的书名区。
  // 摊主若开了「显示精确库存」，把它放出来——这是摊主明确要的信息，优先于粗粒度标签。
  const stock = item.available_stock ?? 0;
  const exact =
    item.show_exact_stock && item.product_type !== 'non_stock' && item.available_stock !== null;
  const tag = soldOut
    ? { text: '售罄', kind: 'danger' }
    : exact
      ? { text: `剩 ${stock}`, kind: stock <= item.low_stock_threshold ? 'warn' : 'flat' }
      : label === '少量'
        ? { text: '少量', kind: 'warn' }
        : null;

  return (
    <div className={`menu-card menu-card-cover ${soldOut ? 'sold-out' : ''}`}>
      <button
        type="button"
        className="menu-card-info"
        onClick={onOpenDetail}
        aria-label={`查看 ${item.product_name} 详情`}
      >
        <AssetImage assetId={item.cover_asset_id} alt={item.product_name} />
        {tag ? <span className={`stock-tag ${tag.kind}`}>{tag.text}</span> : null}
        <span className="caption">
          <span className="name">{item.product_name}</span>
          {item.variant_name !== '默认规格' ? (
            <span className="variant">{item.variant_name}</span>
          ) : null}
        </span>
        {soldOut ? (
          <span className="sold-veil">
            <span className="sold-mark">售罄</span>
          </span>
        ) : null}
      </button>
      <div className="menu-card-action">
        <span className="price">{formatMoney(item.price_minor, item.currency)}</span>
        {soldOut ? null : inCartQty > 0 ? (
          <QtyStepper value={inCartQty} min={0} max={max} onChange={onSetQty} />
        ) : (
          <button
            type="button"
            className="add-btn"
            onClick={onAdd}
            aria-label={`加入购物车：${item.product_name}`}
          >
            + 加入
          </button>
        )}
      </div>
    </div>
  );
}
