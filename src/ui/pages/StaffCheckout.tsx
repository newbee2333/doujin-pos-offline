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

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
    </svg>
  );
}

export default function StaffCheckoutPage() {
  const eventId = useApp((s) => s.currentEventId);
  const showToast = useApp((s) => s.showToast);
  const [keyword, setKeyword] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [lines, setLines] = useState<PickedLine[]>([]);
  const [methodId, setMethodId] = useState('');
  const [tendered, setTendered] = useState('');
  /** tendered 当前是否等于「系统按应付金额填的」。用户手改过就不再加自动覆盖。 */
  const [tenderedAuto, setTenderedAuto] = useState(true);
  const [note, setNote] = useState('');
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
  const totalUnits = lines.reduce((a, l) => a + l.quantity, 0);
  const cashMethod = methods.data?.find((m) => m.id === methodId);
  const categories = catsList.data ?? [];

  // 选了现金就预填实收，并且跟着应付金额走。
  // 原来只在 tendered 为空时预填：加第一件时预填 48，再加到四件变成 213，
  // 输入框却还停在 48 —— 点「确认收款」会被 staffDirectSale 的
  // 「实收金额小于应付金额」挡下来，而屏幕上完全看不出为什么。
  // 现在记录这份值是不是自动填的：用户手改过就不再覆盖。
  useEffect(() => {
    if (!cashMethod || totalMinor <= 0) return;
    if (tendered && !tenderedAuto) return;
    const next = minorToInput(totalMinor, currency);
    setTendered(next);
    setTenderedAuto(true);
  }, [cashMethod, totalMinor, currency, tendered, tenderedAuto]);

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

  function setLineQty(variantId: string, quantity: number) {
    if (quantity <= 0) {
      setLines((prev) => prev.filter((l) => l.variantId !== variantId));
      return;
    }
    setLines((prev) => prev.map((l) => (l.variantId === variantId ? { ...l, quantity } : l)));
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
        note: note.trim() || null,
        operationId: newId()
      });
      const rows = await getOrderDetail(orderId);
      setLastOrder({
        number: rows?.order.human_readable_number ?? 0,
        change: rows?.payment?.change_minor ?? 0
      });
      setLines([]);
      setTendered('');
      setTenderedAuto(true);
      setNote('');
      showToast('已记录收款');
      configs.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  // 找零并到实收输入框右边（原来自己占一行）。钉底区整块要塞进视口，
  // 在 iPad 横屏最矮的 1024×768 上，省下的这一行就是订单明细能多露一行。
  const change = useMemo(() => {
    if (!tendered || totalMinor <= 0) return { text: '', tone: '' };
    try {
      const t = parseAmountToMinor(tendered, currency);
      if (t < totalMinor) return { text: '实收不足', tone: 'danger' };
      return { text: `找零 ${formatMoney(t - totalMinor, currency)}`, tone: '' };
    } catch {
      return { text: '金额格式不正确', tone: 'danger' };
    }
  }, [tendered, totalMinor, currency]);

  if (!eventId) return <ErrorBox message="请先选择展会" />;
  if (configs.loading) {
    return (
      <div className="center-page">
        <Spinner label="读取商品…" />
      </div>
    );
  }

  return (
    <div className="page page-cols">
      <div className="page-head">
        <h1>摊主收银</h1>
        {event.data ? (
          <span className={`badge ${eventActive ? 'ok' : 'warn'}`}>
            {event.data.name} · {eventActive ? '进行中' : event.data.status === 'closed' ? '已收摊' : '草稿'}
          </span>
        ) : null}
      </div>

      {event.data && !eventActive ? (
        <div className="notice danger" style={{ marginBottom: 12 }}>
          本场展会当前是「{event.data.status === 'closed' ? '已收摊' : '草稿'}」状态，不能开单。
          请先到「展会配置」把展会开起来。
        </div>
      ) : null}

      {/* 左商品 / 右订单栏。右侧那一栏是常驻的，收银不用先点进购物车再翻回来。
          pos-layout 给两栏一个共同的高度预算（见 styles.css 的 --panel-h），
          商品区内部滚动、页面不滚，确认收款按钮才始终落在视口里。 */}
      <div className="cols-side pos-layout">
        <div className="stack">
          <div className="pos-toolbar">
            <div className="pos-search">
              <SearchIcon />
              <input
                type="search"
                placeholder="搜索商品名或 SKU"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                aria-label="搜索商品"
              />
            </div>
            <span className="small muted nowrap">共 {filtered.length} 项</span>
          </div>

          <div className="chip-row pos-chips">
            <button
              type="button"
              className={`chip ${categoryFilter === '' ? 'active' : ''}`}
              onClick={() => setCategoryFilter('')}
            >
              全部
            </button>
            {categories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                className={`chip ${categoryFilter === cat.id ? 'active' : ''}`}
                onClick={() => setCategoryFilter(cat.id)}
              >
                {cat.name}
                {cat.hidden ? '（隐藏）' : ''}
              </button>
            ))}
          </div>

          <div className="pos-grid">
            {filtered.map((c) => {
              const avail = availableMap.get(c.variant_id);
              const inCart = lines.find((l) => l.variantId === c.variant_id)?.quantity ?? 0;
              const price = c.product_type === 'gift' ? 0 : Number(c.event_price_minor ?? 0);
              const left = c.product_type === 'non_stock' ? null : (avail ?? 0) - inCart;
              const soldOut = left !== null && left <= 0;
              return (
                <div key={c.variant_id} className={`pos-card ${soldOut ? 'sold-out' : ''}`}>
                  <button
                    type="button"
                    className="pos-cover"
                    onClick={() => !soldOut && addLine(c)}
                    disabled={soldOut}
                    aria-label={`加入 ${c.product_name}`}
                  >
                    <AssetImage assetId={coverByProduct.get(c.product_id) ?? null} alt={c.product_name} />
                    {c.product_type === 'non_stock' ? (
                      <span className="stock-tag">不计库存</span>
                    ) : (
                      <span className={`stock-tag ${soldOut ? 'danger' : left !== null && left <= 3 ? 'warn' : ''}`}>
                        {soldOut ? '售罄' : `余 ${left}`}
                      </span>
                    )}
                    {soldOut ? <span className="sold-veil">售罄</span> : null}
                  </button>

                  <div className="pos-card-name">{c.product_name}</div>
                  {c.variant_name !== '默认规格' ? (
                    <div className="pos-card-sub">{c.variant_name}</div>
                  ) : null}

                  <div className="pos-card-foot">
                    <span className="price">{formatMoney(price, currency)}</span>
                    {inCart > 0 ? (
                      <span className="pos-count" title={`本单已加 ${inCart} 件`}>
                        ×{inCart}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="pos-add"
                        disabled={soldOut}
                        onClick={() => addLine(c)}
                        aria-label={`加入 ${c.product_name}`}
                      >
                        +
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {!filtered.length ? <p className="muted small">没有匹配的商品。</p> : null}
        </div>

        <aside className="side-panel">
          <div className="side-panel-head">
            <span className="strong">本次订单</span>
            <span className="badge">{totalUnits} 件</span>
            <span className="spacer" />
            {lines.length ? (
              <button type="button" className="small ghost" onClick={() => setLines([])} disabled={busy}>
                清空
              </button>
            ) : null}
          </div>

          <div className="side-panel-body">
            {!lines.length ? (
              <p className="muted small" style={{ margin: 0 }}>
                还没有加入商品。点左边的封面或「+」加入本单。
              </p>
            ) : (
              lines.map((l) => (
                <div key={l.variantId} className="pos-line">
                  <div className="pos-line-main">
                    <div className="pos-line-name">{l.name}</div>
                    <div className="pos-line-sub">
                      × {l.quantity} · {formatMoney(l.priceMinor, currency)}
                    </div>
                    <QtyStepper
                      value={l.quantity}
                      min={0}
                      onChange={(v) => setLineQty(l.variantId, v)}
                    />
                  </div>
                  <div className="pos-line-amt">{formatMoney(l.priceMinor * l.quantity, currency)}</div>
                </div>
              ))
            )}
          </div>

          <div className="side-panel-foot">
            <div className="row">
              <span className="strong">合计</span>
              <span className="spacer" />
              <span className="big-price total-price">{formatMoney(totalMinor, currency)}</span>
            </div>

            <div className="field-label">收款方式</div>
            {(methods.data ?? []).length ? (
              <div className="seg">
                {(methods.data ?? []).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`seg-item ${methodId === m.id ? 'active' : ''}`}
                    onClick={() => setMethodId(m.id)}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            ) : (
              <div className="notice danger">本场展会没有可用的收款方式，请先到「展会配置」补齐。</div>
            )}

            {cashMethod?.type === 'cash' ? (
              <>
                <div className="field-label">
                  <span>实收金额（{currency === 'CNY' ? '元' : '日元'}）</span>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      if (totalMinor <= 0) return;
                      setTendered(minorToInput(totalMinor, currency));
                      setTenderedAuto(true);
                    }}
                  >
                    按应付金额
                  </button>
                </div>
                <div className="input-line">
                  <input
                    type="text"
                    value={tendered}
                    onChange={(e) => {
                      setTendered(e.target.value);
                      setTenderedAuto(false);
                    }}
                    placeholder={currency === 'CNY' ? '0.00' : '0'}
                    aria-label="实收金额"
                  />
                  {change.text ? <span className={`aside ${change.tone}`}>{change.text}</span> : null}
                </div>
              </>
            ) : null}

            <div className="inline-field">
              <span className="label">备注</span>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="可选，例如：预留到 15:00"
                aria-label="订单备注"
              />
            </div>

            <ErrorBox message={error} />

            <button
              className="primary block"
              style={{ minHeight: 52 }}
              disabled={busy || !lines.length || !methodId || !eventActive}
              onClick={submit}
            >
              {busy ? <span className="spinner" /> : null}
              确认收款{totalMinor > 0 ? ` ${formatMoney(totalMinor, currency)}` : ''}
            </button>

            {lastOrder ? (
              <div className="notice ok">
                订单 #{lastOrder.number} 已成交
                {lastOrder.change > 0 ? `，找零 ${formatMoney(lastOrder.change, currency)}` : ''}
              </div>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
