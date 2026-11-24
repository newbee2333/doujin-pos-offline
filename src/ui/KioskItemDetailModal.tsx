import { useMemo } from 'react';
import { formatAmountOnly, formatMoney } from '../domain/money';
import type { MenuItem } from '../domain/types';
import { getBundleComponents, listProducts } from '../services/catalog';
import { AssetImage, Modal, Money, QtyStepper, Spinner, useAsync } from './components';
import { effectiveItemMax } from './MenuCard';

/**
 * 游客菜单与菜单预览共用的商品详情弹层。
 * 补齐活动原价/折扣展示，以及组合套装的成分清单（封面缩略图 + 名称 + 每套用量）。
 */
export default function KioskItemDetailModal({
  item,
  qty,
  inCartQty = 0,
  onQtyChange,
  onClose,
  onAdd,
  preview = false
}: {
  item: MenuItem;
  qty: number;
  inCartQty?: number;
  onQtyChange: (v: number) => void;
  onClose: () => void;
  onAdd?: (quantity: number) => void;
  preview?: boolean;
}) {
  const isBundle = item.product_type === 'bundle';
  const bundleComps = useAsync(
    () => (isBundle ? getBundleComponents(item.variant_id) : Promise.resolve([])),
    [item.variant_id, isBundle]
  );
  const allProducts = useAsync(
    () => (isBundle ? listProducts({}) : Promise.resolve([])),
    [isBundle]
  );

  const resolvedComponents = useMemo(() => {
    if (!isBundle || !bundleComps.data?.length) return [];
    const byVariant = new Map<
      string,
      { productName: string; variantName: string; coverAssetId: string | null; categoryName: string | null }
    >();
    for (const p of allProducts.data ?? []) {
      for (const v of p.variants) {
        byVariant.set(v.id, {
          productName: p.name,
          variantName: v.name,
          coverAssetId: p.cover_asset_id,
          categoryName: p.category_name
        });
      }
    }
    return bundleComps.data.map((c) => ({
      variantId: c.component_variant_id,
      quantity: c.quantity,
      ...(byVariant.get(c.component_variant_id) ?? {
        productName: '套装内含商品',
        variantName: '',
        coverAssetId: null,
        categoryName: null
      })
    }));
  }, [isBundle, bundleComps.data, allProducts.data]);

  const hasPromo = item.list_price_minor !== undefined && item.list_price_minor > item.price_minor;
  const max = effectiveItemMax(item);
  const cannotAdd = qty <= 0 || (max !== null && (max <= 0 || qty > max));
  const actionLabel =
    inCartQty > 0
      ? preview
        ? '更新预览数量'
        : '更新数量'
      : preview
        ? '加入预览购物车'
        : '加入购物车';

  return (
    <Modal
      title={item.product_name}
      onClose={onClose}
      actions={
        <>
          <button type="button" onClick={onClose}>
            关闭
          </button>
          {onAdd ? (
            <button
              type="button"
              className="primary"
              onClick={() => onAdd(qty)}
              disabled={cannotAdd}
            >
              {actionLabel}
            </button>
          ) : null}
        </>
      }
    >
      <div className="col">
        <AssetImage
          assetId={item.cover_asset_id}
          alt={item.product_name}
          categoryName={item.category_name}
          className="detail-modal-cover"
        />

        {item.description ? <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{item.description}</p> : null}

        <div className="small muted">
          {item.category_name ? `${item.category_name} · ` : ''}
          {item.variant_name}
          {item.sku ? ` · SKU ${item.sku}` : ''}
        </div>

        {isBundle ? (
          <div className="bundle-contents">
            <div className="bundle-contents-head">套装包含内容</div>
            {bundleComps.loading || allProducts.loading ? (
              <Spinner label="读取套装成分…" />
            ) : resolvedComponents.length ? (
              <div className="bundle-contents-list">
                {resolvedComponents.map((c) => (
                  <div className="bundle-contents-item" key={c.variantId}>
                    <AssetImage
                      assetId={c.coverAssetId}
                      alt={c.productName}
                      categoryName={c.categoryName}
                      className="row-thumb"
                    />
                    <div style={{ minWidth: 0 }}>
                      <div className="strong">{c.productName}</div>
                      {c.variantName && c.variantName !== '默认规格' ? (
                        <div className="tiny muted">{c.variantName}</div>
                      ) : null}
                    </div>
                    <span className="bundle-contents-qty">× {c.quantity}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="tiny muted">暂无成分说明</div>
            )}
          </div>
        ) : null}

        <div className="row">
          <div className="detail-price-block">
            {hasPromo ? (
              <div className="menu-promotion">
                <del className="list-price">{formatMoney(item.list_price_minor!, item.currency)}</del>
                <span>
                  {item.promotion_rate !== undefined
                    ? `${item.promotion_rate / 1000} 折`
                    : `直降 ${formatAmountOnly(item.list_price_minor! - item.price_minor, item.currency)}`}
                </span>
              </div>
            ) : null}
            <Money minor={item.price_minor} currency={item.currency} big />
          </div>
          <span className="spacer" />
          <QtyStepper value={qty} min={1} max={max} onChange={onQtyChange} />
        </div>

        {item.purchase_limit ? (
          <div className="small muted">每单限购 {item.purchase_limit} 件</div>
        ) : null}
      </div>
    </Modal>
  );
}
