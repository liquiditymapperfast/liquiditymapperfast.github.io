import { loadKernels, type Kernels } from '../kernels.ts';
import { gridStepFor } from '../../shared/grid.ts';
import type { ColumnSet, LiveBook } from '../wire.ts';
import { ltSeries, type LtParams, type LtStore } from '../lt.ts';
import { LT_FIELDS } from '../../shared/lt-sample.ts';
import { shareInCell, type CellShare } from '../cell-sources.ts';
import { depthBands } from '../depth-series.ts';
import { dropAbsent } from './membership.ts';
import { RecordedColumns, type ColumnStore as Store } from './column-store.ts';

export type WorkerIn =
  /** These instruments' columns at this step, each replacing what was held for it (the other instruments, and the other steps, are kept). */
  | { type: 'columns'; stepMs: number; instruments: ColumnSet[] }
  /** The columns from `from` on (the start of a window) as the source has them now, replacing those held from there; at the step they were asked at. */
  | { type: 'columnsTail'; stepMs: number; from: number; instruments: ColumnSet[] }
  /** Windows of [from, to) as the source has them now (the long history's tiles came): spliced into what is held, the rest kept. */
  | { type: 'columnsRange'; stepMs: number; from: number; to: number; instruments: ColumnSet[] }
  /** Read the columns held at this step from now on (the data of a step is posted before it is used). */
  | { type: 'columnsUse'; stepMs: number }
  /** Forget these instruments' columns at this step, or all of its (`ids` null). */
  | { type: 'columnsDrop'; stepMs: number; ids: string[] | null }
  | { type: 'live'; books: LiveBook[]; now: number }
  | { type: 'raster'; id: number; enabled: string[]; t0: number; t1: number; p0: number; p1: number; w: number; h: number; smooth: boolean }
  | { type: 'depth'; id: number; enabled: string[]; t0: number; t1: number; w: number; radii: number[] }
  | { type: 'lt'; id: number; enabled: string[]; t0: number; t1: number; params: LtParams; /** Read the lane's trackers (`ltLane`) in place of the columns'. */ lane?: boolean }
  /** The trackers the lane holds, whole (a replacement): per market its windows' starts and LT_FIELDS numbers each, at this step. */
  | { type: 'ltLane'; stepMs: number; instruments: { id: string; times: Float64Array; values: Float32Array }[] }
  | { type: 'cell'; id: number; enabled: string[]; t0: number; t1: number; p0: number; p1: number };
export type { CellShare };
/** Quantiles of the non-empty cells (bid + ask USD): p15 is the black cutoff, p96 the white point. */
export interface RasterStats { p15: number; p50: number; p96: number; max: number; /** Where the raster's time went, in ms: building the column list, the kernel, the blur, the quantiles. */ ms?: { prep: number; kernel: number; blur: number; quant: number } }
export type WorkerOut =
  | { type: 'ready' }
  | { type: 'raster'; id: number; w: number; h: number; data: Float32Array; stats: RasterStats; busyMs: number }
  | { type: 'depth'; id: number; w: number; k: number; bid: Float32Array; ask: Float32Array; bidCoin: Float32Array; askCoin: Float32Array }
  | { type: 'lt'; id: number; times: Float64Array; bid: Float32Array; ask: Float32Array; estimated: boolean; stepMs: number }
  | { type: 'cell'; id: number; items: CellShare[] }
  | { type: 'error'; message: string };

const COLUMN_MS = 60_000;
/** Auto smoothing: a ~5 px Gaussian once price rows are under 15 px tall. */
const SMOOTH_BELOW_ROWS = 15, SMOOTH_SIGMA_ROWS = 5;
const scope = self as unknown as { onmessage: ((e: MessageEvent<WorkerIn>) => void) | null; postMessage(message: WorkerOut, transfer?: Transferable[]): void };

