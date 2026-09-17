import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { deleteUnusedAssets, listCategories, listProducts, setProductArchived } from '../../services/catalog';
import { formatMoney } from '../../domain/money';
import { errorMessage, useApp } from '../../store';
import { ErrorBox, Spinner, useAsync } from '../components';
import { CategoryManagerModal } from '../CategoryManager';
import { ProductEditorModal, TYPE_LABEL } from '../ProductEditor';
import type { Category } from '../../domain/types';
import type { ProductWithVariants } from '../../services/catalog';

export default function StaffProductsPage() {
  const showToast = useApp((s) => s.showToast);
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<ProductWithVariants | null>(null);
  const [creating, setCreating] = useState(false);
  const [managingCats, setManagingCats] = useState(false);

  const products = useAsync(
    () => listProducts({ search, categoryId: categoryId || null, archived: showArchived ? null : false }),
    [search, categoryId, showArchived]
  );
  const cats = useAsync(() => listCategories(true), []);

  if (products.loading && !products.data) {
    return (
      <div className="center-page">
        <Spinner label="读取商品…" />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="row">
        <h1 style={{ margin: 0 }}>商品管理</h1>
        <span className="spacer" />
        <button onClick={() => void deleteUnusedAssets().then((n) => showToast(`已回收 ${n} 个未使用资源`))}>
          回收未使用图片
        </button>
        <button onClick={() => navigate('/preview')} title="不锁定后台，可切换屏幕尺寸">
          预览菜单效果
        </button>
        {/* 分类是商品的属性，管理入口放在商品页最顺：
            新增分类之后马上就能在下面「新增商品」里选到它 */}
        <button onClick={() => setManagingCats(true)} title="新增 / 改名 / 隐藏 / 删除商品分类">
          分类管理
        </button>
        <button className="primary" onClick={() => setCreating(true)}>
          新增商品
        </button>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="row">
          <input
            type="search"
            placeholder="搜索名称 / SKU / 标签"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 280 }}
          />
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} style={{ maxWidth: 200 }}>
            <option value="">全部分类</option>
            {cats.data?.map((c: Category) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.hidden ? '（隐藏）' : ''}
              </option>
            ))}
          </select>
          <label className="check">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            显示已归档
          </label>
        </div>

        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th>商品</th>
                <th>分类</th>
                <th>类型</th>
                <th className="num">默认价格</th>
                <th>规格</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {products.data?.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.name}
                    {p.archived ? (
                      <span className="badge" style={{ marginLeft: 6 }}>
                        已归档
                      </span>
                    ) : null}
                    {p.short_name ? <div className="tiny muted">{p.short_name}</div> : null}
                  </td>
                  <td>{p.category_name ?? '—'}</td>
                  <td>{TYPE_LABEL[p.type]}</td>
                  <td className="num nowrap">
                    {p.default_price_minor === null ? '—' : formatMoney(p.default_price_minor, p.default_currency)}
                  </td>
                  <td className="small">{p.variants.map((v) => v.name).join('、') || '—'}</td>
                  <td className="nowrap">
                    <button className="small" onClick={() => setEditing(p)}>
                      编辑
                    </button>
                    <button
                      className="small"
                      onClick={async () => {
                        try {
                          await setProductArchived(p.id, !p.archived);
                          products.reload();
                        } catch (e) {
                          showToast(errorMessage(e));
                        }
                      }}
                    >
                      {p.archived ? '取消归档' : '归档'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 新增和编辑共用同一个弹窗，字段完全一致——
          不再出现「新建时只有 5 个字段、建完还得再点一次编辑」这种事 */}
      {creating ? (
        <ProductEditorModal
          mode="create"
          categories={cats.data ?? []}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            products.reload();
          }}
        />
      ) : null}

      {editing ? (
        <ProductEditorModal
          mode="edit"
          product={editing}
          categories={cats.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            products.reload();
          }}
        />
      ) : null}

      {managingCats ? (
        <CategoryManagerModal
          categories={cats.data ?? []}
          onClose={() => setManagingCats(false)}
          onChanged={() => {
            // 分类改名后商品列表里的分类名也要跟着变
            cats.reload();
            products.reload();
          }}
        />
      ) : null}

      <ErrorBox message={products.error} />
    </div>
  );
}
