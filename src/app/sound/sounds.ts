import type { Store } from '../store.ts';
import type { Print } from '../prints.ts';
import { anomalies } from '../anomaly.ts';
import { kindOf } from '../scope.ts';
import { SoundEngine } from './engine.ts';
import { Coalescer, chimeNotes, notesFor, tierOf, type SoundEvent } from './rules.ts';

/** What was decided for one event: kept for the test harness and for the panel's "last sounds" line. */
export interface SoundLogEntry { at: number; kind: 'trade' | 'candle' | 'test'; side?: 'buy' | 'sell'; tier?: string; usd?: number; venues?: number; n?: number; audible: boolean }

/** Prints older than this when they reach us (a throttled background tab catching up) are history, not news: a burst of old sounds is worse than silence. */
const MAX_AGE_MS = 2_500;

/**
 * Turns the live stream of large prints into sounds. A sweep that fills on several venues within a quarter of a second is one event;
 * its size picks a tier; the tier decides whether it sounds and how. Everything decided is recorded in `log`, audible or not.
 */
export class Sounds {
  readonly engine = new SoundEngine();
  readonly log: SoundLogEntry[] = [];
  readonly #coalescer = new Coalescer(250);
  #timer: number | undefined;
  #lastBar = 0;

  constructor(private store: Store, private now: () => number = () => performance.now(), private clock: () => number = Date.now) {
    this.engine.setVolume(store.state.sounds.volume);
  }

  /** Start the drain timer and unlock audio on the first gesture (browsers refuse sound before one). */
  start(): void {
    const unlock = (): void => { if (this.store.state.sounds.on) void this.engine.unlock().then(() => this.store.set({ soundState: this.engine.state })); };
    document.addEventListener('pointerdown', unlock, { capture: true }); document.addEventListener('keydown', unlock, { capture: true });
    this.#timer = window.setInterval(() => this.#drain(), 100);
    this.store.subscribe((state, changed) => {
      if (changed.has('sounds')) { this.engine.setVolume(state.sounds.volume); if (state.sounds.on && this.engine.state !== 'running') void this.engine.unlock().then(() => this.store.set({ soundState: this.engine.state })); }
      if (changed.has('candles')) this.#onCandles();
    });
    this.store.set({ soundState: this.engine.state });
  }
  stop(): void { if (this.#timer !== undefined) window.clearInterval(this.#timer); }

  /** New large prints from the live stream. */
  feed(prints: readonly Print[]): void {
    const s = this.store.state;
    if (!s.sounds.on) return;
    const nowMs = this.clock(), at = this.now();
    for (const p of prints) {
      if (nowMs - p.t > MAX_AGE_MS) continue;
      if (s.disabledVenues.includes(p.id.split(':')[0]!)) continue;
      if (s.sounds.scope !== 'all' && kindOf(s.markets, p.id) !== (s.sounds.scope === 'spot' ? 'spot' : 'perp')) continue;
      this.#coalescer.add(p, at);
    }
  }

  #drain(force = false): void {
    const s = this.store.state;
    for (const event of this.#coalescer.drain(this.now(), force)) this.#play(event, s.sounds.tiers, s.sounds.volume, 'trade');
  }
  /** Decide and play one event (exposed for the harness through `drainNow`). */
  #play(event: SoundEvent, tiers = this.store.state.sounds.tiers, volume = this.store.state.sounds.volume, kind: SoundLogEntry['kind'] = 'trade'): void {
    const hit = tierOf(event.usd, tiers);
    if (!hit || !hit.tier.on) return;
    const audible = this.engine.play(notesFor(event.side, hit.index, event.usd, hit.tier.usd, volume));
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
      this.#record({ at: this.clock(), kind: 'test', side, tier: tier.id, usd, audible });
      this.store.set({ soundState: this.engine.state });
    });
  }

  /** A closed candle with unusually large volume gets one chime. */
  #onCandles(): void {
    const s = this.store.state, candles = s.candles;
    if (!s.sounds.on || !s.sounds.barChime || candles.length < 14) return;
    const newest = candles[candles.length - 1]![0];
    if (newest === this.#lastBar) return;
    const first = this.#lastBar === 0; this.#lastBar = newest;
    if (first) return; // the first load is history
    const closed = candles.length - 2, found = anomalies(Float64Array.from(candles, c => c[5]), s.highlight);
    if (found.flag[closed] !== 1) return;
    const audible = this.engine.play(chimeNotes(s.sounds.volume));
    this.#record({ at: this.clock(), kind: 'candle', audible });
  }

  #record(entry: SoundLogEntry): void { this.log.push(entry); if (this.log.length > 200) this.log.splice(0, this.log.length - 200); this.store.set({ lastSound: entry.at }); }
}
