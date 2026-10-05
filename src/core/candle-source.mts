export interface CandleRow { [key: string]: unknown }

/**
 * Candle source/target contract shared by the live feed and browser.
 * Exchanges provide native one-minute rows; larger UI intervals are derived
 * only by combining observed rows.
 */
export const NATIVE_CANDLE_INTERVAL = '1m';
export const SUPPORTED_CANDLE_INTERVALS = Object.freeze(['1m', '5m', '15m', '30m', '1h']);

export function assertSupportedCandleInterval(value: unknown) {
  const interval = String(value ?? '');
  if (!SUPPORTED_CANDLE_INTERVALS.includes(interval)) throw new RangeError(`Unsupported candle interval: ${interval}`);
  return interval;
}

export function assertNativeCandleInterval(value: unknown = NATIVE_CANDLE_INTERVAL) {
  const interval = assertSupportedCandleInterval(value);
  if (interval !== NATIVE_CANDLE_INTERVAL) throw new RangeError(`Candle source must use native ${NATIVE_CANDLE_INTERVAL} interval: ${interval}`);
  return interval;
}

/** Reject a response row whose declared/duration interval contradicts the request. */
export function candleMatchesInterval(row: CandleRow | readonly unknown[] | null | undefined, interval: unknown) {
  const target = intervalMilliseconds(assertSupportedCandleInterval(interval));
  const fields = row as CandleRow | null | undefined;
  const declared = fields?.interval ?? fields?.timeframe ?? fields?.i;
  if (declared != null && String(declared) !== String(interval)) return false;
  const start = Number(Array.isArray(row) ? row[0] : (fields?.start ?? fields?.t));
  const end = Number(Array.isArray(row) ? row[6] : (fields?.end ?? fields?.T));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return true;
  const duration = end - start;
  return duration >= target - 1 && duration <= target + 1;
}

function intervalMilliseconds(value: unknown) {
  const match = /^(\d+)([mhd])$/.exec(String(value));
  if (!match) throw new RangeError(`Unsupported candle interval: ${value}`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 'm' | 'h' | 'd'];
  return Number(match[1]) * unit;
}

export function candleKey(candle: CandleRow | null | undefined) {
  return `${String(candle?.interval ?? '')}|${Number(candle?.start)}`;
}

function candleSourceRank(candle: CandleRow | null | undefined) {
  return candle?.source === 'live' ? 3 : candle?.source === 'history' ? 2 : candle?.source === 'fixture' ? 1 : 0;
}

function knownCandleSourceTime(value: unknown) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

/** Preserve a newer live/SSE row when a delayed REST history row arrives. */
export function candleCanReplace(previous: CandleRow | null | undefined, incoming: CandleRow) {
  if (!previous) return true;
  if (previous.closed === true && incoming.closed !== true) return false;
  const previousSource = knownCandleSourceTime(previous.sourceTimestamp);
  const incomingSource = knownCandleSourceTime(incoming.sourceTimestamp);
  const previousReceived = Number(previous.receivedAt);
  const incomingReceived = Number(incoming.receivedAt);
  if (previousSource != null && incomingSource == null) return false;
  if (previousSource != null && incomingSource != null && incomingSource < previousSource) return false;
  const receivedNotOlder = !Number.isFinite(previousReceived) || !Number.isFinite(incomingReceived) || incomingReceived >= previousReceived;
  const finalityUpgrade = incoming.closed === true && previous.closed !== true && (
    (previousSource != null && incomingSource != null && (incomingSource > previousSource || (incomingSource === previousSource && receivedNotOlder))) ||
    (previousSource == null && (incomingSource == null || receivedNotOlder))
  );
  const provenanceUpgrade = previous.closed === true && incoming.closed === true && previousSource == null && incomingSource != null && receivedNotOlder;
  if (candleSourceRank(incoming) < candleSourceRank(previous) && !finalityUpgrade && !provenanceUpgrade) return false;
  if (candleSourceRank(incoming) === candleSourceRank(previous) && Number.isFinite(Number(previous.receivedAt)) && Number.isFinite(Number(incoming.receivedAt)) && Number(incoming.receivedAt) < Number(previous.receivedAt)) return false;
  return true;
}

export function mergeCandleRows<E extends CandleRow, I extends CandleRow = E>(existing: readonly E[] | null = [], incoming: readonly I[] | null = []) {
  const byKey = new Map<string, E | I>();
  for (const row of existing ?? []) byKey.set(candleKey(row), row);
  for (const row of incoming ?? []) {
    const key = candleKey(row);
    if (candleCanReplace(byKey.get(key), row)) byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => Number(a.start) - Number(b.start));
}
