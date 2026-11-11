import { COLUMN_MS, type Column } from '../../shared/recorder.ts';
import type { FlowMinuteRow } from '../../shared/flow.ts';
import type { Liquidation } from '../../shared/liquidations.ts';
import type { Print } from '../../shared/prints.ts';
import { coveredMs, union, type CoverageRow, type SeamTrade } from '../../shared/coverage.ts';
import type { OiReading } from '../../shared/engine.ts';
import { hyperliquidOneSide } from '../../shared/oi-sides.ts';
import { SIZE_EDGES, STATS_VERSION, type FootprintMinuteRow, type StoredBin, type TradeStats } from '../../shared/footprint.ts';
import type { AbsorptionGroup, AbsorptionMinute, AbsorptionStep } from '../../shared/absorption.ts';
import { parseTilesInfo, type TilesInfo } from '../archive/tiles.ts';

/**
 * The recorded history (hlm-history): minute columns of the default books, and their taker flow, liquidations, open interest, large trades,
 * footprint minutes, absorption candidates and the stretches their trades were recorded over, recorded on a server by the same rules as this
 * page records them, one compressed file per hour. Read once when the page opens, into the recordings, while the engine already runs on the
 * live feeds; the engine is given them when they are in (shared/engine.ts `attach`), so the panes show the day before the visit. A
 * minute the page already holds with at least as many samples stays as it is, and a book whose minutes here lie on another grid step than
 * the page's own keeps its own (the engine holds one step per book).
 */

/** The other recordings an hour file holds (hlm-history's rows.rs), as the page's stores keep them. */
export interface HistoryRows {
  flow: FlowMinuteRow[]; liquidations: Liquidation[]; oi: OiReading[]; prints: Print[]; coverage: CoverageRow[];
  footprint: FootprintMinuteRow[]; absorption: AbsorptionGroup[]; absorptionMinutes: AbsorptionMinute[];
  /** The hour of the file they came from (null: none). */
  hour: number | null;
}
export const noRows = (): HistoryRows => ({ flow: [], liquidations: [], oi: [], prints: [], coverage: [], footprint: [], absorption: [], absorptionMinutes: [], hour: null });
const finite = (...v: number[]): boolean => v.every(Number.isFinite);

export const HOUR_MS = 3_600_000;
/**
 * Hour files read at once. The service is behind Cloudflare (HTTP/2 and 3: one connection, many streams), and a fresh visit's day is some
 * 25 files of 0.5-1 MB: four at a time left the line idle between round trips (3.4 s for 17 MB on a fast line, Research_Findings.md). A
 * slow or data-saving line keeps four: the import gives up at its budget, and eight files half read then would be none whole.
 */
const PARALLEL = 8, PARALLEL_SLOW = 4;
const parallelFiles = (): number => {
  const link = (globalThis.navigator as { connection?: { saveData?: boolean; effectiveType?: string } } | undefined)?.connection;
  return link && (link.saveData === true || /(^|-)(2g|3g)$/.test(link.effectiveType ?? '')) ? PARALLEL_SLOW : PARALLEL;
};
/** An hour whose minutes the page already holds this share of, for every book the service records, is not read. */
const COVERED = 0.95;
/** A minute counts as held from this many samples (of twelve). */
const HELD_SAMPLES = 6;

/** One minute of one book, with the grid step it lies on. */
export interface HistoryColumn { inst: string; step: number; column: Column }
/**
 * What the service says it has: finished hours from `first` to `last` (null when none), the open hour, each book's grid step, and the
 * instruments whose trade side it records (`trades`: for a coin it records no books of, the only ones).
 */
export interface HistoryLatest {
  v: 1; coin: string; first: number | null; last: number | null; open: number | null; steps: Record<string, number>; trades?: string[]; tiles?: unknown;
  /** The open hour's closed pieces (hlm-history from 2026-11-11, `openHourParts`): `n` of them ready, cut every `ms` at the earliest. */
  pieces?: { v: 1; ms: number; n: number };
}

/**
 * An hour file's columns (layout in hlm-history's store.rs: a 16-byte header `HLMC`, version 1, the hour; then length-prefixed records), or
 * null for a file that is not one. A record cut short at the end (the open hour, read while it is written) ends the list; a record that is
 * whole but does not hold a sane minute (of this hour, bins ascending, amounts finite and not negative) is left out, the rest kept.
 */
