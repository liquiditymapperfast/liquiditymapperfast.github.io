import { venueSlug } from './venues.ts';

/** Recorded or live columns for one instrument, flat: column `c` holds `counts[c]` bins starting where the previous one ended. */
export interface ColumnStore { step: number; times: Float64Array; counts: Uint32Array; bins: Int32Array; bid: Float32Array; ask: Float32Array }
/** What one instrument holds in a cell of the map: bid and ask USD, averaged over the cell's time as the raster does. */
export interface CellShare { id: string; bid: number; ask: number }

/**
 * Bid and ask USD one instrument holds in the map cell [t0, t1) x [p0, p1): each bin that overlaps the price band counts for the share
 * of the bin inside it, each column for the share of the cell's time it covers. A column that starts at or after `cutoff` is skipped (the
 * live column stands in for it).
 */
export function shareInCell(store: ColumnStore, columnMs: number, t0: number, t1: number, p0: number, p1: number, cutoff = Infinity): { bid: number; ask: number } {
  const span = t1 - t0;
  let bid = 0, ask = 0, at = 0;
  for (let c = 0; c < store.times.length; c++) {
    const n = store.counts[c]!, t = store.times[c]!;
    const overlap = Math.min(t + columnMs, t1) - Math.max(t, t0);
    if (t < cutoff && overlap > 0) {
      const weight = overlap / span;
      for (let e = at; e < at + n; e++) {
        const lo = store.bins[e]! * store.step, inside = (Math.min(lo + store.step, p1) - Math.max(lo, p0)) / store.step;
        if (inside > 0) { bid += store.bid[e]! * inside * weight; ask += store.ask[e]! * inside * weight; }
      }
    }
    at += n;
  }
  return { bid, ask };
}

/**
 * The venue behind the liquidity in a cell on `side`, as a short handle: "@binance-spot" when it is nearly all one venue (90 % or more),
 * otherwise the largest with its share and how many others share the cell ("@bybit 62% +2"). Empty when nothing is there.
 */
export function describeSources(shares: readonly CellShare[], side: 'bid' | 'ask'): string {
  const list = shares.map(item => ({ id: item.id, usd: item[side] })).filter(item => item.usd > 0).sort((a, b) => b.usd - a.usd);
  const total = list.reduce((sum, item) => sum + item.usd, 0), top = list[0];
  if (!top || !(total > 0)) return '';
  const share = top.usd / total;
  return `@${venueSlug(top.id)}${share >= 0.9 ? '' : ` ${Math.round(share * 100)}%${list.length > 1 ? ` +${list.length - 1}` : ''}`}`;
}
