import type { Hub } from '../hub.ts';
import { TIMEFRAMES } from '../hub.ts';
import type { AppState, CandleRow } from '../store.ts';
import { FlowCache } from '../delta/candles.ts';
import { deltaFlows, deltaIds, ensureDeltaFlow } from '../delta/flows.ts';
import { flowIds, flowLoadIds } from '../cvd/ids.ts';
import { familyKey, venueOfInstrument } from '../cvd/families.ts';
import { kindOf } from '../scope.ts';
import { DAY_MS, liquidationBuckets, type LiquidationDay } from '../panes/bar-stats.ts';
import { LIQUIDATIONS_PER_ANSWER, LIQUIDATION_RETENTION_MS } from '../../shared/liquidations.ts';
import { BROWSER_RETENTION_MS } from '../../shared/recorder.ts';
import { pageNow, replaying } from '../replay/clock.ts';
import { oiPartsUntil, oiUsdChangeByTime } from '../oi-change.ts';
import { candleArrays, filterKey, marketInfo, marketsMatching, sourceInputs, type BarInputs, type SourceFilter } from './inputs.ts';
import { TakerRows } from '../measures/taker-rows.ts';
import { candleSides, candleUsd } from '../measures/volume-strip.ts';
import { DepthFeed } from './depth-feed.ts';
import { currentCoin } from '../coin.ts';
import { historyTarget, type HistoryTarget, type KeyLevelHistory } from '../keylevels/history.ts';
import type { Coin } from '../../shared/coins.ts';
import { scriptChunk, scriptStart } from './bars.ts';

/**
 * The history behind a market whose own candles say who bought: the coin's Binance perpetual or spot market, under the flow feeds' name
 * (`binancespot:BTCUSDT`) or the chart's alias of it (`binance:BTCUSDT:spot`, the same market and the same history). Null for any other.
 */
export function takerHistory(id: string, coin: Coin): HistoryTarget | null {
  const target = historyTarget(id, coin), venue = target ? target.id.slice(0, target.id.indexOf(':')) : '';
  return target?.own && (venue === 'binance' || venue === 'binancespot') ? target : null;
}

/** The same, under the feeds' own name only: the form a market is added to the sets in (`ScriptData.markets`). */
export function takerTarget(id: string, coin: Coin): HistoryTarget | null {
  const target = takerHistory(id, coin);
  return target && target.id === id ? target : null;
}

/**
 * A market's own candles that say who bought (`get`: its candle at a start, or none), and where the exchange's read of them reached the
 * market's first candle (`listedFrom`: before it the market did not trade, so it bought and sold nothing there), or null where that is not known.
 */
export interface TakerCandles { get(start: number): CandleRow | undefined; listedFrom: number | null }

/**
 * A set's buys and sells at a candle start from its markets' own candles, added up (Binance's spot and perpetual markets in it, the only
 * ones whose candles say who bought): null where one of them is not known there (a candle not read, one that does not say who bought, a gap),
 * never a sum short of a market. A market before its first candle, where the read reached it, adds nothing: a set whose perpetual is older
 * than its spot market reads the perpetual's alone before the spot market was listed.
 */
export function setSides(markets: readonly TakerCandles[], start: number): readonly [number, number] | null {
  let buy = 0, sell = 0;
  for (const m of markets) {
    const row = m.get(start), s = row ? candleSides(row, candleUsd(row)) : null;
    if (s) { buy += s.buy; sell += s.sell; }
    else if (m.listedFrom === null || start >= m.listedFrom) return null;
  }
  return [buy, sell];
}

/**
 * Whether a script history (`hub.scriptHistory`) is whole from `from`: of this market and timeframe, and reaching that start, or holding all the
 * exchange has (its history begins later, or it serves no older bars). Before that the scripts do not read it.
 */
export function wholeHistory(h: Pick<KeyLevelHistory, 'id' | 'barMs' | 'reach' | 'exhausted' | 'limited' | 'bars'>, id: string, tf: number, from: number): boolean {
  if (h.id !== id || h.barMs !== tf) return false;
  const reach = h.reach(from);
  return reach === 'yes' || (reach === 'never' && (h.exhausted || h.limited) && h.bars.length > 0);
}

/**
 * The bar at a start in bars sorted by start, for starts asked mostly in order (the scripts' candles, oldest first): a cursor that moves on,
 * searched again only when a start is asked before the last one (another set read from its first candle).
 */
