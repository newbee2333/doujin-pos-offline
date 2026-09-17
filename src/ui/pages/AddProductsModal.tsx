/**
 * 添加商品到本场：从已有商品里勾选加入，或转去「新增商品」（用商品页同一套编辑器）。
 *
 * 这里曾经自己带一套精简的「现场新建」表单（只有名称/类型/价格/分类四项），
 * 和商品页的「新增商品」、以及「编辑商品」是三套不同的字段集。
 * 现在只保留「从已有商品勾选」这一件事，新建走同一个编辑器——
 * 一个对象一套字段，不再有「建完发现少了封面和说明，还得再点一次编辑」。
 */
import { useMemo, useState } from 'react';
import { addVariantsToEvent } from '../../services/events';
import { errorMessage } from '../../store';
import { AssetImage, ErrorBox, Modal } from '../components';

interface NotAddedItem {
  id: string;
  name: string;
  sku: string | null;
  pname: string;
  ptype: string;
  /** 商品的封面与分类，用来在列表里认出是哪一件 */
  cover?: string | null;
  category?: string | null;
}

export default function AddProductsModal({
  eventId,
  notAdded,
  onClose,
  onAdded,
  onCreateNew
}: {
  eventId: string;
  notAdded: NotAddedItem[];
  onClose: () => void;
  onAdded: () => void;
  /** 转去「新增商品」：调用方负责关掉本弹窗并打开商品编辑器 */
  onCreateNew: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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

  const allIds = useMemo(() => notAdded.map((v) => v.id), [notAdded]);

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

  return (
    <Modal
      title="添加商品到本场"
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy || !selected.size} onClick={doExisting}>
            {busy ? <span className="spinner" /> : null}
            加入所选（{selected.size}）
          </button>
        </>
      }
    >
      <div className="col">
        {notAdded.length ? (
          <>
            <div className="row">
              <p className="tiny muted" style={{ margin: 0, flex: 1, minWidth: 200 }}>
                勾选要加入本场的商品。本场价格默认沿用商品默认价格，之后可以在「参展商品」表里逐个改。
              </p>
              <button onClick={onCreateNew} disabled={busy}>
                + 新增商品
              </button>
            </div>
            {/* 商品多的时候逐个点太慢：整批加入是常见动作，给一对全选 / 取消全选。
                取消全选只在有选中项时可点，避免点了个没反应的按钮。 */}
            <div className="row" style={{ marginTop: 2 }}>
              <button
                className="small"
                disabled={busy || selected.size === allIds.length}
                onClick={() => setSelected(new Set(allIds))}
              >
                全选
              </button>
              <button
                className="small"
                disabled={busy || selected.size === 0}
                onClick={() => setSelected(new Set())}
              >
                取消全选
              </button>
              <span className="small muted">
                已选 {selected.size} / {notAdded.length}
              </span>
            </div>
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
                            aria-label={`选择 ${pname}`}
                            onChange={(e) => {
                              const s = new Set(selected);
                              if (e.target.checked) s.add(v.id);
                              else s.delete(v.id);
                              setSelected(s);
                            }}
                          />
                        </td>
                        <td>
                          {/* 同名商品靠封面和分类区分，光看名字容易勾错 */}
                          <span className="cell-product">
                            <AssetImage assetId={v.cover ?? null} alt={pname} className="row-thumb" />
                            <span className="cell-body">
                              <span>{pname}</span>
                              {v.category ? (
                                <span className="tiny muted" style={{ display: 'block' }}>
                                  {v.category}
                                </span>
                              ) : null}
                            </span>
                          </span>
                        </td>
                        <td>{v.name}</td>
                        <td className="tiny muted">{v.sku ?? '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="col">
            <div className="notice info">
              还没有可以「直接加入」的商品——所有商品都已经在本场了，或者商品库还是空的。
            </div>
            <div className="row">
              <button className="primary" onClick={onCreateNew} disabled={busy}>
                + 新增商品并加入本场
              </button>
              <span className="tiny muted">用和「商品」页完全一样的表单，含封面、说明、原作等全部字段。</span>
            </div>
          </div>
        )}

        <ErrorBox message={error} />
      </div>
    </Modal>
  );
}
