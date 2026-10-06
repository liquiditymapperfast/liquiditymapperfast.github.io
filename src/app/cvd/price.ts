/** What the price strip draws: a price per pixel column over the column's window. */
export interface PriceColumns { last: Float64Array; min: number; max: number }

const KEEP = 100_000;

/**
 * Prices over time, ascending, for an instrument that the flow recorder has no seconds for: the closes of minute candles (history), and
 * the marks the page has seen (one a second). The two are kept apart, and the later of the two wins at any moment: reloading the
 * candles (the one still open is stamped at `now`) must not flatten the marks into minute steps.
 * A pixel column takes the last price at or before the end of its slice of time; before the first price there is none (NaN).
 */
export class PriceTrack {
  #ht: number[] = []; #hp: number[] = [];
  #mt: number[] = []; #mp: number[] = [];

  get length(): number { return this.#ht.length + this.#mt.length; }
  get lastTime(): number { return this.#mt.length ? this.#mt[this.#mt.length - 1]! : this.#ht.length ? this.#ht[this.#ht.length - 1]! : 0; }

  /**
   * Replace the history with these candles ([start, open, high, low, close, ...], oldest first): each is a price at its close (the one
   * still open is a price at `now`). The marks are not touched.
   */
  load(candles: readonly (readonly number[])[], now: number = Date.now(), minuteMs = 60_000): void {
    this.#ht = []; this.#hp = [];
    let end = 0;
    for (const c of candles) { const t = Math.min(c[0]! + minuteMs - 1, now), close = c[4]!; if (Number.isFinite(t) && close > 0 && t > end) { this.#ht.push(t); this.#hp.push(close); end = t; } }
  }

  /** The prices of another instrument do not belong here: forget the marks (and the history) when the instrument on screen changes. */
  clear(): void { this.#ht = []; this.#hp = []; this.#mt = []; this.#mp = []; }

  /** A price seen at `t`. One per second is kept (a later one in the same second replaces it); one older than what is held is ignored. */
  add(t: number, price: number): void {
    if (!(price > 0) || !Number.isFinite(t)) return;
    const n = this.#mt.length;
    if (n) {
      const last = this.#mt[n - 1]!;
      if (Math.floor(t / 1000) === Math.floor(last / 1000)) { this.#mt[n - 1] = Math.max(t, last); this.#mp[n - 1] = price; return; }
      if (t < last) return;
    }
    this.#mt.push(t); this.#mp.push(price);
    if (this.#mt.length > KEEP) { this.#mt.splice(0, KEEP / 10); this.#mp.splice(0, KEEP / 10); }
  }

  /** The price at `t`: whichever of the last mark and the last candle close at or before it is the later one (a tab that was asleep has candles newer than its last mark), or NaN. */
  at(t: number): number {
    const m = last(this.#mt, t), h = last(this.#ht, t);
    if (m < 0) return h < 0 ? NaN : this.#hp[h]!;
    return h < 0 || this.#mt[m]! >= this.#ht[h]! ? this.#mp[m]! : this.#hp[h]!;
  }

  columns(t0: number, t1: number, columns: number): PriceColumns {
    const out = new Float64Array(columns).fill(NaN);
    let min = Infinity, max = -Infinity;
    for (let c = 0; c < columns; c++) {
      const v = this.at(t0 + (t1 - t0) * (c + 1) / columns - 1);
      out[c] = v;
      if (v === v) { if (v < min) min = v; if (v > max) max = v; }
    }
    return { last: out, ...(min <= max ? { min, max } : { min: NaN, max: NaN }) };
  }
}

/** Index of the last entry of ascending `times` at or before `t`, or -1. */
function last(times: readonly number[], t: number): number {
  let lo = 0, hi = times.length - 1, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (times[mid]! <= t) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  return found;
}