export function decodeHour(buffer: ArrayBuffer): { hour: number; columns: HistoryColumn[]; rows: HistoryRows } | null {
  const view = new DataView(buffer), size = buffer.byteLength;
  if (size < 16 || view.getUint32(0, false) !== 0x484c4d43 || view.getUint16(4, true) !== 1) return null;
  const hour = Number(view.getBigInt64(8, true)), text = new TextDecoder(), columns: HistoryColumn[] = [], rows = noRows();
  for (let at = 16; at + 4 <= size;) {
    const length = view.getUint32(at, true), end = at + 4 + length;
    // The smallest record is 31 bytes (kind, id length, a one-letter id, time, samples, step, count, tracker samples): a shorter length is
    // not a record boundary (a zero-filled tail after a crash), and nothing after it can be trusted.
    if (end > size || length < 31) break;
    if (view.getUint8(at + 4) === 1) { const column = record(view, buffer, text, at + 4, end, hour); if (column) columns.push(column); }
    else other(view, buffer, text, at + 4, end, rows);
    at = end;
  }
  rows.hour = hour;
  return { hour, columns, rows };
}

/** The open hour's pieces as this page reads them: version 1, cut every ten minutes, at most five closed (`openHourParts`). */
const PIECE_MS = 600_000, PIECES_MAX = 5;

/**
 * The open hour as the service also serves it (2026-11-11): its closed pieces, each cached for hours by every cache, then the tail written
 * since the last of them, which alone changes every few seconds. Each is the hour's 16-byte header and a run of whole records; joined in
 * order (`joinParts`) they are the hour as written so far, byte for byte what `m1/<open>.bin` answers. Names, inside the hour: piece k is
 * open + k * 600000, the tail after k pieces open + k * 600000 + 1. Null when `latest.json` names no piece (none closed yet, or a service
 * from before) or names them in a way this page does not read: the page then reads the whole hour, at most six requests either way.
 */
export function openHourParts(latest: Pick<HistoryLatest, 'open' | 'pieces'>): number[] | null {
  const { open, pieces } = latest;
  if (typeof open !== 'number' || !Number.isSafeInteger(open) || open % HOUR_MS !== 0) return null;
  if (!pieces || typeof pieces !== 'object' || pieces.v !== 1 || pieces.ms !== PIECE_MS) return null;
  const k = pieces.n;
  if (typeof k !== 'number' || !Number.isSafeInteger(k) || k < 1 || k > PIECES_MAX) return null;
  const names: number[] = [];
  for (let i = 1; i <= k; i++) names.push(open + i * PIECE_MS);
  names.push(open + k * PIECE_MS + 1);
  return names;
}

/**
 * Parts of one hour joined into one hour file: the first part's header, then every part's records in order. Null unless each part is a file
 * of `hour` (its header) whose records are whole up to its very end: the service cuts pieces and ends the tail between records, so a part
 * that does not end on one was not sent whole, and a piece cut inside a record would make the next part's first record unreadable.
 */
export function joinParts(parts: readonly ArrayBuffer[], hour: number): ArrayBuffer | null {
  if (!parts.length) return null;
  let total = 16;
  for (const part of parts) {
    const view = new DataView(part), size = part.byteLength;
    if (size < 16 || view.getUint32(0, false) !== 0x484c4d43 || view.getUint16(4, true) !== 1 || Number(view.getBigInt64(8, true)) !== hour) return null;
    let at = 16;
    while (at + 4 <= size) { const length = view.getUint32(at, true); if (length < 31 || at + 4 + length > size) break; at += 4 + length; }
    if (at !== size) return null;
    total += size - 16;
  }
  const out = new Uint8Array(total);
  out.set(new Uint8Array(parts[0]!, 0, 16), 0);
  let at = 16;
  for (const part of parts) { out.set(new Uint8Array(part, 16), at); at += part.byteLength - 16; }
  return out.buffer;
}

/**
 * A record of another kind (rows.rs): 2 a flow minute, 3 a liquidation, 4 and 10 an open-interest reading, 5 a large trade, 6 a stretch of
 * trade coverage, 7 a footprint minute, 8 an absorption candidate group, 9 an absorption minute, into `rows` when it is whole and sane; a
 * kind this page does not know is passed over. An open-interest reading is kept on one side of every contract and marked so: kind 10 is
 * written so, kind 4 (until 2026-11-04) holds each venue's figure as this page read it then, Hyperliquid's on both sides (halved here once:
 * `shared/oi-sides.ts`).
 */
