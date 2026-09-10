import { useRef, useState } from 'react';
import { useAssetUrl } from './components';
import { formatBytes } from '../domain/image';
import { ErrorBox } from './components';

/**
 * 资源选择控件。
 * 商品图走压缩通道，收款码走无损通道——调用方通过 onPick 决定用哪条。
 */
export default function AssetEditor({
  label,
  assetId,
  onChange,
  onPick,
  lossless
}: {
  label: string;
  assetId: string | null;
  onChange: (id: string | null) => void;
  onPick: (file: File) => Promise<void>;
  lossless?: boolean;
}) {
  const url = useAssetUrl(assetId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  return (
    <div>
      <div className="small muted">{label}</div>
      <div className="row" style={{ marginTop: 6 }}>
        {url ? (
          <img
            src={url}
            alt="预览"
            style={{
              width: 96,
              height: 96,
              objectFit: 'contain',
              background: '#fff',
              border: '1px solid var(--line)',
              borderRadius: 10,
              padding: 4
            }}
          />
        ) : (
          <div
            style={{
              width: 96,
              height: 96,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1px dashed var(--line)',
              borderRadius: 10,
              color: 'var(--ink-2)',
              fontSize: '0.75rem'
            }}
          >
            无图片
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setBusy(true);
            setError(null);
            setNote(null);
            try {
              await onPick(f);
              setNote(`已读取 ${formatBytes(f.size)}`);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
              if (inputRef.current) inputRef.current.value = '';
            }
          }}
        />
        <button className="small" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? '处理中…' : '选择图片'}
        </button>
        {assetId ? (
          <button className="small ghost" onClick={() => onChange(null)}>
            移除
          </button>
        ) : null}
      </div>
      {lossless ? <div className="tiny muted">收款码保持原始清晰度，不做压缩或缩放。</div> : null}
      {note ? <div className="tiny muted">{note}</div> : null}
      <ErrorBox message={error} />
    </div>
  );
}
