/**
 * Whale VWAP sums: for each instrument and minute, the USD and the coins of the large market orders (prints) bought and sold, in disjoint size
 * bands, so the average price large buyers and sellers paid over any stretch is Σusd / Σcoins of the bands from a chosen size up. Kept in memory
 * beside the prints and fed as they arrive: asking the database for a day's sum took 90 to 400 ms on the request path (measured on the live
 * recording, 2026-10-09), adding up kept minutes takes a few.
 */

/** BTC's size bands (a coin that trades less has them scaled): an order lands in the highest band it reaches. "From $250K" adds the bands from it up. */
export const WHALE_BANDS_USD: readonly number[] = [100_000, 250_000, 1_000_000, 5_000_000];
const MINUTE = 60_000;

/** One step of an answer: its start, then USD and coins bought, USD and coins sold. */
export type SumRow = [t: number, buyUsd: number, buyCoins: number, sellUsd: number, sellCoins: number];

export interface PrintSumsAnswer {
  /** The earliest large order counted (the recording reaches no further back for whales), or null when none is. */
  since: number | null;
  rows: SumRow[];
}

/** What the sums take from a print. */
export interface SummedPrint { t: number; id: string; side: 'buy' | 'sell'; price: number; usd: number }

export class PrintSums {
  readonly bands: readonly number[];
  /** Per instrument, per minute: [usd, coins] bought and sold for each band, four numbers a band. */
  readonly #byInst = new Map<string, Map<number, Float64Array>>();
  #since = Infinity;

  /** `scale`: the coin's size scale (the bands are BTC's times it). */
  constructor(scale = 1) { this.bands = WHALE_BANDS_USD.map(b => b * scale); }

  /** The band an order of `usd` lands in, or -1 under the smallest. */
  bandOf(usd: number): number {
    let band = -1;
    for (let i = 0; i < this.bands.length; i++) if (usd >= this.bands[i]!) band = i;
    return band;
  }

  /** Count one print (each print once: the stream adds it after its own deduplication). */
  add(p: SummedPrint): void {
    const band = this.bandOf(p.usd);
    if (band < 0 || !(p.price > 0) || !Number.isFinite(p.t)) return;
    let minutes = this.#byInst.get(p.id);
    if (!minutes) { minutes = new Map(); this.#byInst.set(p.id, minutes); }
    const minute = Math.floor(p.t / MINUTE) * MINUTE;
    let sums = minutes.get(minute);
    if (!sums) { sums = new Float64Array(4 * this.bands.length); minutes.set(minute, sums); }
    const at = band * 4 + (p.side === 'buy' ? 0 : 2);
    sums[at]! += p.usd; sums[at + 1]! += p.usd / p.price;
    if (p.t < this.#since) this.#since = p.t;
  }

  /**
   * The sums of `ids` in [from, to), from the band starting at `minUsd` up (it must be a band's edge: null otherwise), in steps of `stepMs`
   * (whole minutes), oldest first; steps with nothing are left out.
   */
  query(ids: readonly string[], from: number, to: number, minUsd: number, stepMs: number): PrintSumsAnswer | null {
    const first = this.bands.findIndex(b => Math.abs(b - minUsd) <= 1e-6 * b);
    if (first < 0 || !(stepMs >= MINUTE)) return null;
    const step = Math.round(stepMs / MINUTE) * MINUTE, rows = new Map<number, SumRow>();
    for (const id of new Set(ids)) {
      const minutes = this.#byInst.get(id); if (!minutes) continue;
      for (const [minute, sums] of minutes) {
        if (minute < from || minute >= to) continue;
        const at = Math.floor(minute / step) * step;
        let row = rows.get(at); if (!row) { row = [at, 0, 0, 0, 0]; rows.set(at, row); }
        for (let band = first; band < this.bands.length; band++) {
          const k = band * 4; row[1] += sums[k]!; row[2] += sums[k + 1]!; row[3] += sums[k + 2]!; row[4] += sums[k + 3]!;
        }
      }
    }
    return { since: Number.isFinite(this.#since) ? this.#since : null, rows: [...rows.values()].filter(r => r[1] + r[3] > 0).sort((a, b) => a[0] - b[0]) };
  }

  /** Drop the minutes before `before` (the prints' retention). */
  expire(before: number): void {
    for (const [id, minutes] of this.#byInst) {
      for (const minute of minutes.keys()) if (minute + MINUTE <= before) minutes.delete(minute);
      if (!minutes.size) this.#byInst.delete(id);
    }
    if (this.#since < before) this.#since = before;
  }
}