export function barsAt(bars: readonly CandleRow[]): (start: number) => CandleRow | undefined {
  let i = 0;
  return start => {
    if (i > 0 && bars[i - 1]![0] >= start) {
      let lo = 0, hi = bars.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (bars[mid]![0] < start) lo = mid + 1; else hi = mid; }
      i = lo;
    }
    while (i < bars.length && bars[i]![0] < start) i++;
    return i < bars.length && bars[i]![0] === start ? bars[i] : undefined;
  };
}

/**
 * Gathers what the scripts read from what the page holds: the chart's candles, the taker flow of the flow column's ALL VENUES markets (the
 * Delta pane's, from the same flow book, so the two always count the same), and the liquidations, a UTC day per answer as the Bar stats
 * ask for them. It asks the hub for the flow the candles need and loads the liquidation days itself; `changed` is called when some landed.
 */
export class ScriptData {
  #caches = new Map<string, FlowCache>();
  #liqDays = new Map<number, LiquidationDay & { at: number }>();
  #liqLoading = new Set<number>();
  #liqRetry = new Map<number, number>();
  /** Counts what has landed, so a reader can tell new inputs from the same ones. */
  version = 0;
  /** Whether a day of liquidations the last inputs read held more than the source answers (the smallest are missing). */
  liquidationsCut = false;

  /** The order book the scripts read (`askdepth`, `biddepth`, `depthbooks`), loaded only while a script reads it. */
  readonly depth: DepthFeed;

  constructor(private hub: Hub, private changed: () => void) { this.depth = new DepthFeed(hub, () => { this.version++; this.changed(); }); }

  /**
   * The markets each filter holds, out of the flow column's ALL VENUES markets, and the coin's Binance markets the page reads (chip on, inside
   * the Spot / Perp filter, book on the map) whether or not a trade of theirs is recorded yet: their own candles say who bought before the
   * recording (`#takerCandles`), and without them a spot set read nothing but zeros in a visitor's first seconds (Sol, code review 2026-11-10,
   * round 4). Flow they have none of recorded adds nothing to what the sets count. One market an exchange and kind, as the ALL VENUES lines
   * keep (`buildFamilies`): a Binance market joins only where that lane is empty, never beside another name of the same market (the chart's
   * alias of Binance spot, with flow recorded under it) or another quote's perpetual, whose recorded flow would be added twice (round 5).
   */
  markets(state: AppState, filters: ReadonlyMap<string, SourceFilter>): Map<string, string[]> {
    const ids = deltaIds(state, this.hub.flow), coin = currentCoin();
    const lane = (id: string): string => `${familyKey(venueOfInstrument(id))}|${kindOf(state.markets, id) === 'spot' ? 'spot' : 'perp'}`;
    const lanes = new Set(ids.map(lane));
    for (const id of flowIds(state, this.hub.flow.ids)) if (takerTarget(id, coin) && !lanes.has(lane(id))) { ids.push(id); lanes.add(lane(id)); }
    const all = ids.map(id => marketInfo(state.markets, id));
    const out = new Map<string, string[]>();
    for (const [key, f] of filters) out.set(key, key === '' ? all.map(m => m.id) : marketsMatching(all, f));
    return out;
  }

  /** The chart market's own candles that say who bought, for the flow the page did not record. */
  readonly #taker = new TakerRows();

