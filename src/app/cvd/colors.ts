import { contrastRatio, mixHex, type Palette } from '../theme.ts';

/**
 * The two lines of every row: spot is blue and perpetual is amber, as on aggr.trade, whatever way the money moved: the hue says which
 * market, never whether it was buying or selling. Each is pushed toward the page's text colour until it stands 3:1 clear of the panel
 * (a graphic's contrast), so it reads on every theme; the quiet tone is the same line faded.
 */
export interface LaneColors { spot: string; perp: string; spotQuiet: string; perpQuiet: string }

const SPOT = '#3d8bfd', PERP = '#ffb648';
const cache = new WeakMap<Palette, LaneColors>();

function legible(color: string, p: Palette): string {
  let amount = 0, tone = color;
  while (amount < 1 && contrastRatio(tone, p.panel) < 3) { amount = Math.min(1, amount + 0.05); tone = mixHex(color, p.text, amount); }
  return tone;
}

export function laneColors(p: Palette): LaneColors {
  let c = cache.get(p);
  if (!c) { const spot = legible(SPOT, p), perp = legible(PERP, p); c = { spot, perp, spotQuiet: mixHex(spot, p.panel, 0.6), perpQuiet: mixHex(perp, p.panel, 0.6) }; cache.set(p, c); }
  return c;
}
