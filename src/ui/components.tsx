import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { formatMoney } from '../domain/money';
import type { Currency } from '../domain/types';
import { getAsset } from '../services/catalog';
import { useApp } from '../store';
import { CategoryPlaceholder } from './CategoryPlaceholder';

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
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}

/* --------------------------------------------------------------- 资源图片 */

export function useAssetUrl(assetId: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!assetId) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    getAsset(assetId)
      .then((row) => {
        if (cancelled) return;
        if (!row) {
          setUrl(null);
          return;
        }
        const bytes = row.blob;
        const blob = new Blob([bytes as unknown as BlobPart], { type: row.mime_type || 'application/octet-stream' });
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
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
  className,
  categoryName
}: {
  assetId: string | null | undefined;
  alt: string;
  /** 追加的样式类；不传时保持原有 thumb/thumb-placeholder 行为 */
  className?: string;
  /** 可选分类名，用于无封面图时展示对应分类的几何线框占位 */
  categoryName?: string | null;
}) {
  const url = useAssetUrl(assetId);
  const cls = className ? `thumb ${className}` : 'thumb';
  if (!url) {
    return <CategoryPlaceholder categoryName={categoryName} alt={alt} className={className} />;
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
  actions,
  className = '',
  subheader
}: {
  title: string;
  children: ReactNode;
  onClose?: () => void;
  actions?: ReactNode;
  className?: string;
  subheader?: ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {subheader}
        <div className="modal-content">{children}</div>
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

/**
 * 挂在标签旁边的问号说明。
 *
 * 桌面端悬停就出，触屏端点一下切换（`:hover` 在 iPad 上没有对应动作）。
 * 两套都留着而不是二选一：同一个应用两种设备都在用。
 */
/**
 * 同一时刻只留一个说明气泡。
 *
 * 模块级记一个「当前开着的那个」就够——气泡之间没有嵌套关系。
 * 用自增 id 而不是函数引用做身份：`close` 每次渲染都是新函数，
 * 拿它比对永远不相等（这一版最初的写法就是这么错的）。
 */
let openBubble: { id: number; close: () => void } | null = null;
let bubbleSeq = 1;

/**
 * 列头问号。桌面 hover 出、触屏点击切换。
 *
 * ⚠️ 触屏上「怎么关掉」踩过一次坑，改法都写在这里，别再退回去：
 *  1. 原来 CSS 里有 `.info-dot-wrap:focus-within .info-bubble { display:block }`。
 *     iPad 上点一下按钮会**一直保持焦点**，于是 `setOpen(false)` 也关不掉 ——
 *     再点一次问号看起来毫无反应，用户不知道该点哪里。现在改成
 *     `:has(.info-dot:focus-visible)`：键盘 Tab 过来仍然出气泡，
 *     手指点过不留 `focus-visible`，不会卡住。
 *  2. 补上「点气泡外面关掉」（pointerdown 监听）和气泡右上角的 ×。
 *  3. 新开一个气泡时把上一个关掉，否则屏幕上会同时挂两个。
 */
export function InfoDot({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [id] = useState(() => bubbleSeq++);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  useEffect(() => () => {
    if (openBubble?.id === id) openBubble = null;
  }, [id]);

  function close() {
    if (openBubble?.id === id) openBubble = null;
    setOpen(false);
  }

  return (
    <span ref={wrapRef} className={`info-dot-wrap${open ? ' open' : ''}`}>
      <button
        type="button"
        className="info-dot"
        aria-label="说明"
        aria-expanded={open}
        onClick={(e) => {
          // 表头里点问号不该顺带触发表格的排序/选择行为
          e.stopPropagation();
          if (open) {
            close();
            return;
          }
          if (openBubble && openBubble.id !== id) openBubble.close();
          openBubble = { id, close };
          setOpen(true);
        }}
      >
        ?
      </button>
      <span className="info-bubble" role="tooltip">
        {text}
        <button
          type="button"
          className="info-bubble-close"
          aria-label="关闭说明"
          onClick={(e) => {
            e.stopPropagation();
            close();
          }}
        >
          ×
        </button>
      </span>
    </span>
  );
}

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
/** 数字键和功能键要分开渲染：功能键是中文两字，和数字用同一个字号会明显更宽，
 *  一排三个看起来就不齐。 */
const FN_KEYS = new Set(['清空', '删除']);

export function PinPad({
  onSubmit,
  onCancel,
  hint,
  error
}: {
  onSubmit: (pin: string) => void | Promise<void>;
  onCancel?: () => void;
  hint?: string;
  error?: string | null;
}) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const press = useCallback((k: string) => {
    if (k === '清空') return setValue('');
    if (k === '删除') return setValue((v) => v.slice(0, -1));
    setValue((v) => (v.length >= 8 ? v : v + k));
  }, []);

  const submitPin = useCallback(
    async (pin: string) => {
      if (pin.length < 4 || submitting) return;
      setSubmitting(true);
      try {
        await onSubmit(pin);
      } finally {
        setSubmitting(false);
      }
    },
    [onSubmit, submitting]
  );

  // 支持电脑端和外接键盘直接输入数字、退格、清空与回车确认
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || submitting) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // 若页面上方覆盖了其他弹窗且当前 PinPad 不在最顶层弹窗内，则不抢占键盘输入
      const modals = document.querySelectorAll('[aria-modal="true"]');
      if (modals.length > 0) {
        const topModal = modals[modals.length - 1];
        if (!rootRef.current || !topModal.contains(rootRef.current)) return;
      }
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        press(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        press('删除');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (value) press('清空');
        else onCancel?.();
      } else if (e.key === 'Enter' && value.length >= 4) {
        // 焦点在按钮上（例如「返回」）时交给按钮原生点击，避免误提交
        if (tag === 'BUTTON') return;
        e.preventDefault();
        void submitPin(value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [press, value, submitPin, onCancel, submitting]);
  const dots = useMemo(() => '●'.repeat(value.length), [value]);
  return (
    <div className="pinpad" ref={rootRef}>
      {hint ? <div className="pin-hint">{hint}</div> : null}
      {/* 未输入时也要占位，否则按下第一个数字整行会往下跳 */}
      <div className="pin-dots">{dots || <span className="pin-dots-empty">未输入</span>}</div>
      {error ? <div className="notice danger">{error}</div> : null}
      <div className="pin-keys">
        {KEYS.map((k) => (
          <button
            key={k}
            type="button"
            className={FN_KEYS.has(k) ? 'pin-fn' : 'pin-digit'}
            disabled={submitting}
            onClick={() => press(k)}
            aria-label={k === '清空' ? '清空' : k === '删除' ? '删除一位' : undefined}
          >
            {k}
          </button>
        ))}
      </div>
      <div className="pin-actions">
        <button
          type="button"
          className="primary block"
          disabled={value.length < 4 || submitting}
          onClick={() => void submitPin(value)}
        >
          确认
        </button>
        {onCancel ? (
          <button type="button" className="block" disabled={submitting} onClick={onCancel}>
            返回
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 设置新 PIN：连输两遍。
 *
 * 为什么要两遍：PIN 只有 4–8 位数字，按错一位不会当场发现，代价是
 * 「下次自己也进不去」—— 而这正是需要走恢复流程的唯一原因。
 * 设置时多按一遍，比事后找恢复入口便宜得多。
 *
 * 两遍不一致时整段退回第一遍，不保留上一遍的值：否则用户会以为
 * 「第二遍输错了，那我改第二遍就行」，实际第一遍才是要改的那个。
 */
export function SetPinFlow({
  onSubmit,
  onCancel,
  hint,
  firstHint,
  secondHint
}: {
  onSubmit: (pin: string) => void | Promise<void>;
  onCancel?: () => void;
  hint?: string;
  firstHint?: string;
  secondHint?: string;
}) {
  const [first, setFirst] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // key 必须不同：两个分支渲染的都是 <PinPad>，React 会复用同一个实例，
  // 于是 PinPad 内部的 useState('') 不会重置 —— 第二遍会带着第一遍已经
  // 打好的四个点，用户再按一下就变成八位。加 key 强制卸载重建。
  if (first === null) {
    return (
      <PinPad
        key="first"
        hint={firstHint ?? hint ?? '输入新的 4 到 8 位数字'}
        error={error}
        onCancel={onCancel}
        onSubmit={(v) => {
          setError(null);
          setFirst(v);
        }}
      />
    );
  }

  return (
    <PinPad
      key="second"
      hint={secondHint ?? '再输入一遍，确认没有按错'}
      error={error}
      onCancel={() => {
        setFirst(null);
        setError(null);
      }}
      onSubmit={async (v) => {
        if (v !== first) {
          setFirst(null);
          setError('两次输入不一致，请重新设置');
          return;
        }
        setError(null);
        await onSubmit(v);
      }}
    />
  );
}
