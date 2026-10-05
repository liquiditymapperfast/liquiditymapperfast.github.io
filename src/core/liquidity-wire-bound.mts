import { NATIVE_BOOK_WIRE_ALIASES_VERSION } from './native-book-wire-aliases.mts';
/** Explicit per-stream policy; the global liquidity hard cap is unchanged. */
export const LIVE_LIQUIDITY_WIRE_BOUND_VERSION = 'hlm-liquidity-wire-v1';
export const LIVE_LIQUIDITY_HARD_WIRE_BYTES = 4 * 1024 * 1024;
export const LIVE_LIQUIDITY_MIN_NEGOTIATED_WIRE_BYTES = 4_096;
export type LiquidityWireBound = { ok: true; maxBytes: number | null; nativeBookAliases?: true } | { ok: false; reason: string };

/** Direct helpers accept any positive safe bound below the unchanged hard cap. */
export function isLiquidityWireBound(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= LIVE_LIQUIDITY_HARD_WIRE_BYTES;
}

/** Only a paired, exactly-once explicit query negotiates a smaller policy. */
export function parseLiquidityWireBound(params: URLSearchParams): LiquidityWireBound {
  let versions = 0; let limits = 0; let aliases = 0; let version = ''; let limit = ''; let aliasVersion = '';
  for (const [key, value] of params) {
    if (key === 'liquidityWire') { versions++; version = value; }
    else if (key === 'liquidityBytes') { limits++; limit = value; }
    else if (key === 'bookAliases') { aliases++; aliasVersion = value; }
    if (versions > 1 || limits > 1 || aliases > 1) return { ok: false, reason: 'duplicate-liquidity-wire-arguments' };
  }
  if (aliases && aliasVersion !== NATIVE_BOOK_WIRE_ALIASES_VERSION) return { ok: false, reason: 'unsupported-native-book-alias-version' };
  if (aliases && (versions !== 1 || limits !== 1)) return { ok: false, reason: 'native-book-aliases-require-bounded-wire' };
  if (versions === 0 && limits === 0) return { ok: true, maxBytes: null };
  if (versions !== 1 || limits !== 1) return { ok: false, reason: 'liquidity-wire-arguments-must-be-paired' };
  if (version !== LIVE_LIQUIDITY_WIRE_BOUND_VERSION) return { ok: false, reason: 'unsupported-liquidity-wire-version' };
  if (limit.length > 16 || !/^[0-9]+$/.test(limit)) return { ok: false, reason: 'invalid-liquidity-wire-bound' };
  const maxBytes = Number(limit);
  if (!isLiquidityWireBound(maxBytes) || maxBytes < LIVE_LIQUIDITY_MIN_NEGOTIATED_WIRE_BYTES)
    return { ok: false, reason: 'invalid-liquidity-wire-bound' };
  return { ok: true, maxBytes, ...(aliases === 1 ? { nativeBookAliases: true as const } : {}) };
}

/** No encoded copy: bound both UTF-8 transport bytes and UTF-16 string storage. */
export function liquidityWireTextBytes(text: string, maxBytes: number): number | null {
  if (!isLiquidityWireBound(maxBytes) || typeof text !== 'string' || text.length > Math.floor(maxBytes / 2)) return null;
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else bytes += 3;
    if (bytes > maxBytes) return null;
  }
  return bytes;
}
