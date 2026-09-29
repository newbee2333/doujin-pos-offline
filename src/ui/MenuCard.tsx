import { AssetImage, QtyStepper } from './components';
import { formatAmountOnly } from '../domain/money';
import { stockLabel, type MenuItem } from '../domain/types';

/**
 * 游客菜单的商品卡片。
 *
 * 抽成共享组件是因为：它同时被「游客菜单」和「菜单预览」渲染。
 * 之前两处各自写了一份标记，结果改版只改了游客面，预览仍然显示旧卡片——
 * 而预览的唯一作用就是忠实反映游客面。共用一份能从根上避免再次漂移。
 *
 * 摊主收银有自己的卡片（StaffCheckout 里也用 .menu-card，但**不带** .menu-card-cover），
 * 所以本组件的重排只写在 .menu-card-cover 下，不会误伤收银台。
 *
 * 2026-09-14 改版：品名/分类从封面上的覆盖条，改成图片下方的正文块。
 * 覆盖条方案会把书名压在封面上（同人本封面顶部往往印着书名），
 * 图片主导的排版下把文字还给图片下方的白底，信息层级更清楚。
 *
 * 2026-09-29：加了「选择模式」（传 onPick）。商品编辑器里配「套装成分」时
 * 直接复用这张卡 —— 摊主挑成分要的正是游客菜单那种「看封面翻」的体验，
 * 而不是一条拼成长字符串的下拉。复用同一份标记，免得又出现
 * 「改版只改了菜单、选择器还停在旧样式」这种漂移。
 */

/**
 * 卡片真正读到的字段。
 *
 * 收窄成子集是为了让「套装成分」的选择器也能复用这张卡 ——
 * 那边只拿得到商品本身，凑不出 MenuItem 里那些跟「本场」绑定的字段
 * （分类名、库存、限购）。MenuItem 结构上是它的超集，所以
 * 游客菜单与菜单预览传 MenuItem 依然合法，一行都不用改。
 */
export type MenuCardItem = Pick<
  MenuItem,
  | 'product_name'
  | 'variant_name'
  | 'category_name'
  | 'cover_asset_id'
  | 'price_minor'
  | 'currency'
  | 'product_type'
  | 'available_stock'
  | 'show_exact_stock'
  | 'low_stock_threshold'
>;

export default function MenuCard({
  item,
  inCartQty = 0,
  onAdd,
  onSetQty,
  onOpenDetail,
  onPick,
  selected = false
}: {
  item: MenuCardItem;
  /** 已在购物车中的数量；为 0 时显示「加入」按钮 */
  inCartQty?: number;
  /**
   * 选择模式：传了它就点不动「详情 / 加购」，整张卡变成一个选项。
   * 这个模式下不判售罄 —— 调用方（商品编辑器）手里没有本场库存，
   * 把「拿不到」当成「卖完了」会直接把选项全挡死。
   */
  onPick?: () => void;
  selected?: boolean;
  onAdd?: () => void;
  onSetQty?: (quantity: number) => void;
  onOpenDetail?: () => void;
}) {
  const picker = !!onPick;
  const label = stockLabel(item);
  const soldOut = !picker && label === '售罄';
  const max = item.product_type === 'non_stock' ? null : item.available_stock;

  // 只在「会影响购买决策」的状态下显示标签。
  // 「有货」是默认状态，标在每张卡上只是噪音，还会压住封面顶部的书名区。
  // 摊主若开了「显示精确库存」，把它放出来——这是摊主明确要的信息。
  //
  // 售罄时**不显示角标**：下面还有一整块 .sold-veil 盖在图片正中写「售罄」，
  // 两个「售罄」同时出现（右上角 44×24 角标 + 正中 68×38 覆盖层）既重复又吵。
  // 中央覆盖层更不容易被划走，留它。
  const stock = item.available_stock ?? 0;
  const exact =
    item.show_exact_stock && item.product_type !== 'non_stock' && item.available_stock !== null;
  const tag =
    picker || soldOut
      ? null
      : exact
        ? { text: `剩 ${stock}`, kind: stock <= item.low_stock_threshold ? 'warn' : 'flat' }
        : label === '少量'
          ? { text: '少量', kind: 'warn' }
          : null;

  // 副标题：分类 + 非默认规格。两样都没有就整行不渲染，不留空行。
  const sub = [
    item.category_name ?? '',
    item.variant_name && item.variant_name !== '默认规格' ? item.variant_name : ''
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={`menu-card menu-card-cover ${soldOut ? 'sold-out' : ''} ${selected ? 'picked' : ''}`}>
      <button
        type="button"
        className="menu-card-info"
        onClick={picker ? onPick : onOpenDetail}
        aria-label={picker ? `选择 ${item.product_name}` : `查看 ${item.product_name} 详情`}
        aria-pressed={picker ? selected : undefined}
      >
        <span className="thumb-wrap">
          <AssetImage assetId={item.cover_asset_id} alt={item.product_name} />
          {tag ? <span className={`stock-tag ${tag.kind}`}>{tag.text}</span> : null}
          {soldOut ? (
            <span className="sold-veil">
              <span className="sold-mark">售罄</span>
            </span>
          ) : null}
        </span>
        <span className="caption">
          <span className="name">{item.product_name}</span>
          {sub ? <span className="sub">{sub}</span> : null}
        </span>
      </button>
      <div className="menu-card-action">
        {/* 金额和加购按钮必须待在同一行。
            原来是 20px 的「¥120.00 CNY」+ 46px 圆钮，横屏 6 列时卡片只有 155px 宽，
            于是长价格一律换行、按钮掉到第二行 —— 每张卡白白高一截。
            现在金额降到 16px、币种代码单独画小一档（10px），两个就能并排放下。
            币种仍然显示：¥ 同时是人民币和日元的符号，单看一个 ¥120.00 分不出是哪种。 */}
        <span className="price">
          {formatAmountOnly(item.price_minor, item.currency)}
          <span className="cur">{item.currency}</span>
        </span>
        {picker ? (
          <button
            type="button"
            className={`pick-btn${selected ? ' on' : ''}`}
            onClick={onPick}
            aria-pressed={selected}
          >
            {selected ? '已选' : '选择'}
          </button>
        ) : soldOut ? null : inCartQty > 0 ? (
          <QtyStepper value={inCartQty} min={0} max={max} onChange={(v) => onSetQty?.(v)} />
        ) : (
          <button
            type="button"
            className="add-btn"
            onClick={() => onAdd?.()}
            aria-label={`加入购物车：${item.product_name}`}
          >
            +
          </button>
        )}
      </div>
    </div>
  );
}
