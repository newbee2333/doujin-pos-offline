/**
 * 资源处理（第 7 节）。
 *
 * 商品图：自动压缩，最大边 1600px，优先 WebP，兼容 JPEG/PNG。
 * 收款码：无损、保留原始比例与白边，不做有损压缩，也不缩放。
 */

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 1600;

export interface PreparedAsset {
  mimeType: string;
  width: number | null;
  height: number | null;
  bytes: Uint8Array;
  originalBytes: number;
  note: string | null;
}

export class AssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetError';
  }
}

function assertSize(file: Blob) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new AssetError(
      `图片超过 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MiB，请缩小后再上传`
    );
  }
}

async function decode(file: Blob): Promise<{ bitmap: ImageBitmap; width: number; height: number }> {
  if (typeof createImageBitmap !== 'function') throw new AssetError('当前浏览器不支持图片解码');
  try {
    const bitmap = await createImageBitmap(file);
    return { bitmap, width: bitmap.width, height: bitmap.height };
  } catch {
    throw new AssetError('图片解码失败，请确认文件未损坏且格式为 JPEG / PNG / WebP');
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new AssetError('图片转换失败'))),
      type,
      quality
    );
  });
}

/** 商品图：等比缩放到最大边 1600px 内，优先 WebP。 */
export async function prepareProductImage(file: Blob): Promise<PreparedAsset> {
  assertSize(file);
  const { bitmap, width, height } = await decode(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
  const targetW = Math.max(1, Math.round(width * scale));
  const targetH = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new AssetError('无法创建绘图上下文');
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);
  bitmap.close?.();

  let blob = await toBlob(canvas, 'image/webp', 0.86);
  let mime = 'image/webp';
  if (blob.type !== 'image/webp' || blob.size === 0) {
    // 浏览器不支持 WebP 编码时退回 JPEG
    blob = await toBlob(canvas, 'image/jpeg', 0.88);
    mime = 'image/jpeg';
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const note =
    scale < 1 || bytes.length < file.size
      ? `已压缩：${formatBytes(file.size)} → ${formatBytes(bytes.length)}`
      : null;
  return { mimeType: mime, width: targetW, height: targetH, bytes, originalBytes: file.size, note };
}

/** 收款码：原样保留，仅做格式与体积校验，不做重采样或有损压缩。 */
export async function preparePaymentQr(file: Blob): Promise<PreparedAsset> {
  assertSize(file);
  const allowed = ['image/png', 'image/jpeg', 'image/webp'];
  if (file.type && !allowed.includes(file.type)) {
    throw new AssetError('收款码请使用 PNG / JPEG / WebP 图片');
  }
  let width: number | null = null;
  let height: number | null = null;
  try {
    const { bitmap } = await decode(file);
    width = bitmap.width;
    height = bitmap.height;
    bitmap.close?.();
  } catch {
    throw new AssetError('收款码图片解码失败，请确认文件未损坏');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    mimeType: file.type || 'image/png',
    width,
    height,
    bytes,
    originalBytes: file.size,
    note: '收款码保持原始清晰度，未做压缩'
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 简单的字节哈希，用于资源去重与往返一致性比较。 */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv-${h.toString(16)}`;
}
