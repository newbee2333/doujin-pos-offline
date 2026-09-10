import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { formatMoney } from '../domain/money';
import type { Currency } from '../domain/types';
import { getAsset } from '../services/catalog';
import { useApp } from '../store';

/* --------------------------------------------------------------- 异步数据 */

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useCallback(fn, deps);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    stable()
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [stable, nonce]);
  return { data, loading, error, reload: () => setNonce((n) => n + 1) };
}

/* --------------------------------------------------------------- 资源图片 */

export function useAssetUrl(assetId: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!assetId) {
      setUrl(null);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    getAsset(assetId)
      .then((row) => {
        if (!row || cancelled) return;
        const bytes = row.blob;
        const blob = new Blob([bytes as unknown as BlobPart], { type: row.mime_type || 'application/octet-stream' });
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => setUrl(null));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId]);
  return url;
}

export function AssetImage({
  assetId,
  alt,
  className
}: {
  assetId: string | null | undefined;
  alt: string;
  /** 追加的样式类；不传时保持原有 thumb/thumb-placeholder 行为 */
  className?: string;
}) {
  const url = useAssetUrl(assetId);
  const cls = className ? `thumb ${className}` : 'thumb';
  if (!url) {
    return (
      <div className={className ? `thumb-placeholder ${className}` : 'thumb-placeholder'}>无图片</div>
    );
  }
  return <img className={cls} src={url} alt={alt} />;
}

/* --------------------------------------------------------------- 金额 */

export function Money({ minor, currency, big }: { minor: number; currency: Currency; big?: boolean }) {
  return <span className={big ? 'big-price' : 'price'}>{formatMoney(minor, currency)}</span>;
}

/* --------------------------------------------------------------- 反馈 */

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row tight">
      <span className="spinner dark" />
      {label ? <span className="small muted">{label}</span> : null}
    </span>
  );
}

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="notice danger">{message}</div>;
}

export function Toast() {
  const toast = useApp((s) => s.toast);
  const showToast = useApp((s) => s.showToast);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => showToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast, showToast]);
  if (!toast) return null;
  return <div className="toast">{toast}</div>;
}

/* --------------------------------------------------------------- 弹层 */

export function Modal({
  title,
  children,
  onClose,
  actions
}: {
  title: string;
  children: ReactNode;
  onClose?: () => void;
  actions?: ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
        {actions ? <div className="modal-actions">{actions}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmText = '确认',
  danger,
  busy,
  onConfirm,
  onCancel,
  children
}: {
  title: string;
  message: ReactNode;
  confirmText?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      actions={
        <>
          <button onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button className={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {confirmText}
          </button>
        </>
      }
    >
      <div className="col">
        <div>{message}</div>
        {children}
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- 表单件 */

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function QtyStepper({
  value,
  min = 0,
  max,
  onChange
}: {
  value: number;
  min?: number;
  max?: number | null;
  onChange: (v: number) => void;
}) {
  return (
    <span className="qty">
      <button className="small" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min}>
        −
      </button>
      <span className="value">{value}</span>
      <button
        className="small"
        onClick={() => onChange(value + 1)}
        disabled={max != null && value >= max}
      >
        +
      </button>
    </span>
  );
}

/* --------------------------------------------------------------- PIN */

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '清空', '0', '删除'];

export function PinPad({
  onSubmit,
  onCancel,
  hint,
  error
}: {
  onSubmit: (pin: string) => void;
  onCancel?: () => void;
  hint?: string;
  error?: string | null;
}) {
  const [value, setValue] = useState('');
  const press = (k: string) => {
    if (k === '清空') return setValue('');
    if (k === '删除') return setValue((v) => v.slice(0, -1));
    setValue((v) => (v.length >= 8 ? v : v + k));
  };
  const dots = useMemo(() => '●'.repeat(value.length), [value]);
  return (
    <div className="col">
      {hint ? <div className="small muted">{hint}</div> : null}
      <div className="center mono" style={{ minHeight: 32, fontSize: '1.4rem', letterSpacing: 6 }}>
        {dots || ' '}
      </div>
      {error ? <div className="notice danger">{error}</div> : null}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {KEYS.map((k) => (
          <button key={k} onClick={() => press(k)}>
            {k}
          </button>
        ))}
      </div>
      <div className="row">
        <button className="primary block" disabled={value.length < 4} onClick={() => onSubmit(value)}>
          确认
        </button>
        {onCancel ? (
          <button className="block" onClick={onCancel}>
            返回
          </button>
        ) : null}
      </div>
    </div>
  );
}
