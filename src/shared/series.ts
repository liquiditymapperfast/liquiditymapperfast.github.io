/** Candle and open-interest series aggregated to a display timeframe. Compact array-of-arrays wire form. */
/** Timeframe name to length in ms. It has no prototype, so a name that merely sounds like an object method ("constructor") is not a timeframe. */
export const TIMEFRAMES: Readonly<Record<string, number>> = Object.freeze(Object.assign(Object.create(null) as Record<string, number>, { '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }));
/** The length of the timeframe named `name`, or null when there is none (whatever the name is: a request can say anything). */
export const timeframeMs = (name: unknown): number | null => typeof name === 'string' && Object.hasOwn(TIMEFRAMES, name) ? TIMEFRAMES[name]! : null;

export interface CandleRow { start: number; open: number; high: number; low: number; close: number; volume?: number }
/** [start, open, high, low, close, volume, sourceRows] */
export type Candle = [number, number, number, number, number, number, number];

/**
 * Candles of `tfMs` built from smaller ones. A minute that appears more than once (history and a live copy, or two pages that overlap) counts
 * once, as the row that came last: summing its volume again would double it.
 */
export function aggregateCandles(rows: Iterable<CandleRow>, tfMs: number): Candle[] {
  const buckets = new Map<number, Candle & { first: number; last: number }>();
  const once = new Map<number, CandleRow>();
  for (const row of rows) if (Number.isFinite(row.start)) once.set(row.start, row);
  for (const row of [...once.values()].sort((a, b) => a.start - b.start)) {
    const { start, open, high, low, close } = row;
    if (![start, open, high, low, close].every(Number.isFinite)) continue;
    const key = Math.floor(start / tfMs) * tfMs;
    const bucket = buckets.get(key);
    const volume = Number.isFinite(row.volume) ? row.volume! : 0;
    if (!bucket) {
      const created = [key, open, high, low, close, volume, 1] as Candle as Candle & { first: number; last: number };
      created.first = start; created.last = start; buckets.set(key, created);
    } else {
      if (start < bucket.first) { bucket[1] = open; bucket.first = start; }
      if (start >= bucket.last) { bucket[4] = close; bucket.last = start; }
      bucket[2] = Math.max(bucket[2], high); bucket[3] = Math.min(bucket[3], low); bucket[5] += volume; bucket[6] += 1;
    }
  }
  return [...buckets.values()].sort((a, b) => a[0] - b[0]).map(({ 0: t, 1: o, 2: h, 3: l, 4: c, 5: v, 6: n }) => [t, o, h, l, c, v, n] as Candle);
}

/** [start, open, high, low, close] of base open interest per bucket. */
export type OiBar = [number, number, number, number, number];
export interface OiRow { base?: unknown; observationTimestamp?: unknown; sourceTimestamp?: unknown; receivedAt?: unknown; start?: unknown; close?: unknown; open?: unknown; high?: unknown; low?: unknown }

export function aggregateOi(rows: Iterable<OiRow>, tfMs: number): OiBar[] {
  const points: { t: number; o: number; h: number; l: number; c: number }[] = [];
  for (const row of rows) {
    const bar = Number.isFinite(Number(row.start)) && Number.isFinite(Number(row.close));
    const t = bar ? Number(row.start) : Number(row.observationTimestamp ?? row.sourceTimestamp ?? row.receivedAt);
    const c = bar ? Number(row.close) : Number(row.base);
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
    points.push({ t, o: bar && Number.isFinite(Number(row.open)) ? Number(row.open) : c, h: bar && Number.isFinite(Number(row.high)) ? Number(row.high) : c, l: bar && Number.isFinite(Number(row.low)) ? Number(row.low) : c, c });
  }
  points.sort((a, b) => a.t - b.t);
  const buckets = new Map<number, OiBar>();
  for (const p of points) {
    const key = Math.floor(p.t / tfMs) * tfMs; const bucket = buckets.get(key);
    if (!bucket) buckets.set(key, [key, p.o, p.h, p.l, p.c]);
    else { bucket[2] = Math.max(bucket[2], p.h); bucket[3] = Math.min(bucket[3], p.l); bucket[4] = p.c; }
  }
  return [...buckets.values()].sort((a, b) => a[0] - b[0]);
}

/**
 * Stored OI bars plus the live samples that arrived after the newest stored bar. Persistence can lag or be suspended (a history store
 * over its size budget stops writing), so the newest data may exist only in memory; a window that reaches back into stored history must
 * not hide it.
 */
export function withLiveOi(stored: readonly OiRow[], live: readonly OiRow[], bucketMs = 60_000): OiRow[] {
  let newest = -Infinity;
  for (const row of stored) { const t = Number(row.start); if (Number.isFinite(t)) newest = Math.max(newest, t + bucketMs); }
  const fresh = live.filter(sample => { const t = Number(sample.observationTimestamp ?? sample.sourceTimestamp ?? sample.receivedAt); return Number.isFinite(t) && t >= newest; });
  return [...stored, ...fresh];
}
