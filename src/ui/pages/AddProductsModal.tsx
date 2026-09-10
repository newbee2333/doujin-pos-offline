/**
 * 添加商品到本场：现场新建一个商品并立即加入，或从已有商品里勾选加入。
 * 不做"导入"：商品本身的图片、规格、套装等请到「商品」页维护完整。
 */
import { useMemo, useState } from 'react';
import { addVariantsToEvent } from '../../services/events';
import { createProduct } from '../../services/catalog';
import { errorMessage } from '../../store';
import { ErrorBox, Field, Modal } from '../components';
import type { Currency, ProductType } from '../../domain/types';

interface NotAddedItem {
  id: string;
  name: string;
  sku: string | null;
  pname: string;
  ptype: string;
}

export default function AddProductsModal({
  eventId,
  currency,
  notAdded,
  categories,
  onClose,
  onAdded
}: {
  eventId: string;
  currency: Currency;
  notAdded: NotAddedItem[];
  categories: { id: string; name: string }[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [tab, setTab] = useState<'existing' | 'new'>(notAdded.length ? 'existing' : 'new');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 新建并加入
  const [name, setName] = useState('');
  const [type, setType] = useState<ProductType>('normal');
  const [price, setPrice] = useState('');
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');

  // 从已有选择
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const grouped = useMemo(() => {
    const m = new Map<string, NotAddedItem[]>();
    for (const v of notAdded) {
      const arr = m.get(v.pname) ?? [];
      arr.push(v);
      m.set(v.pname, arr);
    }
    return Array.from(m.entries());
  }, [notAdded]);

  async function doExisting() {
    if (!selected.size) {
      setError('请至少勾选一个商品');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addVariantsToEvent(eventId, Array.from(selected));
      onAdded();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function doNew() {
    if (!name.trim()) {
      setError('请填写商品名称');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let priceMinor: number | null = null;
      if (price.trim()) {
        const n = Number(price);
        if (!Number.isFinite(n) || n < 0) {
          setError('默认价格必须为非负数');
          setBusy(false);
          return;
        }
        priceMinor = currency === 'CNY' ? Math.round(n * 100) : Math.round(n);
      }
      const { variantId } = await createProduct({
        name: name.trim(),
        type,
        category_id: categoryId || null,
        default_currency: currency,
        default_price_minor: priceMinor
      });
      await addVariantsToEvent(eventId, [variantId]);
      onAdded();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="添加商品到本场"
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          {tab === 'existing' ? (
            <button className="primary" disabled={busy || !selected.size} onClick={doExisting}>
              {busy ? <span className="spinner" /> : null}
              加入所选（{selected.size}）
            </button>
          ) : (
            <button className="primary" disabled={busy || !name.trim()} onClick={doNew}>
              {busy ? <span className="spinner" /> : null}
              新建并加入本场
            </button>
          )}
        </>
      }
    >
      <div className="col">
        <div className="row tight">
          <button
            className={tab === 'existing' ? 'primary' : ''}
            disabled={busy}
            onClick={() => setTab('existing')}
          >
            从已有商品（{notAdded.length}）
          </button>
          <button
            className={tab === 'new' ? 'primary' : ''}
            disabled={busy}
            onClick={() => setTab('new')}
          >
            现场新建一个
          </button>
        </div>

        {tab === 'existing' ? (
          notAdded.length ? (
            <div className="col">
              <p className="tiny muted" style={{ marginBottom: 0 }}>
                勾选要加入本场的商品，默认本场价格使用商品默认价格（之后可在「参展商品」表里逐个修改）。
              </p>
              <div className="table-wrap" style={{ maxHeight: '40vh' }}>
                <table>
                  <thead>
                    <tr>
                      <th />
                      <th>商品</th>
                      <th>规格</th>
                      <th>SKU</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grouped.flatMap(([pname, vs]) =>
                      vs.map((v) => (
                        <tr key={v.id}>
                          <td>
                            <input
                              type="checkbox"
                              checked={selected.has(v.id)}
                              onChange={(e) => {
                                const s = new Set(selected);
                                if (e.target.checked) s.add(v.id);
                                else s.delete(v.id);
                                setSelected(s);
                              }}
                            />
                          </td>
                          <td>{pname}</td>
                          <td>{v.name}</td>
                          <td className="tiny muted">{v.sku ?? '—'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="notice info">
              目前还没有可以"直接加入"的商品。切换到「现场新建一个」来创建首个商品，或到「商品」页维护图片、规格、套装等完整信息后再回来加入。
            </div>
          )
        ) : (
          <div className="col">
            <p className="tiny muted" style={{ marginBottom: 0 }}>
              现场新建只填最少字段：名称、类型、默认价格、分类。封面图、更多规格、套装成分等到「商品」页继续完善。
            </p>
            <div className="grid cols-2">
              <Field label="商品名称 *">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 本子《新刊》" />
              </Field>
              <Field label="类型">
                <select value={type} onChange={(e) => setType(e.target.value as ProductType)}>
                  <option value="normal">普通库存</option>
                  <option value="bundle">虚拟套装</option>
                  <option value="gift">赠品</option>
                  <option value="non_stock">不计库存</option>
                </select>
              </Field>
              <Field label={`默认价格（${currency === 'CNY' ? '元' : '日元'}）`}>
                <input
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder={currency === 'CNY' ? '0.00' : '0'}
                />
              </Field>
              <Field label="分类">
                <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <p className="tiny muted" style={{ marginBottom: 0 }}>
              这里的默认价格仅作为填表参考；本场真正价格以「参展商品」表里填的「本场价格」为准。
            </p>
          </div>
        )}

        <ErrorBox message={error} />
      </div>
    </Modal>
  );
}