function other(view: DataView, buffer: ArrayBuffer, text: TextDecoder, from: number, end: number, rows: HistoryRows): void {
  const kind = view.getUint8(from), idLength = view.getUint8(from + 1);
  let p = from + 2;
  if (!idLength || p + idLength > end) return;
  const id = text.decode(new Uint8Array(buffer, p, idLength)); p += idLength;
  const has = (n: number): boolean => p + n <= end;
  const i64 = (): number => { const v = Number(view.getBigInt64(p, true)); p += 8; return v; };
  const f64 = (): number => { const v = view.getFloat64(p, true); p += 8; return v; };
  const u8 = (): number => view.getUint8(p++);
  const f32s = (): Float32Array => { const v = new Float32Array(buffer.slice(p, p + 240)); p += 240; return v; };
  if (kind === 2 && has(8 + 720)) {
    const t = i64(), buy = f32s(), sell = f32s(), px = f32s();
    const sane = (a: Float32Array): boolean => a.every(v => v >= 0 && Number.isFinite(v));
    if (t % COLUMN_MS === 0 && sane(buy) && sane(sell) && sane(px)) rows.flow.push({ inst: id, t, buy, sell, px });
  } else if (kind === 3 && has(34)) {
    const t = i64(), long = u8() === 1, price = f64(), usd = f64(), reported = f64(), bankruptcy = u8() === 1;
    if (finite(t, price, usd, reported) && price > 0 && usd > 0 && reported > 0) rows.liquidations.push({ t, id, side: long ? 'long' : 'short', price, usd, reported, kind: bankruptcy ? 'bankruptcy' : 'fill' });
  } else if ((kind === 4 || kind === 10) && has(33)) {
    const t = i64(), at = i64(), coins = f64(), quoted = u8() === 1, usd = f64();
    const half = kind === 4 && id === 'hyperliquid', base = half ? hyperliquidOneSide(coins) : coins, quote = half ? hyperliquidOneSide(usd) : usd;
    if (finite(t, at, base) && base > 0 && t % COLUMN_MS === 0 && (!quoted || (quote > 0 && Number.isFinite(quote)))) rows.oi.push({ venue: id, t, at, base, ...(quoted ? { quote } : {}), sides: 1 });
  } else if (kind === 5 && has(46)) {
    const t = i64(), buy = u8() === 1, price = f64(), usd = f64(), span = u8() === 1, lo = f64(), hi = f64(), n = view.getUint32(p, true);
    if (finite(t, price, usd) && price > 0 && usd > 0 && (!span || (lo > 0 && hi >= lo && Number.isFinite(hi) && n > 0))) rows.prints.push({ t, id, side: buy ? 'buy' : 'sell', price, usd, ...(span ? { lo, hi, n } : {}) });
  } else if (kind === 6 && has(17)) {
    const fromT = i64(), to = i64(), recovered = u8() === 1, seams: (SeamTrade | null)[] = [];
    for (let k = 0; k < 2; k++) {
      if (!has(2)) return;
      const present = u8() === 1, length = u8();
      if (!has(length + 8)) return;
      const seamId = text.decode(new Uint8Array(buffer, p, length)); p += length;
      const t = i64();
      seams.push(present && seamId && Number.isFinite(t) ? { id: seamId, t } : null);
    }
    if (finite(fromT, to) && to > fromT) rows.coverage.push({ inst: id, metric: 'trades', from: fromT, to, kind: recovered ? 'recovered' : 'live', ...(seams[0] ? { first: seams[0] } : {}), ...(seams[1] ? { last: seams[1] } : {}) });
  } else if (kind === 7 && has(20)) {
    const footprint = footprintMinute(view, p, end, id);
    if (footprint) rows.footprint.push(footprint);
  } else if (kind === 8 && has(21)) {
    const t0 = i64(), buy = u8() === 1, price = f64(), count = view.getUint32(p, true); p += 4;
    if (!count || !has(count * 36) || !(price > 0) || !Number.isFinite(price) || !Number.isFinite(t0)) return;
    const steps: AbsorptionStep[] = [];
    for (let k = 0; k < count; k++) {
      const credit = f64(), usd = f64(), fills = view.getUint32(p, true); p += 4;
      const first = i64(), last = i64();
      // Credits fall from step to step, USD and fills add up (`stepsOf`).
      const prev = steps[k - 1];
      if (!finite(credit, usd, first, last) || !(credit > 0) || !(usd > 0) || !(fills > 0) || last < first || (prev && !(credit < prev[0] && usd >= prev[1] && fills > prev[2]))) return;
      steps.push([credit, usd, fills, first, last]);
    }
    rows.absorption.push({ id, side: buy ? 'buy' : 'sell', price, t0, steps });
  } else if (kind === 9 && has(36)) {
    const t = i64(), n = view.getUint32(p, true); p += 4;
    const mean = f64(), m2 = f64(), floor = f64();
    if (t % COLUMN_MS === 0 && finite(mean, m2, floor) && mean >= 0 && m2 >= 0 && floor >= 0) rows.absorptionMinutes.push({ id, t, n, mean, m2, floor });
  }
}

/**
 * A footprint minute (kind 7, rows.rs): i64 t, f64 step, u32 rows, each row i32 bin, f64 buy USD, f64 sell USD, u32 buy orders, u32 sell
 * orders; then u8 statistics present and, when they are, u32 buy orders, u32 sell orders, f64 buy USD and f64 sell USD per size bucket, u32
 * large orders and f64 each (signed: a buy positive). The service's minutes always count orders by price, so every row has five numbers.
 * Null when it is not a whole, sane minute.
 */
