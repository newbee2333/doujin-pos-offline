import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  activateEvent,
  addVariantsToEvent,
  bulkSetCategoryEnabled,
  checkEventReady,
  closeEvent,
  createEvent,
  deleteDraftEvent,
  duplicateEvent,
  getEvent,
  getEventPaymentMethods,
  listEventConfigs,
  listEvents,
  listPaymentMethods,
  reopenEvent,
  removeVariantsFromEvent,
  setEventPaymentMethods,
  setVariantsEnabled,
  updateConfig,
  updateEvent,
  updatePaymentMethod
} from '../../services/events';
import { createAsset, listCategories, listProducts } from '../../services/catalog';
import { getVariantSales } from '../../services/reports';
import { initializeStock } from '../../services/inventory';
import { hashBytes, preparePaymentQr } from '../../domain/image';
import { setCurrentEventId } from '../../services/system';
import { formatMoney, minorToInput, parseAmountToMinor } from '../../domain/money';
import { errorMessage, useApp } from '../../store';
import AssetEditor from '../AssetEditor';
import { validateEventDates } from '../../domain/event-dates';
import { AdjustStockModal } from '../AdjustStockModal';
import { AssetImage, ErrorBox, Field, InfoDot, Spinner, useAsync } from '../components';
import AddProductsModal from './AddProductsModal';
import { ProductEditorModal } from '../ProductEditor';
import type { Currency } from '../../domain/types';
import type { ProductWithVariants } from '../../services/catalog';

export default function StaffEventsPage() {
  const showToast = useApp((s) => s.showToast);
  const currentEventId = useApp((s) => s.currentEventId);
  const setCurrentEvent = useApp((s) => s.setCurrentEvent);
  const events = useAsync(() => listEvents(), []);
  const [creating, setCreating] = useState(false);

  const currentId = currentEventId ?? events.data?.[0]?.id ?? null;

  return (
    <div className="page">
      <div className="row">
        <h1 style={{ margin: 0 }}>展会配置</h1>
        <span className="spacer" />
        <select
          value={currentId ?? ''}
          onChange={(e) => setCurrentEvent(e.target.value || null)}
          style={{ maxWidth: 260 }}
        >
          <option value="">选择展会</option>
          {events.data?.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <button
          className="primary"
          onClick={() => {
            setCreating(true);
          }}
        >
          新建展会
        </button>
      </div>

      {creating ? (
        <CreateEventModal
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            setCurrentEvent(id);
            await setCurrentEventId(id);
            events.reload();
          }}
        />
      ) : null}

      {!currentId ? (
        <div className="notice info" style={{ marginTop: 12 }}>
          还没有展会。新建一个展会，加入商品并设置本场价格与库存后即可开场。
        </div>
      ) : (
        <EventDetail key={currentId} eventId={currentId} onChanged={events.reload} showToast={showToast} />
      )}
    </div>
  );
}

/* 展会日期的合理范围。
   浏览器的日期框年份段允许键入 6 位数（HTML 原生行为，规格上限 275760 年），
   不是表单代码的 bug；用 min/max 圈住可选范围，提交时再校验兜底。 */
const EVENT_DATE_MIN = '2020-01-01';
const EVENT_DATE_MAX = '2035-12-31';

