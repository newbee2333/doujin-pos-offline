import { useEffect, useMemo, useState } from 'react';
import { getEvent, getEventPaymentMethods, listEventConfigs } from '../../services/events';
import { getBundleComponentsBatch, listCategories, listProducts } from '../../services/catalog';
import { getOrderDetail, staffDirectSale } from '../../services/orders';
import { formatMoney, minorToInput, parseAmountToMinor } from '../../domain/money';
import { newId } from '../../domain/ids';
import { errorMessage, useApp } from '../../store';
import { AssetImage, ErrorBox, QtyStepper, Spinner, useAsync } from '../components';
import type { Currency } from '../../domain/types';

interface PickedLine {
  variantId: string;
  name: string;
  priceMinor: number;
  quantity: number;
}

export default function StaffCheckoutPage() {
  const eventId = useApp((s) => s.currentEventId);
  const showToast = useApp((s) => s.showToast);
  const [keyword, setKeyword] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [lines, setLines] = useState<PickedLine[]>([]);
  const [methodId, setMethodId] = useState('');
  const [tendered, setTendered] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastOrder, setLastOrder] = useState<{ number: number; change: number } | null>(null);

  const event = useAsync(() => (eventId ? getEvent(eventId) : Promise.resolve(null)), [eventId]);
  const configs = useAsync(
    () => (eventId ? listEventConfigs(eventId) : Promise.resolve([])),
    [eventId, lastOrder]
  );
  const methods = useAsync(
    () => (eventId ? getEventPaymentMethods(eventId) : Promise.resolve([])),
    [eventId]
  );
  // 顺手取一次商品列表，拿封面图和分类
  const productsList = useAsync(() => listProducts({}), []);
  const catsList = useAsync(() => listCategories(true), []);
  const coverByProduct = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const p of productsList.data ?? []) m.set(p.id, p.cover_asset_id);
    return m;
  }, [productsList.data]);
  const productCategory = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const p of productsList.data ?? []) m.set(p.id, p.category_id);
    return m;
  }, [productsList.data]);
  const currency: Currency = event.data?.currency ?? 'CNY';
  const eventActive = event.data?.status === 'active';

  const availableMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of configs.data ?? []) {
      if (c.physical_stock === null) continue;
      m.set(c.variant_id, c.physical_stock - (c.reserved_stock ?? 0));
    }
    return m;
  }, [configs.data]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return (configs.data ?? []).filter(
      (c) =>
        c.enabled === 1 &&
        (!kw || `${c.product_name} ${c.variant_name} ${c.sku ?? ''}`.toLowerCase().includes(kw)) &&
        (!categoryFilter || productCategory.get(c.product_id) === categoryFilter)
    );
  }, [configs.data, keyword, categoryFilter, productCategory]);

  const totalMinor = lines.reduce((a, l) => a + l.priceMinor * l.quantity, 0);
  const cashMethod = methods.data?.find((m) => m.id === methodId);

  // 选了现金就预填实收
  useEffect(() => {
    if (cashMethod && totalMinor > 0 && !tendered) {
      setTendered(minorToInput(totalMinor, currency));
    }
  }, [cashMethod, totalMinor, currency, tendered]);

  function addLine(c: { variant_id: string; product_name: string; variant_name: string; event_price_minor: number | null; product_type: string }) {
    const price = c.product_type === 'gift' ? 0 : Number(c.event_price_minor ?? 0);
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.variantId === c.variant_id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], quantity: next[idx].quantity + 1 };
        return next;
      }
      return [...prev, { variantId: c.variant_id, name: `${c.product_name}（${c.variant_name}）`, priceMinor: price, quantity: 1 }];
    });
  }

  function updateLineQty(c: { variant_id: string }, quantity: number) {
    if (quantity <= 0) {
      setLines((prev) => prev.filter((l) => l.variantId !== c.variant_id));
      return;
    }
    setLines((prev) => prev.map((l) => (l.variantId === c.variant_id ? { ...l, quantity } : l)));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const tenderedMinor = cashMethod?.type === 'cash' ? parseAmountToMinor(tendered || '0', currency) : null;
      const { orderId } = await staffDirectSale({
        eventId: eventId!,
        lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
        paymentMethodId: methodId,
        tenderedMinor,
        operationId: newId()
      });
      const rows = await getOrderDetail(orderId);
      setLastOrder({
        number: rows?.order.human_readable_number ?? 0,
        change: rows?.payment?.change_minor ?? 0
      });
      setLines([]);
      setTendered('');
      showToast('已记录收款');
      configs.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!eventId) return <ErrorBox message="请先选择展会" />;
  if (configs.loading) {
    return (
      <div className="center-page">
        <Spinner label="读取商品…" />
      </div>
    );
  }

  return (
    <div className="content">
      <h1>摊主收银</h1>
      {event.data && !eventActive ? (
        <div className="notice danger" style={{ marginBottom: 12 }}>
          本场展会当前是「{event.data.status === 'closed' ? '已收摊' : '草稿'}」状态，不能开单。
          请先到「展会配置」把展会开起来。
        </div>
      ) : null}
      {/* 商品区给足宽度，收银栏固定宽；不用 auto-fill，否则会被切成 4 列 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 14, alignItems: 'start' }}>
        <div>
          <div className="card">
            <input
              type="search"
              placeholder="搜索商品名或 SKU"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                style={{ maxWidth: 200 }}
              >
                <option value="">全部分类</option>
                {(catsList.data ?? []).map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                    {cat.hidden ? '（隐藏）' : ''}
                  </option>
                ))}
              </select>
              <span className="small muted">共 {filtered.length} 项</span>
            </div>

            <div className="menu-grid" style={{ marginTop: 10, maxHeight: '62vh', overflowY: 'auto', padding: 0 }}>
              {filtered.map((c) => {
                const avail = availableMap.get(c.variant_id);
                const inCart = lines.find((l) => l.variantId === c.variant_id)?.quantity ?? 0;
                const price = c.product_type === 'gift' ? 0 : Number(c.event_price_minor ?? 0);
                const left = c.product_type === 'non_stock' ? null : (avail ?? 0) - inCart;
                const soldOut = left !== null && left <= 0;
                return (
                  <div key={c.variant_id} className={`menu-card ${soldOut ? 'sold-out' : ''}`}>
                    <button
                      type="button"
                      className="menu-card-info"
                      onClick={() => !soldOut && addLine(c)}
                      aria-label={`加入 ${c.product_name}`}
                    >
                      <AssetImage assetId={coverByProduct.get(c.product_id) ?? null} alt={c.product_name} />
                      <div className="body">
                        <span className="name">{c.product_name}</span>
                        {c.variant_name !== '默认规格' ? (
                          <span className="tiny muted">{c.variant_name}</span>
                        ) : null}
                        <span className="price">{formatMoney(price, currency)}</span>
                        <span className="row tight">
                          <span
                            className={`badge ${
                              soldOut ? 'danger' : left !== null && left <= 3 ? 'warn' : 'ok'
                            }`}
                          >
                            {c.product_type === 'non_stock' ? '不计库存' : soldOut ? '售罄' : `可用 ${left}`}
                          </span>
                          {c.product_type === 'gift' ? <span className="badge accent">赠品</span> : null}
                        </span>
                      </div>
                    </button>
                    <div className="menu-card-action">
                      {inCart > 0 ? (
                        <QtyStepper
                          value={inCart}
                          min={0}
                          max={c.product_type === 'non_stock' ? null : avail ?? 0}
                          onChange={(v) => updateLineQty(c, v)}
                        />
                      ) : (
                        <button
                          type="button"
                          className="add-btn"
                          disabled={soldOut}
                          onClick={() => addLine(c)}
                        >
                          {soldOut ? '无可用' : '+ 加入'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {!filtered.length ? <p className="muted small">没有匹配的商品。</p> : null}
          </div>
        </div>

        <div>
          <div className="card">
            <h2>本次订单</h2>
            {!lines.length ? <p className="muted small">还没有加入商品。</p> : null}
            {lines.map((l) => (
              <div key={l.variantId} className="row" style={{ padding: '6px 0' }}>
                <div style={{ flex: 1 }}>
                  <div>{l.name}</div>
                  <div className="small muted">{formatMoney(l.priceMinor, currency)}</div>
                </div>
                <QtyStepper
                  value={l.quantity}
                  min={0}
                  onChange={(v) =>
                    setLines((prev) =>
                      v <= 0
                        ? prev.filter((x) => x.variantId !== l.variantId)
                        : prev.map((x) => (x.variantId === l.variantId ? { ...x, quantity: v } : x))
                    )
                  }
                />
                <div className="nowrap strong">{formatMoney(l.priceMinor * l.quantity, currency)}</div>
              </div>
            ))}

            <div className="row" style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
              <span className="strong">应付</span>
              <span className="spacer" />
              <span className="big-price">{formatMoney(totalMinor, currency)}</span>
            </div>

            <div className="col" style={{ marginTop: 12 }}>
              <label className="field">
                <span>收款方式</span>
                <select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
                  <option value="">请选择</option>
                  {(methods.data ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              {cashMethod?.type === 'cash' ? (
                <>
                  <label className="field">
                    <span>
                      实收金额（{currency === 'CNY' ? '元' : '日元'}）·{' '}
                      <button
                        type="button"
                        className="small ghost"
                        onClick={() => totalMinor > 0 && setTendered(minorToInput(totalMinor, currency))}
                      >
                        按应付金额
                      </button>
                    </span>
                    <input
                      type="text"
                      value={tendered}
                      onChange={(e) => setTendered(e.target.value)}
                      placeholder={currency === 'CNY' ? '0.00' : '0'}
                    />
                  </label>
                  {tendered && totalMinor > 0 ? (
                    <div className="small">
                      找零：
                      {(() => {
                        try {
                          const t = parseAmountToMinor(tendered, currency);
                          return t >= totalMinor
                            ? formatMoney(t - totalMinor, currency)
                            : '实收不足';
                        } catch {
                          return '金额格式不正确';
                        }
                      })()}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>

            <ErrorBox message={error} />

            <button
              className="primary block"
              style={{ marginTop: 12, minHeight: 52 }}
              disabled={busy || !lines.length || !methodId || !eventActive}
              onClick={submit}
            >
              {busy ? <span className="spinner" /> : null}
              确认收款并完成
            </button>

            {lastOrder ? (
              <div className="notice ok" style={{ marginTop: 10 }}>
                订单 #{lastOrder.number} 已成交
                {lastOrder.change > 0 ? `，找零 ${formatMoney(lastOrder.change, currency)}` : ''}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
