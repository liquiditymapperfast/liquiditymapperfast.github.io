import { COLUMN_MS, type Column } from '../../shared/recorder.ts';
import type { FlowMinuteRow } from '../../shared/flow.ts';
import type { Liquidation } from '../../shared/liquidations.ts';
import type { Print } from '../../shared/prints.ts';
import { coveredMs, union, type CoverageRow, type SeamTrade } from '../../shared/coverage.ts';
import type { OiReading } from '../../shared/engine.ts';

/**
 * The recorded history (hlm-history): minute columns of the default books, and their taker flow, liquidations, open interest, large trades
 * and the stretches their trades were recorded over, recorded on a server by the same rules as this page records them, one gzip file per
 * hour. Read once when the page opens, before the engine starts, so the panes show the day before the visit instead of starting empty. A
 * minute the page already holds with at least as many samples stays as it is, and a book whose minutes here lie on another grid step than
 * the page's own keeps its own (the engine holds one step per book).
 */

/** The other recordings an hour file holds (hlm-history's rows.rs), as the page's stores keep them. */
export interface HistoryRows { flow: FlowMinuteRow[]; liquidations: Liquidation[]; oi: OiReading[]; prints: Print[]; coverage: CoverageRow[] }
export const noRows = (): HistoryRows => ({ flow: [], liquidations: [], oi: [], prints: [], coverage: [] });
const finite = (...v: number[]): boolean => v.every(Number.isFinite);

export const HOUR_MS = 3_600_000;
/** Hour files read at once. */
const PARALLEL = 4;
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
export interface HistoryLatest { v: 1; coin: string; first: number | null; last: number | null; open: number | null; steps: Record<string, number>; trades?: string[] }

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
  return { hour, columns, rows };
}

/**
 * A record of another kind (rows.rs): 2 a flow minute, 3 a liquidation, 4 an open-interest reading, 5 a large trade, 6 a stretch of trade
 * coverage, into `rows` when it is whole and sane; a kind this page does not know is passed over.
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
  } else if (kind === 4 && has(33)) {
    const t = i64(), at = i64(), base = f64(), quoted = u8() === 1, quote = f64();
    if (finite(t, at, base) && base > 0 && t % COLUMN_MS === 0 && (!quoted || (quote > 0 && Number.isFinite(quote)))) rows.oi.push({ venue: id, t, at, base, ...(quoted ? { quote } : {}) });
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
  }
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
 * The rows of [since, before): the minute under way is the page's own (its trades arrive live), and a stretch of coverage is cut at it.
 */
export function within(rows: HistoryRows, since: number, before: number): HistoryRows {
  const inside = (t: number): boolean => t >= since && t < before;
  return {
    flow: rows.flow.filter(r => inside(r.t)), liquidations: rows.liquidations.filter(r => inside(r.t)), oi: rows.oi.filter(r => inside(r.t)), prints: rows.prints.filter(r => inside(r.t)),
    coverage: rows.coverage.filter(r => r.to > since && r.from < before).map(r => r.to > before ? { ...r, to: before, ...(r.last && r.last.t >= before ? { last: undefined } : {}) } : r).map(r => { if (r.last === undefined) { const { last: _last, ...rest } = r; return rest; } return r; }),
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
}

/**
 * Reads the hours the page lacks, newest first (what runs out of time is the oldest), and adds their minutes; resolves with what it did and
 * the service's grid steps, never rejects.
 */
export async function importHistory({ url, held, add, addRows, since, now, budgetMs = 5_000, latestMs = 2_000, fetcher = (u, init) => fetch(u, init) }: ImportOptions): Promise<{ hours: number; columns: number; rows: number; failed: number; read: number[]; steps?: Record<string, number>; error?: string }> {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), budgetMs);
  const done = { hours: 0, columns: 0, rows: 0, failed: 0, read: [] as number[] };
  try {
    const first = new AbortController(), firstTimer = setTimeout(() => first.abort(), latestMs), stop = (): void => first.abort();
    abort.signal.addEventListener('abort', stop);
    let latest: HistoryLatest;
    try {
      const response = await fetcher(`${url}/latest.json`, { signal: first.signal });
      if (!response.ok) return { ...done, error: `latest.json: HTTP ${response.status}` };
      latest = await response.json() as HistoryLatest;
    } finally { clearTimeout(firstTimer); abort.signal.removeEventListener('abort', stop); }
    if (!latest || latest.v !== 1 || typeof latest.steps !== 'object' || latest.steps === null) return { ...done, error: `latest.json: unreadable (${latest === null ? 'null' : typeof latest})` };
    const steps: Record<string, number> = {};
    for (const [inst, step] of Object.entries(latest.steps)) if (typeof step === 'number' && step > 0 && Number.isFinite(step)) steps[inst] = step;
    latest = { ...latest, steps };
    const before = Math.floor(now / COLUMN_MS) * COLUMN_MS;
    const queue = hoursToRead(latest, held, since, now).reverse();
    const worker = async (): Promise<void> => {
      for (let hour = queue.shift(); hour !== undefined && !abort.signal.aborted; hour = queue.shift()) {
        try {
          const r = await fetcher(`${url}/m1/${String(hour).padStart(13, '0')}.bin`, { signal: abort.signal });
          const file = r.ok ? decodeHour(await r.arrayBuffer()) : null;
          if (!file || file.hour !== hour) { done.failed++; continue; }
          const take = planImport(held, file.columns, since, before, latest.steps);
          // What is added counts as held, so a later hour (or a minute sent twice) is judged against it.
          for (const c of take) { held.samples.set(`${c.inst}|${c.column.t}`, c.column.n); if (!held.steps.has(c.inst)) held.steps.set(c.inst, c.step); }
          done.columns += add(take);
          if (addRows) done.rows += addRows(within(file.rows, since, before));
          done.hours++;
          // A sealed hour (the service answers it `immutable`; an hour still open, or a copy of it a cache kept, is not) will not change:
          // it is not read again (`Held.imported`).
          if (hour + HOUR_MS <= before && hour !== latest.open && /\bimmutable\b/.test(r.headers?.get('cache-control') ?? '')) { done.read.push(hour); held.imported.add(hour); }
        } catch { done.failed++; }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    return { ...done, steps };
  } catch (error) {
    return { ...done, error: error instanceof Error ? error.message : String(error) };
  } finally { clearTimeout(timer); }
}