function CreateEventModal({
  onClose,
  onCreated
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [booth, setBooth] = useState('');
  const [currency, setCurrency] = useState<Currency>('CNY');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>新建展会</h2>
        <div className="col">
          <Field label="展会名称">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 Comicup 2026" />
          </Field>
          <div className="grid cols-2">
            <Field label="摊位号">
              <input value={booth} onChange={(e) => setBooth(e.target.value)} />
            </Field>
            <Field label="币种（产生订单后不可更改）">
              <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
                <option value="CNY">人民币 / CNY</option>
                <option value="JPY">日元 / JPY</option>
              </select>
            </Field>
            <Field label="开始日期（当地日期）">
              <input type="date" min={EVENT_DATE_MIN} max={EVENT_DATE_MAX} value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="结束日期">
              <input type="date" min={EVENT_DATE_MIN} max={EVENT_DATE_MAX} value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
          <ErrorBox message={error} />
        </div>
        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || !name.trim()}
            onClick={async () => {
              // 日期校验（原生年份段允许键入 6 位数，提交时兜底）
              const dateError = validateEventDates(start || null, end || null);
              if (dateError) {
                setError(dateError);
                return;
              }
              setBusy(true);
              setError(null);
              try {
                const id = await createEvent({
                  name,
                  booth_number: booth || null,
                  currency,
                  start_date: start || null,
                  end_date: end || null
                });
                onCreated(id);
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}

function EventDetail({
  eventId,
  onChanged,
  showToast
}: {
  eventId: string;
  onChanged: () => void;
  showToast: (m: string) => void;
}) {
  const event = useAsync(() => getEvent(eventId), [eventId]);
  const navigate = useNavigate();
  const configs = useAsync(() => listEventConfigs(eventId), [eventId]);
  const methods = useAsync(() => listPaymentMethods(), []);
  const eventMethods = useAsync(() => getEventPaymentMethods(eventId), [eventId]);
  const products = useAsync(() => listProducts({ archived: false }), []);
  const cats = useAsync(() => listCategories(true), []);
  // 本场已售。跟着 configs 一起重取：下架/上架不改销量，但库存调整和成交会改。
  const sales = useAsync(() => getVariantSales(eventId), [eventId, configs.data]);
  const [ready, setReady] = useState<string[] | null>(null);
  const [stockTarget, setStockTarget] = useState<{ variantId: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState('');
  // 支付方式开关使用乐观状态：避免写入完成前复选框回弹
  const [methodOn, setMethodOn] = useState<Record<string, boolean>>({});
  const [templateOn, setTemplateOn] = useState<Record<string, boolean>>({});
  const [pinFor, setPinFor] = useState<Record<string, boolean>>({});
  // 表格里的三个开关（游客可见 / 精确库存 / 上架）也用乐观状态，理由和支付方式那两个一样：
  // 写入是异步的，直接写 checked={c.xxx === 1} 会让方框在写入完成前弹回旧值。
  // ⚠️ 批量操作动了哪个键，就必须把那个键的乐观值清掉 ——
  // 否则用户点完「批量下架」，屏幕会拿着旧乐观值把刚写进库的结果又盖回去。
  const [visibleOn, setVisibleOn] = useState<Record<string, boolean>>({});
  const [exactOn, setExactOn] = useState<Record<string, boolean>>({});
  const [enabledOn, setEnabledOn] = useState<Record<string, boolean>>({});
  const [showAdd, setShowAdd] = useState(false);
  // 参展商品表里的「编辑」直接用「商品」页那套完整编辑器；
  // 新建也走同一个弹窗（不再有展会页专属的精简表单）
  const [editingProduct, setEditingProduct] = useState<ProductWithVariants | null>(null);
  const [creatingProduct, setCreatingProduct] = useState(false);

  // 参展商品表的行来自 event_variant_configs，那里只有 product_id，
  // 没有封面和分类。回商品列表建一次索引，别每一行 find 三遍。
  const productById = useMemo(
    () => new Map((products.data ?? []).map((p) => [p.id, p])),
    [products.data]
  );
  const soldById = useMemo(
    () => new Map((sales.data ?? []).map((r) => [r.variant_id, Number(r.sold_units)])),
    [sales.data]
  );

  // 只在「第一次还没有数据」时占屏。
  // 原来是 `event.loading || configs.loading`，而 useAsync 每次 reload 都会把 loading 置 true ——
  // 于是每改一个开关（上架 / 游客可见 / 限购）整张表都会先被 Spinner 顶掉再重建。
  // 在 iPad 上表现为「点一下，表格闪一下」，同时把正在编辑的输入框和焦点一起丢掉。
  if ((event.loading && !event.data) || (configs.loading && !configs.data)) {
    return (
      <div className="center-page">
        <Spinner label="读取展会配置…" />
      </div>
    );
  }
  const ev = event.data;
  if (!ev) return <ErrorBox message="展会不存在" />;
  const currency = ev.currency;
  const cfgRows = configs.data ?? [];

  const enabledIds = cfgRows.filter((c) => c.enabled === 1).map((c) => c.variant_id);
  const notAdded = (products.data ?? []).flatMap((p) =>
    p.variants
      .filter((v) => !enabledIds.includes(v.id) && (!categoryFilter || p.category_id === categoryFilter))
      .map((v) => ({
        ...v,
        pname: p.name,
        ptype: p.type,
        cover: p.cover_asset_id,
        category: p.category_name
      }))
  );

  async function refreshReady() {
    setReady(await checkEventReady(eventId));
  }

  /**
   * 批量改上架状态。
   *
   * 原来这里两件事都缺：
   *  1. 没有 try/catch —— 写失败会变成一条 unhandled rejection，屏幕上什么都不发生；
   *  2. 没有清乐观值 —— 而「全选」那个表头复选框是**非受控**的，
   *     只要用户中途取消过某一行，它就仍然显示已勾选，于是「批量下架」静默地只作用于一部分行。
   *     用户看到的是「批量下架只下架了几个」，从界面上完全看不出为什么。
   */
  async function bulkEnabled(ids: string[], enabled: boolean, label: string) {
    if (!ids.length) {
      showToast('先勾选要操作的规格');
      return;
    }
    try {
      await setVariantsEnabled(eventId, ids, enabled);
      setEnabledOn({});
      configs.reload();
      showToast(`${label}：${ids.length} 个规格已${enabled ? '上架' : '下架'}`);
    } catch (e) {
      showToast(errorMessage(e));
    }
  }

  /**
   * 从本场移除（不是下架）。
   *
   * 之前只有上下架 —— 不在本场卖的商品会一直留在表里占一行，
   * 想清干净只能靠「删除展会」或者改库。移除是整行去掉。
   * 已经卖出去的件数要提前说出来：报表与库存流水都不受影响，免得摊主以为会丢账。
   */
  async function removeFromEvent(ids: string[]) {
    if (!ids.length) {
      showToast('先勾选要移除的规格');
      return;
    }
    const sold = ids.reduce((a, id) => a + (soldById.get(id) ?? 0), 0);
    const what = ids.length === 1 ? `「${cfgRows.find((c) => c.variant_id === ids[0])?.product_name ?? '这件'}」` : `选中的 ${ids.length} 个规格`;
    const soldNote = sold > 0 ? `\n本场已售 ${sold} 件：报表与库存流水都会保留，不会丢账。` : '';
    if (
      !window.confirm(
        `把${what}从本场移除？\n本场价格、库存开关、上下架状态会一起删掉。\n` +
          `（只是不在本场卖了，商品本身不受影响；库存流水保留，以后再加回来还在。）${soldNote}`
      )
    ) {
      return;
    }
    try {
      await removeVariantsFromEvent(eventId, ids);
      setSelected((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      setEnabledOn({});
      configs.reload();
      showToast(`已从本场移除 ${ids.length} 个规格`);
    } catch (e) {
      showToast(errorMessage(e));
    }
  }

  async function run(fn: () => Promise<void>, ok: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      showToast(ok);
      event.reload();
      configs.reload();
      onChanged();
      setReady(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row">
          <h2 style={{ margin: 0 }}>{ev.name}</h2>
          <span
            className={`badge ${ev.status === 'active' ? 'ok' : ev.status === 'closed' ? 'danger' : ''}`}
          >
            {ev.status === 'active' ? '进行中' : ev.status === 'closed' ? '已收摊' : '草稿'}
          </span>
          <span className="spacer" />
          {ev.status === 'draft' ? (
            <button
              className="primary"
              disabled={busy}
              onClick={() => run(async () => activateEvent(eventId), '已开场')}
            >
              开场
            </button>
          ) : null}
          {ev.status === 'active' ? (
            <button
              disabled={busy}
              onClick={() => run(async () => closeEvent(eventId), '已收摊')}
            >
              收摊
            </button>
          ) : null}
          {ev.status === 'closed' ? (
            <button
              disabled={busy}
              onClick={() => {
                const reason = window.prompt('重新打开已收摊展会的原因（会记入审计）：');
                if (reason) run(async () => reopenEvent(eventId, reason), '已重新打开');
              }}
            >
              重新打开
            </button>
          ) : null}
          <button
            disabled={busy}
            onClick={() => {
              const n = window.prompt('副本名称：', `${ev.name}（副本）`);
              if (n) run(async () => void (await duplicateEvent(eventId, n)), '已复制（仅配置）');
            }}
          >
            复制展会
          </button>
          <button
            className="danger"
            disabled={busy || ev.status !== 'draft'}
            onClick={() => {
              if (window.confirm('删除该草稿展会？已有业务数据的展会不能删除。'))
                run(async () => deleteDraftEvent(eventId), '已删除');
            }}
          >
            删除
          </button>
        </div>

        <div className="grid cols-2" style={{ marginTop: 12 }}>
          <Field label="摊位号">
            <input
              defaultValue={ev.booth_number ?? ''}
              onBlur={(e) => void updateEvent(eventId, { booth_number: e.target.value })}
            />
          </Field>
          <Field label="币种">
            <select
              value={ev.currency}
              disabled={ev.status !== 'draft'}
              onChange={(e) => void updateEvent(eventId, { currency: e.target.value as Currency })}
            >
              <option value="CNY">人民币 / CNY</option>
              <option value="JPY">日元 / JPY</option>
            </select>
          </Field>
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          <button className="small" onClick={refreshReady}>
            检查开场条件
          </button>
          {ready ? (
            ready.length ? (
              <div className="notice" style={{ flex: 1 }}>
                {ready.join('；')}
              </div>
            ) : (
              <div className="notice ok" style={{ flex: 1 }}>
                满足开场条件
              </div>
            )
          ) : null}
        </div>
        <ErrorBox message={error} />
      </div>

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>参展商品</h2>
          <span className="spacer" />
          <button onClick={() => navigate('/preview')} title="不锁定后台，可切换屏幕尺寸">
            预览菜单效果
          </button>
          <button className="primary" onClick={() => setShowAdd(true)}>
            + 添加商品
          </button>
        </div>
        <p className="tiny muted" style={{ marginTop: 6, marginBottom: 0 }}>
          添加商品时可以选择已有规格一键加入，也可以现场新建；本场价格和初始库存在这张表里逐项设置。
        </p>
        <div className="row" style={{ marginTop: 10 }}>
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} style={{ maxWidth: 200 }}>
            <option value="">全部分类</option>
            {cats.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            value=""
            onChange={async (e) => {
              const variantId = e.target.value;
              if (!variantId) return;
              await addVariantsToEvent(eventId, [variantId]);
              configs.reload();
            }}
            style={{ maxWidth: 320 }}
          >
            <option value="">加入单个已有规格…</option>
            {notAdded.map((v) => (
              <option key={v.id} value={v.id}>
                {v.pname}（{v.name}）
              </option>
            ))}
          </select>
          <button
            onClick={async () => {
              try {
                await addVariantsToEvent(
                  eventId,
                  notAdded.map((v) => v.id)
                );
                configs.reload();
                showToast(`已加入 ${notAdded.length} 个规格`);
              } catch (e) {
                showToast(errorMessage(e));
              }
            }}
            disabled={!notAdded.length}
            title={notAdded.length ? undefined : '没有未加入本场的规格'}
          >
            全部加入本场
          </button>
          {categoryFilter ? (
            <>
              {/* 整类上下架也走同一个「清乐观值 + 提示」的路径，
                  否则整类的行内方框会停在旧值上，看起来和批量按钮一样「没反应」。 */}
              <button
                onClick={async () => {
                  try {
                    await bulkSetCategoryEnabled(eventId, categoryFilter, true);
                    setEnabledOn({});
                    configs.reload();
                    showToast('本分类已上架');
                  } catch (e) {
                    showToast(errorMessage(e));
                  }
                }}
              >
                本分类上架
              </button>
              <button
                onClick={async () => {
                  try {
                    await bulkSetCategoryEnabled(eventId, categoryFilter, false);
                    setEnabledOn({});
                    configs.reload();
                    showToast('本分类已下架');
                  } catch (e) {
                    showToast(errorMessage(e));
                  }
                }}
              >
                本分类下架
              </button>
            </>
          ) : null}
        </div>

        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th>
                  {/* 受控 + 三态。
                      原来这个框是非受控的：用户取消掉某一行之后，它仍然显示「已勾选」，
                      于是「批量下架」只作用于剩下的那几行 —— 屏幕上看起来就是
                      「批量下架只下架了一部分」，而且没有任何提示说明为什么。
                      indeterminate 只能走 DOM（React 没有这个 prop），所以放在 ref 里设。 */}
                  <input
                    type="checkbox"
                    aria-label="全选参展商品"
                    checked={selected.size > 0 && selected.size === cfgRows.length}
                    ref={(el) => {
                      if (el) el.indeterminate = selected.size > 0 && selected.size < cfgRows.length;
                    }}
                    onChange={(e) => {
                      setSelected(e.target.checked ? new Set(cfgRows.map((c) => c.variant_id)) : new Set());
                    }}
                  />
                </th>
                <th>商品</th>
                <th>本场价格</th>
                <th className="num">
                  库存 · 已售
                  <InfoDot text="「剩」= 实际库存 − 已预留（待付款占用的那部分），也就是现在还能卖多少；「已售」= 本场已成交订单的件数，口径与报表页的商品排行一致；「备」= 开场时录入的初始库存，之后不会再变（补货、盘点、报损都只改实际库存）。" />
                </th>
                <th>限购</th>
                <th>游客可见</th>
                <th>
                  精确库存
                  <InfoDot text="勾选后，这一项在游客菜单里直接显示「剩 N」。不勾则只在少量或售罄时提示（有货 / 少量 / 售罄）。" />
                </th>
                <th>上架</th>
              </tr>
            </thead>
            <tbody>
              {!cfgRows.length ? (
                <tr>
                  <td colSpan={8} className="center" style={{ padding: '36px 12px' }}>
                    <div className="muted">
                      还没有参展商品。点击右上角「+ 添加商品」，可以现场新建也可以从已有商品加入。
                    </div>
                    <div style={{ marginTop: 10 }}>
                      <button className="primary" onClick={() => setShowAdd(true)}>
                        + 添加商品
                      </button>
                      <span className="spacer" style={{ display: 'inline-block', width: 12 }} />
                      <button
                        onClick={() => {
                          // 走批量加入：等同现有"全部加入本场"
                          if (notAdded.length) {
                            void addVariantsToEvent(eventId, notAdded.map((v) => v.id)).then(() => configs.reload());
                          }
                        }}
                        disabled={!notAdded.length}
                      >
                        全部加入本场（{notAdded.length}）
                      </button>
                    </div>
                  </td>
                </tr>
              ) : null}
              {cfgRows.map((c) => (
                <tr key={c.variant_id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${c.product_name}`}
                      checked={selected.has(c.variant_id)}
                      onChange={(e) => {
                        const s = new Set(selected);
                        if (e.target.checked) s.add(c.variant_id);
                        else s.delete(c.variant_id);
                        setSelected(s);
                      }}
                    />
                  </td>
                  <td>
                    <span className="cell-product">
                      <AssetImage
                        assetId={productById.get(c.product_id)?.cover_asset_id ?? null}
                        alt={c.product_name}
                        className="row-thumb"
                      />
                      <span className="cell-body">
                        <span className="row tight" style={{ gap: 6, alignItems: 'baseline' }}>
                          {/* .cell-name 是给验收脚本用的稳定抓手：
                              这一格里还有「编辑」按钮和收银缩略图，靠 innerText 取商品名
                              会连按钮文字一起带上。 */}
                          <span className="cell-name">{c.product_name}</span>
                          {/* 参展商品也要能改商品属性，否则在展会现场发现名字写错、
                              没配封面，就得切到「商品」页再翻回来找这一件 */}
                          <button
                            className="small ghost"
                            title="编辑这件商品的名称、封面、说明等属性"
                            onClick={() => {
                              const p = productById.get(c.product_id);
                              if (p) setEditingProduct(p);
                              else showToast('商品已被归档或删除，请到「商品」页处理');
                            }}
                          >
                            编辑
                          </button>
                          {/* 移除 = 整行从本场去掉，不是下架。
                              原来只有上下架，不在本场卖的商品会永远占着一行。 */}
                          <button
                            className="small ghost"
                            title="从本场移除（≠ 下架：整行去掉，本场价格与库存开关一起删）"
                            onClick={() => void removeFromEvent([c.variant_id])}
                          >
                            移除
                          </button>
                        </span>
                        {/* 副标题原来第三段是商品类型（normal / bundle…）。
                            类型在英文标识符里看不出意义，中文那版（「普通库存」）又和
                            「初始库存」列的语境打架——换成分类，才知道这件摆在哪一区。 */}
                        <div className="tiny muted">
                          {[
                            c.variant_name,
                            productById.get(c.product_id)?.category_name ?? '未分类',
                            c.sku
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </span>
                    </span>
                  </td>
                  <td>
                    {c.product_type === 'gift' ? (
                      <span className="badge">赠品 0</span>
                    ) : (
                      <input
                        type="text"
                        defaultValue={c.event_price_minor === null ? '' : minorToInput(c.event_price_minor, currency)}
                        placeholder={currency === 'CNY' ? '0.00' : '0'}
                        style={{ maxWidth: 120 }}
                        onBlur={async (e) => {
                          const raw = e.target.value.trim();
                          if (!raw) {
                            await updateConfig(eventId, c.variant_id, { event_price_minor: null });
                            return;
                          }
                          try {
                            const v = parseAmountToMinor(raw, currency);
                            await updateConfig(eventId, c.variant_id, { event_price_minor: v });
                          } catch (err) {
                            showToast(errorMessage(err));
                          }
                        }}
                      />
                    )}
                  </td>
                  <td className="num">
                    {c.product_type === 'non_stock' || c.product_type === 'bundle' ? (
                      // 不计库存/套装本来就没有库存，但「卖了多少」照样要看
                      <span className="tiny muted">已售 {soldById.get(c.variant_id) ?? 0}</span>
                    ) : c.initial_stock === null ? (
                      <input
                        type="number"
                        min={0}
                        placeholder="0"
                        aria-label={`${c.product_name} 初始库存`}
                        style={{ maxWidth: 90 }}
                        onBlur={async (e) => {
                          const v = Number(e.target.value || 0);
                          try {
                            await initializeStock(eventId, c.variant_id, v);
                            configs.reload();
                          } catch (err) {
                            showToast(errorMessage(err));
                          }
                        }}
                      />
                    ) : (
                      // 已设过库存：数字本身不可改，改动必须走「调整」——要选原因并记入流水。
                      //
                      // 原来这里是两列：「初始库存」和「可用」。开场之后初始库存就是一个
                      // 永远不动的数字，真正要看的「卖了多少」反而没有 —— 得翻到报表页。
                      // 现在并成一格：第一行是「剩多少 · 卖了多少」，第二行才是「带了备货多少」
                      // 和调整入口。列数没变，但营业中一眼能拿到的信息多了一条。
                      <span className="stock-cell">
                        <span className="row tight" style={{ justifyContent: 'flex-end', gap: 8 }}>
                          <span className="strong">
                            剩 {c.physical_stock === null ? '—' : c.physical_stock - (c.reserved_stock ?? 0)}
                          </span>
                          <span className="tiny muted">已售 {soldById.get(c.variant_id) ?? 0}</span>
                        </span>
                        <span className="row tight" style={{ justifyContent: 'flex-end', gap: 6 }}>
                          <span className="tiny muted">备 {c.initial_stock}</span>
                          <button
                            className="small ghost"
                            title="调整库存（需选择原因，会记入流水）"
                            onClick={() => setStockTarget({ variantId: c.variant_id, name: c.product_name })}
                          >
                            调整
                          </button>
                        </span>
                      </span>
                    )}
                  </td>
                  <td>
                    <input
                      type="number"
                      min={1}
                      defaultValue={c.purchase_limit ?? ''}
                      placeholder="不限"
                      aria-label={`${c.product_name} 限购`}
                      style={{ maxWidth: 80 }}
                      onBlur={async (e) => {
                        try {
                          await updateConfig(eventId, c.variant_id, {
                            purchase_limit: e.target.value ? Number(e.target.value) : null
                          });
                        } catch (err) {
                          showToast(errorMessage(err));
                        }
                      }}
                    />
                  </td>
                  <td>
                    {/* 受控 + 乐观值。写库是异步的，直接绑 checked={c.kiosk_visible === 1}
                        会让方框在写入期间弹回旧值 —— 这几个开关都不 reload，弹回后就再也不动了。 */}
                    <input
                      type="checkbox"
                      aria-label={`${c.product_name} 游客可见`}
                      checked={visibleOn[c.variant_id] ?? c.kiosk_visible === 1}
                      onChange={async (e) => {
                        const value = e.target.checked;
                        setVisibleOn((s) => ({ ...s, [c.variant_id]: value }));
                        try {
                          await updateConfig(eventId, c.variant_id, { kiosk_visible: value ? 1 : 0 });
                        } catch (err) {
                          setVisibleOn((s) => ({ ...s, [c.variant_id]: !value }));
                          showToast(errorMessage(err));
                        }
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${c.product_name} 精确库存`}
                      checked={exactOn[c.variant_id] ?? c.show_exact_stock === 1}
                      onChange={async (e) => {
                        const value = e.target.checked;
                        setExactOn((s) => ({ ...s, [c.variant_id]: value }));
                        try {
                          await updateConfig(eventId, c.variant_id, { show_exact_stock: value ? 1 : 0 });
                        } catch (err) {
                          setExactOn((s) => ({ ...s, [c.variant_id]: !value }));
                          showToast(errorMessage(err));
                        }
                      }}
                    />
                  </td>
                  <td>
                    {/* 上架：受控 + 乐观值。原来是非受控的 defaultChecked，
                        批量操作改了库之后行内方框不会跟着变（除非整表被重建）。 */}
                    <input
                      type="checkbox"
                      aria-label={`${c.product_name} 上架`}
                      checked={enabledOn[c.variant_id] ?? c.enabled === 1}
                      onChange={async (e) => {
                        const value = e.target.checked;
                        setEnabledOn((s) => ({ ...s, [c.variant_id]: value }));
                        try {
                          await updateConfig(eventId, c.variant_id, { enabled: value ? 1 : 0 });
                          configs.reload();
                        } catch (err) {
                          setEnabledOn((s) => ({ ...s, [c.variant_id]: !value }));
                          showToast(errorMessage(err));
                        }
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {stockTarget ? (
          <AdjustStockModal
            eventId={eventId}
            variantId={stockTarget.variantId}
            name={stockTarget.name}
            onClose={() => setStockTarget(null)}
            onDone={() => {
              setStockTarget(null);
              configs.reload();
            }}
          />
        ) : null}

        {selected.size ? (
          <div className="row" style={{ marginTop: 8 }}>
            <span className="small muted">已选 {selected.size} / {cfgRows.length}</span>
            <button onClick={() => void bulkEnabled(Array.from(selected), true, '批量上架')}>
              批量上架
            </button>
            <button onClick={() => void bulkEnabled(Array.from(selected), false, '批量下架')}>
              批量下架
            </button>
            <button onClick={() => void removeFromEvent(Array.from(selected))} title="整行从本场去掉，不是下架">
              批量移除本场
            </button>
            <button className="ghost" onClick={() => setSelected(new Set())} title="取消选择，但不改任何商品">
              取消选择
            </button>
          </div>
        ) : null}
      </div>

      <div className="card">
        <h2>支付方式</h2>
        <p className="tiny muted">
          模板启用不等于本场启用。扫码方式必须先上传收款码才能用于游客结算。
        </p>
        <div className="col">
          {methods.data?.map((m) => {
            const on = methodOn[m.id] ?? (eventMethods.data ?? []).some((x) => x.id === m.id);
            const tpl = templateOn[m.id] ?? m.enabled === 1;
            return (
              <div key={m.id} className="row" style={{ alignItems: 'flex-start' }}>
                <label className="check" style={{ minWidth: 150 }}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={async (e) => {
                      const value = e.target.checked;
                      setMethodOn((s) => ({ ...s, [m.id]: value }));
                      const ids = (eventMethods.data ?? []).map((x) => x.id);
                      const next = value
                        ? Array.from(new Set([...ids, m.id]))
                        : ids.filter((i) => i !== m.id);
                      try {
                        await setEventPaymentMethods(eventId, next);
                        eventMethods.reload();
                      } catch (err) {
                        setMethodOn((s) => ({ ...s, [m.id]: !value }));
                        showToast(errorMessage(err));
                      }
                    }}
                  />
                  {m.name}
                  <span className="badge">{m.type === 'cash' ? '现金' : m.type === 'qr_payment' ? '扫码' : '其他'}</span>
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={tpl}
                    onChange={async (e) => {
                      const value = e.target.checked;
                      setTemplateOn((s) => ({ ...s, [m.id]: value }));
                      try {
                        await updatePaymentMethod(m.id, { enabled: value });
                        methods.reload();
                      } catch (err) {
                        setTemplateOn((s) => ({ ...s, [m.id]: !value }));
                        showToast(errorMessage(err));
                      }
                    }}
                  />
                  模板启用
                </label>
                <label className="check" title="关闭后，游客下单时摊主直接点确认即可，无需输入 PIN">
                  <input
                    type="checkbox"
                    checked={pinFor[m.id] ?? m.confirm_requires_pin === 1}
                    onChange={async (e) => {
                      const value = e.target.checked;
                      setPinFor((s) => ({ ...s, [m.id]: value }));
                      try {
                        await updatePaymentMethod(m.id, { confirm_requires_pin: value });
                        methods.reload();
                      } catch (err) {
                        setPinFor((s) => ({ ...s, [m.id]: !value }));
                        showToast(errorMessage(err));
                      }
                    }}
                  />
                  确认需输 PIN
                </label>
                {m.type === 'qr_payment' ? (
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <AssetEditor
                      label="收款码"
                      assetId={m.qr_asset_id}
                      lossless
                      onChange={(id) => void updatePaymentMethod(m.id, { qr_asset_id: id }).then(() => methods.reload())}
                      onPick={async (file) => {
                        const prepared = await preparePaymentQr(file);
                        const id = await createAsset(
                          prepared.mimeType,
                          prepared.width,
                          prepared.height,
                          prepared.bytes,
                          await hashBytes(prepared.bytes)
                        );
                        await updatePaymentMethod(m.id, { qr_asset_id: id });
                        methods.reload();
                      }}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="small muted">
          本场启用 {enabledIds.length} 个规格 · 币种 {currency === 'CNY' ? '人民币 CNY' : '日元 JPY'} ·
          价格示例 {formatMoney(1200, currency)}
        </div>
      </div>

      {showAdd ? (
        <AddProductsModal
          eventId={eventId}
          notAdded={notAdded}
          onClose={() => setShowAdd(false)}
          onCreateNew={() => {
            setShowAdd(false);
            setCreatingProduct(true);
          }}
          onAdded={() => {
            configs.reload();
            products.reload();
            setShowAdd(false);
          }}
        />
      ) : null}

      {creatingProduct ? (
        <ProductEditorModal
          mode="create"
          categories={cats.data ?? []}
          defaultCurrency={currency}
          onClose={() => setCreatingProduct(false)}
          onSaved={async ({ variantId }) => {
            setCreatingProduct(false);
            // 新建完顺手加进本场——「添加商品到本场」里点的新建，目的就是加进来
            if (variantId) {
              try {
                await addVariantsToEvent(eventId, [variantId]);
                showToast('已创建并加入本场');
              } catch (e) {
                showToast(errorMessage(e));
              }
            }
            configs.reload();
            products.reload();
          }}
        />
      ) : null}

      {editingProduct ? (
        <ProductEditorModal
          mode="edit"
          product={editingProduct}
          categories={cats.data ?? []}
          onClose={() => setEditingProduct(null)}
          onSaved={() => {
            setEditingProduct(null);
            configs.reload();
            products.reload();
          }}
        />
      ) : null}
    </>
  );
}
