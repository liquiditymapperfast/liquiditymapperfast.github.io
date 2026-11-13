/** One instrument's recorded columns, flat as the worker holds them: `counts[c]` bins of column `c` (ascending), starting at `times[c]`. */
export interface DepthStore { step: number; times: ArrayLike<number>; counts: ArrayLike<number>; bins: ArrayLike<number>; bid: ArrayLike<number>; ask: ArrayLike<number> }
export interface DepthSeries { bid: Float32Array; ask: Float32Array; /** The price each pixel column's band is centred on (NaN where no book gave one). */ mid: Float64Array }
/**
 * Several nested bands at once (`depthBands`): for pixel column `x` and band `j` (the radii ascending), `bid[x * k + j]` is the bid USD within
 * ±radii[j] of the column's price, so each band holds every inner one; `bidCoin`/`askCoin` the same in coins, each bin's USD over its own price.
 */
export interface DepthBands {
  k: number; bid: Float32Array; ask: Float32Array; bidCoin: Float32Array; askCoin: Float32Array; mid: Float64Array;
  /** Per pixel column, how many of the stores had a column touching it (an empty book counts; no column does not), and 1 where a price centre was found. */
  present: Uint16Array; centred: Uint8Array;
}

/**
 * The middle of one column's book: halfway between its highest bin with bids and its lowest bin with asks (`count` bins from `at`), or NaN
 * when a side is missing. A column is a minute's mean, so in a minute the price moved through, the two cross and the middle is the middle of
 * where it went: still a price of that minute, never a later one.
 */
export function touchOf(store: DepthStore, at: number, count: number): number {
  let lowAsk = NaN, highBid = NaN;
  for (let e = at; e < at + count; e++) if (store.ask[e]! > 0) { lowAsk = store.bins[e]! * store.step; break; }
  for (let e = at + count - 1; e >= at; e--) if (store.bid[e]! > 0) { highBid = store.bins[e]! * store.step; break; }
  return (lowAsk + highBid) / 2;
}

/**
 * Bid and ask USD within `range` (a fraction) either side of the price in each of `w` pixel columns over [t0, t1], summed over the
 * instruments; an instrument's columns that fall in one pixel are averaged.
 *
 * The price is the books' own: each instrument's `touchOf`, averaged over its columns in the pixel, and the median of those across the
 * instruments, so one venue with a stale or crossed book does not move it. Each side counts its own volume anywhere inside the band; the
 * band is not split at the price. The pane used to centre the band on the close of the chart candle holding the column, a price from later
 * in that candle, and to count bids only below it and asks only above it, which moved the dense liquidity at the touch from one side to the
 * other whenever the two prices differed. Over 48 hours of the BTC recording (2026-10-10, 15-minute candles, ±20 %), 64 of the 72 minutes
 * in which one side fell by 12 % or more began on a candle boundary, and 43 of the 44 ask drops were followed by a higher price, because the
 * centre already was that price. Counted this way there were none.
 */
export function depthSeries(stores: readonly DepthStore[], stepMs: number, t0: number, t1: number, w: number, range: number): DepthSeries {
  const by = depthByStore(stores, stepMs, t0, t1, w, range), bid = new Float32Array(w), ask = new Float32Array(w);
  for (let i = 0; i < stores.length; i++) for (let x = 0; x < w; x++) { bid[x]! += by.bid[i]![x]!; ask[x]! += by.ask[i]![x]!; }
  return { bid, ask, mid: by.mid };
}

/**
 * `depthSeries` for several nested bands in one pass over the books (the Depth pane): `radii` ascending fractions of the price. Each bin is
 * counted in the narrowest band that holds it and the bands are then added up outward, so the work is that of the widest band, not one pass a band.
 */
export function depthBands(stores: readonly DepthStore[], stepMs: number, t0: number, t1: number, w: number, radii: readonly number[]): DepthBands {
  const k = radii.length, by = depthBandsByStore(stores, stepMs, t0, t1, w, radii, true);
  const bid = new Float32Array(w * k), ask = new Float32Array(w * k), bidCoin = new Float32Array(w * k), askCoin = new Float32Array(w * k), present = new Uint16Array(Math.max(0, w));
  for (let i = 0; i < stores.length; i++) for (let n = 0; n < w * k; n++) {
    bid[n]! += by.bid[i]![n]!; ask[n]! += by.ask[i]![n]!; bidCoin[n]! += by.bidCoin![i]![n]!; askCoin[n]! += by.askCoin![i]![n]!;
  }
  for (let i = 0; i < stores.length; i++) for (let x = 0; x < w; x++) present[x]! += by.column[i]![x]!;
  const centred = Uint8Array.from(by.mid, p => p > 0 ? 1 : 0);
  return { k, bid, ask, bidCoin, askCoin, mid: by.mid, present, centred };
}

/**
 * `depthSeries` before the instruments are added together: each store's bid and ask per pixel, whether it was counted there (`present`: a
 * column with bins and a price centre), and whether it had a column there at all (`column`: an empty book or one with no centre too).
 */
export interface DepthByStore { mid: Float64Array; bid: Float32Array[]; ask: Float32Array[]; present: Uint8Array[]; column: Uint8Array[] }
export function depthByStore(stores: readonly DepthStore[], stepMs: number, t0: number, t1: number, w: number, range: number): DepthByStore {
  return depthBandsByStore(stores, stepMs, t0, t1, w, [range], false);
}