function footprintMinute(view: DataView, from: number, end: number, inst: string): FootprintMinuteRow | null {
  let p = from;
  const has = (n: number): boolean => p + n <= end;
  const f64 = (): number => { const v = view.getFloat64(p, true); p += 8; return v; };
  const u32 = (): number => { const v = view.getUint32(p, true); p += 4; return v; };
  const t = Number(view.getBigInt64(p, true)); p += 8;
  const step = f64(), count = u32();
  if (t % COLUMN_MS !== 0 || !(step > 0) || !Number.isFinite(step) || !has(count * 28 + 1)) return null;
  const bins: StoredBin[] = [], seen = new Set<number>();
  for (let k = 0; k < count; k++) {
    const bin = view.getInt32(p, true); p += 4;
    const buy = f64(), sell = f64(), buyN = u32(), sellN = u32();
    if (seen.has(bin) || !finite(buy, sell) || buy < 0 || sell < 0 || !(buy + sell > 0)) return null;
    seen.add(bin); bins.push([bin, buy, sell, buyN, sellN]);
  }
  let stats: TradeStats | null = null;
  if (view.getUint8(p++) === 1) {
    const n = SIZE_EDGES.length;
    if (!has(8 + 16 * n + 4)) return null;
    const buyN = u32(), sellN = u32(), buy = Array.from({ length: n }, f64), sell = Array.from({ length: n }, f64), bigs = u32();
    if (!has(8 * bigs) || ![...buy, ...sell].every(v => Number.isFinite(v) && v >= 0)) return null;
    const big = Array.from({ length: bigs }, f64);
    if (!big.every(v => Number.isFinite(v) && v !== 0)) return null;
    stats = { buyN, sellN, buy, sell, v: STATS_VERSION, big };
  }
  return p === end ? { inst, t, step, bins, stats } : null;
}

/** One record of an hour file, or null when it is not a column of this hour that can be shown. */
function record(view: DataView, buffer: ArrayBuffer, text: TextDecoder, from: number, end: number, hour: number): HistoryColumn | null {
  let p = from;
  if (view.getUint8(p) !== 1) return null;
  const idLength = view.getUint8(p + 1); p += 2;
  if (!idLength || p + idLength + 28 > end) return null;
  const inst = text.decode(new Uint8Array(buffer, p, idLength)); p += idLength;
  const t = Number(view.getBigInt64(p, true)), n = view.getUint32(p + 8, true), step = view.getFloat64(p + 12, true), count = view.getUint32(p + 20, true); p += 24;
  if (p + count * 12 + 4 > end) return null;
  // Copied out: the records sit at any byte offset, and a typed array over the file's buffer would keep the whole file alive.
  const bins = new Int32Array(buffer.slice(p, p + count * 4)), bid = new Float32Array(buffer.slice(p + count * 4, p + count * 8)), ask = new Float32Array(buffer.slice(p + count * 8, p + count * 12));
  p += count * 12;
  const ltN = view.getUint32(p, true); p += 4;
  const lt = ltN > 0 && p + 128 <= end ? new Float32Array(buffer.slice(p, p + 128)) : null;
  if (lt) p += 128;
  if (p !== end || !(step > 0) || !Number.isFinite(step) || t < hour || t >= hour + HOUR_MS || t % COLUMN_MS !== 0 || n < 1 || n > 13) return null;
  for (let i = 0; i < count; i++) {
    if (i && !(bins[i]! > bins[i - 1]!)) return null;
    if (!(bid[i]! >= 0) || !(ask[i]! >= 0) || !Number.isFinite(bid[i]!) || !Number.isFinite(ask[i]!)) return null;
  }
  if (lt && !lt.every(Number.isFinite)) return null;
  return { inst, step, column: { t, n, bins, bid, ask, ...(lt ? { lt, ltN } : {}) } };
}

/** What the page holds: per book, the step of its oldest minute (the step the engine keeps) and each minute's samples. */
/**
 * `trades`: the stretches over which this page recorded each instrument's trades itself (its own trade coverage); `imported`: the hours of
 * the service it has read whole already.
 */
export interface Held { steps: Map<string, number>; samples: Map<string, number>; trades: Map<string, { from: number; to: number }[]>; imported: Set<number> }
export function heldOf(rows: Iterable<{ instrumentId: string; step: number; column: { t: number; n: number } }>, coverage: Iterable<Pick<CoverageRow, 'inst' | 'metric' | 'from' | 'to'>> = [], imported: Iterable<number> = []): Held {
  const steps = new Map<string, number>(), oldest = new Map<string, number>(), samples = new Map<string, number>(), trades = new Map<string, { from: number; to: number }[]>();
  for (const { instrumentId, step, column } of rows) {
    samples.set(`${instrumentId}|${column.t}`, column.n);
    if (!(column.t >= (oldest.get(instrumentId) ?? Infinity))) { oldest.set(instrumentId, column.t); steps.set(instrumentId, step); }
  }
  for (const { inst, metric, from, to } of coverage) {
    if (metric !== 'trades' || !(to > from)) continue;
    let list = trades.get(inst); if (!list) trades.set(inst, list = []);
    list.push({ from, to });
  }
  return { steps, samples, trades, imported: new Set(imported) };
}

