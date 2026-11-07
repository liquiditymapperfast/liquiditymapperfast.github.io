import { TIMEFRAMES, type Hub } from '../hub.ts';
import type { AppState, OiBar } from '../store.ts';
import { resolveZone } from '../traded/settings.ts';
import { FlowCache, candleStarts, resetKeys, unrecorded, type CandleFlow, type ResetMode } from './candles.ts';
import { ensureDeltaFlow } from './flows.ts';
import { minuteOpens, nlnsModel, withLead, type NlnsCandle, type NlnsFine, type NlnsMarket } from './nlns.ts';
import { oiPartsUntil, type OiPart } from '../oi-change.ts';
import { OI_FINE_MS } from '../oi-fine.ts';
import { replaying } from '../replay/clock.ts';

const MINUTE = 60_000, HOUR = 3_600_000;
/** The minute flow is worked out again from scratch this often (its cache keeps every closed minute it saw until then). */
const FINE_CACHE_MS = 6 * 3_600_000;

/** One hour of one market's opening (`NlnsSource.hourly`): the coins its buyers and its sellers opened at market. */
export interface HourOpens { t: number; longOpened: number; shortOpened: number }

/**
 * NL/NS for every pane that shows it (the Delta pane's NL/NS, the OI pane's bars by who opened, the Funding pane's share of new positions opened
 * by buyers): one model of the view's candles, worked out once per change of what it is made of and shared, so the panes never disagree. The
 * Delta pane's candles start where its running sums restart (the day or week the view's left edge falls in); the OI pane's, which show no sums,
 * at the view's left edge (`reset` 'none'): a weekly restart on a one-minute chart would be ten thousand candles a market, worked out each
 * second for the OI pane too. Each restart keeps its own model, so the two panes do not work each other's out again.
 */
export class NlnsSource {
  /** The models worked out last, one per restart they were worked out with. */
  readonly #held = new Map<ResetMode, { key: string; oi: unknown; parts: unknown; fine: unknown; candles: unknown; model: NlnsCandle[] }>();
  /** Each market's own flow per candle and per minute (NL/NS gives each market's change to its own takers). */
  readonly #caches = new Map<string, FlowCache>();
  readonly #fineCaches = new Map<string, FlowCache>();

  constructor(private readonly hub: Pick<Hub, 'flow' | 'ensureFlow' | 'ensureFlowMinutes'>) {}

  /** The candle starts NL/NS is worked out over for the view [t0, t1]: from where the sums restart (`candleStarts`; 'none': the left edge). */
  starts(state: AppState, t0: number, t1: number, now: number, reset: ResetMode = state.delta.reset): number[] {
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, zone = resolveZone(state.traded.zone, state.timeZone);
    return candleStarts(t0, t1, now, tf, reset, zone, undefined, true);
  }

  /** The NL/NS candles of the view [t0, t1] (`starts`), the running sums restarting as `reset` says (the Delta pane's setting by default). */
  forView(state: AppState, t0: number, t1: number, now: number, reset: ResetMode = state.delta.reset): NlnsCandle[] { return this.model(state, this.starts(state, t0, t1, now, reset), now, reset); }

