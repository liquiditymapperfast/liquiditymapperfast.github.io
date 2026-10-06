import type { AppState } from '../store.ts';
import type { FlowBook } from '../flow-book.ts';
import type { Note } from './rules.ts';
import { alertNotes, type AlertKind } from './rules.ts';
import { Cooldowns, RateCap, WallWatch, ImbalanceWatch, bookBins, imbalanceOf } from './alert-rules.ts';
import { burst } from '../cvd/burst.ts';
import { flowIds } from '../cvd/ids.ts';
import { familyKey, venueOfInstrument } from '../cvd/families.ts';
import { activeIds, kindOf } from '../scope.ts';
import { anomalies } from '../anomaly.ts';
import { signedUsd } from '../cvd/text.ts';
import { venueLabel } from '../venues.ts';
import type { BurstEvent } from '../cvd/burst.ts';
import { TIMEFRAMES } from '../../shared/series.ts';
import { t } from '../i18n.ts';

export type AlertPanel = 'flow' | 'bars' | 'book' | 'depth' | 'oi';
/** What was decided for one alert: kept for the panel's "recent" list and for the harness; audible is false when the engine was locked or muted. */
export interface AlertEntry { at: number; panel: AlertPanel; kind: AlertKind; side: 'buy' | 'sell' | null; text: string; audible: boolean }

/** What the alerts read: the page state, its flow book, and something that plays notes. */
export interface AlertsHost { state: AppState }
export interface Player { play(notes: readonly Note[], force?: boolean): boolean; unlock(): Promise<unknown> }

const FLOW_COOLDOWN_MS = 90_000, WALL_COOLDOWN_MS = 30_000, IMBALANCE_COOLDOWN_MS = 300_000, BOOK_EVERY_MS = 2_000;
/** A reading older than this is history (a tab catching up after being asleep): it does not sound. */
const FRESH_MS = 4_000;
const MAX_BURSTS = 300;

/**
 * The sounds the panels may make beyond the large-trade tiers. Every rule is off until chosen, only fires on what is new (never on
 * history, never during warm-up), has its own cool-down, and shares one cap on how many sounds can come in a short while. The central
 * Sounds switch and volume govern all of it. Detection is in `alert-rules.ts` and `cvd/burst.ts`; this class reads the page, decides
 * what to ask them, and records what happened.
 */
export class Alerts {
  readonly log: AlertEntry[] = [];
  /** Flow bursts seen while the page was open, for the markers on the flow column's rows (oldest first). */
  readonly bursts: BurstEvent[] = [];
  readonly #cool = new Cooldowns();
  readonly #cap = new RateCap(4, 10_000);
  readonly #walls = new WallWatch();
  readonly #balance = new ImbalanceWatch();
  #lastBook = 0; #lastBar = 0; #lastOi = 0;
  #timer: number | undefined;
  onChange: () => void = () => {};

  constructor(private host: AlertsHost, private flow: FlowBook, private player: Player, private clock: () => number = Date.now) {}

