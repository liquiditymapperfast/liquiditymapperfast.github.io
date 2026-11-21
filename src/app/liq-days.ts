import { LIQUIDATIONS_PER_ANSWER } from '../shared/liquidations.ts';
import type { Hub } from './hub.ts';
import { DAY_MS, type LiquidationDay } from './panes/bar-stats.ts';

/** How long a pane's stretch is kept without the pane asking again (it asks on every drawing): a pane put away stops holding days. */
const WANT_MS = 120_000;

/**
 * Liquidations of the markets counted, every size the record keeps, by UTC day: each day asked on its own, so an answer holds a whole day
 * (BTC: 900 to 3,500) rather than the largest 5,000 of a week; the day under way asked again every half minute; two at a time, the newest
 * first; a day whose question failed asked again after its own pause, the others meanwhile. One loader for the Bar stats and the Flow
 * history, which count the same markets (`HeatPane.liquidationMarkets`: the perpetuals whatever the Spot / Perp filter), so a day is asked
 * once however many of them show: each says the stretch it needs (`ensure`), and a day is kept while any of them needs it.
 */
export class LiquidationDays {
  #days = new Map<number, LiquidationDay & { at: number }>();
  #ids = '';
  #loading = new Set<number>();
  #version = 0;
  #retry = new Map<number, number>();
  /** The stretch each pane needs, [from, to), and when it last said so. */
  #wants = new Map<string, { from: number; to: number; at: number }>();
  #listeners = new Set<() => void>();

  constructor(private readonly hub: Pick<Hub, 'source'>) {}

  /** Bumped whenever a day lands or the markets change, for what is worked out from the days. */
  get version(): number { return this.#version; }
  /** The markets the days held are of (comma list, as `ensure` was given it). */
  get ids(): string { return this.#ids; }
  get days(): ReadonlyMap<number, LiquidationDay> { return this.#days; }
  /** Called whenever an answer comes back (a day landed, or its slot is free for the next): the panes draw again. */
  listen(fn: () => void): () => void { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }

  /**
   * `caller` needs the days of [from, to) of the markets `ids`: ask for those not held, and again a day not answered to its end (the day under
   * way, or one asked before its midnight) once what is held of it is half a minute old.
   */
  ensure(caller: string, ids: string, from: number, to: number): void {
    const source = this.hub.source; if (!source.liquidations) return;
    // Other markets counted: what is held is not theirs, and an answer still out for the old ones is dropped when it comes.
    if (ids !== this.#ids) { this.#ids = ids; this.#days = new Map(); this.#retry = new Map(); this.#version++; }
    const now = Date.now();
    this.#wants.set(caller, { from, to, at: now });
    for (const [key, want] of this.#wants) if (now - want.at > WANT_MS) this.#wants.delete(key);
    for (let day = Math.floor((to - 1) / DAY_MS) * DAY_MS; day >= Math.floor(from / DAY_MS) * DAY_MS && this.#loading.size < 2; day -= DAY_MS) {
      const held = this.#days.get(day);
      if (this.#loading.has(day) || now < (this.#retry.get(day) ?? 0) || (held && (held.to >= day + DAY_MS || now - held.at < 30_000))) continue;
      this.#loading.add(day);
      const asked = Date.now();
      source.liquidations(day, day + DAY_MS).then(rows => {
        if (ids !== this.#ids) return;
        this.#retry.delete(day);
        this.#days.set(day, { rows, cut: rows.length >= LIQUIDATIONS_PER_ANSWER, to: Math.min(day + DAY_MS, asked), at: Date.now() }); this.#version++;
      }, () => { if (ids === this.#ids) this.#retry.set(day, Date.now() + 15_000); })
        // Drawn again whatever came back: the slot it held is free for the next day, an answer dropped for other markets included.
        .finally(() => { this.#loading.delete(day); for (const fn of this.#listeners) fn(); });
    }
    // Only the days around a stretch some pane still needs are kept.
    const wants = [...this.#wants.values()];
    for (const day of [...this.#days.keys()]) if (!wants.some(w => day + DAY_MS >= w.from - DAY_MS && day <= w.to + DAY_MS)) this.#days.delete(day);
  }
}
