/**
 * Tags on the price axis: one per line that reaches the chart's right edge, at its price. A tag that would cover a more important one, or
 * something already on the axis (the live price's tag), is left out rather than moved, so a tag always sits at its own price.
 */
export interface TagWish { key: string; y: number; rank: number }
export interface Band { y0: number; y1: number }

/** The tags kept, most important (lowest rank) first; each is `height` tall, centred on its y, and must lie wholly inside [0, ph]. */
export function placeTags<T extends TagWish>(wishes: readonly T[], blocked: readonly Band[], height: number, ph: number): T[] {
  const taken: Band[] = [...blocked], kept: T[] = [], half = height / 2;
  for (const w of [...wishes].sort((a, b) => a.rank - b.rank || a.y - b.y)) {
    if (!(w.y - half >= 0 && w.y + half <= ph)) continue;
    const band = { y0: w.y - half, y1: w.y + half };
    if (taken.some(b => b.y0 < band.y1 && band.y0 < b.y1)) continue;
    taken.push(band); kept.push(w);
  }
  return kept;
}
