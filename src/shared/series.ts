/** Candle and open-interest series aggregated to a display timeframe. Compact array-of-arrays wire form. */
/** Timeframe name to length in ms. It has no prototype, so a name that merely sounds like an object method ("constructor") is not a timeframe. */
export const TIMEFRAMES: Readonly<Record<string, number>> = Object.freeze(Object.assign(Object.create(null) as Record<string, number>, { '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }));
/** The length of the timeframe named `name`, or null when there is none (whatever the name is: a request can say anything). */
export const timeframeMs = (name: unknown): number | null => typeof name === 'string' && Object.hasOwn(TIMEFRAMES, name) ? TIMEFRAMES[name]! : null;

export interface CandleRow { start: number; open: number; high: number; low: number; close: number; volume?: number;
  /** The part of the volume bought at market (taker buys), in the same unit, where the venue reports it (Binance). */
  buy?: number;
  /**
   * Where the venue reports them (Binance): its trades (fills: one market order filled against several resting ones counts several times),
   * its quote volume (USDT for a USDT market) and the part of that bought at market. In the quote currency, never scaled by a listing's unit.
   */
  trades?: number; quote?: number; buyQuote?: number }
/**
 * [start, open, high, low, close, volume, sourceRows, takerBuys, trades, quoteVolume, quoteBought]: the taker buys only where asked for and
 * every row it was built from had them, and the last three likewise, only beside them.
 */
export type Candle = [number, number, number, number, number, number, number, number?, number?, number?, number?];

/**
 * Candles of `tfMs` built from smaller ones. A minute that appears more than once (history and a live copy, or two pages that overlap) counts
 * once, as the row that came last: summing its volume again would double it. `withBuy`: each candle also carries its taker buys, where every
 * row it is built from had them (the wire form leaves them out).
 */
export function aggregateCandles(rows: Iterable<CandleRow>, tfMs: number, withBuy = false): Candle[] {
  const buckets = new Map<number, Candle & { first: number; last: number; buy: number | null; detail: [number, number, number] | null }>();
  const once = new Map<number, CandleRow>();
  for (const row of rows) if (Number.isFinite(row.start)) once.set(row.start, row);
  for (const row of [...once.values()].sort((a, b) => a.start - b.start)) {
    const { start, open, high, low, close } = row;
    if (![start, open, high, low, close].every(Number.isFinite)) continue;
    const key = Math.floor(start / tfMs) * tfMs;
    const bucket = buckets.get(key);
    const volume = Number.isFinite(row.volume) ? row.volume! : 0, buy = withBuy && Number.isFinite(row.buy) ? row.buy! : null;
    const detail: [number, number, number] | null = withBuy && Number.isFinite(row.trades) && Number.isFinite(row.quote) && Number.isFinite(row.buyQuote) ? [row.trades!, row.quote!, row.buyQuote!] : null;
    if (!bucket) {
      const created = [key, open, high, low, close, volume, 1] as Candle as Candle & { first: number; last: number; buy: number | null; detail: [number, number, number] | null };
      created.first = start; created.last = start; created.buy = buy; created.detail = detail; buckets.set(key, created);
    } else {
      bucket.buy = bucket.buy === null || buy === null ? null : bucket.buy + buy;
      bucket.detail = bucket.detail === null || detail === null ? null : [bucket.detail[0] + detail[0], bucket.detail[1] + detail[1], bucket.detail[2] + detail[2]];
      if (start < bucket.first) { bucket[1] = open; bucket.first = start; }
      if (start >= bucket.last) { bucket[4] = close; bucket.last = start; }
      bucket[2] = Math.max(bucket[2], high); bucket[3] = Math.min(bucket[3], low); bucket[5] += volume; bucket[6] += 1;
    }
  }
  return [...buckets.values()].sort((a, b) => a[0] - b[0]).map(({ 0: t, 1: o, 2: h, 3: l, 4: c, 5: v, 6: n, buy, detail }) =>
    (withBuy && buy !== null ? (detail !== null ? [t, o, h, l, c, v, n, buy, ...detail] : [t, o, h, l, c, v, n, buy]) : [t, o, h, l, c, v, n]) as Candle);
}

/** [start, open, high, low, close] of base open interest per bucket. */
export type OiBar = [number, number, number, number, number];
export interface OiRow { base?: unknown; quote?: unknown; observationTimestamp?: unknown; sourceTimestamp?: unknown; receivedAt?: unknown; start?: unknown; close?: unknown; open?: unknown; high?: unknown; low?: unknown;
  /** Set on a venue's history reading (`fetchOiHistory`, the server's history feeds), which fills only a minute no live reading is in. */
  historySource?: unknown;
  /** A stored bar's USD (`quote`) open, high, low and close, where its samples had one. */
  quoteOpen?: unknown; quoteHigh?: unknown; quoteLow?: unknown; quoteClose?: unknown }

/**
 * The rows' USD (an inverse market's own unit) in place of their coins, for `aggregateOi`: a stored bar by its quote prices, a sample by its
 * quote; a row with none is left out.
 */
export function quoteRows(rows: readonly OiRow[]): OiRow[] {
  const out: OiRow[] = [];
  for (const row of rows) {
    const close = Number(row.quoteClose);
    if (Number.isFinite(Number(row.start)) && Number.isFinite(close) && close > 0) {
      const or = (v: unknown): number => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : close;
      out.push({ start: row.start, open: or(row.quoteOpen), high: or(row.quoteHigh), low: or(row.quoteLow), close });
    } else if (!Number.isFinite(Number(row.start)) && Number.isFinite(Number(row.quote)) && Number(row.quote) > 0) out.push({ ...row, base: row.quote });
  }
  return out;
}

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
 * Stored OI bars plus the live samples from the start of the newest stored bar on. Persistence can lag or be suspended (a history store
 * over its size budget stops writing), so the newest data may exist only in memory, and the newest stored bar may hold only the first
 * of its minute's samples: a window that reaches back into stored history must not hide what came after. A sample that bar already
 * holds only repeats it (the bar's own row sorts before the samples of its minute). Only bars (a server's store, with `start`) set the cut:
 * a venue's history readings (`fetchOiHistory`, samples a millisecond before their moment) set none, so on a page every live minute row
 * joins them. Until 2026-11-10 those readings were bars whose newest set the cut, and the page's own minute rows older than it never reached
 * a one-minute series. A history reading (`historySource`) fills only a minute no other row is in, as the server's store keeps it
 * (`HistoryStore.recordOi`): the last of its minute, it would put another source's figure in place of the live close, a few coins apart,
 * a rise and a fall in the one-minute series at every reading, read by NL/NS as positions opened and closed.
 */
export function withLiveOi(stored: readonly OiRow[], live: readonly OiRow[]): OiRow[] {
  let newest = -Infinity;
  for (const row of stored) { const t = Number(row.start); if (Number.isFinite(t)) newest = Math.max(newest, t); }
  const fresh = live.filter(sample => { const t = sampleTime(sample); return Number.isFinite(t) && t >= newest; });
  const rows = [...stored, ...fresh];
  if (!rows.some(row => row.historySource != null)) return rows; // the server's path, nearly always: its readings are older than the cut
  const held = new Set<number>();
  for (const row of rows) if (row.historySource == null) { const t = Number.isFinite(Number(row.start)) ? Number(row.start) : sampleTime(row); if (Number.isFinite(t)) held.add(Math.floor(t / OI_MINUTE_MS)); }
  return held.size ? rows.filter(row => row.historySource == null || !held.has(Math.floor(sampleTime(row) / OI_MINUTE_MS))) : rows;
}
const OI_MINUTE_MS = 60_000;
const sampleTime = (row: OiRow): number => Number(row.observationTimestamp ?? row.sourceTimestamp ?? row.receivedAt);
