import { loadKernels, type Kernels } from '../kernels.ts';
import { gridStepFor } from '../../shared/grid.ts';
import type { ColumnSet, LiveBook } from '../wire.ts';
import { ltSeries, type LtParams, type LtStore } from '../lt.ts';
import { shareInCell, type CellShare } from '../cell-sources.ts';

/** A set of recorded or live columns for one instrument, flat for the raster kernel. */
interface Store { step: number; times: Float64Array; counts: Uint32Array; bins: Int32Array; bid: Float32Array; ask: Float32Array }

export type WorkerIn =
  | { type: 'columns'; stepMs: number; instruments: ColumnSet[] }
  | { type: 'live'; books: LiveBook[]; now: number }
  | { type: 'raster'; id: number; enabled: string[]; t0: number; t1: number; p0: number; p1: number; w: number; h: number; smooth: boolean }
  | { type: 'depth'; id: number; enabled: string[]; t0: number; t1: number; w: number; range: number; mids: Float64Array }
  | { type: 'lt'; id: number; enabled: string[]; t0: number; t1: number; params: LtParams }
  | { type: 'cell'; id: number; enabled: string[]; t0: number; t1: number; p0: number; p1: number };
export type { CellShare };
/** Quantiles of the non-empty cells (bid + ask USD): p15 is the black cutoff, p96 the white point, as in Bookmap's auto-contrast defaults. */
export interface RasterStats { p15: number; p50: number; p96: number; max: number; /** Where the raster's time went, in ms: building the column list, the kernel, the blur, the quantiles. */ ms?: { prep: number; kernel: number; blur: number; quant: number } }
export type WorkerOut =
  | { type: 'ready' }
  | { type: 'raster'; id: number; w: number; h: number; data: Float32Array; stats: RasterStats; busyMs: number }
  | { type: 'depth'; id: number; w: number; bid: Float32Array; ask: Float32Array }
  | { type: 'lt'; id: number; times: Float64Array; bid: Float32Array; ask: Float32Array }
  | { type: 'cell'; id: number; items: CellShare[] }
  | { type: 'error'; message: string };

const COLUMN_MS = 60_000;
/** Bookmap's Auto smoothing: a ~5 px Gaussian once price rows are under 15 px tall. */
const SMOOTH_BELOW_ROWS = 15, SMOOTH_SIGMA_ROWS = 5;
const scope = self as unknown as { onmessage: ((e: MessageEvent<WorkerIn>) => void) | null; postMessage(message: WorkerOut, transfer?: Transferable[]): void };

let kernels: Kernels | null = null;
let recorded = new Map<string, Store>();
let recordedStepMs = COLUMN_MS;
const live = new Map<string, Store & { minute: number }>();
const steps = new Map<string, number>();

function toStore(set: ColumnSet): Store {
  return { step: set.step, times: Float64Array.from(set.times), counts: Uint32Array.from(set.counts), bins: set.bins, bid: set.bid, ask: set.ask };
}

/** Convert the current book of one instrument into a single sparse column on the instrument's grid. */
function liveColumn(book: LiveBook, step: number, now: number): (Store & { minute: number }) | null {
  const k = kernels!;
  const all = [book.bids, book.asks];
  let min = Infinity, max = -Infinity;
  for (const side of all) for (let i = 0; i < side.usd.length; i++) { if (side.lo[i]! < min) min = side.lo[i]!; if (side.hi[i]! > max) max = side.hi[i]!; }
  if (!(max >= min)) return null;
  const bin0 = Math.floor(min / step), nBins = Math.min(20_000, Math.ceil(max / step) - bin0 + 1);
  const spread = (side: LiveBook['bids']) => k.spreadLevels(side.lo, side.hi, side.usd, new Uint32Array(side.usd.length), 1, step, bin0, nBins);
  const bid = spread(book.bids), ask = spread(book.asks);
  const bins: number[] = [], b: number[] = [], a: number[] = [];
  for (let i = 0; i < nBins; i++) if (bid[i]! > 0 || ask[i]! > 0) { bins.push(bin0 + i); b.push(bid[i]!); a.push(ask[i]!); }
  const minute = Math.floor(now / COLUMN_MS) * COLUMN_MS;
  return { minute, step, times: Float64Array.of(minute), counts: Uint32Array.of(bins.length), bins: Int32Array.from(bins), bid: Float32Array.from(b), ask: Float32Array.from(a) };
}

