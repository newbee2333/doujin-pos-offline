import { useRef, useState } from 'react';
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
  setEventPaymentMethods,
  setVariantsEnabled,
  updateConfig,
  updateEvent,
  updatePaymentMethod
} from '../../services/events';
import { createAsset, createProduct, listCategories, listProducts } from '../../services/catalog';
import { initializeStock } from '../../services/inventory';
import { hashBytes, preparePaymentQr } from '../../domain/image';
import { setCurrentEventId } from '../../services/system';
import { formatMoney, minorToInput, parseAmountToMinor } from '../../domain/money';
import { errorMessage, useApp } from '../../store';
import AssetEditor from '../AssetEditor';
import { ErrorBox, Field, Spinner, useAsync } from '../components';
import AddProductsModal from './AddProductsModal';
import type { Currency } from '../../domain/types';

function formatDateInput(value: string) {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 4) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 4)}/${digits.slice(4)}`;
  return `${digits.slice(0, 4)}/${digits.slice(4, 6)}/${digits.slice(6)}`;
}

function DateInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const pickerRef = useRef<HTMLInputElement>(null);
  const pickerValue = /^\d{4}\/\d{2}\/\d{2}$/.test(value) ? value.replaceAll('/', '-') : '';

  return (
    <div className="date-input-control">
      <input
        className="date-input-text"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        maxLength={10}
        placeholder="yyyy/mm/dd"
        value={value}
        onChange={(e) => onChange(formatDateInput(e.target.value))}
      />
      <input
        ref={pickerRef}
        className="date-input-native"
        type="date"
        tabIndex={-1}
        value={pickerValue}
        onChange={(e) => onChange(e.target.value.replaceAll('-', '/'))}
      />
      <button
        className="date-input-picker"
        type="button"
        aria-label="打开日期选择器"
        title="打开日期选择器"
        onClick={() => {
          const picker = pickerRef.current;
          if (!picker) return;
          if (typeof picker.showPicker === 'function') picker.showPicker();
          else picker.click();
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 2v3M17 2v3M3.5 9h17M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z" />
        </svg>
      </button>
    </div>
  );
}

export default function StaffEventsPage() {
  const showToast = useApp((s) => s.showToast);
  const currentEventId = useApp((s) => s.currentEventId);
  const setCurrentEvent = useApp((s) => s.setCurrentEvent);
  const events = useAsync(() => listEvents(), []);
  const [creating, setCreating] = useState(false);

  const currentId = currentEventId ?? events.data?.[0]?.id ?? null;

  return (
    <div className="content">
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
              <DateInput value={start} onChange={setStart} />
            </Field>
            <Field label="结束日期">
              <DateInput value={end} onChange={setEnd} />
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
              setBusy(true);
              setError(null);
              try {
                const id = await createEvent({
                  name,
                  booth_number: booth || null,
                  currency,
                  start_date: start ? start.replaceAll('/', '-') : null,
                  end_date: end ? end.replaceAll('/', '-') : null
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
  const [ready, setReady] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState('');
  // 支付方式开关使用乐观状态：避免写入完成前复选框回弹
  const [methodOn, setMethodOn] = useState<Record<string, boolean>>({});
  const [templateOn, setTemplateOn] = useState<Record<string, boolean>>({});
  const [showAdd, setShowAdd] = useState(false);

  if (event.loading || configs.loading) {
    return (
      <div className="center-page">
        <Spinner label="读取展会配置…" />
      </div>
    );
  }
  const ev = event.data;
  if (!ev) return <ErrorBox message="展会不存在" />;
  const currency = ev.currency;

  const enabledIds = (configs.data ?? []).filter((c) => c.enabled === 1).map((c) => c.variant_id);
  const notAdded = (products.data ?? []).flatMap((p) =>
    p.variants.filter((v) => !enabledIds.includes(v.id) && (!categoryFilter || p.category_id === categoryFilter))
      .map((v) => ({ ...v, pname: p.name, ptype: p.type }))
  );

  async function refreshReady() {
    setReady(await checkEventReady(eventId));
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
              await addVariantsToEvent(
                eventId,
                notAdded.map((v) => v.id)
              );
              configs.reload();
              showToast(`已加入 ${notAdded.length} 个规格`);
            }}
            disabled={!notAdded.length}
            title={notAdded.length ? undefined : '没有未加入本场的规格'}
          >
            全部加入本场
          </button>
          {categoryFilter ? (
            <>
              <button
                onClick={async () => {
                  await bulkSetCategoryEnabled(eventId, categoryFilter, true);
                  configs.reload();
                }}
              >
                本分类上架
              </button>
              <button
                onClick={async () => {
                  await bulkSetCategoryEnabled(eventId, categoryFilter, false);
                  configs.reload();
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
                  <input
                    type="checkbox"
                    onChange={(e) => {
                      setSelected(e.target.checked ? new Set((configs.data ?? []).map((c) => c.variant_id)) : new Set());
                    }}
                  />
                </th>
                <th>商品</th>
                <th>本场价格</th>
                <th className="num">初始库存</th>
                <th className="num">可用</th>
                <th>限购</th>
                <th>游客可见</th>
                <th>精确库存</th>
                <th>上架</th>
              </tr>
            </thead>
            <tbody>
              {!(configs.data && configs.data.length) ? (
                <tr>
                  <td colSpan={9} className="center" style={{ padding: '36px 12px' }}>
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
              {configs.data?.map((c) => (
                <tr key={c.variant_id}>
                  <td>
                    <input
                      type="checkbox"
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
                    {c.product_name}
                    <div className="tiny muted">
                      {c.variant_name}
                      {c.sku ? ` · ${c.sku}` : ''} · {c.product_type}
                    </div>
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
                      '—'
                    ) : c.initial_stock === null ? (
                      <input
                        type="number"
                        min={0}
                        placeholder="0"
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
                      c.initial_stock
                    )}
                  </td>
                  <td className="num">
                    {c.physical_stock === null ? '—' : c.physical_stock - (c.reserved_stock ?? 0)}
                  </td>
                  <td>
                    <input
                      type="number"
                      min={1}
                      defaultValue={c.purchase_limit ?? ''}
                      placeholder="不限"
                      style={{ maxWidth: 80 }}
                      onBlur={(e) =>
                        void updateConfig(eventId, c.variant_id, {
                          purchase_limit: e.target.value ? Number(e.target.value) : null
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      defaultChecked={c.kiosk_visible === 1}
                      onChange={(e) =>
                        void updateConfig(eventId, c.variant_id, { kiosk_visible: e.target.checked ? 1 : 0 })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      defaultChecked={c.show_exact_stock === 1}
                      onChange={(e) =>
                        void updateConfig(eventId, c.variant_id, { show_exact_stock: e.target.checked ? 1 : 0 })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      defaultChecked={c.enabled === 1}
                      onChange={(e) =>
                        void updateConfig(eventId, c.variant_id, { enabled: e.target.checked ? 1 : 0 }).then(() =>
                          configs.reload()
                        )
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selected.size ? (
          <div className="row" style={{ marginTop: 8 }}>
            <button
              onClick={async () => {
                await setVariantsEnabled(eventId, Array.from(selected), true);
                configs.reload();
              }}
            >
              批量上架
            </button>
            <button
              onClick={async () => {
                await setVariantsEnabled(eventId, Array.from(selected), false);
                configs.reload();
              }}
            >
              批量下架
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
          currency={currency}
          notAdded={notAdded}
          categories={cats.data ?? []}
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            configs.reload();
            products.reload();
            setShowAdd(false);
          }}
        />
      ) : null}
    </>
  );
}