  start(): void { if (this.#timer === undefined) this.#timer = window.setInterval(() => this.tick(this.clock()), 1000); }
  stop(): void { if (this.#timer !== undefined) window.clearInterval(this.#timer); this.#timer = undefined; }

  /** One look at everything (every second); `now` is the clock, so a test steps it. */
  tick(now: number): void {
    this.#flow(now); this.#book(now); this.#bars(now); this.#oi(now);
  }

  get #s(): AppState { return this.host.state; }

  #fire(now: number, panel: AlertPanel, kind: AlertKind, side: 'buy' | 'sell' | null, text: string, key: string, cooldownMs: number): void {
    const sounds = this.#s.sounds;
    if (!sounds.on) return;
    if (!this.#cool.take(key, now, cooldownMs) || !this.#cap.allow(now)) return;
    const audible = this.player.play(alertNotes(kind, side, sounds.volume));
    this.log.push({ at: now, panel, kind, side, text, audible });
    if (this.log.length > 100) this.log.splice(0, this.log.length - 100);
    this.onChange();
  }

  // ---- Flow ----------------------------------------------------------------------------------------------------------------------

  #flow(now: number): void {
    const s = this.#s, rule = s.sounds.panels.flow;
    // Bursts are marked on the column whether or not they sound, so they are looked for while the column is on screen or the rule is on.
    if (!s.show.cvd && !rule.burst) return;
    const nowSec = Math.floor(now / 1000);
    for (const id of flowIds(s, this.flow.ids)) {
      const series = this.flow.get(id); if (!series) continue;
      const found = burst(series, nowSec, { windowSec: 10, baselineSec: 1_800, k: rule.sensitivity, minUsd: rule.usd });
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
    const bins = bookBins(s.levels, new Set(activeIds(s)), mark, 0.01);
    for (const signal of this.#walls.update(now, bins, mark, panels.book.usd)) {
      if (!panels.book.wall) continue;
      const word = signal.kind === 'appeared' ? t('wall appeared') : t('wall pulled');
      this.#fire(now, 'book', signal.kind === 'appeared' ? 'wall-appeared' : 'wall-pulled', signal.side, `${signal.side === 'buy' ? t('Bid') : t('Ask')} ${word}: $${Math.round(signal.usd / 1e5) / 10}M`, `wall:${signal.side}:${signal.kind}`, WALL_COOLDOWN_MS);
    }
    const tip = this.#balance.update(imbalanceOf(bins), panels.depth.pct);
    if (tip && panels.depth.imbalance) this.#fire(now, 'depth', 'imbalance', tip, tip === 'buy' ? t('Bids outweigh asks within 1% of the price') : t('Asks outweigh bids within 1% of the price'), 'imbalance', IMBALANCE_COOLDOWN_MS);
  }

  // ---- Candle closes ---------------------------------------------------------------------------------------------------------------

  #bars(now: number): void {
    const s = this.#s, candles = s.candles, rule = s.sounds.panels.bars;
    if (candles.length < 2) return;
    const newest = candles[candles.length - 1]![0];
    if (newest === this.#lastBar) return;
    const first = this.#lastBar === 0; this.#lastBar = newest;
    if (first || !rule.delta) return;                       // the first load is history
    const tf = TIMEFRAMES[s.timeframe] ?? 3_600_000, start = candles[candles.length - 2]![0], startSec = Math.floor(start / 1000), endSec = Math.floor((start + tf) / 1000) - 1;
    let delta = 0;
    for (const id of flowIds(s, this.flow.ids)) delta += this.flow.get(id)?.delta(startSec, endSec) ?? 0;
    if (Math.abs(delta) < rule.usd) return;
    this.#fire(now, 'bars', 'bar-delta', delta > 0 ? 'buy' : 'sell', t('{timeframe} candle closed with {delta} of net taker flow', { timeframe: s.timeframe, delta: signedUsd(delta) }), 'bar-delta', 1_000);
  }

  #oi(now: number): void {
    const s = this.#s, bars = s.oi;
    if (bars.length < 14) return;
    const newest = bars[bars.length - 1]![0];
    if (newest === this.#lastOi) return;
    const first = this.#lastOi === 0; this.#lastOi = newest;
    if (first || !s.sounds.panels.oi.jump || !s.highlight.on) return;
    const changes = Float64Array.from(bars, b => Math.abs(b[4] - b[1])), closed = bars.length - 2;
    if (anomalies(changes, s.highlight).flag[closed] !== 1) return;
    this.#fire(now, 'oi', 'oi-jump', null, t('Open interest changed unusually in the candle that just closed'), 'oi-jump', 1_000);
  }

  /** Play a sample of a panel's alert (the Test buttons): works with sounds off, so a person can hear what the rule would sound like. */
  test(kind: AlertKind, side: 'buy' | 'sell' | null = 'buy'): void {
    void this.player.unlock().then(() => { this.player.play(alertNotes(kind, side, this.#s.sounds.volume), true); });
  }
}