/**
 * The columns of `incoming` worth adding: inside [since, before), on the grid step the page keeps for the book (its own when it holds the
 * book, otherwise the service's current one, `steps`: an older hour on a step the service has since left is not taken), and fuller than the
 * page's own copy of the minute (more samples), the fullest copy of a minute the service sent twice.
 */
export function planImport(held: Held, incoming: readonly HistoryColumn[], since: number, before: number, steps: Readonly<Record<string, number>>): HistoryColumn[] {
  const chosen = new Map<string, HistoryColumn>();
  for (const c of incoming) {
    const t = c.column.t;
    if (t < since || t >= before) continue;
    const step = held.steps.get(c.inst) ?? steps[c.inst];
    if (step === undefined || c.step !== step) continue;
    const key = `${c.inst}|${t}`;
    if ((held.samples.get(key) ?? 0) >= c.column.n) continue;
    const other = chosen.get(key);
    if (!other || c.column.n > other.column.n) chosen.set(key, c);
  }
  return [...chosen.values()];
}

/**
 * The hours worth reading: inside the retention, held by the service, and not already held by the page for every book it records, or for
 * every instrument whose trades it records (the page's own trade coverage: a page that held the books while a trade socket was down still
 * lacks that hour's trade side).
 */
export function hoursToRead(latest: HistoryLatest, held: Held, since: number, now: number): number[] {
  const out: number[] = [], books = Object.keys(latest.steps);
  const trades = Array.isArray(latest.trades) ? latest.trades.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 64) : [];
  if (!books.length && !trades.length) return out;
  /** An hour start the service could have: a whole number on an hour boundary (anything else in its answer is not read). */
  const hourOrNull = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v % HOUR_MS === 0 ? v : null;
  const first = hourOrNull(latest.first), last = hourOrNull(latest.last), open = hourOrNull(latest.open);
  // Every hour from the first the service has (or the retention's) to the open one, never more than the retention: closed hours the
  // service has not sealed yet lie between its last sealed hour and the open one, and it answers them too.
  const from = Math.max(Math.floor(since / HOUR_MS) * HOUR_MS, first ?? -Infinity), to = Math.min(Math.floor(now / HOUR_MS) * HOUR_MS, Math.max(last ?? -Infinity, open ?? -Infinity));
  // Each book on its own: one book holding half the hour is a reason to read it, whatever the others hold.
  const wanted = (hour: number): boolean => {
    const start = Math.ceil(Math.max(hour, since) / COLUMN_MS) * COLUMN_MS, end = Math.min(now, hour + HOUR_MS);
    const minutes = Math.max(0, Math.floor((end - start) / COLUMN_MS));
    if (!minutes) return false;
    return books.some(inst => {
      let have = 0;
      for (let t = start; t < end; t += COLUMN_MS) if ((held.samples.get(`${inst}|${t}`) ?? 0) >= HELD_SAMPLES) have++;
      return have < COVERED * minutes;
    }) || trades.some(inst => coveredMs(union(held.trades.get(inst) ?? [], start, end), start, end) < COVERED * (end - start));
  };
  if (Number.isFinite(from) && Number.isFinite(to)) for (let h = from; h <= to && out.length <= 25; h += HOUR_MS) if (!held.imported.has(h) && wanted(h)) out.push(h);
  return out;
}

/**
 * What the import of the trade side judges by, kept across the hours of one import: the page's own trade coverage as its recordings opened
 * (before anything was imported: hours are read newest first, and a stretch in a newer hour reaches back into the older ones, so coverage
 * merged in from the service must not count), each market's footprint step (the page's own, else the first the service gave: the recorder
 * keeps one step a market) and the service's step for each market from the newest hour read that has its minutes.
 */