function quantiles(grid: Float32Array): RasterStats {
  const sample: number[] = [];
  const stride = Math.max(1, Math.floor(grid.length / 2 / 16_384));
  let max = 0;
  for (let i = 0; i < grid.length; i += 2 * stride) {
    const v = grid[i]! + grid[i + 1]!;
    if (v > 0) sample.push(v);
    if (v > max) max = v;
  }
  if (!sample.length) return { p15: 0, p50: 0, p96: 0, max: 0 };
  sample.sort((x, y) => x - y);
  const q = (p: number) => sample[Math.min(sample.length - 1, Math.floor(p * sample.length))]!;
  return { p15: q(0.15), p50: q(0.5), p96: q(0.96), max };
}

function raster(message: Extract<WorkerIn, { type: 'raster' }>): void {
  const started = performance.now();
  let mark = started;
  const lap = (): number => { const now = performance.now(), took = now - mark; mark = now; return took; };
  const ids = message.enabled.filter(id => recorded.has(id) || live.has(id));
  const stepArr = new Float64Array(ids.length);
  const colInst: number[] = [], colTime: number[] = [], colCount: number[] = [];
  const bins: Int32Array[] = [], bid: Float32Array[] = [], ask: Float32Array[] = [];
  const useLive = recordedStepMs === COLUMN_MS;
  ids.forEach((id, k) => {
    const rec = recorded.get(id), lv = useLive ? live.get(id) : undefined;
    stepArr[k] = rec?.step ?? lv?.step ?? 1;
    if (rec) {
      let at = 0;
      for (let c = 0; c < rec.times.length; c++) {
        const n = rec.counts[c]!, t = rec.times[c]!;
        if (!(lv && t >= lv.minute) && t + recordedStepMs > message.t0 && t < message.t1) {
          colInst.push(k); colTime.push(t); colCount.push(n);
          bins.push(rec.bins.subarray(at, at + n)); bid.push(rec.bid.subarray(at, at + n)); ask.push(rec.ask.subarray(at, at + n));
        }
        at += n;
      }
    }
    if (lv && lv.minute + COLUMN_MS > message.t0 && lv.minute < message.t1) {
      colInst.push(k); colTime.push(lv.minute); colCount.push(lv.counts[0]!);
      bins.push(lv.bins); bid.push(lv.bid); ask.push(lv.ask);
    }
  });
  const concat = <T extends Int32Array | Float32Array>(parts: T[], make: (n: number) => T): T => {
    const out = make(parts.reduce((s, p) => s + p.length, 0)); let o = 0;
    for (const p of parts) { out.set(p as never, o); o += p.length; }
    return out;
  };
  // Zoomed out, thin bins are a pixel or less and the walls in them vanish: smooth vertically, as Bookmap does once rows get under
  // 15 px tall (a Gaussian about 5 px wide). The raster has about one row per screen pixel, so sigma in rows is sigma in pixels.
  const finest = ids.length ? Math.min(...stepArr) : 0;
  const rowsPerBin = finest > 0 ? finest / ((message.p1 - message.p0) / message.h) : Infinity;
  const sigma = message.smooth && rowsPerBin < SMOOTH_BELOW_ROWS ? SMOOTH_SIGMA_ROWS : 0;
  const prep = lap();
  const data = kernels!.rasterColumns({ steps: stepArr, colInst: Uint32Array.from(colInst), colTime: Float64Array.from(colTime), colCount: Uint32Array.from(colCount),
    bins: concat(bins, n => new Int32Array(n)), bid: concat(bid, n => new Float32Array(n)), ask: concat(ask, n => new Float32Array(n)),
    stepMs: recordedStepMs, t0: message.t0, t1: message.t1, p0: message.p0, p1: message.p1, w: message.w, h: message.h, sigma });
  const kernel = lap();
  const blur = 0;
  const stats = quantiles(data); const quant = lap();
  stats.ms = { prep, kernel, blur, quant };
  scope.postMessage({ type: 'raster', id: message.id, w: message.w, h: message.h, data, stats, busyMs: performance.now() - started }, [data.buffer]);
}

