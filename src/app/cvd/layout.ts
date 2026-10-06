export const PHI = (1 + Math.sqrt(5)) / 2;
export type HeightMode = 'golden' | 'volume' | 'equal';
export const HEIGHT_MODES: readonly HeightMode[] = ['golden', 'volume', 'equal'];

export interface RowLayout {
  /** Height of the aggregate row at the top, of the price strip under it, and of each venue row in rank order. */
  agg: number; price: number; rows: number[];
  /** Everything stacked, which is more than the room when the rows would otherwise be too small to read (the column then scrolls). */
  content: number;
}
export interface LayoutOptions {
  /** Smallest height of a venue row and of the aggregate row, and the fixed height of the price strip. */
  minRow?: number; minAgg?: number; price?: number;
  /** In `volume` mode a row's weight never falls below this share, so a quiet venue stays readable. */
  floor?: number;
}

/**
 * Row heights for the column. The aggregate is always the tallest row. `golden` shrinks each rank to 1/φ of the one above it, `volume`
 * makes a row as tall as the venue's share of the volume, `equal` gives every venue the same. Rows never go below `minRow`: what does not
 * fit is scrolled, not squeezed.
 */
export function rowHeights(mode: HeightMode, total: number, shares: readonly number[], { minRow = 54, minAgg = 84, price = 44, floor = 0.06 }: LayoutOptions = {}): RowLayout {
  const n = shares.length;
  const weights = shares.map((share, i) => mode === 'golden' ? PHI ** -i : mode === 'volume' ? Math.max(share, floor) : 1);
  const top = n ? Math.max(...weights) : 1;
  const aggWeight = mode === 'volume' ? top * 1.35 : top * PHI;
  const room = Math.max(0, total - price);
  // Water-filling: a row that would be below its minimum takes the minimum, and the rest share what is left in proportion to their weights.
  const mins = [minAgg, ...weights.map(() => minRow)], ws = [aggWeight, ...weights];
  const fixed = new Array<boolean>(ws.length).fill(false), h = new Array<number>(ws.length).fill(0);
  for (let pass = 0; pass <= ws.length; pass++) {
    const free = ws.reduce((sum, w, i) => sum + (fixed[i] ? 0 : w), 0), left = room - ws.reduce((sum, _, i) => sum + (fixed[i] ? h[i]! : 0), 0);
    let changed = false;
    for (let i = 0; i < ws.length; i++) {
      if (fixed[i]) continue;
      h[i] = free > 0 ? left * ws[i]! / free : 0;
      if (h[i]! < mins[i]!) { h[i] = mins[i]!; fixed[i] = true; changed = true; }
    }
    if (!changed) break;
  }
  let rows = h.slice(1), agg = h[0]!;
  // The aggregate stays the tallest even where the rows were raised to their minimum.
  const tallest = rows.length ? Math.max(...rows) : 0;
  if (agg < tallest * 1.2) agg = tallest * 1.2;
  rows = rows.map(Math.round); agg = Math.round(agg);
  return { agg, price, rows, content: price + agg + rows.reduce((a, b) => a + b, 0) };
}

export type RowHit = { kind: 'agg' } | { kind: 'price' } | { kind: 'row'; index: number };

/**
 * Which row sits at height `y` of the column. The aggregate and the price strip stay at the top; the venue rows below them scroll by
 * `scroll` px and are clipped to the room under the strip (`room` is the column's height).
 */
export function locateRow(layout: RowLayout, scroll: number, room: number, y: number): RowHit | null {
  if (y < 0 || y >= room) return null;
  if (y < layout.agg) return { kind: 'agg' };
  if (y < layout.agg + layout.price) return { kind: 'price' };
  let top = layout.agg + layout.price - scroll;
  for (let i = 0; i < layout.rows.length; i++) { const bottom = top + layout.rows[i]!; if (y >= Math.max(top, layout.agg + layout.price) && y < bottom) return { kind: 'row', index: i }; top = bottom; }
  return null;
}

/** How far the venue rows can scroll: what they need beyond the room under the aggregate and the price strip. */
export const maxScroll = (layout: RowLayout, room: number): number => Math.max(0, layout.content - room);