/** `depthByStore` for nested bands: per store `w * radii.length` values (`DepthBands`' layout), and with `coins` the same in coins. */
export interface DepthBandsByStore extends DepthByStore { bidCoin?: Float32Array[]; askCoin?: Float32Array[] }
export function depthBandsByStore(stores: readonly DepthStore[], stepMs: number, t0: number, t1: number, w: number, radii: readonly number[], coins: boolean): DepthBandsByStore {
  const k = radii.length, mid = new Float64Array(w).fill(NaN), size = w * k;
  const out: DepthBandsByStore = { mid, bid: stores.map(() => new Float32Array(size)), ask: stores.map(() => new Float32Array(size)), present: stores.map(() => new Uint8Array(w)), column: stores.map(() => new Uint8Array(Math.max(0, w))),
    ...(coins ? { bidCoin: stores.map(() => new Float32Array(size)), askCoin: stores.map(() => new Float32Array(size)) } : {}) };
  if (!(w > 0) || !(t1 > t0) || k === 0) return out;
  const pxMs = (t1 - t0) / w, m = stores.length;
  const first = (t: number): number => Math.max(0, Math.floor((t - t0) / pxMs)), last = (t: number): number => Math.min(w - 1, Math.floor((t + stepMs - 1 - t0) / pxMs));
  const touch = new Float64Array(w * m), seen = new Uint32Array(w * m);
  stores.forEach((store, i) => {
    const column = out.column[i]!;
    for (let c = 0, at = 0; c < store.times.length; at += store.counts[c]!, c++) {
      const count = store.counts[c]!, x0 = first(store.times[c]!), x1 = last(store.times[c]!);
      if (x1 < 0 || x0 >= w) continue;
      for (let x = Math.max(0, x0); x <= x1; x++) column[x] = 1;
      if (count <= 0) continue;
      const p = touchOf(store, at, count);
      if (p > 0) for (let x = x0; x <= x1; x++) { touch[x * m + i]! += p; seen[x * m + i]!++; }
    }
  });
  const row: number[] = [];
  for (let x = 0; x < w; x++) {
    row.length = 0;
    for (let i = 0; i < m; i++) if (seen[x * m + i]) row.push(touch[x * m + i]! / seen[x * m + i]!);
    if (row.length) { row.sort((a, b) => a - b); mid[x] = row[row.length >> 1]!; }
  }
  // Per column of the book and pixel it covers: each bin goes to the narrowest band that holds it (the same inclusive edges for every band),
  // then the bands are added up outward, so band j holds every band inside it.
  const sumB = new Float64Array(size), sumA = new Float64Array(size), sumBc = new Float64Array(size), sumAc = new Float64Array(size), n = new Float64Array(w);
  const lo = new Float64Array(k), hi = new Float64Array(k), shB = new Float64Array(k), shA = new Float64Array(k), shBc = new Float64Array(k), shAc = new Float64Array(k);
  stores.forEach((store, i) => {
    sumB.fill(0); sumA.fill(0); sumBc.fill(0); sumAc.fill(0); n.fill(0);
    for (let c = 0, at = 0; c < store.times.length; at += store.counts[c]!, c++) {
      const count = store.counts[c]!, x0 = first(store.times[c]!), x1 = last(store.times[c]!);
      if (x1 < 0 || x0 >= w || count <= 0) continue;
      for (let x = x0; x <= x1; x++) {
        const p = mid[x]!; if (!(p > 0)) continue;
        for (let j = 0; j < k; j++) { lo[j] = p * (1 - radii[j]!); hi[j] = p * (1 + radii[j]!); }
        shB.fill(0); shA.fill(0); shBc.fill(0); shAc.fill(0);
        const outLo = lo[k - 1]!, outHi = hi[k - 1]!;
        for (let e = at; e < at + count; e++) {
          const price = store.bins[e]! * store.step; if (!(price >= outLo && price <= outHi)) continue;
          let j = 0; while (j < k - 1 && !(price >= lo[j]! && price <= hi[j]!)) j++;
          const b = store.bid[e]!, a = store.ask[e]!;
          shB[j]! += b; shA[j]! += a;
          if (coins && price > 0) { shBc[j]! += b / price; shAc[j]! += a / price; }
        }
        let b = 0, a = 0, bc = 0, ac = 0;
        for (let j = 0; j < k; j++) {
          b += shB[j]!; a += shA[j]!; bc += shBc[j]!; ac += shAc[j]!;
          sumB[x * k + j]! += b; sumA[x * k + j]! += a; sumBc[x * k + j]! += bc; sumAc[x * k + j]! += ac;
        }
        n[x]! += 1;
      }
    }
    const bid = out.bid[i]!, ask = out.ask[i]!, present = out.present[i]!, bidCoin = out.bidCoin?.[i], askCoin = out.askCoin?.[i];
    for (let x = 0; x < w; x++) {
      if (!(n[x]! > 0)) continue;
      present[x] = 1;
      for (let j = 0; j < k; j++) {
        const at = x * k + j;
        bid[at] = sumB[at]! / n[x]!; ask[at] = sumA[at]! / n[x]!;
        if (bidCoin && askCoin) { bidCoin[at] = sumBc[at]! / n[x]!; askCoin[at] = sumAc[at]! / n[x]!; }
      }
    }
  });
  return out;
}
