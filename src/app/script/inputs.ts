import type { CandleRow, Market } from '../store.ts';
import type { DepthReader } from './depth.ts';
import type { CandleFlow } from '../delta/candles.ts';
import { familyKey } from '../cvd/families.ts';

/**
 * What a script reads, candle by candle, as flat arrays the page hands the script worker in one message: the chart's candles, and for each set
 * of markets a script asks for (`source(...)`, the flow column's ALL VENUES markets when it asks for none) the taker buys and sells and the
 * liquidations of each candle, in USD. A candle nothing was recorded in is NaN, never 0: a quiet candle and an unknown one must not look alike.
 */

/**
 * Which markets a set holds: by kind, exchange or quote currency (each absent: any). An exchange is its family (`binance` holds Binance's
 * spot and perpetual markets), or a family and a kind (`binance/perp`).
 */
export interface SourceFilter { kinds?: readonly ('spot' | 'perp')[]; venues?: readonly string[]; quotes?: readonly string[] }
/** A market as a filter sees it. */
export interface MarketInfo { id: string; venue: string; kind: 'spot' | 'perp'; quote: string }

/** The one key of a filter, whatever order its lists are in (the set the script worker asks for and the page answers). */
export function filterKey(f: SourceFilter): string {
  const part = (name: string, list: readonly string[] | undefined): string => list?.length ? `${name}=${[...new Set(list.map(s => s.toLowerCase()))].sort().join('+')}` : '';
  return [part('kind', f.kinds), part('venue', f.venues), part('quote', f.quotes)].filter(Boolean).join(';');
}

/** The markets of `all` a filter keeps. */
export function marketsMatching(all: readonly MarketInfo[], f: SourceFilter): string[] {
  const kinds = f.kinds?.length ? new Set(f.kinds) : null, quotes = f.quotes?.length ? new Set(f.quotes.map(q => q.toLowerCase())) : null;
  const venues = f.venues?.length ? f.venues.map(v => { const [family, kind] = v.toLowerCase().split('/'); return { family: family!, kind }; }) : null;
  return all.filter(m => {
    if (kinds && !kinds.has(m.kind)) return false;
    if (quotes && !quotes.has(m.quote.toLowerCase())) return false;
    const family = familyKey(m.venue.toLowerCase());
    return !venues || venues.some(v => v.family === family && (!v.kind || v.kind === m.kind));
  }).map(m => m.id);
}

/** A market's exchange, kind and quote from the market list (a market it does not list counts as a perpetual, as the flow column takes it). */
export function marketInfo(markets: readonly Market[], id: string): MarketInfo {
  const m = markets.find(x => (x.instrumentId ?? x.id) === id);
  const venue = m?.venue ?? id.split(':')[0] ?? id;
  return { id, venue, kind: m?.marketType === 'spot' ? 'spot' : 'perp', quote: (m?.quote ?? '').toUpperCase() };
}

/**
 * One set of markets, candle by candle (USD; NaN where not known). `recorded` says where `vbuy` and `vsell` come from: 1 recorded on the page
 * over the set's markets, 0 the own candles of the set's Binance markets (spot and perpetual, the only candles that say who bought; where
 * the page recorded none), NaN neither.
 * Absent (a test's inputs): reads NaN.
 */
export interface SourceInputs { vbuy: Float64Array; vsell: Float64Array; lbuy: Float64Array; lsell: Float64Array; recorded?: Float64Array; markets: number }

/**
 * The page's colours as a script reads them (`theme`): whether the chart's background is dark, the background and text colours, and the
 * up and down colours of its candles, as colour texts. A script coloured from them follows the theme the person picked.
 */
export interface ScriptTheme { dark: boolean; background: string; text: string; up: string; down: string }
/** What a run given no theme reads (a test's inputs): the page's default dark theme. */
export const DEFAULT_SCRIPT_THEME: ScriptTheme = { dark: true, background: '#121215', text: '#fffcf0', up: '#00d9b8', down: '#ff4d4d' };

export interface BarInputs {
  /** The chart's timeframe (ms). */
  tf: number;
  /** Each candle's start (ms), oldest first. */
  time: Float64Array;
  open: Float64Array; high: Float64Array; low: Float64Array; close: Float64Array;
  /** The chart market's traded volume, in coins. */
  volume: Float64Array;
  /** By `filterKey` ('' for the flow column's markets). */
  sources: Record<string, SourceInputs>;
  /**
   * Open interest opened (+) or closed (-) in each candle, in USD, over the perpetuals the OI pane adds up (NaN where it was not read); there
   * only when a script reads `oichg`.
   */
  oichg?: Float64Array;
  /** Whether the newest candle is still under way. */
  forming: boolean;
  /** The page's colours (`theme`; `DEFAULT_SCRIPT_THEME` when absent). Another theme is other inputs: a run under it starts from the first candle. */
  theme?: ScriptTheme;
  /**
   * The order book of each candle (`askdepth`, `biddepth`, `depthbooks`), set by the script worker from what it holds (`depth.ts DepthCache`),
   * never sent by the page; absent: they read NaN. `depthEpochs`: each candle's depth revision, so a run can tell a closed candle's depth changed.
   */
  depth?: DepthReader;
  depthEpochs?: Float64Array;
}

/**
 * A candle's taker buys and sells from its flow (the running delta over it and its gross volume): buys are half the gross plus half the
 * delta, sells the rest. NaN for both where the candle was not recorded.
 */