export interface TradeImport { own: Map<string, { from: number; to: number }[]>; steps: Map<string, number> }
export function tradeImport(coverage: Iterable<{ inst: string; metric: string; from: number; to: number }>, footprint: Iterable<Pick<FootprintMinuteRow, 'inst' | 'step'>>): TradeImport {
  const own = new Map<string, { from: number; to: number }[]>(), steps = new Map<string, number>();
  for (const row of coverage) if (row.metric === 'trades' && row.to > row.from) { let list = own.get(row.inst); if (!list) own.set(row.inst, list = []); list.push({ from: row.from, to: row.to }); }
  // The newest row's step, as the recorder keeps it (its rows come oldest first).
  for (const row of footprint) steps.set(row.inst, row.step);
  return { own, steps };
}
/** Whether the page recorded `id`'s trades at `t` itself. */
export const ownsTime = (state: TradeImport, id: string, t: number): boolean => (state.own.get(id) ?? []).some(s => t >= s.from && t < s.to);
/** Whether the page recorded `id`'s trades over the whole minute from `t` itself. */
export const ownsMinute = (state: TradeImport, id: string, t: number): boolean => coveredMs(union(state.own.get(id) ?? [], t, t + COLUMN_MS), t, t + COLUMN_MS) >= COLUMN_MS;
export const footprintVolume = (row: Pick<FootprintMinuteRow, 'bins'>): number => { let sum = 0; for (const bin of row.bins) sum += bin[1] + bin[2]; return sum; };
/**
 * Whether `next` is a fuller copy of a footprint minute than `kept`: more volume, or as much and more of its market orders counted (a
 * minute is written while its last order is still open, and written again once that order is counted, with the same trades).
 */
export function fullerFootprint(kept: Pick<FootprintMinuteRow, 'bins' | 'stats'>, next: Pick<FootprintMinuteRow, 'bins' | 'stats'>): boolean {
  const a = footprintVolume(kept), b = footprintVolume(next);
  if (b !== a) return b > a;
  const orders = (row: Pick<FootprintMinuteRow, 'bins' | 'stats'>): [number, number] => {
    let onRows = 0; for (const bin of row.bins) onRows += (bin[3] ?? 0) + (bin[4] ?? 0);
    return [row.stats ? row.stats.buyN + row.stats.sellN : -1, onRows];
  };
  const [x0, x1] = orders(kept), [y0, y1] = orders(next);
  return y0 !== x0 ? y0 > x0 : y1 > x1;
}

/**
 * The footprint minutes of an hour worth taking: where the page did not record the whole minute itself, on the page's step for the market
 * (rows on another step are not re-binned), and fuller (`fullerFootprint`) than the copy the page holds (`held`, or undefined), the fuller
 * of two copies the service wrote of a minute. Taking one fixes the market's step (`state.steps`).
 */
export function planFootprint(state: TradeImport, rows: readonly FootprintMinuteRow[], held: (key: string) => FootprintMinuteRow | undefined): FootprintMinuteRow[] {
  const chosen = new Map<string, FootprintMinuteRow>();
  for (const row of rows) {
    const step = state.steps.get(row.inst) ?? row.step;
    if (row.step !== step || ownsMinute(state, row.inst, row.t)) continue;
    const key = `${row.inst}|${row.t}`, have = chosen.get(key) ?? held(key);
    if (have && !fullerFootprint(have, row)) continue;
    state.steps.set(row.inst, step);
    chosen.set(key, row);
  }
  return [...chosen.values()];
}

/**
 * The absorption minutes of an hour worth taking, each with its groups (a group belongs to the minute of its first fill): where the page
 * did not record the whole minute itself. Keyed `inst|minute`; the page's own groups of such a minute (found in a part of it) are to go.
 */
export function planAbsorption(state: TradeImport, minutes: readonly AbsorptionMinute[], groups: readonly AbsorptionGroup[]): Map<string, { minute: AbsorptionMinute; groups: AbsorptionGroup[] }> {
  const out = new Map<string, { minute: AbsorptionMinute; groups: AbsorptionGroup[] }>();
  for (const m of minutes) if (!ownsMinute(state, m.id, m.t)) out.set(`${m.id}|${m.t}`, { minute: m, groups: [] });
  for (const g of groups) out.get(`${g.id}|${Math.floor(g.t0 / COLUMN_MS) * COLUMN_MS}`)?.groups.push(g);
  return out;
}

/**
 * The service's stretches of trade coverage that may join the page's own: for a market whose footprint the service records on the page's
 * step, from an hour written by a build that records the footprint (`rows.footprint` not empty). Where the page then holds the trades such a
 * stretch says were recorded (`clipCoverage`), that is what the coverage record means (value areas and bar statistics judge a market's
 * share by it, and a recovery fills only what it lacks). Call after `planFootprint` for the same hour.
 */
export function planCoverage(state: TradeImport, rows: Pick<HistoryRows, 'coverage' | 'footprint'>): CoverageRow[] {
  if (!rows.footprint.length) return [];
  // A market whose minutes in this hour lie on another step than the page's is left out here; one with no minute in this hour (a quiet
  // one) waits: `clipCoverage` takes it only once a footprint minute of it on the page's step has been seen, in any hour of the import.
  const fileSteps = new Map(rows.footprint.map(row => [row.inst, row.step]));
  return rows.coverage.filter(row => { const step = fileSteps.get(row.inst); return step === undefined || step === state.steps.get(row.inst); });
}

