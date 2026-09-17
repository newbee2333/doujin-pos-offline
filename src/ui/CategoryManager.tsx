/**
 * 分类管理：新增 / 改名 / 游客可见 / 删除。
 *
 * 这三个服务函数从第一版就有（建库时写进去的那 8 个默认分类走的是同一张表），
 * 只是一直没有界面 —— 分类名打错、或者想加一个「新刊·特典」，只能去改库。
 *
 * 删除的拦截放在服务层（分类下还有商品就抛错），这里不去重复实现一遍判断，
 * 而是先查一次每个分类的商品数量：数量大于 0 时按钮直接置灰并说明原因，
 * 免得摊主点一下才被告知不行。
 */
import { useState } from 'react';
import { countProductsByCategory, createCategory, deleteCategory, updateCategory } from '../services/catalog';
import { errorMessage, useApp } from '../store';
import { ErrorBox, Modal, Spinner, useAsync } from './components';
import type { Category } from '../domain/types';

export function CategoryManagerModal({
  categories,
  onClose,
  onChanged
}: {
  categories: Category[];
  onClose: () => void;
  /** 分类有变动后调用：调用方负责 reload 分类列表与商品列表 */
  onChanged: () => void;
}) {
  const showToast = useApp((s) => s.showToast);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const counts = useAsync(() => countProductsByCategory(), []);

  const usedCount = (id: string) => Number(counts.data?.find((r) => r.category_id === id)?.c ?? 0);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await createCategory(name);
      setName('');
      showToast('已新增分类');
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="分类管理"
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose} disabled={busy}>
            关闭
          </button>
        </>
      }
    >
      <div className="col">
        <div className="row">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="新分类名称，例如：新刊·特典"
            aria-label="新分类名称"
            style={{ maxWidth: 260 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim() && !busy) void add();
            }}
          />
          <button className="primary" disabled={busy || !name.trim()} onClick={add}>
            {busy ? <span className="spinner" /> : null}
            新增分类
          </button>
        </div>
        <p className="tiny muted" style={{ margin: 0 }}>
          分类只用来筛选和自查，不参与价格与库存。取消勾选「游客可见」后，
          这个分类不会出现在游客菜单的分类胶囊里，但商品仍在售、仍能被搜索到。
        </p>

        {counts.loading && !counts.data ? (
          <Spinner label="读取分类…" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>分类名称</th>
                  <th className="num">商品数</th>
                  <th>游客可见</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => {
                  const used = usedCount(c.id);
                  return (
                    <tr key={c.id}>
                      <td>
                        {/* 改名走 onBlur：和本页其他地方（摊位号、价格）一致，
                            没有「改了没保存」的中间态 */}
                        <input
                          defaultValue={c.name}
                          aria-label={`分类名称 ${c.name}`}
                          onBlur={async (e) => {
                            const next = e.target.value.trim();
                            if (!next || next === c.name) {
                              e.target.value = c.name;
                              return;
                            }
                            try {
                              await updateCategory(c.id, { name: next });
                              showToast('已改名');
                              onChanged();
                            } catch (err) {
                              e.target.value = c.name;
                              setError(errorMessage(err));
                            }
                          }}
                        />
                      </td>
                      <td className="num">{counts.loading ? '—' : used}</td>
                      <td>
                        <input
                          type="checkbox"
                          defaultChecked={!c.hidden}
                          aria-label={`${c.name} 游客可见`}
                          onChange={async (e) => {
                            try {
                              await updateCategory(c.id, { hidden: !e.target.checked });
                              onChanged();
                            } catch (err) {
                              e.target.checked = !e.target.checked;
                              setError(errorMessage(err));
                            }
                          }}
                        />
                      </td>
                      <td className="nowrap">
                        <button
                          className="small danger"
                          disabled={busy || used > 0}
                          title={
                            used > 0
                              ? `还有 ${used} 件商品在这个分类下，先改到别的分类再删`
                              : '删除这个分类'
                          }
                          onClick={async () => {
                            if (!window.confirm(`删除分类「${c.name}」？此操作不可撤销。`)) {
                              return;
                            }
                            setBusy(true);
                            setError(null);
                            try {
                              await deleteCategory(c.id);
                              showToast('已删除分类');
                              onChanged();
                              counts.reload();
                            } catch (err) {
                              setError(errorMessage(err));
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {!categories.length ? (
                  <tr>
                    <td colSpan={4} className="center muted" style={{ padding: '24px 12px' }}>
                      还没有分类。上面输入名字就能加一个。
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}

        <ErrorBox message={error} />
      </div>
    </Modal>
  );
}
