import type { Hub } from '../hub.ts';
import { TIMEFRAMES } from '../hub.ts';
import type { AppState, CandleRow } from '../store.ts';
import { FlowCache } from '../delta/candles.ts';
import { deltaFlows, deltaIds, ensureDeltaFlow } from '../delta/flows.ts';
import { flowFeedSpotId, flowLoadIds } from '../cvd/ids.ts';
import { DAY_MS, liquidationBuckets, type LiquidationDay } from '../panes/bar-stats.ts';
import { LIQUIDATIONS_PER_ANSWER, LIQUIDATION_RETENTION_MS } from '../../shared/liquidations.ts';
import { BROWSER_RETENTION_MS } from '../../shared/recorder.ts';
import { pageNow, replaying } from '../replay/clock.ts';
import { oiPartsUntil, oiUsdChangeByTime } from '../oi-change.ts';
import { candleArrays, filterKey, marketInfo, marketsMatching, sourceInputs, type BarInputs, type SourceFilter } from './inputs.ts';
import { TakerRows } from '../measures/taker-rows.ts';
import { candleSides, candleUsd } from '../measures/volume-strip.ts';
import { DepthFeed } from './depth-feed.ts';

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

  /** The markets each filter holds, out of the flow column's ALL VENUES markets. */
  markets(state: AppState, filters: ReadonlyMap<string, SourceFilter>): Map<string, string[]> {
    const all = deltaIds(state, this.hub.flow).map(id => marketInfo(state.markets, id));
    const out = new Map<string, string[]>();
    for (const [key, f] of filters) out.set(key, key === '' ? all.map(m => m.id) : marketsMatching(all, f));
    return out;
  }

  /** The chart market's own candles that say who bought, for the flow the page did not record. */
  readonly #taker = new TakerRows();

  /**
   * The inputs over the chart's candles for each filter (and the change in open interest, `withOi`); null while there are no candles. With
   * `withCandleFlow` (a script reads the flow), a candle whose flow the page did not record takes the chart market's own candle's buys and
   * sells, in each set that holds that market (`sourceInputs`).
   */
  inputs(state: AppState, filters: ReadonlyMap<string, SourceFilter>, withOi = false, withCandleFlow = false, drawn: readonly CandleRow[] = state.candles): BarInputs | null {
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
    ensureDeltaFlow(this.hub, flowLoadIds(state, this.hub.flow.ids), starts[0]!, Date.now());
    const markets = this.markets(state, filters);
    const liq = this.#liquidations(starts, tf, now);
    const sources: BarInputs['sources'] = {};
    this.liquidationsCut = false;
    // The chart's market as the sets name it: Binance spot is `binance:BTCUSDT:spot` on the chart, `binancespot:BTCUSDT` in the flow feeds.
    const chart = state.seriesInstrument || state.marketId, chartSpot = flowFeedSpotId(chart);
    // The chart market's own buys and sells are asked for over the chart's own candles only, as before the scripts read further back: from an older
    // start the loader would read every candle from there to now (a 1m chart panned 60 days back: 87,000 candles, Sol 2026-11-03).
    // None while the chart has no candles of its own (a market or timeframe on its way): the start would be the history's again (Sol, round 2).
    const own = state.candles[0]?.[0];
    const taker = withCandleFlow && own !== undefined ? this.#taker.get(this.hub, state, tf, Math.max(starts[0]!, own), () => { this.version++; this.changed(); }) : null;
    const sides = (start: number): readonly [number, number] | null => {
      const own = taker?.get(start), s = own ? candleSides(own, candleUsd(own)) : null;
      return s ? [s.buy, s.sell] : null;
    };
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
        candle: list => taker && (list.includes(chart) || (chartSpot !== null && list.includes(chartSpot))) ? { from: earliest.get(list.join(',')) ?? null, sides } : null,
      });
    }
    return { tf, ...candles, sources, ...(withOi ? { oichg: ScriptData.oiChange(state, candles.time, candles.close, tf, now) } : {}) };
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
