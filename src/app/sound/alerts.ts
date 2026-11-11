import type { AppState } from '../store.ts';
import type { FlowBook } from '../flow-book.ts';
import type { Note } from './rules.ts';
import { alertNotes, scriptNotes, type AlertKind } from './rules.ts';
import { Cooldowns, RateCap, WallWatch, ImbalanceWatch, bookBins, imbalanceOf } from './alert-rules.ts';
import { burst } from '../cvd/burst.ts';
import { flowIds } from '../cvd/ids.ts';
import { familyKey, venueOfInstrument } from '../cvd/families.ts';
import { activeIds, kindOf, marketIds } from '../scope.ts';
import { anomalies } from '../anomaly.ts';
import { oiChangeByTime } from '../oi-change.ts';
import { signedUsd } from '../cvd/text.ts';
import { venueLabel } from '../venues.ts';
import type { BurstEvent } from '../cvd/burst.ts';
import { TIMEFRAMES } from '../../shared/series.ts';
import { t } from '../i18n.ts';
import { scaledUsd } from '../coin.ts';
import { usd } from '../format.ts';
import { replaying } from '../replay/clock.ts';
import { DepthWatch, depthMinutes } from './depth-watch.ts';
import type { ColumnsFrame } from '../wire.ts';

export type AlertPanel = 'flow' | 'bars' | 'book' | 'depth' | 'depthPane' | 'oi' | 'script' | 'drawing';
/** What was decided for one alert: kept for the panel's "recent" list and for the harness; audible is false when the engine was locked or muted. */
export interface AlertEntry { at: number; panel: AlertPanel; kind: AlertKind; side: 'buy' | 'sell' | null; text: string; audible: boolean }

/** What the alerts read: the page state, its flow book, and something that plays notes. */
export interface AlertsHost { state: AppState }
export interface Player { play(notes: readonly Note[], force?: boolean): boolean; unlock(): Promise<unknown> }

const FLOW_COOLDOWN_MS = 90_000, WALL_COOLDOWN_MS = 30_000, IMBALANCE_COOLDOWN_MS = 300_000, BOOK_EVERY_MS = 2_000;
/** One call of a script's `alert` sounds at most this often (a script that alerts on every candle of a one-minute chart still can). */
const SCRIPT_COOLDOWN_MS = 20_000;
/** A drawn level sounds at most this often (a price hovering at it crosses it again and again). */
const LEVEL_COOLDOWN_MS = 60_000;
/** A reading older than this is history (a tab catching up after being asleep): it does not sound. */
const FRESH_MS = 4_000;
/** A candle that closed longer ago than this is not news: it was loaded, or the tab slept through it. (A new candle shows when its first tick arrives, a few seconds after the close.) */
export const BAR_FRESH_MS = 30_000;
/** The longest candle whose whole flow is asked for and summed (the page's flow history reaches back a day). */
const BAR_HISTORY_MAX_MS = 24 * 3_600_000;
const MINUTE = 60_000;
/** An exchange that traded in the five minutes before a candle began was recording when it began, and one whose flow starts later may only have started recording then. */
const BAR_LOOKBACK_MS = 5 * MINUTE;
const MAX_BURSTS = 300;
const HOUR = 3_600_000;
/** A recorded minute is asked for this long after it ends: the recorder commits it at its first sample of the next minute (every 5 s). */
const DEPTH_SETTLE_MS = 12_000;
/** A minute judged later than this after it ended (a tab that slept, an answer that came late) is history: it does not sound. */
const DEPTH_FRESH_MS = 90_000;
const DEPTH_COOLDOWN_MS = 300_000;
/** The recorded columns of instruments over [from, to), one-minute steps (the page's data source). */
export type ColumnsReader = (ids: string[], from: number, to: number) => Promise<ColumnsFrame>;

/**
 * The sounds the panels may make beyond the large-trade tiers. Every rule is off until chosen, only fires on what is new (never on
 * history, never during warm-up), has its own cool-down, and shares one cap on how many sounds can come in a short while. The central
 * Sounds switch and volume govern all of it. Detection is in `alert-rules.ts` and `cvd/burst.ts`; this class reads the page, decides
 * what to ask them, and records what happened.
 */