  /**
   * The NL/NS model of the candles from `starts` (delta/nlns.ts): the OI pane's markets (each venue's bars while it adds venues together, else
   * its one market), each with its own taker flow, its minute readings and minute flow where it has them (`oiFine`), and the chart's closes
   * where the chart's candles are that coin's own market's (a borrowed reference series is not). Replay: only the bars, minutes and candles that
   * had closed by the moment shown. Worked out again only when something it is made of changed, and at most once a second for the open
   * candle's flow.
   */
  model(state: AppState, starts: number[], now: number, reset: ResetMode = state.delta.reset): NlnsCandle[] {
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, zone = resolveZone(state.traded.zone, state.timeZone), flow = this.hub.flow;
    const aggregated = state.oiParts.length > 1, oiInst = state.oiInstrument, until = replaying() ? now : Infinity;
    const sources: { id: string; bars: readonly OiBar[] }[] = aggregated ? [...oiPartsUntil(state.oiParts, tf, until)]
      : oiInst && state.oi.length ? [{ id: oiInst, bars: replaying() ? state.oi.filter(b => b[0] + tf <= now) : state.oi }] : [];
    if (!sources.length || !starts.length) return [];
    // A reading's change is given to the takers since the reading before, which can be before the view: the candles of one hold before it
    // are worked out too (in a run of their own, so the sums still start at the view) and left out of what is drawn.
    const { all, keys } = withLead(starts, resetKeys(starts, reset, zone), tf);
    ensureDeltaFlow(this.hub, sources.map(m => m.id), all[0]!, Date.now());
    const key = `${sources.map(m => m.id).join(',')}|${tf}|${starts[0]}|${starts.length}|${starts[starts.length - 1]}|${reset}|${zone}|${flow.loads}|${Math.floor(now / 1000)}`;
    const held = this.#held.get(reset);
    if (held && held.key === key && held.oi === state.oi && held.parts === state.oiParts && held.fine === state.oiFine && held.candles === state.candles) return held.model;
    // The chart's own candles only: aggregated, any market of the coin tells the way its price went; one market, only its own candles do.
    const chart = state.seriesInstrument === state.marketId, own = aggregated ? chart : oiInst === (state.seriesInstrument || state.marketId);
    const closes = new Map(own ? state.candles.filter(c => !replaying() || c[0] + tf <= now).map(c => [c[0], c[4]] as const) : []);
    const fine = tf > MINUTE ? new Map(oiPartsUntil(state.oiFine, MINUTE, until).map(part => [part.id, part] as const)) : new Map<string, OiPart>();
    const markets: NlnsMarket[] = sources.map(m => {
      const track = flow.track(m.id);
      const flows = track ? unrecorded(all, this.#cache(this.#caches, m.id).get(`${m.id}|${tf}|${flow.loads}`, [track], all, tf, now), tf, now) : all.map(() => null);
      return { bars: m.bars, flows, fine: track ? this.#fine(fine.get(m.id), track, all, tf, now) : null };
    });
    // A venue no longer counted keeps no cache.
    for (const caches of [this.#caches, this.#fineCaches]) for (const id of caches.keys()) if (!sources.some(m => m.id === id)) caches.delete(id);
    const model = nlnsModel(all, markets, closes, keys, tf, undefined, now).filter(c => c.t >= starts[0]!);
    this.#held.set(reset, { key, oi: state.oi, parts: state.oiParts, fine: state.oiFine, candles: state.candles, model });
    return model;
  }

  /**
   * One market's new longs and new shorts each hour from `from` to `now`, from its minute readings alone (hours they do not stand for are left
   * out): the Funding pane sets each beside the hour's funding (Hyperliquid's settles each hour, the study's unit). Needs the market among those
   * counted (its minute readings are read only then) and its flow recorded; else empty. Worked out at most every ten seconds.
   */
  hourly(state: AppState, id: string, from: number, now: number): HourOpens[] {
    const part = (replaying() ? oiPartsUntil(state.oiFine, MINUTE, now) : state.oiFine).find(p => p.id === id), track = this.hub.flow.track(id);
    if (!part || !track) return [];
    const first = Math.floor(Math.max(from, now - OI_FINE_MS) / HOUR) * HOUR, hours: number[] = [];
    for (let t = first; t <= now; t += HOUR) hours.push(t);
    // Its flow is asked for here too: with the Delta pane, the OI pane and the flow column all closed, nothing else would ask.
    ensureDeltaFlow(this.hub, [id], first - HOUR, Date.now());
    const key = `${id}|${first}|${hours.length}|${this.hub.flow.loads}|${Math.floor(now / 10_000)}`, held = this.#hourly;
    if (held && held.key === key && held.part === part) return held.hours;
    const fine = this.#fine(part, track, hours, HOUR, now), opens = fine ? minuteOpens(hours, fine, HOUR, now) : [];
    const out = hours.flatMap((t, i) => { const o = opens[i]; return o ? [{ t, ...o }] : []; });
    this.#hourly = { key, part, hours: out };
    return out;
  }
  #hourly: { key: string; part: OiPart; hours: HourOpens[] } | null = null;

  #cache(caches: Map<string, FlowCache>, id: string): FlowCache {
    let cache = caches.get(id); if (!cache) { cache = new FlowCache(); caches.set(id, cache); }
    return cache;
  }

  /**
   * One market's minute readings and its flow each minute over the candles `all` (and the hold before them, where a reading's stretch can
   * start), from its first minute reading on and at most OI_FINE_MS back; null where it has none there. Only the delta of each minute is
   * read (one sample), and a long stretch with no trade is taken as not recorded, as for the candles.
   */
  #fine(part: OiPart | undefined, track: NonNullable<ReturnType<Hub['flow']['track']>>, all: readonly number[], tf: number, now: number): NlnsFine | null {
    if (!part || part.bars.length < 2) return null;
    const from = Math.max(all[0]!, Math.floor(part.bars[0]![0] / MINUTE) * MINUTE, Math.floor((now - OI_FINE_MS) / MINUTE) * MINUTE - MINUTE);
    const to = Math.min(all[all.length - 1]! + tf, now);
    if (!(to > from)) return null;
    const starts: number[] = [];
    for (let t = from; t < to; t += MINUTE) starts.push(t);
    // Keyed by the clock, not by `from`: the model and the hourly opening read the same minutes from different starts and share the cache.
    const raw: (CandleFlow | null)[] = this.#cache(this.#fineCaches, part.id).get(`${part.id}|${this.hub.flow.loads}|${Math.floor(now / FINE_CACHE_MS)}`, [track], starts, MINUTE, now, 5_000, 1);
    return { starts, bars: part.bars, flows: unrecorded(starts, raw, MINUTE, now) };
  }
}