export function buysAndSells(flow: CandleFlow | null): [number, number] {
  return known(flow) ? [buysOf(flow), sellsOf(flow)] : [NaN, NaN];
}
/** Whether a candle's flow was recorded (`buysAndSells`), and its buys and sells: one definition, read without a pair made per candle. */
const known = (flow: CandleFlow | null): flow is CandleFlow => !!flow && Number.isFinite(flow.gross) && Number.isFinite(flow.delta);
const buysOf = (flow: CandleFlow): number => Math.max(0, (flow.gross + flow.delta) / 2);
const sellsOf = (flow: CandleFlow): number => Math.max(0, (flow.gross - flow.delta) / 2);

/**
 * Liquidations by the side of the forced order: a short position liquidated is bought back (a forced buy, `lbuy`), a long one is sold
 * (`lsell`). The page records the side of the position liquidated, so this is the one place the two are matched.
 */
export function liquidationOrderSide(positionSide: 'long' | 'short'): 'buy' | 'sell' { return positionSide === 'short' ? 'buy' : 'sell'; }

/** The candles of a timeframe as arrays (oldest first; rows out of order or repeated are left out), and whether the newest is under way at `now`. */
export function candleArrays(rows: readonly CandleRow[], tf: number, now: number): Pick<BarInputs, 'time' | 'open' | 'high' | 'low' | 'close' | 'volume' | 'forming'> {
  const kept: CandleRow[] = [];
  for (const r of rows) if (Number.isFinite(r[0]) && (!kept.length || r[0] > kept[kept.length - 1]![0])) kept.push(r);
  // One pass into the six arrays: `Float64Array.from(rows, fn)` a column at a time took a third of a script run's work on the page at
  // 100,000 candles (2026-11-10).
  const n = kept.length, time = new Float64Array(n), open = new Float64Array(n), high = new Float64Array(n), low = new Float64Array(n), close = new Float64Array(n), volume = new Float64Array(n);
  const num = (x: number | undefined): number => Number.isFinite(x) ? x! : NaN;
  for (let k = 0; k < n; k++) { const r = kept[k]!; time[k] = r[0]; open[k] = num(r[1]); high[k] = num(r[2]); low[k] = num(r[3]); close[k] = num(r[4]); volume[k] = num(r[5]); }
  return { time, open, high, low, close, volume, forming: n > 0 && kept[n - 1]![0] + tf > now };
}

/** What `sourceInputs` reads: each candle's flow over a set of markets (`delta/flows.ts deltaFlows`) and the liquidations by candle start. */
export interface SourceReader {
  flows(ids: readonly string[]): readonly (CandleFlow | null)[];
  /** Forced buys and sells by candle start over `ids`; a candle missing from the maps was not answered (NaN), one present with 0 had none. */
  liquidations(ids: readonly string[]): { buy: ReadonlyMap<number, number>; sell: ReadonlyMap<number, number> } | undefined;
  /**
   * For a set that holds Binance markets (whose own candles say who bought), read after `flows` (null for a set with none, or while one of
   * them is not read yet): where the recording of the set's flow begins (ms; null for none), and their candles' buys and sells, added up, at a
   * start (null where one of them is not known there).
   */
  candle?(ids: readonly string[]): { from: number | null; sides(start: number): readonly [number, number] | null } | null;
}

/**
 * One set of markets' inputs over `time`. A set no market on the page belongs to (an exchange the page does not read) is 0 throughout, as the
 * scripts written for it expect: a sum over many exchanges must not turn unknown because one of them is missing.
 */
export function sourceInputs(time: Float64Array, ids: readonly string[], read: SourceReader): SourceInputs {
  const n = time.length;
  if (!ids.length) return { vbuy: new Float64Array(n), vsell: new Float64Array(n), lbuy: new Float64Array(n), lsell: new Float64Array(n), recorded: new Float64Array(n).fill(NaN), markets: 0 };
  const vbuy = new Float64Array(n).fill(NaN), vsell = new Float64Array(n).fill(NaN), lbuy = new Float64Array(n).fill(NaN), lsell = new Float64Array(n).fill(NaN);
  const recorded = new Float64Array(n).fill(NaN);
  {
    const flows = read.flows(ids), candle = read.candle?.(ids) ?? null;
    for (let i = 0; i < n; i++) {
      const t = time[i]!;
      // The candle the recording began inside holds only its end: the market's own candle says the whole of it.
      const flow = candle && candle.from !== null && t < candle.from ? null : flows[i] ?? null;
      if (known(flow)) { vbuy[i] = buysOf(flow); vsell[i] = sellsOf(flow); recorded[i] = 1; continue; }
      // Not recorded (before the page opened, a gap): the set's Binance markets' own candles, where they say who bought.
      const own = candle?.sides(t);
      if (own) { vbuy[i] = own[0]; vsell[i] = own[1]; recorded[i] = 0; }
    }
    const liq = read.liquidations(ids);
    if (liq) for (let i = 0; i < n; i++) { const t = time[i]!, b = liq.buy.get(t), s = liq.sell.get(t); if (b !== undefined) lbuy[i] = b; if (s !== undefined) lsell[i] = s; }
  }
  return { vbuy, vsell, lbuy, lsell, recorded, markets: ids.length };
}

/** Every array of the inputs, each once (a buffer named twice cannot be handed over), for handing them to the worker without a copy. */
export function transferables(inputs: BarInputs): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const a of [inputs.time, inputs.open, inputs.high, inputs.low, inputs.close, inputs.volume]) out.add(a.buffer as ArrayBuffer);
  for (const s of Object.values(inputs.sources)) for (const a of [s.vbuy, s.vsell, s.lbuy, s.lsell, s.recorded]) if (a) out.add(a.buffer as ArrayBuffer);
  if (inputs.oichg) out.add(inputs.oichg.buffer as ArrayBuffer);
  return [...out];
}