export class Alerts {
  readonly log: AlertEntry[] = [];
  /**
   * Per market, the end of the newest stretch filled from the venue's trade history: its seconds may sit in the burst window for a moment, and
   * recovered trades never sound, so a market is not looked at until the window has passed them.
   */
  readonly recovered = new Map<string, number>();
  /** Flow bursts seen while the page was open, for the markers on the flow column's rows (oldest first). */
  readonly bursts: BurstEvent[] = [];
  readonly #cool = new Cooldowns();
  readonly #cap = new RateCap(4, 10_000);
  readonly #walls = new WallWatch();
  readonly #balance = new ImbalanceWatch();
  #balanceStarts = -1;
  #lastBook = 0; #lastBar = 0; #lastOi = 0;
  /** Which market and timeframe the candles (and the open-interest bars) being watched belong to: another one starts from scratch. */
  #barKey = ''; #oiKey = '';
  #timer: number | undefined;
  /** The depth sound: its minutes, what they were loaded for, and where the next question starts (the end of the last one asked). */
  readonly #depth = new DepthWatch();
  #depthKey = ''; #depthTo = 0; #depthBusy = false; #depthWait = 0;
  /** For the Sounds panel: complete minutes the depth sound holds, and whether it is still loading the hours before. Null while it is off. */
  depthState: { minutes: number; loading: boolean } | null = null;
  onChange: () => void = () => {};

  /**
   * `ensure` asks for the flow history of instruments from a time on (the page's `ensureFlow`): the sum over a whole candle needs the whole
   * of it, and the flow column that normally asks for history may be hidden. Without it only what the flow book already holds can be summed.
   * `columns` reads the recording for the depth sound; without it that sound never starts.
   */
  constructor(private host: AlertsHost, private flow: FlowBook, private player: Player, private clock: () => number = Date.now, private ensure?: (ids: readonly string[], from: number) => void, private columns?: ColumnsReader) {}

