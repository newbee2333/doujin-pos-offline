/** 通用标识与时间工具。 */

export function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // 兜底：非安全上下文下 crypto.randomUUID 可能不可用
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** UTC ISO 时间戳，保存统一用 UTC（第 5 节）。 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** 请求指纹：同一 operation_id 参数不同则拒绝（第 5 节）。 */
export function hashRequest(payload: unknown): string {
  const json = stableStringify(payload);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}-${json.length}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
