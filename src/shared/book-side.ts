/**
 * One side of a live book that keeps itself sorted for valuation (`Research_Findings.md`, 2026-11-11). A `Map` from price to size, as
 * every connector has always used (Coinbase writes it directly), that also remembers which prices changed since it was last sorted. Valuing
 * a deep book once a second used to sort all its prices and look each size up again (a 42,000-level Bybit side whose insertion order had
 * been shuffled by hours of deltas: 33 ms); now the prices that changed (a few hundred a second) are sorted and merged into the previous
 * sorted arrays, O(N + k log k), with the same order and the same sizes, so a valuation built from them is the same to the last bit.
 *
 * Rules: the Map behaves exactly as a Map (iteration order, return values, mutation during iteration); a set to the size a price already
 * has, or a delete of a price not there, changes nothing and is not remembered; past `logCap()` remembered prices (or after `clear`), the
 * next sort is a whole one and the remembered prices and the sorted arrays are let go at once, so a side that is never valued holds no more
 * than that. `sorted()` is synchronous, and the arrays it returns are its own: a caller copies what it keeps (valuation builds new arrays).
 */
export class BookSide extends Map<number, number> {
  /** The prices, ascending, and their sizes, as of the last `sorted()`, and how many of them are valid. */
  #prices = new Float64Array(0); #sizes = new Float64Array(0); #n = 0;
  /** Prices changed since then (their sizes are read from the map when merged; a price no longer there was deleted). */
  #touched: Set<number> | null = null;
  /** The sorted arrays are of no use: the next `sorted()` sorts the whole side. */
  #whole = true;

  // No constructor argument: a Map built from an iterable calls `set` before this class's fields exist.
  constructor() { super(); }

  override set(price: number, size: number): this {
    if (super.get(price) === size) return this;
    super.set(price, size); this.#note(price);
    return this;
  }
  override delete(price: number): boolean {
    if (!super.delete(price)) return false;
    this.#note(price);
    return true;
  }
  override clear(): void { super.clear(); this.#forget(); }

  /** At most this many remembered prices: past it a whole sort is as cheap, so they are dropped and the next sort is whole. */
  logCap(): number { return Math.max(4_096, this.size >> 2); }

  /**
   * The side's prices ascending and their sizes: `prices[i]`, `sizes[i]` for `i < n`. Valid until the side next changes; never modify them.
   */
  sorted(): { prices: Float64Array; sizes: Float64Array; n: number } {
    if (this.#whole) this.#sortWhole();
    else if (this.#touched?.size) this.#merge();
    return { prices: this.#prices, sizes: this.#sizes, n: this.#n };
  }

  #note(price: number): void {
    if (this.#whole) return;
    const touched = this.#touched ??= new Set();
    touched.add(price);
    if (touched.size > this.logCap()) this.#forget();
  }
  /** Back to a whole sort next time, the remembered prices and the sorted arrays let go now. */
  #forget(): void { this.#whole = true; this.#touched = null; this.#prices = new Float64Array(0); this.#sizes = new Float64Array(0); this.#n = 0; }

  #sortWhole(): void {
    const n = this.size, prices = new Float64Array(n);
    let i = 0;
    for (const p of super.keys()) prices[i++] = p;
    prices.sort();
    const sizes = new Float64Array(n);
    for (let k = 0; k < n; k++) sizes[k] = super.get(prices[k]!)!;
    this.#prices = prices; this.#sizes = sizes; this.#n = n; this.#whole = false; this.#touched = null;
  }

  /** The changed prices merged into the sorted arrays: unchanged ones copied, changed ones with the size the map has now (or left out). */
  #merge(): void {
    const touched = Float64Array.from(this.#touched!); touched.sort();
    const old = this.#prices, oldSizes = this.#sizes, n = this.#n, k = touched.length;
    const prices = new Float64Array(n + k), sizes = new Float64Array(n + k);
    let i = 0, j = 0, out = 0;
    while (i < n || j < k) {
      const a = i < n ? old[i]! : Infinity, b = j < k ? touched[j]! : Infinity;
      if (a < b) { prices[out] = a; sizes[out++] = oldSizes[i++]!; continue; }
      // A changed price (and, when equal, the old copy of it, which is skipped): its size now, or nothing when it was deleted.
      if (a === b) i++;
      const size = super.get(b);
      if (size !== undefined) { prices[out] = b; sizes[out++] = size; }
      j++;
    }
    this.#prices = prices; this.#sizes = sizes; this.#n = out; this.#touched = null;
  }
}