/**
 * The parts of the stretches inside the hours `holds` says the page has the footprint of, and after `start(inst)`: a stretch in a newer hour
 * reaches back over hours that may not have been read (the import ran out of time, or a file failed) or that the service recorded before it
 * recorded the footprint (a restart onto a build that does writes the old run's stretches into the new run's first hour), and there the page
 * does not hold what it says was recorded. A part keeps a seam trade that lies inside it. `holds(hour)` should require the next hour too: a
 * minute's footprint can be written into the hour after its own. A market with no `start` (no footprint minute seen) gets nothing.
 */
export function clipCoverage(rows: readonly CoverageRow[], holds: (hour: number) => boolean, start: (inst: string) => number | undefined): CoverageRow[] {
  const out: CoverageRow[] = [];
  for (const row of rows) {
    const first = start(row.inst);
    if (first === undefined) continue;
    const begin = Math.max(row.from, first);
    for (let hour = Math.floor(begin / HOUR_MS) * HOUR_MS; hour < row.to;) {
      if (!holds(hour)) { hour += HOUR_MS; continue; }
      let end = hour + HOUR_MS;
      while (end < row.to && holds(end)) end += HOUR_MS;
      const from = Math.max(begin, hour), to = Math.min(row.to, end);
      if (!(to > from)) { hour = end; continue; }
      const inside = (seam: SeamTrade | undefined): seam is SeamTrade => seam !== undefined && seam.t >= from && seam.t < to;
      out.push({ inst: row.inst, metric: row.metric, from, to, kind: row.kind, ...(inside(row.first) ? { first: row.first } : {}), ...(inside(row.last) ? { last: row.last } : {}) });
      hour = end;
    }
  }
  return out;
}

/**
 * The rows of [since, before): the minute under way is the page's own (its trades arrive live), and a stretch of coverage is cut at it.
 */
export function within(rows: HistoryRows, since: number, before: number): HistoryRows {
  const inside = (t: number): boolean => t >= since && t < before;
  return {
    flow: rows.flow.filter(r => inside(r.t)), liquidations: rows.liquidations.filter(r => inside(r.t)), oi: rows.oi.filter(r => inside(r.t)), prints: rows.prints.filter(r => inside(r.t)),
    // A group belongs to the minute of its first fill, as the recorder keeps it.
    footprint: rows.footprint.filter(r => inside(r.t)), absorptionMinutes: rows.absorptionMinutes.filter(r => inside(r.t)),
    absorption: rows.absorption.filter(r => inside(Math.floor(r.t0 / COLUMN_MS) * COLUMN_MS)), hour: rows.hour,
    // Cut at both ends (a stretch from before `since` would say the page holds trades it did not import), keeping a seam inside it.
    coverage: rows.coverage.filter(r => r.to > since && r.from < before).map(r => {
      const from = Math.max(r.from, since), to = Math.min(r.to, before), { first, last, ...rest } = r;
      return { ...rest, from, to, ...(first && first.t >= from && first.t < to ? { first } : {}), ...(last && last.t >= from && last.t < to ? { last } : {}) };
    }),
  };
}

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; headers?: { get(name: string): string | null }; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface ImportOptions {
  /** The service's folder for the coin (`historyUrl`). */
  url: string;
  /** What the page holds, read from its recordings. */
  held: Held;
  /** Adds columns to the recordings (memory and storage); returns how many it took. */
  add: (columns: HistoryColumn[]) => number;
  /** Adds the other recordings (flow, liquidations, open interest, large trades, trade coverage) the same way; returns how many it took. */
  addRows?: (rows: HistoryRows) => number;
  since: number; now: number;
  /**
   * The whole import gives up after this, and the service's `latest.json` after `latestMs`: the page's map waits for it, so a service that
   * is slow or gone costs a visit a few seconds at most (the engine starts with what has arrived).
   */
  budgetMs?: number; latestMs?: number;
  fetcher?: Fetch;
  /** The service's `latest.json` asked for already (`readLatest`, while the page's recordings were read back): it is not asked again. */
  latest?: Promise<LatestAnswer>;
}

/** The next task: what runs on this thread between (the engine's passes) gets its turn. */
const nextTask = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** What the service's `latest.json` said, or why it could not be read (`readLatest`). */
export type LatestAnswer = { latest: HistoryLatest; error?: undefined } | { latest?: undefined; error: string };

/**
 * The service's `latest.json`, given up after `latestMs` or when `signal` aborts; never rejects. The import asks for it first; a page asks
 * for it while its recordings are read back (app/browser/feeds.worker.ts), so the import does not wait a round trip for it after them.
 */