  /**
   * The inputs over the chart's candles for each filter (and the change in open interest, `withOi`); null while there are no candles. With
   * `withCandleFlow` (a script reads the flow), a candle whose flow the page did not record takes the buys and sells of the own candles of the
   * set's Binance markets, spot and perpetual, added up (`sourceInputs`, `setSides`): a spot set's CVD reaches back as far as the scripts read,
   * not only its perpetual's (Karl, 2026-11-10: a user's CVD script drew the perpetual's history and only the recorded part of spot's). The
   * flow and the liquidations are asked for only while a script reads them
   * (`withCandleFlow`; `withLiquidations`, `lbuy` or `lsell`): asked for every script, a VWAP's chart read a liquidation day per answer back
   * over its candles as the page opened, and the flow's minutes again at each step of a zoom out.
   */
  inputs(state: AppState, filters: ReadonlyMap<string, SourceFilter>, withOi = false, withCandleFlow = false, drawn: readonly CandleRow[] = state.candles, withLiquidations = true): BarInputs | null {
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, now = pageNow();
    // Right after a change of timeframe the candles of the one before are still there: read under the new one, they would be paired with
    // its flow and its market candles. Nothing until the new ones land.
    if (state.candlesTimeframe !== undefined && state.candlesTimeframe !== state.timeframe) return null;
    // The candles the chart draws (`drawn`, HeatPane.candlesDrawn): its own and the exchange's before them, so a script reaches back as far as the
    // chart does (Karl, 2026-11-03), not only to the 500th candle. In a replay only those that had closed by its moment: the one under way then
    // is not known yet, nor anything after.
    const rows = replaying() ? drawn.filter(r => r[0] + tf <= now) : drawn;
    const candles = candleArrays(rows, tf, now);
    const n = candles.time.length;
    if (!n) return null;
    const starts = Array.from(candles.time);
    if (withCandleFlow) ensureDeltaFlow(this.hub, flowLoadIds(state, this.hub.flow.ids), starts[0]!, Date.now());
    const markets = this.markets(state, filters);
    const liq = withLiquidations ? this.#liquidations(starts, tf, now) : null;
    const sources: BarInputs['sources'] = {};
    this.liquidationsCut = false;
    // The chart market's own buys and sells are asked for over the chart's own candles only, as before the scripts read further back: from an older
    // start the loader would read every candle from there to now (a 1m chart panned 60 days back: 87,000 candles, Sol 2026-11-03).
    // None while the chart has no candles of its own (a market or timeframe on its way): the start would be the history's again (Sol, round 2).
    const own = state.candles[0]?.[0];
    const taker = withCandleFlow && own !== undefined ? this.#taker.get(this.hub, state, tf, Math.max(starts[0]!, own), () => { this.version++; this.changed(); }) : null;
    // Further back, and for the sets that do not hold the chart's market: the own candles of each Binance market in the sets (`#takerCandles`).
    const held = withCandleFlow ? this.#takerCandles(state, new Set([...markets.values()].flat()), tf, starts[0]!, taker) : null;
    const earliest = new Map<string, number | null>();
    for (const [key, ids] of markets) {
      sources[key] = sourceInputs(candles.time, ids, {
        flows: list => {
          const k = list.join(',');
          let cache = this.#caches.get(k);
          if (!cache) { cache = new FlowCache(); this.#caches.set(k, cache); if (this.#caches.size > 64) this.#caches.delete(this.#caches.keys().next().value!); }
          const read = deltaFlows(cache, this.hub.flow, list, starts, tf, now);
          earliest.set(k, read.earliest);
          return read.flows;
        },
        liquidations: list => { if (!liq) return undefined; const b = liquidationBuckets(this.#liqDays, list, starts, tf, liq.cover, now); if (b.cut) this.liquidationsCut = true; return b; },
        // The set's Binance markets' own candles, added up, where the page recorded nothing: every one of them, or none (`setSides`), so a set
        // never reads a sum short of a market that is still on its way or could not be read.
        // Each market once, under whichever name the set holds it.
        candle: list => {
          if (!held) return null;
          const markets = [...new Set(list.flatMap(id => { const m = held.binance.get(id); return m === undefined ? [] : [m]; }))];
          if (!markets.length || markets.some(m => !held.candles.has(m))) return null;
          const mine = markets.map(m => held.candles.get(m)!);
          return { from: earliest.get(list.join(',')) ?? null, sides: (start: number) => setSides(mine, start) };
        },
      });
    }
    return { tf, ...candles, sources, ...(withOi ? { oichg: ScriptData.oiChange(state, candles.time, candles.close, tf, now) } : {}) };
  }

  /**
   * The own candles of each Binance market in `ids` (Binance's are the only exchange candles that say who bought: `shared/history.ts`), as
   * `TakerCandles`: its history of the chart's timeframe (`hub.scriptHistory`, the one the scripts' candles come from when the chart shows that
   * market), asked for from where the scripts' candles begin but never further back than the setting reaches (`scriptStart`), once the map has
   * its first columns, and used only once it is whole (it reaches that start, or holds all the exchange has): handed over in parts, each part
   * would be another first candle for every script. The chart market's also from its own candles (`taker`, the newer read where both have one),
   * as before the scripts read further back. `binance`: the market (its history's id) behind every Binance market of `ids`, under its feeds'
   * name or the chart's alias of it (`takerHistory`), held or not, so a set holding one not held reads none; `candles` by that market.
   */
  #takerCandles(state: AppState, ids: ReadonlySet<string>, tf: number, first: number, taker: ReadonlyMap<number, CandleRow> | null): { binance: Map<string, string>; candles: Map<string, TakerCandles> } {
    const binance = new Map<string, string>(), candles = new Map<string, TakerCandles>(), seen = new Set<string>(), coin = currentCoin(), bars = state.scriptBars;
    const chunk = scriptChunk(bars) * tf, from = Math.max(scriptStart(Date.now(), tf, bars), Math.floor(first / chunk) * chunk);
    const series = historyTarget(state.seriesInstrument || state.marketId, coin);
    for (const id of ids) {
      const target = takerHistory(id, coin);
      if (!target) continue;
      binance.set(id, target.id);
      if (seen.has(target.id)) continue;
      seen.add(target.id);
      const h = this.hub.scriptHistory(tf, bars, target.id);
      // A page that lands has the scripts look again only once the history is whole, and then at each page (the newest bars, a minute apart):
      // the parts before change nothing they read.
      if (!this.hub.firstColumnsPending()) h.ensure(target, from, tf, () => { if (wholeHistory(h, target.id, tf, from)) { this.version++; this.changed(); } });
      const whole = wholeHistory(h, target.id, tf, from);
      const long = whole ? barsAt(h.bars) : null, mine = series?.own && series.id === target.id ? taker : null;
      if (!long && !mine) continue;
      candles.set(target.id, { get: start => mine?.get(start) ?? long?.(start), listedFrom: whole ? h.listedFrom : null });
    }
    return { binance, candles };
  }

  /**
   * Each candle's change in open interest in USD, as the OI pane and the Bar stats count it (`oiUsdChangeByTime` over the same venues, the
   * candle's close as the price; in a replay only the venues' readings up to its moment). NaN where it was not read.
   */
  static oiChange(state: Pick<AppState, 'oi' | 'oiParts' | 'oiPrice'>, time: Float64Array, close: Float64Array, tf: number, now: number): Float64Array {
    const parts = oiPartsUntil(state.oiParts, tf, replaying() ? Math.floor(now / tf) * tf : Infinity);
    const closes = new Map<number, number>();
    for (let k = 0; k < time.length; k++) if (Number.isFinite(close[k]!)) closes.set(time[k]!, close[k]!);
    const change = oiUsdChangeByTime(state.oi, parts, tf, t => closes.get(t), state.oiPrice);
    return Float64Array.from(time, t => change.get(t) ?? NaN);
  }

  /** A filter's key (the same `filterKey` the scripts' analysis gives). */
  static key(f: SourceFilter): string { return filterKey(f); }

  /**
   * Ask for the liquidation days the candles reach (not before what the source keeps, nor before the recording started), two at a time;
   * a day already held is asked again once what is held of it is half a minute old while it is not over. Null when the source has none.
   */
  #liquidations(starts: readonly number[], tf: number, now: number): { cover: number } | null {
    const source = this.hub.source;
    if (!source.liquidations) return null;
    const retention = source.kind === 'browser' ? BROWSER_RETENTION_MS : LIQUIDATION_RETENTION_MS;
    const cover = Math.max(Math.ceil((Date.now() - retention) / 60_000) * 60_000, this.hub.recordedSince > 0 ? this.hub.recordedSince : 0);
    const from = Math.max(starts[0]!, cover), to = Math.min(starts[starts.length - 1]! + tf, now);
    const wall = Date.now();
    for (let day = Math.floor((to - 1) / DAY_MS) * DAY_MS; day >= Math.floor(from / DAY_MS) * DAY_MS && this.#liqLoading.size < 2; day -= DAY_MS) {
      const held = this.#liqDays.get(day);
      if (this.#liqLoading.has(day) || wall < (this.#liqRetry.get(day) ?? 0) || (held && (held.to >= day + DAY_MS || wall - held.at < 30_000))) continue;
      this.#liqLoading.add(day);
      const asked = Date.now();
      source.liquidations(day, day + DAY_MS).then(rows => {
        this.#liqRetry.delete(day);
        this.#liqDays.set(day, { rows, cut: rows.length >= LIQUIDATIONS_PER_ANSWER, to: Math.min(day + DAY_MS, asked), at: Date.now() });
        this.version++;
      }, () => { this.#liqRetry.set(day, Date.now() + 15_000); }).finally(() => { this.#liqLoading.delete(day); this.changed(); });
    }
    for (const day of [...this.#liqDays.keys()]) if (day + DAY_MS < from - DAY_MS || day > to + DAY_MS) this.#liqDays.delete(day);
    return { cover };
  }
}