let kernels: Kernels | null = null;
/** The recorded columns by step and instrument: the panes read the current step's, of the instruments they ask for. */
const recorded = new RecordedColumns(COLUMN_MS);
/** The lane's trackers by market (`ltLane`), as stores of trackers alone, and their step. */
let lane = new Map<string, LtStore>();
let laneStepMs = COLUMN_MS;
const live = new Map<string, Store & { minute: number }>();
const steps = new Map<string, number>();

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
  const held = recorded.current, recordedStepMs = recorded.stepMs;
  const ids = message.enabled.filter(id => held.has(id) || live.has(id));
  const stepArr = new Float64Array(ids.length);
  const colInst: number[] = [], colTime: number[] = [], colCount: number[] = [];
  const bins: Int32Array[] = [], bid: Float32Array[] = [], ask: Float32Array[] = [];
  const useLive = recordedStepMs === COLUMN_MS;
  ids.forEach((id, k) => {
    const rec = held.get(id), lv = useLive ? live.get(id) : undefined;
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
  // Zoomed out, thin bins are a pixel or less and the walls in them vanish: smooth vertically once rows get under
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

/** Bid and ask within each of the nested bands (`radii`, ascending) of the books' own price in each pixel column, in USD and in coins, summed over venues (`depthBands`). */
function depth(message: Extract<WorkerIn, { type: 'depth' }>): void {
  const held = recorded.current;
  const stores = message.enabled.map(id => held.get(id)).filter((rec): rec is Store => rec !== undefined);
  const { k, bid, ask, bidCoin, askCoin } = depthBands(stores, recorded.stepMs, message.t0, message.t1, message.w, message.radii);
  scope.postMessage({ type: 'depth', id: message.id, w: message.w, k, bid, ask, bidCoin, askCoin }, [bid.buffer, ask.buffer, bidCoin.buffer, askCoin.buffer]);
}

/** Which instruments make up one cell of the map, so the popup can say where the liquidity under the pointer comes from. */
function cell(message: Extract<WorkerIn, { type: 'cell' }>): void {
  const held = recorded.current, recordedStepMs = recorded.stepMs;
  const useLive = recordedStepMs === COLUMN_MS, items: CellShare[] = [];
  for (const id of message.enabled) {
    const rec = held.get(id), lv = useLive ? live.get(id) : undefined;
    const r = rec ? shareInCell(rec, recordedStepMs, message.t0, message.t1, message.p0, message.p1, lv?.minute) : { bid: 0, ask: 0 };
    const l = lv ? shareInCell(lv, COLUMN_MS, message.t0, message.t1, message.p0, message.p1) : { bid: 0, ask: 0 };
    const bid = r.bid + l.bid, ask = r.ask + l.ask;
    if (bid > 0 || ask > 0) items.push({ id, bid, ask });
  }
  scope.postMessage({ type: 'cell', id: message.id, items });
}

/**
 * Liquidity Tracker over the recorded columns (each venue's own, kept with its minutes), with the live column replacing its own minute at
 * one-minute steps: one instant's book, measured from its own touch.
 */
function lt(message: Extract<WorkerIn, { type: 'lt' }>): void {
  const stepMs = message.lane ? laneStepMs : recorded.stepMs, useLive = stepMs === COLUMN_MS, held = recorded.current;
  const stores: LtStore[] = [];
  for (const id of message.enabled) {
    const rec = message.lane ? lane.get(id) : held.get(id), lv = useLive ? live.get(id) : undefined;
    if (rec) stores.push({ ...rec, cutoff: lv?.minute });
    if (lv) stores.push({ ...lv, instant: true });
  }
  const out = ltSeries(stores, message.t0, message.t1, stepMs, message.params);
  scope.postMessage({ type: 'lt', id: message.id, times: out.times, bid: out.bid, ask: out.ask, estimated: out.estimated, stepMs }, [out.times.buffer, out.bid.buffer, out.ask.buffer]);
}

scope.onmessage = event => {
  const message = event.data;
  try {
    if (!kernels) throw new Error('Kernels are not ready');
    if (message.type === 'columns') {
      recorded.set(message.stepMs, message.instruments);
      for (const set of message.instruments) if (set.step > 0) steps.set(set.id, set.step);
    } else if (message.type === 'columnsTail') {
      recorded.tail(message.stepMs, message.from, message.instruments);
      for (const set of message.instruments) if (set.step > 0) steps.set(set.id, set.step);
    } else if (message.type === 'columnsRange') {
      recorded.range(message.stepMs, message.from, message.to, message.instruments);
    } else if (message.type === 'columnsUse') recorded.use(message.stepMs);
    else if (message.type === 'columnsDrop') recorded.drop(message.stepMs, message.ids);
    else if (message.type === 'live') {
      dropAbsent(live, message.books.map(book => book.id));
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
    } else if (message.type === 'ltLane') {
      laneStepMs = message.stepMs;
      lane = new Map(message.instruments.map(item => [item.id, { step: 0, times: item.times, counts: new Uint32Array(item.times.length), bins: new Int32Array(0), bid: new Float32Array(0), ask: new Float32Array(0), lt: item.values, ltStride: LT_FIELDS }]));
    } else if (message.type === 'depth') depth(message);
    else if (message.type === 'lt') lt(message);
    else if (message.type === 'cell') cell(message);
    else raster(message);
  } catch (error) { scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
};
loadKernels().then(loaded => { kernels = loaded; scope.postMessage({ type: 'ready' }); }, error => scope.postMessage({ type: 'error', message: String(error) }));
