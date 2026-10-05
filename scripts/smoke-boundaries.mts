/** Preserve unknown wire values until the smoke's existing field checks accept them. */
export function smokeRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}
export function smokeArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
export function smokeRequired<T>(value: T, label = 'smoke value'): NonNullable<T> {
  if (value == null) throw new Error(`${label} is missing`);
  return value as NonNullable<T>;
}
export function smokeFrameText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
  return String(value);
}