  start(): void { if (this.#timer === undefined) this.#timer = window.setInterval(() => this.tick(this.clock()), 1000); }
  stop(): void { if (this.#timer !== undefined) window.clearInterval(this.#timer); this.#timer = undefined; }

  /** One look at everything (every second); `now` is the clock, so a test steps it. */
  tick(now: number): void {
    if (replaying()) return;
    this.#flow(now); this.#book(now); this.#bars(now); this.#depthPane(now); this.#oi(now);
  }

  get #s(): AppState { return this.host.state; }

  #fire(now: number, panel: AlertPanel, kind: AlertKind, side: 'buy' | 'sell' | null, text: string, key: string, cooldownMs: number, notes = alertNotes(kind, side, this.#s.sounds.volume)): void {
    const sounds = this.#s.sounds;
    if (!sounds.on) return;
    if (!this.#cool.take(key, now, cooldownMs) || !this.#cap.allow(now)) return;
    // An alert with no sound (a script's `sound=none`) is only listed: there was nothing to hear.
    const audible = notes.length ? this.player.play(notes) : true;
    this.log.push({ at: now, panel, kind, side, text, audible });
    if (this.log.length > 100) this.log.splice(0, this.log.length - 100);
    this.onChange();
  }

  // ---- Flow ----------------------------------------------------------------------------------------------------------------------

  #flow(now: number): void {
    const s = this.#s, rule = s.sounds.panels.flow;
    // Bursts are marked on the column whether or not they sound, so they are looked for while the column shows its marks or the rule is on.
    if (!(s.show.cvd && s.cvd.bursts) && !rule.burst) return;
    const nowSec = Math.floor(now / 1000);
    for (const id of flowIds(s, this.flow.ids)) {
      const series = this.flow.get(id); if (!series || (this.recovered.get(id) ?? 0) > now - 12_000) continue;
      const found = burst(series, nowSec, { windowSec: 10, baselineSec: 1_800, k: rule.sensitivity, minUsd: scaledUsd(rule.usd) });
      if (!found || series.span!.last < nowSec - 2) continue;
      if (this.bursts.some(b => b.id === id && now - b.t < FLOW_COOLDOWN_MS)) continue;
      const kind = kindOf(s.markets, id) === 'spot' ? 'spot' : 'perp', family = familyKey(venueOfInstrument(id));
      this.bursts.push({ ...found, t: now, id, family, kind });
      if (this.bursts.length > MAX_BURSTS) this.bursts.splice(0, this.bursts.length - MAX_BURSTS);
      if (rule.burst) this.#fire(now, 'flow', 'flow-burst', found.delta > 0 ? 'buy' : 'sell', t('{venue} {kind}: {delta} of taker flow in 10 s', { venue: venueLabel(id), kind: kind === 'spot' ? t('spot') : t('perp'), delta: signedUsd(found.delta) }), `flow:${id}`, FLOW_COOLDOWN_MS);
      this.onChange();
    }
  }

  // ---- The book: walls and the balance ---------------------------------------------------------------------------------------------

  #book(now: number): void {
    if (now - this.#lastBook < BOOK_EVERY_MS) return;
    this.#lastBook = now;
    const s = this.#s, panels = s.sounds.panels, mark = s.mark.price;
    if (!panels.book.wall && !panels.depth.imbalance) { this.#walls.reset(); return; }
    if (!s.levels || !(mark > 0) || now - s.levels.asOf > FRESH_MS) return;
    const active = new Set(activeIds(s)), bins = bookBins(s.levels, active, mark, 0.01);
    // The books the bins are made of, what each covers, and the market whose price centres them: when any changes (a venue chip, a venue that
    // dropped out of the feed, a book seeded again or whose coverage grew, another chart market) the walls start over, and the balance only
    // watches until they have warmed up again.
    const context = `${s.levels.books.filter(book => active.has(book.id)).map(book => book.epoch ? `${book.id}#${book.epoch}` : book.id).sort().join(',')}|${s.marketId}|${s.seriesInstrument}`;
    for (const signal of this.#walls.update(now, bins, mark, scaledUsd(panels.book.usd), context)) {
      if (!panels.book.wall) continue;
      const word = signal.kind === 'appeared' ? t('wall appeared') : t('wall pulled');
      this.#fire(now, 'book', signal.kind === 'appeared' ? 'wall-appeared' : 'wall-pulled', signal.side, `${signal.side === 'buy' ? t('Bid') : t('Ask')} ${word}: $${usd(signal.usd)}`, `wall:${signal.side}:${signal.kind}`, WALL_COOLDOWN_MS);
    }
    // The balance starts over with the walls (another set of books or market, a gap), so a book found lopsided before says nothing now.
    if (this.#walls.starts !== this.#balanceStarts) { this.#balance.reset(); this.#balanceStarts = this.#walls.starts; }
    const tip = this.#balance.update(imbalanceOf(bins), panels.depth.pct, !this.#walls.warming(now));
    if (tip && panels.depth.imbalance) this.#fire(now, 'depth', 'imbalance', tip, tip === 'buy' ? t('Bids outweigh asks within 1% of the price') : t('Asks outweigh bids within 1% of the price'), 'imbalance', IMBALANCE_COOLDOWN_MS);
  }

  // ---- Candle closes ---------------------------------------------------------------------------------------------------------------

  #bars(now: number): void {
    const s = this.#s, candles = s.candles, rule = s.sounds.panels.bars;
    if (candles.length < 2) return;
    const key = `${s.seriesInstrument || s.marketId}|${s.timeframe}`;
    if (key !== this.#barKey) { this.#barKey = key; this.#lastBar = 0; }
    const tf = TIMEFRAMES[s.timeframe] ?? 3_600_000, newest = candles[candles.length - 1]![0];
    const ids = flowIds(s, this.flow.ids);
    // The flow of the candle that is open is asked for now, so that when it closes the whole of it is here (with the flow column hidden nothing else asks).
    if (rule.delta && tf <= BAR_HISTORY_MAX_MS) this.ensure?.(ids, newest - BAR_LOOKBACK_MS);
    if (newest === this.#lastBar) return;
    const previous = this.#lastBar; this.#lastBar = newest;
    if (previous === 0 || !rule.delta) return;              // the first load is history
    const start = candles[candles.length - 2]![0], end = start + tf;
    // A fresh, continuous close: the bar that was the newest has just closed (not a candle that was loaded, not one that closed while the tab slept, not a gap in what is loaded).
    if (start !== previous || now - end > BAR_FRESH_MS || tf > BAR_HISTORY_MAX_MS) return;
    if (!this.#whole(ids, start, tf)) return;
    const startSec = Math.floor(start / 1000), endSec = Math.floor(end / 1000) - 1;
    let delta = 0;
    for (const id of ids) delta += this.flow.get(id)?.delta(startSec, endSec) ?? 0;
    if (Math.abs(delta) < scaledUsd(rule.usd)) return;
    this.#fire(now, 'bars', 'bar-delta', delta > 0 ? 'buy' : 'sell', t('{timeframe} candle closed with {delta} of net taker flow', { timeframe: s.timeframe, delta: signedUsd(delta) }), 'bar-delta', 1_000);
  }

  /**
   * Whether the flow book holds the whole of the candle from `start`, for every exchange that has flow in it: the history has been asked for
   * and has come, and each of them was recording when the candle began. An exchange whose flow starts later (it connected late, or was
   * switched on part-way through) is counted for only a part of the candle however full the others are, and a sum with part of an
   * exchange in it is not the candle's delta. The minutes asked for before the candle are what show an exchange that was recording and
   * only quiet at the start; one that moved nothing in the candle has nothing to miss.
   */
  #whole(ids: readonly string[], start: number, tf: number): boolean {
    if (!ids.length) return false;
    if (this.ensure && this.flow.missing(ids, start - BAR_LOOKBACK_MS).length) return false;
    const startSec = Math.floor(start / 1000), endSec = Math.floor((start + tf) / 1000) - 1, late = start + Math.min(MINUTE, tf / 20);
    for (const id of ids) {
      const series = this.flow.get(id);
      if (!series || !(series.gross(startSec, endSec) > 0)) continue;
      const first = series.span?.first;
      if (first === undefined || first * 1000 > late) return false;
    }
    return true;
  }

  // ---- The Depth pane: an extreme balance -------------------------------------------------------------------------------------------

  /**
   * Reads the recording a minute at a time, once each minute has been committed, and judges it against the hours before (`DepthWatch`).
   * Those hours are loaded an hour per question when the sound starts, or when the instruments, the band or the hours change, and judged
   * on the way (silently: they are history); only a fresh minute sounds. Nothing is read while the sound is off.
   */
  #depthPane(now: number): void {
    const s = this.#s, rule = s.sounds.panels.depthPane;
    // The sound is the order book's: while the Depth pane shows liquidation levels it is quiet (the switch keeps its setting).
    if (!s.sounds.on || !rule.extreme || !this.columns || s.depthSource === 'liq') {
      if (this.#depthKey) { this.#depth.reset(); this.#depthKey = ''; this.depthState = null; }
      return;
    }
    // The markets from the market list, so a book that drops out is a gap (`DepthWatch` leaves such minutes out), not a reload of the hours.
    const ids = marketIds(s), key = `${ids.join(',')}|${rule.range}|${rule.hours}`;
    if (key !== this.#depthKey) { this.#depth.reset(); this.#depthKey = key; this.#depthTo = 0; this.#depthWait = 0; this.depthState = { minutes: 0, loading: true }; }
    if (this.#depthBusy || now < this.#depthWait || !ids.length) return;
    // Every minute before `settled` has been committed; the first question goes back the whole baseline, an hour at a time.
    const settled = Math.floor((now - DEPTH_SETTLE_MS) / MINUTE) * MINUTE, from = this.#depthTo || settled - rule.hours * HOUR;
    if (from >= settled) return;
    const to = Math.min(settled, from + HOUR), reader = this.columns;
    this.#depthBusy = true;
    reader(ids, from, to).then(frame => {
      if (key !== this.#depthKey) return;
      const minutes = depthMinutes(frame, from, to, rule.range);
      // Everything the first of these minutes is judged against stays until they all have been; only then are the older ones forgotten.
      this.#depth.add(minutes, from - rule.hours * HOUR);
      this.#depthTo = to;
      // Every minute goes through the watch in order, the hours loaded at the start and those caught up after a pause too, so it re-arms
      // where the balance came back to its usual; only a fresh minute sounds, and only while the rule is still on and no replay has
      // begun since the question was asked (the answer can come after either).
      try {
        for (const m of minutes) {
          const signal = this.#depth.judge(m.t, rule);
          if (!signal || this.clock() - (m.t + MINUTE) > DEPTH_FRESH_MS || replaying() || !this.#s.sounds.panels.depthPane.extreme || this.#s.depthSource === 'liq') continue;
          const change = (v: number, usual: number): string => usual > 0 ? `${v >= usual ? '+' : '-'}${Math.round(Math.abs(v / usual - 1) * 100)}%` : '–';
          const values = { range: `${Math.round(rule.range * 1_000) / 10}%`, pct: String(rule.pct), hours: String(rule.hours), bids: change(signal.bid, signal.usualBid), asks: change(signal.ask, signal.usualAsk) };
          this.#fire(this.clock(), 'depthPane', 'depth-extreme', signal.side, signal.side === 'buy'
            ? t('Bids outweigh asks within {range} more than in {pct} % of the last {hours} h; bids {bids}, asks {asks} against usual', values)
            : t('Asks outweigh bids within {range} more than in {pct} % of the last {hours} h; bids {bids}, asks {asks} against usual', values), 'depth-extreme', DEPTH_COOLDOWN_MS);
        }
      } finally {
        // Whatever happened above, the watch keeps only what the next minute is judged against.
        this.#depth.forget(to - rule.hours * HOUR - MINUTE);
        this.depthState = { minutes: this.#depth.size, loading: to < settled };
      }
      this.onChange();
    }, () => { if (key === this.#depthKey) this.#depthWait = this.clock() + 30_000; }).finally(() => { this.#depthBusy = false; });
  }

  #oi(now: number): void {
    const s = this.#s, bars = s.oi;
    if (bars.length < 14) return;
    const key = `${s.oiInstrument}|${s.oiParts.map(part => part.id).join(',')}|${s.timeframe}`;
    if (key !== this.#oiKey) { this.#oiKey = key; this.#lastOi = 0; }
    const newest = bars[bars.length - 1]![0];
    if (newest === this.#lastOi) return;
    const previous = this.#lastOi; this.#lastOi = newest;
    if (previous === 0 || !s.sounds.panels.oi.jump || !s.highlight.on) return;
    const tf = TIMEFRAMES[s.timeframe] ?? 3_600_000, closed = bars.length - 2;
    if (bars[closed]![0] !== previous || now - (previous + tf) > BAR_FRESH_MS) return;           // a fresh, continuous close, as for the flow
    // The change as the OI pane counts it (venues added together: each its own), so the alert sounds for what the pane flags.
    const change = oiChangeByTime(bars, s.oiParts, tf), changes = Float64Array.from(bars, bar => Math.abs(change.get(bar[0]) ?? 0));
    if (anomalies(changes, s.highlight).flag[closed] !== 1) return;
    this.#fire(now, 'oi', 'oi-jump', null, t('Open interest changed unusually in the candle that just closed'), 'oi-jump', 1_000);
  }

  /** Play a sample of a panel's alert (the Test buttons): works with sounds off, so a person can hear what the rule would sound like. */
  /**
   * A script's alert (`alert(...)` in a script that is on, made new by the Scripts pane): under the same Sounds switch, cap and list as the
   * panels' alerts, with a cool-down of its own per call of `alert` in the script (`key`).
   */
  script(now: number, text: string, sound: Parameters<typeof scriptNotes>[0], key: string): void {
    if (replaying()) return;
    this.#fire(now, 'script', 'script', null, text, `script:${key}`, SCRIPT_COOLDOWN_MS, scriptNotes(sound, this.#s.sounds.volume));
  }

  /** A level drawn on the map with its alert on was reached (draw/controller.ts): the chime, under the same Sounds switch, cap and list. */
  drawing(now: number, text: string, key: string): void {
    if (replaying()) return;
    this.#fire(now, 'drawing', 'script', null, text, `drawing:${key}`, LEVEL_COOLDOWN_MS, scriptNotes('chime', this.#s.sounds.volume));
  }

  test(kind: AlertKind, side: 'buy' | 'sell' | null = 'buy'): void {
    void this.player.unlock().then(() => { this.player.play(alertNotes(kind, side, this.#s.sounds.volume), true); });
  }
}
