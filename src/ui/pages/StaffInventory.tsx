import { useState } from 'react';
import { adjustStock, getInventory, listInventory, listTransactions, reconcile } from '../../services/inventory';
import { listEventConfigs } from '../../services/events';
import { newId } from '../../domain/ids';
import { errorMessage, useApp } from '../../store';
import { ErrorBox, Field, Modal, Spinner, useAsync } from '../components';
import { AdjustStockModal, type AdjustKind } from '../AdjustStockModal';


interface AdjustTarget {
  variantId: string;
  name: string;
  /** 由快捷按钮带入的预设，摊主只需核对前后数量再确认。 */
  preset?: { type: AdjustKind; delta: number; reason: string };
}

export default function StaffInventoryPage() {
  const eventId = useApp((s) => s.currentEventId);
  const showToast = useApp((s) => s.showToast);
  const [adjust, setAdjust] = useState<AdjustTarget | null>(null);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [showTx, setShowTx] = useState(false);

  const configs = useAsync(() => (eventId ? listEventConfigs(eventId) : Promise.resolve([])), [eventId]);
  const inventory = useAsync(() => (eventId ? listInventory(eventId) : Promise.resolve([])), [eventId]);

  if (!eventId) return <ErrorBox message="请先选择展会" />;
  if (configs.loading) {
    return (
      <div className="center-page">
        <Spinner label="读取库存…" />
      </div>
    );
  }

  return (
    <div className="content">
      <div className="row">
        <h1 style={{ margin: 0 }}>库存与流水</h1>
        <span className="spacer" />
        <button
          onClick={async () => {
            const p = await reconcile(eventId);
            setProblems(p);
            showToast(p.length ? `发现 ${p.length} 项不一致` : '对账通过');
          }}
        >
          对账
        </button>
      </div>

      {problems ? (
        problems.length ? (
          <div className="notice danger" style={{ marginTop: 10 }}>
            {problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </div>
        ) : (
          <div className="notice ok" style={{ marginTop: 10 }}>
            余额、流水与预留三者一致。
          </div>
        )
      ) : null}

      <div className="card" style={{ marginTop: 12 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>商品</th>
                <th className="num">初始</th>
                <th className="num">实际</th>
                <th className="num">预留</th>
                <th className="num">可用</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {configs.data
                ?.filter((c) => c.product_type === 'normal' || c.product_type === 'gift')
                .map((c) => {
                  const inv = inventory.data?.find((i) => i.variant_id === c.variant_id);
                  const physical = inv?.physical_stock ?? 0;
                  const reserved = inv?.reserved_stock ?? 0;
                  const available = physical - reserved;
                  const label = `${c.product_name}（${c.variant_name}）`;
                  return (
                    <tr key={c.variant_id}>
                      <td>
                        {c.product_name}
                        <div className="tiny muted">{c.variant_name}</div>
                      </td>
                      <td className="num">{inv?.initial_stock ?? '—'}</td>
                      <td className="num">{physical}</td>
                      <td className="num">{reserved}</td>
                      <td className="num strong">{available}</td>
                      <td className="nowrap">
                        <span className="row tight">
                          <button
                            className="small"
                            title="补货 1 件"
                            onClick={() =>
                              setAdjust({
                                variantId: c.variant_id,
                                name: label,
                                preset: { type: 'restock', delta: 1, reason: '补货' }
                              })
                            }
                          >
                            +1
                          </button>
                          <button
                            className="small"
                            title="报损 1 件"
                            disabled={available <= 0}
                            onClick={() =>
                              setAdjust({
                                variantId: c.variant_id,
                                name: label,
                                preset: { type: 'damaged', delta: -1, reason: '报损' }
                              })
                            }
                          >
                            −1
                          </button>
                          <button
                            className="small ghost"
                            onClick={() => setAdjust({ variantId: c.variant_id, name: label })}
                          >
                            调整…
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <p className="tiny muted" style={{ marginBottom: 0 }}>
          套装没有自己的库存，它消耗成分库存。初始库存只初始化一次，之后补货、盘点、报损都通过流水记录。
        </p>
      </div>

      {showTx ? (
        <TransactionList eventId={eventId} />
      ) : (
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={() => setShowTx(true)}>查看库存流水</button>
          <span className="small muted">补货、预留、售出、返库等每一次变动都在这里留痕。</span>
        </div>
      )}

      {adjust ? (
        <AdjustStockModal
          eventId={eventId}
          variantId={adjust.variantId}
          name={adjust.name}
          preset={adjust.preset}
          onClose={() => setAdjust(null)}
          onDone={() => {
            setAdjust(null);
            inventory.reload();
            configs.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function TransactionList({ eventId }: { eventId: string }) {
  const txs = useAsync(() => listTransactions(eventId), [eventId]);
  const configs = useAsync(() => listEventConfigs(eventId), [eventId]);
  if (txs.loading) return <Spinner label="读取流水…" />;
  const nameOf = (id: string) => {
    const c = configs.data?.find((x) => x.variant_id === id);
    return c ? `${c.product_name}（${c.variant_name}）` : id;
  };
  return (
    <div className="card">
      <h2>库存流水</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>商品</th>
              <th>类型</th>
              <th className="num">实际增减</th>
              <th className="num">预留增减</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            {txs.data?.slice(0, 200).map((t) => (
              <tr key={t.id}>
                <td className="tiny">{new Date(t.created_at).toLocaleString('zh-CN')}</td>
                <td>{nameOf(t.variant_id)}</td>
                <td>
                  <span className="badge">{t.type}</span>
                </td>
                <td className="num">{t.delta_physical}</td>
                <td className="num">{t.delta_reserved}</td>
                <td className="small">{t.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

