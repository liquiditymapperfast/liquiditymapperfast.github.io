import type { Store } from '../store.ts';
import type { Print } from '../prints.ts';
import { anomalies } from '../anomaly.ts';
import { kindOf } from '../scope.ts';
import { SoundEngine } from './engine.ts';
import { Coalescer, chimeNotes, notesFor, tierOf, type SoundEvent } from './rules.ts';
import { TIMEFRAMES } from '../../shared/series.ts';
import { BAR_FRESH_MS } from './alerts.ts';
import { scaledUsd, sizeScale } from '../coin.ts';
import { replaying } from '../replay/clock.ts';

/** What was decided for one event: kept for the test harness and for the panel's "last sounds" line. */
export interface SoundLogEntry { at: number; kind: 'trade' | 'candle' | 'test'; side?: 'buy' | 'sell'; tier?: string; usd?: number; venues?: number; n?: number; audible: boolean }

/** Prints older than this when they reach us (a throttled background tab catching up) are history, not news: a burst of old sounds is worse than silence. */
const MAX_AGE_MS = 2_500;
/** A sweep that waited longer than this to be sounded was held up (a throttled tab): it is history by now, and sounding it late is worse than silence. */
const MAX_QUEUE_MS = 1_000;

/**
 * Turns the live stream of large prints into sounds. A sweep that fills on several venues within a quarter of a second is one event;
 * its size picks a tier; the tier decides whether it sounds and how. Everything decided is recorded in `log`, audible or not.
 */
export class Sounds {
  readonly engine = new SoundEngine();
  readonly log: SoundLogEntry[] = [];
  readonly #coalescer = new Coalescer(250);
  #timer: number | undefined;
  #lastBar = 0; #barKey = '';

  constructor(private store: Store, private now: () => number = () => performance.now(), private clock: () => number = Date.now) {
    this.engine.setVolume(store.state.sounds.volume);
    this.engine.onStateChange = () => this.store.set({ soundState: this.engine.state });
  }

  /** Start the drain timer and unlock audio on the first gesture (browsers refuse sound before one). */
  start(): void {
    const unlock = (): void => { if (this.store.state.sounds.on) void this.engine.unlock().then(() => this.store.set({ soundState: this.engine.state })); };
    document.addEventListener('pointerdown', unlock, { capture: true }); document.addEventListener('keydown', unlock, { capture: true });
    this.#timer = window.setInterval(() => this.#drain(), 100);
    this.store.subscribe((state, changed) => {
      if (changed.has('sounds')) {
        this.engine.setVolume(state.sounds.volume);
        // Switched off: what was waiting to sound is not played when the timer next comes round.
        if (!state.sounds.on) this.#coalescer.clear();
        else if (this.engine.state !== 'running') void this.engine.unlock().then(() => this.store.set({ soundState: this.engine.state }));
      }
      if (changed.has('candles')) this.#onCandles();
    });
    this.store.set({ soundState: this.engine.state });
  }
  stop(): void { if (this.#timer !== undefined) window.clearInterval(this.#timer); }

  /** New large prints from the live stream. */
  feed(prints: readonly Print[]): void {
    const s = this.store.state;
    if (!s.sounds.on || replaying()) return;
    const nowMs = this.clock(), at = this.now();
    for (const p of prints) {
      if (nowMs - p.t > MAX_AGE_MS) continue;
      if (s.disabledVenues.includes(p.id.split(':')[0]!)) continue;
      if (s.sounds.scope !== 'all' && kindOf(s.markets, p.id) !== (s.sounds.scope === 'spot' ? 'spot' : 'perp')) continue;
      this.#coalescer.add(p, at);
    }
  }

  #drain(force = false): void {
    const s = this.store.state, now = this.now(), events = this.#coalescer.drain(now, force);
    // Asked again here, not only when a print came in: sounds may have been switched off since, and a timer that was throttled may have come late.
    if (!s.sounds.on) return;
    for (const event of events) if (now - event.queuedAt <= MAX_QUEUE_MS) this.#play(event, s.sounds.tiers, s.sounds.volume, 'trade');
  }
  /** Decide and play one event (exposed for the harness through `drainNow`). */
  #play(event: SoundEvent, tiers = this.store.state.sounds.tiers, volume = this.store.state.sounds.volume, kind: SoundLogEntry['kind'] = 'trade'): void {
    // The tiers are BTC's sizes: a coin with smaller floors is measured against them as the BTC-sized trade it stands for.
    const usd = event.usd / sizeScale(), hit = tierOf(usd, tiers);
    if (!hit || !hit.tier.on) return;
    const audible = this.engine.play(notesFor(event.side, hit.index, usd, hit.tier.usd, volume));
    this.#record({ at: this.clock(), kind, side: event.side, tier: hit.tier.id, usd: event.usd, venues: event.venues, n: event.n, audible });
  }
  /** Close every open window now (the harness and the Test buttons do not want to wait a quarter of a second). */
  drainNow(): void { this.#drain(true); }

  /** Play a sample of a tier from the panel; works even when sounds are switched off, so the user can hear what they would get. */
  test(tierId: string, side: 'buy' | 'sell'): void {
    const tiers = this.store.state.sounds.tiers, index = tiers.findIndex(t => t.id === tierId);
    if (index < 0) return;
    const tier = tiers[index]!, usd = tier.usd * 1.2;
    void this.engine.unlock().then(() => {
      const audible = this.engine.play(notesFor(side, index, usd, tier.usd, this.store.state.sounds.volume), true);
      this.#record({ at: this.clock(), kind: 'test', side, tier: tier.id, usd: scaledUsd(usd), audible });
      this.store.set({ soundState: this.engine.state });
    });
  }

  /** A closed candle with unusually large volume gets one chime. */
  #onCandles(): void {
    if (replaying()) return;
    const s = this.store.state, candles = s.candles;
    if (!s.sounds.on || !s.sounds.barChime || candles.length < 14) return;
    // Another market or timeframe has candles of its own, and what is loaded for it is history whatever it says about its newest bar.
    const key = `${s.seriesInstrument || s.marketId}|${s.timeframe}`;
    if (key !== this.#barKey) { this.#barKey = key; this.#lastBar = 0; }
    const newest = candles[candles.length - 1]![0];
    if (newest === this.#lastBar) return;
    const previous = this.#lastBar; this.#lastBar = newest;
    if (previous === 0) return; // the first load is history
    // A close that has just happened to the bar that was the newest: not a catch-up after a sleep, not a gap in the loaded candles.
    const closed = candles.length - 2, tf = TIMEFRAMES[s.timeframe] ?? 3_600_000;
    if (candles[closed]![0] !== previous || this.clock() - (previous + tf) > BAR_FRESH_MS) return;
    const found = anomalies(Float64Array.from(candles, c => c[5]), s.highlight);
    if (found.flag[closed] !== 1) return;
    const audible = this.engine.play(chimeNotes(s.sounds.volume));
    this.#record({ at: this.clock(), kind: 'candle', audible });
  }

  #record(entry: SoundLogEntry): void { this.log.push(entry); if (this.log.length > 200) this.log.splice(0, this.log.length - 200); this.store.set({ lastSound: entry.at }); }
}