/** Bid and ask USD within +-range of each pixel column's mid price, summed over venues. */
function depth(message: Extract<WorkerIn, { type: 'depth' }>): void {
  const { w, t0, t1, range, mids } = message;
  const bid = new Float32Array(w), ask = new Float32Array(w);
  const pxMs = (t1 - t0) / w;
  for (const id of message.enabled) {
    const rec = recorded.get(id);
    if (!rec) continue;
    const sumB = new Float64Array(w), sumA = new Float64Array(w), n = new Float64Array(w);
    let at = 0;
    for (let c = 0; c < rec.times.length; c++) {
      const count = rec.counts[c]!, t = rec.times[c]!;
      const x0 = Math.max(0, Math.floor((t - t0) / pxMs)), x1 = Math.min(w - 1, Math.floor((t + recordedStepMs - 1 - t0) / pxMs));
      if (x1 >= 0 && x0 < w && count > 0) {
        for (let x = x0; x <= x1; x++) {
          const mid = mids[x]!;
          if (!(mid > 0)) continue;
          const lo = mid * (1 - range), hi = mid * (1 + range);
          let b = 0, a = 0;
          for (let e = at; e < at + count; e++) {
            const price = rec.bins[e]! * rec.step;
            if (price >= lo && price < mid) b += rec.bid[e]!; else if (price >= mid && price <= hi) a += rec.ask[e]!;
          }
          sumB[x]! += b; sumA[x]! += a; n[x]! += 1;
        }
      }
      at += count;
    }
    for (let x = 0; x < w; x++) if (n[x]! > 0) { bid[x]! += sumB[x]! / n[x]!; ask[x]! += sumA[x]! / n[x]!; }
  }
  scope.postMessage({ type: 'depth', id: message.id, w, bid, ask }, [bid.buffer, ask.buffer]);
}

/** Which instruments make up one cell of the map, so the popup can say where the liquidity under the pointer comes from. */
function cell(message: Extract<WorkerIn, { type: 'cell' }>): void {
  const useLive = recordedStepMs === COLUMN_MS, items: CellShare[] = [];
  for (const id of message.enabled) {
    const rec = recorded.get(id), lv = useLive ? live.get(id) : undefined;
    const r = rec ? shareInCell(rec, recordedStepMs, message.t0, message.t1, message.p0, message.p1, lv?.minute) : { bid: 0, ask: 0 };
    const l = lv ? shareInCell(lv, COLUMN_MS, message.t0, message.t1, message.p0, message.p1) : { bid: 0, ask: 0 };
    const bid = r.bid + l.bid, ask = r.ask + l.ask;
    if (bid > 0 || ask > 0) items.push({ id, bid, ask });
  }
  scope.postMessage({ type: 'cell', id: message.id, items });
}

/** Liquidity Tracker over the aggregated recorded columns, with the live column replacing its own minute. */
function lt(message: Extract<WorkerIn, { type: 'lt' }>): void {
  const useLive = recordedStepMs === COLUMN_MS;
  const stores: LtStore[] = [];
  for (const id of message.enabled) {
    const rec = recorded.get(id), lv = useLive ? live.get(id) : undefined;
    if (rec) stores.push({ ...rec, cutoff: lv?.minute });
    if (lv) stores.push(lv);
  }
  const out = ltSeries(stores, message.t0, message.t1, recordedStepMs, message.params);
  scope.postMessage({ type: 'lt', id: message.id, times: out.times, bid: out.bid, ask: out.ask }, [out.times.buffer, out.bid.buffer, out.ask.buffer]);
}

scope.onmessage = event => {
  const message = event.data;
  try {
    if (!kernels) throw new Error('Kernels are not ready');
    if (message.type === 'columns') {
      recordedStepMs = message.stepMs;
      recorded = new Map(message.instruments.map(set => [set.id, toStore(set)]));
      for (const set of message.instruments) if (set.step > 0) steps.set(set.id, set.step);
    } else if (message.type === 'live') {
      for (const book of message.books) {
        let step = steps.get(book.id);
        if (!step) {
          const ref = book.bids.hi[0] ?? book.asks.lo[0];
          if (!ref) continue;
          step = gridStepFor(ref); steps.set(book.id, step);
        }
        const column = liveColumn(book, step, message.now);
        if (column) live.set(book.id, column); else live.delete(book.id);
      }
    } else if (message.type === 'depth') depth(message);
    else if (message.type === 'lt') lt(message);
    else if (message.type === 'cell') cell(message);
    else raster(message);
  } catch (error) { scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
};
loadKernels().then(loaded => { kernels = loaded; scope.postMessage({ type: 'ready' }); }, error => scope.postMessage({ type: 'error', message: String(error) }));