export async function readLatest(url: string, { latestMs = 2_000, fetcher = (u, init) => fetch(u, init), signal }: { latestMs?: number; fetcher?: Fetch; signal?: AbortSignal } = {}): Promise<LatestAnswer> {
  const first = new AbortController(), timer = setTimeout(() => first.abort(), latestMs), stop = (): void => first.abort();
  signal?.addEventListener('abort', stop);
  try {
    const response = await fetcher(`${url}/latest.json`, { signal: first.signal });
    if (!response.ok) return { error: `latest.json: HTTP ${response.status}` };
    const latest = await response.json() as HistoryLatest | null;
    if (!latest || latest.v !== 1 || typeof latest.steps !== 'object' || latest.steps === null) return { error: `latest.json: unreadable (${latest === null ? 'null' : typeof latest})` };
    return { latest };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}

/**
 * Reads the hours the page lacks, newest first (what runs out of time is the oldest), and adds their minutes; resolves with what it did and
 * the service's grid steps, never rejects.
 */
export async function importHistory({ url, held, add, addRows, since, now, budgetMs = 5_000, latestMs = 2_000, fetcher = (u, init) => fetch(u, init), latest: asked }: ImportOptions): Promise<{ hours: number; columns: number; rows: number; failed: number; read: number[]; steps?: Record<string, number>; tiles?: TilesInfo | null; error?: string }> {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), budgetMs);
  const done = { hours: 0, columns: 0, rows: 0, failed: 0, read: [] as number[] };
  try {
    const answer = await (asked ?? readLatest(url, { latestMs, fetcher, signal: abort.signal }));
    if (answer.error !== undefined) return { ...done, error: answer.error };
    let latest = answer.latest;
    const steps: Record<string, number> = {};
    for (const [inst, step] of Object.entries(latest.steps)) if (typeof step === 'number' && step > 0 && Number.isFinite(step)) steps[inst] = step;
    latest = { ...latest, steps };
    const before = Math.floor(now / COLUMN_MS) * COLUMN_MS;
    const queue = hoursToRead(latest, held, since, now).reverse();
    const address = (n: number): string => `${url}/m1/${String(n).padStart(13, '0')}.bin`;
    const parts = openHourParts(latest);
    /** The open hour from its pieces and tail, read at once (`openHourParts`); null when any of them fails, and the whole hour is read. */
    const openFromParts = async (hour: number): Promise<ArrayBuffer | null> => {
      if (hour !== latest.open || !parts) return null;
      // The first part that fails stops the others: the whole hour is read instead, within the same budget.
      const own = new AbortController(), stop = (): void => own.abort();
      abort.signal.addEventListener('abort', stop);
      try {
        return joinParts(await Promise.all(parts.map(async n => {
          const r = await fetcher(address(n), { signal: own.signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        })), hour);
      } catch { own.abort(); return null; } finally { abort.signal.removeEventListener('abort', stop); }
    };
    const worker = async (): Promise<void> => {
      for (let hour = queue.shift(); hour !== undefined && !abort.signal.aborted; hour = queue.shift()) {
        try {
          const joined = await openFromParts(hour);
          let file: ReturnType<typeof decodeHour>, cache = '';
          if (joined) file = decodeHour(joined);
          else {
            const r = await fetcher(address(hour), { signal: abort.signal });
            file = r.ok ? decodeHour(await r.arrayBuffer()) : null;
            cache = r.headers?.get('cache-control') ?? '';
          }
          if (!file || file.hour !== hour) { done.failed++; continue; }
          // Decoding, taking the columns and taking the rest are each a task of their own: the page's engine runs its live feeds on this
          // thread meanwhile, and an hour in one go held the book still for a few hundred milliseconds.
          await nextTask();
          const take = planImport(held, file.columns, since, before, latest.steps);
          // What is added counts as held, so a later hour (or a minute sent twice) is judged against it.
          for (const c of take) { held.samples.set(`${c.inst}|${c.column.t}`, c.column.n); if (!held.steps.has(c.inst)) held.steps.set(c.inst, c.step); }
          done.columns += add(take);
          if (addRows) { await nextTask(); done.rows += addRows(within(file.rows, since, before)); }
          done.hours++;
          // A sealed hour (the service answers it `immutable`; an hour still open, or a copy of it a cache kept, is not) will not change:
          // it is not read again (`Held.imported`).
          if (hour + HOUR_MS <= before && hour !== latest.open && /\bimmutable\b/.test(cache)) { done.read.push(hour); held.imported.add(hour); }
        } catch { done.failed++; }
      }
    };
    await Promise.all(Array.from({ length: parallelFiles() }, worker));
    // The long history's tiles (app/archive/): read by the page from the same answer, never asked for again.
    return { ...done, steps, tiles: parseTilesInfo(latest.tiles) };
  } catch (error) {
    return { ...done, error: error instanceof Error ? error.message : String(error) };
  } finally { clearTimeout(timer); }
}
