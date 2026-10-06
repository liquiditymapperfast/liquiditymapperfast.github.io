/** What the price strip draws: a price per pixel column over the column's window, from minute candles and then from the marks the page has seen. */
export interface PriceColumns { last: Float64Array; min: number; max: number }

const KEEP = 100_000;

/**
 * Prices over time, ascending: the closes of recorded minute candles (history) followed by one mark a second from the live stream.
 * A pixel column takes the last price at or before the end of its slice of time; before the first price there is none (NaN).
 */
export class PriceTrack {
  #t: number[] = [];
  #p: number[] = [];

  get length(): number { return this.#t.length; }
  get lastTime(): number { return this.#t.length ? this.#t[this.#t.length - 1]! : 0; }

  /**
   * Replace the history with these candles ([start, open, high, low, close, ...], oldest first): each is a price at its close (the one
   * still open is a price at `now`). Marks newer than the last candle stay.
   */
  load(candles: readonly (readonly number[])[], now: number = Date.now(), minuteMs = 60_000): void {
    const tail = this.#t.map((t, i) => [t, this.#p[i]!] as const);
    this.#t = []; this.#p = [];
    let end = 0;
    for (const c of candles) { const t = Math.min(c[0]! + minuteMs - 1, now), close = c[4]!; if (Number.isFinite(t) && close > 0 && t > end) { this.#t.push(t); this.#p.push(close); end = t; } }
    for (const [t, p] of tail) if (t > end) { this.#t.push(t); this.#p.push(p); }
  }

  /** A price seen at `t`. One per second is kept (a later one in the same second replaces it); one older than what is held is ignored. */
  add(t: number, price: number): void {
    if (!(price > 0) || !Number.isFinite(t)) return;
    const n = this.#t.length;
    if (n) {
      const last = this.#t[n - 1]!;
      if (Math.floor(t / 1000) === Math.floor(last / 1000)) { this.#t[n - 1] = Math.max(t, last); this.#p[n - 1] = price; return; }
      if (t < last) return;
    }
    this.#t.push(t); this.#p.push(price);
    if (this.#t.length > KEEP) { this.#t.splice(0, KEEP / 10); this.#p.splice(0, KEEP / 10); }
  }

  /** The price at `t`: the last one at or before it, or NaN. */
  at(t: number): number {
    let lo = 0, hi = this.#t.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (this.#t[mid]! <= t) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    return found < 0 ? NaN : this.#p[found]!;
  }

  columns(t0: number, t1: number, columns: number): PriceColumns {
    const last = new Float64Array(columns).fill(NaN);
    let min = Infinity, max = -Infinity;
    for (let c = 0; c < columns; c++) {
      const v = this.at(t0 + (t1 - t0) * (c + 1) / columns - 1);
      last[c] = v;
      if (v === v) { if (v < min) min = v; if (v > max) max = v; }
    }
    return { last, ...(min <= max ? { min, max } : { min: NaN, max: NaN }) };
  }
}
